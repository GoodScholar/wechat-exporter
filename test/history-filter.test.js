import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';
import { exportArticle } from '../src/exporter.js';
import { browserOptions } from '../src/browser.js';

test('历史搜索跨批次组合标题、公众号与状态，清空后恢复记录及下载', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-history-'));
  const app = createApp({ dataDir: dir, interval: 0, exporter: (url, formats, context) => exportArticle(url, formats, {
    ...context,
    getHtml: async () => `<h1 id="activity-name">${url.endsWith('/old') ? 'Node 入门' : '旅行笔记'}</h1><strong id="js_name">${url.endsWith('/old') ? '技术周刊' : '生活周刊'}</strong><div id="js_content"><p>文章正文</p></div>`,
    renderPdf: async () => { throw new Error('PDF 需要 Chromium'); }
  }) });
  const store = app.locals.store;
  const waitForJobs = async () => {
    for (let n = 0; store.running && n < 300; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.running, false);
  };
  const older = store.create('https://mp.weixin.qq.com/s/old\nhttps://mp.weixin.qq.com/s/other', ['html']);
  await waitForJobs();
  const newer = store.create('https://mp.weixin.qq.com/s/new', ['html', 'pdf']);
  await waitForJobs();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('.article-row').waitFor();
    const search = page.getByRole('searchbox', { name: '搜索标题或公众号' });
    await search.fill(' node ');
    assert.equal(await page.locator('.article-title').textContent(), 'Node 入门');
    assert.equal(await page.locator('#history').inputValue(), older.id);
    const download = await page.getByRole('link', { name: '下载文章' }).getAttribute('href');
    assert.equal((await page.request.get(new URL(download, page.url()).href)).status(), 200);
    await search.fill('周刊');
    await page.getByLabel('导出状态', { exact: true }).selectOption('partial');
    assert.equal(await page.locator('.article-title').textContent(), '旅行笔记');
    assert.equal(await page.locator('#history').inputValue(), newer.id);
    await search.fill('技术周刊');
    assert.equal(await page.locator('.article-row').count(), 0);
    assert.equal(await page.getByText('没有匹配的导出记录', { exact: true }).isVisible(), true);
    assert.equal(await page.locator('#download-all').isVisible(), false);
    await page.getByRole('button', { name: '清空筛选', exact: true }).click();
    assert.equal(await search.inputValue(), '');
    assert.equal(await page.getByLabel('导出状态', { exact: true }).inputValue(), '');
    assert.equal(await page.locator('#history option').count(), 2);
    await page.locator('#history').selectOption(older.id);
    assert.deepEqual(await page.locator('.article-title').allTextContents(), ['Node 入门', '旅行笔记']);
    await search.fill('技术周刊');
    // A real backend change triggers polling; it must not discard the current query.
    store.create('https://mp.weixin.qq.com/s/third', ['html']);
    await waitForJobs();
    await page.waitForFunction(() => document.querySelector('#history-result').textContent.includes('共 4 篇'));
    assert.equal(await search.inputValue(), '技术周刊');
    assert.equal(await page.locator('.article-title').textContent(), 'Node 入门');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('.tasks').screenshot({ path: '/tmp/wechat-history-mobile.png' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('.tasks').screenshot({ path: '/tmp/wechat-history-desktop.png' });
    await page.getByLabel('文章链接', { exact: true }).fill('https://mp.weixin.qq.com/s/submitted');
    await page.getByRole('button', { name: '开始导出' }).click();
    await page.waitForFunction(() => document.querySelector('#history-search').value === '');
    await page.getByRole('link', { name: '下载文章' }).waitFor();
    assert.equal(await page.locator('.article-title').textContent(), '旅行笔记');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
