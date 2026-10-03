import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { convertRichText, RichTextError, richTextErrorCodes } from '../src/rich-text.js';
import { createApp } from '../src/server.js';

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function post(base, route, body) {
  return await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

const unsafeSpecialMediaHtml = '<object data="javascript:evil()"></object><video data-src="file:///etc/passwd" data-url="data:text/html,evil" url="javascript:evil()" poster="data:image/png;base64,abc"></video><audio data-src="javascript:evil()" data-url="file:///etc/passwd" url="data:text/html,evil" poster="javascript:evil()"></audio><div class="vote_area" data-url="data:text/html,evil" url="file:///etc/passwd" poster="javascript:evil()"></div><mp-miniprogram data-url="javascript:evil()" url="data:text/html,evil" poster="file:///etc/passwd"></mp-miniprogram>';

test('富文本转换保留语义 Markdown 且不会凭空加入文章元信息', () => {
  const result = convertRichText('<html><head><title>不应成为正文</title><style>p{color:red}</style></head><body><h1>标题</h1><p><strong>重点</strong>和<em>强调</em>，<a href="https://example.test/read">链接</a>。</p><ol><li>一</li></ol><ul><li>二</li></ul><blockquote>引用</blockquote><table><thead><tr><th>列</th></tr></thead><tbody><tr><td>值</td></tr></tbody></table><p><code>inline()</code></p><pre><code>const value = 1;</code></pre><img src="https://example.test/image.png" alt="配图"></body></html>');
  assert.match(result.markdown, /^# 标题/m);
  assert.match(result.markdown, /\*\*重点\*\*/);
  assert.match(result.markdown, /_强调_|\*强调\*/);
  assert.match(result.markdown, /\[链接\]\(https:\/\/example\.test\/read\)/);
  assert.match(result.markdown, /1\.\s+一/);
  assert.match(result.markdown, /[-*]\s+二/);
  assert.match(result.markdown, />\s*引用/);
  assert.match(result.markdown, /\|\s*列\s*\|/);
  assert.match(result.markdown, /`inline\(\)`/);
  assert.match(result.markdown, /```[\s\S]*const value = 1;/);
  assert.match(result.markdown, /!\[配图\]\(https:\/\/example\.test\/image\.png\)/);
  assert.doesNotMatch(result.markdown, /不应成为正文|<html|<head|<style/);
  assert.deepEqual(result.removed, ['style']);
  assert.deepEqual(result.downgraded, []);
});

test('富文本转换移除可执行内容和不安全 URL，但保留可读文本', () => {
  const result = convertRichText('<p onclick="alert(1)" style="color:red">安全文字<script>alert(2)</script></p><a href="javascript:alert(3)">危险链接</a><img src="data:image/png;base64,abc"><form action="https://example.test"><input value="秘密"></form><iframe src="file:///etc/passwd"></iframe>');
  assert.match(result.markdown, /安全文字/);
  assert.doesNotMatch(result.markdown, /alert|javascript:|data:|file:|秘密/i);
  assert.ok(result.removed.includes('script'));
  assert.ok(result.removed.includes('event-handler'));
  assert.ok(result.removed.includes('unsafe-url'));
  assert.ok(result.removed.includes('form'));
});

test('富文本图片按 HTTPS 本地二进制本地路径不支持协议和缺失来源分类', () => {
  const sources = [
    ['https://example.test/publishable.png', 'HTTPS'],
    ['https://user:secret@example.test/credential.png', '凭据 HTTPS'],
    ['http://example.test/insecure.png', 'HTTP'],
    ['//example.test/protocol-relative.png', '协议相对'],
    ['file:///tmp/local-file.png', 'file'],
    ['/tmp/unix-path.png', 'Unix'],
    [String.raw`C:\private\windows-path.png`, 'Windows'],
    ['./relative-path.png', '相对'],
    ['~/home-path.png', '家目录'],
    ['data:image/png;base64,LOCAL_BINARY_DATA', 'data'],
    ['blob:https://example.test/LOCAL_BINARY_BLOB', 'blob'],
    ['   ', '空来源']
  ];
  const html = sources.map(([src, alt]) => `<img src="${src}" alt="${alt}">`).join('') + '<img alt="缺失来源">';

  const result = convertRichText(html);

  assert.match(result.markdown, /!\[HTTPS\]\(https:\/\/example\.test\/publishable\.png\)/);
  assert.deepEqual(result.downgraded, [
    { type: 'image', reason: 'unsupported-scheme' },
    { type: 'image', reason: 'unsupported-scheme' },
    { type: 'image', reason: 'unsupported-scheme' },
    { type: 'image', reason: 'local-path' },
    { type: 'image', reason: 'local-path' },
    { type: 'image', reason: 'local-path' },
    { type: 'image', reason: 'local-path' },
    { type: 'image', reason: 'local-path' },
    { type: 'image', reason: 'local-binary' },
    { type: 'image', reason: 'local-binary' },
    { type: 'image', reason: 'missing-source' },
    { type: 'image', reason: 'missing-source' }
  ]);
  assert.equal(result.markdown.match(/\[\u56fe\u7247\u5360\u4f4d：local-binary\]/g)?.length, 2);
  assert.equal(result.markdown.match(/\[\u56fe\u7247\u5360\u4f4d：local-path\]/g)?.length, 5);
  assert.equal(result.markdown.match(/\[\u56fe\u7247\u5360\u4f4d：unsupported-scheme\]/g)?.length, 3);
  assert.equal(result.markdown.match(/\[\u56fe\u7247\u5360\u4f4d：missing-source\]/g)?.length, 2);
  assert.match(result.markdown, /^> \[图片占位：local-binary\] 本地图片不可发布。请先上传图片并替换为 HTTPS 地址。/m);
  assert.doesNotMatch(result.markdown, /^> \\\[图片占位：/m);
  for (const text of [
    '本地图片不可发布。请先上传图片并替换为 HTTPS 地址。',
    '本地路径图片不可发布。请先上传图片并替换为 HTTPS 地址。',
    '图片协议不受支持。请替换为 HTTPS 地址。',
    '图片缺少来源。请补充 HTTPS 地址。'
  ]) assert.match(result.markdown, new RegExp(text));
});

test('富文本图片占位保留安全截断 alt 但不泄漏来源', () => {
  const longAlt = '🙂'.repeat(205) + 'ALT_TAIL_MUST_NOT_APPEAR';
  const result = convertRichText([
    '<img src="file:///private/SECRET_FILE.png" alt="  第一行\n\t *强调* [链接]  第二行  ">',
    `<img src="data:image/png;base64,SECRET_DATA" alt="${longAlt}">`,
    '<img src="blob:https://example.test/SECRET_BLOB" alt="blob alt">',
    '<img src="https://user:SECRET_PASSWORD@example.test/private.png" alt="credential alt">',
    '<img src="http://example.test/SECRET_HTTP.png" alt="http alt">'
  ].join(''));

  assert.match(result.markdown, /替代文本：第一行 \\\*强调\\\* \\\[链接\\\] 第二行/);
  assert.match(result.markdown, new RegExp(`替代文本：${'🙂'.repeat(200)}(?!🙂)`));
  assert.doesNotMatch(result.markdown, /ALT_TAIL_MUST_NOT_APPEAR/);
  assert.deepEqual(result.downgraded, [
    { type: 'image', reason: 'local-path' },
    { type: 'image', reason: 'local-binary' },
    { type: 'image', reason: 'local-binary' },
    { type: 'image', reason: 'unsupported-scheme' },
    { type: 'image', reason: 'unsupported-scheme' }
  ]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_FILE|SECRET_DATA|SECRET_BLOB|SECRET_PASSWORD|SECRET_HTTP/);
});

test('富文本 removed 固定去重排序且现有特殊媒体结构保持严格', () => {
  const result = convertRichText('<a href="javascript:first()">安全文字</a><p onclick="first()" onmouseover="second()" style="color:red">正文</p><form><input></form><style>p{color:red}</style><script>first()</script><link rel="stylesheet" href="javascript:second()"><div data-type="video"><img src="data:image/png;base64,MEDIA_SECRET"><video src="https://example.test/movie.mp4"></video><img src="file:///private/MEDIA_PATH.png"></div>');

  assert.deepEqual(result.removed, ['script', 'style', 'form', 'event-handler', 'unsafe-url']);
  assert.deepEqual(result.downgraded, [{ type: 'video', sourceUrl: 'https://example.test/movie.mp4' }]);
  assert.equal(result.downgraded.filter(item => item.type === 'image').length, 0);
  assert.equal(result.markdown.match(/^> \\\[特殊内容：视频\\\] 来源：https:\/\/example\.test\/movie\.mp4$/gm)?.length, 1);
  assert.doesNotMatch(result.markdown, /\[图片占位：/);
  assert.doesNotMatch(JSON.stringify(result), /MEDIA_SECRET|MEDIA_PATH/);
});

test('富文本转换把所有特殊媒体降级为带安全来源的静态占位块', () => {
  const result = convertRichText('<video src="https://example.test/video.mp4"></video><audio src="https://example.test/audio.mp3"></audio><iframe src="https://example.test/embed"></iframe><mp-miniprogram data-miniprogram-appid="wx123" data-path="/pages/home"></mp-miniprogram><div class="vote_area">投票</div><video src="javascript:alert(1)"></video>');
  assert.deepEqual(result.downgraded.map(item => item.type), ['video', 'audio', 'embed', 'mini-program', 'poll', 'video']);
  for (const label of ['视频', '音频', '嵌入内容', '小程序卡片', '投票']) assert.match(result.markdown, new RegExp(`特殊内容：${label}`));
  assert.match(result.markdown, /来源：https:\/\/example\.test\/video\.mp4/);
  assert.match(result.markdown, /来源：https:\/\/example\.test\/audio\.mp3/);
  assert.match(result.markdown, /来源：https:\/\/example\.test\/embed/);
  assert.doesNotMatch(result.markdown, /javascript:/i);
  assert.equal(result.downgraded.at(-1).sourceUrl, undefined);
});

test('不可读的富文本返回稳定 typed error，不伪造空成功', () => {
  assert.throws(() => convertRichText('<script>alert(1)</script><style>body{display:none}</style>'), error => error instanceof RichTextError && error.code === 'EMPTY_RICH_TEXT' && error.status === 422);
});

test('转义的 HTML 保持为文本，常见块容器保留段落边界', () => {
  const result = convertRichText('<div>第一段</div><div>第二段</div><p>&lt;img src="https://tracker.invalid/pixel"&gt;</p>');
  assert.match(result.markdown, /第一段\s*\n\s*第二段/);
  assert.match(result.markdown, /`<img src="https:\/\/tracker\.invalid\/pixel">`/);
});

test('特殊媒体从子资源或 data 属性保留安全来源 URL', () => {
  const result = convertRichText('<video><source src="https://example.test/movie.mp4"></video><object data="https://example.test/embed"></object>');
  assert.deepEqual(result.downgraded, [
    { type: 'video', sourceUrl: 'https://example.test/movie.mp4' },
    { type: 'embed', sourceUrl: 'https://example.test/embed' }
  ]);
  assert.match(result.markdown, /来源：https:\/\/example\.test\/movie\.mp4/);
  assert.match(result.markdown, /来源：https:\/\/example\.test\/embed/);
});

test('特殊媒体来源 URL 保留命名实体样式查询参数，错误 code 由集中常量提供', () => {
  const result = convertRichText('<video src="https://example.test/v?x=1&copy=2"></video><audio><source src="https://example.test/a?x=1&not=2"></audio><object data="https://example.test/o?x=1&copy=2"></object>');
  assert.deepEqual(result.downgraded.map(item => item.sourceUrl), [
    'https://example.test/v?x=1&copy=2',
    'https://example.test/a?x=1&not=2',
    'https://example.test/o?x=1&copy=2'
  ]);
  assert.match(result.markdown, /https:\/\/example\.test\/v\?x=1&copy=2/);
  assert.match(result.markdown, /https:\/\/example\.test\/a\?x=1&not=2/);
  assert.match(result.markdown, /https:\/\/example\.test\/o\?x=1&copy=2/);
  assert.equal(richTextErrorCodes.RICH_TEXT_TOO_LARGE, 'RICH_TEXT_TOO_LARGE');
});

test('嵌套特殊媒体只输出一个有安全来源的可见占位和降级记录', () => {
  const result = convertRichText('<div class="vote_area">投票<iframe src="https://example.test/vote"></iframe></div><mp-common-videosnap><video src="https://example.test/video.mp4"></video></mp-common-videosnap><div data-type="video"><video><source src="https://example.test/source.mp4"></video></div>');
  assert.deepEqual(result.downgraded, [
    { type: 'poll', sourceUrl: 'https://example.test/vote' },
    { type: 'video', sourceUrl: 'https://example.test/video.mp4' },
    { type: 'video', sourceUrl: 'https://example.test/source.mp4' }
  ]);
  assert.equal(result.markdown.match(/\[特殊内容：/g).length, 3);
  assert.match(result.markdown, /投票[\s\S]*来源：https:\/\/example\.test\/vote/);
  assert.match(result.markdown, /视频[\s\S]*来源：https:\/\/example\.test\/video\.mp4/);
  assert.match(result.markdown, /视频[\s\S]*来源：https:\/\/example\.test\/source\.mp4/);
});

test('特殊媒体只采用匹配媒体来源并审计被替换节点内的危险内容', () => {
  const result = convertRichText('<div data-type="video" onclick="evil()"><script src="https://evil.test/payload.js"></script><a href="https://example.test/help">帮助</a><img src="https://example.test/thumbnail.jpg"><video src="https://example.test/movie.mp4"></video><iframe src="javascript:evil()"></iframe></div>');
  assert.deepEqual(result.downgraded, [{ type: 'video', sourceUrl: 'https://example.test/movie.mp4' }]);
  assert.deepEqual(result.removed, ['script', 'event-handler', 'unsafe-url']);
  assert.match(result.markdown, /来源：https:\/\/example\.test\/movie\.mp4/);
  assert.doesNotMatch(result.markdown, /evil\.test|example\.test\/(?:help|thumbnail)|javascript:/);
});

test('视频和音频只采用同类型父节点下的 source', () => {
  const result = convertRichText('<div data-type="video"><audio><source src="https://example.test/audio-first.mp3"></audio><video><source src="https://example.test/movie-fallback.mp4"></video></div><div data-type="audio"><video><source src="https://example.test/movie-first.mp4"></video><audio><source src="https://example.test/audio-fallback.mp3"></audio></div>');
  assert.deepEqual(result.downgraded, [
    { type: 'video', sourceUrl: 'https://example.test/movie-fallback.mp4' },
    { type: 'audio', sourceUrl: 'https://example.test/audio-fallback.mp3' }
  ]);
  assert.doesNotMatch(result.markdown, /audio-first|movie-first/);
});

test('特殊媒体候选 URL 属性中的危险值会被审计且不泄露', () => {
  const result = convertRichText(unsafeSpecialMediaHtml);
  assert.deepEqual(result.downgraded.map(item => item.type), ['embed', 'video', 'audio', 'poll', 'mini-program']);
  assert.equal(result.downgraded.some(item => item.sourceUrl), false);
  assert.deepEqual(result.removed, ['unsafe-url']);
  assert.doesNotMatch(result.markdown, /javascript:|data:|file:/i);
});

test('富文本转换 HTTP API 只返回转换结果，错误使用稳定结构且不保存文稿', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-rich-text-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  try {
    const before = await (await fetch(server.base + '/api/typesetting/document')).json();
    const success = await post(server.base, '/api/typesetting/rich-text', { html: '<h2>服务端标题</h2><p>正文</p>' });
    assert.equal(success.status, 200);
    assert.match((await success.json()).markdown, /## 服务端标题/);
    assert.deepEqual(await (await fetch(server.base + '/api/typesetting/document')).json(), before);
    const failed = await post(server.base, '/api/typesetting/rich-text', { html: '<script>only()</script>' });
    assert.equal(failed.status, 422);
    assert.deepEqual(await failed.json(), { error: { code: 'EMPTY_RICH_TEXT', message: '富文本中没有可转换的可读内容。', action: '请保留正文文字后重试。' } });
    assert.deepEqual(await (await fetch(server.base + '/api/typesetting/document')).json(), before);
    const escaped = await (await post(server.base, '/api/typesetting/rich-text', { html: '<p>&lt;img src="https://tracker.invalid/pixel"&gt;</p>' })).json();
    const preview = await (await post(server.base, '/api/typesetting/render', {
      body: escaped.markdown,
      theme: 'default',
      settings: { primaryColor: '#0F4C81', fontSize: '16px', lineHeight: '1.75', blockSpacing: '1' }
    })).json();
    assert.doesNotMatch(preview.html, /<img\b/i);
    assert.match(preview.html, /&lt;img/);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('富文本转换 HTTP API 覆盖恶意内容、全部特殊媒体和超限 typed error', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-rich-text-http-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  try {
    const hostile = await post(server.base, '/api/typesetting/rich-text', { html: '<p onclick="evil()">可读文字<script>evil()</script></p><a href="javascript:evil()">危险链接</a><img src="data:image/png;base64,abc"><form><input value="秘密"></form>' });
    assert.equal(hostile.status, 200);
    const hostileResult = await hostile.json();
    assert.match(hostileResult.markdown, /可读文字/);
    assert.doesNotMatch(hostileResult.markdown, /evil|javascript:|data:|秘密/i);
    assert.deepEqual(hostileResult.removed.sort(), ['event-handler', 'form', 'script', 'unsafe-url']);

    const media = await post(server.base, '/api/typesetting/rich-text', { html: '<video src="https://example.test/video"></video><audio src="https://example.test/audio"></audio><iframe src="https://example.test/embed"></iframe><mp-miniprogram></mp-miniprogram><div class="vote_area">投票</div>' });
    assert.equal(media.status, 200);
    assert.deepEqual((await media.json()).downgraded.map(item => item.type), ['video', 'audio', 'embed', 'mini-program', 'poll']);

    const empty = await post(server.base, '/api/typesetting/rich-text', { html: '<script>only()</script>' });
    assert.deepEqual(await empty.json(), { error: { code: 'EMPTY_RICH_TEXT', message: '富文本中没有可转换的可读内容。', action: '请保留正文文字后重试。' } });

    const tooLarge = await post(server.base, '/api/typesetting/rich-text', { html: 'x'.repeat(160 * 1024) });
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(await tooLarge.json(), { error: { code: 'RICH_TEXT_TOO_LARGE', message: '富文本内容过大，无法安全转换。', action: '请缩短粘贴内容后重试。' } });
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('富文本转换 HTTP API 审计特殊媒体内部危险内容且不暴露无关 URL', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-rich-text-special-media-http-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  try {
    const response = await post(server.base, '/api/typesetting/rich-text', { html: '<div data-type="video" onclick="evil()"><script src="https://evil.test/payload.js"></script><a href="https://example.test/help">帮助</a><img src="https://example.test/thumbnail.jpg"><video src="https://example.test/movie.mp4"></video><iframe src="javascript:evil()"></iframe></div>' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.downgraded, [{ type: 'video', sourceUrl: 'https://example.test/movie.mp4' }]);
    assert.deepEqual(result.removed, ['script', 'event-handler', 'unsafe-url']);
    assert.match(result.markdown, /来源：https:\/\/example\.test\/movie\.mp4/);
    assert.doesNotMatch(result.markdown, /evil\.test|example\.test\/(?:help|thumbnail)|javascript:/);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('富文本转换 HTTP API 审计特殊媒体的全部候选 URL 属性', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-rich-text-special-url-http-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  try {
    const response = await post(server.base, '/api/typesetting/rich-text', { html: unsafeSpecialMediaHtml });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.downgraded.map(item => item.type), ['embed', 'video', 'audio', 'poll', 'mini-program']);
    assert.equal(result.downgraded.some(item => item.sourceUrl), false);
    assert.deepEqual(result.removed, ['unsafe-url']);
    assert.doesNotMatch(result.markdown, /javascript:|data:|file:/i);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
