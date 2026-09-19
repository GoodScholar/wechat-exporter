import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchFeed } from '../src/feeds.js';
import { createApp } from '../src/server.js';

async function serve(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

test('通过本地 HTTP 源读取 RSS，并限制协议、凭据、HTML、重定向和解压后体积', async () => {
  const source = await serve((req, res) => {
    if (req.url === '/feed') return res.end('<rss><channel><title>本机源</title><item><title>文章</title><link>https://mp.weixin.qq.com/s/local</link></item></channel></rss>');
    if (req.url === '/html') return res.end('<html><body>登录</body></html>');
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://example.com/feed' }); return res.end(); }
    if (req.url === '/credential-redirect') { res.writeHead(302, { location: `http://user:pass@${req.headers.host}/feed` }); return res.end(); }
    if (req.url === '/large') return res.end('<rss>' + 'x'.repeat(5 * 1024 * 1024) + '</rss>');
    res.statusCode = 404; res.end();
  });
  try {
    const feed = await fetchFeed(source.base + '/feed');
    assert.equal(feed.url, source.base + '/feed');
    assert.equal(feed.items[0].url, 'https://mp.weixin.qq.com/s/local');
    await assert.rejects(fetchFeed('file:///tmp/feed.xml'), /http|https/);
    await assert.rejects(fetchFeed('http://user:pass@127.0.0.1/feed'), /凭据|用户名/);
    await assert.rejects(fetchFeed(source.base + '/html'), /HTML|RSS/);
    await assert.rejects(fetchFeed(source.base + '/redirect'), /最终 RSS 地址/);
    await assert.rejects(fetchFeed(source.base + '/credential-redirect'), /凭据|用户名/);
    await assert.rejects(fetchFeed(source.base + '/large'), /5MiB|过大/);
    const originalTimeout = AbortSignal.timeout;
    try {
      AbortSignal.timeout = () => AbortSignal.abort();
      await assert.rejects(fetchFeed(source.base + '/feed'), /超时/);
    } finally { AbortSignal.timeout = originalTimeout; }
  } finally { await source.close(); }
});

test('RSS 预览只接受受保护的 JSON POST，并复用真实本地 HTTP 源', async () => {
  const source = await serve((req, res) => res.end('<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><title>原文</title><link href="https://mp.weixin.qq.com/s/route"/></entry></feed>'));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-feed-route-'));
  const app = createApp({ dataDir: path.join(dir, '.data'), interval: 0 });
  const appServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => appServer.once('listening', resolve));
  const base = `http://127.0.0.1:${appServer.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/feeds/preview')).status, 404);
    assert.equal((await fetch(base + '/api/feeds/preview', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.com' }, body: JSON.stringify({ url: source.base + '/feed' }) })).status, 403);
    const response = await fetch(base + '/api/feeds/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: source.base + '/feed' }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { url: source.base + '/feed', title: 'Atom', items: [{ url: 'https://mp.weixin.qq.com/s/route', title: '原文', publishedAt: null, author: '' }], skipped: 0, duplicates: 0, truncated: false });
  } finally {
    await new Promise(resolve => appServer.close(resolve));
    await source.close();
    await rm(dir, { recursive: true, force: true });
  }
});
