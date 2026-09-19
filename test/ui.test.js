import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { createApp } from '../src/server.js';
import { browserOptions } from '../src/browser.js';
import { exportArticle } from '../src/exporter.js';

test('浏览器可提交、显示部分失败、重试、下载真实归档，并适配手机宽度', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-ui-'));
  let first = true;
  const app = createApp({ dataDir: path.join(dir, '.data'), interval: 0, exporter: (url, formats) => {
    if (url.endsWith('/fail') && first) { first = false; throw new Error('访问验证测试'); }
    return exportArticle(url, formats, { getHtml: async () => '<h1 id="activity-name">浏览器验收文章</h1><div id="js_content"><p>实际导出正文</p></div>' });
  } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.getByLabel('文章链接').fill('https://example.com');
    await page.getByRole('button', { name: '开始导出' }).click();
    await page.getByText('没有找到有效文章链接', { exact: false }).waitFor();
    await page.getByLabel('文章链接').fill('https://mp.weixin.qq.com/s/ok\nhttps://mp.weixin.qq.com/s/fail');
    await page.getByRole('button', { name: '开始导出' }).click();
    await page.getByText('访问验证测试', { exact: true }).waitFor();
    await page.locator('#retry').click();
    await page.getByText('2 篇成功', { exact: false }).waitFor();
    await page.getByText('文件已保存到', { exact: true }).waitFor();
    assert.equal(await page.locator('#saved-directory').textContent(), path.join(dir, '.data', 'exports'));
    const fileUrl = await page.getByRole('link', { name: '下载文章' }).first().getAttribute('href');
    const fileResponse = await fetch(url + fileUrl);
    assert.equal(fileResponse.status, 200, '真实保存目录 .data 中的文件应能通过下载接口读取');
    assert.match(fileResponse.headers.get('content-disposition'), /^attachment;/);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载文章' }).first().click();
    const download = await downloadEvent;
    assert.match(await page.locator('#notice').textContent(), /浏览器下载列表/);
    const zip = await JSZip.loadAsync(await readFile(await download.path()));
    assert.match(await zip.file('article.md').async('string'), /实际导出正文/);
    const batchDownloadEvent = page.waitForEvent('download');
    await page.getByRole('link', { name: '打包下载' }).click();
    const batchDownload = await batchDownloadEvent;
    assert.match(await page.locator('#notice').textContent(), /浏览器下载列表/);
    const batchZip = await JSZip.loadAsync(await readFile(await batchDownload.path()));
    const articles = Object.values(batchZip.files).filter(file => !file.dir);
    assert.equal(articles.length, 2);
    for (const article of articles) {
      const archive = await JSZip.loadAsync(await article.async('nodebuffer'));
      assert.match(await archive.file('article.html').async('string'), /实际导出正文/);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(dir, 'mobile.png'), fullPage: true });
    const forbidden = await fetch(`${url}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: '{}' });
    assert.equal(forbidden.status, 403);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('界面管理保存目录，并呈现部分成功、阶段进度、取消和恢复操作', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-ui-state-'));
  const app = createApp({ dataDir: path.join(dir, '.data'), interval: 0 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  let jobs = [{
    id: 'job-1', createdAt: '2026-09-19T08:00:00.000Z', outputDirectory: '/tmp/留篇导出', formats: ['markdown', 'html', 'pdf'], invalid: [], duplicates: 0,
    items: [
      { id: 'partial-1', url: 'https://mp.weixin.qq.com/s/partial', title: '部分成功的文章', status: 'partial', warnings: [], successfulFormats: ['markdown', 'html'], failedFormats: { pdf: 'PDF 生成失败' }, downloadable: true, progress: { stage: 'archive' } },
      { id: 'running-1', url: 'https://mp.weixin.qq.com/s/running', title: '正在处理的文章', status: 'running', warnings: [], successfulFormats: [], failedFormats: {}, downloadable: false, progress: { stage: 'images', completed: 2, total: 5 } },
      { id: 'cancelled-1', url: 'https://mp.weixin.qq.com/s/cancelled', title: '已取消的文章', status: 'cancelled', warnings: [], successfulFormats: [], failedFormats: {}, downloadable: false, progress: { stage: 'fetch' } }
    ]
  }];
  const requests = [];
  try {
    const page = await browser.newPage();
    await page.route('**/api/**', async route => {
      const request = route.request();
      const data = request.postData();
      requests.push({ url: request.url(), method: request.method(), body: data ? JSON.parse(data) : undefined });
      const pathname = new URL(request.url()).pathname;
      const reply = payload => route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
      if (pathname === '/api/jobs' && request.method() === 'GET') return reply(jobs);
      if (pathname === '/api/settings' && request.method() === 'GET') return reply({ outputDirectory: '/tmp/留篇导出' });
      if (pathname === '/api/settings') return reply({ outputDirectory: '/tmp/新的导出目录' });
      if (pathname === '/api/open-directory') return reply({ message: '已打开文件夹' });
      if (pathname.endsWith('/cancel')) { jobs[0].items[1].status = 'cancelled'; return reply(jobs[0]); }
      if (pathname.endsWith('/retry')) return reply(jobs[0]);
      return reply({});
    });
    await page.goto(url);
    await page.getByLabel('保存目录').fill('/tmp/新的导出目录');
    await page.getByRole('button', { name: '保存目录' }).click();
    await page.getByText('保存目录已更新', { exact: false }).waitFor();
    await page.getByText('部分成功：Markdown、HTML', { exact: true }).waitFor();
    await page.getByText('PDF：PDF 生成失败', { exact: true }).waitFor();
    await page.getByText('正在下载图片 2/5', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: '下载文章' }).getAttribute('href'), '/api/items/partial-1/download');
    await page.getByRole('button', { name: '打开文件夹' }).first().click();
    await page.getByRole('button', { name: '取消本批次' }).click();
    await page.getByText('本批次已结束', { exact: false }).waitFor();
    await page.getByRole('button', { name: '仅重试失败格式' }).click();
    await page.locator('.retry-item').last().click();
    await page.locator('#retry').click();
    assert.ok(requests.some(request => request.url.endsWith('/api/settings') && request.method === 'POST' && request.body.outputDirectory === '/tmp/新的导出目录'));
    assert.ok(requests.some(request => request.url.endsWith('/api/open-directory') && request.method === 'POST' && request.body.jobId === 'job-1'));
    assert.ok(requests.some(request => request.url.endsWith('/api/jobs/job-1/cancel') && request.method === 'POST'));
    assert.ok(requests.some(request => request.url.endsWith('/api/jobs/job-1/retry') && request.body.itemId === 'partial-1'));
    assert.ok(requests.some(request => request.url.endsWith('/api/jobs/job-1/retry') && request.body.itemId === 'cancelled-1'));
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
