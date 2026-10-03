import sanitizeHtml from 'sanitize-html';
import { marked } from 'marked';
import { normalizeTypesettingPresentation } from './typesetting-presentation.js';

const renderInputKeys = Object.freeze(['body', 'presentation', 'convertExternalLinksToFootnotes']);
const sanitizerOptions = Object.freeze({
  allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'h1', 'h2', 'span'],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'width', 'height'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
    code: ['class']
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

function createDiagnosticFactory() {
  let nextId = 1;
  return ({ code, message, targets }) => ({
    id: `diagnostic-${nextId++}`,
    code,
    severity: 'blocker',
    message,
    targets
  });
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
    const { body, presentation } = normalizeRenderInput(value);
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
      const parsed = parseMarkdown(body, { gfm: true, breaks: true });
      if (typeof parsed !== 'string') throw new TypeError('parseMarkdown 必须同步返回字符串');
      const html = sanitizeHtml(parsed, sanitizerOptions);
      return toRenderResult({ html, presentation, diagnostics: [] });
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
