import { load } from 'cheerio';
import sanitizeHtml from 'sanitize-html';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
markdown.use(gfm);
export const escapeHtml = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function normalizeUrl(value) {
  let url;
  try { url = new URL(value.replaceAll('&amp;', '&')); } catch { throw new Error('请输入完整的微信公众号文章链接'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'mp.weixin.qq.com' || url.username || url.password || url.port || !/^\/s(?:\/[\w-]+)?$/.test(url.pathname)) {
    throw new Error('仅支持 mp.weixin.qq.com/s 开头的文章链接');
  }
  if (url.pathname === '/s' && !['__biz', 'mid', 'idx', 'sn'].every(key => url.searchParams.get(key))) {
    throw new Error('文章长链接缺少必要参数，请重新复制完整链接');
  }
  const clean = new URL(`https://mp.weixin.qq.com${url.pathname}`);
  if (url.pathname === '/s') for (const key of ['__biz', 'mid', 'idx', 'sn']) clean.searchParams.set(key, url.searchParams.get(key));
  return clean.href;
}

export function parseLinks(text) {
  if (typeof text !== 'string' || text.length > 100000) throw new Error('请粘贴文章链接，每批最多 50 篇');
  const urls = new Set();
  const invalid = [];
  let duplicates = 0;
  for (const line of text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    const candidates = line.match(/https?:\/\/[^\s<>"“”]+/g) || [line];
    for (const candidate of candidates) {
      try {
        const url = normalizeUrl(candidate.replace(/[，。；、）)\]】]+$/, ''));
        if (urls.has(url)) duplicates++; else urls.add(url);
      } catch (error) { invalid.push({ value: candidate, error: error.message }); }
    }
  }
  if (urls.size > 50) throw new Error('每批最多 50 篇，请分批导出');
  return { urls: [...urls], invalid, duplicates };
}

export function parseArticle(html, url) {
  const $ = load(html);
  const body = $('#js_content');
  if (!body.length || (!body.text().trim() && !body.find('img').length)) {
    const visible = $('body').clone();
    visible.find('script, style').remove();
    const text = $('title').text() + visible.text();
    if (/账号已迁移|帐号已迁移/.test(text)) throw new Error('公众号账号已迁移，请在微信中打开文章并复制迁移后的新链接');
    if (/验证|环境异常|访问过于频繁/.test(text)) throw new Error('微信要求访问验证。请点击「浏览器验证」，完成验证后重试');
    if (/已被.*删除|内容已删除|内容无法查看|该内容已被|已被屏蔽/.test(text)) throw new Error('文章已删除或无法查看，请在微信中确认链接');
    throw new Error('未找到文章正文，可能是访问受限或暂不支持的消息类型');
  }
  const title = $('#activity-name').text().trim() || $('meta[property="og:title"]').attr('content') || $('title').text().trim() || '未命名文章';
  const account = $('#js_name').text().trim() || $('meta[property="og:article:author"]').attr('content') || '';
  const author = ($('#js_author_name_text').text() || $('#js_author_name').text() || $('#meta_content > span.rich_media_meta_text').first().text()).trim().replace(/\s+/g, ' ');
  let date = $('#publish_time').text().trim();
  if (!date) {
    const timestamp = html.match(/\b(?:var\s+)?(?:ct|create_time)\s*=\s*["']?(\d{10})/);
    if (timestamp) date = new Date(Number(timestamp[1]) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  }
  const warnings = [];
  if (body.find('iframe, video, audio, mpvoice, qqmusic, mp-common-videosnap, mp-common-mpaudio').length) warnings.push('音频、视频和互动组件不包含在离线文件中，请通过原文链接查看');
  body.find('script, style, iframe, video, audio, mpvoice, qqmusic, mp-common-videosnap, mp-common-mpaudio').remove();
  body.find('img').each((_, el) => {
    const img = $(el);
    const source = img.attr('data-src') || img.attr('src');
    if (source) { try { img.attr('src', new URL(source, url).href); } catch { img.remove(); } }
    else img.remove();
  });
  body.find('[style]').each((_, el) => {
    const style = $(el).attr('style');
    if (/url\s*\(|expression|@import|\\/i.test(style)) $(el).removeAttr('style');
  });
  const content = sanitizeHtml(body.html(), {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'section'],
    allowedAttributes: { '*': ['style'], a: ['href', 'title'], img: ['src', 'alt', 'width', 'height'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowedStyles: { '*': {
      'color': [/^[#\w\s(),.%+-]+$/], 'background-color': [/^[#\w\s(),.%+-]+$/],
      'text-align': [/^(left|right|center|justify)$/], 'font-weight': [/^(normal|bold|[1-9]00)$/],
      'font-size': [/^\d+(\.\d+)?(px|em|rem|%)$/], 'font-style': [/^(normal|italic)$/],
      'line-height': [/^[\d.]+(px|em|rem|%)?$/], 'text-decoration': [/^(underline|line-through|none)$/]
    } }
  });
  return { title, account, author, date, url, content, warnings };
}

export function renderHtml(article) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(article.title)}</title><style>
body{max-width:760px;margin:48px auto;padding:0 28px;color:#242c29;font:16px/1.85 'PingFang SC','Microsoft YaHei',sans-serif;overflow-wrap:anywhere}h1{font-size:30px;line-height:1.4}header{border-bottom:1px solid #ddd;margin-bottom:28px;padding-bottom:22px}header p,footer{color:#66716a;font-size:13px}a{color:#16724d}img{max-width:100%;height:auto}pre{white-space:pre-wrap;background:#f3f5f3;padding:16px}blockquote{border-left:3px solid #86ab96;margin-left:0;padding-left:20px;color:#56655c}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px}footer{border-top:1px solid #ddd;margin-top:36px;padding-top:16px}@media print{body{margin:0;padding:0}img,pre,tr{break-inside:avoid}h1,h2,h3{break-after:avoid}img{max-height:200mm;object-fit:contain}}
</style></head><body><header><h1>${escapeHtml(article.title)}</h1><p>${[...new Set([article.account, article.author, article.date].filter(Boolean))].map(escapeHtml).join(' / ')}</p><a href="${escapeHtml(article.url)}">查看原文</a></header><main>${article.content}</main><footer>来源：${escapeHtml(article.url)}${article.warnings.length ? '<p>' + article.warnings.map(escapeHtml).join('<br>') + '</p>' : ''}</footer></body></html>`;
}

export function renderMarkdown(article) {
  const metadata = [...new Set([article.account, article.author, article.date].filter(Boolean))].map(s => markdown.turndown(escapeHtml(s))).join(' / ');
  return `# ${markdown.turndown(escapeHtml(article.title))}\n\n${metadata}\n\n[查看原文](${article.url})\n\n${markdown.turndown(article.content)}\n${article.warnings.map(w => '\n> ' + w + '\n').join('')}`;
}
