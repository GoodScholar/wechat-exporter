const $ = selector => document.querySelector(selector);
const fields = { title: $('#document-title'), author: $('#document-author'), account: $('#document-account'), publishedAt: $('#document-published-at'), body: $('#document-body') };
const themeControls = { theme: $('#document-theme'), primaryColor: $('#theme-primary-color'), fontSize: $('#theme-font-size'), lineHeight: $('#theme-line-height'), blockSpacing: $('#theme-block-spacing'), reset: $('#reset-theme') };
const convertExternalLinks = $('#convert-external-links');
const importForm = $('#article-import');
const importUrl = $('#import-url');
const importMessage = $('#import-message');
const renderStatus = $('#render-status');
const formatChecks = $('#format-checks');
const themeNames = [...themeControls.theme.options].map(option => option.value);
const themeSettingNames = ['primaryColor', 'fontSize', 'lineHeight', 'blockSpacing'];
const documentKeys = [...Object.keys(fields), 'revision', 'savedAt', 'theme', 'themeSettings', 'convertExternalLinksToFootnotes'];
const severityNames = ['blocker', 'conversion', 'advisory'];
const safeRemovedTypes = ['script', 'style', 'form', 'event-handler', 'unsafe-url'];
const specialContentTypes = ['video', 'audio', 'embed', 'mini-program', 'poll'];
const imageDiagnosticCodes = ['IMAGE_LOAD_FAILED', 'IMAGE_UNSUPPORTED_SCHEME', 'IMAGE_LOCAL_PATH', 'IMAGE_LOCAL_BINARY', 'IMAGE_MISSING_SOURCE'];
const defaultThemeSettings = () => Object.fromEntries(['default', 'grace', 'simple'].map(theme => [theme, { primaryColor: '#0F4C81', fontSize: '16px', lineHeight: '1.75', blockSpacing: '1' }]));
let documentModel = { title: '', author: '', account: '', publishedAt: '', body: '', revision: 0, savedAt: '', theme: 'default', themeSettings: defaultThemeSettings(), convertExternalLinksToFootnotes: false };
let saveTimer;
let previewTimer;
let saving = false;
let savingPromise;
let saveError;
let dirty = false;
let changeVersion = 0;
let previewVersion = 0;
let appliedRenderVersion = 0;
let renderFresh = false;
let renderBlocked = false;
let staticDiagnostics = [];
let dynamicImageDiagnostics = [];
let dynamicImageDiagnosticSequence = 0;
const pendingImageHandlers = new WeakMap();
let richPastePending = false;
let richPasteVersion = 0;
let activeRichPaste;

function setStatus(status, message = '') { $('#save-status').textContent = status; $('#save-status').className = status === '未保存' ? 'unsaved' : ''; $('#save-message').textContent = message; }
function collect() { for (const [name, input] of Object.entries(fields)) documentModel[name] = input.value; documentModel.convertExternalLinksToFootnotes = convertExternalLinks.checked; }
function currentThemeSettings() { return documentModel.themeSettings[documentModel.theme]; }
function hasExactKeys(value, keys) { return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function isKnownOption(control, value) { return [...control.options].some(option => option.value === value); }
function isCompleteThemeSettings(themeSettings) {
  return hasExactKeys(themeSettings, themeNames) && themeNames.every(theme => hasExactKeys(themeSettings[theme], themeSettingNames)
    && themeSettingNames.every(name => isKnownOption(themeControls[name], themeSettings[theme][name])));
}
function isCompleteDocument(document) {
  return hasExactKeys(document, documentKeys) && Object.keys(fields).every(name => typeof document[name] === 'string')
    && Number.isSafeInteger(document.revision) && document.revision >= 0 && typeof document.savedAt === 'string'
    && isKnownOption(themeControls.theme, document.theme) && isCompleteThemeSettings(document.themeSettings)
    && typeof document.convertExternalLinksToFootnotes === 'boolean';
}
function isValidPresentation(presentation) {
  return hasExactKeys(presentation, ['theme', 'settings']) && isKnownOption(themeControls.theme, presentation.theme)
    && hasExactKeys(presentation.settings, themeSettingNames)
    && themeSettingNames.every(name => isKnownOption(themeControls[name], presentation.settings[name]));
}
function isNonEmptyString(value) { return typeof value === 'string' && value.length > 0; }
function isPositiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function isSourceTarget(target, body) {
  return hasExactKeys(target, ['kind', 'start', 'end']) && target.kind === 'source'
    && Number.isSafeInteger(target.start) && target.start >= 0
    && Number.isSafeInteger(target.end) && target.start <= target.end && target.end <= body.length;
}
function isPreviewTarget(target, detachedPreview) {
  if (!hasExactKeys(target, ['kind', 'id']) || target.kind !== 'preview' || !isNonEmptyString(target.id)) return false;
  return [...detachedPreview.querySelectorAll('[data-format-target]')]
    .filter(node => node.getAttribute('data-format-target') === target.id).length === 1;
}
function hasValidTargets(diagnostic, body, detachedPreview, kind, count) {
  if (!Array.isArray(diagnostic.targets) || diagnostic.targets.length === 0) return false;
  if (count !== undefined && diagnostic.targets.length !== count) return false;
  if (!diagnostic.targets.every(target => kind === 'source' ? isSourceTarget(target, body) : isPreviewTarget(target, detachedPreview))) return false;
  const targetKeys = diagnostic.targets.map(target => target.kind === 'source'
    ? `source:${target.start}:${target.end}`
    : `preview:${target.id}`);
  return new Set(targetKeys).size === targetKeys.length;
}
function hasOrderedUniqueValues(values, allowed) {
  return Array.isArray(values) && values.length > 0 && new Set(values).size === values.length
    && values.every(value => allowed.includes(value))
    && values.every((value, index) => index === 0 || allowed.indexOf(values[index - 1]) < allowed.indexOf(value));
}
function isValidDiagnostic(diagnostic, body, detachedPreview) {
  if (typeof diagnostic !== 'object' || diagnostic === null || Array.isArray(diagnostic)
    || !isNonEmptyString(diagnostic.id) || !isNonEmptyString(diagnostic.message)) return false;
  const baseKeys = ['id', 'code', 'severity', 'message', 'targets'];
  if (diagnostic.code === 'EMPTY_BODY') {
    return hasExactKeys(diagnostic, baseKeys) && diagnostic.severity === 'blocker'
      && body.trim() === '' && hasValidTargets(diagnostic, body, detachedPreview, 'source', 1)
      && diagnostic.targets[0].start === 0 && diagnostic.targets[0].end === 0;
  }
  if (diagnostic.code === 'RENDER_FAILED') {
    return hasExactKeys(diagnostic, baseKeys) && diagnostic.severity === 'blocker'
      && hasValidTargets(diagnostic, body, detachedPreview, 'source', 1)
      && diagnostic.targets[0].start === 0 && diagnostic.targets[0].end === body.length;
  }
  if (diagnostic.code === 'EXTERNAL_LINK_TO_FOOTNOTE') {
    return hasExactKeys(diagnostic, [...baseKeys, 'meta']) && diagnostic.severity === 'conversion'
      && hasValidTargets(diagnostic, body, detachedPreview, 'preview')
      && hasExactKeys(diagnostic.meta, ['footnote', 'occurrences'])
      && isPositiveInteger(diagnostic.meta.footnote) && diagnostic.meta.occurrences === diagnostic.targets.length;
  }
  if (diagnostic.code === 'SPECIAL_CONTENT_PLACEHOLDER') {
    return hasExactKeys(diagnostic, [...baseKeys, 'meta']) && diagnostic.severity === 'conversion'
      && hasValidTargets(diagnostic, body, detachedPreview, 'preview', 1)
      && hasExactKeys(diagnostic.meta, ['type']) && specialContentTypes.includes(diagnostic.meta.type);
  }
  if (diagnostic.code === 'UNSAFE_RICH_TEXT_REMOVED') {
    return hasExactKeys(diagnostic, [...baseKeys, 'meta']) && diagnostic.severity === 'conversion'
      && hasValidTargets(diagnostic, body, detachedPreview, 'source', 1)
      && hasExactKeys(diagnostic.meta, ['types']) && hasOrderedUniqueValues(diagnostic.meta.types, safeRemovedTypes);
  }
  if (imageDiagnosticCodes.includes(diagnostic.code)) {
    return hasExactKeys(diagnostic, baseKeys) && diagnostic.severity === 'advisory'
      && hasValidTargets(diagnostic, body, detachedPreview, 'preview', 1);
  }
  return false;
}
function isValidRenderResult(value, body, detachedPreview) {
  if (!hasExactKeys(value, ['html', 'presentation', 'diagnostics', 'blocked'])
    || typeof value.html !== 'string' || !isValidPresentation(value.presentation)
    || !Array.isArray(value.diagnostics) || typeof value.blocked !== 'boolean') return false;
  if (value.diagnostics.some(item => !isValidDiagnostic(item, body, detachedPreview))) return false;
  if (new Set(value.diagnostics.map(item => item.id)).size !== value.diagnostics.length) return false;
  return value.blocked === value.diagnostics.some(item => item.severity === 'blocker');
}
function syncThemeControls() {
  themeControls.theme.value = documentModel.theme;
  for (const name of themeSettingNames) themeControls[name].value = currentThemeSettings()[name];
}
function applyPresentation(preview, presentation) {
  preview.classList.remove(...[...preview.classList].filter(name => name.startsWith('typeset-theme-')));
  preview.classList.add(`typeset-theme-${presentation.theme}`);
  preview.style.setProperty('--md-primary-color', presentation.settings.primaryColor);
  preview.style.setProperty('--md-font-size', presentation.settings.fontSize);
  preview.style.setProperty('--md-line-height', presentation.settings.lineHeight);
  preview.style.setProperty('--md-block-spacing', presentation.settings.blockSpacing);
}
function hydrateDocument(document) {
  if (!isCompleteDocument(document)) return false;
  documentModel = document;
  return true;
}
function hasContent() { return Object.values(fields).some(input => input.value.trim()); }
function showImportMessage(error) {
  const details = typeof error === 'string' ? { message: error } : error || {};
  importMessage.textContent = [details.message || '导入失败，请重试。', details.action].filter(Boolean).join(' ');
  if (details.code === 'IMAGE_MESSAGE' || details.code === 'UNSUPPORTED_MESSAGE') {
    importMessage.append(' ');
    const link = document.createElement('a');
    link.href = '/';
    link.textContent = '返回文章导出';
    importMessage.append(link);
  }
}
function renderSnapshot() {
  return Object.freeze({
    body: documentModel.body,
    theme: documentModel.theme,
    settings: Object.freeze({ ...currentThemeSettings() }),
    convertExternalLinksToFootnotes: documentModel.convertExternalLinksToFootnotes
  });
}
function sameRenderInput(left, right) {
  return left.body === right.body && left.theme === right.theme
    && left.convertExternalLinksToFootnotes === right.convertExternalLinksToFootnotes
    && themeSettingNames.every(name => left.settings[name] === right.settings[name]);
}
function isCurrentRenderRequest(version, snapshot) { return version === previewVersion && sameRenderInput(snapshot, renderSnapshot()); }
function syncRenderStatus(state) {
  renderStatus.dataset.state = state;
  renderStatus.dataset.blocked = renderFresh ? String(renderBlocked) : 'unknown';
  renderStatus.textContent = state === 'checking' ? '正在重新检查'
    : state === 'stale' ? '预览不是当前内容'
      : renderBlocked ? '检查完成，存在阻断问题' : '检查完成';
  formatChecks.setAttribute('aria-busy', state === 'checking' ? 'true' : 'false');
  formatChecks.setAttribute('aria-disabled', renderFresh ? 'false' : 'true');
}
function markRenderChecking() { renderFresh = false; syncRenderStatus('checking'); }
function markRenderStale() { renderFresh = false; syncRenderStatus('stale'); }
function focusDiagnostic(diagnostic, version) {
  if (!renderFresh || version !== appliedRenderVersion) return;
  const target = diagnostic.targets[0];
  if (target.kind === 'source') {
    fields.body.focus();
    fields.body.setSelectionRange(target.start, target.end);
    return;
  }
  const matches = [...$('#preview').querySelectorAll('[data-format-target]')]
    .filter(node => node.getAttribute('data-format-target') === target.id);
  if (matches.length !== 1) return;
  const node = matches[0];
  $('#preview').querySelectorAll('.format-target-highlight').forEach(item => item.classList.remove('format-target-highlight'));
  node.scrollIntoView({ block: 'center', behavior: 'auto' });
  node.focus({ preventScroll: true });
  node.classList.add('format-target-highlight');
  setTimeout(() => node.classList.remove('format-target-highlight'), 1600);
}
function renderDiagnosticGroups(version) {
  const allDiagnostics = [...staticDiagnostics, ...dynamicImageDiagnostics];
  for (const severity of severityNames) {
    const group = formatChecks.querySelector(`[data-check-severity="${severity}"]`);
    const diagnostics = allDiagnostics.filter(item => item.severity === severity);
    group.querySelector('[data-check-count]').textContent = String(diagnostics.length);
    const list = group.querySelector('[data-check-list]');
    const fragment = document.createDocumentFragment();
    if (diagnostics.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'format-check-empty';
      empty.textContent = '暂无';
      fragment.append(empty);
    } else {
      for (const diagnostic of diagnostics) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'format-check-item';
        button.dataset.diagnosticId = diagnostic.id;
        button.textContent = diagnostic.message;
        button.addEventListener('click', () => focusDiagnostic(diagnostic, version));
        fragment.append(button);
      }
    }
    list.replaceChildren(fragment);
  }
}
function removePendingImageHandlers(img) {
  const handlers = pendingImageHandlers.get(img);
  if (!handlers) return;
  img.removeEventListener('load', handlers.load);
  img.removeEventListener('error', handlers.error);
  pendingImageHandlers.delete(img);
}
function isCurrentPendingImage(img, previewRoot, version) {
  if (!renderFresh || version !== appliedRenderVersion || version !== previewVersion
    || previewRoot !== $('#preview') || !previewRoot.contains(img)
    || img.getAttribute('data-image-state') !== 'pending') return false;
  const target = img.getAttribute('data-format-target');
  if (!target) return false;
  const matches = [...previewRoot.querySelectorAll('[data-format-target]')]
    .filter(node => node.getAttribute('data-format-target') === target);
  return matches.length === 1 && matches[0] === img;
}
function nextDynamicImageDiagnosticId(version) {
  const used = new Set([...staticDiagnostics, ...dynamicImageDiagnostics].map(item => item.id));
  let id;
  do id = `runtime-image-load-failed-${version}-${++dynamicImageDiagnosticSequence}`;
  while (used.has(id));
  return id;
}
function settleImage(img, previewRoot, version, failed = false) {
  if (!isCurrentPendingImage(img, previewRoot, version)) {
    removePendingImageHandlers(img);
    return;
  }
  if (!failed && img.naturalWidth > 0) {
    removePendingImageHandlers(img);
    img.setAttribute('data-image-state', 'loaded');
    return;
  }
  if (!failed && !img.complete) return;

  const target = img.getAttribute('data-format-target');
  removePendingImageHandlers(img);
  const placeholder = document.createElement('figure');
  placeholder.className = 'format-image-placeholder';
  placeholder.setAttribute('data-image-state', 'load-failed');
  placeholder.setAttribute('data-format-target', target);
  placeholder.setAttribute('role', 'note');
  placeholder.tabIndex = 0;
  const caption = document.createElement('figcaption');
  caption.textContent = '图片加载失败。请检查图片地址后重试。';
  placeholder.append(caption);
  img.replaceWith(placeholder);
  dynamicImageDiagnostics.push({
    id: nextDynamicImageDiagnosticId(version),
    code: 'IMAGE_LOAD_FAILED',
    severity: 'advisory',
    message: '图片加载失败，请检查图片地址后重试。',
    targets: [{ kind: 'preview', id: target }]
  });
  renderDiagnosticGroups(version);
}
function attachPendingImageHandlers(previewRoot, version) {
  for (const img of previewRoot.querySelectorAll('img[data-image-state="pending"]')) {
    if (pendingImageHandlers.has(img)) continue;
    const handlers = {
      load: () => settleImage(img, previewRoot, version),
      error: () => settleImage(img, previewRoot, version, true)
    };
    pendingImageHandlers.set(img, handlers);
    img.addEventListener('load', handlers.load);
    img.addEventListener('error', handlers.error);
    if (img.complete) settleImage(img, previewRoot, version, img.naturalWidth === 0);
  }
}
function applyRenderResult(rendered, detachedPreview, version) {
  const currentPreview = $('#preview');
  const nextPreview = currentPreview.cloneNode(false);
  nextPreview.replaceChildren(...detachedPreview.childNodes);
  applyPresentation(nextPreview, rendered.presentation);
  staticDiagnostics = rendered.diagnostics;
  dynamicImageDiagnostics = [];
  renderBlocked = rendered.blocked;
  appliedRenderVersion = version;
  renderFresh = true;
  currentPreview.replaceWith(nextPreview);
  renderDiagnosticGroups(version);
  syncRenderStatus('current');
  attachPendingImageHandlers(nextPreview, version);
}
async function preview(version, snapshot) {
  try {
    const response = await fetch('/api/typesetting/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot) });
    if (!response.ok) {
      if (isCurrentRenderRequest(version, snapshot)) markRenderStale();
      return;
    }
    const rendered = await response.json();
    if (!isCurrentRenderRequest(version, snapshot)) return;
    const inertPreview = document.createElement('template');
    inertPreview.innerHTML = typeof rendered?.html === 'string' ? rendered.html : '';
    if (!isValidRenderResult(rendered, snapshot.body, inertPreview.content)) { markRenderStale(); return; }
    applyRenderResult(rendered, inertPreview.content, version);
  } catch {
    if (isCurrentRenderRequest(version, snapshot)) markRenderStale();
  }
}
function schedulePreview() {
  markRenderChecking();
  const version = ++previewVersion;
  const snapshot = renderSnapshot();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => { void preview(version, snapshot); }, 180);
}
async function save() {
  clearTimeout(saveTimer); saveTimer = undefined;
  if (saving) return savingPromise;
  if (!dirty) return;
  saving = true; dirty = false; collect(); setStatus('保存中');
  saveError = undefined;
  const version = changeVersion;
  const next = { ...documentModel, revision: documentModel.revision + 1 };
  let saved = false;
  savingPromise = (async () => { try {
    const response = await fetch('/api/typesetting/document', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || '保存失败'); error.status = response.status; throw error; }
    if (!isCompleteDocument(result.document)) throw new Error('服务返回了不完整的文稿。');
    documentModel.revision = result.document.revision;
    saved = true;
    if (changeVersion === version) { hydrateDocument(result.document); setStatus('已保存'); }
    else { dirty = true; setStatus('保存中'); }
  } catch (error) {
    saveError = error;
    dirty = true;
    setStatus('未保存', error.status === 409
      ? '文稿已在其他页面更新。请复制当前内容后重新载入页面，再决定如何合并。'
      : '保存失败，请检查本机数据目录后继续编辑。');
  } finally { saving = false; if (saved && dirty) void save(); } })();
  return savingPromise;
}
function scheduleSave() { clearTimeout(saveTimer); setStatus('未保存'); saveTimer = setTimeout(() => { void save(); }, 500); }
async function flushSave() {
  clearTimeout(saveTimer);
  while (saving || dirty) {
    await (saving ? savingPromise : save());
    if (saveError) return false;
  }
  return true;
}
for (const input of Object.values(fields)) input.addEventListener('input', () => { saveError = undefined; collect(); dirty = true; changeVersion++; schedulePreview(); scheduleSave(); });
convertExternalLinks.addEventListener('change', () => {
  documentModel.convertExternalLinksToFootnotes = convertExternalLinks.checked;
  saveError = undefined; dirty = true; changeVersion++; schedulePreview(); scheduleSave();
});
themeControls.theme.addEventListener('change', () => {
  documentModel.theme = themeControls.theme.value;
  syncThemeControls();
  saveError = undefined; dirty = true; changeVersion++; schedulePreview(); scheduleSave();
});
for (const name of themeSettingNames) themeControls[name].addEventListener('change', () => {
  currentThemeSettings()[name] = themeControls[name].value;
  saveError = undefined; dirty = true; changeVersion++; schedulePreview(); scheduleSave();
});
themeControls.reset.addEventListener('click', () => {
  documentModel.themeSettings[documentModel.theme] = defaultThemeSettings()[documentModel.theme];
  syncThemeControls();
  saveError = undefined; dirty = true; changeVersion++; schedulePreview(); scheduleSave();
});
function showRichTextMessage(message = '') { $('#rich-text-message').textContent = message; }
function richTextError(error) {
  const details = error || {};
  return [details.message || '富文本转换失败，请重试。', details.action].filter(Boolean).join(' ');
}
function preserveBlockBoundaries(markdown, snapshot, block) {
  if (!block && !/\n\s*\n|(^|\n)(?:#{1,6}\s|[-*+]\s|\d+\.\s|>|\||```)/.test(markdown)) return markdown;
  const before = snapshot.body.slice(0, snapshot.start);
  const after = snapshot.body.slice(snapshot.end);
  const beforeNewlines = before.match(/\n*$/)[0].length;
  const afterNewlines = after.match(/^\n*/)[0].length;
  return `${before ? '\n'.repeat(Math.max(0, 2 - beforeNewlines)) : ''}${markdown}${after ? '\n'.repeat(Math.max(0, 2 - afterNewlines)) : ''}`;
}
function noteSelectionChange() {
  if (activeRichPaste && (fields.body.selectionStart !== activeRichPaste.start || fields.body.selectionEnd !== activeRichPaste.end)) activeRichPaste.selectionChanged = true;
}
for (const method of ['setSelectionRange', 'select']) {
  const native = fields.body[method].bind(fields.body);
  fields.body[method] = (...args) => {
    const result = native(...args);
    noteSelectionChange();
    return result;
  };
}
for (const property of ['selectionStart', 'selectionEnd']) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, property);
  if (!descriptor) continue;
  Object.defineProperty(fields.body, property, {
    configurable: true,
    get: () => descriptor.get.call(fields.body),
    set: value => { descriptor.set.call(fields.body, value); noteSelectionChange(); }
  });
}
fields.body.addEventListener('select', noteSelectionChange);
document.addEventListener('selectionchange', noteSelectionChange);
fields.body.addEventListener('paste', async event => {
  const html = event.clipboardData?.getData('text/html')?.trim();
  if (!html) return;
  event.preventDefault();
  if (richPastePending) { showRichTextMessage('正在转换上一段富文本，请稍后再试。'); return; }
  if (!window.confirm('检测到富文本，将转换为 Markdown 后插入当前选区。是否继续？')) return;
  const snapshot = { body: fields.body.value, start: fields.body.selectionStart, end: fields.body.selectionEnd, changeVersion, request: ++richPasteVersion, selectionChanged: false };
  activeRichPaste = snapshot;
  richPastePending = true;
  showRichTextMessage('正在安全转换富文本…');
  try {
    const response = await fetch('/api/typesetting/rich-text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html }) });
    const result = await response.json();
    if (!response.ok) throw result.error;
    if (snapshot.request !== richPasteVersion || snapshot.selectionChanged || changeVersion !== snapshot.changeVersion || fields.body.value !== snapshot.body || fields.body.selectionStart !== snapshot.start || fields.body.selectionEnd !== snapshot.end) {
      showRichTextMessage('正文或选区已变化，请重新粘贴后重试。');
      return;
    }
    const markdown = preserveBlockBoundaries(result.markdown, snapshot, result.block);
    fields.body.focus();
    fields.body.setSelectionRange(snapshot.start, snapshot.end);
    if (!document.execCommand('insertText', false, markdown)) throw { message: '浏览器无法安全插入转换后的富文本。', action: '请复制 Markdown 后手动粘贴。' };
    showRichTextMessage(`已转换富文本${result.removed.length ? `，移除 ${result.removed.length} 项` : ''}${result.downgraded.length ? `，降级 ${result.downgraded.length} 项特殊内容` : ''}。`);
  } catch (error) { showRichTextMessage(richTextError(error)); }
  finally { if (activeRichPaste === snapshot) activeRichPaste = undefined; richPastePending = false; }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && dirty) void save(); });
importForm.addEventListener('submit', async event => {
  event.preventDefault();
  const replacing = hasContent();
  if (replacing && !window.confirm('当前文稿已有内容，导入将替换现有文稿。是否继续？')) return;
  const button = importForm.querySelector('button');
  button.disabled = true;
  convertExternalLinks.disabled = true;
  for (const input of Object.values(fields)) input.disabled = true;
  for (const control of Object.values(themeControls)) control.disabled = true;
  try {
    if (!await flushSave()) throw { message: '当前编辑未能保存，未开始导入。', action: '检查数据目录后继续编辑或重试保存。' };
    importMessage.textContent = '正在读取文章…';
    const response = await fetch('/api/typesetting/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: importUrl.value, revision: documentModel.revision, confirmed: replacing }) });
    const result = await response.json();
    if (!response.ok) throw result.error || { message: '导入失败，请重试。' };
    clearTimeout(saveTimer);
    dirty = false;
    if (!hydrateDocument(result.document)) throw { message: '服务返回了不完整的文稿。', action: '请重新载入页面后重试。' };
    for (const [name, input] of Object.entries(fields)) input.value = documentModel[name] || '';
    convertExternalLinks.checked = documentModel.convertExternalLinksToFootnotes;
    syncThemeControls();
    schedulePreview();
    setStatus('已保存');
    importMessage.textContent = '文章已导入，可继续编辑。';
  } catch (error) { showImportMessage(error); }
  finally { button.disabled = false; convertExternalLinks.disabled = false; for (const input of Object.values(fields)) input.disabled = false; for (const control of Object.values(themeControls)) control.disabled = false; }
});
async function start() {
  try {
    const response = await fetch('/api/typesetting/document');
    if (response.ok) hydrateDocument((await response.json()).document);
  } catch { /* Keep the complete default document and continue with an initial render. */ }
  for (const [name, input] of Object.entries(fields)) input.value = documentModel[name] || '';
  convertExternalLinks.checked = documentModel.convertExternalLinksToFootnotes;
  syncThemeControls();
  markRenderChecking();
  const version = ++previewVersion;
  void preview(version, renderSnapshot());
}
void start();
