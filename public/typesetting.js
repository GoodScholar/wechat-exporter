const $ = selector => document.querySelector(selector);
const fields = { title: $('#document-title'), author: $('#document-author'), account: $('#document-account'), publishedAt: $('#document-published-at'), body: $('#document-body') };
const importForm = $('#article-import');
const importUrl = $('#import-url');
const importMessage = $('#import-message');
let documentModel = { title: '', author: '', account: '', publishedAt: '', body: '', revision: 0, savedAt: '' };
let saveTimer;
let previewTimer;
let saving = false;
let savingPromise;
let dirty = false;
let changeVersion = 0;
let previewVersion = 0;

function setStatus(status, message = '') { $('#save-status').textContent = status; $('#save-status').className = status === '未保存' ? 'unsaved' : ''; $('#save-message').textContent = message; }
function collect() { for (const [name, input] of Object.entries(fields)) documentModel[name] = input.value; }
function hasContent() { return Object.values(fields).some(input => input.value.trim()); }
function showImportMessage(error) {
  importMessage.textContent = [error.message, error.action].filter(Boolean).join(' ');
  if (error.code === 'IMAGE_MESSAGE' || error.code === 'UNSUPPORTED_MESSAGE') {
    importMessage.append(' ');
    const link = document.createElement('a');
    link.href = '/';
    link.textContent = '返回文章导出';
    importMessage.append(link);
  }
}
async function preview(version) {
  const response = await fetch('/api/typesetting/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: documentModel.body }) });
  if (!response.ok) return;
  const rendered = await response.json();
  if (version === previewVersion) $('#preview').innerHTML = rendered.html || '<p class="preview-empty">正文为空</p>';
}
function schedulePreview() { const version = ++previewVersion; clearTimeout(previewTimer); previewTimer = setTimeout(() => { void preview(version); }, 180); }
async function save() {
  clearTimeout(saveTimer); saveTimer = undefined;
  if (saving) return savingPromise;
  if (!dirty) return;
  saving = true; dirty = false; collect(); setStatus('保存中');
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
  while (saving || dirty) await (saving ? savingPromise : save());
}
for (const input of Object.values(fields)) input.addEventListener('input', () => { collect(); dirty = true; changeVersion++; schedulePreview(); scheduleSave(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && dirty) void save(); });
importForm.addEventListener('submit', async event => {
  event.preventDefault();
  const replacing = hasContent();
  if (replacing && !window.confirm('当前文稿已有内容，导入将替换现有文稿。是否继续？')) return;
  const button = importForm.querySelector('button');
  button.disabled = true;
  for (const input of Object.values(fields)) input.disabled = true;
  try {
    await flushSave();
    if (dirty) throw { message: '当前编辑尚未保存，请先处理保存错误后再导入。' };
    importMessage.textContent = '正在读取文章…';
    const response = await fetch('/api/typesetting/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: importUrl.value, revision: documentModel.revision, confirmed: replacing }) });
    const result = await response.json();
    if (!response.ok) throw result.error || { message: '导入失败，请重试。' };
    clearTimeout(saveTimer);
    dirty = false;
    documentModel = result.document;
    for (const [name, input] of Object.entries(fields)) input.value = documentModel[name] || '';
    schedulePreview();
    setStatus('已保存');
    importMessage.textContent = '文章已导入，可继续编辑。';
  } catch (error) { showImportMessage(error); }
  finally { button.disabled = false; for (const input of Object.values(fields)) input.disabled = false; }
});
async function start() { const response = await fetch('/api/typesetting/document'); if (response.ok) documentModel = (await response.json()).document; for (const [name, input] of Object.entries(fields)) input.value = documentModel[name] || ''; void preview(++previewVersion); }
void start();
