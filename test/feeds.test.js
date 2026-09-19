import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed } from '../src/feeds.js';

test('解析 RSS 与 Atom，保留源顺序并规范化、去重微信公众号原文链接', () => {
  const long = 'https://mp.weixin.qq.com/s?__biz=abc&amp;mid=1&amp;idx=2&amp;sn=' + 'x'.repeat(180) + '&amp;scene=1';
  const rss = `<?xml version="1.0"?><rss><channel><title><![CDATA[订阅源]]></title>
    <item><title><![CDATA[第一篇]]></title><link>${long}</link><dc:creator xmlns:dc="urn:dc">作者甲</dc:creator><dc:date xmlns:dc="urn:dc">2026-09-18T08:00:00+08:00</dc:date></item>
    <item><title>重复</title><guid>${long}</guid></item><item><title>站外</title><link>https://example.com/a</link></item>
  </channel></rss>`;
  const parsed = parseFeed(rss, 'https://rss.example/feed.xml');
  assert.equal(parsed.title, '订阅源');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].url, 'https://mp.weixin.qq.com/s?__biz=abc&mid=1&idx=2&sn=' + 'x'.repeat(180));
  assert.equal(parsed.items[0].author, '作者甲');
  assert.equal(parsed.items[0].publishedAt, '2026-09-18T00:00:00.000Z');
  assert.equal(parsed.duplicates, 1);
  assert.equal(parsed.skipped, 1);

  const atom = `<?xml version="1.0"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>Atom 源</atom:title>
    <atom:entry><atom:title>${'标题'.repeat(300)}</atom:title><atom:link rel="alternate" href="https://mp.weixin.qq.com/s/atom-one?foo=1"/><atom:updated>2026-09-17T00:00:00Z</atom:updated><atom:author><atom:name>作者乙</atom:name></atom:author></atom:entry>
  </atom:feed>`;
  const atomParsed = parseFeed(atom, 'https://rss.example/atom.xml');
  assert.equal(atomParsed.title, 'Atom 源');
  assert.equal(atomParsed.items[0].url, 'https://mp.weixin.qq.com/s/atom-one');
  assert.equal(atomParsed.items[0].title.length, 500);
  assert.equal(atomParsed.items[0].publishedAt, '2026-09-17T00:00:00.000Z');
  assert.equal(atomParsed.items[0].author, '作者乙');
});

test('拒绝 DTD、实体声明和不属于 RSS/Atom 的内容', () => {
  assert.throws(() => parseFeed('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>', 'https://rss.example/feed.xml'), /DTD|实体/);
  assert.throws(() => parseFeed('<html><title>登录</title></html>', 'https://rss.example/feed.xml'), /RSS|Atom|订阅/);
});

test('RSS 在 link 不是微信原文时回退使用微信 guid', () => {
  const parsed = parseFeed('<rss><channel><item><title>回退</title><link>https://reader.example/article</link><guid>https://mp.weixin.qq.com/s/from-guid</guid></item></channel></rss>', 'https://rss.example/feed.xml');
  assert.deepEqual(parsed.items.map(item => item.url), ['https://mp.weixin.qq.com/s/from-guid']);
});

test('Atom 从多个 alternate 链接中选择有效的微信原文', () => {
  const parsed = parseFeed('<feed><entry><title>多链接</title><link href="https://reader.example/article"/><link rel="alternate" href="https://mp.weixin.qq.com/s/atom-valid"/></entry></feed>', 'https://rss.example/feed.xml');
  assert.deepEqual(parsed.items.map(item => item.url), ['https://mp.weixin.qq.com/s/atom-valid']);
});

test('最多返回 500 篇，继续统计扫描范围内的无效与重复条目', () => {
  const entries = Array.from({ length: 502 }, (_, index) => `<item><title>${index}</title><link>https://mp.weixin.qq.com/s/item-${index}</link></item>`).join('')
    + '<item><link>https://example.com/not-wechat</link></item><item><link>https://mp.weixin.qq.com/s/item-1</link></item>';
  const parsed = parseFeed(`<rss><channel><title>大量源</title>${entries}</channel></rss>`, 'https://rss.example/feed.xml');
  assert.equal(parsed.items.length, 500);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.skipped, 1);
  assert.equal(parsed.duplicates, 1);
});
