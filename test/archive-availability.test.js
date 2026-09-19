import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { createApp } from '../src/server.js';
import { exportArticle } from '../src/exporter.js';
import { browserOptions } from '../src/browser.js';

const articleHtml = '<h1 id="activity-name">归档恢复</h1><div id="js_content"><p>恢复后的正文</p></div>';
async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('任务未到达预期状态');
}
async function start(t, getHtml = async () => articleHtml) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-availability-'));
  const app = createApp({ dataDir: dir, interval: 0, exporter: (url, formats, context) => exportArticle(url, formats, { ...context, getHtml }) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const store = app.locals.store;
  return { base, store, post: (route, body = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) };
}

for (const single of [true, false]) test(`完整归档被移走后，无需先读取列表即可${single ? '单篇' : '整批'}重试`, async t => {
  const { store, base, post } = await start(t);
  const job = store.create('https://mp.weixin.qq.com/s/missing-complete', ['markdown', 'html']);
  await until(() => !store.running);
  const item = job.items[0];
  assert.equal(item.status, 'success');
  await rm(store.file(item, job));
  assert.equal((await fetch(`${base}/api/items/${item.id}/download`)).status, 404);
  assert.equal((await post(`/api/jobs/${job.id}/retry`, single ? { itemId: item.id } : {})).status, 200);
  await until(() => !store.running);
  const response = await fetch(`${base}/api/items/${item.id}/download`);
  assert.equal(response.status, 200, '重试必须重新生成已丢失的完整归档');
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  assert.match(await zip.file('article.md').async('string'), /恢复后的正文/);
  assert.match(await zip.file('article.html').async('string'), /恢复后的正文/);
});

test('浏览器轮询识别归档缺失，移除下载入口，并能恢复为可下载文件', async t => {
  const { store, base } = await start(t);
  const job = store.create('https://mp.weixin.qq.com/s/missing-browser', ['markdown', 'html']);
  await until(() => !store.running);
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(base);
    await page.getByRole('link', { name: '下载文章' }).waitFor();
    await rm(store.file(job.items[0], job));
    const item = (await (await fetch(base + '/api/jobs')).json())[0].items[0];
    assert.equal(item.status, 'error');
    assert.equal(item.downloadable, false);
    assert.deepEqual(item.successfulFormats, []);
    assert.deepEqual(Object.keys(item.failedFormats).sort(), ['html', 'markdown']);
    assert.equal((await fetch(`${base}/api/jobs/${job.id}/download`)).status, 404);
    await page.locator('#items').getByRole('button', { name: '重新导出' }).waitFor();
    assert.equal(await page.getByRole('link', { name: '下载文章' }).count(), 0);
    assert.equal(await page.locator('#download-all').isVisible(), false);
    await page.locator('#items').getByRole('button', { name: '重新导出' }).click();
    await page.getByRole('link', { name: '下载文章' }).waitFor();
    const event = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载文章' }).click();
    assert.equal(await (await event).failure(), null);
    assert.equal(await page.locator('#download-all').isVisible(), true);
  } finally { await browser.close(); }
});

test('运行中的文章与等待项不会被列表校验或重复重试误判为中断', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { store, base, post } = await start(t, async () => { await gate; return articleHtml; });
  const job = store.create('https://mp.weixin.qq.com/s/active\nhttps://mp.weixin.qq.com/s/queued', ['html']);
  try {
    const listed = (await (await fetch(base + '/api/jobs')).json())[0];
    assert.deepEqual(listed.items.map(item => item.status), ['running', 'queued']);
    const retried = await (await post(`/api/jobs/${job.id}/retry`)).json();
    assert.deepEqual(retried.items.map(item => item.status), ['running', 'queued']);
  } finally { release(); await until(() => !store.running); }
  assert.deepEqual(job.items.map(item => item.status), ['success', 'success']);
});
