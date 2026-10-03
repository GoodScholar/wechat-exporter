import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createTypesettingRenderer, renderTypesettingMarkdown } from '../src/typesetting-render.js';

const presentation = {
  theme: 'default',
  settings: { primaryColor: '#0F4C81', fontSize: '16px', lineHeight: '1.75', blockSpacing: '1' }
};

const input = (body, convertExternalLinksToFootnotes = false) => ({ body, presentation, convertExternalLinksToFootnotes });

function conversionDiagnostics(result, code) {
  return result.diagnostics.filter(item => item.code === code);
}

function assertPreviewTargetsAreStrictAndPresent(result, diagnostic) {
  for (const target of diagnostic.targets) {
    assert.deepEqual(Object.keys(target).sort(), ['id', 'kind']);
    assert.equal(target.kind, 'preview');
    assert.match(target.id, /^format-target-/);
    assert.match(result.html, new RegExp(`data-format-target="${target.id}"`));
  }
}

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

test('外链脚注按规范化 URL 和首次出现去重聚合全部 targets', () => {
  const body = [
    '[首次](https://example.test/path)',
    '[默认端口重复](https://example.test:443/path)',
    '[另一地址](http://other.test/article)',
    '[同地址片段](https://example.test/path#part)',
    '[邮件](mailto:reader@example.test)'
  ].join('\n\n');
  const result = renderTypesettingMarkdown(input(body, true));
  const diagnostics = conversionDiagnostics(result, 'EXTERNAL_LINK_TO_FOOTNOTE');

  assert.equal(result.blocked, false);
  assert.equal(diagnostics.length, 3);
  assert.deepEqual(diagnostics.map(item => item.meta), [
    { footnote: 1, occurrences: 2 },
    { footnote: 2, occurrences: 1 },
    { footnote: 3, occurrences: 1 }
  ]);
  assert.deepEqual(diagnostics.map(item => item.targets.length), [2, 1, 1]);
  for (const diagnostic of diagnostics) {
    assert.deepEqual(Object.keys(diagnostic).sort(), ['code', 'id', 'message', 'meta', 'severity', 'targets']);
    assert.equal(diagnostic.severity, 'conversion');
    assert.deepEqual(Object.keys(diagnostic.meta).sort(), ['footnote', 'occurrences']);
    assertPreviewTargetsAreStrictAndPresent(result, diagnostic);
  }
  assert.match(result.html, /<h4>参考链接<\/h4>/);
  assert.match(result.html, /https:\/\/example\.test\/path/);
  assert.match(result.html, /http:\/\/other\.test\/article/);
  assert.match(result.html, /https:\/\/example\.test\/path#part/);
  assert.match(result.html, /href="mailto:reader@example\.test"/);
  assert.doesNotMatch(result.html, /mailto:reader@example\.test[\s\S]*<sup>/);
});

test('链接文字等于 URL 仍生成尾注且关闭开关不改变链接或正文', () => {
  const body = 'https://bare.example/path\n\n[https://label.example/path](https://label.example/path)';
  const enabled = renderTypesettingMarkdown(input(body, true));
  const disabled = renderTypesettingMarkdown(input(body, false));

  assert.deepEqual(conversionDiagnostics(enabled, 'EXTERNAL_LINK_TO_FOOTNOTE').map(item => item.meta), [
    { footnote: 1, occurrences: 1 },
    { footnote: 2, occurrences: 1 }
  ]);
  assert.match(enabled.html, />https:\/\/bare\.example\/path<sup>\[1\]<\/sup><\/a>/);
  assert.match(enabled.html, />https:\/\/label\.example\/path<sup>\[2\]<\/sup><\/a>/);
  assert.deepEqual(disabled.diagnostics, []);
  assert.match(disabled.html, /href="https:\/\/bare\.example\/path"/);
  assert.match(disabled.html, /href="https:\/\/label\.example\/path"/);
  assert.doesNotMatch(disabled.html, /<sup>|参考链接/);
  assert.equal(body, 'https://bare.example/path\n\n[https://label.example/path](https://label.example/path)');
});

test('微信公众号文章链接只豁免严格 HTTPS 主机文章路径和无凭据端口', () => {
  const body = [
    '[文章根路径](https://mp.weixin.qq.com/s)',
    '[文章子路径](https://mp.weixin.qq.com/s/abc)',
    '[大写主机](https://MP.WEIXIN.QQ.COM/s?id=1)',
    '[显式默认端口](https://mp.weixin.qq.com:443/s?id=2)',
    '[HTTP](http://mp.weixin.qq.com/s)',
    '[其他页面](https://mp.weixin.qq.com/profile)',
    '[带凭据](https://reader:secret@mp.weixin.qq.com/s)',
    '[非默认端口](https://mp.weixin.qq.com:444/s)',
    '[子域名](https://sub.mp.weixin.qq.com/s)',
    '[伪域名](https://mp.weixin.qq.com.evil.test/s)'
  ].join('\n\n');
  const result = renderTypesettingMarkdown(input(body, true));
  const diagnostics = conversionDiagnostics(result, 'EXTERNAL_LINK_TO_FOOTNOTE');

  assert.equal(diagnostics.length, 6);
  assert.deepEqual(diagnostics.map(item => item.meta.footnote), [1, 2, 3, 4, 5, 6]);
  assert.equal(result.html.match(/data-format-target=/g)?.length, 6);
  for (const diagnostic of diagnostics) assertPreviewTargetsAreStrictAndPresent(result, diagnostic);
  assert.match(result.html, /href="https:\/\/mp\.weixin\.qq\.com\/s"/);
  assert.match(result.html, /href="https:\/\/mp\.weixin\.qq\.com\/s\/abc"/);
  assert.match(result.html, /href="https:\/\/mp\.weixin\.qq\.com\/s\?id=1"/);
  assert.match(result.html, /href="https:\/\/mp\.weixin\.qq\.com\/s\?id=2"/);
});

test('特殊内容完整规范块重建单条 conversion 且来源不进入脚注', () => {
  const body = [
    '> [特殊内容：视频] 来源：https://media.example/video',
    '> \\[特殊内容：音频\\] 来源：http://media.example/audio',
    '> [特殊内容：嵌入内容]',
    '> [特殊内容：小程序卡片]',
    '> [特殊内容：投票]'
  ].join('\n\n');
  const result = renderTypesettingMarkdown(input(body, true));
  const diagnostics = conversionDiagnostics(result, 'SPECIAL_CONTENT_PLACEHOLDER');

  assert.equal(result.blocked, false);
  assert.deepEqual(diagnostics.map(item => item.meta), [
    { type: 'video' },
    { type: 'audio' },
    { type: 'embed' },
    { type: 'mini-program' },
    { type: 'poll' }
  ]);
  assert.equal(conversionDiagnostics(result, 'EXTERNAL_LINK_TO_FOOTNOTE').length, 0);
  for (const diagnostic of diagnostics) {
    assert.deepEqual(Object.keys(diagnostic).sort(), ['code', 'id', 'message', 'meta', 'severity', 'targets']);
    assert.equal(diagnostic.severity, 'conversion');
    assert.deepEqual(Object.keys(diagnostic.meta), ['type']);
    assert.equal(diagnostic.targets.length, 1);
    assertPreviewTargetsAreStrictAndPresent(result, diagnostic);
  }
  assert.match(result.html, /href="https:\/\/media\.example\/video"/);
  assert.match(result.html, /href="http:\/\/media\.example\/audio"/);
  assert.doesNotMatch(result.html, /参考链接|<sup>/);

  const nonCanonical = renderTypesettingMarkdown(input([
    '正文中的 [特殊内容：视频] 只是普通文字。',
    '> [特殊内容：视频] 来源：https://media.example/partial\n> 额外文本',
    '> > [特殊内容：音频]'
  ].join('\n\n'), true));
  assert.equal(conversionDiagnostics(nonCanonical, 'SPECIAL_CONTENT_PLACEHOLDER').length, 0);
});

test('脚注与特殊占位经过最终清理且多次 render 编号重置', () => {
  const body = [
    '<a href="https://raw.example" data-format-target="spoof" data-evil="1" onclick="alert(1)" style="color:red">原始链接</a>',
    '[安全链接](https://safe.example/path "标题 <b>粗体</b>")',
    '> [特殊内容：视频] 来源：https://media.example/video?x=1&y=2',
    '<script>sentinel()</script>'
  ].join('\n\n');
  const first = renderTypesettingMarkdown(input(body, true));
  const second = renderTypesettingMarkdown(input('[另一个](https://second.example/path)', true));

  for (const result of [first, second]) {
    const footnotes = conversionDiagnostics(result, 'EXTERNAL_LINK_TO_FOOTNOTE');
    assert.equal(footnotes.length, 1);
    assert.deepEqual(footnotes[0].meta, { footnote: 1, occurrences: 1 });
    assert.match(result.html, /<sup>\[1\]<\/sup>/);
    assert.equal(new Set(result.diagnostics.map(item => item.id)).size, result.diagnostics.length);
    for (const diagnostic of result.diagnostics) assertPreviewTargetsAreStrictAndPresent(result, diagnostic);
  }
  assert.equal(conversionDiagnostics(first, 'SPECIAL_CONTENT_PLACEHOLDER').length, 1);
  assert.doesNotMatch(first.html, /<script|<b>|sentinel\(\)|\sonclick=|\sstyle=|data-evil|data-format-target="spoof"/i);
  assert.match(first.html, /href="https:\/\/media\.example\/video\?x=1&amp;y=2"/);
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
