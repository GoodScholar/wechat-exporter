import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';
import { exportArticle } from '../src/exporter.js';
import { browserOptions } from '../src/browser.js';

const html = '<h1 id="activity-name">恢复提示验收</h1><div id="js_content"><p>已保存的正文</p></div>';

test('不同失败原因给出对应恢复操作，只有微信验证错误显示验证按钮', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-recovery-guidance-'));
  const app = createApp({ dataDir: dir, interval: 0, exporter: (url, formats, context) => exportArticle(url, formats, {
    ...context,
    getHtml: async () => {
      if (url.endsWith('/verify')) return '<body>微信要求访问验证</body>';
      if (url.endsWith('/unsupported')) return '<div id="js_content"><script>var data="特殊消息";</script></div>';
      if (url.endsWith('/network')) throw new Error('无法连接微信，请检查网络或进行浏览器验证');
      return html;
    },
    renderPdf: async () => {
      if (url.endsWith('/pdf')) throw new Error('PDF 需要 Chromium，请在工具目录运行 npm run setup:browser 后重试');
      return Buffer.from('%PDF-test');
    }
  }) });
  const store = app.locals.store;
  const names = ['missing', 'pdf', 'verify', 'unsupported', 'network'];
  const job = store.create(names.map(name => `https://mp.weixin.qq.com/s/${name}`).join('\n'), ['html', 'pdf']);
  for (let n = 0; store.running && n < 300; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.running, false);
  await rm(store.file(job.items[0], job));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('.article-row').last().waitFor();
    const row = name => page.locator('.article-row').filter({ has: page.locator(`.article-url[href="https://mp.weixin.qq.com/s/${name}"]`) });
    assert.equal(await page.getByRole('button', { name: '浏览器验证', exact: true }).count(), 1);
    assert.equal(await row('verify').getByRole('button', { name: '浏览器验证', exact: true }).count(), 1);
    assert.equal(await row('verify').getByText(/微信要求访问验证/).count(), 1, '同一错误不应按格式重复展示');
    assert.equal(await row('missing').getByRole('button', { name: '重新导出', exact: true }).count(), 1);
    await row('pdf').getByText('PDF 环境说明', { exact: true }).click();
    assert.match(await row('pdf').locator('details').textContent(), /npm run setup:browser/);
    assert.equal(await row('pdf').getByRole('link', { name: '下载文章' }).count(), 1, 'PDF 失败不能遮挡已有成果');
    const original = row('unsupported').getByRole('link', { name: '查看原文', exact: true });
    assert.equal(await original.getAttribute('href'), 'https://mp.weixin.qq.com/s/unsupported');
    assert.match(await row('network').locator('.recovery-hint').textContent(), /网络/);
    const response = page.waitForResponse(r => r.url().endsWith(`/api/jobs/${job.id}/retry`) && r.request().method() === 'POST');
    await row('missing').getByRole('button', { name: '重新导出', exact: true }).click();
    assert.equal((await response).status(), 200);
    await row('missing').getByRole('link', { name: '下载文章' }).waitFor();
    assert.equal(await row('missing').locator('.recovery-hint').count(), 0, '成功后移除旧恢复提示');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
