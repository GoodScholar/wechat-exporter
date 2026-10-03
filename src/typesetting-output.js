import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import juice from 'juice';
import sanitizeHtml from 'sanitize-html';
import { normalizeTypesettingPresentation } from './typesetting-presentation.js';
import { renderTypesettingMarkdown } from './typesetting-render.js';

const outputRequestKeys = Object.freeze(['document', 'presentation', 'convertExternalLinksToFootnotes', 'failedImageTargets']);
const outputDocumentKeys = Object.freeze(['title', 'author', 'account', 'publishedAt', 'body']);
const renderResultKeys = Object.freeze(['html', 'presentation', 'diagnostics', 'blocked']);
const themeSettingKeys = Object.freeze(['primaryColor', 'fontSize', 'lineHeight', 'blockSpacing']);
const imageDiagnosticCodes = Object.freeze(['IMAGE_UNSUPPORTED_SCHEME', 'IMAGE_LOCAL_PATH', 'IMAGE_LOCAL_BINARY', 'IMAGE_MISSING_SOURCE']);
const specialContentTypes = Object.freeze(['video', 'audio', 'embed', 'mini-program', 'poll']);
const imageAttributeKeys = Object.freeze(['src', 'alt', 'referrerpolicy', 'data-image-state', 'data-format-target']);
const previewAllowedTags = Object.freeze([
  'address', 'article', 'aside', 'footer', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup', 'main', 'nav', 'section',
  'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'hr', 'li', 'menu', 'ol', 'p', 'pre', 'ul',
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'img', 'kbd', 'mark', 'q', 'rb', 'rp', 'rt', 'rtc', 'ruby',
  's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
  'caption', 'col', 'colgroup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr'
]);
const previewAllowedTagSet = new Set(previewAllowedTags);
const allowedStyleProperties = new Set([
  'color', 'background', 'background-color', 'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'letter-spacing', 'text-align', 'text-decoration', 'text-underline-offset', 'white-space', 'overflow-wrap', 'word-break',
  'vertical-align', 'display', 'width', 'max-width', 'height', 'max-height', 'margin', 'margin-top', 'margin-right',
  'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border',
  'border-top', 'border-right', 'border-bottom', 'border-left', 'border-width', 'border-style', 'border-color', 'border-radius',
  'border-collapse', 'table-layout', 'list-style-type', 'overflow'
]);
const blockPlainTextTags = new Set([
  'address', 'article', 'aside', 'footer', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup', 'main', 'nav', 'section',
  'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'p'
]);
const structuralWhitespaceParents = new Set([
  'article', 'aside', 'blockquote', 'body', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'header', 'hgroup',
  'main', 'nav', 'section', 'table', 'tbody', 'tfoot', 'thead', 'tr'
]);
const inlinePlainTextTags = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'img', 'kbd', 'mark', 'q', 'rb', 'rp', 'rt',
  'rtc', 'ruby', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var'
]);
const cssNumericLimit = 10000;
const themePrimaryColors = new Set(['#0F4C81', '#009874', '#FA5151', '#FECE00', '#92617E', '#55C9EA', '#B76E79', '#556B2F', '#333333', '#A9A9A9', '#FFB7C5']);
const themeFontSizes = new Set(['14px', '15px', '16px', '17px', '18px']);
const themeLineHeights = new Set(['1.5', '1.65', '1.75', '1.9', '2.05']);
const themeBlockSpacings = new Set(['0.75', '0.9', '1', '1.15', '1.35']);
const themeMarginValuesByTag = Object.freeze({
  h1: expandThemeValues(['calc(2em * {s}) auto calc(1em * {s})', 'calc(2em * {s}) 0 calc(1em * {s})', 'calc(1.8em * {s}) 0 calc(.8em * {s})']),
  h2: expandThemeValues(['calc(2.5em * {s}) auto calc(1em * {s})', 'calc(2em * {s}) 0 calc(.9em * {s})', 'calc(1.6em * {s}) 0 calc(.7em * {s})']),
  h3: expandThemeValues(['calc(2em * {s}) 0 calc(.75em * {s})', 'calc(1.6em * {s}) 0 calc(.7em * {s})', 'calc(1.4em * {s}) 0 calc(.6em * {s})']),
  p: expandThemeValues(['calc(1.25em * {s}) 8px', 'calc(1.15em * {s}) 0', 'calc(1em * {s}) 0', '0']),
  ul: expandThemeValues(['calc(1em * {s}) 0', 'calc(.9em * {s}) 0']),
  ol: expandThemeValues(['calc(1em * {s}) 0', 'calc(.9em * {s}) 0']),
  blockquote: expandThemeValues(['calc(1em * {s}) 0', 'calc(1.2em * {s}) 0']),
  img: expandThemeValues(['calc(.5em * {s}) auto', 'calc(.8em * {s}) auto', 'calc(.6em * {s}) auto']),
  pre: expandThemeValues(['calc(1em * {s}) 0']),
  hr: expandThemeValues(['calc(2em * {s}) 0', 'calc(1.6em * {s}) 0'])
});
const themePaddingValuesByTagProperty = Object.freeze({
  'h1.padding': new Set(['0 1em']),
  'h1.padding-bottom': new Set(['.35em']),
  'h1.padding-left': new Set(['.6em']),
  'h2.padding': new Set(['.15em .5em']),
  'h2.padding-bottom': new Set(['.25em']),
  'h3.padding-left': new Set(['8px']),
  'ul.padding-left': new Set(['1.5em', '1.4em']),
  'ol.padding-left': new Set(['1.5em', '1.4em']),
  'blockquote.padding': new Set(['1em', '.8em 1em', '.6em .9em']),
  'code.padding': new Set(['2px 4px']),
  'pre.padding': new Set(['12px']),
  'th.padding': new Set(['6px']),
  'td.padding': new Set(['6px'])
});
const themedStylePropertiesByTag = Object.freeze({
  section: new Set(['color', 'font', 'overflow-wrap']),
  h1: new Set(['display', 'margin', 'padding', 'padding-bottom', 'padding-left', 'border-bottom', 'border-left', 'color', 'font-size', 'text-align']),
  h2: new Set(['display', 'margin', 'padding', 'padding-bottom', 'border-bottom', 'background', 'color', 'font-size']),
  h3: new Set(['margin', 'padding-left', 'border-left', 'color', 'font-size']),
  p: new Set(['margin', 'letter-spacing']),
  ul: new Set(['margin', 'padding-left']),
  ol: new Set(['margin', 'padding-left']),
  blockquote: new Set(['margin', 'padding', 'border-left', 'background', 'color']),
  img: new Set(['display', 'max-width', 'height', 'margin', 'border-radius']),
  a: new Set(['color', 'text-decoration', 'text-underline-offset', 'border-bottom']),
  code: new Set(['padding', 'background', 'color']),
  pre: new Set(['overflow', 'margin', 'padding', 'background']),
  hr: new Set(['margin', 'border', 'border-top']),
  table: new Set(['width', 'border-collapse']),
  th: new Set(['padding', 'border']),
  td: new Set(['padding', 'border'])
});
const controlledImageTarget = /^format-target-[a-f0-9]{24}-[1-9]\d*$/u;
const fixedTypesettingThemeCss = readFileSync(new URL('../public/typesetting-theme.css', import.meta.url), 'utf8');
const fixedJuiceOptions = Object.freeze({
  applyStyleTags: true,
  removeStyleTags: true,
  inlinePseudoElements: false,
  preserveFontFaces: false,
  preserveMediaQueries: false,
  preserveKeyFrames: false,
  preservePseudos: false,
  preserveImportant: false,
  resolveCSSVariables: true,
  applyWidthAttributes: false,
  applyHeightAttributes: false,
  xmlMode: false
});
const errorDefinitions = Object.freeze({
  OUTPUT_REQUEST_INVALID: Object.freeze({ message: '排版输出请求无效', status: 400, retryable: false }),
  OUTPUT_FAILED_IMAGE_TARGET_INVALID: Object.freeze({ message: '失败图片目标无效', status: 400, retryable: false }),
  OUTPUT_GENERATION_FAILED: Object.freeze({ message: '排版输出生成失败', status: 500, retryable: true })
});

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isPlainRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const hasExactKeys = (value, keys) => isPlainRecord(value)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => hasOwn(value, key));
const normalizeLineEndings = value => value.replace(/\r\n?/gu, '\n');
const isNonEmptyString = value => typeof value === 'string' && value.length > 0;
const isPositiveInteger = value => Number.isSafeInteger(value) && value > 0;

function isDenseExactArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1 || !hasOwn(value, 'length')) return false;
  for (let index = 0; index < value.length; index += 1) if (!hasOwn(value, index)) return false;
  return true;
}

function outputError(code) {
  const definition = errorDefinitions[code];
  const error = new Error(definition.message);
  error.code = code;
  error.status = definition.status;
  error.retryable = definition.retryable;
  return error;
}

function normalizeOutputRequest(value) {
  if (!hasExactKeys(value, outputRequestKeys) || !hasExactKeys(value.document, outputDocumentKeys)) {
    throw outputError('OUTPUT_REQUEST_INVALID');
  }

  const document = {};
  for (const key of outputDocumentKeys) {
    if (typeof value.document[key] !== 'string') throw outputError('OUTPUT_REQUEST_INVALID');
    document[key] = normalizeLineEndings(value.document[key]);
  }
  if (typeof value.convertExternalLinksToFootnotes !== 'boolean' || !isDenseExactArray(value.failedImageTargets)) {
    throw outputError('OUTPUT_REQUEST_INVALID');
  }
  if (value.failedImageTargets.some(target => typeof target !== 'string' || target.length === 0)) {
    throw outputError('OUTPUT_REQUEST_INVALID');
  }
  if (new Set(value.failedImageTargets).size !== value.failedImageTargets.length) {
    throw outputError('OUTPUT_FAILED_IMAGE_TARGET_INVALID');
  }

  const presentation = normalizePresentation(value.presentation, 'OUTPUT_REQUEST_INVALID');
  return {
    document,
    presentation,
    convertExternalLinksToFootnotes: value.convertExternalLinksToFootnotes,
    failedImageTargets: [...value.failedImageTargets]
  };
}

function normalizePresentation(value, errorCode) {
  if (!hasExactKeys(value, ['theme', 'settings']) || !hasExactKeys(value.settings, themeSettingKeys)) {
    throw outputError(errorCode);
  }
  try {
    return normalizeTypesettingPresentation(value);
  } catch {
    throw outputError(errorCode);
  }
}

function samePresentation(left, right) {
  return left.theme === right.theme
    && themeSettingKeys.every(key => left.settings[key] === right.settings[key]);
}

function validateRenderResult(value, expectedPresentation) {
  if (!hasExactKeys(value, renderResultKeys)
    || typeof value.html !== 'string'
    || !isDenseExactArray(value.diagnostics)
    || typeof value.blocked !== 'boolean') {
    throw outputError('OUTPUT_GENERATION_FAILED');
  }
  const presentation = normalizePresentation(value.presentation, 'OUTPUT_GENERATION_FAILED');
  if (!samePresentation(presentation, expectedPresentation)) {
    throw outputError('OUTPUT_GENERATION_FAILED');
  }
  return { ...value, presentation };
}

function isSourceTarget(target, body) {
  return hasExactKeys(target, ['kind', 'start', 'end']) && target.kind === 'source'
    && Number.isSafeInteger(target.start) && target.start >= 0
    && Number.isSafeInteger(target.end) && target.start <= target.end && target.end <= body.length;
}

function isPreviewTarget(target, $) {
  if (!hasExactKeys(target, ['kind', 'id']) || target.kind !== 'preview' || !isNonEmptyString(target.id)) return false;
  return $('[data-format-target]').toArray()
    .filter(element => $(element).attr('data-format-target') === target.id).length === 1;
}

function hasValidTargets(diagnostic, body, $, kind, count) {
  if (!isDenseExactArray(diagnostic.targets) || diagnostic.targets.length === 0) return false;
  if (count !== undefined && diagnostic.targets.length !== count) return false;
  if (!diagnostic.targets.every(target => kind === 'source' ? isSourceTarget(target, body) : isPreviewTarget(target, $))) return false;
  const targetKeys = diagnostic.targets.map(target => target.kind === 'source'
    ? `source:${target.start}:${target.end}`
    : `preview:${target.id}`);
  return new Set(targetKeys).size === targetKeys.length;
}

function isValidDiagnostic(diagnostic, body, $) {
  if (!isPlainRecord(diagnostic) || !isNonEmptyString(diagnostic.id) || !isNonEmptyString(diagnostic.message)) return false;
  const baseKeys = ['id', 'code', 'severity', 'message', 'targets'];
  if (diagnostic.code === 'EMPTY_BODY') {
    return hasExactKeys(diagnostic, baseKeys) && diagnostic.severity === 'blocker'
      && body.trim() === '' && hasValidTargets(diagnostic, body, $, 'source', 1)
      && diagnostic.targets[0].start === 0 && diagnostic.targets[0].end === 0;
  }
  if (diagnostic.code === 'RENDER_FAILED') {
    return hasExactKeys(diagnostic, baseKeys) && diagnostic.severity === 'blocker'
      && hasValidTargets(diagnostic, body, $, 'source', 1)
      && diagnostic.targets[0].start === 0 && diagnostic.targets[0].end === body.length;
  }
  if (diagnostic.code === 'EXTERNAL_LINK_TO_FOOTNOTE') {
    return hasExactKeys(diagnostic, [...baseKeys, 'meta']) && diagnostic.severity === 'conversion'
      && hasValidTargets(diagnostic, body, $, 'preview')
      && hasExactKeys(diagnostic.meta, ['footnote', 'occurrences'])
      && isPositiveInteger(diagnostic.meta.footnote) && diagnostic.meta.occurrences === diagnostic.targets.length;
  }
  if (diagnostic.code === 'SPECIAL_CONTENT_PLACEHOLDER') {
    return hasExactKeys(diagnostic, [...baseKeys, 'meta']) && diagnostic.severity === 'conversion'
      && hasValidTargets(diagnostic, body, $, 'preview', 1)
      && hasExactKeys(diagnostic.meta, ['type']) && specialContentTypes.includes(diagnostic.meta.type);
  }
  if (imageDiagnosticCodes.includes(diagnostic.code)) {
    return hasExactKeys(diagnostic, baseKeys) && diagnostic.severity === 'advisory'
      && hasValidTargets(diagnostic, body, $, 'preview', 1);
  }
  return false;
}

function validateDiagnostics(diagnostics, body, $) {
  if (diagnostics.some(diagnostic => !isValidDiagnostic(diagnostic, body, $))) {
    throw outputError('OUTPUT_GENERATION_FAILED');
  }
  if (new Set(diagnostics.map(diagnostic => diagnostic.id)).size !== diagnostics.length) {
    throw outputError('OUTPUT_GENERATION_FAILED');
  }
  const previewTargets = diagnostics.flatMap(diagnostic => diagnostic.targets
    .filter(target => target.kind === 'preview')
    .map(target => target.id));
  if (new Set(previewTargets).size !== previewTargets.length) {
    throw outputError('OUTPUT_GENERATION_FAILED');
  }
}

function safeOutputBaseName(title) {
  let basename = title.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_');
  basename = basename.replace(/^\.+/u, '').replace(/[. ]+$/u, '');
  basename = [...basename].slice(0, 80).join('').replace(/[. ]+$/u, '');
  return basename || '未命名文章';
}

function buildNormalizedMarkdown(document) {
  const body = document.body.replace(/\n+$/u, '') + '\n';
  return {
    mimeType: 'text/markdown;charset=utf-8',
    filename: `${safeOutputBaseName(document.title)}.md`,
    content: [
      '---',
      `title: ${JSON.stringify(document.title)}`,
      `author: ${JSON.stringify(document.author)}`,
      `account: ${JSON.stringify(document.account)}`,
      `publishedAt: ${JSON.stringify(document.publishedAt)}`,
      '---',
      '',
      body
    ].join('\n')
  };
}

function normalizeImageAlt(value) {
  return [...String(value || '').replace(/\s+/gu, ' ').trim()].slice(0, 200).join('');
}

function isControlledImage(image, target) {
  if (image.length !== 1
    || Object.keys(image[0].attribs).length !== imageAttributeKeys.length
    || !imageAttributeKeys.every(key => image.attr(key) !== undefined)
    || !controlledImageTarget.test(target)
    || !image.is('img')
    || image.attr('data-format-target') !== target
    || image.attr('data-image-state') !== 'pending'
    || image.attr('referrerpolicy') !== 'no-referrer'
    || image.attr('alt') === undefined) return false;
  try {
    const source = new URL(image.attr('src'));
    return source.protocol === 'https:' && source.username === '' && source.password === '';
  } catch {
    return false;
  }
}

function parseRenderedHtml(html) {
  let $;
  try {
    $ = load(html, null, false);
  } catch {
    throw outputError('OUTPUT_GENERATION_FAILED');
  }
  return $;
}

function prepareRenderedHtml($, failedImageTargets) {
  const indexedTargets = $('[data-format-target]').toArray().map((element, index) => ({
    element,
    index,
    target: $(element).attr('data-format-target')
  }));
  const failedImages = failedImageTargets.map(target => {
    const matches = indexedTargets.filter(item => item.target === target);
    if (matches.length !== 1 || !isControlledImage($(matches[0].element), target)) {
      throw outputError('OUTPUT_FAILED_IMAGE_TARGET_INVALID');
    }
    return matches[0];
  });
  if (failedImages.some((item, index) => index > 0 && failedImages[index - 1].index >= item.index)) {
    throw outputError('OUTPUT_FAILED_IMAGE_TARGET_INVALID');
  }

  for (const { element } of failedImages) {
    const image = $(element);
    const alt = normalizeImageAlt(image.attr('alt'));
    const figure = $('<figure></figure>').attr('role', 'note');
    figure.append($('<figcaption></figcaption>').text(`图片加载失败。请检查图片地址后重试。${alt ? ` 替代文本：${alt}` : ''}`));
    image.replaceWith(figure);
  }
  $('[data-format-target]').removeAttr('data-format-target');
  $('img[data-image-state]').removeAttr('data-image-state');
  return $.root().html() || '';
}

function themeRootHtml(html, presentation) {
  const { theme, settings } = presentation;
  const variables = [
    `--md-primary-color:${settings.primaryColor}`,
    `--md-font-size:${settings.fontSize}`,
    `--md-line-height:${settings.lineHeight}`,
    `--md-block-spacing:${settings.blockSpacing}`
  ].join(';');
  return `<section class="typeset-preview typeset-theme-${theme}" style="${variables}">${html}</section>`;
}

function splitStyleDeclarations(style) {
  const declarations = [];
  let current = '';
  let quote = '';
  let depth = 0;
  for (const character of style) {
    if (quote) {
      current += character;
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
    } else if (character === '(') {
      depth += 1;
      current += character;
    } else if (character === ')') {
      depth -= 1;
      if (depth < 0) throw outputError('OUTPUT_GENERATION_FAILED');
      current += character;
    } else if (character === ';' && depth === 0) {
      if (current.trim()) declarations.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (quote || depth !== 0) throw outputError('OUTPUT_GENERATION_FAILED');
  if (current.trim()) declarations.push(current.trim());
  return declarations;
}

function parseFiniteCssNumber(value, { min = -cssNumericLimit, max = cssNumericLimit } = {}) {
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function expandThemeValues(templates) {
  const values = new Set();
  for (const template of templates) {
    if (!template.includes('{s}')) values.add(template);
    else for (const spacing of themeBlockSpacings) values.add(template.replaceAll('{s}', spacing));
  }
  return values;
}

function isFixedLength(value, allowed, { min = 0, max = cssNumericLimit } = {}) {
  const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(px|em|rem|%)?$/iu.exec(value);
  return Boolean(match) && parseFiniteCssNumber(match[1], { min, max }) !== null && allowed.has(value);
}

function hasOnlyFiniteCssNumbers(value) {
  const numbers = value.match(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/gu) || [];
  return numbers.every(number => Number.isFinite(Number(number)));
}

function splitCssValueTokens(value) {
  const tokens = [];
  let current = '';
  let quote = '';
  let depth = 0;
  for (const character of value) {
    if (quote) {
      current += character;
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
    } else if (character === '(') {
      depth += 1;
      current += character;
    } else if (character === ')') {
      depth -= 1;
      if (depth < 0) return [];
      current += character;
    } else if (/\s/u.test(character) && depth === 0) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (quote || depth !== 0) return [];
  if (current) tokens.push(current);
  return tokens;
}

function isThemeColor(tagName, property, value) {
  if (tagName === 'section' && property === 'color') return value === '#25332b';
  if (tagName === 'h1' && property === 'color') return themePrimaryColors.has(value) || value === '#222';
  if (tagName === 'h2' && property === 'color') return themePrimaryColors.has(value) || value === '#fff' || value === '#222';
  if (tagName === 'h2' && property === 'background') return themePrimaryColors.has(value);
  if (tagName === 'h3' && property === 'color') return value === '#44504a' || value === '#333';
  if (tagName === 'blockquote' && property === 'color') return value === '#5b625d' || value === '#666';
  if (tagName === 'blockquote' && property === 'background') return value === '#f3f7f4' || value === '#f7f7f5';
  if (tagName === 'a' && property === 'color') return themePrimaryColors.has(value) || value === '#576b95';
  if (tagName === 'code' && property === 'color') return themePrimaryColors.has(value) || value === '#7a4d2d' || value === '#333';
  if (tagName === 'code' && property === 'background') return ['#f1f3f1', '#f5f5f2', '#f3f3f3'].includes(value);
  if (tagName === 'pre' && property === 'background') return ['#f1f3f1', '#f5f5f2', '#f3f3f3'].includes(value);
  return false;
}

function isPrimaryBorder(value, widths) {
  const tokens = splitCssValueTokens(value);
  return tokens.length === 3 && isFixedLength(tokens[0], widths, { max: 5 })
    && tokens[1] === 'solid' && themePrimaryColors.has(tokens[2]);
}

function isThemeBorder(tagName, property, value) {
  if (tagName === 'hr' && property === 'border') return value === '0';
  if (tagName === 'hr' && property === 'border-top') {
    return ['1px solid #d7e0d9', '1px solid #d9d7d1', '1px solid #ddd'].includes(value);
  }
  if (tagName === 'h1' && property === 'border-bottom') return isPrimaryBorder(value, new Set(['1px', '2px']));
  if (tagName === 'h1' && property === 'border-left') return isPrimaryBorder(value, new Set(['5px']));
  if (tagName === 'h2' && property === 'border-bottom') return isPrimaryBorder(value, new Set(['2px']));
  if (tagName === 'h3' && property === 'border-left') return isPrimaryBorder(value, new Set(['3px']));
  if (tagName === 'blockquote' && property === 'border-left') {
    return isPrimaryBorder(value, new Set(['3px', '4px'])) || value === '4px solid #c9c9c9';
  }
  if (tagName === 'a' && property === 'border-bottom') return value === '1px solid currentColor';
  if ((tagName === 'th' || tagName === 'td') && property === 'border') {
    return ['1px solid #d7e0d9', '1px solid #d9d7d1', '1px solid #ddd'].includes(value);
  }
  return false;
}

function isThemeFont(value) {
  const match = /^((?:\d+(?:\.\d+)?|\.\d+)px)\/((?:\d+(?:\.\d+)?|\.\d+)) ('PingFang SC'|"PingFang SC"), ('Microsoft YaHei'|"Microsoft YaHei"), sans-serif$/u.exec(value);
  return Boolean(match)
    && isFixedLength(match[1], themeFontSizes, { min: 14, max: 18 })
    && parseFiniteCssNumber(match[2], { min: 1.5, max: 2.05 }) !== null
    && themeLineHeights.has(match[2]);
}

function hasSafeStyleValue(tagName, property, value) {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f\\{};<>@!]/u.test(value)
    || /(?:url\s*\(|@import|expression|javascript\s*:|data\s*:|blob\s*:|var\s*\(|env\s*\(|attr\s*\(|behavior)/iu.test(value)
    || !/^[\p{L}\p{N}\s#.,'"%+\-*/()]+$/u.test(value)) return false;
  const lower = value.toLowerCase();
  if (property === 'color' || property === 'background') return isThemeColor(tagName, property, value);
  if (property === 'font') return isThemeFont(value);
  if (property === 'overflow-wrap') return lower === 'anywhere';
  if (property === 'display') return (tagName === 'img' && lower === 'block') || ((tagName === 'h1' || tagName === 'h2') && lower === 'table');
  if (property === 'font-size') {
    const values = tagName === 'h1' ? new Set(['1.35em', '1.45em', '1.4em'])
      : tagName === 'h2' ? new Set(['1.25em', '1.2em']) : new Set(['1.12em', '1.1em', '1.08em']);
    return isFixedLength(value, values, { min: 1.08, max: 1.45 });
  }
  if (property === 'text-align') return tagName === 'h1' && lower === 'center';
  if (property === 'letter-spacing') return tagName === 'p' && isFixedLength(value, new Set(['.04em', '.06em']), { max: 0.06 });
  if (property === 'text-decoration') return tagName === 'a' && (lower === 'none' || lower === 'underline');
  if (property === 'text-underline-offset') return tagName === 'a' && isFixedLength(value, new Set(['.15em']), { max: 0.15 });
  if (property === 'width') return tagName === 'table' && isFixedLength(value, new Set(['100%']), { max: 100 });
  if (property === 'max-width') return tagName === 'img' && isFixedLength(value, new Set(['100%']), { max: 100 });
  if (property === 'height') return tagName === 'img' && lower === 'auto';
  if (property === 'margin') {
    return hasOnlyFiniteCssNumbers(value) && Boolean(themeMarginValuesByTag[tagName]?.has(value));
  }
  if (property === 'padding' || property === 'padding-left' || property === 'padding-bottom') {
    return hasOnlyFiniteCssNumbers(value) && Boolean(themePaddingValuesByTagProperty[`${tagName}.${property}`]?.has(value));
  }
  if (property === 'border' || property === 'border-top' || property === 'border-bottom' || property === 'border-left') {
    return hasOnlyFiniteCssNumbers(value) && isThemeBorder(tagName, property, value);
  }
  if (property === 'border-radius') return tagName === 'img' && isFixedLength(value, new Set(['2px', '4px']), { max: 4 });
  if (property === 'border-collapse') return tagName === 'table' && lower === 'collapse';
  if (property === 'overflow') return tagName === 'pre' && lower === 'auto';
  return false;
}

function normalizeStyle(style, { removeVariables = false, tagName, isRoot = false } = {}) {
  const normalized = [];
  const seen = new Set();
  const tagProperties = tagName === 'section' && !isRoot ? undefined : themedStylePropertiesByTag[tagName];
  for (const declaration of splitStyleDeclarations(style)) {
    const separator = declaration.indexOf(':');
    if (separator <= 0) throw outputError('OUTPUT_GENERATION_FAILED');
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (removeVariables && property.startsWith('--')) continue;
    if (!allowedStyleProperties.has(property) || !tagProperties?.has(property)
      || seen.has(property) || !hasSafeStyleValue(tagName, property, value)) {
      throw outputError('OUTPUT_GENERATION_FAILED');
    }
    seen.add(property);
    normalized.push(`${property}: ${value}`);
  }
  return normalized.join('; ');
}

function hasAllowedHref(href) {
  const classified = href.replace(/[\u0000-\u0020]/gu, '').replace(/<!--[\s\S]*?-->/gu, '');
  if (/^[\\/]{2}/u.test(classified)) return false;
  const scheme = /^([a-zA-Z][a-zA-Z0-9.\-+]*):/u.exec(classified);
  return !scheme || ['http', 'https', 'mailto'].includes(scheme[1].toLowerCase());
}

function hasSafeImageSource(source) {
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function allowedAttributesFor(tagName) {
  const attributes = new Set(['style']);
  if (tagName === 'a') for (const name of ['href', 'title']) attributes.add(name);
  if (tagName === 'img') for (const name of ['src', 'alt', 'referrerpolicy']) attributes.add(name);
  if (tagName === 'th' || tagName === 'td') for (const name of ['colspan', 'rowspan']) attributes.add(name);
  if (tagName === 'blockquote' || tagName === 'figure') attributes.add('role');
  return attributes;
}

function cleanCanonicalRuntimeAttributes($) {
  const rootSection = $.root().children('section').first()[0];
  $('*').each((_, element) => {
    const node = $(element);
    node.removeAttr('class');
    node.removeAttr('id');
    node.removeAttr('data-format-target');
    node.removeAttr('data-image-state');
    if ((element.tagName === 'blockquote' || element.tagName === 'figure') && node.attr('role') === 'note') {
      node.removeAttr('tabindex');
    }
    const style = node.attr('style');
    if (style === undefined) return;
    const normalized = normalizeStyle(style, { removeVariables: true, tagName: element.tagName, isRoot: element === rootSection });
    if (normalized) node.attr('style', normalized);
    else node.removeAttr('style');
  });
}

function validateSafeNodes($) {
  const inspect = node => {
    if (node.type === 'text') return;
    if (node.type !== 'tag') throw outputError('OUTPUT_GENERATION_FAILED');
    const tagName = node.tagName.toLowerCase();
    if (!previewAllowedTagSet.has(tagName)) throw outputError('OUTPUT_GENERATION_FAILED');
    const allowedAttributes = allowedAttributesFor(tagName);
    for (const [name, value] of Object.entries(node.attribs)) {
      if (!allowedAttributes.has(name)) throw outputError('OUTPUT_GENERATION_FAILED');
      if (name === 'style' && normalizeStyle(value, { tagName, isRoot: node.parent?.type === 'root' }) !== value.replace(/;\s*$/u, '').trim()) {
        throw outputError('OUTPUT_GENERATION_FAILED');
      }
      if (name === 'href' && !hasAllowedHref(value)) throw outputError('OUTPUT_GENERATION_FAILED');
    }
    const element = $(node);
    if (tagName === 'img' && (!hasOwn(node.attribs, 'src') || !hasOwn(node.attribs, 'alt')
      || node.attribs.referrerpolicy !== 'no-referrer' || !hasSafeImageSource(node.attribs.src))) {
      throw outputError('OUTPUT_GENERATION_FAILED');
    }
    if (hasOwn(node.attribs, 'role') && (node.attribs.role !== 'note' || !element.is('blockquote, figure'))) {
      throw outputError('OUTPUT_GENERATION_FAILED');
    }
    for (const child of node.children || []) inspect(child);
  };
  for (const node of $.root().contents().toArray()) {
    if (node.type === 'text' && /^\s*$/u.test(node.data || '')) continue;
    inspect(node);
  }
}

function normalizedDom($) {
  const normalizeNode = node => {
    if (node.type === 'text') return ['text', node.data || ''];
    if (node.type !== 'tag') return [node.type];
    return [
      'tag',
      node.tagName.toLowerCase(),
      Object.entries(node.attribs)
        .map(([name, value]) => [name, name === 'style'
          ? normalizeStyle(value, { tagName: node.tagName.toLowerCase(), isRoot: node.parent?.type === 'root' })
          : value])
        .sort(([left], [right]) => left.localeCompare(right)),
      (node.children || []).map(normalizeNode)
    ];
  };
  return $.root().contents().toArray()
    .filter(node => !(node.type === 'text' && /^\s*$/u.test(node.data || '')))
    .map(normalizeNode);
}

const finalSanitizerOptions = Object.freeze({
  allowedTags: [...previewAllowedTags],
  allowedAttributes: {
    '*': ['style'],
    a: ['href', 'title', 'style'],
    img: ['src', 'alt', 'referrerpolicy', 'style'],
    blockquote: ['role', 'style'],
    figure: ['role', 'style'],
    th: ['colspan', 'rowspan', 'style'],
    td: ['colspan', 'rowspan', 'style']
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['https'] },
  allowProtocolRelative: false,
  enforceHtmlBoundary: true
});

function assertSanitizerConsistency(html, $) {
  let sanitized;
  try {
    sanitized = sanitizeHtml(html, finalSanitizerOptions);
  } catch {
    throw outputError('OUTPUT_GENERATION_FAILED');
  }
  const sanitizedDom = parseRenderedHtml(sanitized);
  if (JSON.stringify(normalizedDom($)) !== JSON.stringify(normalizedDom(sanitizedDom))) {
    throw outputError('OUTPUT_GENERATION_FAILED');
  }
}

function parseSingleSection(html, { clean = false } = {}) {
  const $ = parseRenderedHtml(html);
  const significantRoots = $.root().contents().toArray()
    .filter(node => !(node.type === 'text' && /^\s*$/u.test(node.data || '')));
  if (significantRoots.length !== 1 || significantRoots[0].type !== 'tag' || significantRoots[0].tagName !== 'section') {
    throw outputError('OUTPUT_GENERATION_FAILED');
  }
  if (clean) cleanCanonicalRuntimeAttributes($);
  validateSafeNodes($);
  const serialized = $.root().html() || '';
  assertSanitizerConsistency(serialized, $);
  return { $, serialized };
}

// Adapted from doocs/md@a7c17fc4cda92e3c13aa7e24f06615cfa4219b31
// clipboard-dom.ts modifyHtmlStructure(); adapted to Cheerio and stable multi-list order.
function modifyHtmlStructure($) {
  for (const item of $('li').toArray()) {
    const childLists = $(item).children('ul, ol').toArray();
    if (childLists.length > 0) $(item).after(childLists);
  }
}

// Adapted from the same fixed doocs clipboard-dom.ts solveWeChatImage().
// Current canonical input has no width/height attributes; this remains a conditional compatibility step.
function solveWeChatImage($) {
  $('img').each((_, element) => {
    const image = $(element);
    const migrated = [];
    for (const name of ['width', 'height']) {
      const value = image.attr(name);
      if (!value) continue;
      image.removeAttr(name);
      const length = /^\d+$/u.test(value) ? `${value}px` : value;
      if (!/^(?:\d+(?:\.\d+)?(?:px|em|rem|%)|auto)$/u.test(length)) throw outputError('OUTPUT_GENERATION_FAILED');
      migrated.push(`${name}: ${length}`);
    }
    if (migrated.length === 0) return;
    const existing = image.attr('style');
    image.attr('style', [existing, ...migrated].filter(Boolean).join('; '));
  });
}

function assertClipboardImages($) {
  $('img').each((_, element) => {
    const image = $(element);
    if (image.attr('width') !== undefined || image.attr('height') !== undefined) throw outputError('OUTPUT_GENERATION_FAILED');
    const declarations = new Map(splitStyleDeclarations(image.attr('style') || '').map(declaration => {
      const separator = declaration.indexOf(':');
      return [declaration.slice(0, separator).trim().toLowerCase(), declaration.slice(separator + 1).trim().toLowerCase()];
    }));
    if (declarations.get('display') !== 'block' || declarations.get('max-width') !== '100%' || declarations.get('height') !== 'auto') {
      throw outputError('OUTPUT_GENERATION_FAILED');
    }
  });
}

// Adapted from the same fixed doocs clipboard-dom.ts createEmptyNode().
function createEmptyNode() {
  return '<p style="font-size:0;line-height:0;margin:0">&nbsp;</p>';
}

function renderInlinePlainText($, nodes, depth) {
  return nodes.map(node => renderPlainTextNode($, node, depth)).join('');
}

function renderListPlainText($, list, depth) {
  const ordered = list.tagName === 'ol';
  const rawStart = $(list).attr('start');
  let number = /^-?\d+$/u.test(rawStart || '') ? Number(rawStart) : 1;
  let output = '';
  for (const child of $(list).contents().toArray()) {
    if (child.type === 'text') continue;
    if (child.type !== 'tag') continue;
    if (child.tagName === 'li') {
      const inlineNodes = $(child).contents().toArray().filter(node => node.type !== 'tag' || (node.tagName !== 'ul' && node.tagName !== 'ol'));
      const text = renderInlinePlainText($, inlineNodes, depth).replace(/\s+/gu, ' ').trim();
      output += `${'  '.repeat(depth)}${ordered ? `${number}. ` : '- '}${text}\n`;
      number += 1;
      for (const nested of $(child).children('ul, ol').toArray()) output += renderListPlainText($, nested, depth + 1);
    } else if (child.tagName === 'ul' || child.tagName === 'ol') {
      output += renderListPlainText($, child, depth + 1);
    }
  }
  return output;
}

function renderTablePlainText($, table, depth) {
  let output = '';
  for (const row of $(table).find('tr').toArray()) {
    const cells = $(row).children('th, td').toArray().map(cell => renderInlinePlainText($, $(cell).contents().toArray(), depth)
      .replace(/\s+/gu, ' ').trim());
    output += `${cells.join('\t')}\n`;
  }
  return output;
}

function isVisibleInlinePlainNode($, node) {
  if (node?.type === 'text') return /\S/u.test((node.data || '').replace(/\u00a0/gu, ' '));
  if (node?.type !== 'tag' || !inlinePlainTextTags.has(node.tagName.toLowerCase())) return false;
  return node.tagName === 'img' || /\S/u.test($(node).text().replace(/\u00a0/gu, ' '));
}

function inlineWhitespaceBetweenVisibleSiblings($, node) {
  const siblings = node.parent?.children || [];
  const index = siblings.indexOf(node);
  let before = index - 1;
  let after = index + 1;
  while (before >= 0 && siblings[before].type === 'text' && !/\S/u.test(siblings[before].data || '')) before -= 1;
  while (after < siblings.length && siblings[after].type === 'text' && !/\S/u.test(siblings[after].data || '')) after += 1;
  return isVisibleInlinePlainNode($, siblings[before]) && isVisibleInlinePlainNode($, siblings[after]);
}

function renderPlainTextNode($, node, depth = 0) {
  if (node.type === 'text') {
    const raw = node.data || '';
    const value = raw.replace(/[\s\u00a0]+/gu, ' ');
    if (!value.trim() && /[\r\n]/u.test(raw) && structuralWhitespaceParents.has(node.parent?.tagName)) {
      return inlineWhitespaceBetweenVisibleSiblings($, node) ? ' ' : '';
    }
    return value;
  }
  if (node.type !== 'tag') return '';
  const tagName = node.tagName.toLowerCase();
  if (tagName === 'br') return '\n';
  if (tagName === 'img') {
    const alt = ($(node).attr('alt') || '').replace(/\s+/gu, ' ').trim();
    return alt ? `[图片：${alt}]` : '[图片]';
  }
  if (tagName === 'pre') return `${$(node).text()}\n`;
  if (tagName === 'code') return $(node).text();
  if (tagName === 'ul' || tagName === 'ol') return renderListPlainText($, node, depth);
  if (tagName === 'table') return renderTablePlainText($, node, depth);
  const content = renderInlinePlainText($, $(node).contents().toArray(), depth);
  return blockPlainTextTags.has(tagName) ? `${content}\n` : content;
}

function buildPlainText($) {
  return renderInlinePlainText($, $.root().contents().toArray(), 0)
    .split('\n')
    .map(line => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/^\n+|\n+$/gu, '');
}

function buildFullHtml(document, canonicalInlineBody) {
  const $ = load('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title></title><meta http-equiv="Referrer-Policy" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src https:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"></head><body><header><h1></h1><dl><dt>作者</dt><dd></dd><dt>公众号名称</dt><dd></dd><dt>发布日期</dt><dd></dd></dl></header><main></main></body></html>');
  $('head title').text(document.title);
  $('header h1').text(document.title);
  const metadata = [document.author, document.account, document.publishedAt];
  $('header dd').each((index, element) => $(element).text(metadata[index]));
  $('main').html(canonicalInlineBody);
  return `<!doctype html>${$.html('html')}`;
}

function defaultJuiceAdapter(html, themeCss, options) {
  return juice(`<style>${themeCss}</style>${html}`, options);
}

export function createTypesettingOutputBuilder({
  renderTypesetting = renderTypesettingMarkdown,
  inlineCss = defaultJuiceAdapter,
  themeCss = fixedTypesettingThemeCss
} = {}) {
  return async function buildTypesettingOutputFromInput(value) {
    const snapshot = normalizeOutputRequest(value);
    if (typeof renderTypesetting !== 'function' || typeof inlineCss !== 'function' || typeof themeCss !== 'string') {
      throw outputError('OUTPUT_GENERATION_FAILED');
    }

    let rendered;
    try {
      rendered = renderTypesetting({
        body: snapshot.document.body,
        presentation: snapshot.presentation,
        convertExternalLinksToFootnotes: snapshot.convertExternalLinksToFootnotes
      });
      if (rendered instanceof Promise) {
        Promise.prototype.then.call(rendered, undefined, () => {});
        throw outputError('OUTPUT_GENERATION_FAILED');
      }
    } catch {
      throw outputError('OUTPUT_GENERATION_FAILED');
    }
    const result = validateRenderResult(rendered, snapshot.presentation);
    const $ = parseRenderedHtml(result.html);
    validateDiagnostics(result.diagnostics, snapshot.document.body, $);
    if (result.blocked !== result.diagnostics.some(item => item.severity === 'blocker')) {
      throw outputError('OUTPUT_GENERATION_FAILED');
    }
    const preparedHtml = prepareRenderedHtml($, snapshot.failedImageTargets);
    const markdown = buildNormalizedMarkdown(snapshot.document);

    if (result.blocked) {
      return {
        schemaVersion: 1,
        status: 'blocked',
        snapshot,
        markdown,
        clipboard: null,
        html: null
      };
    }

    try {
      const inlined = await inlineCss(themeRootHtml(preparedHtml, snapshot.presentation), themeCss, fixedJuiceOptions);
      if (typeof inlined !== 'string') throw outputError('OUTPUT_GENERATION_FAILED');
      const canonical = parseSingleSection(inlined, { clean: true });
      const canonicalInlineBody = canonical.serialized;
      const fullHtml = buildFullHtml(snapshot.document, canonicalInlineBody);

      const clipboard = parseSingleSection(canonicalInlineBody);
      modifyHtmlStructure(clipboard.$);
      solveWeChatImage(clipboard.$);
      assertClipboardImages(clipboard.$);
      const correctedHtml = clipboard.$.root().html() || '';
      const corrected = parseSingleSection(correctedHtml);
      const plainText = buildPlainText(corrected.$);
      const clipboardHtml = `${createEmptyNode()}${corrected.serialized}${createEmptyNode()}`;

      return {
        schemaVersion: 1,
        status: 'ready',
        snapshot,
        markdown,
        clipboard: {
          html: { mimeType: 'text/html', content: clipboardHtml },
          plain: { mimeType: 'text/plain', content: plainText }
        },
        html: {
          mimeType: 'text/html;charset=utf-8',
          filename: `${safeOutputBaseName(snapshot.document.title)}.html`,
          content: fullHtml
        }
      };
    } catch {
      throw outputError('OUTPUT_GENERATION_FAILED');
    }
  };
}

export const buildTypesettingOutput = createTypesettingOutputBuilder();
