import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { exportArticle, fetchResource } from '../src/exporter.js';

const html = '<h1 id="activity-name">离线导出测试</h1><a id="js_name">测试公众号</a><div id="js_content"><h2>图片正文</h2><p>本地保存</p><img data-src="https://mmbiz.qpic.cn/test.png"><img data-src="https://mmbiz.qpic.cn/fail.png"></div>';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64');

test('离线包包含 Markdown 本地图片、内嵌图片 HTML、真实 PDF 和缺图提示', async () => {
  const result = await exportArticle('https://mp.weixin.qq.com/s/test', ['markdown', 'html', 'pdf'], {
    getHtml: async () => html,
    getImage: async url => {
      if (url.endsWith('fail.png')) throw new Error('连接超时');
      return { bytes: png, mime: 'image/png' };
    }
  });
  const zip = await JSZip.loadAsync(result.archive);
  assert.match(await zip.file('article.md').async('string'), /images\/001.png/);
  assert.match(await zip.file('article.html').async('string'), /data:image\/png;base64/);
  assert.equal((await zip.file('article.pdf').async('nodebuffer')).subarray(0, 5).toString(), '%PDF-');
  assert.deepEqual(await zip.file('images/001.png').async('nodebuffer'), png);
  assert.match(result.warnings.join(' '), /图片/);
  assert.match(await zip.file('article.html').async('string'), /图片未下载/);
});

test('网络读取拒绝非微信来源、私有地址和伪造域名', async () => {
  for (const url of ['http://127.0.0.1/a', 'https://localhost/a', 'https://mmbiz.qpic.cn.evil.com/a', 'https://user@mmbiz.qpic.cn/a']) {
    await assert.rejects(fetchResource(url, 'image'));
  }
});
