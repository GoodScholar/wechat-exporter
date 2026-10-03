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
  ...blockPlainTextTags, 'body', 'table', 'tbody', 'tfoot', 'thead', 'tr'
]);
const inlinePlainTextTags = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'img', 'kbd', 'mark', 'q', 'rb', 'rp', 'rt',
  'rtc', 'ruby', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var'
]);
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

function hasOnlyFiniteCssNumbers(value) {
  const numbers = value.match(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/gu) || [];
  return numbers.every(number => Number.isFinite(Number(number)));
}

function createThemeStyleContract(presentation) {
  const contract = new Map();
  const allow = (tagName, declarations) => {
    let tag = contract.get(tagName);
    if (!tag) {
      tag = new Map();
      contract.set(tagName, tag);
    }
    for (const [property, rawValues] of Object.entries(declarations)) {
      const values = Array.isArray(rawValues) ? rawValues : [rawValues];
      const allowed = tag.get(property) || new Set();
      for (const value of values) allowed.add(value);
      tag.set(property, allowed);
    }
  };
  const { theme, settings } = presentation;
  const primary = settings.primaryColor;
  const spacing = settings.blockSpacing;
  const scaled = value => `calc(${value}em * ${spacing})`;

  allow('section', {
    color: '#25332b',
    font: `${settings.fontSize}/${settings.lineHeight} 'PingFang SC', 'Microsoft YaHei', sans-serif`,
    'overflow-wrap': 'anywhere'
  });
  allow('img', { display: 'block', 'max-width': '100%', height: 'auto' });
  allow('pre', { overflow: 'auto' });
  allow('table', { width: '100%', 'border-collapse': 'collapse' });

  if (theme === 'default') {
    allow('h1', { display: 'table', margin: `${scaled('2')} auto ${scaled('1')}`, padding: '0 1em', 'border-bottom': `2px solid ${primary}`, color: primary, 'font-size': '1.35em', 'text-align': 'center' });
    allow('h2', { display: 'table', margin: `${scaled('2.5')} auto ${scaled('1')}`, padding: '.15em .5em', background: primary, color: '#fff', 'font-size': '1.25em' });
    allow('h3', { margin: `${scaled('2')} 0 ${scaled('.75')}`, 'padding-left': '8px', 'border-left': `3px solid ${primary}`, 'font-size': '1.12em' });
    allow('p', { margin: [`${scaled('1.25')} 8px`, '0'], 'letter-spacing': '.06em' });
    for (const tag of ['ul', 'ol']) allow(tag, { margin: `${scaled('1')} 0`, 'padding-left': '1.5em' });
    allow('blockquote', { margin: `${scaled('1')} 0`, padding: '1em', 'border-left': `4px solid ${primary}`, background: '#f3f7f4' });
    allow('img', { margin: `${scaled('.5')} auto`, 'border-radius': '4px' });
    allow('a', { color: '#576b95', 'text-decoration': 'none' });
    allow('code', { padding: '2px 4px', background: '#f1f3f1', color: primary });
    allow('pre', { margin: `${scaled('1')} 0`, padding: '12px', background: '#f1f3f1' });
    allow('hr', { margin: `${scaled('2')} 0`, border: '0', 'border-top': '1px solid #d7e0d9' });
    for (const tag of ['th', 'td']) allow(tag, { padding: '6px', border: '1px solid #d7e0d9' });
  } else if (theme === 'grace') {
    allow('h1', { margin: `${scaled('2')} 0 ${scaled('1')}`, 'padding-bottom': '.35em', 'border-bottom': `1px solid ${primary}`, color: primary, 'font-size': '1.45em', 'text-align': 'center' });
    allow('h2', { margin: `${scaled('2')} 0 ${scaled('.9')}`, color: primary, 'font-size': '1.25em' });
    allow('h3', { margin: `${scaled('1.6')} 0 ${scaled('.7')}`, color: '#44504a', 'font-size': '1.1em' });
    allow('p', { margin: [`${scaled('1.15')} 0`, '0'], 'letter-spacing': '.04em' });
    for (const tag of ['ul', 'ol']) allow(tag, { margin: `${scaled('1')} 0`, 'padding-left': '1.5em' });
    allow('blockquote', { margin: `${scaled('1.2')} 0`, padding: '.8em 1em', 'border-left': `3px solid ${primary}`, background: '#f7f7f5', color: '#5b625d' });
    allow('img', { margin: `${scaled('.8')} auto`, 'border-radius': '2px' });
    allow('a', { color: primary, 'text-decoration': 'underline', 'text-underline-offset': '.15em' });
    allow('code', { padding: '2px 4px', background: '#f5f5f2', color: '#7a4d2d' });
    allow('pre', { margin: `${scaled('1')} 0`, padding: '12px', background: '#f5f5f2' });
    allow('hr', { margin: `${scaled('2')} 0`, border: '0', 'border-top': '1px solid #d9d7d1' });
    for (const tag of ['th', 'td']) allow(tag, { padding: '6px', border: '1px solid #d9d7d1' });
  } else {
    allow('h1', { margin: `${scaled('1.8')} 0 ${scaled('.8')}`, 'padding-left': '.6em', 'border-left': `5px solid ${primary}`, color: '#222', 'font-size': '1.4em' });
    allow('h2', { margin: `${scaled('1.6')} 0 ${scaled('.7')}`, 'padding-bottom': '.25em', 'border-bottom': `2px solid ${primary}`, color: '#222', 'font-size': '1.2em' });
    allow('h3', { margin: `${scaled('1.4')} 0 ${scaled('.6')}`, color: '#333', 'font-size': '1.08em' });
    allow('p', { margin: [`${scaled('1')} 0`, '0'] });
    for (const tag of ['ul', 'ol']) allow(tag, { margin: `${scaled('.9')} 0`, 'padding-left': '1.4em' });
    allow('blockquote', { margin: `${scaled('1')} 0`, padding: '.6em .9em', 'border-left': '4px solid #c9c9c9', color: '#666' });
    allow('img', { margin: `${scaled('.6')} auto` });
    allow('a', { color: primary, 'text-decoration': 'none', 'border-bottom': '1px solid currentColor' });
    allow('code', { padding: '2px 4px', background: '#f3f3f3', color: '#333' });
    allow('pre', { margin: `${scaled('1')} 0`, padding: '12px', background: '#f3f3f3' });
    allow('hr', { margin: `${scaled('1.6')} 0`, border: '0', 'border-top': '1px solid #ddd' });
    for (const tag of ['th', 'td']) allow(tag, { padding: '6px', border: '1px solid #ddd' });
  }
  return contract;
}

function hasSafeStyleValue(styleContract, tagName, property, value) {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f\\{};<>@!]/u.test(value)
    || /(?:url\s*\(|@import|expression|javascript\s*:|data\s*:|blob\s*:|var\s*\(|env\s*\(|attr\s*\(|behavior)/iu.test(value)
    || !/^[\p{L}\p{N}\s#.,'"%+\-*/()]+$/u.test(value)
    || !hasOnlyFiniteCssNumbers(value)) return false;
  return Boolean(styleContract.get(tagName)?.get(property)?.has(value));
}

function normalizeStyle(style, { removeVariables = false, tagName, isRoot = false, styleContract } = {}) {
  const normalized = [];
  const seen = new Set();
  const tagContract = tagName === 'section' && !isRoot ? undefined : styleContract.get(tagName);
  for (const declaration of splitStyleDeclarations(style)) {
    const separator = declaration.indexOf(':');
    if (separator <= 0) throw outputError('OUTPUT_GENERATION_FAILED');
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (removeVariables && property.startsWith('--')) continue;
    if (!allowedStyleProperties.has(property) || !tagContract?.has(property)
      || seen.has(property) || !hasSafeStyleValue(styleContract, tagName, property, value)) {
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

function cleanCanonicalRuntimeAttributes($, styleContract) {
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
    const normalized = normalizeStyle(style, { removeVariables: true, tagName: element.tagName, isRoot: element === rootSection, styleContract });
    if (normalized) node.attr('style', normalized);
    else node.removeAttr('style');
  });
}

function validateSafeNodes($, styleContract) {
  const inspect = node => {
    if (node.type === 'text') return;
    if (node.type !== 'tag') throw outputError('OUTPUT_GENERATION_FAILED');
    const tagName = node.tagName.toLowerCase();
    if (!previewAllowedTagSet.has(tagName)) throw outputError('OUTPUT_GENERATION_FAILED');
    const allowedAttributes = allowedAttributesFor(tagName);
    for (const [name, value] of Object.entries(node.attribs)) {
      if (!allowedAttributes.has(name)) throw outputError('OUTPUT_GENERATION_FAILED');
      if (name === 'style' && normalizeStyle(value, { tagName, isRoot: node.parent?.type === 'root', styleContract }) !== value.replace(/;\s*$/u, '').trim()) {
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

function normalizedDom($, styleContract) {
  const normalizeNode = node => {
    if (node.type === 'text') return ['text', node.data || ''];
    if (node.type !== 'tag') return [node.type];
    return [
      'tag',
      node.tagName.toLowerCase(),
      Object.entries(node.attribs)
        .map(([name, value]) => [name, name === 'style'
          ? normalizeStyle(value, { tagName: node.tagName.toLowerCase(), isRoot: node.parent?.type === 'root', styleContract })
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

function assertSanitizerConsistency(html, $, styleContract) {
  let sanitized;
  try {
    sanitized = sanitizeHtml(html, finalSanitizerOptions);
  } catch {
    throw outputError('OUTPUT_GENERATION_FAILED');
  }
  const sanitizedDom = parseRenderedHtml(sanitized);
  if (JSON.stringify(normalizedDom($, styleContract)) !== JSON.stringify(normalizedDom(sanitizedDom, styleContract))) {
    throw outputError('OUTPUT_GENERATION_FAILED');
  }
}

function parseSingleSection(html, presentation, { clean = false } = {}) {
  const $ = parseRenderedHtml(html);
  const styleContract = createThemeStyleContract(presentation);
  const significantRoots = $.root().contents().toArray()
    .filter(node => !(node.type === 'text' && /^\s*$/u.test(node.data || '')));
  if (significantRoots.length !== 1 || significantRoots[0].type !== 'tag' || significantRoots[0].tagName !== 'section') {
    throw outputError('OUTPUT_GENERATION_FAILED');
  }
  if (clean) cleanCanonicalRuntimeAttributes($, styleContract);
  validateSafeNodes($, styleContract);
  const serialized = $.root().html() || '';
  assertSanitizerConsistency(serialized, $, styleContract);
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

function isPlainTextBlockNode(node) {
  if (node?.type !== 'tag') return false;
  const tagName = node.tagName.toLowerCase();
  return blockPlainTextTags.has(tagName) || tagName === 'ul' || tagName === 'ol' || tagName === 'table' || tagName === 'pre';
}

function renderInlinePlainText($, nodes, depth) {
  let output = '';
  for (const node of nodes) {
    if (isPlainTextBlockNode(node) && output && !output.endsWith('\n')) output += '\n';
    output += renderPlainTextNode($, node, depth);
  }
  return output;
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

function adjacentSemanticPlainNode(node, direction) {
  const siblings = node.parent?.children || [];
  for (let index = siblings.indexOf(node) + direction; index >= 0 && index < siblings.length; index += direction) {
    const sibling = siblings[index];
    if (sibling.type !== 'text' || /\S/u.test(sibling.data || '')) return sibling;
  }
  return undefined;
}

function inlineWhitespaceBetweenVisibleSiblings($, node) {
  return isVisibleInlinePlainNode($, adjacentSemanticPlainNode(node, -1))
    && isVisibleInlinePlainNode($, adjacentSemanticPlainNode(node, 1));
}

function renderPlainTextNode($, node, depth = 0) {
  if (node.type === 'text') {
    const raw = node.data || '';
    let value = raw.replace(/[\s\u00a0]+/gu, ' ');
    if (!value.trim() && structuralWhitespaceParents.has(node.parent?.tagName)) {
      return inlineWhitespaceBetweenVisibleSiblings($, node) ? ' ' : '';
    }
    if (value.trim() && structuralWhitespaceParents.has(node.parent?.tagName)) {
      const leadingWhitespace = /^[\s\u00a0]*/u.exec(raw)?.[0] || '';
      const trailingWhitespace = /[\s\u00a0]*$/u.exec(raw)?.[0] || '';
      const before = adjacentSemanticPlainNode(node, -1);
      const after = adjacentSemanticPlainNode(node, 1);
      if (/[\r\n]/u.test(leadingWhitespace) && (!before || isPlainTextBlockNode(before))) value = value.replace(/^ /u, '');
      if (/[\r\n]/u.test(trailingWhitespace) && (!after || isPlainTextBlockNode(after))) value = value.replace(/ $/u, '');
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
      const canonical = parseSingleSection(inlined, snapshot.presentation, { clean: true });
      const canonicalInlineBody = canonical.serialized;
      const fullHtml = buildFullHtml(snapshot.document, canonicalInlineBody);

      const clipboard = parseSingleSection(canonicalInlineBody, snapshot.presentation);
      modifyHtmlStructure(clipboard.$);
      solveWeChatImage(clipboard.$);
      assertClipboardImages(clipboard.$);
      const correctedHtml = clipboard.$.root().html() || '';
      const corrected = parseSingleSection(correctedHtml, snapshot.presentation);
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
