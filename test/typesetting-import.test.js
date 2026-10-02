import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';
import { browserOptions } from '../src/browser.js';
import { TypesettingStore } from '../src/typesetting.js';

const articleUrl = 'https://mp.weixin.qq.com/s?__biz=abc&mid=1&idx=2&sn=xyz';
const articleHtml = `<!doctype html><html><body>
  <h1 id="activity-name">可导入文章</h1><a id="js_name">测试公众号</a>
  <span id="js_author_name">测试作者</span><span id="publish_time">2026年9月19日 10:00</span>
  <div id="js_content"><h2>第一节</h2><p>正文<strong>重点</strong>与<a href="https://example.com">链接</a>。</p><img data-src="https://mmbiz.qpic.cn/example.png" alt="配图"><blockquote>引用</blockquote><ul><li>条目</li></ul><table><tr><th>列</th></tr><tr><td>值</td></tr></table><pre><code>const x = 1;</code></pre></div>
</body></html>`;

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function post(base, route, body) {
  return fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function seed(base, body = '原有正文') {
  const response = await post(base, '/api/typesetting/document', { title: '原有标题', author: '原作者', account: '原公众号', publishedAt: '2026-09-01', body, revision: 1 });
  assert.equal(response.status, 200);
}

test('导入 API 将普通文章一次性保存为独立元信息和语义 Markdown，重启不会重新抓取', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-'));
  const dataDir = path.join(root, '.data');
  let fetches = 0;
  let server = await serve(createApp({ dataDir, interval: 0, fetchArticle: async url => { fetches++; assert.equal(url, articleUrl); return articleHtml; } }));
  try {
    const response = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 0, confirmed: false, fetchArticle: null, typesetting: null });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(Object.fromEntries(['title', 'author', 'account', 'publishedAt'].map(field => [field, result.document[field]])), {
      title: '可导入文章', author: '测试作者', account: '测试公众号', publishedAt: '2026-09-19'
    });
    assert.match(result.document.body, /## 第一节/);
    assert.match(result.document.body, /\*\*重点\*\*/);
    assert.match(result.document.body, /\[链接\]\(https:\/\/example.com\)/);
    assert.match(result.document.body, /https:\/\/mmbiz.qpic.cn\/example.png/);
    assert.doesNotMatch(result.document.body, /^# 可导入文章/m);
    assert.equal(fetches, 1);
    await server.close();
    server = await serve(createApp({ dataDir, interval: 0, fetchArticle: async () => { throw new Error('重启读取文稿不应抓取来源'); } }));
    const restored = await (await fetch(server.base + '/api/typesetting/document')).json();
    assert.equal(restored.document.body, result.document.body);
    assert.equal(fetches, 1);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('主文稿保存成功而恢复备份不可写时，导入仍作为成功结果提交一致的当前文稿', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-backup-'));
  const dataDir = path.join(root, '.data');
  await mkdir(path.join(dataDir, 'typesetting-document.backup.json'), { recursive: true });
  const store = new TypesettingStore(dataDir);
  try {
    const server = await serve(createApp({ dataDir, interval: 0, typesettingStore: store, fetchArticle: async () => articleHtml }));
    try {
      const response = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 0, confirmed: false });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).document.title, '可导入文章');
      assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.title, '可导入文章');
      assert.match(await readFile(path.join(dataDir, 'typesetting-document.json'), 'utf8'), /可导入文章/);
    } finally { await server.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('导入 API 拒绝未确认替换，并对所有分类失败保留持久化文稿', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-errors-'));
  const dataDir = path.join(root, '.data');
  let mode = 'success';
  let fetches = 0;
  const fixtures = {
    verification: '<html><body>环境异常，请完成验证</body></html>',
    unavailable: '<html><body>该内容已被发布者删除</body></html>',
    empty: '<html><body><div id="js_content"></div></body></html>',
    image: '<html><body><script>var item_show_type = 8;</script><div id="js_content"><img src="https://mmbiz.qpic.cn/picture.png"></div></body></html>',
    unsupported: '<html><body><script>var item_show_type = 12;</script></body></html>',
    sanitizedEmpty: '<html><body><div id="js_content"><script>var hidden = "data";</script><style>.x{display:none}</style></div></body></html>'
  };
  const server = await serve(createApp({ dataDir, interval: 0, fetchArticle: async () => {
    fetches++;
    if (mode === 'network') throw new Error('socket closed');
    return fixtures[mode] || articleHtml;
  } }));
  try {
    await seed(server.base);
    const file = path.join(dataDir, 'typesetting-document.json');
    const original = await readFile(file, 'utf8');
    const unconfirmed = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 1, confirmed: false });
    assert.equal(unconfirmed.status, 409);
    assert.deepEqual((await unconfirmed.json()).error, { code: 'CONFIRM_REQUIRED', message: '当前文稿已有内容，请确认替换后再导入。', action: '确认替换当前文稿后重试。' });
    assert.equal(fetches, 0);
    assert.equal(await readFile(file, 'utf8'), original);

    const cases = [
      ['invalid', 'https://example.com/a', 'INVALID_LINK', 400],
      ['verification', articleUrl, 'ACCESS_VERIFICATION', 403],
      ['unavailable', articleUrl, 'ARTICLE_UNAVAILABLE', 410],
      ['empty', articleUrl, 'EMPTY_BODY', 422],
      ['sanitizedEmpty', articleUrl, 'EMPTY_BODY', 422],
      ['image', articleUrl, 'IMAGE_MESSAGE', 422],
      ['unsupported', articleUrl, 'UNSUPPORTED_MESSAGE', 422],
      ['network', articleUrl, 'NETWORK_READ', 502],
    ];
    for (const [nextMode, url, code, status] of cases) {
      mode = nextMode;
      const response = await post(server.base, '/api/typesetting/import', { url, revision: 1, confirmed: true });
      assert.equal(response.status, status, code);
      const result = await response.json();
      assert.equal(result.error.code, code);
      assert.match(result.error.message, /[\u4e00-\u9fff]/);
      assert.match(result.error.action, /[\u4e00-\u9fff]/);
      assert.equal(await readFile(file, 'utf8'), original, `${code} 不能修改文稿文件`);
      assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, '原有正文');
    }
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('抓取期间的修订冲突返回稳定错误且不覆盖较新文稿', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-conflict-'));
  const dataDir = path.join(root, '.data');
  let release;
  const fetched = new Promise(resolve => { release = resolve; });
  const server = await serve(createApp({ dataDir, interval: 0, fetchArticle: async () => { await fetched; return articleHtml; } }));
  try {
    const importing = post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 0, confirmed: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    await post(server.base, '/api/typesetting/document', { title: '更新者', author: '', account: '', publishedAt: '', body: '较新正文', revision: 1 });
    release();
    const response = await importing;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'REVISION_CONFLICT');
    const current = (await (await fetch(server.base + '/api/typesetting/document')).json()).document;
    assert.equal(current.body, '较新正文');
    assert.equal(current.title, '更新者');
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('工作台取消替换不请求导入，成功导入更新字段和预览，图片消息提供文章导出入口', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-ui-'));
  const dataDir = path.join(root, '.data');
  let mode = 'success';
  let fetches = 0;
  const server = await serve(createApp({ dataDir, interval: 0, fetchArticle: async () => {
    fetches++;
    return mode === 'image' ? '<script>var item_show_type=8;</script><div id="js_content"><img src="https://mmbiz.qpic.cn/picture.png"></div>' : articleHtml;
  } }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    await seed(server.base);
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.getByLabel('导入公众号文章链接').fill(articleUrl);
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: '导入文章' }).click();
    await page.waitForTimeout(80);
    assert.equal(fetches, 0);
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '原有正文');
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, '原有正文');

    await page.getByLabel('Markdown 正文').fill('');
    await page.getByLabel('标题').fill('');
    await page.getByLabel('作者').fill('');
    await page.getByLabel('公众号名称').fill('');
    await page.getByLabel('发布日期').fill('');
    await page.waitForTimeout(600);
    await page.getByLabel('导入公众号文章链接').fill(articleUrl);
    await page.getByRole('button', { name: '导入文章' }).click();
    await page.getByLabel('标题').waitFor({ state: 'visible' });
    await page.getByLabel('标题').evaluate(input => new Promise(resolve => {
      const timer = setInterval(() => { if (input.value === '可导入文章') { clearInterval(timer); resolve(); } }, 10);
    }));
    await page.getByRole('heading', { name: '第一节' }).waitFor();
    assert.equal(await page.getByLabel('发布日期').inputValue(), '2026-09-19');

    mode = 'image';
    const previousTitle = await page.getByLabel('标题').inputValue();
    const previousBody = await page.getByLabel('Markdown 正文').inputValue();
    await page.getByLabel('导入公众号文章链接').fill(articleUrl);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '导入文章' }).click();
    const exportLink = page.getByRole('link', { name: '返回文章导出' });
    await exportLink.waitFor();
    assert.equal(await exportLink.getAttribute('href'), '/');
    assert.equal(await page.getByLabel('标题').inputValue(), previousTitle);
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), previousBody);
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, previousBody);
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('工作台在慢导入前先保存待处理编辑，并在抓取期间锁定字段避免覆盖新输入', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-ui-race-'));
  const dataDir = path.join(root, '.data');
  let release;
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  const server = await serve(createApp({ dataDir, interval: 0, fetchArticle: async () => { started(); await delayed; return articleHtml; } }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    await seed(server.base);
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.getByLabel('Markdown 正文').fill('待保存编辑');
    await page.getByLabel('导入公众号文章链接').fill(articleUrl);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '导入文章' }).click();
    await reading;
    assert.equal(await page.getByLabel('Markdown 正文').isDisabled(), true);
    assert.equal(await page.getByLabel('标题').isDisabled(), true);
    release();
    await page.getByLabel('标题').evaluate(input => new Promise(resolve => {
      const timer = setInterval(() => { if (input.value === '可导入文章') { clearInterval(timer); resolve(); } }, 10);
    }));
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.title, '可导入文章');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('工作台导入会排空级联自动保存，避免使用旧修订号自发冲突', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-save-queue-'));
  const dataDir = path.join(root, '.data');
  const server = await serve(createApp({ dataDir, interval: 0, fetchArticle: async () => articleHtml }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    await seed(server.base);
    const page = await browser.newPage();
    let releaseFirst;
    let firstStarted;
    const firstSave = new Promise(resolve => { firstStarted = resolve; });
    let saves = 0;
    await page.route('**/api/typesetting/document', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      if (saves++ === 0) { firstStarted(); await new Promise(resolve => { releaseFirst = resolve; }); }
      await route.continue();
    });
    await page.goto(server.base + '/typesetting');
    await page.getByLabel('Markdown 正文').fill('第一版');
    await firstSave;
    await page.getByLabel('Markdown 正文').fill('第二版');
    await page.getByLabel('导入公众号文章链接').fill(articleUrl);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '导入文章' }).click();
    releaseFirst();
    await page.getByLabel('标题').evaluate(input => new Promise(resolve => {
      const timer = setInterval(() => { if (input.value === '可导入文章') { clearInterval(timer); resolve(); } }, 10);
    }));
    assert.ok(saves >= 2);
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.title, '可导入文章');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('仅排版页面允许 HTTPS 图片来源，文章导出页保持原有 CSP', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-csp-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  try {
    assert.doesNotMatch((await fetch(server.base + '/')).headers.get('content-security-policy'), /img-src 'self' data: https:/);
    assert.match((await fetch(server.base + '/typesetting')).headers.get('content-security-policy'), /img-src 'self' data: https:/);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
