import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import { JobStore } from '../src/jobs.js';
import { exportArticle } from '../src/exporter.js';

const articleHtml = '<h1 id="activity-name">恢复验证</h1><div id="js_content"><p>保留的正文</p><img src="https://mmbiz.qpic.cn/retry.png"></div>';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64');
async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('任务未在预期时间内完成');
}
async function archive(store, job) { return JSZip.loadAsync(await readFile(store.file(job.items[0], job))); }

for (const restart of [false, true]) test(`部分成功归档被移除后补齐所有格式${restart ? '（服务重启）' : '（不重启）'}`, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-missing-archive-'));
  let failPdf = true;
  let htmlReads = 0;
  let imageReads = 0;
  const exporter = (url, formats, context) => exportArticle(url, formats, {
    ...context,
    getHtml: async () => { htmlReads++; return articleHtml; },
    getImage: async () => { imageReads++; return { bytes: png, mime: 'image/png' }; },
    renderPdf: async () => { if (failPdf) throw new Error('PDF 暂时失败'); return Buffer.from('%PDF-restored'); }
  });
  try {
    let store = new JobStore(dir, exporter, 0);
    let job = store.create('https://mp.weixin.qq.com/s/missing-archive', ['markdown', 'html', 'pdf']);
    await until(() => !store.running);
    assert.equal(job.items[0].status, 'partial');
    await rm(store.file(job.items[0], job));
    if (restart) { store = new JobStore(dir, exporter, 0); job = store.findJob(job.id); }
    failPdf = false;
    store.retry(job.id);
    await until(() => !store.running);
    const zip = await archive(store, job);
    assert.ok(zip.file('article.md'), '重试成功的 ZIP 必须实际包含 Markdown');
    assert.ok(zip.file('article.html'), '重试成功的 ZIP 必须实际包含 HTML');
    assert.ok(zip.file('article.pdf'));
    assert.deepEqual(await zip.file('images/001.png').async('nodebuffer'), png);
    assert.equal(job.items[0].status, 'success');
    assert.deepEqual(job.items[0].successfulFormats, ['html', 'markdown', 'pdf']);
    assert.deepEqual(JSON.parse(await zip.file('metadata.json').async('string')).successfulFormats, ['html', 'markdown', 'pdf']);
    assert.equal(htmlReads, 1);
    assert.equal(imageReads, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PDF 阶段取消保留已生成文件，重启恢复仅生成 PDF 且复用正文图片', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-cancel-checkpoint-'));
  let enteredPdf = false;
  let blockPdf = true;
  let htmlReads = 0;
  let imageReads = 0;
  const formatsSeen = [];
  const visited = [];
  const exporter = (url, formats, context) => {
    visited.push(url);
    formatsSeen.push(formats);
    return exportArticle(url, formats, {
      ...context,
      getHtml: async () => { htmlReads++; return articleHtml; },
      getImage: async () => { imageReads++; return { bytes: png, mime: 'image/png' }; },
      renderPdf: async (html, { signal }) => {
        assert.match(html, /data:image\/png;base64,/);
        enteredPdf = true;
        if (blockPdf) await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        return Buffer.from('%PDF-resumed');
      }
    });
  };
  try {
    let store = new JobStore(dir, exporter, 0);
    let job = store.create('https://mp.weixin.qq.com/s/cancel\nhttps://mp.weixin.qq.com/s/pending', ['markdown', 'html', 'pdf']);
    await until(() => enteredPdf);
    store.cancel(job.id);
    await until(() => !store.running);
    const item = job.items[0];
    assert.equal(item.status, 'cancelled');
    assert.equal(item.downloadable, true, '取消时已有格式应能下载');
    assert.deepEqual(item.successfulFormats, ['html', 'markdown']);
    assert.equal(job.items[1].status, 'cancelled');
    assert.equal(visited.length, 1);
    const before = await archive(store, job);
    assert.equal(before.file('article.pdf'), null);
    const markdown = await before.file('article.md').async('string');
    assert.match(markdown, /保留的正文/);
    assert.deepEqual(await before.file('images/001.png').async('nodebuffer'), png);
    assert.deepEqual(Object.keys(JSON.parse(await before.file('metadata.json').async('string')).failedFormats), ['pdf']);
    blockPdf = false;
    store = new JobStore(dir, exporter, 0);
    job = store.findJob(job.id);
    assert.equal(job.items[0].downloadable, true);
    store.retry(job.id, item.id);
    await until(() => !store.running);
    const after = await archive(store, job);
    assert.equal(await after.file('article.md').async('string'), markdown);
    assert.ok(after.file('article.pdf'));
    assert.deepEqual(formatsSeen, [['html', 'markdown', 'pdf'], ['pdf']]);
    assert.equal(htmlReads, 1);
    assert.equal(imageReads, 1);
    assert.equal(job.items[0].status, 'success');
    assert.equal(job.items[1].status, 'cancelled');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('所有格式生成后在打包阶段取消，已完成文章仍记为成功', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-cancel-archive-'));
  let store;
  try {
    store = new JobStore(dir, (url, formats, context) => exportArticle(url, formats, {
      ...context,
      getHtml: async () => articleHtml,
      getImage: async () => ({ bytes: png, mime: 'image/png' }),
      onProgress: progress => {
        context.onProgress(progress);
        if (progress.stage === 'archive') store.cancel(store.list()[0].id);
      }
    }), 0);
    const job = store.create('https://mp.weixin.qq.com/s/complete\nhttps://mp.weixin.qq.com/s/never-start', ['markdown', 'html']);
    await until(() => !store.running);
    assert.equal(job.items[0].status, 'success', '所有目标文件完成时不应留下无法恢复的取消状态');
    const zip = await archive(store, job);
    assert.ok(zip.file('article.md'));
    assert.ok(zip.file('article.html'));
    assert.equal(job.items[1].status, 'cancelled');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
