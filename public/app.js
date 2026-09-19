const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let jobs = [];
let selectedId;
let lastSnapshot;
let submitting = false;

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
  const failed = job.items.filter(item => item.status === 'error').length;
  const finished = success + failed;
  const complete = finished === job.items.length;
  const warningCount = job.items.filter(item => item.warnings.length).length;
  $('#summary').textContent = `${job.items.length} 篇文章 · ${success} 篇成功${failed ? ` · ${failed} 篇失败` : ''}${warningCount ? ` · ${warningCount} 篇有提示` : ''}${complete ? ' · 本批次已结束' : ' · 正在处理'}`;
  $('#progress').hidden = complete;
  $('#progress').max = job.items.length;
  $('#progress').value = finished;
  $('#history').hidden = jobs.length < 2;
  $('#history').innerHTML = jobs.map(job => `<option value="${job.id}" ${job.id === selectedId ? 'selected' : ''}>${escape(new Date(job.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }))} / ${job.items.length} 篇</option>`).join('');
  $('#retry').hidden = !failed;
  $('#retry').disabled = !complete;
  $('#download-all').hidden = !success;
  $('#download-all').href = `/api/jobs/${job.id}/download`;
  $('#save-location').hidden = !success || !job.outputDirectory;
  $('#saved-directory').textContent = job.outputDirectory || '';
  $('#batch-info').hidden = !job.duplicates && !job.invalid.length;
  $('#batch-info').innerHTML = `${job.duplicates ? `已去重 ${job.duplicates} 个重复链接。` : ''}${job.invalid.length ? `<details><summary>已跳过 ${job.invalid.length} 个无效输入，展开查看</summary>${job.invalid.map(item => `<div>${escape(item.value)}：${escape(item.error)}</div>`).join('')}</details>` : ''}`;
  const statusText = { queued: '等待中', running: '正在抓取和导出', success: '已导出', error: '导出失败' };
  $('#items').innerHTML = job.items.map((item, index) => `<article class="article-row"><span class="article-index">${String(index + 1).padStart(2, '0')}</span><div class="article-main"><div class="article-title">${escape(item.title || '微信公众号文章')}</div><a class="article-url" href="${escape(item.url)}" target="_blank" rel="noreferrer">${escape(item.url)}</a>${item.account || item.date ? `<div class="article-meta">${escape([item.account, item.date].filter(Boolean).join(' / '))}</div>` : ''}${item.error ? `<p class="article-message">${escape(item.error)}</p>` : ''}${item.warnings.length ? `<details class="warning-details"><summary>${item.warnings.length} 条导出提示</summary>${item.warnings.map(w => `<p>${escape(w)}</p>`).join('')}</details>` : ''}</div><div class="article-end"><span class="status ${item.status}">${item.cached ? '已复用本地文件' : statusText[item.status]}</span>${item.status === 'success' ? `<a class="secondary" href="/api/items/${item.id}/download" aria-label="下载文章">下载 ZIP</a>` : item.status === 'error' ? `<button type="button" class="secondary verify" data-url="${escape(item.url)}">浏览器验证</button>` : ''}</div></article>`).join('');
}

async function refresh() {
  try {
    const result = await api('/api/jobs');
    const snapshot = JSON.stringify(result);
    jobs = result;
    if (snapshot !== lastSnapshot) { lastSnapshot = snapshot; render(); }
  } catch { notify('无法连接本地服务，请确认终端中的工具仍在运行。页面会自动尝试重新连接。', true); }
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

$('#history').addEventListener('change', event => { selectedId = event.target.value; render(); });
$('#download-all').addEventListener('click', notifyDownload);
$('#retry').addEventListener('click', async () => {
  $('#retry').disabled = true;
  try { await api(`/api/jobs/${selectedId}/retry`, {}); $('#notice').hidden = true; await refresh(); }
  catch (error) { notify(error.message, true); $('#retry').disabled = false; }
});
$('#items').addEventListener('click', async event => {
  if (event.target.closest('a[href$="/download"]')) { notifyDownload(); return; }
  const button = event.target.closest('.verify');
  if (!button) return;
  button.disabled = true;
  try { notify((await api('/api/verify', { url: button.dataset.url })).message); }
  catch (error) { notify(`浏览器未能打开：${error.message}。如未安装浏览器，请在工具目录运行 npm run setup:browser。`, true); }
  finally { button.disabled = false; }
});

async function poll() { await refresh(); setTimeout(poll, 1200); }
poll();
