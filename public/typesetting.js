const $ = selector => document.querySelector(selector);
const fields = { title: $('#document-title'), author: $('#document-author'), account: $('#document-account'), publishedAt: $('#document-published-at'), body: $('#document-body') };
let documentModel = { title: '', author: '', account: '', publishedAt: '', body: '', revision: 0 };
let saveTimer;
let previewTimer;
let saving = false;
let dirty = false;
let changeVersion = 0;

function setStatus(status, message = '') { $('#save-status').textContent = status; $('#save-status').className = status === '未保存' ? 'unsaved' : ''; $('#save-message').textContent = message; }
function collect() { for (const [name, input] of Object.entries(fields)) documentModel[name] = input.value; }
async function preview() {
  const response = await fetch('/api/typesetting/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: documentModel.body }) });
  if (!response.ok) return;
  const rendered = await response.json();
  $('#preview').innerHTML = rendered.html || '<p class="preview-empty">正文为空</p>';
}
function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(() => { void preview(); }, 180); }
async function save() {
  clearTimeout(saveTimer); saveTimer = undefined;
  if (saving || !dirty) return;
  saving = true; dirty = false; collect(); setStatus('保存中');
  const version = changeVersion;
  const next = { ...documentModel, revision: documentModel.revision + 1 };
  let saved = false;
  try {
    const response = await fetch('/api/typesetting/document', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '保存失败');
    documentModel.revision = result.document.revision;
    saved = true;
    if (changeVersion === version) { documentModel = result.document; setStatus('已保存'); }
    else { dirty = true; setStatus('保存中'); }
  } catch { dirty = true; setStatus('未保存', '保存失败，请检查本机数据目录后继续编辑。'); }
  finally { saving = false; if (saved && dirty) void save(); }
}
function scheduleSave() { clearTimeout(saveTimer); setStatus('保存中'); saveTimer = setTimeout(() => { void save(); }, 500); }
for (const input of Object.values(fields)) input.addEventListener('input', () => { collect(); dirty = true; changeVersion++; schedulePreview(); scheduleSave(); });
document.addEventListener('visibilitychange', () => { if (dirty) void save(); });
async function start() { const response = await fetch('/api/typesetting/document'); if (response.ok) documentModel = (await response.json()).document; for (const [name, input] of Object.entries(fields)) input.value = documentModel[name] || ''; await preview(); }
void start();
