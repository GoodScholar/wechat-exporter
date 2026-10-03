import { load } from 'cheerio';
import sanitizeHtml from 'sanitize-html';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const imagePlaceholderMessages = Object.freeze({
  'local-binary': '本地图片不可发布。请先上传图片并替换为 HTTPS 地址。',
  'local-path': '本地路径图片不可发布。请先上传图片并替换为 HTTPS 地址。',
  'unsupported-scheme': '图片协议不受支持。请替换为 HTTPS 地址。',
  'missing-source': '图片缺少来源。请补充 HTTPS 地址。'
});
const removedTypeOrder = ['script', 'style', 'form', 'event-handler', 'unsafe-url'];
const markdownConverter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
const defaultEscape = markdownConverter.escape.bind(markdownConverter);
markdownConverter.escape = value => defaultEscape(value).replace(/\\*<\/?[a-z][^>\n]*>/gi, text => {
  const fence = '`'.repeat(Math.max(...[...text.matchAll(/`+/g)].map(match => match[0].length), 0) + 1);
  return `${fence}${text}${fence}`;
});
markdownConverter.use(gfm);
markdownConverter.addRule('block-container', {
  filter: ['div', 'section', 'article', 'main', 'header', 'footer'],
  replacement: content => `\n\n${content}\n\n`
});
markdownConverter.addRule('image-placeholder', {
  filter: node => isCanonicalImagePlaceholder(node),
  replacement: (_, node) => `\n\n> ${node.textContent}\n\n`
});

export const specialContentTypes = [
  { type: 'video', label: '视频', selector: 'video, mp-common-videosnap, [data-type="video"]' },
  { type: 'audio', label: '音频', selector: 'audio, mpvoice, qqmusic, mp-common-mpaudio, [data-type="audio"]' },
  { type: 'embed', label: '嵌入内容', selector: 'iframe, embed, object' },
  { type: 'mini-program', label: '小程序卡片', selector: 'mp-miniprogram, mp-weapp, [data-miniprogram-appid], [data-weapp-appid], [data-miniprogram]' },
  { type: 'poll', label: '投票', selector: 'mp-vote, [data-vote-id], [data-type="vote"], [class~="vote_area"]' }
];

export const richTextErrorCodes = Object.freeze({
  INVALID_RICH_TEXT: 'INVALID_RICH_TEXT',
  EMPTY_RICH_TEXT: 'EMPTY_RICH_TEXT',
  RICH_TEXT_TOO_LARGE: 'RICH_TEXT_TOO_LARGE'
});

const errors = {
  [richTextErrorCodes.INVALID_RICH_TEXT]: [400, '富文本内容无效。', '请重新复制正文后重试。'],
  [richTextErrorCodes.EMPTY_RICH_TEXT]: [422, '富文本中没有可转换的可读内容。', '请保留正文文字后重试。'],
  [richTextErrorCodes.RICH_TEXT_TOO_LARGE]: [413, '富文本内容过大，无法安全转换。', '请缩短粘贴内容后重试。']
};

export class RichTextError extends Error {
  constructor(code) {
    const [status, message, action] = errors[code] || errors[richTextErrorCodes.INVALID_RICH_TEXT];
    super(message);
    this.code = code in errors ? code : richTextErrorCodes.INVALID_RICH_TEXT;
    this.status = status;
    this.action = action;
  }

  toJSON() { return { code: this.code, message: this.message, action: this.action }; }
}

const fail = code => { throw new RichTextError(code); };
const addOnce = (items, value) => { if (!items.includes(value)) items.push(value); };
const mediaSourceRules = {
  video: [
    { selector: 'video', attributes: ['src', 'data-src', 'data-url', 'url'] },
    { selector: 'source', parent: 'video', attributes: ['src'] },
    { selector: 'mp-common-videosnap, [data-type="video"]', attributes: ['data-src', 'data-url', 'url'] }
  ],
  audio: [
    { selector: 'audio', attributes: ['src', 'data-src', 'data-url', 'url'] },
    { selector: 'source', parent: 'audio', attributes: ['src'] },
    { selector: 'mpvoice, qqmusic, mp-common-mpaudio, [data-type="audio"]', attributes: ['data-src', 'data-url', 'url'] }
  ],
  embed: [{ selector: 'iframe, embed', attributes: ['src'] }, { selector: 'object', attributes: ['data'] }],
  'mini-program': [{ selector: 'mp-miniprogram, mp-weapp, [data-miniprogram-appid], [data-weapp-appid], [data-miniprogram]', attributes: ['data-url', 'url'] }],
  poll: [{ selector: 'iframe', attributes: ['src'] }, { selector: 'mp-vote, [data-vote-id], [data-type="vote"], [class~="vote_area"]', attributes: ['data-url', 'url'] }]
};

function safeImageAlt(value) {
  const normalized = [...String(value || '').replace(/\s+/gu, ' ').trim()].slice(0, 200).join('');
  return normalized.replace(/([\\`*_[\]{}()#+.!|<>&~-])/g, '\\$1');
}

function imagePlaceholderText(reason, alt) {
  const text = `[图片占位：${reason}] ${imagePlaceholderMessages[reason]}`;
  const safeAlt = safeImageAlt(alt);
  return safeAlt ? `${text} 替代文本：${safeAlt}` : text;
}

function isCanonicalImagePlaceholder(node) {
  if (node.nodeName !== 'BLOCKQUOTE' || node.children.length !== 1 || node.firstElementChild?.nodeName !== 'P') return false;
  const text = node.textContent;
  if (/\r|\n/.test(text)) return false;
  return Object.entries(imagePlaceholderMessages).some(([reason, message]) => {
    const fixed = `[图片占位：${reason}] ${message}`;
    return text === fixed || text.startsWith(`${fixed} 替代文本：`);
  });
}

function classifyImageSource(value) {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!source) return { reason: 'missing-source' };
  if (/^(?:data|blob):/i.test(source)) return { reason: 'local-binary' };
  if (/^file:/i.test(source) || /^(?:\/(?!\/)|[a-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|\\)/i.test(source)) return { reason: 'local-path' };
  if (/^\/\//.test(source)) return { reason: 'unsupported-scheme' };
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && !url.username && !url.password ? { url: url.href } : { reason: 'unsupported-scheme' };
  } catch {
    return { reason: 'local-path' };
  }
}

function replaceImages($, downgraded) {
  $('img').each((_, element) => {
    const node = $(element);
    const classification = classifyImageSource(node.attr('src'));
    if (classification.url) {
      node.attr('src', classification.url);
      return;
    }
    const placeholder = $('<blockquote><p></p></blockquote>');
    placeholder.find('p').text(imagePlaceholderText(classification.reason, node.attr('alt')));
    node.replaceWith(placeholder);
    downgraded.push({ type: 'image', reason: classification.reason });
  });
}

function safeUrl(value, { image = false } = {}) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && (url.protocol === 'https:' || !image && url.protocol === 'http:') ? url.href : '';
  } catch { return ''; }
}

function sourceUrl($, element, type) {
  const rules = mediaSourceRules[type] || [];
  for (const node of [element, ...element.find('*').toArray().map(item => $(item))]) {
    const rule = rules.find(candidate => node.is(candidate.selector));
    if (!rule || rule.parent && !node.parents('video, audio').first().is(rule.parent)) continue;
    for (const attribute of rule.attributes) {
      const url = safeUrl(node.attr(attribute));
      if (url) return url;
    }
  }
  return undefined;
}

function candidateUrlAttributes(node) {
  const names = new Set(['href', 'src', 'action', 'poster']);
  for (const rules of Object.values(mediaSourceRules)) for (const rule of rules) if (node.is(rule.selector)) for (const name of rule.attributes) names.add(name);
  return names;
}

function replaceSpecialContent($, downgraded) {
  const candidates = $('*').toArray().map(element => {
    const node = $(element);
    const definition = specialContentTypes.find(candidate => node.is(candidate.selector));
    return { element, definition, nested: node.parents().toArray().some(parent => specialContentTypes.some(candidate => $(parent).is(candidate.selector))) };
  });
  for (const { element, definition, nested } of candidates) {
    if (!definition) continue;
    if (nested) continue;
    const node = $(element);
    const source = sourceUrl($, node, definition.type);
    const text = `[特殊内容：${definition.label}]${source ? ` 来源：${source}` : ''}`;
    const placeholder = $('<blockquote><p></p></blockquote>');
    placeholder.find('p').text(text);
    node.replaceWith(placeholder);
    downgraded.push(source ? { type: definition.type, sourceUrl: source } : { type: definition.type });
  }
}

function removeUnsafeContent($, removed) {
  $('script, style, link, meta, base, form, input, button, textarea, select, option, template').each((_, element) => {
    $(element).remove();
    addOnce(removed, $(element).is('form, input, button, textarea, select, option') ? 'form' : $(element).is('style, link') ? 'style' : 'script');
  });
  $('[style]').each((_, element) => { $(element).removeAttr('style'); addOnce(removed, 'style'); });
  $('*').each((_, element) => {
    const node = $(element);
    for (const name of Object.keys(node.attr() || {})) if (/^on/i.test(name)) {
      node.removeAttr(name);
      addOnce(removed, 'event-handler');
    }
  });
  $('*').each((_, element) => {
    const node = $(element);
    for (const name of candidateUrlAttributes(node)) {
      const value = node.attr(name);
      if (value === undefined) continue;
      const safe = safeUrl(value, { image: node.is('img') && name === 'src' });
      if (safe) node.attr(name, safe);
      else {
        addOnce(removed, 'unsafe-url');
        if (node.is('img') && name === 'src') continue;
        node.removeAttr(name);
      }
    }
  });
}

export function convertRichText(html) {
  if (typeof html !== 'string' || !html.trim()) fail(richTextErrorCodes.INVALID_RICH_TEXT);
  const $ = load(html);
  const removed = [];
  const downgraded = [];
  removeUnsafeContent($, removed);
  replaceSpecialContent($, downgraded);
  replaceImages($, downgraded);
  const block = $('body').find('p, div, section, article, main, header, footer, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, hr').length > 0;
  const safeHtml = sanitizeHtml($('body').html() || '', {
    allowedTags: ['p', 'br', 'div', 'section', 'article', 'main', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'del', 's', 'a', 'img', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    allowedAttributes: { a: ['href', 'title'], img: ['src', 'alt', 'width', 'height'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'] },
    allowedSchemes: ['https', 'http'],
    allowedSchemesByTag: { img: ['https'] },
    allowProtocolRelative: false
  });
  const result = markdownConverter.turndown(safeHtml).trim();
  if (!result) fail(richTextErrorCodes.EMPTY_RICH_TEXT);
  return { markdown: result, removed: removedTypeOrder.filter(type => removed.includes(type)), downgraded, block };
}
