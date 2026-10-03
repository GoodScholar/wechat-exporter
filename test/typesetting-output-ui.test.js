import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';
import { browserOptions } from '../src/browser.js';

const fixturePath = new URL('./fixtures/typesetting-output-artifacts.json', import.meta.url);
const artifactFixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
const settings = Object.freeze({ primaryColor: '#0F4C81', fontSize: '16px', lineHeight: '1.75', blockSpacing: '1' });
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const serverModuleUrl = new URL('../src/server.js', import.meta.url).href;

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function withBrowser(t, { initScript } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-output-ui-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  const context = await browser.newContext();
  for (const script of [initScript].flat().filter(Boolean)) await context.addInitScript(script);
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  t.after(async () => {
    await browser.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { page, base: server.base };
}

async function startIsolatedServer(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-output-restart-'));
  const source = `
    import { createApp } from ${JSON.stringify(serverModuleUrl)};
    const app = createApp({ dataDir: process.env.TASK7_DATA_DIR, interval: 0 });
    const server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, TASK7_DATA_DIR: path.join(root, '.data') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`等待独立服务启动超时: ${stderr}`)), 6000);
    child.once('message', message => { clearTimeout(timeout); resolve(message.port); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`独立服务提前退出 ${code}: ${stderr}`)); });
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(root, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}` };
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function renderResult(request, html) {
  if (request.body.trim() === '') return {
    html: '',
    presentation: { theme: request.theme, settings: request.settings },
    diagnostics: [{
      id: 'empty-body',
      code: 'EMPTY_BODY',
      severity: 'blocker',
      message: '正文为空。',
      targets: [{ kind: 'source', start: 0, end: 0 }]
    }],
    blocked: true
  };
  return {
    html: html ?? `<p>${escapeHtml(request.body)}</p>`,
    presentation: { theme: request.theme, settings: request.settings },
    diagnostics: [],
    blocked: false
  };
}

function outputBundle(snapshot, { status = snapshot.document.body.trim() ? 'ready' : 'blocked', marker = snapshot.document.title || snapshot.document.body || 'empty' } = {}) {
  const markdown = {
    mimeType: 'text/markdown;charset=utf-8',
    filename: `server-${marker}.md`,
    content: `SERVER:${marker}`
  };
  return {
    schemaVersion: 1,
    status,
    snapshot: structuredClone(snapshot),
    markdown,
    clipboard: status === 'ready' ? {
      html: { mimeType: 'text/html', content: `<p>${escapeHtml(marker)}</p>` },
      plain: { mimeType: 'text/plain', content: marker }
    } : null,
    html: status === 'ready' ? {
      mimeType: 'text/html;charset=utf-8',
      filename: `server-${marker}.html`,
      content: `<!doctype html><html><body>${escapeHtml(marker)}</body></html>`
    } : null
  };
}

async function installRenderRoute(page, makeResult = request => renderResult(request)) {
  await page.route('**/api/typesetting/render', route => {
    const request = route.request().postDataJSON();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(makeResult(request)) });
  });
}

async function installOutputRoute(page, calls, handle = (route, request) => route.fulfill({
  contentType: 'application/json',
  body: JSON.stringify(outputBundle(request))
})) {
  await page.route('**/api/typesetting/output', route => {
    const request = route.request().postDataJSON();
    calls.push(request);
    return handle(route, request, calls.length);
  });
}

async function waitForCount(values, count) {
  const deadline = Date.now() + 6000;
  while (values.length < count) {
    if (Date.now() > deadline) assert.fail(`等待请求数量 ${count} 超时，当前为 ${values.length}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function waitForRenderState(page, state) {
  await page.waitForFunction(expected => document.querySelector('#render-status')?.dataset.state === expected, state);
}

async function waitForReadyOutput(page) {
  await page.waitForFunction(() => typeof window.hasFreshReadyOutput === 'function' && window.hasFreshReadyOutput());
}

async function currentMarkdownArtifact(page) {
  return page.evaluate(() => window.currentMarkdownArtifact());
}

function installOutputBrowserSpies() {
  window.__secureContext = true;
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    get: () => window.__secureContext
  });
  window.__clipboardMode = 'resolve';
  window.__writeTextMode = 'resolve';
  window.__clipboardSupports = { 'text/html': true, 'text/plain': true };
  window.__clipboardItems = [];
  window.__clipboardWrites = [];
  window.__writeTextCalls = [];
  window.__pendingClipboardWrites = [];
  window.__pendingWriteTexts = [];
  window.__execCommandCalls = 0;
  document.execCommand = () => { window.__execCommandCalls++; return true; };
  class TestClipboardItem {
    static supports(type) { return window.__clipboardSupports[type] === true; }
    constructor(types) {
      this.types = types;
      window.__clipboardItems.push(this);
    }
  }
  window.__TestClipboardItem = TestClipboardItem;
  window.ClipboardItem = TestClipboardItem;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      write(items) {
        window.__clipboardWrites.push(items);
        if (window.__clipboardMode === 'throw') throw new Error('write throw');
        if (window.__clipboardMode === 'reject') return Promise.reject(new Error('write reject'));
        if (window.__clipboardMode === 'pending') return new Promise((resolve, reject) => window.__pendingClipboardWrites.push({ resolve, reject }));
        return Promise.resolve();
      },
      writeText(value) {
        window.__writeTextCalls.push(value);
        if (window.__writeTextMode === 'throw') throw new Error('writeText throw');
        if (window.__writeTextMode === 'reject') return Promise.reject(new Error('writeText reject'));
        if (window.__writeTextMode === 'pending') return new Promise((resolve, reject) => window.__pendingWriteTexts.push({ resolve, reject, value }));
        return Promise.resolve();
      }
    }
  });
  window.__createdBlobs = [];
  window.__downloadClicks = [];
  window.__revokedUrls = [];
  window.__openCalls = [];
  window.open = (...args) => { window.__openCalls.push(args); };
  URL.createObjectURL = blob => {
    window.__createdBlobs.push(blob);
    return `blob:output-test-${window.__createdBlobs.length}`;
  };
  URL.revokeObjectURL = url => { window.__revokedUrls.push(url); };
  HTMLAnchorElement.prototype.click = function () {
    window.__downloadClicks.push({ download: this.download, href: this.href, connected: this.isConnected, anchor: this });
  };
}

function installPendingImageSpies() {
  window.__imageHandlers = new Map();
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (this instanceof HTMLImageElement && this.src.startsWith('https://fixture.invalid/') && (type === 'load' || type === 'error')) {
      const handlers = window.__imageHandlers.get(this) || {};
      handlers[type] = listener;
      window.__imageHandlers.set(this, handlers);
      return;
    }
    return nativeAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (this instanceof HTMLImageElement && window.__imageHandlers.has(this) && (type === 'load' || type === 'error')) return;
    return nativeRemove.call(this, type, listener, options);
  };
  const complete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete');
  const naturalWidth = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth');
  Object.defineProperty(HTMLImageElement.prototype, 'complete', {
    configurable: true,
    get() { return this.src.startsWith('https://fixture.invalid/') ? false : complete.get.call(this); }
  });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
    configurable: true,
    get() { return this.dataset.testLoaded === 'true' ? 1 : naturalWidth.get.call(this); }
  });
}

test('客户端本地 Markdown artifact 与服务端共享 fixture 深度相等', async t => {
  const { page, base } = await withBrowser(t);
  await installRenderRoute(page);
  await installOutputRoute(page, []);
  await page.goto(base + '/typesetting');
  await waitForRenderState(page, 'current');

  for (const item of artifactFixtures) {
    const actual = await page.evaluate(document => ({
      mimeType: 'text/markdown;charset=utf-8',
      filename: `${window.safeOutputBaseName(document.title)}.md`,
      content: window.buildNormalizedMarkdown(document)
    }), item.document);
    assert.deepEqual(actual, item.artifact, item.name);
  }
});

test('客户端只接受 exact 六键 OutputBundle 和 exact nested snapshot artifact', async t => {
  const { page, base } = await withBrowser(t);
  await installRenderRoute(page);
  await installOutputRoute(page, []);
  await page.goto(base + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('严格 schema');
  await waitForReadyOutput(page);

  const snapshot = await page.evaluate(() => window.outputSnapshot());
  const valid = outputBundle(snapshot, { marker: 'strict' });
  assert.equal(await page.evaluate(({ value, expected }) => window.isValidOutputBundle(value, expected), { value: valid, expected: snapshot }), true);

  const mutations = [
    ['顶层额外键', value => { value.extra = true; }],
    ['顶层缺键', value => { delete value.html; }],
    ['未知 schema', value => { value.schemaVersion = 2; }],
    ['未知 status', value => { value.status = 'pending'; }],
    ['snapshot 额外键', value => { value.snapshot.revision = 1; }],
    ['document 额外键', value => { value.snapshot.document.savedAt = ''; }],
    ['document 缺键', value => { delete value.snapshot.document.author; }],
    ['settings 额外键', value => { value.snapshot.presentation.settings.extra = 'x'; }],
    ['failed targets 非字符串', value => { value.snapshot.failedImageTargets = [1]; }],
    ['failed targets 重复', value => { value.snapshot.failedImageTargets = ['a', 'a']; }],
    ['markdown 额外键', value => { value.markdown.extra = true; }],
    ['markdown MIME 错误', value => { value.markdown.mimeType = 'text/markdown'; }],
    ['markdown filename 错误类型', value => { value.markdown.filename = 1; }],
    ['clipboard 额外键', value => { value.clipboard.extra = true; }],
    ['clipboard html MIME 错误', value => { value.clipboard.html.mimeType = 'text/plain'; }],
    ['clipboard plain 缺键', value => { delete value.clipboard.plain.content; }],
    ['完整 HTML 额外键', value => { value.html.extra = true; }],
    ['完整 HTML MIME 错误', value => { value.html.mimeType = 'text/html'; }],
    ['ready 缺 clipboard', value => { value.clipboard = null; }],
    ['blocked 携带产物', value => { value.status = 'blocked'; }],
    ['snapshot 值漂移', value => { value.snapshot.document.body = '其他正文'; }]
  ];
  for (const [name, mutate] of mutations) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.equal(await page.evaluate(({ value, expected }) => window.isValidOutputBundle(value, expected), { value: candidate, expected: snapshot }), false, name);
  }

  const blockedSnapshot = structuredClone(snapshot);
  blockedSnapshot.document.body = '';
  const blocked = outputBundle(blockedSnapshot, { status: 'blocked', marker: 'blocked' });
  assert.equal(await page.evaluate(({ value, expected }) => window.isValidOutputBundle(value, expected), { value: blocked, expected: blockedSnapshot }), true);
});

test('最新 render 原子应用后预生成 ready 和 blocker 且请求只含完整 output snapshot', async t => {
  const { page, base } = await withBrowser(t);
  const calls = [];
  await installRenderRoute(page, request => {
    const result = renderResult(request);
    if (request.body === '可输出正文') result.presentation = {
      theme: 'simple',
      settings: { primaryColor: '#009874', fontSize: '17px', lineHeight: '1.9', blockSpacing: '1.15' }
    };
    return result;
  });
  await installOutputRoute(page, calls, (route, request) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(outputBundle(request, { marker: request.document.body ? 'ready-marker' : 'blocked-marker' }))
  }));
  await page.goto(base + '/typesetting');
  await waitForCount(calls, 1);
  await waitForRenderState(page, 'current');
  assert.deepEqual(Object.keys(calls[0]).sort(), ['convertExternalLinksToFootnotes', 'document', 'failedImageTargets', 'presentation']);
  assert.deepEqual(Object.keys(calls[0].document).sort(), ['account', 'author', 'body', 'publishedAt', 'title']);
  assert.deepEqual(calls[0].failedImageTargets, []);
  assert.equal(calls[0].document.revision, undefined);
  assert.equal(calls[0].document.savedAt, undefined);
  assert.equal(calls[0].preview, undefined);
  assert.equal(await page.evaluate(() => window.hasFreshReadyOutput()), false);
  assert.deepEqual(await currentMarkdownArtifact(page), outputBundle(calls[0], { marker: 'blocked-marker' }).markdown);

  await page.getByLabel('标题').fill('当前标题');
  await page.getByLabel('作者').fill('当前作者');
  await page.getByLabel('公众号名称').fill('当前账号');
  await page.getByLabel('发布日期').fill('2026-10-03');
  await page.getByLabel('Markdown 正文').fill('可输出正文');
  await waitForReadyOutput(page);
  const current = calls.at(-1);
  assert.deepEqual(current.document, {
    title: '当前标题',
    author: '当前作者',
    account: '当前账号',
    publishedAt: '2026-10-03',
    body: '可输出正文'
  });
  assert.deepEqual(current.presentation, {
    theme: 'simple',
    settings: { primaryColor: '#009874', fontSize: '17px', lineHeight: '1.9', blockSpacing: '1.15' }
  }, 'output 必须使用最新 RenderResult 已应用的 presentation，而非重新读取控件');
  assert.equal(current.convertExternalLinksToFootnotes, false);
  assert.deepEqual(await currentMarkdownArtifact(page), outputBundle(current, { marker: 'ready-marker' }).markdown, 'fresh bundle 必须直接提供完整 artifact');
});

test('五字段主题四设置脚注变化均先失效再按最新 applied presentation 重建', async t => {
  const { page, base } = await withBrowser(t);
  const calls = [];
  await installRenderRoute(page);
  await installOutputRoute(page, calls);
  await page.goto(base + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('初始正文');
  await waitForReadyOutput(page);

  const changes = [
    ['#document-title', 'input', '新标题'],
    ['#document-author', 'input', '新作者'],
    ['#document-account', 'input', '新账号'],
    ['#document-published-at', 'input', '2026-10-03'],
    ['#document-body', 'input', '新正文'],
    ['#document-theme', 'change', 'grace'],
    ['#theme-primary-color', 'change', '#FA5151'],
    ['#theme-font-size', 'change', '18px'],
    ['#theme-line-height', 'change', '2.05'],
    ['#theme-block-spacing', 'change', '1.35'],
    ['#convert-external-links', 'change', true]
  ];
  for (const [selector, eventName, value] of changes) {
    const wasFreshDuringHandler = await page.evaluate(({ selector, eventName, value }) => {
      const control = document.querySelector(selector);
      if (control.type === 'checkbox') control.checked = value;
      else control.value = value;
      control.dispatchEvent(new Event(eventName, { bubbles: true }));
      return window.hasFreshReadyOutput();
    }, { selector, eventName, value });
    assert.equal(wasFreshDuringHandler, false, selector);
    await waitForReadyOutput(page);
  }

  const latest = calls.at(-1);
  assert.deepEqual(latest.document, {
    title: '新标题', author: '新作者', account: '新账号', publishedAt: '2026-10-03', body: '新正文'
  });
  assert.deepEqual(latest.presentation, {
    theme: 'grace',
    settings: { primaryColor: '#FA5151', fontSize: '18px', lineHeight: '2.05', blockSpacing: '1.35' }
  });
  assert.equal(latest.convertExternalLinksToFootnotes, true);
});

test('已有 ready 后重置当前主题立即 stale 且只接受默认设置新 output', async t => {
  const { page, base } = await withBrowser(t);
  const calls = [];
  const held = [];
  let holdNext = false;
  await installRenderRoute(page);
  await installOutputRoute(page, calls, async (route, request) => {
    if (holdNext) {
      holdNext = false;
      const action = await new Promise(resolve => held.push({ resolve, request }));
      if (action === 'failure') return route.abort('failed');
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(outputBundle(request, { marker: request.presentation.settings.primaryColor })) });
  });
  await page.goto(base + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('重置主题');
  await page.getByLabel('主色').selectOption('#FA5151');
  await waitForReadyOutput(page);

  await page.evaluate(() => {
    window.__resetWrites = [];
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    for (const id of ['theme-primary-color', 'theme-font-size', 'theme-line-height', 'theme-block-spacing']) {
      const control = document.getElementById(id);
      Object.defineProperty(control, 'value', {
        configurable: true,
        get() { return descriptor.get.call(this); },
        set(value) {
          window.__resetWrites.push({ id: this.id, fresh: window.hasFreshReadyOutput(), value });
          descriptor.set.call(this, value);
        }
      });
    }
  });

  for (const oldOutcome of ['success', 'failure']) {
    if (oldOutcome === 'failure') {
      await page.getByLabel('主色').selectOption('#FECE00');
      await waitForReadyOutput(page);
    }
    holdNext = true;
    await page.evaluate(() => { void window.requestOutput(); });
    await waitForCount(held, oldOutcome === 'success' ? 1 : 2);
    await page.getByRole('button', { name: '恢复当前主题默认值' }).click();
    assert.equal(await page.evaluate(() => window.hasFreshReadyOutput()), false);
    const writes = await page.evaluate(() => window.__resetWrites.splice(0));
    assert.equal(writes.length, 4);
    assert.equal(writes.every(item => item.fresh === false), true, 'reset 必须先失效再写控件');
    await waitForReadyOutput(page);
    const current = calls.at(-1);
    assert.deepEqual(current.presentation.settings, settings);
    assert.deepEqual(await currentMarkdownArtifact(page), outputBundle(current, { marker: settings.primaryColor }).markdown);

    held.at(-1).resolve(oldOutcome);
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => window.hasFreshReadyOutput()), true);
    assert.deepEqual(await currentMarkdownArtifact(page), outputBundle(current, { marker: settings.primaryColor }).markdown, `慢旧 ${oldOutcome} 不得恢复旧 artifact`);
  }
});

test('慢旧 success failure 与非二百 malformed schema snapshot status 均不能恢复 stale cache', async t => {
  const { page, base } = await withBrowser(t);
  const calls = [];
  let mode = 'valid';
  const held = [];
  await installRenderRoute(page);
  await installOutputRoute(page, calls, async (route, request) => {
    if (mode === 'hold-success' || mode === 'hold-failure') {
      const outcome = mode;
      mode = 'valid';
      await new Promise(resolve => held.push({ resolve, request, outcome }));
      if (outcome === 'hold-failure') return route.abort('failed');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(outputBundle(request, { marker: `old-${request.document.body}` })) });
    }
    if (mode === 'non2xx') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'OUTPUT_GENERATION_FAILED', message: '固定失败', retryable: true } }) });
    if (mode === 'malformed') return route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
    let bundle = outputBundle(request, { marker: `current-${request.document.body}` });
    if (mode === 'schema') bundle = { ...bundle, extra: true };
    if (mode === 'snapshot') bundle.snapshot.document.title = '漂移标题';
    if (mode === 'status') bundle = outputBundle(request, { status: 'blocked', marker: 'wrong-status' });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(bundle) });
  });
  await page.goto(base + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('稳定');
  await waitForReadyOutput(page);

  for (const outcome of ['hold-success', 'hold-failure']) {
    mode = outcome;
    await page.getByLabel('Markdown 正文').fill(`旧-${outcome}`);
    await waitForCount(held, outcome === 'hold-success' ? 1 : 2);
    await page.getByLabel('Markdown 正文').fill(`新-${outcome}`);
    await waitForReadyOutput(page);
    const current = await currentMarkdownArtifact(page);
    held.at(-1).resolve();
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => window.hasFreshReadyOutput()), true);
    assert.deepEqual(await currentMarkdownArtifact(page), current, outcome);
  }

  for (const failureMode of ['non2xx', 'malformed', 'schema', 'snapshot', 'status']) {
    mode = failureMode;
    const before = calls.length;
    await page.getByLabel('Markdown 正文').fill(`失败-${failureMode}`);
    await waitForCount(calls, before + 1);
    await waitForRenderState(page, 'current');
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => window.hasFreshReadyOutput()), false, failureMode);
    const fallback = await currentMarkdownArtifact(page);
    assert.equal(fallback.filename, '未命名文章.md');
    assert.match(fallback.content, new RegExp(`失败-${failureMode}`));
  }
});

test('慢旧 output 成功失败均不能覆盖五字段正文主题设置 reset 脚注的新 snapshot', async t => {
  const { page, base } = await withBrowser(t, { initScript: installOutputBrowserSpies });
  const calls = [];
  const held = [];
  const live = [];
  let holdNext = false;
  let marker = 0;
  await installRenderRoute(page);
  await installOutputRoute(page, calls, async (route, request) => {
    if (holdNext) {
      holdNext = false;
      const outcome = await new Promise(resolve => held.push({ request, resolve }));
      if (outcome === 'failure') return route.abort('failed');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(outputBundle(request, { marker: `old-${++marker}` })) });
    }
    const bundle = outputBundle(request, { marker: `live-${++marker}` });
    live.push({ request: structuredClone(request), bundle });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(bundle) });
  });
  await page.goto(base + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('竞态正文-0');
  await waitForReadyOutput(page);

  let valueSequence = 0;
  const selectDifferent = async label => {
    const control = page.getByLabel(label);
    const current = await control.inputValue();
    const values = await control.locator('option').evaluateAll(options => options.map(option => option.value));
    await control.selectOption(values.find(value => value !== current));
  };
  const scenarios = [
    ['标题字段', () => page.getByLabel('标题').fill(`标题-${++valueSequence}`)],
    ['作者字段', () => page.getByLabel('作者').fill(`作者-${++valueSequence}`)],
    ['公众号字段', () => page.getByLabel('公众号名称').fill(`账号-${++valueSequence}`)],
    ['发布日期字段', () => page.getByLabel('发布日期').fill(`2026-10-${String(++valueSequence % 28 + 1).padStart(2, '0')}`)],
    ['正文字段', () => page.getByLabel('Markdown 正文').fill(`竞态正文-${++valueSequence}`)],
    ['主题', () => selectDifferent('主题')],
    ['主色设置', () => selectDifferent('主色')],
    ['字号设置', () => selectDifferent('字号')],
    ['行距设置', () => selectDifferent('行距')],
    ['段间距设置', () => selectDifferent('段间距')],
    ['reset', async () => {
      await page.getByRole('button', { name: '恢复当前主题默认值' }).click();
      assert.deepEqual(await page.evaluate(() => ({
        primaryColor: document.querySelector('#theme-primary-color').value,
        fontSize: document.querySelector('#theme-font-size').value,
        lineHeight: document.querySelector('#theme-line-height').value,
        blockSpacing: document.querySelector('#theme-block-spacing').value
      })), settings);
    }, async () => {
      if (await page.getByLabel('主色').inputValue() === '#FA5151') await page.getByLabel('主色').selectOption('#009874');
      else await page.getByLabel('主色').selectOption('#FA5151');
      await waitForReadyOutput(page);
    }],
    ['脚注开关', () => page.getByLabel('外链转脚注').click()]
  ];

  for (const outcome of ['success', 'failure']) {
    for (const [name, change, prepare] of scenarios) {
      if (prepare) await prepare();
      holdNext = true;
      const heldCount = held.length;
      await page.evaluate(() => { void window.requestOutput(); });
      await waitForCount(held, heldCount + 1);
      await change();
      assert.equal(await page.evaluate(() => window.hasFreshReadyOutput()), false, `${name} 必须同步失效`);
      await waitForReadyOutput(page);
      const accepted = live.at(-1);
      const statusBefore = await page.locator('#output-status').textContent();
      const errorBefore = await page.locator('#output-error').textContent();
      held.at(-1).resolve(outcome);
      await page.waitForTimeout(60);
      assert.equal(await page.evaluate(() => window.hasFreshReadyOutput()), true, `${name} ${outcome} 不得关闭新 gate`);
      assert.deepEqual(await page.evaluate(() => window.outputSnapshot()), accepted.request, `${name} ${outcome} 必须保留新 snapshot`);
      assert.deepEqual(await currentMarkdownArtifact(page), accepted.bundle.markdown, `${name} ${outcome} 不得恢复旧 Markdown`);
      assert.equal(await page.locator('#output-status').textContent(), statusBefore, `${name} ${outcome} 不得覆盖 status`);
      assert.equal(await page.locator('#output-error').textContent(), errorBefore, `${name} ${outcome} 不得覆盖 error`);
      assert.equal(await page.locator('#copy-wechat').isEnabled(), true);
      assert.equal(await page.locator('#download-html').isEnabled(), true);
      assert.deepEqual(accepted.request.failedImageTargets, []);

      const downloadCount = await page.evaluate(() => window.__downloadClicks.length);
      await page.locator('#download-html').click();
      await page.waitForFunction(count => window.__revokedUrls.length === count + 1, downloadCount);
      const download = await page.evaluate(async index => ({
        filename: window.__downloadClicks[index].download,
        content: await window.__createdBlobs[index].text()
      }), downloadCount);
      assert.deepEqual(download, { filename: accepted.bundle.html.filename, content: accepted.bundle.html.content }, `${name} ${outcome} 下载必须保持新 artifact`);
    }
  }
});

test('render stale pending malformed 时旧 ready bundle 不能复制或下载 HTML', async t => {
  const { page, base } = await withBrowser(t, { initScript: installOutputBrowserSpies });
  let renderMode = 'valid';
  const held = [];
  await page.route('**/api/typesetting/render', async route => {
    const request = route.request().postDataJSON();
    if (renderMode === 'pending') await new Promise(resolve => held.push(resolve));
    if (renderMode === 'failure') return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    if (renderMode === 'malformed') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...renderResult(request), extra: true }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(renderResult(request)) });
  });
  await installOutputRoute(page, []);
  await page.goto(base + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('旧 ready');
  await waitForReadyOutput(page);

  const assertNoRichSideEffect = async label => {
    const before = await page.evaluate(() => ({ writes: window.__clipboardWrites.length, blobs: window.__createdBlobs.length }));
    await page.evaluate(() => {
      document.querySelector('#copy-wechat').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.querySelector('#download-html').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForTimeout(30);
    assert.deepEqual(await page.evaluate(() => ({ writes: window.__clipboardWrites.length, blobs: window.__createdBlobs.length })), before, label);
    assert.equal(await page.locator('#copy-wechat').isDisabled(), true, label);
    assert.equal(await page.locator('#download-html').isDisabled(), true, label);
  };

  renderMode = 'pending';
  await page.getByLabel('Markdown 正文').fill('render pending');
  await waitForCount(held, 1);
  await waitForRenderState(page, 'checking');
  await assertNoRichSideEffect('pending');
  renderMode = 'valid';
  held.shift()();
  await waitForReadyOutput(page);

  renderMode = 'failure';
  await page.getByLabel('Markdown 正文').fill('render stale');
  await waitForRenderState(page, 'stale');
  await assertNoRichSideEffect('stale');

  renderMode = 'malformed';
  await page.getByLabel('Markdown 正文').fill('render malformed');
  await waitForRenderState(page, 'stale');
  await assertNoRichSideEffect('malformed');
});

test('图片 loaded 不失效而首次 error 按当前 DOM 顺序重建且重复旧事件无效', async t => {
  const { page, base } = await withBrowser(t, { initScript: installPendingImageSpies });
  const calls = [];
  await page.route('https://fixture.invalid/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: onePixelPng }));
  await installRenderRoute(page, request => renderResult(request, request.body === '三张图片' ? [
    '<img src="https://fixture.invalid/one.png" alt="一" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="image-one">',
    '<img src="https://fixture.invalid/two.png" alt="二" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="image-two">',
    '<img src="https://fixture.invalid/three.png" alt="三" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="image-three">'
  ].join('') : undefined));
  await installOutputRoute(page, calls);
  await page.goto(base + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('三张图片');
  await page.locator('#preview img').nth(2).waitFor();
  await waitForReadyOutput(page);
  const baseline = calls.length;

  await page.evaluate(() => {
    const images = [...document.querySelectorAll('#preview img')];
    images[0].dataset.testLoaded = 'true';
    window.__imageHandlers.get(images[0]).load();
  });
  await page.waitForTimeout(50);
  assert.equal(calls.length, baseline, 'loaded 不得失效或重建 output');
  assert.equal(await page.evaluate(() => window.hasFreshReadyOutput()), true);

  await page.evaluate(() => {
    const images = [...document.querySelectorAll('#preview img')];
    window.__oldThirdImage = images[2];
    window.__oldThirdError = window.__imageHandlers.get(images[2]).error;
    window.__oldThirdError();
  });
  await waitForCount(calls, baseline + 1);
  assert.deepEqual(calls.at(-1).failedImageTargets, ['image-three']);
  await waitForReadyOutput(page);

  await page.evaluate(() => {
    const second = [...document.querySelectorAll('#preview img')].find(img => img.dataset.formatTarget === 'image-two');
    window.__oldSecondError = window.__imageHandlers.get(second).error;
    window.__oldSecondError();
  });
  await waitForCount(calls, baseline + 2);
  assert.deepEqual(calls.at(-1).failedImageTargets, ['image-two', 'image-three'], '必须按当前 DOM 顺序而非 error 到达顺序提交');
  await waitForReadyOutput(page);

  const afterFailures = calls.length;
  await page.evaluate(() => { window.__oldThirdError(); window.__oldSecondError(); });
  await page.waitForTimeout(80);
  assert.equal(calls.length, afterFailures, '重复或旧节点事件不得重建');

  await page.getByLabel('Markdown 正文').fill('新预览');
  await waitForReadyOutput(page);
  const afterNewRender = calls.length;
  await page.evaluate(() => window.__oldThirdError());
  await page.waitForTimeout(80);
  assert.equal(calls.length, afterNewRender, '旧 render 图片事件不得污染当前 failed set');
  assert.deepEqual(calls.at(-1).failedImageTargets, []);
});

test('坏图 snapshot 的慢旧 output 成功失败不能覆盖无 src 占位且新旧 DOM 事件隔离', async t => {
  const { page, base } = await withBrowser(t, { initScript: [installOutputBrowserSpies, installPendingImageSpies] });
  const calls = [];
  const held = [];
  let holdNext = false;
  let imageVersion = 0;
  await page.route('https://fixture.invalid/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: onePixelPng }));
  await installRenderRoute(page, request => {
    if (!request.body.startsWith('坏图竞态')) return renderResult(request);
    const suffix = request.body.split('-').at(-1);
    return renderResult(request, `<img src="https://fixture.invalid/${suffix}.png" alt="坏图 ${suffix}" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="image-${suffix}">`);
  });
  await installOutputRoute(page, calls, async (route, request) => {
    if (holdNext) {
      holdNext = false;
      const outcome = await new Promise(resolve => held.push({ request, resolve }));
      if (outcome === 'failure') return route.abort('failed');
    }
    const bundle = outputBundle(request, { marker: request.failedImageTargets.join(',') || `clean-${++imageVersion}` });
    if (request.failedImageTargets.length) {
      const placeholder = '<figure role="note"><figcaption>图片加载失败。请检查图片地址后重试。</figcaption></figure>';
      bundle.clipboard.html.content = placeholder;
      bundle.clipboard.plain.content = '图片加载失败。请检查图片地址后重试。';
      bundle.html.content = `<!doctype html><html><body>${placeholder}</body></html>`;
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(bundle) });
  });
  await page.goto(base + '/typesetting');

  const oldErrors = [];
  for (const [index, outcome] of ['success', 'failure'].entries()) {
    await page.getByLabel('Markdown 正文').fill(`坏图竞态-${index + 1}`);
    await page.locator('#preview img').waitFor();
    await waitForReadyOutput(page);
    assert.deepEqual((await page.evaluate(() => window.outputSnapshot())).failedImageTargets, [], '新 render 必须清空旧 failed set');

    holdNext = true;
    const heldCount = held.length;
    await page.evaluate(() => { void window.requestOutput(); });
    await waitForCount(held, heldCount + 1);
    const beforeFailureCalls = calls.length;
    const immediate = await page.evaluate(() => {
      const image = document.querySelector('#preview img');
      window.__task7OldError = window.__imageHandlers.get(image).error;
      window.__task7OldError();
      return {
        fresh: window.hasFreshReadyOutput(),
        copyDisabled: document.querySelector('#copy-wechat').disabled,
        htmlDisabled: document.querySelector('#download-html').disabled
      };
    });
    oldErrors.push(await page.evaluateHandle(() => window.__task7OldError));
    assert.deepEqual(immediate, { fresh: false, copyDisabled: true, htmlDisabled: true }, '首次 error 必须同步关闭 ready gate');
    await waitForCount(calls, beforeFailureCalls + 1);
    assert.deepEqual(calls.at(-1).failedImageTargets, [`image-${index + 1}`]);
    await waitForReadyOutput(page);

    held.at(-1).resolve(outcome);
    await page.waitForTimeout(60);
    assert.equal(await page.evaluate(() => window.hasFreshReadyOutput()), true, `旧 ${outcome} 不得覆盖坏图新 bundle`);
    assert.deepEqual((await page.evaluate(() => window.outputSnapshot())).failedImageTargets, [`image-${index + 1}`]);
    await page.locator('#copy-wechat').click();
    await page.waitForFunction(count => window.__clipboardItems.length === count, index + 1);
    const richHtml = await page.evaluate(async itemIndex => window.__clipboardItems[itemIndex].types['text/html'].text(), index);
    assert.match(richHtml, /图片加载失败/u);
    assert.doesNotMatch(richHtml, /\ssrc=/iu, '恢复后的坏图 bundle 必须是无 src 占位');

    const callsBeforeOldEvent = calls.length;
    await oldErrors.at(-1).evaluate(handler => handler());
    await page.waitForTimeout(40);
    assert.equal(calls.length, callsBeforeOldEvent, '已替换的旧 DOM 事件不得再次改变 failed set');
  }
});

test('真实 server restart 的新 nonce 使非空 target stale 后重新 render 而空 target 正常接受', async t => {
  const { page, base } = await withBrowser(t, { initScript: installPendingImageSpies });
  const restarted = await startIsolatedServer(t);
  const forwarded = [];
  const heldRestartRenders = [];
  let holdRestartRender = true;
  await page.route('https://fixture.invalid/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: onePixelPng }));
  await page.goto(base + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('![重启图片](https://fixture.invalid/restart.png)');
  await page.locator('#preview img').waitFor();
  await waitForReadyOutput(page);
  const oldTarget = await page.locator('#preview img').getAttribute('data-format-target');
  const oldError = await page.evaluateHandle(() => window.__imageHandlers.get(document.querySelector('#preview img')).error);

  const forwardToRestartedServer = async route => {
    const request = route.request();
    const endpoint = new URL(request.url()).pathname;
    const requestBody = request.postData();
    if (endpoint.endsWith('/render') && holdRestartRender) {
      await new Promise(resolve => heldRestartRenders.push(resolve));
      holdRestartRender = false;
    }
    const response = await fetch(restarted.base + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: restarted.base },
      body: requestBody
    });
    const body = await response.text();
    forwarded.push({ endpoint, request: JSON.parse(requestBody), status: response.status, body });
    await route.fulfill({ status: response.status, contentType: 'application/json', body });
  };
  await page.route('**/api/typesetting/render', forwardToRestartedServer);
  await page.route('**/api/typesetting/output', forwardToRestartedServer);

  await oldError.evaluate(handler => handler());
  await waitForCount(heldRestartRenders, 1);
  assert.equal(await page.evaluate(() => window.hasFreshReadyOutput()), false, 'target-invalid 后 render/output gate 必须同时 stale');
  assert.equal(await page.locator('#render-status').getAttribute('data-state'), 'checking');
  assert.deepEqual((await page.evaluate(() => window.outputSnapshot())).failedImageTargets, [oldTarget], '重新 render 前不得静默删除旧 target');
  assert.equal(forwarded.filter(entry => entry.endpoint.endsWith('/output')).length, 1, '重新 render 前不得清空 target 后静默重试 output');
  heldRestartRenders[0]();
  try {
    await page.waitForFunction(() => document.querySelector('#render-status')?.dataset.state === 'current'
      && window.hasFreshReadyOutput() && document.querySelector('#preview img'));
  } catch (error) {
    const state = await page.evaluate(() => ({
      renderState: document.querySelector('#render-status')?.dataset.state,
      renderBlocked: document.querySelector('#render-status')?.dataset.blocked,
      ready: window.hasFreshReadyOutput(),
      snapshot: window.outputSnapshot(),
      outputError: document.querySelector('#output-error')?.textContent
    }));
    assert.fail(`${error.message}\nforwarded=${JSON.stringify(forwarded)}\nstate=${JSON.stringify(state)}`);
  }
  const invalid = forwarded.find(entry => entry.endpoint.endsWith('/output') && entry.status === 400);
  assert.ok(invalid, '旧 nonce 的非空 failed target 必须由真实新服务拒绝');
  assert.deepEqual(invalid.request.failedImageTargets, [oldTarget]);
  assert.equal(JSON.parse(invalid.body).error.code, 'OUTPUT_FAILED_IMAGE_TARGET_INVALID');
  const renderAfterInvalid = forwarded.findIndex(entry => entry.endpoint.endsWith('/render'));
  const invalidIndex = forwarded.indexOf(invalid);
  assert.equal(renderAfterInvalid > invalidIndex, true, 'typed target error 后必须重新请求 render');
  assert.equal(forwarded.slice(invalidIndex + 1, renderAfterInvalid).some(entry => entry.endpoint.endsWith('/output')), false, '新 render 前不得静默重试 output');

  const newTarget = await page.locator('#preview img').getAttribute('data-format-target');
  assert.notEqual(newTarget, oldTarget, '新服务必须产生不同 target nonce');
  const acceptedEmpty = forwarded.find((entry, index) => index > renderAfterInvalid
    && entry.endpoint.endsWith('/output') && entry.status === 200 && entry.request.failedImageTargets.length === 0);
  assert.ok(acceptedEmpty, '新 render 后空 failed target 必须跨 restart 正常接受');
  assert.doesNotMatch(acceptedEmpty.body, /format-target-/u, '空 target 响应不得泄漏新 nonce');
  assert.deepEqual((await page.evaluate(() => window.outputSnapshot())).failedImageTargets, [], '新 render 应清空旧 failed set');

  const forwardedBeforeOldEvent = forwarded.length;
  await oldError.evaluate(handler => handler());
  await page.waitForTimeout(50);
  assert.equal(forwarded.length, forwardedBeforeOldEvent, '旧 DOM error 在新 render 后必须无效');

  await page.evaluate(() => window.__imageHandlers.get(document.querySelector('#preview img')).error());
  await page.waitForFunction(target => window.outputSnapshot().failedImageTargets[0] === target && window.hasFreshReadyOutput(), newTarget);
  const rebuilt = forwarded.find(entry => entry.endpoint.endsWith('/output') && entry.status === 200
    && entry.request.failedImageTargets[0] === newTarget);
  assert.ok(rebuilt, '新 DOM error 必须用新 nonce 重建 failed set');
  assert.match(rebuilt.body, /图片加载失败/u);
  assert.doesNotMatch(JSON.parse(rebuilt.body).clipboard.html.content, /\ssrc=/iu);
});

test('blocker conversion advisory 静态占位门禁只禁止 blocker 且始终保留当前 Markdown', async t => {
  const { page, base } = await withBrowser(t);
  const calls = [];
  await installRenderRoute(page, request => {
    if (request.body === '触发 RENDER_FAILED') return {
      html: '',
      presentation: { theme: request.theme, settings: request.settings },
      diagnostics: [{
        id: 'render-failed',
        code: 'RENDER_FAILED',
        severity: 'blocker',
        message: '正文渲染失败。',
        targets: [{ kind: 'source', start: 0, end: request.body.length }]
      }],
      blocked: true
    };
    if (request.body === '转换内容') return {
      html: '<p>转换内容</p>',
      presentation: { theme: request.theme, settings: request.settings },
      diagnostics: [{
        id: 'conversion',
        code: 'UNSAFE_RICH_TEXT_REMOVED',
        severity: 'conversion',
        message: '已移除不安全内容。',
        targets: [{ kind: 'source', start: 0, end: request.body.length }],
        meta: { types: ['script'] }
      }],
      blocked: false
    };
    if (request.body === '静态占位') return {
      html: '<figure class="format-image-placeholder" data-format-target="static-image" tabindex="0" role="note"><figcaption>图片缺少来源。请补充 HTTPS 地址。</figcaption></figure>',
      presentation: { theme: request.theme, settings: request.settings },
      diagnostics: [{
        id: 'advisory',
        code: 'IMAGE_MISSING_SOURCE',
        severity: 'advisory',
        message: '图片缺少来源。',
        targets: [{ kind: 'preview', id: 'static-image' }]
      }],
      blocked: false
    };
    return renderResult(request);
  });
  await installOutputRoute(page, calls, (route, request) => {
    const blocked = request.document.body === '' || request.document.body === '触发 RENDER_FAILED';
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(outputBundle(request, { status: blocked ? 'blocked' : 'ready', marker: request.document.body || 'EMPTY_BODY' })) });
  });
  await page.goto(base + '/typesetting');

  for (const entry of [
    { body: '', blocked: true, label: 'EMPTY_BODY' },
    { body: '触发 RENDER_FAILED', blocked: true, label: 'RENDER_FAILED' },
    { body: '转换内容', blocked: false, label: 'conversion' },
    { body: '静态占位', blocked: false, label: 'advisory/static placeholder' }
  ]) {
    if (await page.getByLabel('Markdown 正文').inputValue() !== entry.body) await page.getByLabel('Markdown 正文').fill(entry.body);
    await page.waitForFunction(() => window.hasFreshOutput());
    assert.equal(await page.evaluate(() => window.hasFreshReadyOutput()), !entry.blocked, entry.label);
    assert.equal(await page.locator('#copy-wechat').isDisabled(), entry.blocked, entry.label);
    assert.equal(await page.locator('#download-html').isDisabled(), entry.blocked, entry.label);
    assert.equal(await page.locator('#copy-markdown').isEnabled(), true, entry.label);
    assert.equal(await page.locator('#download-markdown').isEnabled(), true, entry.label);
    const artifact = await currentMarkdownArtifact(page);
    assert.equal(artifact.content, `SERVER:${entry.body || 'EMPTY_BODY'}`, `${entry.label} 必须保留当前 Markdown`);
  }
});

test('输出区保留现有 label 并提供四个元信息复制按钮和四个输出动作', async t => {
  const { page, base } = await withBrowser(t, { initScript: installOutputBrowserSpies });
  await page.setViewportSize({ width: 720, height: 1000 });
  await installRenderRoute(page);
  await installOutputRoute(page, []);
  await page.goto(base + '/typesetting');
  await waitForRenderState(page, 'current');

  for (const [field, copyName] of [
    ['标题', '复制标题'],
    ['作者', '复制作者'],
    ['公众号名称', '复制公众号名称'],
    ['发布日期', '复制发布日期']
  ]) {
    assert.equal(await page.getByLabel(field).count(), 1, `${field} label 仍须关联原输入`);
    assert.equal(await page.getByRole('button', { name: copyName, exact: true }).count(), 1);
  }
  for (const name of ['复制到微信', '复制 Markdown', '下载 HTML', '下载 Markdown']) {
    const button = page.getByRole('button', { name, exact: true });
    assert.equal(await button.count(), 1);
    assert.equal(await button.evaluate(node => getComputedStyle(node).height.replace('px', '') >= 42), true, `${name} 触控高度`);
  }
  assert.equal(await page.locator('#output-status[role="status"]').count(), 1);
  assert.equal(await page.locator('#output-error[role="alert"]').count(), 1);
  assert.equal(await page.evaluate(() => {
    const editor = document.querySelector('.typesetting-editor');
    const proof = document.querySelector('.typesetting-proof');
    return Boolean(editor.compareDocumentPosition(proof) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), true, '窄屏不得改变编辑区与预览区的主体顺序');
});

test('HTML gate disabled pending blocker stale error 且 Markdown 下载始终可用', async t => {
  const { page, base } = await withBrowser(t, { initScript: installOutputBrowserSpies });
  const calls = [];
  let mode = 'valid';
  let releasePending;
  await installRenderRoute(page);
  await installOutputRoute(page, calls, async (route, request) => {
    if (mode === 'pending') await new Promise(resolve => { releasePending = resolve; });
    if (mode === 'failure') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'OUTPUT_GENERATION_FAILED', message: '排版输出生成失败', retryable: true } }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(outputBundle(request)) });
  });
  await page.goto(base + '/typesetting');
  await page.waitForFunction(() => document.querySelector('#output-status')?.textContent.includes('存在阻断问题'));
  assert.equal(await page.locator('#copy-wechat').isDisabled(), true);
  assert.equal(await page.locator('#download-html').isDisabled(), true);
  assert.equal(await page.locator('#download-markdown').isEnabled(), true);
  assert.equal(await page.locator('#output-error').textContent(), '');

  mode = 'pending';
  await page.getByLabel('Markdown 正文').fill('待准备');
  await page.waitForFunction(() => document.querySelector('#output-status')?.textContent === '正在准备输出');
  assert.equal(await page.locator('#copy-wechat').isDisabled(), true);
  assert.equal(await page.locator('#download-html').isDisabled(), true);
  assert.equal(await page.locator('#download-markdown').isEnabled(), true);
  mode = 'valid';
  releasePending();
  await waitForReadyOutput(page);
  assert.equal(await page.locator('#copy-wechat').isEnabled(), true);
  assert.equal(await page.locator('#download-html').isEnabled(), true);
  assert.equal(await page.locator('#output-status').textContent(), '输出已准备');

  mode = 'failure';
  const beforeFailure = calls.length;
  await page.getByLabel('Markdown 正文').fill('输出失败');
  await waitForCount(calls, beforeFailure + 1);
  await page.waitForFunction(() => document.querySelector('#output-error')?.textContent.includes('未能生成富文本'));
  assert.equal(await page.locator('#copy-wechat').isDisabled(), true);
  assert.equal(await page.locator('#download-html').isDisabled(), true);
  assert.equal(await page.locator('#download-markdown').isEnabled(), true);
});

test('clipboard 降级在非 secure 无 ClipboardItem supports false 与 write reject 时无 rich fallback', async t => {
  const { page, base } = await withBrowser(t, { initScript: installOutputBrowserSpies });
  await installRenderRoute(page);
  await installOutputRoute(page, []);
  await page.goto(base + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('双 MIME 正文');
  await waitForReadyOutput(page);

  await page.evaluate(() => { window.__clipboardMode = 'pending'; });
  await page.locator('#copy-wechat').click();
  await page.waitForFunction(() => window.__pendingClipboardWrites.length === 1);
  assert.doesNotMatch(await page.locator('#output-status').textContent(), /已复制正文富文本/u);
  const pendingShape = await page.evaluate(async () => ({
    itemCount: window.__clipboardItems.length,
    itemTypes: Object.keys(window.__clipboardItems[0].types).sort(),
    html: await window.__clipboardItems[0].types['text/html'].text(),
    plain: await window.__clipboardItems[0].types['text/plain'].text(),
    writeCount: window.__clipboardWrites.length,
    writeTextCount: window.__writeTextCalls.length,
    execCount: window.__execCommandCalls
  }));
  assert.deepEqual(pendingShape, {
    itemCount: 1,
    itemTypes: ['text/html', 'text/plain'],
    html: '<p>双 MIME 正文</p>',
    plain: '双 MIME 正文',
    writeCount: 1,
    writeTextCount: 0,
    execCount: 0
  });
  await page.evaluate(() => window.__pendingClipboardWrites[0].resolve());
  await page.waitForFunction(() => document.querySelector('#output-status')?.textContent === '已复制正文富文本');

  await page.evaluate(() => { window.__clipboardMode = 'reject'; });
  await page.locator('#copy-wechat').click();
  await page.waitForFunction(() => document.querySelector('#output-error')?.textContent.includes('未能复制富文本'));
  assert.equal(await page.locator('#download-html').isEnabled(), true, '剪贴板失败不得隐藏 HTML 下载');
  assert.deepEqual(await page.evaluate(() => ({ writeTextCount: window.__writeTextCalls.length, execCount: window.__execCommandCalls })), { writeTextCount: 0, execCount: 0 });

  const beforeUnsupported = await page.evaluate(() => ({ items: window.__clipboardItems.length, writes: window.__clipboardWrites.length }));
  await page.evaluate(() => { window.__clipboardSupports['text/plain'] = false; });
  await page.locator('#copy-wechat').click();
  await page.waitForFunction(() => document.querySelector('#output-error')?.textContent.includes('未能复制富文本'));
  assert.deepEqual(await page.evaluate(() => ({ items: window.__clipboardItems.length, writes: window.__clipboardWrites.length })), beforeUnsupported, '支持性检查必须早于 Blob/ClipboardItem/write');

  await page.evaluate(() => { window.__clipboardSupports['text/plain'] = true; window.__clipboardMode = 'throw'; });
  await page.locator('#copy-wechat').click();
  await page.waitForFunction(() => document.querySelector('#output-error')?.textContent.includes('未能复制富文本'));
  assert.deepEqual(await page.evaluate(() => ({
    items: window.__clipboardItems.length,
    writes: window.__clipboardWrites.length,
    writeText: window.__writeTextCalls.length,
    exec: window.__execCommandCalls
  })), { items: beforeUnsupported.items + 1, writes: beforeUnsupported.writes + 1, writeText: 0, exec: 0 }, 'write 同步抛错也不得 fallback');

  const beforeMissingItem = await page.evaluate(() => ({ items: window.__clipboardItems.length, writes: window.__clipboardWrites.length }));
  await page.evaluate(() => { window.ClipboardItem = undefined; window.__clipboardMode = 'resolve'; });
  await page.locator('#copy-wechat').click();
  await page.waitForFunction(() => document.querySelector('#output-error')?.textContent.includes('未能复制富文本'));
  assert.deepEqual(await page.evaluate(() => ({ items: window.__clipboardItems.length, writes: window.__clipboardWrites.length })), beforeMissingItem, '无 ClipboardItem 不得构造 item 或写入');
  assert.equal(await page.locator('#download-html').isEnabled(), true, '无 ClipboardItem 仍须保留 HTML 下载');

  const beforeInsecure = await page.evaluate(() => ({ items: window.__clipboardItems.length, writes: window.__clipboardWrites.length }));
  await page.evaluate(() => { window.ClipboardItem = window.__TestClipboardItem; window.__secureContext = false; });
  await page.locator('#copy-wechat').click();
  await page.waitForFunction(() => document.querySelector('#output-error')?.textContent.includes('未能复制富文本'));
  assert.deepEqual(await page.evaluate(() => ({ items: window.__clipboardItems.length, writes: window.__clipboardWrites.length })), beforeInsecure, '非安全上下文不得构造 item 或写入');
  assert.deepEqual(await page.evaluate(() => ({ writeText: window.__writeTextCalls.length, exec: window.__execCommandCalls })), { writeText: 0, exec: 0 });
  assert.equal(await page.locator('#download-html').isEnabled(), true, '非安全上下文仍须保留 HTML 下载');
});

test('元信息复制按点击时原值各调用一次 writeText', async t => {
  const { page, base } = await withBrowser(t, { initScript: installOutputBrowserSpies });
  await installRenderRoute(page);
  await installOutputRoute(page, []);
  await page.goto(base + '/typesetting');
  const cases = [
    ['标题', '标题原值'],
    ['作者', ' 作者 '],
    ['公众号名称', '账号#1'],
    ['发布日期', '']
  ];
  for (const [index, [field, value]] of cases.entries()) {
    const input = page.getByLabel(field);
    await input.fill(value);
    await page.getByRole('button', { name: `复制${field}`, exact: true }).click();
    await page.waitForFunction(expected => window.__writeTextCalls.length === expected, index + 1);
  }
  assert.deepEqual(await page.evaluate(() => window.__writeTextCalls), cases.map(([, value]) => value));
  assert.equal(await page.locator('#output-status').textContent(), '已复制发布日期');

  await page.evaluate(() => { window.__writeTextMode = 'reject'; });
  await page.getByRole('button', { name: '复制标题', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#output-error')?.textContent.includes('未能复制标题'));
  assert.notEqual(await page.locator('#output-status').textContent(), '已复制标题');
  assert.equal(await page.evaluate(() => window.__execCommandCalls), 0);
});

test('Markdown 复制与 Blob 下载严格使用当前 artifact 且 HTML 重查 gate', async t => {
  const { page, base } = await withBrowser(t, { initScript: installOutputBrowserSpies });
  const outputCalls = [];
  await installRenderRoute(page);
  await installOutputRoute(page, outputCalls);
  await page.goto(base + '/typesetting');
  await page.waitForFunction(() => document.querySelector('#output-status')?.textContent.includes('存在阻断问题'));
  const blockedBundle = outputBundle(outputCalls.at(-1));
  await page.locator('#download-markdown').click();
  await page.waitForFunction(() => window.__revokedUrls.length === 1);
  assert.deepEqual(await page.evaluate(async () => ({
    type: window.__createdBlobs[0].type,
    content: await window.__createdBlobs[0].text(),
    filename: window.__downloadClicks[0].download
  })), {
    type: blockedBundle.markdown.mimeType,
    content: blockedBundle.markdown.content,
    filename: blockedBundle.markdown.filename
  }, 'fresh blocked bundle 仍必须直接下载服务端 Markdown artifact');
  await page.evaluate(() => {
    window.__createdBlobs = [];
    window.__downloadClicks = [];
    window.__revokedUrls = [];
  });
  await page.getByLabel('标题').fill('服务端标题');
  await page.getByLabel('Markdown 正文').fill('可下载正文');
  await waitForReadyOutput(page);
  const readyBundle = outputBundle(outputCalls.at(-1));

  await page.locator('#copy-markdown').click();
  await page.waitForFunction(() => window.__writeTextCalls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__writeTextCalls), [readyBundle.markdown.content]);
  await page.locator('#download-html').click();
  await page.locator('#download-markdown').click();
  await page.waitForFunction(() => window.__revokedUrls.length === 2);
  const readyDownloads = await page.evaluate(async () => Promise.all(window.__createdBlobs.map(async (blob, index) => ({
    type: blob.type,
    content: await blob.text(),
    filename: window.__downloadClicks[index].download,
    connectedAtClick: window.__downloadClicks[index].connected,
    connectedAfterCleanup: window.__downloadClicks[index].anchor.isConnected
  }))));
  assert.deepEqual(readyDownloads, [
    { type: readyBundle.html.mimeType, content: readyBundle.html.content, filename: readyBundle.html.filename, connectedAtClick: true, connectedAfterCleanup: false },
    { type: readyBundle.markdown.mimeType, content: readyBundle.markdown.content, filename: readyBundle.markdown.filename, connectedAtClick: true, connectedAfterCleanup: false }
  ]);

  const beforeStale = await page.evaluate(() => ({ blobs: window.__createdBlobs.length, clicks: window.__downloadClicks.length }));
  await page.evaluate(() => {
    const title = document.querySelector('#document-title');
    title.value = '本地/新标题';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#download-html').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.querySelector('#download-markdown').click();
  });
  await page.waitForFunction(count => window.__createdBlobs.length === count + 1, beforeStale.blobs);
  await page.waitForFunction(count => window.__revokedUrls.length === count + 1, 2);
  const staleDownload = await page.evaluate(async () => {
    const index = window.__createdBlobs.length - 1;
    return {
      type: window.__createdBlobs[index].type,
      content: await window.__createdBlobs[index].text(),
      filename: window.__downloadClicks[index].download,
      blobs: window.__createdBlobs.length,
      clicks: window.__downloadClicks.length,
      openCalls: window.__openCalls.length
    };
  });
  assert.equal(staleDownload.type, 'text/markdown;charset=utf-8');
  assert.equal(staleDownload.filename, '本地_新标题.md');
  assert.match(staleDownload.content, /^---\ntitle: "本地\/新标题"/u);
  assert.equal(staleDownload.blobs, beforeStale.blobs + 1, 'stale HTML 点击不得创建 Blob');
  assert.equal(staleDownload.clicks, beforeStale.clicks + 1, 'stale HTML 点击不得创建 anchor');
  assert.equal(staleDownload.openCalls, 0);
});

test('rich pending 后编辑使动作失效且 resolve 不产生幽灵提示', async t => {
  const { page, base } = await withBrowser(t, { initScript: installOutputBrowserSpies });
  await installRenderRoute(page);
  await installOutputRoute(page, []);
  await page.goto(base + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('幽灵提示');
  await waitForReadyOutput(page);

  await page.evaluate(() => { window.__clipboardMode = 'pending'; });
  await page.locator('#copy-wechat').click();
  await page.waitForFunction(() => window.__pendingClipboardWrites.length === 1);
  await page.getByLabel('标题').fill('输出已失效');
  await page.evaluate(() => window.__pendingClipboardWrites[0].resolve());
  await page.waitForTimeout(40);
  assert.notEqual(await page.locator('#output-status').textContent(), '已复制正文富文本');
  assert.doesNotMatch(await page.locator('#output-error').textContent(), /未能复制富文本/u);
});

test('快速重复 rich action token 只允许已 resolve 的最新 write 报成功', async t => {
  const { page, base } = await withBrowser(t, { initScript: installOutputBrowserSpies });
  await installRenderRoute(page);
  await installOutputRoute(page, []);
  await page.goto(base + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('两次 rich');
  await waitForReadyOutput(page);

  await page.evaluate(() => { window.__clipboardMode = 'pending'; });
  await page.locator('#copy-wechat').click();
  await page.locator('#copy-wechat').click();
  await page.waitForFunction(() => window.__pendingClipboardWrites.length === 2);
  assert.deepEqual(await page.evaluate(() => ({
    itemCount: window.__clipboardItems.length,
    writeCount: window.__clipboardWrites.length,
    firstWriteLength: window.__clipboardWrites[0].length,
    secondWriteLength: window.__clipboardWrites[1].length,
    firstIdentity: window.__clipboardWrites[0][0] === window.__clipboardItems[0],
    secondIdentity: window.__clipboardWrites[1][0] === window.__clipboardItems[1],
    firstTypes: Object.keys(window.__clipboardItems[0].types).sort(),
    secondTypes: Object.keys(window.__clipboardItems[1].types).sort()
  })), {
    itemCount: 2,
    writeCount: 2,
    firstWriteLength: 1,
    secondWriteLength: 1,
    firstIdentity: true,
    secondIdentity: true,
    firstTypes: ['text/html', 'text/plain'],
    secondTypes: ['text/html', 'text/plain']
  });
  await page.evaluate(() => window.__pendingClipboardWrites[0].resolve());
  await page.waitForTimeout(40);
  assert.notEqual(await page.locator('#output-status').textContent(), '已复制正文富文本', '旧 write resolve 时最新动作仍 pending，不能报成功');
  await page.evaluate(() => window.__pendingClipboardWrites[1].resolve());
  await page.waitForFunction(() => document.querySelector('#output-status')?.textContent === '已复制正文富文本');
  assert.equal(await page.locator('#output-status').textContent(), '已复制正文富文本');
  assert.equal(await page.locator('#output-error').textContent(), '');
});

test('rich 旧 reject 不得覆盖较新 metadata 成功', async t => {
  const { page, base } = await withBrowser(t, { initScript: installOutputBrowserSpies });
  await installRenderRoute(page);
  await installOutputRoute(page, []);
  await page.goto(base + '/typesetting');
  await page.getByLabel('标题').fill('当前标题');
  await page.getByLabel('Markdown 正文').fill('rich 旧失败');
  await waitForReadyOutput(page);

  await page.evaluate(() => { window.__clipboardMode = 'pending'; });
  await page.locator('#copy-wechat').click();
  await page.waitForFunction(() => window.__pendingClipboardWrites.length === 1);
  await page.getByRole('button', { name: '复制标题', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#output-status')?.textContent === '已复制标题');
  await page.evaluate(() => window.__pendingClipboardWrites[0].reject(new Error('old reject')));
  await page.waitForTimeout(40);
  assert.equal(await page.locator('#output-status').textContent(), '已复制标题');
  assert.equal(await page.locator('#output-error').textContent(), '');
});

test('Markdown 与 metadata writeText 乱序 settle 不得让旧结果覆盖新动作', async t => {
  const { page, base } = await withBrowser(t, { initScript: installOutputBrowserSpies });
  await installRenderRoute(page);
  await installOutputRoute(page, []);
  await page.goto(base + '/typesetting');
  await page.getByLabel('作者').fill('当前作者');
  await page.getByLabel('Markdown 正文').fill('writeText 乱序');
  await waitForReadyOutput(page);

  await page.evaluate(() => { window.__writeTextMode = 'pending'; });
  await page.getByRole('button', { name: '复制作者', exact: true }).click();
  await page.locator('#copy-markdown').click();
  await page.waitForFunction(() => window.__pendingWriteTexts.length === 2);
  assert.deepEqual(await page.evaluate(() => window.__pendingWriteTexts.map(item => item.value)), ['当前作者', 'SERVER:writeText 乱序']);
  await page.evaluate(() => window.__pendingWriteTexts[1].resolve());
  await page.waitForFunction(() => document.querySelector('#output-status')?.textContent === '已复制 Markdown');
  await page.evaluate(() => window.__pendingWriteTexts[0].reject(new Error('old metadata reject')));
  await page.waitForTimeout(40);
  assert.equal(await page.locator('#output-status').textContent(), '已复制 Markdown');
  assert.equal(await page.locator('#output-error').textContent(), '');
});
