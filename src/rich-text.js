import { load } from 'cheerio';
import sanitizeHtml from 'sanitize-html';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

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
        node.removeAttr(name);
        addOnce(removed, 'unsafe-url');
        if (node.is('img') && name === 'src') node.remove();
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
  return { markdown: result, removed, downgraded, block };
}
