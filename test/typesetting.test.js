import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';
import { browserOptions } from '../src/browser.js';
import { TypesettingStore } from '../src/typesetting.js';

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function post(base, route, body) {
  return fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('排版文稿经真实 HTTP 保存、渲染、重启和备份恢复，过时修订不会覆盖较新正文', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-'));
  const dataDir = path.join(root, '.data');
  let server = await serve(createApp({ dataDir, interval: 0 }));
  try {
    const exportPage = await (await fetch(server.base + '/')).text();
    assert.match(exportPage, /文章导出/);
    assert.match(exportPage, /公众号排版/);
    assert.doesNotMatch(exportPage, /素材|发布/);
    const initial = await (await fetch(server.base + '/api/typesetting/document')).json();
    assert.deepEqual(initial.document, { title: '', author: '', account: '', publishedAt: '', body: '', revision: 0 });
    const unsafe = '# 标题\n\n<script>alert(1)</script><img src="javascript:alert(1)" onerror="alert(2)">\n\n[危险](javascript:alert(3))';
    const preview = await (await post(server.base, '/api/typesetting/render', { body: unsafe })).json();
    assert.match(preview.html, /<h1/);
    assert.doesNotMatch(preview.html, /script|onerror|javascript:/i);
    assert.equal((await post(server.base, '/api/typesetting/document', { title: '第一篇', author: '作者', account: '公众号', publishedAt: '2026-10-02', body: '较新的正文', revision: 2 })).status, 200);
    const stale = await post(server.base, '/api/typesetting/document', { title: '旧标题', author: '作者', account: '公众号', publishedAt: '2026-10-02', body: '旧正文', revision: 1 });
    assert.equal(stale.status, 409);
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, '较新的正文');
    await server.close();
    server = await serve(createApp({ dataDir, interval: 0 }));
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.author, '作者');
    await writeFile(path.join(dataDir, 'typesetting-document.json'), '{corrupted');
    await server.close();
    server = await serve(createApp({ dataDir, interval: 0 }));
    const restored = await (await fetch(server.base + '/api/typesetting/document')).json();
    assert.equal(restored.document.body, '较新的正文');
    assert.equal(restored.document.revision, 2);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('工作台约 500ms 自动保存、预览防抖、页面隐藏刷新并展示保存状态', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-ui-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.getByLabel('Markdown 正文').fill('# 新文稿');
    await page.getByText('保存中', { exact: true }).waitFor();
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 2000 });
    await page.getByRole('heading', { name: '新文稿' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: '新文稿' }).evaluate(element => getComputedStyle(element).borderBottomColor), 'rgb(22, 114, 77)');
    await page.getByLabel('Markdown 正文').fill('# 隐藏刷新');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1000 });
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, '# 隐藏刷新');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('工作台保存失败时保留未保存状态并给出可操作提示', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-failure-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0, typesettingStore: {
    load: async () => ({ title: '', author: '', account: '', publishedAt: '', body: '', revision: 0 }),
    save: async () => { throw new Error('磁盘不可写'); }
  } }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    assert.equal((await post(server.base, '/api/typesetting/document', { title: '', author: '', account: '', publishedAt: '', body: '无法保存', revision: 1 })).status, 500);
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.getByLabel('Markdown 正文').fill('无法保存');
    await page.getByText('未保存', { exact: true }).waitFor({ timeout: 2000 });
    await page.getByText('请检查本机数据目录', { exact: false }).waitFor();
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('自动保存遇到慢响应时，最新输入仍会成为已保存文稿', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-race-'));
  const store = new TypesettingStore(path.join(root, '.data'));
  let releaseFirst;
  let firstSaved;
  const firstReached = new Promise(resolve => { firstSaved = resolve; });
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0, typesettingStore: {
    load: () => store.load(),
    async save(document) {
      const saved = await store.save(document);
      if (document.body === '第一版') { firstSaved(); await new Promise(resolve => { releaseFirst = resolve; }); }
      return saved;
    }
  } }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.getByLabel('Markdown 正文').fill('第一版');
    await firstReached;
    await page.getByLabel('Markdown 正文').fill('第二版');
    await page.waitForTimeout(650);
    releaseFirst();
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 2000 });
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, '第二版');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
