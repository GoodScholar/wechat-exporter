import { load } from 'cheerio';
import JSZip from 'jszip';
import { normalizeUrl, parseArticle, renderHtml, renderMarkdown } from './article.js';
import { makePdf } from './browser.js';

const types = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

function allowedUrl(value, kind) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('不支持的资源地址');
  const host = url.hostname;
  const allowed = kind === 'article' ? host === 'mp.weixin.qq.com' : host === 'mp.weixin.qq.com' || /(?:^|\.)(qpic\.cn|qlogo\.cn)$/.test(host);
  if (!allowed) throw new Error('资源不是受支持的微信地址');
  url.protocol = 'https:';
  return url.href;
}

export async function fetchResource(value, kind = 'article') {
  let url = allowedUrl(value, kind);
  const signal = AbortSignal.timeout(25000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(url, { redirect: 'manual', signal, headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Referer: 'https://mp.weixin.qq.com/', 'Accept-Language': 'zh-CN,zh;q=0.9'
    } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('服务器返回了无效跳转');
      url = allowedUrl(new URL(location, url).href, kind);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`微信返回 HTTP ${response.status}，请稍后重试`); }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > (kind === 'image' ? 15 : 8) * 1024 * 1024) throw new Error('资源超过大小限制');
      chunks.push(chunk);
    }
    const mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (kind === 'image' && !types[mime]) throw new Error('图片格式不支持或服务器未返回图片');
    return { bytes: Buffer.concat(chunks), mime };
  }
  throw new Error('文章跳转次数过多，请复制最终文章链接');
}

export async function exportArticle(url, formats, { getHtml = async url => (await fetchResource(url)).bytes.toString('utf8'), getImage = url => fetchResource(url, 'image') } = {}) {
  url = normalizeUrl(url);
  const article = parseArticle(await getHtml(url), url);
  const $ = load(article.content, null, false);
  const zip = new JSZip();
  const images = new Map();
  let bytesUsed = 0;
  let index = 0;
  for (const element of $('img').toArray()) {
    const img = $(element);
    const source = img.attr('src');
    if (!images.has(source)) {
      try {
        if (bytesUsed >= 60 * 1024 * 1024 || index >= 150) throw new Error('达到单篇图片下载限制');
        const { bytes, mime } = await getImage(source);
        if (!types[mime]) throw new Error('不支持的图片格式');
        bytesUsed += bytes.length;
        const filename = `images/${String(++index).padStart(3, '0')}.${types[mime]}`;
        zip.file(filename, bytes);
        images.set(source, { filename, data: `data:${mime};base64,${bytes.toString('base64')}` });
      } catch (error) {
        article.warnings.push(`图片未下载：${source}（${error.message}）`);
        images.set(source, null);
      }
    }
    const image = images.get(source);
    if (image) img.attr('src', image.filename);
    else img.replaceWith($('<p>').text(`[图片未下载：${img.attr('alt') || source}]`));
  }
  article.content = $.html();
  if (formats.includes('markdown')) zip.file('article.md', renderMarkdown(article));
  for (const element of $('img').toArray()) {
    const img = $(element);
    const image = [...images.values()].find(value => value?.filename === img.attr('src'));
    if (image) img.attr('src', image.data);
  }
  article.content = $.html();
  const html = renderHtml(article);
  if (formats.includes('html')) zip.file('article.html', html);
  if (formats.includes('pdf')) zip.file('article.pdf', await makePdf(html));
  const { content, ...metadata } = article;
  zip.file('metadata.json', JSON.stringify(metadata, null, 2));
  return { ...metadata, imageCount: index, archive: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) };
}
