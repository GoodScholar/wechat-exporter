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
