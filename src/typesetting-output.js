import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import juice from 'juice';
import { normalizeTypesettingPresentation } from './typesetting-presentation.js';
import { renderTypesettingMarkdown } from './typesetting-render.js';

const outputRequestKeys = Object.freeze(['document', 'presentation', 'convertExternalLinksToFootnotes', 'failedImageTargets']);
const outputDocumentKeys = Object.freeze(['title', 'author', 'account', 'publishedAt', 'body']);
const renderResultKeys = Object.freeze(['html', 'presentation', 'diagnostics', 'blocked']);
const themeSettingKeys = Object.freeze(['primaryColor', 'fontSize', 'lineHeight', 'blockSpacing']);
const imageDiagnosticCodes = Object.freeze(['IMAGE_UNSUPPORTED_SCHEME', 'IMAGE_LOCAL_PATH', 'IMAGE_LOCAL_BINARY', 'IMAGE_MISSING_SOURCE']);
const specialContentTypes = Object.freeze(['video', 'audio', 'embed', 'mini-program', 'poll']);
const imageAttributeKeys = Object.freeze(['src', 'alt', 'referrerpolicy', 'data-image-state', 'data-format-target']);
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
  if (typeof value.convertExternalLinksToFootnotes !== 'boolean' || !Array.isArray(value.failedImageTargets)) {
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
    || !Array.isArray(value.diagnostics)
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
  if (!Array.isArray(diagnostic.targets) || diagnostic.targets.length === 0) return false;
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
    } catch {
      throw outputError('OUTPUT_GENERATION_FAILED');
    }
    if (rendered && typeof rendered.then === 'function') {
      Promise.resolve(rendered).catch(() => {});
      throw outputError('OUTPUT_GENERATION_FAILED');
    }
    const result = validateRenderResult(rendered, snapshot.presentation);
    const $ = parseRenderedHtml(result.html);
    validateDiagnostics(result.diagnostics, snapshot.document.body, $);
    if (result.blocked !== result.diagnostics.some(item => item.severity === 'blocker')) {
      throw outputError('OUTPUT_GENERATION_FAILED');
    }
    prepareRenderedHtml($, snapshot.failedImageTargets);

    if (!result.blocked) throw outputError('OUTPUT_GENERATION_FAILED');
    return {
      schemaVersion: 1,
      status: 'blocked',
      snapshot,
      markdown: buildNormalizedMarkdown(snapshot.document),
      clipboard: null,
      html: null
    };
  };
}

export const buildTypesettingOutput = createTypesettingOutputBuilder();
