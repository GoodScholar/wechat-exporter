const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const formatName = { markdown: 'Markdown', html: 'HTML', pdf: 'PDF' };
let jobs = [];
let selectedId;
let lastSnapshot;
let submitting = false;
let settingsLoaded = false;
let inputMode = 'links';
let rssItems = [];
let rssSelected = new Set();
let rssPreviewUrl = '';
let rssLoading = false;
let rssRequest = 0;
let savedFeeds = [];
let savedFeedsLoaded = false;
let savedFeedsBusy = false;

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
function isDownloadable(item) { return item.downloadable === true; }
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
  return Object.entries(item.failedFormats || {}).filter(([, error]) => error !== item.error).map(([format, error]) => `<p class="format-failure">${escape(formatName[format] || format)}：${escape(error)}</p>`).join('');
}

function recoveryAdvice(item) {
  if (!['error', 'partial'].includes(item.status)) return { hints: [] };
  const messages = [item.error, ...Object.values(item.failedFormats || {})].filter(Boolean);
  const has = pattern => messages.some(message => pattern.test(message));
  const missing = has(/^导出文件已被移除/);
  const pdfSetup = has(/^PDF 需要 Chromium/);
  const verify = has(/^微信要求访问验证/);
  const original = has(/未找到.*正文|暂不支持的消息类型|文章已删除或无法查看|公众号账号已迁移/);
  const network = has(/网络|无法连接|请求超时|HTTP \d{3}/);
  const hints = [];
  if (missing) hints.push('原文件已被移动或删除，重新导出即可生成新文件。');
  if (pdfSetup) hints.push('PDF 所需浏览器尚未就绪。请展开安装说明，完成后重试；已有文件仍可下载。');
  if (verify) hints.push('请在独立浏览器中完成微信验证，保持文章页面打开，然后重试。');
  if (original) hints.push('请先查看原文，确认文章可访问且为图文消息；若已迁移，请复制新链接重新导出。');
  if (network) hints.push('请检查网络连接，稍后重试；仅遇到微信验证页面时才需要浏览器验证。');
  if (!hints.length) hints.push('请根据上方错误信息处理后重试，已成功生成的格式会保留。');
  return { hints, pdfSetup, verify, original, retryLabel: missing ? '重新导出' : pdfSetup ? '安装后重试 PDF' : verify ? '验证后重试' : undefined };
}

function inputCount() {
  const count = ($('#links').value.match(/https?:\/\/mp\.weixin\.qq\.com\/s(?:\/|\?)/g) || []).length;
  $('#link-count').textContent = count ? `识别到 ${count} 个链接` : '尚未添加链接';
}
$('#links').addEventListener('input', inputCount);
$('#clear').addEventListener('click', () => { $('#links').value = ''; inputCount(); $('#links').focus(); });

function localDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function visibleRssItems() {
  const keyword = $('#rss-title-filter').value.trim().toLocaleLowerCase();
  const start = $('#rss-start-date').value;
  const end = $('#rss-end-date').value;
  return rssItems.filter(item => {
    const date = localDate(item.publishedAt);
    return (!keyword || String(item.title || '').toLocaleLowerCase().includes(keyword))
      && (!start || (date && date >= start))
      && (!end || (date && date <= end));
  });
}

function rssMessage(message, error = false) {
  $('#rss-message').textContent = message;
  $('#rss-message').className = 'rss-message' + (error ? ' error' : '');
}

function clearRssPreview() {
  rssItems = [];
  rssSelected.clear();
  rssPreviewUrl = '';
  $('#rss-preview').hidden = true;
  render();
}

function invalidateRss() {
  rssRequest += 1;
  rssLoading = false;
  $('#rss-load').disabled = false;
  clearRssPreview();
}

function savedFeedMessage(message, error = false) {
  $('#rss-saved-message').textContent = message;
  $('#rss-saved-message').className = 'rss-message' + (error ? ' error' : '');
}

function savedFeedControls() {
  for (const selector of ['#rss-saved', '#rss-name', '#rss-url', '#rss-save']) $(selector).disabled = savedFeedsBusy;
  $('#rss-delete').disabled = savedFeedsBusy || !$('#rss-saved').value;
  $('#rss-load').textContent = $('#rss-saved').value ? '刷新文章' : '读取文章';
}

function renderSavedFeeds(id = '') {
  $('#rss-saved').innerHTML = '<option value="">输入新订阅源</option>' + savedFeeds.map(source => `<option value="${escape(source.id)}">${escape(source.name)}</option>`).join('');
  $('#rss-saved').value = id;
  savedFeedControls();
}

async function loadSavedFeeds() {
  savedFeedsBusy = true;
  savedFeedControls();
  try {
    savedFeeds = await api('/api/feeds');
    renderSavedFeeds();
    savedFeedsLoaded = true;
  } catch (error) { savedFeedMessage(`读取常用订阅源失败：${error.message}。切换输入方式后可重试。`, true); }
  finally { savedFeedsBusy = false; savedFeedControls(); }
}

$('#rss-saved').addEventListener('change', () => {
  const source = savedFeeds.find(item => item.id === $('#rss-saved').value);
  $('#rss-name').value = source?.name || '';
  $('#rss-url').value = source?.url || '';
  for (const selector of ['#rss-title-filter', '#rss-start-date', '#rss-end-date']) $(selector).value = '';
  invalidateRss();
  rssMessage(source ? '已切换订阅源，点击「刷新文章」读取最新列表。' : '填写 RSS 地址后读取文章，也可以保存为常用订阅源。');
  savedFeedMessage('订阅源仅保存在本机；删除订阅源不会删除已导出的文件。');
  savedFeedControls();
});

$('#rss-save').addEventListener('click', async () => {
  if (savedFeedsBusy) return;
  savedFeedsBusy = true;
  savedFeedControls();
  try {
    const source = await api('/api/feeds', { name: $('#rss-name').value, url: $('#rss-url').value });
    const index = savedFeeds.findIndex(item => item.id === source.id);
    if (index < 0) savedFeeds.push(source); else savedFeeds[index] = source;
    if ($('#rss-url').value !== source.url) invalidateRss();
    $('#rss-name').value = source.name;
    $('#rss-url').value = source.url;
    renderSavedFeeds(source.id);
    savedFeedMessage('订阅源已保存到本机');
  } catch (error) { savedFeedMessage(`保存失败：${error.message}`, true); }
  finally { savedFeedsBusy = false; savedFeedControls(); }
});

$('#rss-delete').addEventListener('click', async () => {
  const id = $('#rss-saved').value;
  if (!id || savedFeedsBusy) return;
  savedFeedsBusy = true;
  savedFeedControls();
  try {
    await api(`/api/feeds/${encodeURIComponent(id)}/delete`, {});
    savedFeeds = savedFeeds.filter(item => item.id !== id);
    renderSavedFeeds();
    $('#rss-name').value = '';
    $('#rss-url').value = '';
    invalidateRss();
    rssMessage('');
    savedFeedMessage('已删除订阅源，已导出的文件仍保留');
  } catch (error) { savedFeedMessage(`删除失败：${error.message}`, true); }
  finally { savedFeedsBusy = false; savedFeedControls(); }
});

function renderRss() {
  if (!rssItems.length) {
    $('#rss-preview').hidden = true;
    return;
  }
  const visible = visibleRssItems();
  const visibleUrls = new Set(visible.map(item => item.url));
  rssSelected = new Set([...rssSelected].filter(url => visibleUrls.has(url)));
  $('#rss-preview').hidden = false;
  $('#rss-selection-count').textContent = `当前可见 ${visible.length} 篇 · 已选 ${rssSelected.size} 篇`;
  $('#rss-list').innerHTML = visible.length ? visible.map(item => {
    const date = localDate(item.publishedAt);
    const meta = [date, item.author].filter(Boolean).join(' · ');
    return `<label class="rss-item"><input type="checkbox" data-url="${escape(item.url)}" ${rssSelected.has(item.url) ? 'checked' : ''}><span><strong>${escape(item.title || '微信公众号文章')}</strong>${meta ? `<small>${escape(meta)}</small>` : '<small>未提供日期</small>'}</span><a href="${escape(item.url)}" target="_blank" rel="noreferrer" aria-label="打开原文">原文</a></label>`;
  }).join('') : '<p class="rss-empty">当前筛选没有文章。</p>';
}

function setInputMode(mode) {
  inputMode = mode;
  const rss = mode === 'rss';
  $('#links-panel').hidden = rss;
  $('#rss-panel').hidden = !rss;
  $('#clear').hidden = rss;
  $('#input-mode-links').classList.toggle('active', !rss);
  $('#input-mode-links').setAttribute('aria-pressed', String(!rss));
  $('#input-mode-rss').classList.toggle('active', rss);
  $('#input-mode-rss').setAttribute('aria-pressed', String(rss));
  if (rss) {
    renderRss();
    if (!savedFeedsLoaded && !savedFeedsBusy) void loadSavedFeeds();
  }
  render();
}

async function loadRss() {
  const url = $('#rss-url').value.trim();
  if (!url) { rssMessage('请先填写 RSS 地址。', true); return; }
  const requestId = ++rssRequest;
  clearRssPreview();
  rssLoading = true;
  $('#rss-load').disabled = true;
  rssMessage('正在读取文章…');
  render();
  try {
    const result = await api('/api/feeds/preview', { url });
    if (requestId !== rssRequest || $('#rss-url').value.trim() !== url) return;
    rssItems = result.items || [];
    rssPreviewUrl = url;
    $('#rss-source-title').textContent = result.title || 'RSS 文章';
    $('#rss-source-meta').textContent = result.url || url;
    const hints = [];
    if (!rssItems.length) hints.push('源中没有可导入的微信原文，请检查订阅服务设置（we-mp-rss 请使用 RSS_LOCAL=false）。');
    else hints.push(`已读取 ${rssItems.length} 篇微信文章。`);
    if (result.skipped) hints.push(`已跳过 ${result.skipped} 个非微信或无效条目。`);
    if (result.duplicates) hints.push(`已合并 ${result.duplicates} 个重复条目。`);
    if (result.truncated) hints.push('源条目较多，仅显示前 500 篇。');
    rssMessage(hints.join(' '));
    renderRss();
  } catch (error) {
    if (requestId === rssRequest) rssMessage(`读取失败：${error.message}`, true);
  } finally {
    if (requestId === rssRequest) {
      rssLoading = false;
      $('#rss-load').disabled = false;
      render();
    }
  }
}

$('#input-mode-links').addEventListener('click', () => setInputMode('links'));
$('#input-mode-rss').addEventListener('click', () => setInputMode('rss'));
$('#rss-load').addEventListener('click', loadRss);
$('#rss-url').addEventListener('input', () => {
  $('#rss-saved').value = '';
  savedFeedControls();
  if (rssPreviewUrl || rssLoading) {
    invalidateRss();
    rssMessage('RSS 地址已变化，请重新读取文章。');
  }
});
['#rss-title-filter', '#rss-start-date', '#rss-end-date'].forEach(selector => $(selector).addEventListener('input', () => { renderRss(); render(); }));
$('#rss-select-all').addEventListener('click', () => {
  const visible = visibleRssItems();
  rssSelected = new Set(visible.slice(0, 50).map(item => item.url));
  if (visible.length > 50) rssMessage('当前筛选结果超过 50 篇，已选择前 50 篇。');
  renderRss();
  render();
});
$('#rss-clear-selection').addEventListener('click', () => { rssSelected.clear(); renderRss(); render(); });
$('#rss-list').addEventListener('change', event => {
  const input = event.target.closest('input[type="checkbox"][data-url]');
  if (!input) return;
  if (input.checked && rssSelected.size >= 50) {
    input.checked = false;
    rssMessage('每批最多选择 50 篇文章。', true);
  } else if (input.checked) rssSelected.add(input.dataset.url);
  else rssSelected.delete(input.dataset.url);
  renderRss();
  render();
});

function render() {
  const active = jobs.some(job => job.items.some(item => ['running', 'queued'].includes(item.status)));
  $('#submit').disabled = submitting || active || (inputMode === 'rss' && (rssLoading || rssSelected.size === 0));
  $('#submit').innerHTML = active ? '正在导出，请稍候' : '开始导出 <span aria-hidden="true">↓</span>';
  const keyword = $('#history-search').value.trim().toLocaleLowerCase();
  const status = $('#history-status').value;
  const filtering = Boolean(keyword || status);
  const matches = item => (!keyword || [item.title, item.account].some(value => String(value || '').toLocaleLowerCase().includes(keyword))) && (!status || item.status === status);
  const visibleJobs = jobs.filter(job => job.items.some(matches));
  $('#history-filters').hidden = !jobs.length;
  $('#history-reset').disabled = !filtering;
  const total = jobs.reduce((count, job) => count + job.items.length, 0);
  const matched = visibleJobs.reduce((count, job) => count + job.items.filter(matches).length, 0);
  $('#history-result').textContent = filtering ? `共 ${total} 篇，匹配 ${matched} 篇 / ${visibleJobs.length} 个批次。下方展示所选批次的匹配文章；批量操作仍作用于整个批次。` : `共 ${total} 篇 / ${jobs.length} 个批次，可搜索所有历史记录。`;
  const job = visibleJobs.find(job => job.id === selectedId) || visibleJobs[0];
  if (!job) {
    if (jobs.length) {
      $('#summary').textContent = '没有匹配的导出记录';
      $('#items').innerHTML = '<div class="empty"><strong>试试其他关键词或状态</strong><p>清空筛选可查看全部记录。</p></div>';
      for (const selector of ['#history', '#progress', '#retry', '#cancel', '#download-all', '#save-location', '#batch-info']) $(selector).hidden = true;
    }
    return;
  }
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
  $('#history').hidden = visibleJobs.length < 2;
  $('#history').innerHTML = visibleJobs.map(entry => `<option value="${entry.id}" ${entry.id === selectedId ? 'selected' : ''}>${escape(new Date(entry.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }))} / ${entry.items.length} 篇</option>`).join('');
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
    if (!matches(item)) return '';
    const warnings = itemWarnings(item);
    const advice = recoveryAdvice(item);
    const guidance = advice.hints.map(hint => `<p class="recovery-hint">${escape(hint)}</p>`).join('')
      + (advice.pdfSetup ? '<details class="warning-details"><summary>PDF 环境说明</summary><p>在工具所在目录打开终端，运行 <code>npm run setup:browser</code> 安装 Chromium。安装完成后返回此处重试 PDF，无需重新抓取已有正文和图片。</p></details>' : '');
    const retry = ['partial', 'error', 'cancelled'].includes(item.status)
      ? `<button type="button" class="secondary retry-item" data-item-id="${escape(item.id)}">${advice.retryLabel || (item.status === 'partial' ? '仅重试失败格式' : '恢复未完成项')}</button>` : '';
    const download = isDownloadable(item) ? `<a class="secondary" href="/api/items/${item.id}/download" aria-label="下载文章">下载 ZIP</a>` : '';
    const verify = advice.verify ? `<button type="button" class="secondary verify" data-url="${escape(item.url)}">浏览器验证</button>` : '';
    const original = advice.original ? `<a class="secondary" href="${escape(item.url)}" target="_blank" rel="noreferrer">查看原文</a>` : '';
    return `<article class="article-row"><span class="article-index">${String(index + 1).padStart(2, '0')}</span><div class="article-main"><div class="article-title">${escape(item.title || '微信公众号文章')}</div><a class="article-url" href="${escape(item.url)}" target="_blank" rel="noreferrer">${escape(item.url)}</a>${item.account || item.date ? `<div class="article-meta">${escape([item.account, item.date].filter(Boolean).join(' / '))}</div>` : ''}${progressText(item.progress) && ['queued', 'running'].includes(item.status) ? `<p class="article-progress">${escape(progressText(item.progress))}</p>` : ''}${item.error ? `<p class="article-message">${escape(item.error)}</p>` : ''}${formatFailures(item)}${guidance}${warnings.length ? `<details class="warning-details"><summary>${warnings.length} 条导出提示</summary>${warnings.map(warning => `<p>${escape(warning)}</p>`).join('')}</details>` : ''}</div><div class="article-end"><span class="status ${escape(item.status)}">${escape(statusText(item))}</span>${download}${original}${verify}${retry}</div></article>`;
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
  const text = inputMode === 'rss' ? rssItems.filter(item => rssSelected.has(item.url)).map(item => item.url).join('\n') : $('#links').value;
  if (inputMode === 'rss' && !rssSelected.size) { notify('请至少选择一篇 RSS 文章。', true); return; }
  submitting = true;
  render();
  try {
    const formats = [...document.querySelectorAll('input[name="format"]:checked')].map(input => input.value);
    const job = await api('/api/jobs', { text, formats });
    selectedId = job.id;
    $('#history-search').value = '';
    $('#history-status').value = '';
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
$('#history-search').addEventListener('input', render);
$('#history-status').addEventListener('change', render);
$('#history-reset').addEventListener('click', () => {
  $('#history-search').value = '';
  $('#history-status').value = '';
  render();
  $('#history-search').focus();
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
