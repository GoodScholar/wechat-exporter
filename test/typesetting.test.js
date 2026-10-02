import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    assert.deepEqual(initial.document, { title: '', author: '', account: '', publishedAt: '', body: '', revision: 0, savedAt: '' });
    const unsafe = '# 标题\n\n<script>alert(1)</script><img src="javascript:alert(1)" onerror="alert(2)">\n\n[危险](javascript:alert(3))';
    const preview = await (await post(server.base, '/api/typesetting/render', { body: unsafe })).json();
    assert.match(preview.html, /<h1/);
    assert.doesNotMatch(preview.html, /script|onerror|javascript:/i);
    assert.equal((await post(server.base, '/api/typesetting/document', { title: '第一篇', author: '作者', account: '公众号', publishedAt: '2026-10-02', body: '较旧的正文', revision: 1 })).status, 200);
    assert.equal((await post(server.base, '/api/typesetting/document', { title: '第一篇', author: '作者', account: '公众号', publishedAt: '2026-10-02', body: '较新的正文', revision: 2 })).status, 200);
    const stale = await post(server.base, '/api/typesetting/document', { title: '旧标题', author: '作者', account: '公众号', publishedAt: '2026-10-02', body: '旧正文', revision: 1 });
    assert.equal(stale.status, 409);
    const saved = (await (await fetch(server.base + '/api/typesetting/document')).json()).document;
    assert.equal(saved.body, '较新的正文');
    assert.match(saved.savedAt, /^\d{4}-\d{2}-\d{2}T/);
    await server.close();
    server = await serve(createApp({ dataDir, interval: 0 }));
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.author, '作者');
    const manifest = JSON.parse(await readFile(path.join(dataDir, 'typesetting-document.manifest.json'), 'utf8'));
    assert.notEqual(manifest.current, manifest.recovery);
    assert.equal(await readFile(path.join(dataDir, 'typesetting-versions', `${manifest.current}.json`), 'utf8'), await readFile(path.join(dataDir, 'typesetting-versions', `${manifest.recovery}.json`), 'utf8'));
    await writeFile(path.join(dataDir, 'typesetting-versions', `${manifest.current}.json`), '{corrupted');
    await server.close();
    server = await serve(createApp({ dataDir, interval: 0 }));
    const restored = await (await fetch(server.base + '/api/typesetting/document')).json();
    assert.equal(restored.document.body, '较新的正文');
    assert.equal(restored.document.revision, 2);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('首次保存会保留与 current 物理独立的同版本 recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-first-recovery-'));
  const dataDir = path.join(root, '.data');
  const store = new TypesettingStore(dataDir);
  try {
    const saved = await store.save({ title: '第一篇', author: '作者', account: '公众号', publishedAt: '2026-10-02', body: '第一版正文', revision: 1 });
    const manifest = JSON.parse(await readFile(store.manifest, 'utf8'));
    assert.notEqual(manifest.current, manifest.recovery);
    assert.equal(await readFile(path.join(store.versions, `${manifest.current}.json`), 'utf8'), await readFile(path.join(store.versions, `${manifest.recovery}.json`), 'utf8'));
    await writeFile(path.join(store.versions, `${manifest.current}.json`), '{corrupted');
    assert.deepEqual(await new TypesettingStore(dataDir).load(), saved);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('慢的旧预览响应不能覆盖较新的预览', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-preview-race-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    let releaseFirst;
    let firstFetched;
    const firstReady = new Promise(resolve => { firstFetched = resolve; });
    let renders = 0;
    await page.route('**/api/typesetting/render', async route => {
      const response = await route.fetch();
      if (renders++ === 0) { firstFetched(); await new Promise(resolve => { releaseFirst = resolve; }); }
      await route.fulfill({ response });
    });
    await page.getByLabel('Markdown 正文').fill('# 第一版');
    await firstReady;
    await page.getByLabel('Markdown 正文').fill('# 第二版');
    await page.getByRole('heading', { name: '第二版' }).waitFor({ timeout: 1000 });
    releaseFirst();
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole('heading', { name: '第二版' }).count(), 1);
    assert.equal(await page.getByRole('heading', { name: '第一版' }).count(), 0);
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('自动保存等待期、请求期和 hidden 刷新有可观察状态与时序', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-timing-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    const saves = [];
    const previews = [];
    let releaseSave;
    let saveHeld;
    const firstSaveHeld = new Promise(resolve => { saveHeld = resolve; });
    let holdNextSave = true;
    await page.route('**/api/typesetting/document', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      saves.push(Date.now());
      const response = await route.fetch();
      if (holdNextSave) { await new Promise(resolve => { releaseSave = resolve; saveHeld(); }); }
      await route.fulfill({ response });
    });
    await page.route('**/api/typesetting/render', async route => { previews.push(Date.now()); await route.continue(); });
    const started = Date.now();
    await page.getByLabel('Markdown 正文').fill('# 时序');
    assert.equal(await page.getByText('未保存', { exact: true }).count(), 1);
    await page.waitForTimeout(120);
    assert.equal(previews.length, 0);
    assert.equal(saves.length, 0);
    await page.waitForTimeout(250);
    assert.equal(previews.length, 1);
    assert.ok(previews[0] - started >= 150);
    await page.waitForTimeout(50);
    assert.equal(saves.length, 0);
    await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === '保存中', undefined, { timeout: 1000 });
    await Promise.race([
      firstSaveHeld,
      new Promise((_, reject) => setTimeout(() => reject(new Error('自动保存请求未在 1000ms 内进入拦截路由')), 1000)),
    ]);
    assert.equal(saves.length, 1);
    assert.ok(saves[0] - started >= 450);
    assert.ok(saves[0] - started < 1000, '自动保存请求必须在约 500ms 防抖后的一秒内启动');
    releaseSave();
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1000 });
    assert.ok(Date.now() - started < 1000, '自动保存完成必须在输入后的一秒内可见');
    holdNextSave = false;
    const hiddenStarted = Date.now();
    await page.getByLabel('Markdown 正文').fill('# hidden 刷新');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === '已保存', undefined, { timeout: 1000 });
    assert.equal(saves.length, 2);
    assert.ok(saves[1] - hiddenStarted < 300);
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, '# hidden 刷新');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('并发保存冲突保留未保存状态并给出重新载入提示', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-conflict-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const first = await browser.newPage();
    const second = await browser.newPage();
    await Promise.all([first.goto(server.base + '/typesetting'), second.goto(server.base + '/typesetting')]);
    await Promise.all([first.waitForTimeout(250), second.waitForTimeout(250)]);
    await first.getByLabel('Markdown 正文').fill('第一位编辑者');
    await first.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
    await second.getByLabel('Markdown 正文').fill('第二位编辑者');
    await second.getByText('未保存', { exact: true }).waitFor({ timeout: 1500 });
    await second.getByText('其他页面', { exact: false }).waitFor();
    assert.doesNotMatch(await second.locator('#save-message').textContent(), /数据目录/);
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, '第一位编辑者');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('工作台约 500ms 自动保存、预览防抖、页面隐藏刷新并展示保存状态', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-ui-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.getByLabel('Markdown 正文').fill('# 新文稿');
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 2000 });
    await page.getByRole('heading', { name: '新文稿' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: '新文稿' }).evaluate(element => getComputedStyle(element).borderBottomColor), 'rgb(22, 114, 77)');
    await page.getByLabel('Markdown 正文').fill('# 隐藏刷新');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
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

async function dispatchPaste(page, { html = '', text = '' }) {
  return await page.evaluate(({ html, text }) => {
    const clipboard = new DataTransfer();
    if (text) clipboard.setData('text/plain', text);
    if (html) clipboard.setData('text/html', html);
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard });
    const body = document.querySelector('#document-body');
    body.dispatchEvent(event);
    if (!event.defaultPrevented && text) {
      body.setRangeText(text, body.selectionStart, body.selectionEnd, 'end');
      body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
    }
    return { defaultPrevented: event.defaultPrevented, value: body.value };
  }, { html, text });
}

test('纯文本粘贴保持原生路径；富文本确认后按触发选区插入并自动保存', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-rich-paste-ui-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    await page.route('https://example.test/**', route => route.abort());
    let conversionRequests = 0;
    await page.route('**/api/typesetting/rich-text', async route => { conversionRequests++; await route.continue(); });

    const plainPaste = await dispatchPaste(page, { text: '纯文本' });
    assert.equal(plainPaste.defaultPrevented, false, '纯文本必须不阻止浏览器原生粘贴');
    assert.equal(plainPaste.value, '纯文本', '合成事件的原生默认插入等价路径应更新正文');
    assert.equal(conversionRequests, 0, '纯文本不得请求转换 API');

    await page.getByLabel('标题').fill('原有标题');
    await page.getByLabel('Markdown 正文').fill('甲乙丙');
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
    const before = await (await fetch(server.base + '/api/typesetting/document')).json();
    const previewBefore = await page.locator('#preview').innerHTML();
    await page.evaluate(() => { window.confirm = () => false; document.querySelector('#document-body').setSelectionRange(1, 2); });
    assert.equal((await dispatchPaste(page, { html: '<strong>取消内容</strong>' })).defaultPrevented, true);
    await page.waitForTimeout(100);
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '甲乙丙');
    assert.equal(await page.locator('#preview').innerHTML(), previewBefore);
    assert.deepEqual(await (await fetch(server.base + '/api/typesetting/document')).json(), before);
    assert.equal(conversionRequests, 0, '取消不得请求转换 API');

    await page.evaluate(() => { window.confirm = () => true; document.querySelector('#document-body').setSelectionRange(1, 2); });
    assert.equal((await dispatchPaste(page, { html: '<strong>粗体</strong><video src="https://example.test/video.mp4"></video>' })).defaultPrevented, true);
    await page.waitForFunction(() => document.querySelector('#document-body').value.includes('**粗体**') && document.querySelector('#document-body').value.includes('特殊内容：视频'));
    assert.match(await page.getByLabel('Markdown 正文').inputValue(), /^甲[\s\S]*粗体[\s\S]*特殊内容：视频[\s\S]*丙$/);
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
    await page.getByText('粗体', { exact: true }).waitFor();
    await page.getByText('特殊内容：视频', { exact: false }).waitFor();
    const saved = (await (await fetch(server.base + '/api/typesetting/document')).json()).document;
    assert.equal(saved.title, '原有标题');
    assert.match(saved.body, /\*\*粗体\*\*/);
    assert.match(saved.body, /特殊内容：视频/);
    assert.equal(conversionRequests, 1);
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('富文本转换失败或旧响应到达时不修改当前文稿', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-rich-paste-race-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    await page.getByLabel('Markdown 正文').fill('失败前正文');
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
    const before = await (await fetch(server.base + '/api/typesetting/document')).json();
    const previewBefore = await page.locator('#preview').innerHTML();
    await page.evaluate(() => { window.confirm = () => true; document.querySelector('#document-body').setSelectionRange(1, 3); });
    await page.route('**/api/typesetting/rich-text', route => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'EMPTY_RICH_TEXT', message: '富文本中没有可转换的可读内容。', action: '请保留正文文字后重试。' } }) }));
    assert.equal((await dispatchPaste(page, { html: '<p>不会插入</p>' })).defaultPrevented, true);
    await page.getByText('请保留正文文字后重试。', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '失败前正文');
    assert.equal(await page.locator('#preview').innerHTML(), previewBefore);
    assert.deepEqual(await (await fetch(server.base + '/api/typesetting/document')).json(), before);
    await page.unroute('**/api/typesetting/rich-text');

    let release;
    let requestReached;
    const responseHeld = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { requestReached = resolve; });
    await page.route('**/api/typesetting/rich-text', async route => {
      requestReached();
      const response = await route.fetch();
      await responseHeld;
      await route.fulfill({ response });
    });
    await page.evaluate(() => document.querySelector('#document-body').setSelectionRange(1, 3));
    assert.equal((await dispatchPaste(page, { html: '<strong>旧结果</strong>' })).defaultPrevented, true);
    await reached;
    await page.getByLabel('Markdown 正文').fill('临时新编辑');
    await page.getByLabel('Markdown 正文').fill('失败前正文');
    await page.evaluate(() => document.querySelector('#document-body').setSelectionRange(1, 3));
    release();
    await page.getByText('正文或选区已变化，请重新粘贴后重试。', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '失败前正文');
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, '失败前正文');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('块级富文本插入行内选区时保留 Markdown 与预览的块边界', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-rich-paste-block-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    await page.getByLabel('Markdown 正文').fill('甲乙丙');
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
    await page.evaluate(() => { window.confirm = () => true; document.querySelector('#document-body').setSelectionRange(1, 2); });
    assert.equal((await dispatchPaste(page, { html: '<h1>插入标题</h1>' })).defaultPrevented, true);
    await page.getByRole('heading', { name: '插入标题' }).waitFor();
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '甲\n\n# 插入标题\n\n丙');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('多段富文本插入选区时保留两侧 Markdown 块边界', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-rich-paste-paragraphs-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    await page.getByLabel('Markdown 正文').fill('甲乙丙');
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
    await page.evaluate(() => { window.confirm = () => true; document.querySelector('#document-body').setSelectionRange(1, 2); });
    assert.equal((await dispatchPaste(page, { html: '<div>第一段</div><div>第二段</div>' })).defaultPrevented, true);
    await page.getByText('第二段', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '甲\n\n第一段\n\n第二段\n\n丙');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('富文本插入进入原生撤销栈，转义标签不触发外部资源请求', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-rich-paste-undo-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    let resourceRequests = 0;
    await page.route('https://tracker.invalid/**', route => { resourceRequests++; return route.abort(); });
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    await page.getByLabel('Markdown 正文').fill('甲乙丙');
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
    await page.evaluate(() => { window.confirm = () => true; document.querySelector('#document-body').setSelectionRange(1, 2); });
    assert.equal((await dispatchPaste(page, { html: '<p>\\\\&lt;img src="https://tracker.invalid/pixel"&gt;</p>' })).defaultPrevented, true);
    await page.getByText('已转换富文本', { exact: false }).waitFor();
    assert.equal(await page.locator('#preview img').count(), 0);
    assert.equal(resourceRequests, 0);
    await page.getByLabel('Markdown 正文').focus();
    await page.keyboard.press('Meta+Z');
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '甲乙丙');
    await page.keyboard.press('Meta+Shift+Z');
    assert.match(await page.getByLabel('Markdown 正文').inputValue(), /tracker\.invalid/);
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
