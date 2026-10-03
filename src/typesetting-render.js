import { randomUUID } from 'node:crypto';
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
const sanitizerBaseOptions = Object.freeze({
  allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'h1', 'h2', 'span'],
  allowedAttributes: {
    a: ['href', 'title', 'data-format-target'],
    blockquote: ['class', 'data-format-target', 'tabindex', 'role'],
    p: ['class'],
    img: ['src', 'alt', 'width', 'height'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
    code: ['class']
  },
  allowedClasses: {
    blockquote: ['format-special-placeholder'],
    p: ['typeset-footnotes']
  },
  allowedSchemes: ['https', 'http', 'mailto'],
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

function normalLinkHtml({ href, title, content, targetId, footnote }) {
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
  const targetAttribute = targetId ? ` data-format-target="${escapeHtml(targetId)}"` : '';
  const reference = footnote ? `<sup>[${footnote}]</sup>` : '';
  return `<a href="${escapeHtml(href)}"${titleAttribute}${targetAttribute}>${content}${reference}</a>`;
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
  const match = /^\[特殊内容：(视频|音频|嵌入内容|小程序卡片|投票)\](?: 来源：(.+))?$/u.exec(text);
  if (!match) return null;

  const [, label, source] = match;
  if (!source) return { label, type: specialContentTypeByLabel[label] };
  const url = parseHttpUrl(source);
  if (!url || url.username || url.password) return null;
  return { label, type: specialContentTypeByLabel[label], sourceUrl: url.href };
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

function createSanitizerOptions(targetKinds) {
  const keepControlledTarget = (tagName, attributes, kind) => {
    const targetId = attributes['data-format-target'];
    if (!targetId || targetKinds.get(targetId) !== kind) delete attributes['data-format-target'];
    return { tagName, attribs: attributes };
  };

  return {
    ...sanitizerBaseOptions,
    transformTags: {
      a: (tagName, attributes) => keepControlledTarget(tagName, attributes, 'link'),
      blockquote: (tagName, attributes) => {
        const controlled = targetKinds.get(attributes['data-format-target']) === 'special';
        if (!controlled) {
          delete attributes['data-format-target'];
          delete attributes.class;
          delete attributes.tabindex;
          delete attributes.role;
        }
        return { tagName, attribs: attributes };
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
      const targetNonce = randomUUID();
      let nextTarget = 1;
      let blockquoteDepth = 0;

      const createTarget = kind => {
        const id = `format-target-${targetNonce}-${nextTarget++}`;
        targetKinds.set(id, kind);
        return { kind: 'preview', id };
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

      const renderer = new Renderer();
      renderer.link = function link(token) {
        const content = this.parser.parseInline(token.tokens);
        const url = parseHttpUrl(token.href);
        const title = token.title || token.text;

        // Adapted from doocs/md renderer.link(): keep the WeChat exception before
        // ordinary external-link conversion, with an exact URL-parser boundary.
        if (url && isWeChatArticle(url)) {
          return normalLinkHtml({ href: url.href, title, content });
        }
        if (url && convertExternalLinksToFootnotes) {
          const target = createTarget('link');
          const footnote = addFootnote(title || url.href, url.href, target);
          return normalLinkHtml({ href: url.href, title, content, targetId: target.id, footnote });
        }
        return normalLinkHtml({ href: token.href, title: token.title, content });
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

        blockquoteDepth += 1;
        try {
          return `<blockquote>\n${this.parser.parse(token.tokens)}</blockquote>\n`;
        } finally {
          blockquoteDepth -= 1;
        }
      };

      const parsed = parseMarkdown(body, { gfm: true, breaks: true, renderer });
      if (typeof parsed !== 'string') throw new TypeError('parseMarkdown 必须同步返回字符串');
      const html = sanitizeHtml(parsed + buildFootnotes(footnotes), createSanitizerOptions(targetKinds));
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
