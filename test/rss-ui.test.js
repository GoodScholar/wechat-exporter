import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';
import { browserOptions } from '../src/browser.js';

const sourceUrl = 'http://127.0.0.1:8080/feed.xml';
const feed = items => ({
  url: sourceUrl,
  title: '本机订阅源',
  skipped: 2,
  duplicates: 1,
  truncated: false,
  items
});

const articles = [
  { url: 'https://mp.weixin.qq.com/s/first', title: '秋日精选', publishedAt: '2026-09-18T08:00:00.000Z', author: '小留' },
  { url: 'https://mp.weixin.qq.com/s/second', title: '夏日笔记', publishedAt: '2026-09-10T08:00:00.000Z', author: '小留' },
  { url: 'https://mp.weixin.qq.com/s/no-date', title: '没有日期', publishedAt: null, author: '' }
];

async function startPage(t, handler) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-rss-ui-'));
  const app = createApp({ dataDir: path.join(dir, '.data'), interval: 0 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  const page = await browser.newPage();
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  await page.route('**/api/**', handler);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  return page;
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test('RSS 预览按标题和日期筛选，只导出当前勾选的文章', async t => {
  const requests = [];
  const page = await startPage(t, async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const body = request.postDataJSON?.() || undefined;
    requests.push({ pathname, method: request.method(), body });
    if (pathname === '/api/jobs' && request.method() === 'GET') return json(route, []);
    if (pathname === '/api/settings') return json(route, { outputDirectory: '/tmp/exports' });
    if (pathname === '/api/feeds/preview') return json(route, feed(articles));
    if (pathname === '/api/jobs') return json(route, { id: 'rss-job' });
    return json(route, {});
  });

  assert.equal(await page.getByRole('button', { name: 'RSS 导入' }).count(), 1, 'RSS 模式入口应可见');
  await page.getByRole('button', { name: 'RSS 导入' }).click();
  await page.getByLabel('RSS 地址').fill(sourceUrl);
  await page.getByRole('button', { name: '读取文章' }).click();
  await page.getByText('本机订阅源', { exact: true }).waitFor();
  assert.match(await page.locator('#rss-selection-count').textContent(), /已选 0 篇/);
  assert.equal(await page.locator('#submit').isDisabled(), true);

  await page.getByLabel('标题关键字').fill('精选');
  await page.getByLabel('开始日期').fill('2026-09-18');
  await page.getByLabel('结束日期').fill('2026-09-18');
  await page.getByRole('button', { name: '全选当前筛选结果' }).click();
  assert.match(await page.locator('#rss-selection-count').textContent(), /当前可见 1 篇 · 已选 1 篇/);
  assert.equal(await page.locator('#submit').isDisabled(), false);

  await page.getByLabel('标题关键字').fill('夏日');
  assert.match(await page.locator('#rss-selection-count').textContent(), /当前可见 0 篇 · 已选 0 篇/);
  assert.equal(await page.locator('#submit').isDisabled(), true);
  await page.getByLabel('标题关键字').fill('精选');
  await page.getByRole('button', { name: '全选当前筛选结果' }).click();

  await page.getByRole('button', { name: '开始导出' }).click();
  const job = requests.find(request => request.pathname === '/api/jobs' && request.method === 'POST');
  assert.deepEqual(job.body.text, 'https://mp.weixin.qq.com/s/first');
  assert.equal(job.body.formats.includes('markdown'), true);

  await page.getByLabel('RSS 地址').fill('不是一个有效网址');
  await page.getByRole('button', { name: '粘贴链接' }).click();
  await page.getByLabel('文章链接').fill('https://mp.weixin.qq.com/s/manual');
  await page.getByRole('button', { name: '开始导出' }).click();
  const manualJob = requests.filter(request => request.pathname === '/api/jobs' && request.method === 'POST').at(-1);
  assert.equal(manualJob.body.text, 'https://mp.weixin.qq.com/s/manual');
});

test('RSS 换源和旧请求不会留下旧预览，全选最多 50 篇并适配手机宽度', async t => {
  const many = Array.from({ length: 51 }, (_, index) => ({
    url: `https://mp.weixin.qq.com/s/${index + 1}`,
    title: `文章 ${index + 1}`,
    publishedAt: '2026-09-18T08:00:00.000Z',
    author: '小留'
  }));
  let firstPreview;
  const firstPreviewDone = new Promise(resolve => { firstPreview = resolve; });
  let previewCount = 0;
  const page = await startPage(t, async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/jobs' && request.method() === 'GET') return json(route, []);
    if (pathname === '/api/settings') return json(route, { outputDirectory: '/tmp/exports' });
    if (pathname === '/api/feeds/preview') {
      previewCount += 1;
      if (previewCount === 1) {
        await firstPreviewDone;
        return json(route, feed([{ ...articles[0], title: '旧源文章' }]));
      }
      return json(route, { ...feed(many), url: 'http://127.0.0.1:8080/new.xml', title: '新源' });
    }
    return json(route, {});
  });

  assert.equal(await page.getByRole('button', { name: 'RSS 导入' }).count(), 1, 'RSS 模式入口应可见');
  await page.getByRole('button', { name: 'RSS 导入' }).click();
  await page.getByLabel('RSS 地址').fill(sourceUrl);
  await page.getByRole('button', { name: '读取文章' }).click();
  await page.getByLabel('RSS 地址').fill('http://127.0.0.1:8080/new.xml');
  assert.equal(await page.locator('#rss-preview').isHidden(), true);
  await page.getByRole('button', { name: '读取文章' }).click();
  await page.getByText('新源', { exact: true }).waitFor();
  firstPreview();
  await page.waitForTimeout(60);
  assert.equal(await page.getByText('旧源文章', { exact: true }).count(), 0);

  await page.getByRole('button', { name: '全选当前筛选结果' }).click();
  assert.match(await page.locator('#rss-selection-count').textContent(), /当前可见 51 篇 · 已选 50 篇/);
  assert.match(await page.locator('#rss-message').textContent(), /前 50 篇/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
