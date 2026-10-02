const $ = selector => document.querySelector(selector);
const fields = { title: $('#document-title'), author: $('#document-author'), account: $('#document-account'), publishedAt: $('#document-published-at'), body: $('#document-body') };
const themeControls = { theme: $('#document-theme'), primaryColor: $('#theme-primary-color'), fontSize: $('#theme-font-size'), lineHeight: $('#theme-line-height'), blockSpacing: $('#theme-block-spacing'), reset: $('#reset-theme') };
const importForm = $('#article-import');
const importUrl = $('#import-url');
const importMessage = $('#import-message');
const defaultThemeSettings = () => Object.fromEntries(['default', 'grace', 'simple'].map(theme => [theme, { primaryColor: '#0F4C81', fontSize: '16px', lineHeight: '1.75', blockSpacing: '1' }]));
let documentModel = { title: '', author: '', account: '', publishedAt: '', body: '', revision: 0, savedAt: '', theme: 'default', themeSettings: defaultThemeSettings() };
let saveTimer;
let previewTimer;
let saving = false;
let savingPromise;
let saveError;
let dirty = false;
let changeVersion = 0;
let previewVersion = 0;
let richPastePending = false;
let richPasteVersion = 0;
let activeRichPaste;

function setStatus(status, message = '') { $('#save-status').textContent = status; $('#save-status').className = status === '未保存' ? 'unsaved' : ''; $('#save-message').textContent = message; }
function collect() { for (const [name, input] of Object.entries(fields)) documentModel[name] = input.value; }
function currentThemeSettings() { return documentModel.themeSettings[documentModel.theme]; }
function syncThemeControls() {
  themeControls.theme.value = documentModel.theme;
  for (const name of ['primaryColor', 'fontSize', 'lineHeight', 'blockSpacing']) themeControls[name].value = currentThemeSettings()[name];
}
function applyPresentation(presentation) {
  const preview = $('#preview');
  preview.classList.remove(...[...preview.classList].filter(name => name.startsWith('typeset-theme-')));
  preview.classList.add(`typeset-theme-${presentation.theme}`);
  preview.style.setProperty('--md-primary-color', presentation.settings.primaryColor);
  preview.style.setProperty('--md-font-size', presentation.settings.fontSize);
  preview.style.setProperty('--md-line-height', presentation.settings.lineHeight);
  preview.style.setProperty('--md-block-spacing', presentation.settings.blockSpacing);
}
function hydrateDocument(document) {
  documentModel = { ...documentModel, ...document, theme: document.theme || 'default', themeSettings: document.themeSettings || defaultThemeSettings() };
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
async function preview(version) {
  const response = await fetch('/api/typesetting/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: documentModel.body, theme: documentModel.theme, settings: { ...currentThemeSettings() } }) });
  if (!response.ok) return;
  const rendered = await response.json();
  if (version === previewVersion) {
    $('#preview').innerHTML = rendered.html || '<p class="preview-empty">正文为空</p>';
    applyPresentation(rendered.presentation);
  }
}
function schedulePreview() { const version = ++previewVersion; clearTimeout(previewTimer); previewTimer = setTimeout(() => { void preview(version); }, 180); }
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
    documentModel.revision = result.document.revision;
    saved = true;
    if (changeVersion === version) { documentModel = result.document; setStatus('已保存'); }
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
themeControls.theme.addEventListener('change', () => {
  documentModel.theme = themeControls.theme.value;
  syncThemeControls();
  saveError = undefined; dirty = true; changeVersion++; schedulePreview(); scheduleSave();
});
for (const name of ['primaryColor', 'fontSize', 'lineHeight', 'blockSpacing']) themeControls[name].addEventListener('change', () => {
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
    hydrateDocument(result.document);
    for (const [name, input] of Object.entries(fields)) input.value = documentModel[name] || '';
    syncThemeControls();
    schedulePreview();
    setStatus('已保存');
    importMessage.textContent = '文章已导入，可继续编辑。';
  } catch (error) { showImportMessage(error); }
  finally { button.disabled = false; for (const input of Object.values(fields)) input.disabled = false; for (const control of Object.values(themeControls)) control.disabled = false; }
});
async function start() { const response = await fetch('/api/typesetting/document'); if (response.ok) hydrateDocument((await response.json()).document); for (const [name, input] of Object.entries(fields)) input.value = documentModel[name] || ''; syncThemeControls(); void preview(++previewVersion); }
void start();
