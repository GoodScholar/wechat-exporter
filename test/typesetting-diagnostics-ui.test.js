import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';
import { browserOptions } from '../src/browser.js';
import { createDefaultThemeSettings } from '../src/typesetting.js';

const settings = { primaryColor: '#0F4C81', fontSize: '16px', lineHeight: '1.75', blockSpacing: '1' };
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function post(base, route, body) {
  return fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function emptyResult(body = '') {
  return body.trim() ? {
    html: `<p>${body}</p>`,
    presentation: { theme: 'default', settings },
    diagnostics: [],
    blocked: false
  } : {
    html: '',
    presentation: { theme: 'default', settings },
    diagnostics: [{ id: 'empty-body', code: 'EMPTY_BODY', severity: 'blocker', message: '正文为空。', targets: [{ kind: 'source', start: 0, end: 0 }] }],
    blocked: true
  };
}

function groupedResult(body) {
  const quotedTarget = 'target"quoted';
  return {
    html: `<p><button type="button" tabindex="0" data-format-target="target&amp;literal">普通目标</button><button type="button" tabindex="0" data-format-target="target&quot;quoted">引号目标</button></p>`,
    presentation: { theme: 'grace', settings: { ...settings, primaryColor: '#009874' } },
    diagnostics: [
      { id: 'render-blocker', code: 'RENDER_FAILED', severity: 'blocker', message: '渲染失败。', targets: [{ kind: 'source', start: 0, end: body.length }] },
      { id: 'rich-removal', code: 'UNSAFE_RICH_TEXT_REMOVED', severity: 'conversion', message: '已移除不安全内容。', targets: [{ kind: 'source', start: 1, end: 3 }], meta: { types: ['script', 'unsafe-url'] } },
      { id: 'link-footnote', code: 'EXTERNAL_LINK_TO_FOOTNOTE', severity: 'conversion', message: '已转为脚注。', targets: [{ kind: 'preview', id: 'target&literal' }], meta: { footnote: 1, occurrences: 1 } },
      { id: 'missing-image', code: 'IMAGE_MISSING_SOURCE', severity: 'advisory', message: '图片缺少来源。', targets: [{ kind: 'preview', id: quotedTarget }] }
    ],
    blocked: true
  };
}

function pendingImageResult(pathname, target = 'runtime-image-1', diagnostics = [], blocked = false) {
  return {
    html: `<img src="https://fixture.invalid${pathname}" alt="远程示例" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="${target}">`,
    presentation: { theme: 'default', settings },
    diagnostics,
    blocked
  };
}

function threeSeverityImageResult(body, pathname, target) {
  return {
    html: `<figure role="note" tabindex="0" data-format-target="static-special"><figcaption>特殊内容占位</figcaption></figure><img src="https://fixture.invalid${pathname}" alt="远程示例" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="${target}">`,
    presentation: { theme: 'default', settings },
    diagnostics: [
      { id: 'static-blocker', code: 'RENDER_FAILED', severity: 'blocker', message: '渲染失败。', targets: [{ kind: 'source', start: 0, end: body.length }] },
      { id: 'static-conversion', code: 'SPECIAL_CONTENT_PLACEHOLDER', severity: 'conversion', message: '特殊内容已转为占位。', targets: [{ kind: 'preview', id: 'static-special' }], meta: { type: 'video' } }
    ],
    blocked: true
  };
}

async function withBrowser(t, appOptions = {}, contextOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-diagnostics-ui-'));
  const dataDir = path.join(root, '.data');
  let server = await serve(createApp({ dataDir, interval: 0, ...appOptions }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  t.after(async () => {
    await browser.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    page,
    dataDir,
    base: () => server.base,
    async restart(options = appOptions) {
      await server.close();
      server = await serve(createApp({ dataDir, interval: 0, ...options }));
      return server.base;
    }
  };
}

async function installRenderFixture(page, makeResult = request => emptyResult(request.body)) {
  await page.route('**/api/typesetting/render', route => {
    const request = route.request().postDataJSON();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(makeResult(request)) });
  });
}

async function waitForRenderState(page, state) {
  await page.waitForFunction(expected => document.querySelector('#render-status')?.dataset.state === expected, state);
}

async function dispatchHtmlPaste(page, html) {
  return page.evaluate(value => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/html', value);
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard });
    document.querySelector('#document-body').dispatchEvent(event);
    return event.defaultPrevented;
  }, html);
}

async function dispatchImageFilePaste(page) {
  return page.evaluate(() => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File(['binary-is-never-read'], 'paste.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard });
    document.querySelector('#document-body').dispatchEvent(event);
    return event.defaultPrevented;
  });
}

function richResult(overrides = {}) {
  return {
    markdown: '插入😀内容',
    removed: ['unsafe-url', 'script', 'style'],
    downgraded: [{ type: 'video', sourceUrl: 'https://example.test/video' }],
    block: true,
    ...overrides
  };
}

test('格式检查始终显示三组数量空状态并支持 source 与 preview 键盘定位', async t => {
  const { page, base } = await withBrowser(t);
  await installRenderFixture(page, request => request.body === 'A😀B' ? groupedResult(request.body) : emptyResult(request.body));
  await page.goto(base() + '/typesetting');
  await waitForRenderState(page, 'current');

  for (const [severity, title] of [['blocker', '阻断问题'], ['conversion', '已执行转换'], ['advisory', '建议复核']]) {
    const group = page.locator(`[data-check-severity="${severity}"]`);
    await group.getByRole('heading', { name: title }).waitFor();
    assert.equal(await group.getByText('暂无', { exact: true }).count(), severity === 'blocker' ? 0 : 1);
  }
  await page.getByLabel('Markdown 正文').fill('A😀B');
  await waitForRenderState(page, 'current');
  assert.deepEqual(await page.locator('[data-check-severity]').evaluateAll(groups => groups.map(group => ({
    severity: group.dataset.checkSeverity,
    count: group.querySelector('[data-check-count]').textContent,
    visible: group.getClientRects().length > 0
  }))), [
    { severity: 'blocker', count: '1', visible: true },
    { severity: 'conversion', count: '2', visible: true },
    { severity: 'advisory', count: '1', visible: true }
  ]);

  const sourceButton = page.getByRole('button', { name: '已移除不安全内容。' });
  await sourceButton.focus();
  await sourceButton.press('Enter');
  assert.deepEqual(await page.getByLabel('Markdown 正文').evaluate(input => ({ active: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd })), { active: true, start: 1, end: 3 });

  await page.evaluate(() => { Element.prototype.scrollIntoView = function () { this.dataset.scrolled = 'true'; }; });
  const previewButton = page.getByRole('button', { name: '图片缺少来源。' });
  await previewButton.focus();
  await previewButton.press('Enter');
  assert.deepEqual(await page.locator('#preview [data-format-target]').evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-format-target'), active: document.activeElement === node, scrolled: node.dataset.scrolled === 'true', highlighted: node.classList.contains('format-target-highlight') }))), [
    { id: 'target&literal', active: false, scrolled: false, highlighted: false },
    { id: 'target"quoted', active: true, scrolled: true, highlighted: true }
  ]);
});

test('客户端只在完整严格 RenderResult 合法时原子应用 HTML presentation diagnostics blocked', async t => {
  const { page, base } = await withBrowser(t);
  let responseFor = request => emptyResult(request.body);
  await installRenderFixture(page, request => responseFor(request));
  await page.goto(base() + '/typesetting');

  const firstBody = 'A😀B';
  responseFor = request => request.body === firstBody ? groupedResult(request.body) : emptyResult(request.body);
  await page.getByLabel('Markdown 正文').fill(firstBody);
  await waitForRenderState(page, 'current');
  const accepted = await page.evaluate(() => {
    const preview = document.querySelector('#preview');
    return {
      html: preview.innerHTML,
      className: preview.className,
      style: preview.getAttribute('style'),
      checks: document.querySelector('#format-checks').innerHTML,
      blocked: document.querySelector('#render-status').dataset.blocked
    };
  });
  assert.equal(accepted.blocked, 'true');

  const malformedCases = [
    ['额外顶层键', (result) => ({ ...result, extra: true })],
    ['额外 presentation 键', (result) => ({ ...result, presentation: { ...result.presentation, extra: true } })],
    ['额外 settings 键', (result) => ({ ...result, presentation: { ...result.presentation, settings: { ...result.presentation.settings, extra: true } } })],
    ['额外 diagnostic 键', (result) => ({ ...result, diagnostics: [{ ...result.diagnostics[0], extra: true }, ...result.diagnostics.slice(1)] })],
    ['重复 diagnostic id', (result) => ({ ...result, diagnostics: [result.diagnostics[0], { ...result.diagnostics[1], id: result.diagnostics[0].id }] })],
    ['空 targets', (result) => ({ ...result, diagnostics: [{ ...result.diagnostics[0], targets: [] }, ...result.diagnostics.slice(1)] })],
    ['越界 source', (result, body) => ({ ...result, diagnostics: [{ ...result.diagnostics[0], targets: [{ kind: 'source', start: 0, end: body.length + 1 }] }, ...result.diagnostics.slice(1)] })],
    ['不存在 preview target', (result) => ({ ...result, diagnostics: result.diagnostics.map(item => item.id === 'missing-image' ? { ...item, targets: [{ kind: 'preview', id: 'absent' }] } : item) })],
    ['不唯一 preview target', (result) => ({ ...result, html: `${result.html}<i data-format-target="target&quot;quoted"></i>` })],
    ['code severity 不匹配', (result) => ({ ...result, diagnostics: [{ ...result.diagnostics[0], severity: 'advisory' }, ...result.diagnostics.slice(1)] })],
    ['meta 缺失', (result) => ({ ...result, diagnostics: result.diagnostics.map(item => item.id === 'link-footnote' ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'meta')) : item) })],
    ['meta 多余键', (result) => ({ ...result, diagnostics: result.diagnostics.map(item => item.id === 'link-footnote' ? { ...item, meta: { ...item.meta, extra: true } } : item) })],
    ['重复 preview targets', (result) => ({ ...result, diagnostics: result.diagnostics.map(item => item.id === 'link-footnote' ? { ...item, targets: [item.targets[0], { ...item.targets[0] }], meta: { ...item.meta, occurrences: 2 } } : item) })],
    ['blocked 不一致', (result) => ({ ...result, blocked: false })],
    ['presentation 不完整', (result) => ({ ...result, presentation: { theme: result.presentation.theme, settings: { primaryColor: result.presentation.settings.primaryColor } } })]
  ];

  for (const [label, mutate] of malformedCases) {
    const body = `畸形-${label}`;
    responseFor = () => mutate(groupedResult(body), body);
    await page.getByLabel('Markdown 正文').fill(body);
    await waitForRenderState(page, 'stale');
    assert.deepEqual(await page.evaluate(() => {
      const preview = document.querySelector('#preview');
      return {
        html: preview.innerHTML,
        className: preview.className,
        style: preview.getAttribute('style'),
        checks: document.querySelector('#format-checks').innerHTML,
        blocked: document.querySelector('#render-status').dataset.blocked
      };
    }), { ...accepted, blocked: 'unknown' }, label);
  }
});

test('畸形 RenderResult 的 HTTPS 图片在 strict 校验前不会发起请求', async t => {
  const { page, base } = await withBrowser(t);
  let sideEffectRequests = 0;
  await page.route('https://sideeffect.invalid/**', route => { sideEffectRequests++; return route.abort(); });
  await installRenderFixture(page, request => request.body === '畸形图片响应'
    ? { ...emptyResult(request.body), html: '<img src="https://sideeffect.invalid/probe.png">', extra: true }
    : emptyResult(request.body));
  await page.goto(base() + '/typesetting');
  await waitForRenderState(page, 'current');
  const stable = await page.locator('#preview').innerHTML();

  await page.getByLabel('Markdown 正文').fill('畸形图片响应');
  await waitForRenderState(page, 'stale');
  await page.waitForTimeout(120);
  assert.equal(sideEffectRequests, 0);
  assert.equal(await page.locator('#preview').innerHTML(), stable);
  assert.equal(await page.locator('#render-status').getAttribute('data-blocked'), 'unknown');
});

test('全局复用 target 或非受控 pending 图片使响应 stale 且不发请求不污染已接受 UI', async t => {
  const { page, base } = await withBrowser(t);
  const imageRequests = [];
  await page.route('https://sideeffect.invalid/**', route => {
    imageRequests.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  await page.route('http://sideeffect.invalid/**', route => {
    imageRequests.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  let responseFor = request => request.body === 'A😀B' ? groupedResult(request.body) : emptyResult(request.body);
  await installRenderFixture(page, request => responseFor(request));
  await page.goto(base() + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('A😀B');
  await waitForRenderState(page, 'current');
  const accepted = await page.evaluate(() => {
    const preview = document.querySelector('#preview');
    return {
      html: preview.innerHTML,
      className: preview.className,
      style: preview.getAttribute('style'),
      checks: document.querySelector('#format-checks').innerHTML
    };
  });

  const malformedCases = [
    ['pending 图片复用 target', {
      html: '<img src="https://sideeffect.invalid/one.png" alt="one" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="shared-image"><img src="https://sideeffect.invalid/two.png" alt="two" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="shared-image">',
      diagnostics: []
    }],
    ['不同诊断复用 preview target', {
      html: '<figure class="format-special-placeholder" data-format-target="shared-diagnostic" tabindex="0" role="note">特殊内容</figure>',
      diagnostics: [
        { id: 'special-one', code: 'SPECIAL_CONTENT_PLACEHOLDER', severity: 'conversion', message: '特殊内容一。', targets: [{ kind: 'preview', id: 'shared-diagnostic' }], meta: { type: 'video' } },
        { id: 'special-two', code: 'SPECIAL_CONTENT_PLACEHOLDER', severity: 'conversion', message: '特殊内容二。', targets: [{ kind: 'preview', id: 'shared-diagnostic' }], meta: { type: 'audio' } }
      ]
    }],
    ['空 target', { html: '<span data-format-target=""></span>', diagnostics: [] }],
    ['pending 图片缺少 target', { html: '<img src="https://sideeffect.invalid/missing-target.png" alt="missing" referrerpolicy="no-referrer" data-image-state="pending">', diagnostics: [] }],
    ['pending 图片不是 HTTPS', { html: '<img src="http://sideeffect.invalid/http.png" alt="http" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="http-image">', diagnostics: [] }],
    ['pending 图片携带非服务端白名单属性', { html: '<img src="https://sideeffect.invalid/danger.png" alt="danger" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="danger-image" onerror="document.body.dataset.polluted=\'true\'">', diagnostics: [] }]
  ];

  for (const [label, fixture] of malformedCases) {
    responseFor = () => ({
      html: fixture.html,
      presentation: { theme: 'default', settings },
      diagnostics: fixture.diagnostics,
      blocked: false
    });
    await page.getByLabel('Markdown 正文').fill(`严格校验-${label}`);
    await waitForRenderState(page, 'stale');
    await page.waitForTimeout(80);
    assert.deepEqual(await page.evaluate(() => {
      const preview = document.querySelector('#preview');
      return {
        html: preview.innerHTML,
        className: preview.className,
        style: preview.getAttribute('style'),
        checks: document.querySelector('#format-checks').innerHTML
      };
    }), accepted, label);
    assert.equal(await page.locator('#render-status').getAttribute('data-blocked'), 'unknown', label);
    assert.equal(await page.locator('[data-check-severity="advisory"] [data-check-count]').textContent(), '1', label);
    assert.equal(await page.evaluate(() => document.body.dataset.polluted), undefined, label);
  }
  assert.deepEqual(imageRequests, []);
});

test('本地 HTTPS 图片成功加载为 loaded 且请求不含 Referer', async t => {
  const { page, base } = await withBrowser(t);
  const requests = [];
  await page.route('https://fixture.invalid/**', route => {
    requests.push(route.request().headers());
    return route.fulfill({ status: 200, contentType: 'image/png', body: onePixelPng });
  });
  await installRenderFixture(page, request => request.body === '成功图片'
    ? pendingImageResult('/ok.png')
    : emptyResult(request.body));
  await page.goto(base() + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('成功图片');

  await page.locator('#preview img[data-image-state="loaded"]').waitFor();
  assert.equal(await page.locator('[data-check-severity="advisory"] [data-check-count]').textContent(), '0');
  assert.equal(await page.locator('#render-status').getAttribute('data-blocked'), 'false');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].referer, undefined);
});

test('真实 renderer 的 HTTPS 404 占位保留安全 ALT 且仅生成非阻断 IMAGE_LOAD_FAILED', async t => {
  const { page, base } = await withBrowser(t);
  let imageRequests = 0;
  await page.route('https://fixture.invalid/alt-fail.png', route => {
    imageRequests++;
    return route.fulfill({ status: 404, contentType: 'image/png', body: '' });
  });
  await page.goto(base() + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('![  安全   ALT & \\<b\\>不注入\\</b\\>  ](https://fixture.invalid/alt-fail.png)');

  const placeholder = page.locator('#preview .format-image-placeholder[data-image-state="load-failed"]');
  await placeholder.waitFor();
  assert.deepEqual(await placeholder.evaluate(node => ({
    text: node.textContent,
    containsElement: Boolean(node.querySelector('b')),
    hasSource: node.hasAttribute('src'),
    html: node.innerHTML
  })), {
    text: '图片加载失败。请检查图片地址后重试。 替代文本：安全 ALT & <b>不注入</b>',
    containsElement: false,
    hasSource: false,
    html: '<figcaption>图片加载失败。请检查图片地址后重试。 替代文本：安全 ALT &amp; &lt;b&gt;不注入&lt;/b&gt;</figcaption>'
  });
  assert.equal((await placeholder.textContent()).includes('https://fixture.invalid/alt-fail.png'), false);
  assert.equal(await page.locator('[data-check-severity="advisory"] [data-check-count]').textContent(), '1');
  assert.equal(await page.getByRole('button', { name: '图片加载失败，请检查图片地址后重试。' }).count(), 1);
  assert.equal(await page.locator('#render-status').getAttribute('data-blocked'), 'false');
  assert.equal(imageRequests, 1);
});

test('HTTPS 404 或中断在相同 target 原位变为可定位 load-failed advisory', async t => {
  const { page, base } = await withBrowser(t);
  await page.route('https://fixture.invalid/**', route => route.request().url().endsWith('/404.png')
    ? route.fulfill({ status: 404, contentType: 'image/png', body: '' })
    : route.abort('failed'));
  await installRenderFixture(page, request => request.body.startsWith('失败图片-')
    ? threeSeverityImageResult(request.body, request.body.endsWith('404') ? '/404.png' : '/abort.png', `failed-${request.body}`)
    : emptyResult(request.body));
  await page.goto(base() + '/typesetting');
  await page.evaluate(() => { Element.prototype.scrollIntoView = function () { this.dataset.scrolled = 'true'; }; });

  for (const mode of ['404', 'abort']) {
    const target = `failed-失败图片-${mode}`;
    await page.getByLabel('Markdown 正文').fill(`失败图片-${mode}`);
    const placeholder = page.locator(`#preview .format-image-placeholder[data-format-target="${target}"]`);
    await placeholder.waitFor();
    assert.deepEqual(await placeholder.evaluate(node => ({
      target: node.getAttribute('data-format-target'),
      state: node.getAttribute('data-image-state'),
      role: node.getAttribute('role'),
      tabindex: node.getAttribute('tabindex'),
      text: node.textContent
    })), { target, state: 'load-failed', role: 'note', tabindex: '0', text: '图片加载失败。请检查图片地址后重试。 替代文本：远程示例' });
    assert.equal((await placeholder.innerHTML()).includes('https://fixture.invalid'), false);
    assert.deepEqual(await page.locator('[data-check-severity]').evaluateAll(groups => groups.map(group => group.querySelector('[data-check-count]').textContent)), ['1', '1', '1']);
    assert.equal(await page.locator('#render-status').getAttribute('data-blocked'), 'true');
    const ids = await page.locator('.format-check-item').evaluateAll(items => items.map(item => item.dataset.diagnosticId));
    assert.equal(new Set(ids).size, ids.length);

    const failureButton = page.getByRole('button', { name: '图片加载失败，请检查图片地址后重试。' });
    await failureButton.focus();
    await failureButton.press('Enter');
    assert.deepEqual(await placeholder.evaluate(node => ({
      active: document.activeElement === node,
      scrolled: node.dataset.scrolled === 'true',
      highlighted: node.classList.contains('format-target-highlight')
    })), { active: true, scrolled: true, highlighted: true });
  }
});

test('监听注册后立即处理 complete naturalWidth 避免缓存早发事件', async t => {
  const { page, base } = await withBrowser(t);
  await page.addInitScript(() => {
    const complete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete');
    const naturalWidth = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth');
    Object.defineProperty(HTMLImageElement.prototype, 'complete', {
      configurable: true,
      get() { return this.getAttribute('src')?.includes('/cached-') ? true : complete.get.call(this); }
    });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
      configurable: true,
      get() {
        if (this.getAttribute('src')?.includes('/cached-ok.png')) return 1;
        if (this.getAttribute('src')?.includes('/cached-broken.png')) return 0;
        return naturalWidth.get.call(this);
      }
    });
    window.__imageListenerRegistrations = {};
    const addEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      const pathname = this instanceof HTMLImageElement ? new URL(this.src).pathname : '';
      if ((type === 'load' || type === 'error') && pathname.startsWith('/cached-')) {
        const counts = window.__imageListenerRegistrations[pathname] ||= { load: 0, error: 0 };
        counts[type]++;
      }
      return addEventListener.call(this, type, listener, options);
    };
  });
  await page.route('https://fixture.invalid/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: onePixelPng }));
  await installRenderFixture(page, request => request.body === '缓存成功'
    ? pendingImageResult('/cached-ok.png', 'cached-ok')
    : request.body === '缓存失败'
      ? pendingImageResult('/cached-broken.png', 'cached-broken')
      : emptyResult(request.body));
  await page.goto(base() + '/typesetting');

  await page.getByLabel('Markdown 正文').fill('缓存成功');
  await page.locator('#preview img[data-image-state="loaded"]').waitFor();
  assert.equal(await page.locator('[data-check-severity="advisory"] [data-check-count]').textContent(), '0');

  await page.getByLabel('Markdown 正文').fill('缓存失败');
  await page.locator('#preview .format-image-placeholder[data-image-state="load-failed"]').waitFor();
  assert.equal(await page.locator('[data-check-severity="advisory"] [data-check-count]').textContent(), '1');
  assert.deepEqual(await page.evaluate(() => window.__imageListenerRegistrations), {
    '/cached-ok.png': { load: 1, error: 1 },
    '/cached-broken.png': { load: 1, error: 1 }
  });
});

test('旧 preview 图片 load error 和过期响应不能污染新 HTML diagnostics blocked target', async t => {
  const { page, base } = await withBrowser(t);
  let releaseOldRender;
  let oldRenderReached;
  let releaseOldImage;
  await page.addInitScript(() => {
    const addEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (this instanceof HTMLImageElement && this.getAttribute('src')?.endsWith('/held.png') && type === 'error') window.__oldPreviewImage = this;
      return addEventListener.call(this, type, listener, options);
    };
  });
  await page.route('https://fixture.invalid/**', async route => {
    if (!route.request().url().endsWith('/held.png')) return route.abort('blockedbyclient');
    await new Promise(resolve => { releaseOldImage = resolve; });
    await route.abort('failed');
  });
  await page.route('**/api/typesetting/render', async route => {
    const request = route.request().postDataJSON();
    if (request.body === '旧响应') {
      oldRenderReached();
      await new Promise(resolve => { releaseOldRender = resolve; });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(pendingImageResult('/late.png', 'late-target')) });
    }
    if (request.body === '旧图片') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(pendingImageResult('/held.png', 'old-target')) });
    if (request.body === '新响应') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      html: '<figure class="format-image-placeholder" data-image-state="unsupported-scheme" data-format-target="new-target" role="note" tabindex="0"><figcaption>不支持的图片来源。</figcaption></figure>',
      presentation: { theme: 'default', settings },
      diagnostics: [{ id: 'new-static-image', code: 'IMAGE_UNSUPPORTED_SCHEME', severity: 'advisory', message: '图片协议不受支持。', targets: [{ kind: 'preview', id: 'new-target' }] }],
      blocked: false
    }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(emptyResult(request.body)) });
  });
  await page.goto(base() + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('旧图片');
  await page.locator('#preview img[data-image-state="pending"]').waitFor({ state: 'attached' });

  const reached = new Promise(resolve => { oldRenderReached = resolve; });
  await page.getByLabel('Markdown 正文').fill('旧响应');
  await reached;
  await page.evaluate(() => window.__oldPreviewImage.dispatchEvent(new Event('error')));
  assert.equal(await page.locator('#preview img[data-format-target="old-target"][data-image-state="pending"]').count(), 1);
  assert.equal(await page.locator('[data-check-severity="advisory"] [data-check-count]').textContent(), '0');
  await page.getByLabel('Markdown 正文').fill('新响应');
  await waitForRenderState(page, 'current');
  const current = await page.evaluate(() => ({
    html: document.querySelector('#preview').innerHTML,
    checks: document.querySelector('#format-checks').innerHTML,
    blocked: document.querySelector('#render-status').dataset.blocked
  }));

  releaseOldRender();
  await page.evaluate(() => window.__oldPreviewImage.dispatchEvent(new Event('error')));
  releaseOldImage();
  await page.waitForTimeout(120);
  assert.deepEqual(await page.evaluate(() => ({
    html: document.querySelector('#preview').innerHTML,
    checks: document.querySelector('#format-checks').innerHTML,
    blocked: document.querySelector('#render-status').dataset.blocked
  })), current);
  assert.equal(await page.locator('#preview [data-format-target="new-target"]').count(), 1);
  assert.equal(await page.locator('.format-check-item[data-diagnostic-id="new-static-image"]').count(), 1);
});

test('静态不支持图片不发起网络请求且全部图片问题保持非阻断', async t => {
  const { page, base } = await withBrowser(t);
  const forbiddenRequests = [];
  for (const pattern of ['http://unsafe.invalid/**', 'http://protocol-relative.invalid/**']) {
    await page.route(pattern, route => { forbiddenRequests.push(route.request().url()); return route.abort('blockedbyclient'); });
  }
  await page.route('https://fixture.invalid/nonblocking-failure.png', route => route.fulfill({ status: 404, contentType: 'image/png', body: '' }));
  await page.route('**/api/typesetting/render', route => {
    const request = route.request().postDataJSON();
    if (request.body !== '静态与动态图片') return route.continue();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      html: '<figure class="format-image-placeholder" data-image-state="unsupported-scheme" data-format-target="static-unsupported" role="note" tabindex="0"><figcaption>图片协议不受支持。</figcaption></figure><img src="https://fixture.invalid/nonblocking-failure.png" alt="远程示例" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="dynamic-failure">',
      presentation: { theme: 'default', settings },
      diagnostics: [{ id: 'static-unsupported', code: 'IMAGE_UNSUPPORTED_SCHEME', severity: 'advisory', message: '图片协议不受支持。', targets: [{ kind: 'preview', id: 'static-unsupported' }] }],
      blocked: false
    }) });
  });
  await page.goto(base() + '/typesetting');
  await page.getByLabel('Markdown 正文').fill([
    '![http](http://unsafe.invalid/a.png)',
    '![relative](//protocol-relative.invalid/a.png)',
    '![file](file:///tmp/a.png)',
    '![local](/tmp/a.png)',
    '![dot](./a.png)',
    '![data](data:image/png;base64,AAAA)',
    '![blob](blob:https://fixture.invalid/id)',
    '<img alt="missing">'
  ].join('\n\n'));
  await waitForRenderState(page, 'current');
  await page.waitForTimeout(120);

  assert.deepEqual(forbiddenRequests, []);
  assert.equal(await page.locator('#preview img').count(), 0);
  assert.equal(await page.locator('#preview .format-image-placeholder').count(), 8);
  assert.equal(await page.locator('[data-check-severity="advisory"] [data-check-count]').textContent(), '8');
  assert.equal(await page.locator('#render-status').getAttribute('data-blocked'), 'false');

  await page.getByLabel('Markdown 正文').fill('静态与动态图片');
  await page.locator('#preview [data-format-target="dynamic-failure"][data-image-state="load-failed"]').waitFor();
  assert.equal(await page.locator('[data-check-severity="advisory"] [data-check-count]').textContent(), '2');
  assert.equal(await page.locator('#render-status').getAttribute('data-blocked'), 'false');
});

test('document 启动读取失败仍以默认文稿发出四键 render 且无未捕获错误', async t => {
  const { page, base } = await withBrowser(t);
  let mode = 'json';
  const renderRequests = [];
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/typesetting/document', route => {
    if (mode === 'json') return route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
    if (mode === 'network') return route.abort('failed');
    if (mode === 'non2xx') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '暂不可用' }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ document: { body: '不完整' } }) });
  });
  await page.route('**/api/typesetting/render', route => {
    const request = route.request().postDataJSON();
    renderRequests.push(request);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(emptyResult(request.body)) });
  });

  for (const nextMode of ['json', 'network', 'non2xx', 'shape']) {
    mode = nextMode;
    renderRequests.length = 0;
    if (nextMode === 'json') await page.goto(base() + '/typesetting'); else await page.reload();
    await waitForRenderState(page, 'current');
    assert.deepEqual(renderRequests, [{ body: '', theme: 'default', settings, convertExternalLinksToFootnotes: false }], nextMode);
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '', nextMode);
    assert.equal(await page.getByLabel('外链转脚注').isChecked(), false, nextMode);
  }
  assert.deepEqual(pageErrors, []);
});

test('输入变化立即标记正在重新检查且网络非二百和畸形响应只保留 stale 参考', async t => {
  const { page, base } = await withBrowser(t);
  let mode = 'valid';
  let releasePending;
  let pendingReached;
  await page.route('**/api/typesetting/render', async route => {
    const request = route.request().postDataJSON();
    if (mode === 'pending') {
      pendingReached?.();
      await new Promise(resolve => { releasePending = resolve; });
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '暂不可用' }) });
    }
    if (mode === 'json') return route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
    if (mode === 'network') return route.abort('failed');
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(emptyResult(request.body)) });
  });
  await page.goto(base() + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('稳定预览');
  await waitForRenderState(page, 'current');
  const stable = await page.locator('#preview').innerHTML();

  mode = 'pending';
  const reached = new Promise(resolve => { pendingReached = resolve; });
  await page.getByLabel('Markdown 正文').fill('等待响应');
  await waitForRenderState(page, 'checking');
  assert.match(await page.locator('#render-status').textContent(), /正在重新检查/);
  assert.equal(await page.locator('#preview').innerHTML(), stable);
  await reached;
  releasePending();
  await waitForRenderState(page, 'stale');
  assert.match(await page.locator('#render-status').textContent(), /预览不是当前内容/);
  assert.equal(await page.locator('#preview').innerHTML(), stable);

  for (const nextMode of ['json', 'network']) {
    mode = nextMode;
    await page.getByLabel('Markdown 正文').fill(`失败-${nextMode}`);
    await waitForRenderState(page, 'stale');
    assert.equal(await page.locator('#preview').innerHTML(), stable);
    assert.equal(await page.locator('#render-status').getAttribute('data-blocked'), 'unknown');
  }
});

test('非空成功后正文改为空时旧 blocked false 不得在 pending 或失败期间变为当前', async t => {
  const { page, base } = await withBrowser(t);
  let holdEmpty = false;
  let releaseEmpty;
  let emptyReached;
  await page.route('**/api/typesetting/render', async route => {
    const request = route.request().postDataJSON();
    if (holdEmpty && request.body === '') {
      emptyReached();
      await new Promise(resolve => { releaseEmpty = resolve; });
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '失败' }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(emptyResult(request.body)) });
  });
  await page.goto(base() + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('可发布正文');
  await waitForRenderState(page, 'current');
  assert.equal(await page.locator('#render-status').getAttribute('data-blocked'), 'false');
  const stable = await page.locator('#preview').innerHTML();

  holdEmpty = true;
  const reached = new Promise(resolve => { emptyReached = resolve; });
  await page.getByLabel('Markdown 正文').fill('');
  await waitForRenderState(page, 'checking');
  assert.equal(await page.locator('#render-status').getAttribute('data-blocked'), 'unknown');
  await reached;
  assert.equal(await page.locator('#preview').innerHTML(), stable);
  releaseEmpty();
  await waitForRenderState(page, 'stale');
  assert.equal(await page.locator('#render-status').getAttribute('data-blocked'), 'unknown');
  assert.equal(await page.locator('#preview').innerHTML(), stable);
});

test('脚注开关即时刷新预览并经单次 500ms 自动保存跨刷新重启恢复', async t => {
  const { page, base, restart } = await withBrowser(t);
  const seeded = {
    title: '脚注文稿', author: '', account: '', publishedAt: '', body: '[外链](https://example.com/path)',
    theme: 'default', themeSettings: createDefaultThemeSettings(), convertExternalLinksToFootnotes: false, revision: 1
  };
  assert.equal((await post(base(), '/api/typesetting/document', seeded)).status, 200);
  const renderRequests = [];
  await page.route('**/api/typesetting/render', async route => {
    renderRequests.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.goto(base() + '/typesetting');
  const toggle = page.getByLabel('外链转脚注');
  assert.equal(await toggle.isChecked(), false);
  await toggle.check();
  await waitForRenderState(page, 'checking');
  await page.getByRole('button', { name: /外链.*脚注|脚注/ }).waitFor();
  await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
  assert.equal(renderRequests.at(-1).convertExternalLinksToFootnotes, true);
  assert.deepEqual(Object.keys(renderRequests.at(-1)).sort(), ['body', 'convertExternalLinksToFootnotes', 'settings', 'theme']);
  let persisted = (await (await fetch(base() + '/api/typesetting/document')).json()).document;
  assert.equal(persisted.convertExternalLinksToFootnotes, true);
  assert.equal(persisted.revision, 2);

  await page.reload();
  assert.equal(await page.getByLabel('外链转脚注').isChecked(), true);
  const restartedBase = await restart();
  await page.goto(restartedBase + '/typesetting');
  assert.equal(await page.getByLabel('外链转脚注').isChecked(), true);
  persisted = (await (await fetch(restartedBase + '/api/typesetting/document')).json()).document;
  assert.equal(persisted.convertExternalLinksToFootnotes, true);
  assert.equal(persisted.revision, 2);
});

test('脚注开关快速双切换最终回原值仍只串行提交一次并增长一次 revision', async t => {
  const { page, base } = await withBrowser(t);
  let saves = 0;
  let activeSaves = 0;
  let maxActiveSaves = 0;
  const payloads = [];
  const saveTimes = [];
  await page.route('**/api/typesetting/document', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    saves++;
    activeSaves++;
    maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
    payloads.push(route.request().postDataJSON());
    saveTimes.push(Date.now());
    await new Promise(resolve => setTimeout(resolve, 120));
    await route.continue();
    activeSaves--;
  });
  await page.goto(base() + '/typesetting');
  const toggle = page.getByLabel('外链转脚注');
  const started = Date.now();
  await toggle.check();
  await page.waitForTimeout(60);
  await toggle.uncheck();
  await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1800 });
  assert.equal(saves, 1);
  assert.equal(maxActiveSaves, 1);
  assert.ok(saveTimes[0] - started >= 450, '脚注开关必须沿用约 500ms 自动保存防抖');
  assert.equal(payloads[0].convertExternalLinksToFootnotes, false);
  assert.equal(payloads[0].revision, 1);
  const persisted = (await (await fetch(base() + '/api/typesetting/document')).json()).document;
  assert.equal(persisted.convertExternalLinksToFootnotes, false);
  assert.equal(persisted.revision, 1);
});

test('格式检查与定位在键盘 reduced-motion 和 390px 窄屏下可操作', async t => {
  const { page, base } = await withBrowser(t, {}, { viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await installRenderFixture(page, request => request.body === 'A😀B' ? groupedResult(request.body) : emptyResult(request.body));
  await page.goto(base() + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('A😀B');
  await waitForRenderState(page, 'current');

  const toggle = page.getByLabel('外链转脚注');
  await toggle.focus();
  await toggle.press('Space');
  assert.equal(await toggle.isChecked(), true);
  await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });

  await page.getByRole('button', { name: '已移除不安全内容。' }).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.getByLabel('Markdown 正文').evaluate(input => [input.selectionStart, input.selectionEnd]), [1, 3]);
  await page.getByRole('button', { name: '图片缺少来源。' }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#preview [data-format-target="target&quoted"]').count(), 0, '属性值必须按精确值定位，不能近似或拼接 selector');
  assert.equal(await page.locator('#preview [data-format-target]').evaluateAll(nodes => nodes.find(node => node.getAttribute('data-format-target') === 'target"quoted')?.classList.contains('format-target-highlight')), true);
  assert.equal(await page.locator('#preview [data-format-target]').evaluateAll(nodes => getComputedStyle(nodes.find(node => node.getAttribute('data-format-target') === 'target"quoted')).animationName), 'none');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);

  let releaseImport;
  let importReached;
  const reached = new Promise(resolve => { importReached = resolve; });
  await page.route('**/api/typesetting/import', async route => {
    importReached();
    await new Promise(resolve => { releaseImport = resolve; });
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: '固定失败' } }) });
  });
  await page.evaluate(() => { window.confirm = () => true; });
  await page.getByLabel('导入公众号文章链接').fill('https://mp.weixin.qq.com/s/local');
  await page.getByRole('button', { name: '导入文章' }).click();
  await reached;
  assert.equal(await toggle.isDisabled(), true);
  releaseImport();
  await page.getByText('固定失败', { exact: false }).waitFor();
  assert.equal(await toggle.isDisabled(), false);
  assert.equal(await toggle.isChecked(), true);
});

test('富文本 removed 合并为单条 conversion 并定位实际插入 UTF-16 范围', async t => {
  const { page, base } = await withBrowser(t);
  await page.route('https://fixture.invalid/audit.png', route => route.fulfill({ status: 404, contentType: 'image/png', body: '' }));
  await installRenderFixture(page, request => request.body ? {
    html: '<figure role="note" tabindex="0" data-format-target="static-special"><figcaption>特殊内容</figcaption></figure><img src="https://fixture.invalid/audit.png" alt="审计图" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="dynamic-image">',
    presentation: { theme: request.theme, settings: request.settings },
    diagnostics: [{ id: 'static-conversion', code: 'SPECIAL_CONTENT_PLACEHOLDER', severity: 'conversion', message: '特殊内容已转为占位。', targets: [{ kind: 'preview', id: 'static-special' }], meta: { type: 'video' } }],
    blocked: false
  } : emptyResult(''));
  await page.route('**/api/typesetting/rich-text', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(richResult()) }));
  await page.goto(base() + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('甲乙');
  await page.evaluate(() => { window.confirm = () => true; document.querySelector('#document-body').setSelectionRange(1, 1); });

  assert.equal(await dispatchHtmlPaste(page, '<script>危险</script><p>插入😀内容</p>'), true);
  const inserted = '\n\n插入😀内容\n\n';
  await page.locator('.format-check-item[data-diagnostic-id^="rich-text-removal-"]').waitFor();
  await page.locator('#preview [data-image-state="load-failed"]').waitFor();
  assert.deepEqual(await page.locator('[data-check-severity]').evaluateAll(groups => groups.map(group => [group.dataset.checkSeverity, group.querySelector('[data-check-count]').textContent])), [
    ['blocker', '0'], ['conversion', '2'], ['advisory', '1']
  ]);
  assert.equal(await page.locator('#render-status').getAttribute('data-blocked'), 'false');
  const ids = await page.locator('.format-check-item').evaluateAll(items => items.map(item => item.dataset.diagnosticId));
  assert.equal(new Set(ids).size, ids.length);
  const audit = page.locator('.format-check-item[data-diagnostic-id^="rich-text-removal-"]');
  assert.equal(await audit.getAttribute('data-diagnostic-types'), 'script,style,unsafe-url');
  await audit.click();
  assert.deepEqual(await page.getByLabel('Markdown 正文').evaluate(input => [input.selectionStart, input.selectionEnd]), [1, 1 + inserted.length]);
});

test('富文本审计仅在人工或成功正文替换时清除且非正文变化继续保留', async t => {
  const { page, base } = await withBrowser(t);
  await installRenderFixture(page, request => ({ ...emptyResult(request.body), presentation: { theme: request.theme, settings: request.settings } }));
  await page.route('**/api/typesetting/rich-text', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(richResult({ block: false })) }));
  await page.goto(base() + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('正文');
  await page.evaluate(() => { window.confirm = () => true; document.querySelector('#document-body').setSelectionRange(2, 2); });
  await dispatchHtmlPaste(page, '<p>审计</p>');
  const audit = page.locator('.format-check-item[data-diagnostic-id^="rich-text-removal-"]');
  await audit.waitFor();

  await page.getByLabel('外链转脚注').check();
  await waitForRenderState(page, 'current');
  await page.getByLabel('主题').selectOption('grace');
  await waitForRenderState(page, 'current');
  await page.getByLabel('标题').fill('只改元信息');
  await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1600 });
  assert.equal(await audit.count(), 1, '脚注、主题、元信息与 body 相同的保存水合必须保留审计');

  await page.getByLabel('Markdown 正文').pressSequentially('x');
  assert.equal(await audit.count(), 0, '人工正文 input 必须立即清除审计');
  await page.reload();
  assert.equal(await page.locator('.format-check-item[data-diagnostic-id^="rich-text-removal-"]').count(), 0, '审计不得持久化');
});

test('成功下一次粘贴替换旧审计而失败过期选区正文竞态保持当前审计', async t => {
  const { page, base } = await withBrowser(t);
  await installRenderFixture(page, request => ({ ...emptyResult(request.body), presentation: { theme: request.theme, settings: request.settings } }));
  let response = richResult({ markdown: '第一段', removed: ['script'], downgraded: [], block: false });
  let release;
  await page.route('**/api/typesetting/rich-text', async route => {
    if (response === 'held') {
      await new Promise(resolve => { release = resolve; });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(richResult({ markdown: '过期', removed: ['style'], downgraded: [], block: false })) });
    }
    if (response === 'failure') return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { message: '固定失败' } }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  });
  await page.goto(base() + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('甲乙');
  await page.evaluate(() => { window.confirm = () => true; document.querySelector('#document-body').setSelectionRange(1, 1); });
  await dispatchHtmlPaste(page, '<p>第一段</p>');
  let audit = page.locator('.format-check-item[data-diagnostic-id^="rich-text-removal-"]');
  await audit.waitFor();
  const firstId = await audit.getAttribute('data-diagnostic-id');

  response = 'failure';
  await dispatchHtmlPaste(page, '<p>失败</p>');
  await page.getByText('固定失败', { exact: false }).waitFor();
  assert.equal(await audit.getAttribute('data-diagnostic-id'), firstId);

  const beforeFailedInsertion = await page.getByLabel('Markdown 正文').inputValue();
  await page.evaluate(() => { window.__nativeExecCommand = document.execCommand; document.execCommand = () => false; });
  response = richResult({ markdown: '不能插入', removed: ['style'], downgraded: [], block: false });
  await dispatchHtmlPaste(page, '<p>不能插入</p>');
  await page.getByText('浏览器无法安全插入', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('Markdown 正文').inputValue(), beforeFailedInsertion);
  assert.equal(await audit.getAttribute('data-diagnostic-id'), firstId);
  await page.evaluate(() => { document.execCommand = window.__nativeExecCommand; });

  await page.evaluate(() => { window.__nativeExecCommand = document.execCommand; document.execCommand = () => true; });
  response = richResult({ markdown: '伪成功', removed: ['style'], downgraded: [], block: false });
  await dispatchHtmlPaste(page, '<p>伪成功</p>');
  await page.getByText('浏览器无法安全插入', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('Markdown 正文').inputValue(), beforeFailedInsertion);
  assert.equal(await audit.getAttribute('data-diagnostic-id'), firstId);
  await page.evaluate(() => { document.execCommand = window.__nativeExecCommand; });

  response = 'held';
  await dispatchHtmlPaste(page, '<p>过期</p>');
  await page.waitForTimeout(30);
  await page.evaluate(() => document.querySelector('#document-body').setSelectionRange(0, 0));
  release();
  await page.getByText('正文或选区已变化', { exact: false }).waitFor();
  assert.equal(await audit.getAttribute('data-diagnostic-id'), firstId);

  response = richResult({ markdown: '第二段', removed: ['unsafe-url', 'style'], downgraded: [], block: false });
  await page.evaluate(() => document.querySelector('#document-body').setSelectionRange(1, 1));
  await dispatchHtmlPaste(page, '<p>第二段</p>');
  audit = page.locator('.format-check-item[data-diagnostic-id^="rich-text-removal-"]');
  await page.waitForFunction(id => document.querySelector('.format-check-item[data-diagnostic-id^="rich-text-removal-"]')?.dataset.diagnosticId !== id, firstId);
  assert.equal(await audit.getAttribute('data-diagnostic-types'), 'style,unsafe-url');
});

test('客户端拒绝额外键重复 removed 未知 downgrade 和不安全 sourceUrl', async t => {
  const { page, base } = await withBrowser(t);
  await installRenderFixture(page, request => ({ ...emptyResult(request.body), presentation: { theme: request.theme, settings: request.settings } }));
  let payload = richResult({ markdown: '基准', removed: ['script'], downgraded: [], block: false });
  let responseCount = 0;
  await page.route('**/api/typesetting/rich-text', route => {
    responseCount++;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.goto(base() + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('甲乙');
  await page.evaluate(() => { window.confirm = () => true; document.querySelector('#document-body').setSelectionRange(1, 1); });
  await dispatchHtmlPaste(page, '<p>基准</p>');
  const audit = page.locator('.format-check-item[data-diagnostic-id^="rich-text-removal-"]');
  await audit.waitFor();
  await waitForRenderState(page, 'current');

  const invalid = [
    { ...richResult(), extra: true },
    richResult({ markdown: '' }),
    richResult({ markdown: ' \n\t ' }),
    richResult({ markdown: null }),
    richResult({ block: 1 }),
    richResult({ removed: 'script' }),
    richResult({ downgraded: {} }),
    richResult({ removed: ['script', 'script'] }),
    richResult({ removed: ['unknown'] }),
    richResult({ downgraded: [{ type: 'carousel' }] }),
    richResult({ downgraded: [{ type: 'video', sourceUrl: 'https://user:secret@example.test/a' }] }),
    richResult({ downgraded: [{ type: 'image', reason: 'local-binary', sourceUrl: 'https://example.test/a' }] }),
    richResult({ downgraded: [{ type: 'image', reason: 'unknown' }] }),
    richResult({ downgraded: [{ type: 'video', extra: true }] })
  ];
  for (const candidate of invalid) {
    payload = candidate;
    const before = await page.getByLabel('Markdown 正文').inputValue();
    const beforeChecks = await page.locator('#format-checks').innerHTML();
    const expectedResponseCount = responseCount + 1;
    await page.evaluate(() => { document.querySelector('#rich-text-message').textContent = ''; });
    await page.evaluate(() => document.querySelector('#document-body').setSelectionRange(1, 1));
    await dispatchHtmlPaste(page, '<p>畸形</p>');
    while (responseCount < expectedResponseCount) await page.waitForTimeout(10);
    await page.getByText('富文本转换失败', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), before);
    assert.equal(await page.locator('#format-checks').innerHTML(), beforeChecks);
  }
});

test('富文本 execCommand 破坏正文后抛错会完整回滚且保留旧审计和异步状态', async t => {
  const { page, base } = await withBrowser(t);
  const pageErrors = [];
  const renderRequests = [];
  const savePayloads = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/typesetting/render', route => {
    const request = route.request().postDataJSON();
    renderRequests.push(request);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...emptyResult(request.body), presentation: { theme: request.theme, settings: request.settings } }) });
  });
  await page.route('**/api/typesetting/document', async route => {
    if (route.request().method() === 'POST') savePayloads.push(route.request().postDataJSON());
    await route.continue();
  });
  let payload = richResult({ markdown: '建立旧审计', removed: ['script'], downgraded: [], block: false });
  await page.route('**/api/typesetting/rich-text', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) }));
  await page.goto(base() + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('甲乙');
  await page.evaluate(() => { window.confirm = () => true; const body = document.querySelector('#document-body'); body.setSelectionRange(1, 1); });
  await dispatchHtmlPaste(page, '<p>建立旧审计</p>');
  const audit = page.locator('.format-check-item[data-diagnostic-id^="rich-text-removal-"]');
  await audit.waitFor();
  await waitForRenderState(page, 'current');
  await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1600 });
  const stable = {
    body: await page.getByLabel('Markdown 正文').inputValue(),
    auditId: await audit.getAttribute('data-diagnostic-id'),
    checks: await page.locator('#format-checks').innerHTML(),
    preview: await page.locator('#preview').innerHTML(),
    renderStatus: await page.locator('#render-status').textContent(),
    renders: renderRequests.length,
    saves: savePayloads.length
  };

  payload = richResult({ markdown: '不得插入', removed: ['style'], downgraded: [], block: false });
  await page.evaluate(() => {
    document.execCommand = (_command, _ui, value) => {
      const body = document.querySelector('#document-body');
      body.setRangeText(`破坏-${value}`, body.selectionStart, body.selectionEnd, 'end');
      body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      throw new Error('exec mutation then throw');
    };
    document.querySelector('#document-body').setSelectionRange(1, 1);
  });
  await dispatchHtmlPaste(page, '<p>不得插入</p>');
  await page.getByText('浏览器无法安全插入转换后的富文本', { exact: false }).waitFor();
  await page.waitForTimeout(700);
  assert.deepEqual(await page.evaluate(() => ({
    body: document.querySelector('#document-body').value,
    checks: document.querySelector('#format-checks').innerHTML,
    preview: document.querySelector('#preview').innerHTML,
    renderStatus: document.querySelector('#render-status').textContent
  })), { body: stable.body, checks: stable.checks, preview: stable.preview, renderStatus: stable.renderStatus });
  assert.equal(await audit.getAttribute('data-diagnostic-id'), stable.auditId);
  assert.equal(renderRequests.length, stable.renders);
  assert.equal(savePayloads.length, stable.saves);
  assert.deepEqual(pageErrors, []);

  await page.getByLabel('外链转脚注').check();
  await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1600 });
  assert.equal(savePayloads.at(-1).body, stable.body, '失败插入后 documentModel.body 必须恢复');
});

test('image File execCommand 破坏正文后抛错会完整回滚且无未处理异常', async t => {
  const { page, base } = await withBrowser(t);
  const pageErrors = [];
  const renderRequests = [];
  const savePayloads = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/typesetting/render', route => {
    const request = route.request().postDataJSON();
    renderRequests.push(request);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...emptyResult(request.body), presentation: { theme: request.theme, settings: request.settings } }) });
  });
  await page.route('**/api/typesetting/document', async route => {
    if (route.request().method() === 'POST') savePayloads.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.route('**/api/typesetting/rich-text', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(richResult({ markdown: '建立旧审计', removed: ['script'], downgraded: [], block: false })) }));
  await page.goto(base() + '/typesetting');
  await page.getByLabel('Markdown 正文').fill('甲乙');
  await page.evaluate(() => { window.confirm = () => true; const body = document.querySelector('#document-body'); body.setSelectionRange(1, 1); });
  await dispatchHtmlPaste(page, '<p>建立旧审计</p>');
  const audit = page.locator('.format-check-item[data-diagnostic-id^="rich-text-removal-"]');
  await audit.waitFor();
  await waitForRenderState(page, 'current');
  await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1600 });
  const stable = {
    body: await page.getByLabel('Markdown 正文').inputValue(),
    auditId: await audit.getAttribute('data-diagnostic-id'),
    checks: await page.locator('#format-checks').innerHTML(),
    preview: await page.locator('#preview').innerHTML(),
    renderStatus: await page.locator('#render-status').textContent(),
    renders: renderRequests.length,
    saves: savePayloads.length
  };

  await page.evaluate(() => {
    document.execCommand = (_command, _ui, value) => {
      const body = document.querySelector('#document-body');
      body.setRangeText(`破坏-${value}`, body.selectionStart, body.selectionEnd, 'end');
      body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      throw new Error('image exec mutation then throw');
    };
    document.querySelector('#document-body').setSelectionRange(1, 1);
  });
  assert.equal(await dispatchImageFilePaste(page), true);
  await page.getByText('浏览器无法安全插入图片占位', { exact: false }).waitFor();
  await page.waitForTimeout(700);
  assert.deepEqual(await page.evaluate(() => ({
    body: document.querySelector('#document-body').value,
    checks: document.querySelector('#format-checks').innerHTML,
    preview: document.querySelector('#preview').innerHTML,
    renderStatus: document.querySelector('#render-status').textContent
  })), { body: stable.body, checks: stable.checks, preview: stable.preview, renderStatus: stable.renderStatus });
  assert.equal(await audit.getAttribute('data-diagnostic-id'), stable.auditId);
  assert.equal(renderRequests.length, stable.renders);
  assert.equal(savePayloads.length, stable.saves);
  assert.deepEqual(pageErrors, []);

  await page.getByLabel('外链转脚注').check();
  await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1600 });
  assert.equal(savePayloads.at(-1).body, stable.body, '失败图片插入后 documentModel.body 必须恢复');
});
