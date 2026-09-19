import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { createApp } from '../src/server.js';
import { exportArticle } from '../src/exporter.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (base, route, body) => fetch(base + route, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

test('本机 RSS 预览不启动导出，所选微信原文复用现有队列并生成可下载 ZIP', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechat-rss-integration-'));
  const sourceRequests = [];
  const exportedUrls = [];
  const feed = createServer((req, res) => {
    sourceRequests.push(req.url);
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.end(`<?xml version="1.0" encoding="utf-8"?>
      <rss version="2.0"><channel><title>我的公众号</title><generator>Mp-We-Rss</generator>
      <item><title><![CDATA[技术 & 阅读]]></title><link>https://mp.weixin.qq.com/s/selected?scene=1</link><pubDate>Sat, 19 Sep 2026 08:00:00 +0800</pubDate><description><![CDATA[<img src="http://127.0.0.1/private">]]></description></item>
      <item><title>重复分享</title><guid>https://mp.weixin.qq.com/s/selected?scene=2</guid></item>
      <item><title>暂不导出</title><link>https://mp.weixin.qq.com/s/unselected</link></item>
      <item><title>本地阅读页</title><link>http://127.0.0.1:8001/views/article/123</link></item>
      </channel></rss>`);
  });
  const sourceBase = await listen(feed);
  const app = createApp({ dataDir: path.join(directory, '.data'), interval: 0, exporter: (url, formats, context) => {
    exportedUrls.push(url);
    return exportArticle(url, formats, { ...context, getHtml: async () => '<h1 id="activity-name">订阅导入验收</h1><div id="js_content"><p>来自所选微信原文的正文</p></div>' });
  } });
  const server = createServer(app);
  const base = await listen(server);
  try {
    const response = await post(base, '/api/feeds/preview', { url: sourceBase + '/feed/test.xml' });
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.title, '我的公众号');
    assert.deepEqual(preview.items.map(item => item.url), ['https://mp.weixin.qq.com/s/selected', 'https://mp.weixin.qq.com/s/unselected']);
    assert.equal(preview.items[0].title, '技术 & 阅读');
    assert.equal(preview.items[0].publishedAt, '2026-09-19T00:00:00.000Z');
    assert.equal(preview.duplicates, 1);
    assert.equal(preview.skipped, 1);
    assert.equal(JSON.stringify(preview).includes('/private'), false, '源中的正文和图片不应送到页面');
    assert.deepEqual(await (await fetch(base + '/api/jobs')).json(), [], '预览应等待用户勾选后才导出');
    assert.deepEqual(exportedUrls, []);

    const created = await post(base, '/api/jobs', { text: preview.items[0].url, formats: ['markdown', 'html'] });
    assert.equal(created.status, 201);
    const jobId = (await created.json()).id;
    let job;
    for (let n = 0; n < 200; n++) {
      job = (await (await fetch(base + '/api/jobs')).json()).find(item => item.id === jobId);
      if (job.items[0].status === 'success') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(job.items[0].status, 'success');
    assert.deepEqual(exportedUrls, ['https://mp.weixin.qq.com/s/selected']);
    const downloaded = await fetch(`${base}/api/items/${job.items[0].id}/download`);
    assert.equal(downloaded.status, 200);
    const zip = await JSZip.loadAsync(await downloaded.arrayBuffer());
    assert.match(await zip.file('article.md').async('string'), /来自所选微信原文的正文/);
    assert.match(await zip.file('article.html').async('string'), /https:\/\/mp.weixin.qq.com\/s\/selected/);
    assert.deepEqual(sourceRequests, ['/feed/test.xml'], '不能自动访问源内的阅读页或图片');
  } finally {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => feed.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  }
});
