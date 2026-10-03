import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { load } from 'cheerio';
import juice from 'juice';
import { createApp } from '../src/server.js';

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
const readyResult = (normalizedPresentation, html, diagnostics = []) => ({
  html,
  presentation: normalizedPresentation,
  diagnostics,
  blocked: false
});
const fixedJuiceOptions = {
  applyStyleTags: true,
  removeStyleTags: true,
  inlinePseudoElements: false,
  preserveFontFaces: false,
  preserveMediaQueries: false,
  preserveKeyFrames: false,
  preservePseudos: false,
  preserveImportant: false,
  resolveCSSVariables: true,
  applyWidthAttributes: false,
  applyHeightAttributes: false,
  xmlMode: false
};
const previewAllowedTags = [
  'address', 'article', 'aside', 'footer', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup', 'main', 'nav', 'section',
  'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'hr', 'li', 'menu', 'ol', 'p', 'pre', 'ul',
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'img', 'kbd', 'mark', 'q', 'rb', 'rp', 'rt', 'rtc', 'ruby',
  's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
  'caption', 'col', 'colgroup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr'
];

function inlineRequiredImageStyles(html) {
  const $ = load(html, null, false);
  $('img').attr('style', 'display: block; max-width: 100%; height: auto;');
  return $.root().html() || '';
}

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

function withArrayExtra(values, key) {
  const copy = [...values];
  Object.defineProperty(copy, key, { value: true });
  return copy;
}

function withCustomArrayPrototype(values) {
  const copy = [...values];
  Object.setPrototypeOf(copy, Object.create(Array.prototype));
  return copy;
}

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

const outputHttpErrors = Object.freeze({
  OUTPUT_REQUEST_FORBIDDEN: Object.freeze({ status: 403, message: '排版输出请求被拒绝', retryable: false }),
  OUTPUT_METHOD_NOT_ALLOWED: Object.freeze({ status: 405, message: '排版输出仅支持 POST 请求', retryable: false }),
  OUTPUT_JSON_INVALID: Object.freeze({ status: 400, message: '排版输出 JSON 无效', retryable: false }),
  OUTPUT_REQUEST_TOO_LARGE: Object.freeze({ status: 413, message: '排版输出请求过大', retryable: false }),
  OUTPUT_REQUEST_INVALID: Object.freeze({ status: 400, message: '排版输出请求无效', retryable: false }),
  OUTPUT_FAILED_IMAGE_TARGET_INVALID: Object.freeze({ status: 400, message: '失败图片目标无效', retryable: false }),
  OUTPUT_GENERATION_FAILED: Object.freeze({ status: 500, message: '排版输出生成失败', retryable: true })
});

async function assertTypedOutputResponse(response, code) {
  const expected = outputHttpErrors[code];
  assert.equal(response.status, expected.status);
  assert.match(response.headers.get('content-type') || '', /^application\/json\b/iu);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['error']);
  assert.deepEqual(Object.keys(body.error), ['code', 'message', 'retryable']);
  assert.deepEqual(body, { error: { code, message: expected.message, retryable: expected.retryable } });
  assert.doesNotMatch(JSON.stringify(body), /sentinel|\/Users\/private|secret\.example|SyntaxError|entity\.parse|api\/typesetting\/output/iu);
}

function rawHttpResponse(url, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
      headers
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const content = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          headers: { get: name => response.headers[name.toLowerCase()] || null },
          json: async () => JSON.parse(content)
        });
      });
    });
    request.once('error', reject);
    request.end(body);
  });
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

test('第三方 notice 精确记录 doocs 三 helper 与 Juice 固定版本许可边界', async () => {
  const notice = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  assert.match(notice, /a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/u);
  assert.match(notice, /WTFPL/u);

  const sourceRows = [
    {
      upstream: 'apps/web/src/services/export/clipboard-dom.ts',
      local: 'src/typesetting-output.js',
      responsibilities: ['Copied and adapted only', 'solveWeChatImage()', 'modifyHtmlStructure()', 'createEmptyNode()']
    },
    {
      upstream: 'apps/web/src/services/export/clipboard.ts',
      local: 'src/typesetting-output.js',
      responsibilities: ['safe DOM', 'Juice', 'compatibility fix', 'un-inlined fallback', 'active deviation']
    },
    {
      upstream: 'apps/web/src/lib/browser/clipboard.ts',
      local: 'public/typesetting.js',
      responsibilities: ['Behavior reference only', 'ClipboardItem', 'clipboard.write()', 'dual MIME', 'plain-text fallback', 'legacy fallback', 'not copied']
    }
  ];
  for (const { upstream, local, responsibilities } of sourceRows) {
    const row = notice.split('\n').find(line => line.includes(`\`${upstream}\``));
    assert.ok(row, `notice 应包含完整上游路径 ${upstream}`);
    for (const token of [local, ...responsibilities]) assert.ok(row.includes(token), `${upstream} 行应包含 ${token}`);
  }

  const juiceNotice = notice.split('## Juice')[1] || '';
  for (const token of [
    '11.0.3',
    'ce15687713507252813744b0daaa70d4549527d1',
    'MIT',
    'Automattic',
    '>=18.17',
    'string public API',
    'juiceResources()',
    'juiceFile()',
    'fallback'
  ]) assert.ok(juiceNotice.includes(token), `Juice notice 应包含 ${token}`);

  const juicePackage = await readJson('../node_modules/juice/package.json');
  assert.equal(juicePackage.version, '11.0.3');
  assert.equal(juicePackage.license, 'MIT');
  assert.equal(juicePackage.engines.node, '>=18.17');
  if (Object.hasOwn(juicePackage, 'gitHead')) {
    assert.equal(juicePackage.gitHead, 'ce15687713507252813744b0daaa70d4549527d1');
  }
  const juiceLicense = await readFile(new URL('../node_modules/juice/LICENSE.md', import.meta.url), 'utf8');
  assert.match(juiceLicense, /^# MIT License$/mu);
  assert.match(juiceLicense, /Copyright \(c\) 2021 Automattic/u);

  assert.match(notice, /Clipboard API[\s\S]*Blob[\s\S]*object URL[\s\S]*browser standards/iu);
  assert.match(notice, /not copied the complete doocs clipboard\s+pipeline/iu);
  assert.match(notice, /has not completed compatibility acceptance in the real WeChat Official\s+Account editor/iu);

  const doocsLicense = await readFile(new URL('../LICENSES/DOOCS-MD-WTFPL-2.txt', import.meta.url), 'utf8');
  assert.match(doocsLicense, /DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE/u);
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

test('输出 builder 拒绝稀疏或带额外属性的契约数组', async () => {
  const { createTypesettingOutputBuilder } = await loadOutputModule();
  const ordinaryBuild = createTypesettingOutputBuilder({
    renderTypesetting: input => blockedResult(input.presentation, '', input.body),
    inlineCss: () => 'unexpected',
    themeCss: 'fixed theme css'
  });
  const sparseFailedTargets = new Array(1);
  for (const failedImageTargets of [
    sparseFailedTargets,
    withArrayExtra([], 'hidden'),
    withArrayExtra([], Symbol('extra')),
    withCustomArrayPrototype([])
  ]) {
    await assertOutputError(ordinaryBuild(outputRequest({ failedImageTargets })), 'OUTPUT_REQUEST_INVALID');
  }

  const body = '数组契约';
  const validBlocker = blocker(body);
  const sparseDiagnostics = new Array(2);
  sparseDiagnostics[1] = validBlocker;
  for (const diagnostics of [
    sparseDiagnostics,
    withArrayExtra([validBlocker], 'hidden'),
    withArrayExtra([validBlocker], Symbol('extra')),
    withCustomArrayPrototype([validBlocker])
  ]) {
    const build = createTypesettingOutputBuilder({
      renderTypesetting: () => ({ html: '', presentation, diagnostics, blocked: true }),
      inlineCss: () => 'unexpected',
      themeCss: 'fixed theme css'
    });
    await assertOutputError(build(outputRequest({ document: { ...document, body } })), 'OUTPUT_GENERATION_FAILED');
  }

  const preview = 'array-preview-target';
  const html = `<a href="https://example.com" data-format-target="${preview}">链接</a>`;
  const previewTarget = { kind: 'preview', id: preview };
  const sparseTargets = new Array(2);
  sparseTargets[1] = previewTarget;
  for (const targets of [
    sparseTargets,
    withArrayExtra([previewTarget], 'hidden'),
    withArrayExtra([previewTarget], Symbol('extra')),
    withCustomArrayPrototype([previewTarget])
  ]) {
    const footnote = {
      id: 'diagnostic-footnote', code: 'EXTERNAL_LINK_TO_FOOTNOTE', severity: 'conversion', message: '已转换脚注。',
      targets, meta: { footnote: 1, occurrences: targets.length }
    };
    const build = createTypesettingOutputBuilder({
      renderTypesetting: () => ({ html, presentation, diagnostics: [blocker(body), footnote], blocked: true }),
      inlineCss: () => 'unexpected',
      themeCss: 'fixed theme css'
    });
    await assertOutputError(build(outputRequest({ document: { ...document, body } })), 'OUTPUT_GENERATION_FAILED');
  }
});

test('输出 builder 不读取 then getter并安全拒绝 Promise 与自定义 thenable', async () => {
  const { createTypesettingOutputBuilder } = await loadOutputModule();
  let thenGetterReads = 0;
  const throwingThenGetter = blockedResult(presentation);
  Object.defineProperty(throwingThenGetter, 'then', {
    get() {
      thenGetterReads += 1;
      throw new Error('then getter sentinel /Users/private/source.md');
    }
  });
  const customThenable = {
    then() {
      throw new Error('custom thenable sentinel /Users/private/source.md');
    }
  };
  for (const rendered of [throwingThenGetter, customThenable]) {
    const build = createTypesettingOutputBuilder({
      renderTypesetting: () => rendered,
      inlineCss: () => 'unexpected',
      themeCss: 'fixed theme css'
    });
    await assertOutputError(build(outputRequest()), 'OUTPUT_GENERATION_FAILED');
  }
  assert.equal(thenGetterReads, 0);

  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const rejectedPromise = Promise.reject(new Error('promise rejection sentinel /Users/private/source.md'));
    const build = createTypesettingOutputBuilder({
      renderTypesetting: () => rejectedPromise,
      inlineCss: () => 'unexpected',
      themeCss: 'fixed theme css'
    });
    await assertOutputError(build(outputRequest()), 'OUTPUT_GENERATION_FAILED');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
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

test('三个主题和四项设置经固定 Juice options 形成无 class 变量 style 标签的 canonical body', async () => {
  const { createTypesettingOutputBuilder } = await loadOutputModule();
  const themeCss = await readFile(new URL('../public/typesetting-theme.css', import.meta.url), 'utf8');
  const settings = { primaryColor: '#FA5151', fontSize: '18px', lineHeight: '2.05', blockSpacing: '1.35' };

  for (const theme of ['default', 'grace', 'simple']) {
    const calls = [];
    const currentPresentation = { theme, settings };
    const build = createTypesettingOutputBuilder({
      renderTypesetting: input => readyResult(input.presentation, '<h1>标题</h1><p>正文</p>'),
      inlineCss(html, css, options) {
        calls.push({ html, css, options });
        return juice(`<style>${css}</style>${html}`, options);
      },
      themeCss
    });
    const bundle = await build(outputRequest({ presentation: currentPresentation }));

    assert.equal(bundle.status, 'ready');
    assert.deepEqual(Object.keys(bundle).sort(), ['clipboard', 'html', 'markdown', 'schemaVersion', 'snapshot', 'status']);
    assert.deepEqual(Object.keys(bundle.clipboard).sort(), ['html', 'plain']);
    assert.deepEqual(bundle.clipboard.html.mimeType, 'text/html');
    assert.deepEqual(bundle.clipboard.plain.mimeType, 'text/plain');
    assert.deepEqual(Object.keys(bundle.html).sort(), ['content', 'filename', 'mimeType']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].css, themeCss);
    assert.deepEqual(calls[0].options, fixedJuiceOptions);
    assert.match(calls[0].html, new RegExp(`typeset-theme-${theme}`, 'u'));
    assert.match(calls[0].html, /--md-primary-color:#FA5151/u);
    const $full = load(bundle.html.content);
    const canonical = $full('main > section');
    assert.equal(canonical.length, 1);
    assert.match(canonical.attr('style'), /font:\s*18px\/2\.05/iu);
    assert.match(canonical.html(), /#FA5151/iu);
    assert.match(canonical.html(), /calc\([^)]*\* 1\.35\)/iu);
    assert.equal($full('main style, main [class], main [id], main [data-format-target], main [data-image-state]').length, 0);
    assert.doesNotMatch($full('main').html(), /--md-|@media|@font-face|url\s*\(/iu);
  }
});

test('输出标签集合、anchor URL、table span 与 Juice failure seam 严格遵守 canonical 白名单', async () => {
  const { createTypesettingOutputBuilder } = await loadOutputModule();
  const specialMarkup = {
    a: '<a href="../relative#part" title="标题">a</a>',
    br: '<p>前<br>后</p>',
    col: '<table><colgroup><col></colgroup><tbody><tr><td>x</td></tr></tbody></table>',
    colgroup: '<table><colgroup><col></colgroup><tbody><tr><td>x</td></tr></tbody></table>',
    caption: '<table><caption>x</caption><tbody><tr><td>x</td></tr></tbody></table>',
    table: '<table><tbody><tr><td>x</td></tr></tbody></table>',
    tbody: '<table><tbody><tr><td>x</td></tr></tbody></table>',
    td: '<table><tbody><tr><td>x</td></tr></tbody></table>',
    tfoot: '<table><tfoot><tr><td>x</td></tr></tfoot></table>',
    th: '<table><thead><tr><th>x</th></tr></thead></table>',
    thead: '<table><thead><tr><th>x</th></tr></thead></table>',
    tr: '<table><tbody><tr><td>x</td></tr></tbody></table>',
    dd: '<dl><dt>k</dt><dd>v</dd></dl>',
    dt: '<dl><dt>k</dt><dd>v</dd></dl>',
    figcaption: '<figure><figcaption>x</figcaption></figure>',
    li: '<ul><li>x</li></ul>',
    rb: '<ruby><rb>汉</rb><rt>hàn</rt></ruby>',
    rp: '<ruby><rp>(</rp><rt>hàn</rt><rp>)</rp></ruby>',
    rt: '<ruby><rb>汉</rb><rt>hàn</rt></ruby>',
    rtc: '<ruby><rb>汉</rb><rtc>hàn</rtc></ruby>',
    img: '<img src="https://images.example/image.png" alt="图" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="format-target-aaaaaaaaaaaaaaaaaaaaaaaa-1">'
  };
  const voidTags = new Set(['hr', 'wbr']);
  for (const tag of previewAllowedTags) {
    const html = specialMarkup[tag] || (voidTags.has(tag) ? `<${tag}>` : `<${tag}>x</${tag}>`);
    const build = createTypesettingOutputBuilder({
      renderTypesetting: input => readyResult(input.presentation, html),
      inlineCss: inlineRequiredImageStyles,
      themeCss: ''
    });
    const bundle = await build(outputRequest());
    const $ = load(bundle.clipboard.html.content, null, false);
    assert.equal($(`section ${tag}`).length > 0 || (tag === 'section' && $('section').length === 1), true, tag);
  }

  for (const href of ['http://example.com/a', 'https://reader:secret@example.com/a', 'mailto:user@example.com', '../relative', '#fragment']) {
    const build = createTypesettingOutputBuilder({
      renderTypesetting: input => readyResult(input.presentation, `<a href="${href}">链接</a>`),
      inlineCss: html => html,
      themeCss: ''
    });
    const bundle = await build(outputRequest());
    assert.equal(load(bundle.clipboard.html.content, null, false)('a').attr('href'), href);
  }

  for (const href of ['java\nscript:alert(1)', 'java<!-- -->script:alert(1)', '//evil.example/a', '\\\\evil.example/a', 'ftp://example.com/a']) {
    const build = createTypesettingOutputBuilder({
      renderTypesetting: input => readyResult(input.presentation, `<a href="${href}">链接</a>`),
      inlineCss: html => html,
      themeCss: ''
    });
    await assertOutputError(build(outputRequest()), 'OUTPUT_GENERATION_FAILED');
  }

  for (const span of ['many', '0', '-2', '007', '999999999999999999999']) {
    const html = `<table><tbody><tr><th colspan="${span}">甲</th><td rowspan="${span}">乙</td></tr></tbody></table>`;
    const build = createTypesettingOutputBuilder({
      renderTypesetting: input => readyResult(input.presentation, html),
      inlineCss: value => value,
      themeCss: ''
    });
    const $ = load((await build(outputRequest())).clipboard.html.content, null, false);
    assert.equal($('th').attr('colspan'), span);
    assert.equal($('td').attr('rowspan'), span);
  }

  const failures = [
    () => { throw new Error('juice sentinel /Users/private/file.css'); },
    () => Promise.reject(new Error('juice rejected sentinel')),
    () => null,
    html => html.replace('<section ', '<video></video><section '),
    html => html.replace('<section ', '<section onclick="evil()" '),
    html => html.replace('<section ', '<section data-extra="evil" '),
    html => html.replace('<section ', '<section style="position:absolute" '),
    html => html.replace('<section ', '<section style="width:calc(evil)" '),
    html => `${html}<!-- sanitizer drift -->`
  ];
  for (const inlineCss of failures) {
    const build = createTypesettingOutputBuilder({
      renderTypesetting: input => readyResult(input.presentation, '<p>正文</p>'),
      inlineCss,
      themeCss: ''
    });
    await assertOutputError(build(outputRequest()), 'OUTPUT_GENERATION_FAILED');
  }
});

test('style value 按 property 拒绝错配关键字隐藏内容和非有限巨大长度', async () => {
  const { buildTypesettingOutput, createTypesettingOutputBuilder } = await loadOutputModule();
  const hugeLength = `${'9'.repeat(400)}px`;
  for (const style of [
    'width:block',
    'color:auto',
    'display:none',
    `width:${hugeLength}`,
    `width:calc(1px * ${'9'.repeat(400)})`,
    'font-size:999px',
    'font-weight:bold',
    'white-space:pre',
    'margin:-1000px',
    'padding:1000px',
    'border:100px dashed #fff',
    'display:block'
  ]) {
    const build = createTypesettingOutputBuilder({
      renderTypesetting: input => readyResult(input.presentation, '<p>正文</p>'),
      inlineCss: html => html.replace('<p>', `<p style="${style}">`),
      themeCss: ''
    });
    await assertOutputError(build(outputRequest()), 'OUTPUT_GENERATION_FAILED');
  }
  for (const [html, styled] of [
    ['<h2>正文</h2>', '<h2 style="text-align:center">'],
    ['<h1>正文</h1>', '<h1 style="padding:12px">'],
    ['<strong>正文</strong>', '<strong style="color:#0F4C81">']
  ]) {
    const tagName = /^<([a-z0-9]+)/iu.exec(html)[1];
    const build = createTypesettingOutputBuilder({
      renderTypesetting: input => readyResult(input.presentation, html),
      inlineCss: value => value.replace(`<${tagName}>`, styled),
      themeCss: ''
    });
    await assertOutputError(build(outputRequest()), 'OUTPUT_GENERATION_FAILED');
  }

  const primaryColors = ['#0F4C81', '#009874', '#FA5151', '#FECE00', '#92617E', '#55C9EA', '#B76E79', '#556B2F', '#333333', '#A9A9A9', '#FFB7C5'];
  const fontSizes = ['14px', '15px', '16px', '17px', '18px'];
  const lineHeights = ['1.5', '1.65', '1.75', '1.9', '2.05'];
  const blockSpacings = ['0.75', '0.9', '1', '1.15', '1.35'];
  const themeCoverageBody = [
    '# 一级标题', '## 二级标题', '### 三级标题', '正文 [链接](https://example.com) 和 `代码`',
    '- 无序列表', '1. 有序列表', '> 引用', '```text\n预格式\n```', '---',
    '| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |', '![图](https://images.example/theme.png)'
  ].join('\n\n');
  let combinations = 0;
  for (const theme of ['default', 'grace', 'simple']) {
    for (const primaryColor of primaryColors) {
      for (const fontSize of fontSizes) {
        for (const lineHeight of lineHeights) {
          for (const blockSpacing of blockSpacings) {
            const bundle = await buildTypesettingOutput(outputRequest({
              presentation: { theme, settings: { primaryColor, fontSize, lineHeight, blockSpacing } },
              document: { ...document, body: themeCoverageBody }
            }));
            assert.equal(bundle.status, 'ready');
            assert.match(bundle.clipboard.html.content, /display: block; max-width: 100%; height: auto/u);
            combinations += 1;
          }
        }
      }
    }
  }
  assert.equal(combinations, 4125);
});

test('style 校验绑定当前 presentation 并拒绝跨主题跨设置 stale 声明', async () => {
  const { createTypesettingOutputBuilder } = await loadOutputModule();
  const staleStyles = [
    {
      body: '<h1>正文</h1>',
      mutate: html => html.replace('<h1>', '<h1 style="color:#FA5151">')
    },
    {
      body: '<h1>正文</h1>',
      mutate: html => html.replace('<h1>', '<h1 style="padding-left:.6em">')
    },
    {
      body: '<p>正文</p>',
      mutate: html => html.replace(/style="[^"]*"/u, 'style="font:18px/2.05 \'PingFang SC\', \'Microsoft YaHei\', sans-serif"')
    },
    {
      body: '<h1>正文</h1>',
      mutate: html => html.replace('<h1>', '<h1 style="margin:calc(1.8em * 1.35) 0 calc(.8em * 1.35)">')
    }
  ];

  for (const { body, mutate } of staleStyles) {
    const build = createTypesettingOutputBuilder({
      renderTypesetting: input => readyResult(input.presentation, body),
      inlineCss: mutate,
      themeCss: ''
    });
    await assertOutputError(build(outputRequest()), 'OUTPUT_GENERATION_FAILED');
  }
});

test('clipboard doocs 修正、图片安全样式、边界与 plain text 共享同一修正后正文', async () => {
  const { buildTypesettingOutput, createTypesettingOutputBuilder } = await loadOutputModule();
  const nested = '<ul><li>甲<ul><li>乙</li></ul><ol><li>丙</li></ol></li></ul>';
  const nestedBuild = createTypesettingOutputBuilder({
    renderTypesetting: input => readyResult(input.presentation, nested),
    inlineCss: html => html,
    themeCss: ''
  });
  const nestedBundle = await nestedBuild(outputRequest());
  const $fullNested = load(nestedBundle.html.content);
  assert.equal($fullNested('main section > ul > li > ul').length, 1);
  assert.equal($fullNested('main section > ul > li > ol').length, 1);
  const $clipboardNested = load(nestedBundle.clipboard.html.content, null, false);
  assert.deepEqual($clipboardNested('section > ul').first().children().map((_, node) => node.tagName).get(), ['li', 'ul', 'ol']);

  const imageBundle = await buildTypesettingOutput(outputRequest({
    document: { ...document, body: '![图示](https://images.example/image.png)' }
  }));
  assert.equal(imageBundle.status, 'ready');
  for (const content of [imageBundle.clipboard.html.content, imageBundle.html.content]) {
    const $ = load(content);
    const image = $('img');
    assert.equal(image.length, 1);
    assert.match(image.attr('style'), /(?:^|;)\s*display:\s*block(?:;|$)/iu);
    assert.match(image.attr('style'), /(?:^|;)\s*max-width:\s*100%(?:;|$)/iu);
    assert.match(image.attr('style'), /(?:^|;)\s*height:\s*auto(?:;|$)/iu);
    assert.equal(image.attr('width'), undefined);
    assert.equal(image.attr('height'), undefined);
  }

  const target = 'format-target-bbbbbbbbbbbbbbbbbbbbbbbb-1';
  const failedBuild = createTypesettingOutputBuilder({
    renderTypesetting: input => readyResult(input.presentation, `<p>前</p><img src="https://secret.example/private.png" alt="  替代   文本  " referrerpolicy="no-referrer" data-image-state="pending" data-format-target="${target}"><p>后</p>`),
    inlineCss: html => html,
    themeCss: ''
  });
  const failedBundle = await failedBuild(outputRequest({ failedImageTargets: [target] }));
  const $failed = load(failedBundle.clipboard.html.content, null, false);
  assert.equal($failed('figure[role="note"] figcaption').text(), '图片加载失败。请检查图片地址后重试。 替代文本：替代 文本');
  assert.equal($failed('img').length, 0);
  assert.doesNotMatch(JSON.stringify(failedBundle), /secret\.example|private\.png/u);

  const staticTarget = 'static-placeholder';
  const staticDiagnostic = {
    id: 'diagnostic-static-image', code: 'IMAGE_MISSING_SOURCE', severity: 'advisory', message: '图片缺少来源。',
    targets: [{ kind: 'preview', id: staticTarget }]
  };
  const semanticHtml = [
    '<h2>题</h2>',
    '<p>段落   空白<br>换行 <code>内联</code> <a href="#footnote">链接<sup>[1]</sup></a></p>',
    '<ul><li>甲<ul><li>乙</li></ul></li></ul>',
    '<ol><li>一</li><li>二</li></ol>',
    '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    '<pre>  x\n y  </pre>',
    '<p><img src="https://images.example/plain.png" alt="图示" referrerpolicy="no-referrer" data-image-state="pending" data-format-target="format-target-cccccccccccccccccccccccc-1"></p>',
    `<figure class="format-image-placeholder" data-format-target="${staticTarget}" tabindex="0" role="note">图片缺少来源。请补充 HTTPS 地址。</figure>`
  ].join('');
  const plainBuild = createTypesettingOutputBuilder({
    renderTypesetting: input => readyResult(input.presentation, semanticHtml, [staticDiagnostic]),
    inlineCss: inlineRequiredImageStyles,
    themeCss: ''
  });
  const plainBundle = await plainBuild(outputRequest());
  assert.equal(plainBundle.status, 'ready');
  const plain = plainBundle.clipboard.plain.content;
  assert.match(plain, /^题\n/u);
  assert.match(plain, /段落 空白\n换行 内联 链接\[1\]/u);
  assert.match(plain, /- 甲\n  - 乙/u);
  assert.match(plain, /1\. 一\n2\. 二/u);
  assert.match(plain, /A\tB\n1\t2/u);
  assert.match(plain, /  x\n y/u);
  assert.match(plain, /\[图片：图示\]/u);
  assert.match(plain, /图片缺少来源。请补充 HTTPS 地址。/u);
  assert.equal(plain.endsWith('\n'), false);
  assert.doesNotMatch(plain, /输出标题|作者|公众号|2026-10-03|\u00a0/u);
  const $clipboard = load(plainBundle.clipboard.html.content, null, false);
  assert.equal($clipboard.root().children().length, 3);
  assert.equal($clipboard.root().children().first().is('p'), true);
  assert.equal($clipboard.root().children().first().text(), '\u00a0');
  assert.equal($clipboard.root().children().last().is('p'), true);
  assert.equal(load(plainBundle.html.content)('body > p').length, 0);
});

test('plain text 忽略真实块容器 DOM 缩进且保留 inline code 与行内元素空格', async () => {
  const { buildTypesettingOutput } = await loadOutputModule();
  const bundle = await buildTypesettingOutput(outputRequest({
    document: {
      ...document,
      body: [
        '> 引用 **加粗** 与 *强调*',
        '',
        '<dl>',
        '  <dt>术语 <em>A</em></dt>',
        '  <dd>解释 <code>x  y</code></dd>',
        '</dl>',
        '',
        '<figure>',
        '  <figcaption>图注 <strong>B</strong></figcaption>',
        '</figure>'
      ].join('\n')
    }
  }));
  const plain = bundle.clipboard.plain.content;

  assert.equal(bundle.status, 'ready');
  assert.equal(plain, ['引用 加粗 与 强调', '', '术语 A', '解释 x  y', '', '图注 B'].join('\n'));
  assert.doesNotMatch(plain, /(^|\n) /u);
});

test('生产 builder 将 menu 及混合嵌套 menu ul ol 输出为有层级的无序列表', async () => {
  const { buildTypesettingOutput } = await loadOutputModule();
  const cases = [
    {
      body: '<menu><li>甲</li><li>乙</li></menu>',
      expected: ['- 甲', '- 乙'].join('\n')
    },
    {
      body: [
        '<menu>',
        '  <li>甲',
        '    <menu><li>乙</li><li>丙<ol><li>丁</li></ol></li></menu>',
        '    <ul><li>戊</li></ul>',
        '    <ol><li>己</li></ol>',
        '  </li>',
        '  <li>庚</li>',
        '</menu>'
      ].join('\n'),
      expected: ['- 甲', '  - 乙', '  - 丙', '    1. 丁', '  - 戊', '  1. 己', '- 庚'].join('\n')
    }
  ];

  for (const { body, expected } of cases) {
    const bundle = await buildTypesettingOutput(outputRequest({ document: { ...document, body } }));
    assert.equal(bundle.status, 'ready');
    assert.equal(bundle.clipboard.plain.content, expected);
  }
});

test('生产 builder 在 table tab 行前保留一次 caption 的 inline br 与空白语义', async () => {
  const { buildTypesettingOutput } = await loadOutputModule();
  const bundle = await buildTypesettingOutput(outputRequest({
    document: {
      ...document,
      body: '<table><caption>季度   <strong>汇总</strong><br>第二   行</caption><tbody><tr><th>项目</th><th>数量</th></tr><tr><td>甲</td><td>2</td></tr></tbody></table>'
    }
  }));

  assert.equal(bundle.status, 'ready');
  assert.equal(bundle.clipboard.plain.content, ['季度 汇总', '第二 行', '项目\t数量', '甲\t2'].join('\n'));
});

test('plain text 将块容器中行内语义兄弟间的换行空白保留为单个空格', async () => {
  const { buildTypesettingOutput } = await loadOutputModule();
  const bundle = await buildTypesettingOutput(outputRequest({
    document: {
      ...document,
      body: [
        '<blockquote>',
        '  <strong>甲</strong>',
        '  <em>乙</em>',
        '</blockquote>',
        '<dl>',
        '  <dt><strong>丙</strong>',
        '  <em>丁</em></dt>',
        '  <dd><span>戊</span>',
        '  <i>己</i></dd>',
        '</dl>',
        '<figure>',
        '  <figcaption><b>庚</b>',
        '  <small>辛</small></figcaption>',
        '</figure>'
      ].join('\n')
    }
  }));

  assert.equal(bundle.status, 'ready');
  assert.equal(bundle.clipboard.plain.content, ['甲 乙', '丙 丁', '戊 己', '', '庚 辛'].join('\n'));
});

test('plain text 去除可见结构文本的换行缩进并保留内部与 inline 空格', async () => {
  const { buildTypesettingOutput } = await loadOutputModule();
  const indentationCases = [
    ['<p>\n  段落\n</p>', '段落'],
    ['<h1>\n  一级标题\n</h1>', '一级标题'],
    ['<h2>\n  二级标题\n</h2>', '二级标题'],
    ['<address>\n  地址\n</address>', '地址'],
    ['<blockquote>\n  引用\n</blockquote>', '引用'],
    ['<dl><dt>\n  术语\n</dt></dl>', '术语'],
    ['<dl><dd>\n  解释\n</dd></dl>', '解释'],
    ['<figure><figcaption>\n  图注\n</figcaption></figure>', '图注']
  ];

  for (const [body, expected] of indentationCases) {
    const bundle = await buildTypesettingOutput(outputRequest({ document: { ...document, body } }));
    assert.equal(bundle.status, 'ready');
    assert.equal(bundle.clipboard.plain.content, expected);
  }

  const internal = await buildTypesettingOutput(outputRequest({
    document: { ...document, body: '<blockquote>甲\n  乙</blockquote>' }
  }));
  assert.equal(internal.clipboard.plain.content, '甲 乙');

  const aroundInline = await buildTypesettingOutput(outputRequest({
    document: {
      ...document,
      body: '<figure><figcaption>\n  前文\n  <strong>行内</strong>\n  后文\n</figcaption></figure>'
    }
  }));
  assert.equal(aroundInline.clipboard.plain.content, '前文 行内 后文');
});

test('plain text 在 inline 与段落列表表格块边界输出 LF', async () => {
  const { buildTypesettingOutput } = await loadOutputModule();
  const bundle = await buildTypesettingOutput(outputRequest({
    document: {
      ...document,
      body: [
        '<strong>甲</strong><p>乙</p>',
        '<em>丙</em><ul><li>丁</li></ul>',
        '<span>戊</span><table><tbody><tr><td>己</td></tr></tbody></table>',
        '<p>庚</p><strong>辛</strong><p>壬</p>'
      ].join('')
    }
  }));

  assert.equal(bundle.status, 'ready');
  assert.equal(bundle.clipboard.plain.content, ['甲', '乙', '丙', '- 丁', '戊', '己', '庚', '辛', '壬'].join('\n'));
});

test('完整 HTML 有固定安全文档壳四项元信息和同一 canonical 正文', async () => {
  const { buildTypesettingOutput } = await loadOutputModule();
  const unsafeLookingDocument = {
    title: '<img src=x onerror=alert(1)>',
    author: '<script>alert(1)</script>',
    account: '公众号 & "属性"',
    publishedAt: '2026-10-03 <iframe>',
    body: '# 正文 <script>alert(1)</script>\n\n[相对链接](../article)'
  };
  const bundle = await buildTypesettingOutput(outputRequest({ document: unsafeLookingDocument }));

  assert.match(bundle.html.content, /^<!doctype html>/iu);
  assert.equal(bundle.html.mimeType, 'text/html;charset=utf-8');
  assert.equal(bundle.html.filename, '_img src=x onerror=alert(1)_.html');
  const $ = load(bundle.html.content);
  assert.equal($('html').attr('lang'), 'zh-CN');
  assert.equal($('head').children().first().is('meta[charset="utf-8"]'), true);
  assert.equal($('meta[name="viewport"]').attr('content'), 'width=device-width, initial-scale=1');
  assert.equal($('head title').text(), unsafeLookingDocument.title);
  assert.equal($('meta[http-equiv="Referrer-Policy"]').attr('content'), 'no-referrer');
  assert.equal($('meta[http-equiv="Content-Security-Policy"]').attr('content'), "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  assert.equal($('header h1').text(), unsafeLookingDocument.title);
  assert.deepEqual($('header dl dt').map((_, node) => $(node).text()).get(), ['作者', '公众号名称', '发布日期']);
  assert.deepEqual($('header dl dd').map((_, node) => $(node).text()).get(), [unsafeLookingDocument.author, unsafeLookingDocument.account, unsafeLookingDocument.publishedAt]);
  assert.equal($('main > section').length, 1);
  assert.equal($('script, link, base, form, iframe, svg, math').length, 0);
  assert.equal($('[onerror], [onclick], [target], [download], [contenteditable]').length, 0);
  assert.equal($('main a').attr('href'), '../article');
  assert.doesNotMatch(bundle.clipboard.html.content, /公众号 &|2026-10-03|<header/iu);
  assert.doesNotMatch(bundle.clipboard.plain.content, /公众号 &|2026-10-03|作者/iu);
});

test('output endpoint 只调用注入 builder 并原样返回 bundle 与 typed domain error', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-output-http-'));
  const calls = [];
  const bundle = {
    schemaVersion: 1,
    status: 'blocked',
    snapshot: outputRequest(),
    markdown: { mimeType: 'text/markdown;charset=utf-8', filename: '输出标题.md', content: 'sentinel bundle content' },
    clipboard: null,
    html: null
  };
  const typesettingOutputBuilder = async body => {
    calls.push(body);
    if (body.failure) {
      const error = new Error(`internal sentinel /Users/private/${body.failure}`);
      error.code = body.failure;
      error.status = 418;
      error.retryable = !outputHttpErrors[body.failure]?.retryable;
      throw error;
    }
    if (body.unexpected) throw new Error('unexpected sentinel /Users/private/secret.example');
    return bundle;
  };
  const server = await serve(createApp({
    dataDir: path.join(root, '.data'),
    interval: 0,
    typesettingOutputBuilder,
    typesettingRenderer() {
      throw new Error('output endpoint 不应调用 typesettingRenderer');
    }
  }));

  try {
    const successBody = outputRequest({ document: { ...document, body: '原样传递正文' } });
    const success = await fetch(`${server.base}/api/typesetting/output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(successBody)
    });
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), bundle);
    assert.deepEqual(calls, [successBody]);

    for (const code of ['OUTPUT_REQUEST_INVALID', 'OUTPUT_FAILED_IMAGE_TARGET_INVALID', 'OUTPUT_GENERATION_FAILED']) {
      const response = await fetch(`${server.base}/api/typesetting/output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ failure: code })
      });
      await assertTypedOutputResponse(response, code);
    }
    const unexpected = await fetch(`${server.base}/api/typesetting/output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unexpected: true })
    });
    await assertTypedOutputResponse(unexpected, 'OUTPUT_GENERATION_FAILED');
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('transport typed error 覆盖 output guard method parser limit 并与其他 endpoint 隔离', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-output-transport-'));
  let builderCalls = 0;
  const server = await serve(createApp({
    dataDir: path.join(root, '.data'),
    interval: 0,
    typesettingOutputBuilder() {
      builderCalls += 1;
      throw new Error('transport 错误不应进入 builder sentinel');
    }
  }));
  const endpoint = `${server.base}/api/typesetting/output`;

  try {
    await assertTypedOutputResponse(await rawHttpResponse(endpoint, {
      method: 'POST',
      headers: { Host: 'evil.example', 'Content-Type': 'application/json' },
      body: '{}'
    }), 'OUTPUT_REQUEST_FORBIDDEN');

    const forbiddenRequests = [
      { headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' },
      { headers: { 'Content-Type': 'text/plain' }, body: 'sentinel /Users/private/not-json' }
    ];
    for (const init of forbiddenRequests) {
      await assertTypedOutputResponse(await fetch(endpoint, { method: 'POST', ...init }), 'OUTPUT_REQUEST_FORBIDDEN');
    }

    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await fetch(endpoint, {
        method,
        headers: method === 'DELETE' ? { Host: 'evil.example' } : undefined
      });
      await assertTypedOutputResponse(response, 'OUTPUT_METHOD_NOT_ALLOWED');
    }

    await assertTypedOutputResponse(await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"body":"sentinel /Users/private/source.md",'
    }), 'OUTPUT_JSON_INVALID');

    await assertTypedOutputResponse(await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `sentinel-${'x'.repeat(154 * 1024)}` })
    }), 'OUTPUT_REQUEST_TOO_LARGE');

    assert.equal(builderCalls, 0);

    const existingEndpoint = await fetch(`${server.base}/api/typesetting/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(existingEndpoint.status, 400);
    assert.deepEqual(await existingEndpoint.json(), { error: '排版预览请求无效' });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('transport typed error 将合法 JSON 标量交给 builder 并安全归类客户端解码错误', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-output-parser-'));
  const received = [];
  const server = await serve(createApp({
    dataDir: path.join(root, '.data'),
    interval: 0,
    typesettingOutputBuilder(value) {
      received.push(value);
      const error = new Error('builder request invalid sentinel /Users/private/source.md');
      error.code = 'OUTPUT_REQUEST_INVALID';
      throw error;
    }
  }));
  const endpoint = `${server.base}/api/typesetting/output`;

  try {
    const scalars = ['字符串', 42, true, false, null, []];
    for (const value of scalars) {
      await assertTypedOutputResponse(await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value)
      }), 'OUTPUT_REQUEST_INVALID');
    }
    assert.deepEqual(received, scalars);

    const parserFailures = [
      { headers: { 'Content-Type': 'application/json; charset=us-ascii' }, body: '{}' },
      { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'compress' }, body: '{}' },
      { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: Buffer.from('not-a-gzip-stream') }
    ];
    for (const init of parserFailures) {
      await assertTypedOutputResponse(await fetch(endpoint, { method: 'POST', ...init }), 'OUTPUT_JSON_INVALID');
    }
    assert.equal(received.length, scalars.length);

    const existingStrictParser = await fetch(`${server.base}/api/typesetting/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify('合法 JSON 标量')
    });
    assert.equal(existingStrictParser.status, 400);
    const existingError = await existingStrictParser.json();
    assert.deepEqual(Object.keys(existingError), ['error']);
    assert.equal(typeof existingError.error, 'string');
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('transport typed error 仅接受严格本机 Host authority 并继续匹配 Origin', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-output-host-'));
  let calls = 0;
  const bundle = {
    schemaVersion: 1,
    status: 'blocked',
    snapshot: {},
    markdown: { mimeType: 'text/markdown;charset=utf-8', filename: 'host.md', content: 'host' },
    clipboard: null,
    html: null
  };
  const server = await serve(createApp({
    dataDir: path.join(root, '.data'),
    interval: 0,
    typesettingOutputBuilder() {
      calls += 1;
      return bundle;
    }
  }));
  const endpoint = `${server.base}/api/typesetting/output`;

  try {
    const allowedHosts = ['localhost', 'localhost:0', 'localhost:65535', '127.0.0.1', '127.0.0.1:4318', '[::1]', '[::1]:65535'];
    for (const host of allowedHosts) {
      const response = await rawHttpResponse(endpoint, {
        method: 'POST',
        headers: { Host: host, 'Content-Type': 'application/json' },
        body: '{}'
      });
      assert.equal(response.status, 200, host);
      assert.deepEqual(await response.json(), bundle);
    }

    const matchedOrigin = await rawHttpResponse(endpoint, {
      method: 'POST',
      headers: { Host: 'localhost:4318', Origin: 'http://localhost:4318', 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(matchedOrigin.status, 200);

    const invalidHosts = [
      'localhost.evil.example',
      '127.0.0.1.evil.example',
      '[::1].evil.example',
      'localhost:4318:evil',
      '127.0.0.1:not-a-port',
      '[::1]:65536',
      'localhost:65536',
      'localhost:-1',
      'localhost:',
      'localhost@evil.example'
    ];
    for (const host of invalidHosts) {
      await assertTypedOutputResponse(await rawHttpResponse(endpoint, {
        method: 'POST',
        headers: { Host: host, 'Content-Type': 'application/json' },
        body: '{}'
      }), 'OUTPUT_REQUEST_FORBIDDEN');
    }

    await assertTypedOutputResponse(await rawHttpResponse(endpoint, {
      method: 'POST',
      headers: { Host: 'localhost:4318', Origin: 'http://localhost:4319', 'Content-Type': 'application/json' },
      body: '{}'
    }), 'OUTPUT_REQUEST_FORBIDDEN');
    assert.equal(calls, allowedHosts.length + 1);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
