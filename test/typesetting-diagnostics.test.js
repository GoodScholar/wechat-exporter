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

function imageDiagnostics(result) {
  return result.diagnostics.filter(item => item.code.startsWith('IMAGE_'));
}

function assertStaticImageDiagnosticsAreStrictAndPresent(result) {
  const diagnostics = imageDiagnostics(result);
  assert.equal(result.blocked, false);
  assert.equal(new Set(diagnostics.map(item => item.id)).size, diagnostics.length);
  assert.equal(new Set(diagnostics.map(item => item.targets[0].id)).size, diagnostics.length);
  for (const diagnostic of diagnostics) {
    assert.deepEqual(Object.keys(diagnostic).sort(), ['code', 'id', 'message', 'severity', 'targets']);
    assert.equal(diagnostic.severity, 'advisory');
    assert.equal(diagnostic.targets.length, 1);
    assertPreviewTargetsAreStrictAndPresent(result, diagnostic);
    assert.equal(result.html.split(`data-format-target="${diagnostic.targets[0].id}"`).length - 1, 1);
  }
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
  assert.match(result.html, /href="https:\/\/MP\.WEIXIN\.QQ\.COM\/s\?id=1"/);
  assert.match(result.html, /href="https:\/\/mp\.weixin\.qq\.com:443\/s\?id=2"/);
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

test('特殊内容非法来源被丢弃但仍重建占位且不进入脚注', () => {
  const body = [
    '> [特殊内容：视频] 来源：https://reader:secret@media.example/video',
    '> [特殊内容：音频] 来源：file:///Users/private/audio.mp3',
    '> [特殊内容：嵌入内容] 来源：data:text/html;base64,c2VudGluZWw=',
    '> [特殊内容：小程序卡片] 来源：',
    '> [特殊内容：投票] 来源：不是合法地址'
  ].join('\n\n');
  const result = renderTypesettingMarkdown(input(body, true));
  const diagnostics = conversionDiagnostics(result, 'SPECIAL_CONTENT_PLACEHOLDER');

  assert.deepEqual(diagnostics.map(item => item.meta), [
    { type: 'video' },
    { type: 'audio' },
    { type: 'embed' },
    { type: 'mini-program' },
    { type: 'poll' }
  ]);
  assert.equal(conversionDiagnostics(result, 'EXTERNAL_LINK_TO_FOOTNOTE').length, 0);
  assert.equal(result.html.match(/format-special-placeholder/g)?.length, 5);
  assert.doesNotMatch(result.html + JSON.stringify(result.diagnostics), /reader|secret|media\.example|file:|\/Users\/private|data:|c2VudGluZWw|不是合法地址/);
  assert.doesNotMatch(result.html, /<a\b/);
});

test('关闭脚注时保留 Marked autolink entity 和 angle URL cleanUrl 语义', () => {
  const body = '<https://example.test/?name=&copy;>\n\n[angle](<https://example.test/a b>)';
  const result = renderTypesettingMarkdown(input(body, false));

  assert.deepEqual(result.diagnostics, []);
  assert.match(result.html, /<a href="https:\/\/example\.test\/\?name=&amp;copy;">https:\/\/example\.test\/\?name=&amp;copy;<\/a>/);
  assert.match(result.html, /<a href="https:\/\/example\.test\/a%20b">angle<\/a>/);
  assert.doesNotMatch(result.html, /title=|data-format-target|<sup>|参考链接/);
});

test('开启脚注时沿用 Marked autolink 与 cleanUrl 输出后仅追加 target 和引用', () => {
  const body = '<https://example.test/?name=&copy;>\n\n[angle](<https://example.test/a b>)';
  const result = renderTypesettingMarkdown(input(body, true));
  const diagnostics = conversionDiagnostics(result, 'EXTERNAL_LINK_TO_FOOTNOTE');

  assert.deepEqual(diagnostics.map(item => item.meta), [
    { footnote: 1, occurrences: 1 },
    { footnote: 2, occurrences: 1 }
  ]);
  assert.match(result.html, /<a href="https:\/\/example\.test\/\?name=&amp;copy;" data-format-target="[^"]+">https:\/\/example\.test\/\?name=&amp;copy;<sup>\[1\]<\/sup><\/a>/);
  assert.match(result.html, /<a href="https:\/\/example\.test\/a%20b" data-format-target="[^"]+">angle<sup>\[2\]<\/sup><\/a>/);
  assert.doesNotMatch(result.html, /title=/);
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

test('Markdown 与 raw HTML 图片使用相同的严格静态分类', () => {
  const markdownImages = [
    '![md-https](https://images.example/md.png)',
    '![md-credential](https://reader:MD_SECRET@images.example/credential.png)',
    '![md-http](http://images.example/http.png)',
    '![md-protocol](//images.example/protocol.png)',
    '![md-file](file:///Users/private/MD_FILE.png)',
    '![md-unix](/Users/private/MD_UNIX.png)',
    '![md-relative](../private/MD_RELATIVE.png)',
    '![md-windows](<C:\\private\\MD_WINDOWS.png>)',
    '![md-tilde](~/private/MD_TILDE.png)',
    '![md-data](data:image/png;base64,MD_DATA_SECRET)',
    '![md-blob](blob:https://images.example/MD_BLOB_SECRET)',
    '![md-empty]()',
    '![md-other](ftp://images.example/other.png)'
  ];
  const rawImages = [
    '<img src="https://images.example/raw.png" alt="raw-https" data-format-target="format-target-spoof-1">',
    '<img src="https://reader:RAW_SECRET@images.example/credential.png" alt="raw-credential" data-format-target="format-target-spoof-1">',
    '<img src="http://images.example/http.png" alt="raw-http">',
    '<img src="//images.example/protocol.png" alt="raw-protocol">',
    '<img src="file:///Users/private/RAW_FILE.png" alt="raw-file">',
    '<img src="/Users/private/RAW_UNIX.png" alt="raw-unix">',
    '<img src="../private/RAW_RELATIVE.png" alt="raw-relative">',
    '<img src="C:\\private\\RAW_WINDOWS.png" alt="raw-windows">',
    '<img src="~/private/RAW_TILDE.png" alt="raw-tilde">',
    '<img src="data:image/png;base64,RAW_DATA_SECRET" alt="raw-data">',
    '<img src="blob:https://images.example/RAW_BLOB_SECRET" alt="raw-blob">',
    '<img src="" alt="raw-empty">',
    '<img alt="raw-missing">',
    '<img src="ftp://images.example/other.png" alt="raw-other">'
  ];
  const result = renderTypesettingMarkdown(input([...markdownImages, ...rawImages].join('\n\n')));
  const codes = imageDiagnostics(result).map(item => item.code);

  assert.deepEqual(Object.fromEntries([...new Set(codes)].sort().map(code => [code, codes.filter(value => value === code).length])), {
    IMAGE_LOCAL_BINARY: 4,
    IMAGE_LOCAL_PATH: 10,
    IMAGE_MISSING_SOURCE: 3,
    IMAGE_UNSUPPORTED_SCHEME: 8
  });
  assert.equal(result.html.match(/<img\b/g)?.length, 2);
  assert.equal(result.html.match(/<figure\b/g)?.length, 25);
  const renderedTargets = [...result.html.matchAll(/data-format-target="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(renderedTargets).size, renderedTargets.length);
  assert.doesNotMatch(result.html, /format-target-spoof-1/);
  assertStaticImageDiagnosticsAreStrictAndPresent(result);
});

test('HTTPS 及微信 HTTPS 图片保留 pending no-referrer target 且无静态错误', () => {
  const result = renderTypesettingMarkdown(input([
    '![Markdown 普通](https://images.example/a.png)',
    '![Markdown 微信](https://mmbiz.qpic.cn/mmbiz_png/a.png)',
    '![Markdown HTTP 微信](http://mmbiz.qpic.cn/mmbiz_png/MD_HTTP.png)',
    '<img src="https://images.example/raw.png" alt="Raw 普通" onerror="evil()" data-format-target="spoof">',
    '<img src="https://mmbiz.qpic.cn/mmbiz_png/raw.png" alt="Raw 微信">',
    '<img src="http://mmbiz.qpic.cn/mmbiz_png/RAW_HTTP.png" alt="Raw HTTP 微信">'
  ].join('\n\n')));
  const pending = [...result.html.matchAll(/<img\s+([^>]+)>/g)].map(match => match[1]);

  assert.equal(pending.length, 4);
  for (const attributes of pending) {
    assert.match(attributes, /src="https:\/\//);
    assert.match(attributes, /referrerpolicy="no-referrer"/);
    assert.match(attributes, /data-image-state="pending"/);
    assert.match(attributes, /data-format-target="format-target-[^"]+"/);
    assert.doesNotMatch(attributes, /onerror|spoof/);
  }
  assert.deepEqual(imageDiagnostics(result).map(item => item.code), [
    'IMAGE_UNSUPPORTED_SCHEME',
    'IMAGE_UNSUPPORTED_SCHEME'
  ]);
  assert.doesNotMatch(result.html, /src="http:\/\//);
  assertStaticImageDiagnosticsAreStrictAndPresent(result);
});

test('不可发布图片原位占位可聚焦且不泄漏来源或发起请求', () => {
  const result = renderTypesettingMarkdown(input([
    '![本地路径](file:///Users/private/SECRET_FILE.png)',
    '![本地二进制](data:image/png;base64,SECRET_BINARY)',
    '![不支持协议](http://reader:SECRET_PASSWORD@images.example/SECRET_HTTP.png)',
    '![缺失]()',
    '<img src="../private/SECRET_RELATIVE.png" alt="Raw 本地路径">',
    '<img src="blob:https://images.example/SECRET_BLOB" alt="Raw 本地二进制">',
    '<img src="//images.example/SECRET_PROTOCOL.png" alt="Raw 不支持协议">',
    '<img alt="Raw 缺失">'
  ].join('\n\n')));

  assert.equal(result.html.match(/<figure class="format-image-placeholder"/g)?.length, 8);
  assert.equal(result.html.match(/role="note"/g)?.length, 8);
  assert.equal(result.html.match(/tabindex="0"/g)?.length, 8);
  assert.doesNotMatch(result.html, /<img\b|\ssrc=|\shref=/i);
  assert.match(result.html, /本地路径图片不可发布。请先上传图片并替换为 HTTPS 地址。/);
  assert.match(result.html, /本地图片不可发布。请先上传图片并替换为 HTTPS 地址。/);
  assert.match(result.html, /图片协议不受支持。请替换为 HTTPS 地址。/);
  assert.match(result.html, /图片缺少来源。请补充 HTTPS 地址。/);
  assert.doesNotMatch(result.html + JSON.stringify(result.diagnostics), /SECRET_|\/Users\/private|reader|images\.example/);
  assertStaticImageDiagnosticsAreStrictAndPresent(result);
});

test('规范富文本图片占位刷新后重建唯一 advisory', () => {
  const result = renderTypesettingMarkdown(input([
    '> [图片占位：local-binary] 本地图片不可发布。请先上传图片并替换为 HTTPS 地址。',
    '> [图片占位：local-path] 本地路径图片不可发布。请先上传图片并替换为 HTTPS 地址。 替代文本：安全\\*图片\\*',
    '> [图片占位：unsupported-scheme] 图片协议不受支持。请替换为 HTTPS 地址。',
    '> [图片占位：missing-source] 图片缺少来源。请补充 HTTPS 地址。',
    '正文中的 [图片占位：local-binary] 本地图片不可发布。请先上传图片并替换为 HTTPS 地址。 只是文字。',
    '> [图片占位：local-path] 本地路径图片不可发布。请先上传图片并替换为 HTTPS 地址。\n> 额外文本',
    '> [图片占位：local-binary] 不完整文案',
    '> > [图片占位：missing-source] 图片缺少来源。请补充 HTTPS 地址。'
  ].join('\n\n')));

  assert.deepEqual(imageDiagnostics(result).map(item => item.code), [
    'IMAGE_LOCAL_BINARY',
    'IMAGE_LOCAL_PATH',
    'IMAGE_UNSUPPORTED_SCHEME',
    'IMAGE_MISSING_SOURCE'
  ]);
  assert.equal(result.html.match(/format-image-placeholder/g)?.length, 4);
  assert.match(result.html, /替代文本：安全\*图片\*/);
  assertStaticImageDiagnosticsAreStrictAndPresent(result);
});

test('图片 alt 折叠截断转义后仍不能突破 sanitizer', () => {
  const longAlt = `${'🙂'.repeat(205)}   \n\t尾部`;
  const result = renderTypesettingMarkdown(input([
    `<img src="data:image/png;base64,ALT_SECRET" alt="${longAlt}">`,
    '<img src="file:///private/ALT_PATH.png" alt="   \n\t  ">',
    '<img src="http://images.example/ALT_HTTP.png" alt="&quot;&gt;&lt;script&gt;ALT_XSS&lt;/script&gt;&lt;img src=x onerror=evil()&gt;">',
    '![Markdown \\*alt\\* \\[x\\] \\<tag\\>](blob:https://images.example/ALT_BLOB)'
  ].join('\n\n')));

  assert.equal((result.html.match(/🙂/g) || []).length, 200);
  assert.doesNotMatch(result.html, /🙂{201}/u);
  assert.equal(result.html.match(/替代文本：/g)?.length, 3);
  assert.match(result.html, /&lt;script&gt;ALT_XSS&lt;\/script&gt;/);
  assert.match(result.html, /替代文本：Markdown \*alt\* \[x\] &lt;tag&gt;/);
  assert.doesNotMatch(result.html, /<(?:script|img)\b|<[^>]+\sonerror=|ALT_SECRET|ALT_PATH|ALT_HTTP|ALT_BLOB/i);
  assertStaticImageDiagnosticsAreStrictAndPresent(result);
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
