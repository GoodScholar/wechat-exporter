import test from 'node:test';
import assert from 'node:assert/strict';
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
