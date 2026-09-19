import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { load } from 'cheerio';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { fetchFeed } from '../src/feeds.js';
import { exportArticle, fetchResource } from '../src/exporter.js';
import { JobStore } from '../src/jobs.js';

const source = '<h1 id="activity-name">格式组合验收</h1><div id="js_content"><p>完整正文</p><table><tr><th>列名</th></tr><tr><td>单元格</td></tr></table><img src="https://mmbiz.qpic.cn/sample.png"></div>';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64');
const inputs = { getHtml: async () => source, getImage: async () => ({ bytes: png, mime: 'image/png' }) };
const formats = ['markdown', 'html', 'pdf'];
const filenames = { markdown: 'article.md', html: 'article.html', pdf: 'article.pdf' };

for (let bits = 1; bits < 8; bits++) {
  const selected = formats.filter((_, n) => bits & (1 << n));
  test(`格式组合 ${selected.join('+')} 生成真实文件且不混入未选择格式`, async () => {
    const result = await exportArticle('https://mp.weixin.qq.com/s/combinations', selected, inputs);
    assert.deepEqual(result.successfulFormats, selected);
    assert.deepEqual(result.failedFormats, {});
    const zip = await JSZip.loadAsync(result.archive, { checkCRC32: true });
    for (const format of formats) assert.equal(Boolean(zip.file(filenames[format])), selected.includes(format));
    assert.deepEqual(await zip.file('images/001.png').async('nodebuffer'), png);
    assert.deepEqual(JSON.parse(await zip.file('metadata.json').async('string')).successfulFormats, selected);
    if (selected.includes('markdown')) assert.match(await zip.file('article.md').async('string'), /images\/001.png/);
    if (selected.includes('html')) assert.match(await zip.file('article.html').async('string'), /data:image\/png;base64/);
    if (selected.includes('pdf')) assert.equal((await zip.file('article.pdf').async('nodebuffer')).subarray(0, 5).toString(), '%PDF-');
  });
}

test('50 篇整批导出全部落盘，重启后保持可下载且重复批次复用本地归档', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-fifty-'));
  const urls = Array.from({ length: 50 }, (_, n) => `https://mp.weixin.qq.com/s/batch${n}`);
  let calls = 0;
  let store = new JobStore(dir, (url, selected, context) => { calls++; return exportArticle(url, selected, { ...context, ...inputs, getHtml: async () => source.replace('完整正文', `正文标识：${new URL(url).pathname}`) }); }, 0);
  const idle = async () => {
    for (let n = 0; store.running && n < 1000; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.running, false);
  };
  try {
    const job = store.create([...urls, urls[0]].join('\n'), ['markdown', 'html']);
    await idle();
    assert.equal(job.duplicates, 1);
    assert.equal(calls, 50);
    assert.equal(job.items.length, 50);
    const checkArticles = async batch => {
      for (const item of batch.items) {
        assert.equal(item.status, 'success');
        const zip = await JSZip.loadAsync(await readFile(store.file(item, batch)), { checkCRC32: true });
        assert.equal(JSON.parse(await zip.file('metadata.json').async('string')).url, item.url);
        const marker = `正文标识：${new URL(item.url).pathname}`;
        assert.equal(load(await zip.file('article.html').async('string'))('main p').first().text(), marker);
        assert.ok((await zip.file('article.md').async('string')).split('\n').includes(marker));
      }
    };
    await checkArticles(job);
    store = new JobStore(dir, () => { throw new Error('不应再次抓取'); }, 0);
    assert.equal(store.list()[0].items.filter(item => item.downloadable).length, 50);
    const duplicate = store.create(urls.join('\n'), ['html', 'markdown']);
    await idle();
    assert.equal(duplicate.items.filter(item => item.status === 'success' && item.cached && item.downloadable).length, 50);
    await checkArticles(duplicate);
    assert.throws(() => store.create([...urls, 'https://mp.weixin.qq.com/s/extra'].join('\n'), ['html']), /50/);
  } finally { await idle(); await rm(dir, { recursive: true, force: true }); }
});

test('实际 Chromium 启动失败时保留 Markdown/HTML，并在恢复环境后补齐 PDF', async () => {
  const original = process.env.CHROME_PATH;
  let first;
  try {
    process.env.CHROME_PATH = path.join(os.tmpdir(), 'nonexistent-wechat-browser', 'chrome');
    first = await exportArticle('https://mp.weixin.qq.com/s/no-browser', formats, inputs);
    assert.deepEqual(first.successfulFormats, ['markdown', 'html']);
    assert.match(first.failedFormats.pdf, /Chromium/);
    assert.ok(first.archive);
  } finally {
    if (original === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = original;
  }
  const retry = await exportArticle('https://mp.weixin.qq.com/s/no-browser', ['pdf'], {
    retryInput: first.retryInput, previousArchive: first.archive,
    getHtml: async () => { throw new Error('不应重新抓取'); },
    getImage: async () => { throw new Error('不应重新下载图片'); }
  });
  assert.deepEqual(retry.successfulFormats, ['pdf']);
  assert.equal((await (await JSZip.loadAsync(retry.archive)).file('article.pdf').async('nodebuffer')).subarray(0, 5).toString(), '%PDF-');
});

test('微信资源读取拒绝越界跳转、错误状态、非图片及过大响应，允许大小边界', async t => {
  // Only the external transport is replaced; parsing, redirect checks and streaming limits remain real.
  let respond;
  t.mock.method(globalThis, 'fetch', async () => respond());
  respond = () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  await assert.rejects(fetchResource('https://mp.weixin.qq.com/s/test'), /微信地址/);
  respond = () => new Response('', { status: 302 });
  await assert.rejects(fetchResource('https://mp.weixin.qq.com/s/test'), /无效跳转/);
  respond = () => new Response('', { status: 302, headers: { location: '/s/loop' } });
  await assert.rejects(fetchResource('https://mp.weixin.qq.com/s/test'), /跳转次数/);
  respond = () => new Response('', { status: 403 });
  await assert.rejects(fetchResource('https://mp.weixin.qq.com/s/test'), /403/);
  respond = () => new Response('<html>不是图片</html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(fetchResource('https://mmbiz.qpic.cn/test', 'image'), /图片格式/);
  for (const [kind, limit] of [['article', 8], ['image', 15]]) {
    const bytes = limit * 1024 * 1024;
    respond = () => new Response(Buffer.alloc(bytes), { headers: { 'content-type': kind === 'image' ? 'image/png' : 'text/html' } });
    assert.equal((await fetchResource('https://mp.weixin.qq.com/s/test', kind)).bytes.length, bytes);
    respond = () => new Response(Buffer.alloc(bytes + 1));
    await assert.rejects(fetchResource('https://mp.weixin.qq.com/s/test', kind), /大小限制/);
  }
  await assert.rejects(fetchResource('https://mp.weixin.qq.com/s/test', 'article', { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('RSS 正常同源跳转、错误状态及 gzip 解压后容量限制', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/feed' }); return res.end(); }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    if (req.url === '/feed') return res.end('<rss><channel><title>验收源</title><item><link>https://mp.weixin.qq.com/s/feed</link></item></channel></rss>');
    if (req.url === '/gzip') { res.writeHead(200, { 'content-encoding': 'gzip' }); return res.end(gzipSync('<rss>' + 'x'.repeat(5 * 1024 * 1024) + '</rss>')); }
    res.writeHead(Number(req.url.slice(1))); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetchFeed(base + '/redirect')).items[0].url, 'https://mp.weixin.qq.com/s/feed');
    for (const [route, message] of [['/loop', /重定向次数/], ['/401', /登录/], ['/403', /登录/], ['/404', /未找到/], ['/500', /500/], ['/gzip', /5MiB/]]) await assert.rejects(fetchFeed(base + route), message);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('运行中进程被强制终止后标记中断，重启重试可恢复整批归档', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-process-crash-'));
  const moduleUrl = new URL('../src/jobs.js', import.meta.url).href;
  const script = `import {JobStore} from ${JSON.stringify(moduleUrl)};
    const store = new JobStore(${JSON.stringify(dir)}, async () => {
      process.send('running');
      await new Promise(() => {});
    }, 0);
    store.create('https://mp.weixin.qq.com/s/crash1\\nhttps://mp.weixin.qq.com/s/crash2', ['html']);
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('子进程未进入导出阶段')), 5000);
      child.once('message', () => { clearTimeout(timer); resolve(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    child.kill('SIGKILL'); await exited;
    const store = new JobStore(dir, (url, selected, context) => exportArticle(url, selected, { ...context, ...inputs }), 0);
    const job = store.list()[0];
    assert.deepEqual(job.items.map(item => item.status), ['error', 'error']);
    assert.ok(job.items.every(item => /中断/.test(item.error)));
    store.retry(job.id);
    for (let n = 0; store.running && n < 300; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.running, false);
    assert.ok(store.list()[0].items.every(item => item.status === 'success' && item.downloadable));
    for (const item of store.list()[0].items) {
      const zip = await JSZip.loadAsync(await readFile(store.file(item, job)), { checkCRC32: true });
      assert.match(await zip.file('article.html').async('string'), /完整正文/);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
});
