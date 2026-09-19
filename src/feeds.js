import { load } from 'cheerio';
import { normalizeUrl } from './article.js';

const MAX_ITEMS = 500;
const MAX_BYTES = 5 * 1024 * 1024;
const text = ($, node) => $(node).text().replace(/\s+/g, ' ').trim();
const nameOf = node => (node.name || '').split(':').at(-1).toLowerCase();
const children = (node, name) => (node.children || []).filter(child => child.type === 'tag' && nameOf(child) === name);
const first = (node, name) => children(node, name)[0];
const childText = ($, node, name) => {
  const child = first(node, name);
  return child ? text($, child) : '';
};
const title = ($, node) => (childText($, node, 'title') || '未命名文章').slice(0, 500);

function articleUrl(value, sourceUrl) {
  if (!value) return null;
  try { return normalizeUrl(new URL(value.replaceAll('&amp;', '&'), sourceUrl).href); } catch { return null; }
}

function dateValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rssItem($, item, sourceUrl) {
  const link = childText($, item, 'link');
  const guid = childText($, item, 'guid');
  const url = articleUrl(link, sourceUrl) || articleUrl(guid, sourceUrl);
  if (!url) return null;
  return {
    url,
    title: title($, item),
    publishedAt: dateValue(childText($, item, 'pubdate') || childText($, item, 'date')),
    author: childText($, item, 'author') || childText($, item, 'creator')
  };
}

function atomItem($, entry, sourceUrl) {
  const links = children(entry, 'link').filter(node => {
    const rel = ($(node).attr('rel') || '').toLowerCase();
    return !rel || rel === 'alternate';
  });
  const url = links.map(node => articleUrl($(node).attr('href'), sourceUrl)).find(Boolean);
  if (!url) return null;
  const authorNode = first(entry, 'author');
  return {
    url,
    title: title($, entry),
    publishedAt: dateValue(childText($, entry, 'published') || childText($, entry, 'updated')),
    author: authorNode ? childText($, authorNode, 'name') || text($, authorNode) : ''
  };
}

export function parseFeed(xml, sourceUrl) {
  if (typeof xml !== 'string') throw new Error('RSS 内容格式无效');
  if (/<\s*!(?:doctype|entity)\b/i.test(xml)) throw new Error('RSS 内容包含不支持的 DTD 或实体声明');
  const $ = load(xml, { xmlMode: true, decodeEntities: true });
  const root = $.root().children().toArray().find(node => node.type === 'tag');
  const rootName = root && nameOf(root);
  let feedTitle = '';
  let entries = [];
  let toItem;
  if (rootName === 'rss') {
    const channel = first(root, 'channel');
    if (!channel) throw new Error('RSS 内容缺少频道信息');
    feedTitle = title($, channel);
    entries = children(channel, 'item');
    toItem = item => rssItem($, item, sourceUrl);
  } else if (rootName === 'feed') {
    feedTitle = title($, root);
    entries = children(root, 'entry');
    toItem = entry => atomItem($, entry, sourceUrl);
  } else {
    throw new Error('返回内容不是 RSS 或 Atom 订阅源');
  }

  const urls = new Set();
  const items = [];
  let skipped = 0;
  let duplicates = 0;
  let truncated = false;
  for (const entry of entries) {
    const item = toItem(entry);
    if (!item) { skipped++; continue; }
    if (urls.has(item.url)) { duplicates++; continue; }
    urls.add(item.url);
    if (items.length === MAX_ITEMS) { truncated = true; continue; }
    items.push(item);
  }
  return { title: feedTitle, items, skipped, duplicates, truncated };
}

function sourceUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new Error('请输入不超过 4096 字符的 RSS 地址');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('请输入完整的 RSS 地址'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('RSS 地址仅支持 http 或 https');
  if (url.username || url.password) throw new Error('RSS 地址不能包含用户名或凭据');
  url.hash = '';
  return url;
}

async function readBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new Error('RSS 内容解压后超过 5MiB');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function cancelBody(response) {
  try { await response.body?.cancel(); } catch { /* 连接已关闭时无需处理 */ }
}

export async function fetchFeed(value) {
  let url = sourceUrl(value);
  const signal = AbortSignal.timeout(15_000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1' },
        signal
      });
    } catch (error) {
      if (signal.aborted || error.name === 'TimeoutError') throw new Error('读取 RSS 超时，请稍后重试');
      throw new Error('无法读取 RSS 地址，请检查网络和地址是否可访问');
    }
    if (response.status >= 300 && response.status < 400) {
      if (redirects === 3) { await cancelBody(response); throw new Error('RSS 地址重定向次数过多'); }
      const location = response.headers.get('location');
      if (!location) { await cancelBody(response); throw new Error('RSS 地址重定向无效'); }
      let next;
      try { next = sourceUrl(new URL(location, url).href); } catch (error) { await cancelBody(response); throw error; }
      if (next.origin !== url.origin) { await cancelBody(response); throw new Error('RSS 地址跳转到了其他来源，请填写最终 RSS 地址'); }
      next.hash = '';
      await cancelBody(response);
      url = next;
      continue;
    }
    if (response.status === 401 || response.status === 403) { await cancelBody(response); throw new Error('RSS 源需要登录，请确认访问权限或填写公开 RSS 地址'); }
    if (response.status === 404) { await cancelBody(response); throw new Error('未找到 RSS 地址，请检查是否填写正确'); }
    if (!response.ok) { await cancelBody(response); throw new Error(`读取 RSS 失败（HTTP ${response.status}）`); }
    if ((response.headers.get('content-type') || '').toLowerCase().includes('text/html')) { await cancelBody(response); throw new Error('RSS 地址返回了 HTML 页面，请填写最终 RSS 地址'); }
    let xml;
    try { xml = await readBody(response); } catch (error) {
      if (signal.aborted || error.name === 'TimeoutError') throw new Error('读取 RSS 超时，请稍后重试');
      if (error.message === 'RSS 内容解压后超过 5MiB') throw error;
      throw new Error('读取 RSS 内容失败，请检查网络后重试');
    }
    const parsed = parseFeed(xml, url.href);
    return { url: url.href, ...parsed };
  }
  throw new Error('RSS 地址重定向次数过多');
}
