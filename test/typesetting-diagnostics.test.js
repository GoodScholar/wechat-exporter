import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createTypesettingRenderer, renderTypesettingMarkdown } from '../src/typesetting-render.js';

const presentation = {
  theme: 'default',
  settings: { primaryColor: '#0F4C81', fontSize: '16px', lineHeight: '1.75', blockSpacing: '1' }
};

const input = body => ({ body, presentation, convertExternalLinksToFootnotes: false });

test('深渲染接口只返回四键 RenderResult 且 blocked 严格等价于 blocker', () => {
  const result = renderTypesettingMarkdown(input('# 标题'));

  assert.deepEqual(Object.keys(result).sort(), ['blocked', 'diagnostics', 'html', 'presentation']);
  assert.match(result.html, /<h1>标题<\/h1>/);
  assert.deepEqual(result.presentation, presentation);
  assert.equal(result.blocked, result.diagnostics.some(item => item.severity === 'blocker'));
});

test('空字符串和全空白正文返回 EMPTY_BODY 与 source 0 到 0', () => {
  for (const body of ['', ' \n\t ']) {
    const result = renderTypesettingMarkdown(input(body));
    assert.equal(result.html, '');
    assert.equal(result.blocked, true);
    assert.equal(result.diagnostics.length, 1);
    const [diagnostic] = result.diagnostics;
    assert.deepEqual(Object.keys(diagnostic).sort(), ['code', 'id', 'message', 'severity', 'targets']);
    assert.equal(diagnostic.code, 'EMPTY_BODY');
    assert.equal(diagnostic.severity, 'blocker');
    assert.ok(diagnostic.id.length > 0 && diagnostic.message.length > 0);
    assert.deepEqual(diagnostic.targets, [{ kind: 'source', start: 0, end: 0 }]);
    assert.equal(result.blocked, result.diagnostics.some(item => item.severity === 'blocker'));
  }
});

test('可控 parse 异常返回安全 RENDER_FAILED 且不泄漏异常', () => {
  const render = createTypesettingRenderer({
    parseMarkdown() {
      throw new Error('sentinel stack /Users/private/source.md');
    }
  });
  const failed = render(input('会触发失败的正文'));

  assert.equal(failed.blocked, true);
  assert.equal(failed.diagnostics.length, 1);
  const [diagnostic] = failed.diagnostics;
  assert.deepEqual(Object.keys(diagnostic).sort(), ['code', 'id', 'message', 'severity', 'targets']);
  assert.equal(diagnostic.code, 'RENDER_FAILED');
  assert.equal(diagnostic.severity, 'blocker');
  assert.ok(diagnostic.id.length > 0 && diagnostic.message.length > 0);
  assert.deepEqual(diagnostic.targets, [{ kind: 'source', start: 0, end: '会触发失败的正文'.length }]);
  assert.match(failed.html, /渲染失败/);
  assert.doesNotMatch(failed.html + JSON.stringify(failed.diagnostics), /sentinel stack|\/Users\//);
  assert.equal(failed.blocked, failed.diagnostics.some(item => item.severity === 'blocker'));

  const invalidInputs = [
    { ...input('正文'), body: 42 },
    { ...input('正文'), convertExternalLinksToFootnotes: 'false' },
    { ...input('正文'), presentation: { ...presentation, extra: true } },
    { ...input('正文'), extra: true }
  ];
  for (const invalidInput of invalidInputs) {
    assert.throws(
      () => render(invalidInput),
      error => error.status === 400 && !String(error.message).includes('sentinel')
    );
  }
});

test('parse 返回 null undefined number 或 Promise 均安全返回 RENDER_FAILED', () => {
  const parserResults = [
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['Promise', Promise.resolve('<p>异步结果</p>')]
  ];

  for (const [label, parserResult] of parserResults) {
    const render = createTypesettingRenderer({ parseMarkdown: () => parserResult });
    const result = render(input(`正文-${label}`));
    assert.equal(result.blocked, true, label);
    assert.equal(result.diagnostics.length, 1, label);
    assert.equal(result.diagnostics[0].code, 'RENDER_FAILED', label);
    assert.equal(result.diagnostics[0].severity, 'blocker', label);
    assert.match(result.html, /渲染失败/, label);
    assert.equal(result.blocked, result.diagnostics.some(item => item.severity === 'blocker'), label);
  }
});

test('多次渲染不继承 diagnostic id target 或内部状态', () => {
  const render = createTypesettingRenderer({
    parseMarkdown(body) {
      if (body.startsWith('失败')) throw new Error('internal sentinel');
      return `<p>${body}</p>`;
    }
  });

  const firstFailure = render(input('失败'));
  const success = render(input('恢复'));
  const secondFailure = render(input('失败正文更长'));

  assert.deepEqual(firstFailure.diagnostics[0].targets, [{ kind: 'source', start: 0, end: 2 }]);
  assert.deepEqual(success.diagnostics, []);
  assert.equal(success.blocked, false);
  assert.match(success.html, /恢复/);
  assert.deepEqual(secondFailure.diagnostics[0].targets, [{ kind: 'source', start: 0, end: 6 }]);
  for (const result of [firstFailure, secondFailure]) {
    assert.equal(result.diagnostics.length, 1);
    assert.equal(new Set(result.diagnostics.map(item => item.id)).size, result.diagnostics.length);
    assert.equal(result.blocked, result.diagnostics.some(item => item.severity === 'blocker'));
  }
});

test('主题校验叶子模块支持两种导入顺序且 renderer 无反向依赖', () => {
  const rendererUrl = new URL('../src/typesetting-render.js', import.meta.url);
  const typesettingUrl = new URL('../src/typesetting.js', import.meta.url);
  const presentationUrl = new URL('../src/typesetting-presentation.js', import.meta.url);
  const rendererSource = readFileSync(rendererUrl, 'utf8');

  assert.match(rendererSource, /from ['"]\.\/typesetting-presentation\.js['"]/);
  assert.doesNotMatch(rendererSource, /from ['"]\.\/typesetting\.js['"]/);

  const presentationSource = readFileSync(presentationUrl, 'utf8');
  assert.doesNotMatch(presentationSource, /^\s*import\s/m);
  assert.doesNotMatch(presentationSource, /from ['"]\.\/typesetting(?:-render)?\.js['"]/);

  for (const order of [
    [rendererUrl.href, typesettingUrl.href],
    [typesettingUrl.href, rendererUrl.href]
  ]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `for (const url of ${JSON.stringify(order)}) await import(url);`], {
      encoding: 'utf8'
    });
    assert.equal(child.status, 0, child.stderr);
  }
});
