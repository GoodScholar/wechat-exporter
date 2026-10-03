import { createHmac, randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import sanitizeHtml from 'sanitize-html';
import { marked, Renderer } from 'marked';
import { normalizeTypesettingPresentation } from './typesetting-presentation.js';

const renderInputKeys = Object.freeze(['body', 'presentation', 'convertExternalLinksToFootnotes']);
const specialContentTypeByLabel = Object.freeze({
  '视频': 'video',
  '音频': 'audio',
  '嵌入内容': 'embed',
  '小程序卡片': 'mini-program',
  '投票': 'poll'
});
const imagePlaceholderMessages = Object.freeze({
  'local-binary': '本地图片不可发布。请先上传图片并替换为 HTTPS 地址。',
  'local-path': '本地路径图片不可发布。请先上传图片并替换为 HTTPS 地址。',
  'unsupported-scheme': '图片协议不受支持。请替换为 HTTPS 地址。',
  'missing-source': '图片缺少来源。请补充 HTTPS 地址。'
});
const imageDiagnosticCodeByReason = Object.freeze({
  'local-binary': 'IMAGE_LOCAL_BINARY',
  'local-path': 'IMAGE_LOCAL_PATH',
  'unsupported-scheme': 'IMAGE_UNSUPPORTED_SCHEME',
  'missing-source': 'IMAGE_MISSING_SOURCE'
});
const targetSecret = randomUUID();
const sanitizerBaseOptions = Object.freeze({
  allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'figure', 'h1', 'h2', 'span'],
  allowedAttributes: {
    a: ['href', 'title', 'data-format-target'],
    blockquote: ['class', 'data-format-target', 'tabindex', 'role'],
    figure: ['class', 'data-format-target', 'tabindex', 'role'],
    p: ['class'],
    img: ['src', 'alt', 'referrerpolicy', 'data-image-state', 'data-format-target'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
    code: ['class']
  },
  allowedClasses: {
    blockquote: ['format-special-placeholder'],
    figure: ['format-image-placeholder'],
    p: ['typeset-footnotes']
  },
  allowedSchemes: ['https', 'http', 'mailto'],
  allowedSchemesByTag: { img: ['https'] },
  allowProtocolRelative: false
});

const hasOwn = (value, key) => typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, key);
const hasExactKeys = (value, keys) => typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => hasOwn(value, key));

function invalidRenderInput(message = '排版预览请求无效') {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function normalizeRenderInput(value) {
  if (!hasExactKeys(value, renderInputKeys)) return invalidRenderInput();
  if (typeof value.body !== 'string') return invalidRenderInput('Markdown 正文必须是文本');
  if (typeof value.convertExternalLinksToFootnotes !== 'boolean') return invalidRenderInput('外链转脚注设置无效');
  return {
    body: value.body,
    presentation: normalizeTypesettingPresentation(value.presentation),
    convertExternalLinksToFootnotes: value.convertExternalLinksToFootnotes
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function normalizeImageAlt(value) {
  return [...String(value || '').replace(/\s+/gu, ' ').trim()].slice(0, 200).join('');
}

function escapeMarkdown(value) {
  return value.replace(/([\\`*_[\]{}()#+.!|<>&~-])/g, '\\$1');
}

function decodeMarkdownEscapes(value) {
  return value.replace(/\\([\\`*_[\]{}()#+.!|<>&~-])/g, '$1');
}

function classifyImageSource(value) {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!source) return { reason: 'missing-source' };
  if (/^(?:\/(?!\/)|[a-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|\\)/i.test(source)) return { reason: 'local-path' };
  if (/^\/\//.test(source)) return { reason: 'unsupported-scheme' };
  try {
    const url = new URL(source);
    if (url.protocol === 'data:' || url.protocol === 'blob:') return { reason: 'local-binary' };
    if (url.protocol === 'file:') return { reason: 'local-path' };
    if (url.protocol === 'https:' && !url.username && !url.password) return { url: url.href };
    return { reason: 'unsupported-scheme' };
  } catch {
    return { reason: 'local-path' };
  }
}

function imagePlaceholderText(reason, alt) {
  const message = imagePlaceholderMessages[reason];
  return alt ? `${message} 替代文本：${alt}` : message;
}

function imageFactHtml(fact) {
  if (fact.url) {
    const alt = fact.alt ? ` alt="${escapeHtml(fact.alt)}"` : ' alt=""';
    return `<img src="${escapeHtml(fact.url)}"${alt} referrerpolicy="no-referrer" data-image-state="pending" data-format-target="${escapeHtml(fact.target.id)}">`;
  }
  return `<figure class="format-image-placeholder" data-format-target="${escapeHtml(fact.target.id)}" tabindex="0" role="note">${escapeHtml(imagePlaceholderText(fact.reason, fact.alt))}</figure>`;
}

function normalLinkHtml({ href, title, content, targetId, footnote }) {
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
  const targetAttribute = targetId ? ` data-format-target="${escapeHtml(targetId)}"` : '';
  const reference = footnote ? `<sup>[${footnote}]</sup>` : '';
  return `<a href="${escapeHtml(href)}"${titleAttribute}${targetAttribute}>${content}${reference}</a>`;
}

function decorateMarkedLink(html, targetId) {
  const openingEnd = html.indexOf('>');
  if (!html.startsWith('<a ') || openingEnd === -1 || !html.endsWith('</a>')) {
    throw new TypeError('Marked link renderer returned an unexpected result');
  }
  return `${html.slice(0, openingEnd)} data-format-target="${escapeHtml(targetId)}"${html.slice(openingEnd)}`;
}

function parseHttpUrl(href) {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function isWeChatArticle(url) {
  return url.protocol === 'https:'
    && url.hostname === 'mp.weixin.qq.com'
    && (url.pathname === '/s' || url.pathname.startsWith('/s/'))
    && url.username === ''
    && url.password === ''
    && url.port === '';
}

function parseSpecialContent(token) {
  if (token.tokens.length !== 1 || token.tokens[0].type !== 'paragraph') return null;
  const text = token.tokens[0].text
    .replace(/^\\\[/u, '[')
    .replace(/\\\](?= 来源：|$)/u, ']');
  const match = /^\[特殊内容：(视频|音频|嵌入内容|小程序卡片|投票)\](?: 来源：(.*))?$/u.exec(text);
  if (!match) return null;

  const [, label, source] = match;
  if (!source) return { label, type: specialContentTypeByLabel[label] };
  const url = parseHttpUrl(decodeMarkdownEscapes(source));
  if (!url || url.username || url.password) return { label, type: specialContentTypeByLabel[label] };
  return { label, type: specialContentTypeByLabel[label], sourceUrl: url.href };
}

function parseCanonicalImagePlaceholder(token) {
  if (token.tokens.length !== 1 || token.tokens[0].type !== 'paragraph') return null;
  const text = token.tokens[0].text;
  if (typeof text !== 'string' || text.includes('\n') || text.includes('\r')) return null;

  for (const [reason, message] of Object.entries(imagePlaceholderMessages)) {
    const fixed = `[图片占位：${reason}] ${message}`;
    if (text === fixed) return { reason, alt: '' };
    const prefix = `${fixed} 替代文本：`;
    if (!text.startsWith(prefix)) continue;
    const rawAlt = text.slice(prefix.length);
    const alt = normalizeImageAlt(decodeMarkdownEscapes(rawAlt));
    if (alt && escapeMarkdown(alt) === rawAlt) return { reason, alt };
  }
  return null;
}

// Adapted from doocs/md@a7c17fc4cda92e3c13aa7e24f06615cfa4219b31
// buildFootnoteArray()/buildFootnotes(); output is escaped and sanitized here.
function buildFootnoteArray(footnotes) {
  return footnotes.map(({ index, title, link }) => {
    const escapedTitle = escapeHtml(title);
    const escapedLink = escapeHtml(link);
    return title === link
      ? `<code>[${index}]</code>：<i>${escapedLink}</i><br>`
      : `<code>[${index}]</code> ${escapedTitle}：<i>${escapedLink}</i><br>`;
  }).join('\n');
}

function buildFootnotes(footnotes) {
  if (footnotes.length === 0) return '';
  return `<h4>参考链接</h4><p class="typeset-footnotes">${buildFootnoteArray(footnotes)}</p>`;
}

function createSanitizerOptions(targetKinds, createImageFact) {
  const keepControlledTarget = (tagName, attributes, kind) => {
    const targetId = attributes['data-format-target'];
    if (!targetId || targetKinds.get(targetId) !== kind) delete attributes['data-format-target'];
    return { tagName, attribs: attributes };
  };

  return {
    ...sanitizerBaseOptions,
    transformTags: {
      a: (tagName, attributes) => keepControlledTarget(tagName, attributes, 'link'),
      img: (tagName, attributes) => {
        const targetId = attributes['data-format-target'];
        if (targetKinds.get(targetId) === 'image') {
          const safe = {
            src: attributes.src,
            alt: attributes.alt || '',
            referrerpolicy: 'no-referrer',
            'data-image-state': 'pending',
            'data-format-target': targetId
          };
          return { tagName, attribs: safe };
        }
        const fact = createImageFact(attributes.src, attributes.alt);
        if (fact.url) {
          return {
            tagName,
            attribs: {
              src: fact.url,
              alt: fact.alt,
              referrerpolicy: 'no-referrer',
              'data-image-state': 'pending',
              'data-format-target': fact.target.id
            }
          };
        }
        return {
          tagName: 'figure',
          attribs: {
            class: 'format-image-placeholder',
            'data-format-target': fact.target.id,
            tabindex: '0',
            role: 'note'
          },
          text: imagePlaceholderText(fact.reason, fact.alt)
        };
      },
      blockquote: (tagName, attributes) => {
        const controlled = targetKinds.get(attributes['data-format-target']) === 'special';
        if (!controlled) {
          delete attributes['data-format-target'];
          delete attributes.class;
          delete attributes.tabindex;
          delete attributes.role;
        }
        return { tagName, attribs: attributes };
      },
      figure: (tagName, attributes) => {
        const controlled = targetKinds.get(attributes['data-format-target']) === 'image-placeholder';
        if (!controlled) return { tagName, attribs: {} };
        return {
          tagName,
          attribs: {
            class: 'format-image-placeholder',
            'data-format-target': attributes['data-format-target'],
            tabindex: '0',
            role: 'note'
          }
        };
      }
    }
  };
}

function createDiagnosticFactory() {
  let nextId = 1;
  return ({ code, severity = 'blocker', message, targets, meta }) => {
    const diagnostic = { id: `diagnostic-${nextId++}`, code, severity, message, targets };
    if (meta !== undefined) diagnostic.meta = meta;
    return diagnostic;
  };
}

function toRenderResult({ html, presentation, diagnostics }) {
  return {
    html,
    presentation,
    diagnostics,
    blocked: diagnostics.some(item => item.severity === 'blocker')
  };
}

const defaultParseMarkdown = (body, options) => marked.parse(body, options);

export function createTypesettingRenderer({ parseMarkdown = defaultParseMarkdown } = {}) {
  if (typeof parseMarkdown !== 'function') throw new TypeError('parseMarkdown 必须是函数');

  return function renderTypesettingMarkdown(value) {
    const { body, presentation, convertExternalLinksToFootnotes } = normalizeRenderInput(value);
    const createDiagnostic = createDiagnosticFactory();

    if (!body.trim()) {
      return toRenderResult({
        html: '',
        presentation,
        diagnostics: [createDiagnostic({
          code: 'EMPTY_BODY',
          message: '正文为空，请输入需要排版的内容。',
          targets: [{ kind: 'source', start: 0, end: 0 }]
        })]
      });
    }

    try {
      const diagnostics = [];
      const footnotes = [];
      const footnoteByUrl = new Map();
      const targetKinds = new Map();
      const linkTitleByTarget = new Map();
      const targetNonce = createHmac('sha256', targetSecret).update(body).digest('hex').slice(0, 24);
      let nextTarget = 1;
      let blockquoteDepth = 0;

      const createTarget = kind => {
        const id = `format-target-${targetNonce}-${nextTarget++}`;
        targetKinds.set(id, kind);
        return { kind: 'preview', id };
      };

      const createImageFact = (source, alt, knownReason) => {
        const classification = knownReason ? { reason: knownReason } : classifyImageSource(source);
        const target = createTarget(classification.url ? 'image' : 'image-placeholder');
        const fact = { ...classification, alt: normalizeImageAlt(alt), target };
        if (!classification.url) {
          diagnostics.push(createDiagnostic({
            code: imageDiagnosticCodeByReason[classification.reason],
            severity: 'advisory',
            message: imagePlaceholderMessages[classification.reason],
            targets: [target]
          }));
        }
        return fact;
      };

      // Adapted from doocs/md addFootnote(): first occurrence assigns the number,
      // later occurrences reuse it. The local key is the URL parser's href.
      const addFootnote = (title, link, target) => {
        const existing = footnoteByUrl.get(link);
        if (existing) {
          existing.diagnostic.targets.push(target);
          existing.diagnostic.meta.occurrences += 1;
          return existing.index;
        }

        const index = footnotes.length + 1;
        const diagnostic = createDiagnostic({
          code: 'EXTERNAL_LINK_TO_FOOTNOTE',
          severity: 'conversion',
          message: '已将外部链接转换为脚注。',
          targets: [target],
          meta: { footnote: index, occurrences: 1 }
        });
        const entry = { index, title, link, diagnostic };
        footnotes.push(entry);
        footnoteByUrl.set(link, entry);
        diagnostics.push(diagnostic);
        return index;
      };

      const decorateExternalLinks = html => {
        if (!convertExternalLinksToFootnotes) return html;
        const $ = load(html, null, false);
        $('a').each((_, element) => {
          const anchor = $(element);
          const targetId = anchor.attr('data-format-target');
          const insideSpecialPlaceholder = anchor.parents('[data-format-target]').toArray()
            .some(parent => targetKinds.get($(parent).attr('data-format-target')) === 'special');
          if (insideSpecialPlaceholder) return;

          const url = parseHttpUrl(anchor.attr('href'));
          if (!url || isWeChatArticle(url)) return;
          const controlledMarkdownTarget = targetKinds.get(targetId) === 'link';
          const target = controlledMarkdownTarget ? { kind: 'preview', id: targetId } : createTarget('link');
          const title = controlledMarkdownTarget
            ? linkTitleByTarget.get(targetId)
            : anchor.attr('title') || anchor.text().trim() || url.href;
          const footnote = addFootnote(title || url.href, url.href, target);
          anchor.attr('href', url.href);
          anchor.attr('data-format-target', target.id);
          anchor.append($('<sup></sup>').text(`[${footnote}]`));
        });
        return $.root().html() || '';
      };

      const renderer = new Renderer();
      const defaultLink = renderer.link;
      renderer.link = function link(token) {
        if (!convertExternalLinksToFootnotes) return defaultLink.call(this, token);

        const url = parseHttpUrl(token.href);

        // Adapted from doocs/md renderer.link(): keep the WeChat exception before
        // ordinary external-link conversion, with an exact URL-parser boundary.
        if (!url || isWeChatArticle(url)) return defaultLink.call(this, token);

        const rendered = defaultLink.call(this, { ...token, href: url.href });
        const target = createTarget('link');
        linkTitleByTarget.set(target.id, token.title || token.text || url.href);
        return decorateMarkedLink(rendered, target.id);
      };
      renderer.image = function image(token) {
        const alt = token.tokens
          ? this.parser.parseInline(token.tokens, this.parser.textRenderer)
          : token.text;
        return imageFactHtml(createImageFact(token.href, alt));
      };
      renderer.blockquote = function blockquote(token) {
        const special = blockquoteDepth === 0 ? parseSpecialContent(token) : null;
        if (special) {
          const target = createTarget('special');
          diagnostics.push(createDiagnostic({
            code: 'SPECIAL_CONTENT_PLACEHOLDER',
            severity: 'conversion',
            message: '已将特殊内容保留为可见占位。',
            targets: [target],
            meta: { type: special.type }
          }));
          const source = special.sourceUrl
            ? ` 来源：${normalLinkHtml({ href: special.sourceUrl, title: special.sourceUrl, content: escapeHtml(special.sourceUrl) })}`
            : '';
          return `<blockquote class="format-special-placeholder" data-format-target="${target.id}" tabindex="0" role="note"><p>[特殊内容：${escapeHtml(special.label)}]${source}</p></blockquote>\n`;
        }
        const imagePlaceholder = blockquoteDepth === 0 ? parseCanonicalImagePlaceholder(token) : null;
        if (imagePlaceholder) {
          return `${imageFactHtml(createImageFact(undefined, imagePlaceholder.alt, imagePlaceholder.reason))}\n`;
        }

        blockquoteDepth += 1;
        try {
          return `<blockquote>\n${this.parser.parse(token.tokens)}</blockquote>\n`;
        } finally {
          blockquoteDepth -= 1;
        }
      };

      const parsed = parseMarkdown(body, { gfm: true, breaks: true, renderer });
      if (typeof parsed !== 'string') throw new TypeError('parseMarkdown 必须同步返回字符串');
      const html = sanitizeHtml(decorateExternalLinks(parsed) + buildFootnotes(footnotes), createSanitizerOptions(targetKinds, createImageFact));
      return toRenderResult({ html, presentation, diagnostics });
    } catch {
      return toRenderResult({
        html: '<p>正文渲染失败，请检查内容后重试。</p>',
        presentation,
        diagnostics: [createDiagnostic({
          code: 'RENDER_FAILED',
          message: '正文渲染失败，请检查内容后重试。',
          targets: [{ kind: 'source', start: 0, end: body.length }]
        })]
      });
    }
  };
}

export const renderTypesettingMarkdown = createTypesettingRenderer();
