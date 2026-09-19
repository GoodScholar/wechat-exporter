import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import { createApp } from '../src/server.js';
import { exportArticle } from '../src/exporter.js';
import { makePdf } from '../src/browser.js';

const articleHtml = '<h1 id="activity-name">目录与重试验收</h1><a id="js_name">测试公众号</a><div id="js_content"><p>保留原来的正文。</p></div>';

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function post(base, route, body = {}) {
  return fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function waitJob(base, id, condition) {
  for (let n = 0; n < 200; n++) {
    const jobs = await (await fetch(base + '/api/jobs')).json();
    const job = jobs.find(job => job.id === id);
    if (job && condition(job)) return job;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('任务未在预期时间内到达目标状态');
}

test('保存目录变更和重启后，旧文件与新目录中的中文命名文件都可下载', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-directory-'));
  const dataDir = path.join(dir, '.data');
  const outputDirectory = path.join(dir, '我的文章');
  await mkdir(path.join(dataDir, 'exports'), { recursive: true });
  const oldZip = new JSZip();
  oldZip.file('article.md', '# 原有文件');
  const oldBytes = await oldZip.generateAsync({ type: 'nodebuffer' });
  await writeFile(path.join(dataDir, 'exports', 'legacy-item.zip'), oldBytes);
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{ id: 'legacy-job', createdAt: '2026-09-19T00:00:00Z', formats: ['markdown'], invalid: [], duplicates: 0, items: [{ id: 'legacy-item', url: 'https://mp.weixin.qq.com/s/legacy', title: '原有文件', status: 'success', warnings: [] }] }]));
  const opened = [];
  const options = { dataDir, interval: 0, openDirectory: async folder => { opened.push(folder); }, exporter: (url, formats, context) => exportArticle(url, formats, { ...context, getHtml: async () => articleHtml }) };
  let server = await serve(createApp(options));
  try {
    const settings = await fetch(server.base + '/api/settings');
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).outputDirectory, path.join(dataDir, 'exports'));
    assert.equal((await post(server.base, '/api/settings', { outputDirectory: 'relative/path' })).status, 400);
    const saved = await post(server.base, '/api/settings', { outputDirectory });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).outputDirectory, outputDirectory);
    const response = await post(server.base, '/api/jobs', { text: 'https://mp.weixin.qq.com/s/new', formats: ['markdown', 'html'] });
    assert.equal(response.status, 201);
    const created = await response.json();
    const job = await waitJob(server.base, created.id, job => job.items[0].status === 'success');
    assert.equal(job.outputDirectory, outputDirectory);
    const files = await readdir(outputDirectory);
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}.*目录与重试验收.*\.zip$/);
    const downloaded = await fetch(`${server.base}/api/items/${job.items[0].id}/download`);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), await readFile(path.join(outputDirectory, files[0])));
    assert.equal((await post(server.base, '/api/open-directory', { jobId: 'legacy-job' })).status, 200);
    assert.equal((await post(server.base, '/api/open-directory', { jobId: created.id })).status, 200);
    assert.deepEqual(opened, [path.join(dataDir, 'exports'), outputDirectory]);
    await server.close();
    server = await serve(createApp(options));
    assert.equal((await (await fetch(server.base + '/api/settings')).json()).outputDirectory, outputDirectory);
    const legacyResponse = await fetch(server.base + '/api/items/legacy-item/download');
    assert.equal(legacyResponse.status, 200);
    assert.deepEqual(Buffer.from(await legacyResponse.arrayBuffer()), oldBytes);
    assert.equal((await fetch(`${server.base}/api/items/${job.items[0].id}/download`)).status, 200);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('PDF 失败保留现有格式，服务重启后只重试 PDF 并复用之前的正文', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-partial-'));
  let fetches = 0;
  let imageFetches = 0;
  let failPdf = true;
  const options = { dataDir: path.join(dir, '.data'), interval: 0, exporter: (url, formats, context) => exportArticle(url, formats, {
    ...context,
    getHtml: async () => { fetches++; return articleHtml.replace('</div>', '<img src="https://mmbiz.qpic.cn/example.png"></div>'); },
    getImage: async () => {
      imageFetches++;
      return { mime: 'image/png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64') };
    },
    renderPdf: async (html, settings) => { assert.match(html, /data:image\/png;base64,/); if (failPdf) throw new Error('PDF 暂时不可用'); return makePdf(html, settings); }
  }) };
  let server = await serve(createApp(options));
  try {
    const created = await (await post(server.base, '/api/jobs', { text: 'https://mp.weixin.qq.com/s/partial', formats: ['markdown', 'html', 'pdf'] })).json();
    const partial = await waitJob(server.base, created.id, job => job.items[0].status === 'partial');
    const item = partial.items[0];
    assert.equal(item.downloadable, true);
    assert.match(item.failedFormats.pdf, /PDF 暂时不可用/);
    const original = await JSZip.loadAsync(await (await fetch(`${server.base}/api/items/${item.id}/download`)).arrayBuffer());
    const markdown = await original.file('article.md').async('string');
    assert.match(markdown, /保留原来的正文/);
    assert.equal(original.file('article.pdf'), null);
    await server.close();
    failPdf = false;
    server = await serve(createApp(options));
    assert.equal((await post(server.base, `/api/jobs/${created.id}/retry`, { itemId: item.id })).status, 200);
    const success = await waitJob(server.base, created.id, job => job.items[0].status === 'success');
    assert.equal(fetches, 1, '重启后的格式重试不应再次抓取正文');
    assert.equal(imageFetches, 1, '格式重试应复用已下载的图片');
    assert.deepEqual(success.items[0].failedFormats, {});
    const exported = await JSZip.loadAsync(await (await fetch(`${server.base}/api/items/${item.id}/download`)).arrayBuffer());
    assert.equal(await exported.file('article.md').async('string'), markdown);
    assert.equal((await exported.file('article.pdf').async('nodebuffer')).subarray(0, 5).toString(), '%PDF-');
    const metadata = JSON.parse(await exported.file('metadata.json').async('string'));
    assert.deepEqual(metadata.successfulFormats.slice().sort(), ['html', 'markdown', 'pdf']);
    assert.deepEqual(metadata.failedFormats, {});
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('取消会终止活动任务并跳过待处理文章，随后可以创建新批次', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-cancel-'));
  const visited = [];
  let aborted = false;
  const app = createApp({ dataDir: path.join(dir, '.data'), interval: 0, exporter: async (url, formats, context) => {
    visited.push(url);
    if (url.endsWith('/slow')) {
      context.onProgress({ stage: 'images', completed: 1, total: 3 });
      await new Promise((resolve, reject) => context.signal.addEventListener('abort', () => { aborted = true; reject(context.signal.reason); }, { once: true }));
    }
    return exportArticle(url, formats, { ...context, getHtml: async () => articleHtml });
  } });
  const server = await serve(app);
  try {
    const created = await (await post(server.base, '/api/jobs', { text: 'https://mp.weixin.qq.com/s/slow\nhttps://mp.weixin.qq.com/s/pending', formats: ['markdown'] })).json();
    const running = await waitJob(server.base, created.id, job => job.items[0].progress?.stage === 'images');
    assert.equal(running.items[0].progress.completed, 1);
    assert.equal((await post(server.base, `/api/jobs/${created.id}/cancel`)).status, 200);
    await waitJob(server.base, created.id, job => job.items.every(item => item.status === 'cancelled'));
    assert.equal(aborted, true);
    assert.deepEqual(visited, ['https://mp.weixin.qq.com/s/slow']);
    const next = await post(server.base, '/api/jobs', { text: 'https://mp.weixin.qq.com/s/next', formats: ['markdown'] });
    assert.equal(next.status, 201);
    await waitJob(server.base, (await next.json()).id, job => job.items[0].status === 'success');
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
