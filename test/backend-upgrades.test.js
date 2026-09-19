import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { JobStore } from '../src/jobs.js';

async function settled(store) {
  for (let i = 0; i < 200; i++) {
    if (store.list().every(job => job.items.every(item => !['queued', 'running'].includes(item.status)))) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('队列没有完成');
}

test('部分成功只重试失败格式，并保留已有可下载文件', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-upgrade-'));
  const calls = [];
  try {
    const archive = async name => {
      const zip = new JSZip();
      zip.file(name, name);
      return zip.generateAsync({ type: 'nodebuffer' });
    };
    const store = new JobStore(dir, async (url, formats, context) => {
      calls.push({ formats, retryInput: context.retryInput });
      if (formats.includes('pdf') && !context.retryInput) {
        return { title: '有空格 / 标题', warnings: [], archive: await archive('md-html'), successfulFormats: ['markdown', 'html'], failedFormats: { pdf: 'PDF 失败' }, retryInput: { article: { title: '有空格 / 标题' } } };
      }
      return { title: '有空格 / 标题', warnings: [], archive: await archive('pdf'), successfulFormats: ['pdf'], failedFormats: {}, retryInput: context.retryInput };
    }, 0);
    const job = store.create('https://mp.weixin.qq.com/s/test', ['markdown', 'html', 'pdf']);
    await settled(store);
    const item = job.items[0];
    assert.equal(item.status, 'partial');
    assert.deepEqual(item.successfulFormats, ['html', 'markdown']);
    assert.equal(item.downloadable, true);
    const before = store.file(item);
    assert.equal(existsSync(before), true);
    store.retry(job.id, item.id);
    await settled(store);
    assert.equal(item.status, 'success');
    assert.equal(item.downloadable, true);
    assert.deepEqual(calls.map(call => call.formats), [['html', 'markdown', 'pdf'], ['pdf']]);
    assert.ok(calls[1].retryInput);
    assert.equal((await readFile(store.file(item))).includes(Buffer.from('pdf')), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('取消忽略不响应 AbortSignal 的导出器结果，并继续处理下一批', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-cancel-'));
  let release;
  try {
    const store = new JobStore(dir, (url, formats, context) => new Promise(resolve => {
      if (url.endsWith('/slow')) release = () => resolve({ title: '慢', warnings: [], archive: Buffer.from('slow') });
      else resolve({ title: '快', warnings: [], archive: Buffer.from('fast') });
    }), 0);
    const first = store.create('https://mp.weixin.qq.com/s/slow', ['html']);
    for (let i = 0; i < 50 && !release; i++) await new Promise(resolve => setTimeout(resolve, 2));
    store.cancel(first.id);
    release();
    await settled(store);
    assert.equal(first.items[0].status, 'cancelled');
    assert.equal(first.items[0].downloadable, false);
    const second = store.create('https://mp.weixin.qq.com/s/fast', ['html']);
    await settled(store);
    assert.equal(second.items[0].status, 'success');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('跨重启重试全失败 PDF 时保留图片输入，并支持默认目录恢复', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-retry-image-'));
  const custom = path.join(dir, 'custom');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64');
  const html = '<h1 id="activity-name">' + '长'.repeat(100) + '</h1><div id="js_content"><img data-src="https://mmbiz.qpic.cn/test.png"></div>';
  let fetches = 0;
  let failPdf = true;
  const exporter = async (url, formats, context) => {
    const { exportArticle } = await import('../src/exporter.js');
    return exportArticle(url, formats, {
      ...context,
      getHtml: async () => { fetches++; return html; },
      getImage: async () => ({ bytes: png, mime: 'image/png' }),
      renderPdf: async () => { if (failPdf) throw new Error('PDF 失败'); return Buffer.from('%PDF-重试'); }
    });
  };
  try {
    const store = new JobStore(dir, exporter, 0);
    assert.equal(store.setOutputDirectory(custom), custom);
    assert.equal(store.setOutputDirectory(''), path.join(dir, 'exports'));
    const job = store.create('https://mp.weixin.qq.com/s/retry-image', ['pdf']);
    await settled(store);
    assert.equal(job.items[0].status, 'error');
    assert.equal('retryInput' in store.list()[0].items[0], false);
    failPdf = false;
    const restored = new JobStore(dir, exporter, 0);
    restored.retry(job.id);
    await settled(restored);
    const item = restored.list()[0].items[0];
    assert.equal(item.status, 'success');
    assert.equal(fetches, 1);
    const zip = await JSZip.loadAsync(await readFile(restored.file(restored.findItem(item.id).item, restored.findItem(item.id).job)));
    assert.deepEqual(await zip.file('images/001.png').async('nodebuffer'), png);
    assert.ok(Buffer.byteLength(path.basename(restored.file(restored.findItem(item.id).item, restored.findItem(item.id).job))) < 255);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('旧式导出器取消后的阶段成果仍可下载，内部恢复标记不进入公开记录', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-legacy-checkpoint-'));
  let release;
  try {
    const zip = new JSZip();
    zip.file('article.html', '<p>已完成的正文</p>');
    const archive = await zip.generateAsync({ type: 'nodebuffer' });
    const store = new JobStore(dir, () => new Promise(resolve => {
      release = () => resolve({ title: '旧式阶段成果', warnings: [], archive, successfulFormats: ['html'], failedFormats: { pdf: '已取消' }, retryInput: { article: { title: '旧式阶段成果' } } });
    }), 0);
    const job = store.create('https://mp.weixin.qq.com/s/legacy-checkpoint', ['html', 'pdf']);
    store.cancel(job.id);
    release();
    await settled(store);
    const item = store.list()[0].items[0];
    assert.equal(item.status, 'cancelled');
    assert.equal(item.downloadable, true);
    assert.deepEqual(item.successfulFormats, ['html']);
    assert.equal('retryInput' in item, false);
    assert.equal('resumable' in item, false);
    const exported = await JSZip.loadAsync(await readFile(store.file(item, job)));
    assert.match(await exported.file('article.html').async('string'), /已完成的正文/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
