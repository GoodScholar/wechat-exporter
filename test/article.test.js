import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, parseLinks, parseArticle, renderHtml, renderMarkdown } from '../src/article.js';

export const fixture = `<!doctype html><html><head><meta property="og:title" content="测试文章"></head><body>
<h1 id="activity-name">一篇值得保存的文章</h1><a id="js_name">阅读实验室</a>
<span id="publish_time">2026年9月19日 10:00</span>
<div id="js_content" style="display:none"><h2>第一节</h2><p>正文<strong>重点</strong>与<a href="https://example.com">参考链接</a>。</p>
<img data-src="https://mmbiz.qpic.cn/example.png" alt="配图"><pre><code>const x = 1;</code></pre>
<table><thead><tr><th>列名</th></tr></thead><tbody><tr><td>内容</td></tr></tbody></table>
<script>alert(1)</script><iframe src="http://localhost:1234"></iframe><img src="x" onerror="alert(1)">
<p style="background-image:url(http://localhost/a);color:red" onclick="evil()">安全文本</p></div></body></html>`;

test('保留文章身份参数，去掉分享参数，并拒绝非微信文章地址', () => {
  assert.equal(normalizeUrl('http://mp.weixin.qq.com/s?__biz=abc&mid=1&idx=2&sn=xyz&scene=1#rd'), 'https://mp.weixin.qq.com/s?__biz=abc&mid=1&idx=2&sn=xyz');
  for (const url of ['https://example.com/s/abc', 'https://mp.weixin.qq.com.evil.com/s/a', 'https://user@mp.weixin.qq.com/s/a', 'https://mp.weixin.qq.com:8080/s/a', 'file:///etc/passwd', 'https://mp.weixin.qq.com/']) {
    assert.throws(() => normalizeUrl(url));
  }
});

test('批量粘贴支持混合分享文本、去重，同时报告无效行', () => {
  const result = parseLinks('推荐文章 https://mp.weixin.qq.com/s/abc\nhttps://mp.weixin.qq.com/s/abc?scene=1\nhttps://example.com/a');
  assert.deepEqual(result.urls, ['https://mp.weixin.qq.com/s/abc']);
  assert.equal(result.duplicates, 1);
  assert.equal(result.invalid.length, 1);
});

test('提取正文与元数据，处理懒加载图片并移除可执行内容', () => {
  const article = parseArticle(fixture, 'https://mp.weixin.qq.com/s/abc');
  assert.equal(article.title, '一篇值得保存的文章');
  assert.equal(article.account, '阅读实验室');
  assert.match(article.date, /2026/);
  assert.match(article.content, /src="https:\/\/mmbiz.qpic.cn\/example.png"/);
  assert.doesNotMatch(article.content, /<script|<iframe|onerror|onclick|background-image|display:none/);
  assert.match(renderMarkdown(article), /## 第一节/);
  assert.match(renderMarkdown(article), /\*\*重点\*\*/);
  assert.match(renderMarkdown(article), /\| 列名 \|/);
  assert.match(renderHtml(article), /Content-Security-Policy/);
});

test('验证页面与删除页面不能被当作成功文章导出', () => {
  assert.throws(() => parseArticle('<body>环境异常，请完成验证</body>', 'https://mp.weixin.qq.com/s/abc'), /验证/);
  assert.throws(() => parseArticle('<body>该内容已被发布者删除</body>', 'https://mp.weixin.qq.com/s/abc'), /删除/);
  assert.throws(() => parseArticle('<div id="js_content"></div>', 'https://mp.weixin.qq.com/s/abc'), /正文/);
});

test('账号迁移页面给出明确提示，不被脚本中的验证字样干扰', () => {
  assert.throws(() => parseArticle('<title>账号已迁移</title><body><script>const message="验证";</script><p>账号已迁移</p></body>', 'https://mp.weixin.qq.com/s/abc'), /迁移/);
});

test('作者只读取一个节点，公众号与作者相同时只显示一次', () => {
  const html = '<a id="js_name">测试公众号</a><div id="meta_content"><span class="rich_media_meta_text"><span id="js_author_name" style="display:none">测试公众号</span><span id="js_author_name_text">测试公众号</span></span></div><div id="js_content"><p>正文</p></div>';
  const article = parseArticle(html, 'https://mp.weixin.qq.com/s/abc');
  assert.equal(article.author, '测试公众号');
  assert.equal((renderHtml(article).match(/测试公众号/g) || []).length, 1);
  assert.equal((renderMarkdown(article).match(/测试公众号/g) || []).length, 1);
});

test('清理脚本和互动内容后没有正文时，不得导出只有标题的空文章', () => {
  const html = '<h1 id="activity-name">特殊消息</h1><div id="js_content"><script>var description="只有脚本数据";</script><style>.x{color:red}</style><div><span> </span></div></div>';
  assert.throws(() => parseArticle(html, 'https://mp.weixin.qq.com/s/empty-content'), /正文|消息类型/);
});
