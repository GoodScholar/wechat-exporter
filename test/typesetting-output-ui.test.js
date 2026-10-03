import test from 'node:test';
import assert from 'node:assert/strict';
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
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  t.after(async () => {
    await browser.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { page, base: server.base };
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
  window.__execCommandCalls = 0;
  document.execCommand = () => { window.__execCommandCalls++; return true; };
  class TestClipboardItem {
    static supports(type) { return window.__clipboardSupports[type] === true; }
    constructor(types) {
      this.types = types;
      window.__clipboardItems.push(this);
    }
  }
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

test('图片 loaded 不失效而首次 error 按当前 DOM 顺序重建且重复旧事件无效', async t => {
  const imageInitScript = () => {
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
  };
  const { page, base } = await withBrowser(t, { initScript: imageInitScript });
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

test('富文本双 MIME 仅在 write resolve 后成功且失败无 fallback', async t => {
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

  const beforeInsecure = await page.evaluate(() => ({ items: window.__clipboardItems.length, writes: window.__clipboardWrites.length }));
  await page.evaluate(() => { window.__secureContext = false; });
  await page.locator('#copy-wechat').click();
  await page.waitForFunction(() => document.querySelector('#output-error')?.textContent.includes('未能复制富文本'));
  assert.deepEqual(await page.evaluate(() => ({ items: window.__clipboardItems.length, writes: window.__clipboardWrites.length })), beforeInsecure, '非安全上下文不得构造 item 或写入');
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
