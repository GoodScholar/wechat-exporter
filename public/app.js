const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const formatName = { markdown: 'Markdown', html: 'HTML', pdf: 'PDF' };
let jobs = [];
let selectedId;
let lastSnapshot;
let submitting = false;
let settingsLoaded = false;

function notify(message, error = false) {
  $('#notice').textContent = message;
  $('#notice').className = 'notice' + (error ? ' error' : '');
  $('#notice').hidden = false;
}

function notifyDownload() {
  notify('已请求浏览器下载。请在浏览器下载列表中查看保存位置；如出现保存对话框，请选择目标文件夹。工具自动保存的原文件仍在下方显示的文件夹中。');
}

async function api(url, body) {
  const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败，请重试');
  return result;
}

function itemWarnings(item) { return item.warnings || []; }
function isDownloadable(item) { return item.downloadable === true || item.status === 'success'; }
function progressText(progress) {
  if (!progress) return '';
  if (progress.stage === 'fetch') return '正在读取文章正文';
  if (progress.stage === 'images') return `正在下载图片 ${progress.completed ?? 0}/${progress.total ?? 0}`;
  if (progress.stage === 'format') return `正在生成 ${formatName[progress.format] || '文件'}`;
  if (progress.stage === 'archive') return '正在打包保存文件';
  return '';
}
function statusText(item) {
  if (item.cached) return '已复用本地文件';
  if (item.status === 'partial') return `部分成功：${(item.successfulFormats || []).map(format => formatName[format] || format).join('、') || '已有文件可下载'}`;
  return ({ queued: '等待中', running: '正在导出', success: '已导出', error: '导出失败', cancelled: '已取消' })[item.status] || '处理中';
}
function formatFailures(item) {
  return Object.entries(item.failedFormats || {}).map(([format, error]) => `<p class="format-failure">${escape(formatName[format] || format)}：${escape(error)}</p>`).join('');
}

function inputCount() {
  const count = ($('#links').value.match(/https?:\/\/mp\.weixin\.qq\.com\/s(?:\/|\?)/g) || []).length;
  $('#link-count').textContent = count ? `识别到 ${count} 个链接` : '尚未添加链接';
}
$('#links').addEventListener('input', inputCount);
$('#clear').addEventListener('click', () => { $('#links').value = ''; inputCount(); $('#links').focus(); });

function render() {
  const active = jobs.some(job => job.items.some(item => ['running', 'queued'].includes(item.status)));
  $('#submit').disabled = submitting || active;
  $('#submit').innerHTML = active ? '正在导出，请稍候' : '开始导出 <span aria-hidden="true">↓</span>';
  const job = jobs.find(job => job.id === selectedId) || jobs[0];
  if (!job) return;
  selectedId = job.id;
  const success = job.items.filter(item => item.status === 'success').length;
  const partial = job.items.filter(item => item.status === 'partial').length;
  const failed = job.items.filter(item => item.status === 'error').length;
  const cancelled = job.items.filter(item => item.status === 'cancelled').length;
  const finished = job.items.filter(item => !['running', 'queued'].includes(item.status)).length;
  const complete = finished === job.items.length;
  const warningCount = job.items.filter(item => itemWarnings(item).length).length;
  $('#summary').textContent = `${job.items.length} 篇文章 · ${success} 篇成功${partial ? ` · ${partial} 篇部分成功` : ''}${failed ? ` · ${failed} 篇失败` : ''}${cancelled ? ` · ${cancelled} 篇已取消` : ''}${warningCount ? ` · ${warningCount} 篇有提示` : ''}${complete ? ' · 本批次已结束' : ' · 正在处理'}`;
  $('#progress').hidden = complete;
  $('#progress').max = job.items.length;
  $('#progress').value = finished;
  $('#history').hidden = jobs.length < 2;
  $('#history').innerHTML = jobs.map(entry => `<option value="${entry.id}" ${entry.id === selectedId ? 'selected' : ''}>${escape(new Date(entry.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }))} / ${entry.items.length} 篇</option>`).join('');
  const unfinished = job.items.some(item => ['error', 'partial', 'cancelled'].includes(item.status));
  $('#retry').hidden = !unfinished;
  $('#retry').disabled = !complete;
  $('#cancel').hidden = !job.items.some(item => ['running', 'queued'].includes(item.status));
  $('#download-all').hidden = !job.items.some(isDownloadable);
  $('#download-all').href = `/api/jobs/${job.id}/download`;
  $('#save-location').hidden = !job.outputDirectory;
  $('#save-location-heading').textContent = job.items.some(isDownloadable) ? '文件已保存到' : '本批次保存目录';
  $('#saved-directory').textContent = job.outputDirectory || '';
  $('#batch-info').hidden = !job.duplicates && !(job.invalid || []).length;
  $('#batch-info').innerHTML = `${job.duplicates ? `已去重 ${job.duplicates} 个重复链接。` : ''}${(job.invalid || []).length ? `<details><summary>已跳过 ${job.invalid.length} 个无效输入，展开查看</summary>${job.invalid.map(item => `<div>${escape(item.value)}：${escape(item.error)}</div>`).join('')}</details>` : ''}`;
  $('#items').innerHTML = job.items.map((item, index) => {
    const warnings = itemWarnings(item);
    const retry = ['partial', 'error', 'cancelled'].includes(item.status)
      ? `<button type="button" class="secondary retry-item" data-item-id="${escape(item.id)}">${item.status === 'partial' ? '仅重试失败格式' : '恢复未完成项'}</button>` : '';
    const download = isDownloadable(item) ? `<a class="secondary" href="/api/items/${item.id}/download" aria-label="下载文章">下载 ZIP</a>` : '';
    const verify = item.status === 'error' ? `<button type="button" class="secondary verify" data-url="${escape(item.url)}">浏览器验证</button>` : '';
    return `<article class="article-row"><span class="article-index">${String(index + 1).padStart(2, '0')}</span><div class="article-main"><div class="article-title">${escape(item.title || '微信公众号文章')}</div><a class="article-url" href="${escape(item.url)}" target="_blank" rel="noreferrer">${escape(item.url)}</a>${item.account || item.date ? `<div class="article-meta">${escape([item.account, item.date].filter(Boolean).join(' / '))}</div>` : ''}${progressText(item.progress) && ['queued', 'running'].includes(item.status) ? `<p class="article-progress">${escape(progressText(item.progress))}</p>` : ''}${item.error ? `<p class="article-message">${escape(item.error)}</p>` : ''}${formatFailures(item)}${warnings.length ? `<details class="warning-details"><summary>${warnings.length} 条导出提示</summary>${warnings.map(warning => `<p>${escape(warning)}</p>`).join('')}</details>` : ''}</div><div class="article-end"><span class="status ${escape(item.status)}">${escape(statusText(item))}</span>${download}${retry}${verify}</div></article>`;
  }).join('');
}

async function refresh() {
  try {
    const result = await api('/api/jobs');
    const snapshot = JSON.stringify(result);
    jobs = result;
    if (snapshot !== lastSnapshot) { lastSnapshot = snapshot; render(); }
  } catch { notify('无法连接本地服务，请确认终端中的工具仍在运行。页面会自动尝试重新连接。', true); }
}

async function loadSettings() {
  try {
    const settings = await api('/api/settings');
    if (!settingsLoaded) $('#output-directory').value = settings.outputDirectory || '';
    settingsLoaded = true;
  } catch { notify('无法读取保存目录设置，请确认本地服务仍在运行。', true); }
}

async function retry(itemId) {
  try {
    await api(`/api/jobs/${selectedId}/retry`, itemId ? { itemId } : {});
    $('#notice').hidden = true;
    await refresh();
  } catch (error) { notify(error.message, true); }
}

$('#export-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (submitting) return;
  submitting = true;
  render();
  try {
    const formats = [...document.querySelectorAll('input[name="format"]:checked')].map(input => input.value);
    const job = await api('/api/jobs', { text: $('#links').value, formats });
    selectedId = job.id;
    $('#notice').hidden = true;
    await refresh();
  } catch (error) { notify(error.message, true); }
  finally { submitting = false; render(); }
});

$('#save-directory').addEventListener('click', async () => {
  try {
    const settings = await api('/api/settings', { outputDirectory: $('#output-directory').value.trim() });
    $('#output-directory').value = settings.outputDirectory || '';
    notify('保存目录已更新，新的导出批次会保存到此处。');
  } catch (error) { notify(`保存目录失败：${error.message}`, true); }
});
$('#restore-directory').addEventListener('click', async () => {
  $('#output-directory').value = '';
  $('#save-directory').click();
});
$('#history').addEventListener('change', event => { selectedId = event.target.value; render(); });
$('#download-all').addEventListener('click', notifyDownload);
$('#retry').addEventListener('click', () => retry());
$('#cancel').addEventListener('click', async () => {
  $('#cancel').disabled = true;
  try { await api(`/api/jobs/${selectedId}/cancel`, {}); notify('正在取消本批次，已完成的文件会保留。'); await refresh(); }
  catch (error) { notify(error.message, true); }
  finally { $('#cancel').disabled = false; }
});
$('#copy-path').addEventListener('click', async () => {
  const directory = $('#saved-directory').textContent;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('浏览器不支持自动复制');
    await navigator.clipboard.writeText(directory);
    notify('保存路径已复制。');
  } catch { notify('无法自动复制路径，请手动选中并复制上方路径。', true); }
});
$('#open-directory').addEventListener('click', async () => {
  try { notify((await api('/api/open-directory', { jobId: selectedId })).message); }
  catch (error) { notify(`无法打开文件夹：${error.message}`, true); }
});
$('#items').addEventListener('click', async event => {
  if (event.target.closest('a[href$="/download"]')) { notifyDownload(); return; }
  const retryButton = event.target.closest('.retry-item');
  if (retryButton) {
    retryButton.disabled = true;
    try { await retry(retryButton.dataset.itemId); }
    finally { retryButton.disabled = false; }
    return;
  }
  const button = event.target.closest('.verify');
  if (!button) return;
  button.disabled = true;
  try { notify((await api('/api/verify', { url: button.dataset.url })).message); }
  catch (error) { notify(`浏览器未能打开：${error.message}。如未安装浏览器，请在工具目录运行 npm run setup:browser。`, true); }
  finally { button.disabled = false; }
});

async function poll() { await refresh(); setTimeout(poll, 1200); }
void loadSettings();
poll();
