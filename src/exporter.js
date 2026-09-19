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

export async function fetchResource(value, kind = 'article', { signal } = {}) {
  let url = allowedUrl(value, kind);
  const timeout = AbortSignal.timeout(25000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal?.throwIfAborted();
    const response = await fetch(url, { redirect: 'manual', signal: requestSignal, headers: {
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
      signal?.throwIfAborted();
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

export async function exportArticle(url, formats, options = {}) {
  const { signal, onProgress, retryInput, previousArchive, getHtml = async (articleUrl, context) => (await fetchResource(articleUrl, 'article', context)).bytes.toString('utf8'), getImage = (imageUrl, context) => fetchResource(imageUrl, 'image', context), renderPdf = makePdf } = options;
  const progress = value => { signal?.throwIfAborted(); onProgress?.(value); };
  url = normalizeUrl(url);
  const zip = new JSZip();
  const images = new Map();
  let article;
  let index = 0;

  if (retryInput?.article) {
    article = structuredClone(retryInput.article);
    const oldZip = previousArchive ? await JSZip.loadAsync(previousArchive) : null;
    const $ = load(article.content, null, false);
    for (const element of $('img').toArray()) {
      const filename = $(element).attr('src');
      if (!filename?.startsWith('images/')) continue;
      if (retryInput.images?.[filename]) {
        const image = retryInput.images[filename];
        images.set(filename, image);
        zip.file(filename, Buffer.from(image.data.split(',', 2)[1], 'base64'));
        continue;
      }
      if (!oldZip?.file(filename)) continue;
      const bytes = await oldZip.file(filename).async('nodebuffer');
      const extension = filename.split('.').pop();
      const mime = Object.entries(types).find(([, value]) => value === extension)?.[0];
      if (mime) images.set(filename, { filename, data: `data:${mime};base64,${bytes.toString('base64')}` });
    }
    index = [...images.keys()].filter(name => name.startsWith('images/')).length;
  } else {
    progress({ stage: 'fetch' });
    article = parseArticle(await getHtml(url, { signal }), url);
    const $ = load(article.content, null, false);
    const elements = $('img').toArray();
    let bytesUsed = 0;
    let completed = 0;
    progress({ stage: 'images', completed, total: elements.length });
    for (const element of elements) {
      signal?.throwIfAborted();
      const img = $(element);
      const source = img.attr('src');
      if (!images.has(source)) {
        try {
          if (bytesUsed >= 60 * 1024 * 1024 || index >= 150) throw new Error('达到单篇图片下载限制');
          const { bytes, mime } = await getImage(source, { signal });
          signal?.throwIfAborted();
          if (!types[mime]) throw new Error('不支持的图片格式');
          bytesUsed += bytes.length;
          const filename = `images/${String(++index).padStart(3, '0')}.${types[mime]}`;
          zip.file(filename, bytes);
          const image = { filename, data: `data:${mime};base64,${bytes.toString('base64')}` };
          images.set(source, image);
          images.set(filename, image);
        } catch (error) {
          if (signal?.aborted || error?.name === 'AbortError') throw error;
          article.warnings.push(`图片未下载：${source}（${error.message}）`);
          images.set(source, null);
        }
      }
      const image = images.get(source);
      if (image) img.attr('src', image.filename);
      else img.replaceWith($('<p>').text(`[图片未下载：${img.attr('alt') || source}]`));
      progress({ stage: 'images', completed: ++completed, total: elements.length });
    }
    article.content = $.html();
  }

  const successfulFormats = [];
  const failedFormats = {};
  const htmlForExport = () => {
    const copy = structuredClone(article);
    const $ = load(copy.content, null, false);
    for (const element of $('img').toArray()) {
      const image = images.get($(element).attr('src'));
      if (image) $(element).attr('src', image.data);
    }
    copy.content = $.html();
    return renderHtml(copy);
  };
  let html;
  for (const format of formats) {
    try {
      progress({ stage: 'format', format });
      if (format === 'markdown') zip.file('article.md', renderMarkdown(article));
      if (format === 'html') { html ||= htmlForExport(); zip.file('article.html', html); }
      if (format === 'pdf') { html ||= htmlForExport(); zip.file('article.pdf', await renderPdf(html, { signal })); }
      successfulFormats.push(format);
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      failedFormats[format] = error.message || `${format} 导出失败`;
    }
  }
  const { content, ...metadata } = article;
  if (successfulFormats.length) {
    zip.file('metadata.json', JSON.stringify({ ...metadata, successfulFormats, failedFormats }, null, 2));
  }
  progress({ stage: 'archive' });
  return {
    ...metadata,
    imageCount: index,
    successfulFormats,
    failedFormats,
    retryInput: { article, images: Object.fromEntries([...images.entries()].filter(([name]) => name.startsWith('images/'))) },
    archive: successfulFormats.length ? await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) : undefined
  };
}
