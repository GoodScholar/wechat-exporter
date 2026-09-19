import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserOptions } from '../src/browser.js';
import { parseArticle, renderHtml, renderMarkdown } from '../src/article.js';

const source = '<h1 id="activity-name">表格阅读</h1><div id="js_content"><table><thead><tr><th>语义名称</th><th>字号</th><th>字重</th><th>行高</th><th>使用场景</th></tr></thead><tbody><tr><td>Display</td><td>24px</td><td>700</td><td>32px</td><td>页面大标题</td></tr><tr><td>Heading</td><td>20px</td><td>600</td><td>28px</td><td>模块标题</td></tr></tbody></table><p>表格之后的正文</p></div>';

test('窄屏表格保持短值完整并可独立滚动，打印时完整适配纸张', async () => {
  const article = parseArticle(source, 'https://mp.weixin.qq.com/s/table');
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
    page.setDefaultTimeout(3000);
    await page.setContent(renderHtml(article));
    const lines = await page.locator('td').evaluateAll(cells => cells.slice(0, 4).map(cell => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      return range.getClientRects().length;
    }));
    assert.deepEqual(lines, [1, 1, 1, 1], '短单词和数值不得被窄屏强制拆行');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const region = page.getByRole('region', { name: '文章表格，可左右滚动' });
    assert.equal(await region.evaluate(el => el.scrollWidth > el.clientWidth), true);
    await region.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('[role="region"]').scrollLeft > 0);
    await page.emulateMedia({ media: 'print' });
    await page.setViewportSize({ width: 673, height: 986 });
    // An unbroken value must wrap for printing rather than be hidden off the sheet.
    await page.locator('td').first().evaluate(el => { el.textContent = 'LongIdentifier'.repeat(30); });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await region.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    assert.equal(await page.locator('td').count(), 10);
    assert.match(renderMarkdown(article), /\| Display \| 24px \| 700 \| 32px \| 页面大标题 \|/);
    assert.doesNotMatch(renderMarkdown(article), /<div|tabindex/);
  } finally { await browser.close(); }
});
