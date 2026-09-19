import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { createApp } from '../src/server.js';
import { JobStore } from '../src/jobs.js';
import { exportArticle } from '../src/exporter.js';

async function until(predicate) {
  for (let n = 0; n < 300; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('队列未按预期完成');
}
const html = '<h1 id="activity-name">边界测试</h1><div id="js_content"><p>保留正文</p></div>';

test('异常 API 请求不创建任务、不改变保存目录，之后仍可正常导出和下载', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-api-boundaries-'));
  const app = createApp({ dataDir: dir, interval: 0, exporter: (url, formats, context) => exportArticle(url, formats, { ...context, getHtml: async () => html }) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  try {
    const invalid = ['{', 'null', '[]', '{}', JSON.stringify({ text: 'https://mp.weixin.qq.com/s/test', formats: ['invalid'] }), JSON.stringify({ text: Array.from({ length: 51 }, (_, n) => `https://mp.weixin.qq.com/s/a${n}`).join('\n'), formats: ['html'] }), JSON.stringify({ text: 'x'.repeat(160000), formats: ['html'] })];
    for (const body of invalid) {
      const response = await post('/api/jobs', body);
      assert.equal(response.status, 400);
      assert.equal(typeof (await response.json()).error, 'string');
    }
    const original = await (await fetch(base + '/api/settings')).json();
    for (const value of [null, [], {}, '../outside']) assert.equal((await post('/api/settings', JSON.stringify({ outputDirectory: value }))).status, 400);
    assert.deepEqual(await (await fetch(base + '/api/settings')).json(), original);
    assert.deepEqual(await (await fetch(base + '/api/jobs')).json(), []);
    assert.equal((await fetch(base + '/api/items/missing/download')).status, 404);
    assert.equal((await post('/api/jobs/missing/retry', '{}')).status, 400);
    const created = await post('/api/jobs', JSON.stringify({ text: 'https://mp.weixin.qq.com/s/test', formats: ['html'] }));
    assert.equal(created.status, 201);
    const job = await created.json();
    await until(() => !app.locals.store.running);
    const response = await fetch(`${base}/api/items/${job.items[0].id}/download`);
    assert.equal(response.status, 200);
    const zip = await JSZip.loadAsync(await response.arrayBuffer(), { checkCRC32: true });
    assert.match(await zip.file('article.html').async('string'), /保留正文/);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

test('取消后的迟到结果不写入文件，连续重试不会重复执行，恢复后可跨重启下载', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-queue-boundaries-'));
  let release;
  let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const exporter = async (url, formats, context) => {
    calls++;
    if (calls === 1) { await gate; return { title: '迟到结果', archive: Buffer.from('must not be saved') }; }
    return exportArticle(url, formats, { ...context, getHtml: async () => html });
  };
  const store = new JobStore(dir, exporter, 0);
  try {
    const job = store.create('https://mp.weixin.qq.com/s/a\nhttps://mp.weixin.qq.com/s/b', ['html']);
    assert.throws(() => store.create('https://mp.weixin.qq.com/s/c', ['html']), /仍在导出/);
    store.cancel(job.id);
    store.cancel(job.id);
    release();
    await until(() => !store.running);
    assert.deepEqual(job.items.map(item => item.status), ['cancelled', 'cancelled']);
    assert.equal(calls, 1);
    assert.equal(store.list()[0].items.some(item => item.downloadable), false);
    assert.deepEqual(await readdir(store.getOutputDirectory()), [], '取消后的迟到结果不得留下归档文件');
    store.retry(job.id);
    store.retry(job.id);
    await until(() => !store.running);
    assert.equal(calls, 3, '每篇文章只恢复一次');
    assert.deepEqual(job.items.map(item => item.status), ['success', 'success']);
    const restored = new JobStore(dir, exporter, 0);
    for (const item of restored.list()[0].items) {
      assert.equal(item.downloadable, true);
      const zip = await JSZip.loadAsync(await readFile(restored.file(item, job)), { checkCRC32: true });
      assert.match(await zip.file('article.html').async('string'), /保留正文/);
    }
  } finally { release(); await until(() => !store.running); await rm(dir, { recursive: true, force: true }); }
});

test('图片累计不超过 60MiB，超额图片跳过后仍可填满剩余预算', async () => {
  const sizes = [15, 15, 15, 14, 2, 1, 1];
  const source = `<div id="js_content"><p>容量边界</p>${sizes.map((_, n) => `<img src="https://mmbiz.qpic.cn/${n}.png">`).join('')}</div>`;
  const result = await exportArticle('https://mp.weixin.qq.com/s/images', ['markdown'], {
    getHtml: async () => source,
    getImage: async url => ({ bytes: Buffer.alloc(sizes[Number(new URL(url).pathname.slice(1, -4))] * 1024 * 1024), mime: 'image/png' })
  });
  const zip = await JSZip.loadAsync(result.archive);
  const images = Object.values(zip.files).filter(file => !file.dir && file.name.startsWith('images/'));
  assert.equal(images.length, 5, '跳过 2MiB 图片后，应能保存恰好填满 60MiB 的 1MiB 图片');
  assert.equal((await zip.file('images/005.png').async('nodebuffer')).length, 1024 * 1024);
  assert.equal(zip.file('images/006.png'), null);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings.join(' '), /大小|限制/);
  assert.match(await zip.file('article.md').async('string'), /图片未下载/);
});

test('150 张图片上限不会重复请求被拒绝的图片，已下载的重复图片仍能复用', async () => {
  const urls = Array.from({ length: 151 }, (_, n) => `https://mmbiz.qpic.cn/${n}.png`);
  const reads = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64');
  const result = await exportArticle('https://mp.weixin.qq.com/s/image-count', ['markdown', 'html'], {
    getHtml: async () => `<div id="js_content">${[...urls, urls[0], urls[150]].map(url => `<img src="${url}">`).join('')}</div>`,
    getImage: async url => { reads.push(url); return { bytes: png, mime: 'image/png' }; }
  });
  const zip = await JSZip.loadAsync(result.archive, { checkCRC32: true });
  assert.equal(Object.values(zip.files).filter(file => !file.dir && file.name.startsWith('images/')).length, 150);
  assert.equal(reads.length, 150);
  assert.equal(reads.includes(urls[150]), false);
  const markdown = await zip.file('article.md').async('string');
  assert.equal((markdown.match(/images\/001.png/g) || []).length, 2);
  assert.equal((markdown.match(/\[图片未下载/g) || []).length, 2);
  assert.equal(result.warnings.length, 1);
});

test('保存目录被同名文件占用时不误报成功，修复目录后重试可生成真实归档', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-output-failure-'));
  const store = new JobStore(dir, (url, formats, context) => exportArticle(url, formats, { ...context, getHtml: async () => html }), 0);
  try {
    const output = store.getOutputDirectory();
    await rm(output, { recursive: true });
    await writeFile(output, '模拟保存目录被文件占用');
    const job = store.create('https://mp.weixin.qq.com/s/disk', ['html']);
    await until(() => !store.running);
    assert.equal(job.items[0].status, 'error');
    assert.equal(store.list()[0].items[0].downloadable, false);
    await rm(output);
    store.retry(job.id);
    await until(() => !store.running);
    assert.equal(job.items[0].status, 'success');
    const zip = await JSZip.loadAsync(await readFile(store.file(job.items[0], job)), { checkCRC32: true });
    assert.match(await zip.file('article.html').async('string'), /保留正文/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
