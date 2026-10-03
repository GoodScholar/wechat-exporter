import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readJson = async relativePath => JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));

const presentation = {
  theme: 'default',
  settings: { primaryColor: '#0F4C81', fontSize: '16px', lineHeight: '1.75', blockSpacing: '1' }
};
const document = {
  title: '输出标题', author: '作者', account: '公众号', publishedAt: '2026-10-03', body: '# 正文'
};
const outputRequest = (overrides = {}) => ({
  document,
  presentation,
  convertExternalLinksToFootnotes: false,
  failedImageTargets: [],
  ...overrides
});
const blocker = (body = document.body) => ({
  id: 'diagnostic-blocker',
  code: body.trim() ? 'RENDER_FAILED' : 'EMPTY_BODY',
  severity: 'blocker',
  message: body.trim() ? '正文渲染失败，请检查内容后重试。' : '正文为空，请输入需要排版的内容。',
  targets: [{ kind: 'source', start: 0, end: body.trim() ? body.length : 0 }]
});
const blockedResult = (normalizedPresentation, html = '', body = document.body) => ({
  html,
  presentation: normalizedPresentation,
  diagnostics: [blocker(body)],
  blocked: true
});

async function loadOutputModule() {
  let module;
  let loadError;
  try {
    module = await import('../src/typesetting-output.js');
  } catch (error) {
    loadError = error;
  }
  assert.equal(loadError, undefined, 'src/typesetting-output.js 应提供输出深模块');
  return module;
}

async function assertOutputError(operation, code) {
  await assert.rejects(operation, error => {
    assert.equal(error.code, code);
    assert.doesNotMatch(String(error.message), /sentinel|\/Users\/private|secret\.example/iu);
    return true;
  });
}

function withCustomPrototype(value) {
  return Object.assign(Object.create({ inherited: true }), value);
}

function withHiddenExtra(value) {
  const copy = { ...value };
  Object.defineProperty(copy, 'hidden', { value: true });
  return copy;
}

test('输出依赖和共享 Markdown fixture 固定版本与完整 artifact shape', async () => {
  const packageJson = await readJson('../package.json');
  const lock = await readJson('../package-lock.json');

  assert.equal(packageJson.dependencies.juice, '11.0.3');
  assert.equal(lock.packages['node_modules/juice'].version, '11.0.3');

  const fixtures = await readJson('./fixtures/typesetting-output-artifacts.json');
  assert.ok(Array.isArray(fixtures));
  assert.ok(fixtures.length > 0);

  for (const item of fixtures) {
    assert.deepEqual(Object.keys(item).sort(), ['artifact', 'document', 'name']);
    assert.equal(typeof item.name, 'string');
    assert.deepEqual(Object.keys(item.document).sort(), ['account', 'author', 'body', 'publishedAt', 'title']);
    assert.equal(Object.values(item.document).every(value => typeof value === 'string'), true);
    assert.deepEqual(Object.keys(item.artifact).sort(), ['content', 'filename', 'mimeType']);
    assert.equal(item.artifact.mimeType, 'text/markdown;charset=utf-8');
    assert.equal(typeof item.artifact.filename, 'string');
    assert.match(item.artifact.content, /^---\ntitle: /u);
    assert.equal(item.artifact.content.endsWith('\n'), true);
    assert.equal(item.artifact.content.endsWith('\n\n'), false);
  }

  const whitespace = fixtures.find(item => item.name === '正文空白逐字节保留');
  assert.ok(whitespace);
  assert.equal(whitespace.document.body, '  开头\r\n行尾  \r末行空白  \n\n');
  assert.equal(whitespace.artifact.content.split('---\n\n')[1], '  开头\n行尾  \n末行空白  \n');
});

test('输出 builder 只接受 exact 四键请求和 exact 五键 document', async () => {
  const { createTypesettingOutputBuilder } = await loadOutputModule();
  const renderCalls = [];
  const build = createTypesettingOutputBuilder({
    renderTypesetting(input) {
      renderCalls.push(input);
      return blockedResult(input.presentation, '', input.body);
    },
    inlineCss() {
      throw new Error('blocked 不应调用 inlineCss');
    },
    themeCss: 'fixed theme css'
  });

  const normalized = await build(outputRequest({
    document: {
      title: '标题\r\n第二行', author: '作者\r名', account: '公众号', publishedAt: '2026-10-03', body: '第一行\r\n第二行\r'
    },
    convertExternalLinksToFootnotes: true
  }));
  assert.deepEqual(renderCalls, [{
    body: '第一行\n第二行\n', presentation, convertExternalLinksToFootnotes: true
  }]);
  assert.deepEqual(normalized.snapshot.document, {
    title: '标题\n第二行', author: '作者\n名', account: '公众号', publishedAt: '2026-10-03', body: '第一行\n第二行\n'
  });

  const valid = outputRequest();
  const { failedImageTargets, ...missingTopLevel } = valid;
  const invalidRequests = [
    null,
    [],
    missingTopLevel,
    { ...valid, extra: true },
    { ...valid, document: null },
    { ...valid, document: { ...document, extra: true } },
    { ...valid, document: Object.fromEntries(Object.entries(document).filter(([key]) => key !== 'author')) },
    ...Object.keys(document).map(key => ({ ...valid, document: { ...document, [key]: 42 } })),
    { ...valid, presentation: { ...presentation, extra: true } },
    { ...valid, presentation: { ...presentation, settings: { ...presentation.settings, fontSize: '999px' } } },
    { ...valid, convertExternalLinksToFootnotes: 'false' },
    { ...valid, failedImageTargets: 'format-target' },
    { ...valid, failedImageTargets: [''] },
    { ...valid, failedImageTargets: [42] }
  ];
  for (const invalid of invalidRequests) await assertOutputError(build(invalid), 'OUTPUT_REQUEST_INVALID');
  await assertOutputError(build({ ...valid, failedImageTargets: ['format-target-aaaaaaaaaaaaaaaaaaaaaaaa-1', 'format-target-aaaaaaaaaaaaaaaaaaaaaaaa-1'] }), 'OUTPUT_FAILED_IMAGE_TARGET_INVALID');
});

test('服务端 Markdown artifact 与共享 fixture 逐字节一致', async () => {
  const { createTypesettingOutputBuilder } = await loadOutputModule();
  const fixtures = await readJson('./fixtures/typesetting-output-artifacts.json');
  const build = createTypesettingOutputBuilder({
    renderTypesetting(input) {
      return blockedResult(input.presentation, '', input.body);
    },
    inlineCss() {
      throw new Error('blocked 不应调用 inlineCss');
    },
    themeCss: 'fixed theme css'
  });

  for (const item of fixtures) {
    const bundle = await build(outputRequest({ document: item.document }));
    assert.deepEqual(bundle.markdown, item.artifact, item.name);
  }
});

test('blocked bundle 恰好六键并跳过 Juice', async () => {
  const { buildTypesettingOutput, createTypesettingOutputBuilder } = await loadOutputModule();
  let inlineCalls = 0;
  const renderCalls = [];
  const build = createTypesettingOutputBuilder({
    renderTypesetting(input) {
      renderCalls.push(input);
      return blockedResult(input.presentation, '<p>阻断正文不会进入输出</p>', input.body);
    },
    inlineCss() {
      inlineCalls += 1;
      return 'unexpected';
    },
    themeCss: 'fixed theme css'
  });
  const bundle = await build(outputRequest());

  assert.deepEqual(Object.keys(bundle).sort(), ['clipboard', 'html', 'markdown', 'schemaVersion', 'snapshot', 'status']);
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.status, 'blocked');
  assert.equal(bundle.clipboard, null);
  assert.equal(bundle.html, null);
  assert.equal(inlineCalls, 0);
  assert.deepEqual(renderCalls, [{ body: document.body, presentation, convertExternalLinksToFootnotes: false }]);
  assert.deepEqual(Object.keys(bundle.snapshot).sort(), ['convertExternalLinksToFootnotes', 'document', 'failedImageTargets', 'presentation']);
  assert.deepEqual(Object.keys(bundle.snapshot.document).sort(), ['account', 'author', 'body', 'publishedAt', 'title']);
  assert.deepEqual(Object.keys(bundle.snapshot.presentation).sort(), ['settings', 'theme']);
  assert.deepEqual(Object.keys(bundle.snapshot.presentation.settings).sort(), ['blockSpacing', 'fontSize', 'lineHeight', 'primaryColor']);
  assert.deepEqual(bundle.snapshot.failedImageTargets, []);
  assert.doesNotMatch(JSON.stringify(bundle), /diagnostics|data-format-target/u);

  const productionBundle = await buildTypesettingOutput(outputRequest({ document: { ...document, body: '' } }));
  assert.equal(productionBundle.status, 'blocked');
  assert.equal(productionBundle.markdown.content.endsWith('\n'), true);
  assert.equal(productionBundle.clipboard, null);
  assert.equal(productionBundle.html, null);
});

test('输出 builder 拒绝畸形四键 RenderResult 且不泄漏内部错误', async () => {
  const { createTypesettingOutputBuilder } = await loadOutputModule();
  const malformedResults = [
    null,
    [],
    { html: '', presentation, diagnostics: [blocker()] },
    { ...blockedResult(presentation), extra: true },
    { ...blockedResult(presentation), html: 42 },
    { ...blockedResult(presentation), presentation: { ...presentation, extra: true } },
    { ...blockedResult(presentation), presentation: { theme: 'grace', settings: presentation.settings } },
    { ...blockedResult(presentation), diagnostics: null },
    { ...blockedResult(presentation), blocked: 'true' },
    { html: '', presentation, diagnostics: [blocker()], blocked: false },
    { html: '', presentation, diagnostics: [], blocked: true }
  ];

  for (const malformed of malformedResults) {
    const build = createTypesettingOutputBuilder({
      renderTypesetting: () => malformed,
      inlineCss: () => 'unexpected',
      themeCss: 'fixed theme css'
    });
    await assertOutputError(build(outputRequest({ document: { ...document, body: 'sentinel /Users/private/source.md' } })), 'OUTPUT_GENERATION_FAILED');
  }

  const throwingBuild = createTypesettingOutputBuilder({
    renderTypesetting() {
      throw new Error('renderer sentinel /Users/private/source.md');
    },
    inlineCss: () => 'unexpected',
    themeCss: 'fixed theme css'
  });
  await assertOutputError(throwingBuild(outputRequest()), 'OUTPUT_GENERATION_FAILED');
});

test('输出 builder 要求 exact record 为普通对象且拒绝异步 renderer', async () => {
  const { createTypesettingOutputBuilder } = await loadOutputModule();
  const ordinaryBuild = createTypesettingOutputBuilder({
    renderTypesetting: input => blockedResult(input.presentation, '', input.body),
    inlineCss: () => 'unexpected',
    themeCss: 'fixed theme css'
  });
  const valid = outputRequest();

  await assertOutputError(ordinaryBuild(withCustomPrototype(valid)), 'OUTPUT_REQUEST_INVALID');
  await assertOutputError(ordinaryBuild(withHiddenExtra(valid)), 'OUTPUT_REQUEST_INVALID');
  await assertOutputError(ordinaryBuild({ ...valid, document: withCustomPrototype(document) }), 'OUTPUT_REQUEST_INVALID');
  await assertOutputError(ordinaryBuild({ ...valid, document: withHiddenExtra(document) }), 'OUTPUT_REQUEST_INVALID');

  for (const result of [withCustomPrototype(blockedResult(presentation)), withHiddenExtra(blockedResult(presentation))]) {
    const build = createTypesettingOutputBuilder({
      renderTypesetting: () => result,
      inlineCss: () => 'unexpected',
      themeCss: 'fixed theme css'
    });
    await assertOutputError(build(valid), 'OUTPUT_GENERATION_FAILED');
  }

  const asyncBuild = createTypesettingOutputBuilder({
    renderTypesetting: input => Promise.resolve(blockedResult(input.presentation, '', input.body)),
    inlineCss: () => 'unexpected',
    themeCss: 'fixed theme css'
  });
  await assertOutputError(asyncBuild(valid), 'OUTPUT_GENERATION_FAILED');
});

test('输出 builder 按 #6 判别联合严格校验 diagnostics', async () => {
  const { createTypesettingOutputBuilder } = await loadOutputModule();
  const body = '严格诊断';
  const previewOne = 'diagnostic-preview-one';
  const previewTwo = 'diagnostic-preview-two';
  const previewSpecial = 'diagnostic-preview-special';
  const previewImage = 'diagnostic-preview-image';
  const html = [
    `<a href="https://example.com/one" data-format-target="${previewOne}">一<sup>[1]</sup></a>`,
    `<a href="https://example.com/two" data-format-target="${previewTwo}">二<sup>[1]</sup></a>`,
    `<blockquote class="format-special-placeholder" data-format-target="${previewSpecial}" tabindex="0" role="note">特殊内容</blockquote>`,
    `<figure class="format-image-placeholder" data-format-target="${previewImage}" tabindex="0" role="note">图片占位</figure>`
  ].join('');
  const footnote = {
    id: 'diagnostic-footnote', code: 'EXTERNAL_LINK_TO_FOOTNOTE', severity: 'conversion', message: '已将外部链接转换为脚注。',
    targets: [{ kind: 'preview', id: previewOne }, { kind: 'preview', id: previewTwo }],
    meta: { footnote: 1, occurrences: 2 }
  };
  const special = {
    id: 'diagnostic-special', code: 'SPECIAL_CONTENT_PLACEHOLDER', severity: 'conversion', message: '已将特殊内容保留为可见占位。',
    targets: [{ kind: 'preview', id: previewSpecial }], meta: { type: 'video' }
  };
  const image = {
    id: 'diagnostic-image', code: 'IMAGE_MISSING_SOURCE', severity: 'advisory', message: '图片缺少来源。',
    targets: [{ kind: 'preview', id: previewImage }]
  };
  const validDiagnostics = [blocker(body), footnote, special, image];
  const validResult = { html, presentation, diagnostics: validDiagnostics, blocked: true };
  const buildFor = result => createTypesettingOutputBuilder({
    renderTypesetting: () => result,
    inlineCss: () => 'unexpected',
    themeCss: 'fixed theme css'
  });

  assert.equal((await buildFor(validResult)(outputRequest({ document: { ...document, body } }))).status, 'blocked');

  const sourceTarget = blocker(body).targets[0];
  const malformedDiagnostics = [
    [{ severity: 'blocker' }],
    [{ ...blocker(body), extra: true }],
    [withCustomPrototype(blocker(body))],
    [withHiddenExtra(blocker(body))],
    [{ ...blocker(body), targets: [{ ...sourceTarget, extra: true }] }],
    [{ ...blocker(body), targets: [withCustomPrototype(sourceTarget)] }],
    [{ ...blocker(body), targets: [withHiddenExtra(sourceTarget)] }],
    [{ ...blocker(body), targets: [{ kind: 'source', start: 0, end: body.length + 1 }] }],
    [{ ...image, targets: [{ kind: 'preview', id: 'absent' }] }, blocker(body)],
    [{ ...image, targets: [{ kind: 'preview', id: '' }] }, blocker(body)],
    [{ ...footnote, meta: { footnote: 0, occurrences: 2 } }, blocker(body), special, image],
    [{ ...footnote, meta: { footnote: 1, occurrences: 1 } }, blocker(body), special, image],
    [{ ...footnote, meta: { ...footnote.meta, extra: true } }, blocker(body), special, image],
    [{ ...footnote, meta: withCustomPrototype(footnote.meta) }, blocker(body), special, image],
    [{ ...footnote, meta: withHiddenExtra(footnote.meta) }, blocker(body), special, image],
    [{ ...special, meta: { type: 'unknown' } }, blocker(body), footnote, image],
    [{ ...image, severity: 'conversion' }, blocker(body), footnote, special],
    [{ ...image, code: 'IMAGE_LOAD_FAILED' }, blocker(body), footnote, special],
    [blocker(body), { ...blocker(body) }],
    [blocker(body), image, { ...special, targets: [{ kind: 'preview', id: previewImage }] }]
  ];

  for (const diagnostics of malformedDiagnostics) {
    await assertOutputError(buildFor({ ...validResult, diagnostics })(outputRequest({ document: { ...document, body } })), 'OUTPUT_GENERATION_FAILED');
  }
});

test('failed target 仅接受当前唯一受控 HTTPS 图片并按 DOM 顺序回显', async () => {
  const { createTypesettingOutputBuilder } = await loadOutputModule();
  const first = 'format-target-aaaaaaaaaaaaaaaaaaaaaaaa-1';
  const second = 'format-target-aaaaaaaaaaaaaaaaaaaaaaaa-2';
  let inlineCalls = 0;
  const build = createTypesettingOutputBuilder({
    renderTypesetting(input) {
      return blockedResult(input.presentation, [
        `<img src="https://images.example/first.png" alt="第一张" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="${first}">`,
        '<p>中间正文</p>',
        `<img src="https://images.example/second.png" alt="第二张" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="${second}">`
      ].join(''), input.body);
    },
    inlineCss() {
      inlineCalls += 1;
      return 'unexpected';
    },
    themeCss: 'fixed theme css'
  });

  const bundle = await build(outputRequest({ failedImageTargets: [first, second] }));
  assert.deepEqual(bundle.snapshot.failedImageTargets, [first, second]);
  assert.equal(bundle.status, 'blocked');
  assert.equal(inlineCalls, 0);
});

test('failed target 拒绝未知链接静态占位重复 DOM target 乱序与旧 nonce', async () => {
  const { createTypesettingOutputBuilder } = await loadOutputModule();
  const first = 'format-target-bbbbbbbbbbbbbbbbbbbbbbbb-1';
  const second = 'format-target-bbbbbbbbbbbbbbbbbbbbbbbb-2';
  const image = (target, source = 'https://images.example/image.png', attributes = '') => `<img src="${source}" alt="图片" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="${target}" ${attributes}>`;
  const cases = [
    ['未知 target', image(first), ['format-target-cccccccccccccccccccccccc-1']],
    ['链接 target', `<a href="https://example.com" data-format-target="${first}">链接</a>`, [first]],
    ['静态占位 target', `<figure class="format-image-placeholder" role="note" data-format-target="${first}">占位</figure>`, [first]],
    ['重复 DOM target', image(first) + image(first), [first]],
    ['请求顺序与 DOM 相反', image(first) + image(second), [second, first]],
    ['旧 nonce', image(first), ['format-target-dddddddddddddddddddddddd-1']],
    ['非 HTTPS 图片', image(first, 'http://images.example/image.png'), [first]],
    ['带凭据图片', image(first, 'https://reader:secret@images.example/image.png'), [first]],
    ['错误 referrer policy', image(first).replace('no-referrer', 'origin'), [first]],
    ['缺少 pending 状态', image(first).replace(' data-image-state="pending"', ''), [first]],
    ['非规范 runtime 状态', image(first).replace('pending', 'loaded'), [first]],
    ['缺少 alt', image(first).replace(' alt="图片"', ''), [first]],
    ['额外 onerror', image(first, 'https://images.example/image.png', 'onerror="evil()"'), [first]],
    ['额外 class', image(first, 'https://images.example/image.png', 'class="unexpected"'), [first]],
    ['额外 data 属性', image(first, 'https://images.example/image.png', 'data-extra="unexpected"'), [first]],
    ['不受控 target 形状', image('format-target-short-1'), ['format-target-short-1']]
  ];

  for (const [label, html, failedImageTargets] of cases) {
    const build = createTypesettingOutputBuilder({
      renderTypesetting: input => blockedResult(input.presentation, html, input.body),
      inlineCss: () => 'unexpected',
      themeCss: 'fixed theme css'
    });
    await assertOutputError(build(outputRequest({ failedImageTargets })), 'OUTPUT_FAILED_IMAGE_TARGET_INVALID');
    assert.ok(label);
  }
});

test('空 failed target 跨 renderer nonce 正常且 bundle 不泄漏新 target', async () => {
  const { createTypesettingOutputBuilder } = await loadOutputModule();
  const targets = [
    'format-target-111111111111111111111111-1',
    'format-target-222222222222222222222222-1'
  ];

  for (const target of targets) {
    const build = createTypesettingOutputBuilder({
      renderTypesetting: input => blockedResult(input.presentation, `<img src="https://images.example/image.png" alt="图片" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="${target}">`, input.body),
      inlineCss: () => 'unexpected',
      themeCss: 'fixed theme css'
    });
    const bundle = await build(outputRequest());
    assert.deepEqual(bundle.snapshot.failedImageTargets, []);
    assert.equal(bundle.status, 'blocked');
    assert.doesNotMatch(JSON.stringify(bundle), /format-target-/u);
  }
});

test('输出 builder 在 Task 2 不伪造 ready 产物', async () => {
  const { createTypesettingOutputBuilder } = await loadOutputModule();
  let inlineCalls = 0;
  const build = createTypesettingOutputBuilder({
    renderTypesetting: input => ({ html: '<p>正文</p>', presentation: input.presentation, diagnostics: [], blocked: false }),
    inlineCss() {
      inlineCalls += 1;
      return '<p>伪产物</p>';
    },
    themeCss: 'fixed theme css'
  });

  await assertOutputError(build(outputRequest()), 'OUTPUT_GENERATION_FAILED');
  assert.equal(inlineCalls, 0);
});
