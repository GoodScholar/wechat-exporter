import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';
import { browserOptions } from '../src/browser.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('浏览器保存与切换常用源，手动刷新清空旧勾选，重载保留、删除生效', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-saved-ui-'));
  let reads = 0;
  const source = createServer((req, res) => {
    reads++;
    const id = req.url === '/one' ? 'one' : 'two';
    res.end(`<rss><channel><title>订阅 ${id}</title><item><title>文章 ${id}</title><link>https://mp.weixin.qq.com/s/${id}</link></item></channel></rss>`);
  });
  const feedBase = await listen(source);
  const server = createServer(createApp({ dataDir: dir }));
  const base = await listen(server);
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(base);
    await page.getByRole('button', { name: 'RSS 导入', exact: true }).click();
    assert.equal(await page.getByLabel('常用订阅源', { exact: true }).count(), 1);
    await page.getByLabel('订阅源名称', { exact: true }).fill('技术 & 阅读');
    await page.getByLabel('RSS 地址', { exact: true }).fill(feedBase + '/one');
    await page.getByRole('button', { name: '保存订阅源', exact: true }).click();
    await page.getByText('订阅源已保存到本机', { exact: true }).waitFor();
    const firstId = await page.getByLabel('常用订阅源', { exact: true }).inputValue();
    assert.ok(firstId);
    assert.equal(reads, 0, '保存配置不应自动读取订阅源');
    await page.getByRole('button', { name: '刷新文章', exact: true }).click();
    await page.getByText('文章 one', { exact: true }).waitFor();
    await page.getByRole('button', { name: '全选当前筛选结果', exact: true }).click();
    assert.equal(await page.locator('#submit').isDisabled(), false);
    await page.getByRole('button', { name: '刷新文章', exact: true }).click();
    await page.getByText('文章 one', { exact: true }).waitFor();
    assert.equal(await page.locator('#submit').isDisabled(), true);

    await page.getByLabel('常用订阅源', { exact: true }).selectOption('');
    assert.equal(await page.getByLabel('RSS 地址', { exact: true }).inputValue(), '');
    await page.getByLabel('订阅源名称', { exact: true }).fill('生活订阅');
    await page.getByLabel('RSS 地址', { exact: true }).fill(feedBase + '/two');
    await page.getByRole('button', { name: '保存订阅源', exact: true }).click();
    await page.getByText('订阅源已保存到本机', { exact: true }).waitFor();
    const secondId = await page.getByLabel('常用订阅源', { exact: true }).inputValue();
    assert.notEqual(firstId, secondId);
    await page.reload();
    await page.getByRole('button', { name: 'RSS 导入', exact: true }).click();
    await page.getByLabel('常用订阅源', { exact: true }).selectOption(firstId);
    assert.equal(await page.getByLabel('订阅源名称', { exact: true }).inputValue(), '技术 & 阅读');
    assert.equal(await page.getByLabel('RSS 地址', { exact: true }).inputValue(), feedBase + '/one');
    assert.equal(reads, 2, '重新打开及切换源不应自动抓取');
    await page.getByRole('button', { name: '刷新文章', exact: true }).click();
    await page.getByText('文章 one', { exact: true }).waitFor();
    await page.getByRole('button', { name: '全选当前筛选结果', exact: true }).click();
    await page.getByLabel('常用订阅源', { exact: true }).selectOption(secondId);
    assert.equal(await page.locator('#rss-preview').isHidden(), true);
    assert.equal(await page.locator('#submit').isDisabled(), true);
    await page.getByRole('button', { name: '刷新文章', exact: true }).click();
    await page.getByText('文章 two', { exact: true }).waitFor();
    await page.getByLabel('订阅源名称', { exact: true }).fill('');
    await page.getByRole('button', { name: '保存订阅源', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#rss-saved-message').textContent.includes('名称'));
    assert.equal(await page.locator('#rss-saved option').count(), 3);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', { name: '删除订阅源', exact: true }).click();
    await page.getByText('已删除订阅源，已导出的文件仍保留', { exact: true }).waitFor();
    assert.equal(await page.locator('#rss-preview').isHidden(), true);
    await page.reload();
    const remaining = await (await fetch(base + '/api/feeds')).json();
    assert.deepEqual(remaining.map(item => item.id), [firstId]);
  } finally {
    await browser.close();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => source.close(resolve))]);
    await rm(dir, { recursive: true, force: true });
  }
});
