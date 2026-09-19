import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

const safeName = name => String(name || '文章').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 60) || '文章';
const unique = values => [...new Set(values)].sort();
const errorMessage = error => error?.name === 'TimeoutError' ? '网络请求超时，请稍后重试或进行浏览器验证'
  : error?.message === 'fetch failed' ? '无法连接微信，请检查网络或进行浏览器验证' : error?.message || '导出失败';

async function mergeArchives(oldArchive, newArchive, successfulFormats, failedFormats) {
  if (!oldArchive) return newArchive;
  const [oldZip, newZip] = await Promise.all([JSZip.loadAsync(oldArchive), JSZip.loadAsync(newArchive)]);
  const merged = new JSZip();
  for (const source of [oldZip, newZip]) for (const entry of Object.values(source.files)) if (!entry.dir) merged.file(entry.name, await entry.async('nodebuffer'));
  const metadata = merged.file('metadata.json');
  if (metadata) {
    const value = JSON.parse(await metadata.async('string'));
    merged.file('metadata.json', JSON.stringify({ ...value, successfulFormats, failedFormats }, null, 2));
  }
  return merged.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export class ArticleArchive {
  constructor(item, job) {
    this.item = item;
    this.job = job;
  }

  get file() { return this.item.filePath || path.join(this.job.outputDirectory, this.item.id + '.zip'); }
  get available() { return Boolean(this.item.downloadable && existsSync(this.file)); }

  restore() {
    const { item, job } = this;
    if (['queued', 'running'].includes(item.status)) { item.status = 'error'; item.error = '上次运行已中断，请点击重试'; }
    item.warnings ||= [];
    item.successfulFormats ||= item.status === 'success' ? [...job.formats] : [];
    item.failedFormats ||= item.status === 'error' ? Object.fromEntries(job.formats.filter(format => !item.successfulFormats.includes(format)).map(format => [format, item.error || '导出失败'])) : {};
    item.successfulFormats = unique(item.successfulFormats);
    this.#refresh();
  }

  #refresh() {
    const { item, job } = this;
    if (['queued', 'running'].includes(item.status)) return;
    const exists = existsSync(this.file);
    if (item.successfulFormats.length && !exists) {
      item.status = 'error'; item.error = '导出文件已被移除，请重新导出'; item.failedFormats = Object.fromEntries(job.formats.map(format => [format, item.error])); item.successfulFormats = [];
      delete item.cached;
    }
    item.downloadable = Boolean(item.successfulFormats.length && exists);
  }

  snapshot() {
    this.#refresh();
    const { retryInput, retryFormats, ...item } = this.item;
    return item;
  }

  retry() {
    this.#refresh();
    const { item, job } = this;
    if (['error', 'partial', 'cancelled'].includes(item.status)) {
      item.retryFormats = job.formats.filter(format => !item.successfulFormats.includes(format));
      if (item.retryFormats.length) { item.status = 'queued'; item.progress = undefined; delete item.error; }
    }
  }

  cancel() {
    const { item, job } = this;
    item.status = 'cancelled'; item.progress = undefined; item.failedFormats = { ...item.failedFormats };
    for (const format of job.formats) if (!item.successfulFormats.includes(format) && !item.failedFormats[format]) item.failedFormats[format] = '已取消';
    item.downloadable = this.available; delete item.error;
  }

  reusableFor(url, formats) {
    const { item, job } = this;
    return item.url === url && item.status === 'success' && !item.warnings.length
      && job.formats.join() === formats.join() && item.successfulFormats.join() === formats.join() && this.available;
  }

  #destination(title) {
    return path.join(this.job.outputDirectory, this.job.createdAt.slice(0, 10) + '_' + safeName(title) + '_' + this.item.id.slice(0, 8) + '.zip');
  }

  #write(bytes, title) {
    mkdirSync(this.job.outputDirectory, { recursive: true });
    const destination = this.item.filePath || this.#destination(title);
    const temporary = destination + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, bytes); renameSync(temporary, destination); this.item.filePath = destination;
  }

  async run(exporter, { signal, onProgress, cached } = {}) {
    const { item, job } = this;
    const formats = item.retryFormats?.length ? item.retryFormats : job.formats;
    const cancelled = () => signal?.aborted || job.cancelRequested;
    item.status = 'running'; item.progress = { stage: item.retryInput ? 'format' : 'fetch' };
    onProgress?.();
    try {
      if (cached && !item.retryInput) {
        const destination = this.#destination(cached.item.title);
        mkdirSync(job.outputDirectory, { recursive: true }); copyFileSync(cached.file, destination);
        const { id, url } = item;
        Object.assign(item, cached.item, { id, url, filePath: destination, cached: true, progress: undefined });
        return;
      }
      const previousArchive = this.available ? readFileSync(this.file) : null;
      const result = await exporter(item.url, formats, { signal, retryInput: item.retryInput, previousArchive,
        onProgress: progress => { if (!signal?.aborted) { item.progress = progress; onProgress?.(); } } });
      // 优先使用显式标记；旧式导出器仍按原有正文缓存约定保留阶段成果。
      const resumable = result.resumable ?? Boolean(result.retryInput?.article);
      const discard = () => (cancelled() || result.cancelled) && !resumable;
      if (discard()) { this.cancel(); return; }
      const successfulFormats = unique([...(item.successfulFormats || []), ...(result.successfulFormats || (result.archive ? formats : []))]);
      const failedFormats = { ...item.failedFormats, ...(result.failedFormats || {}) };
      for (const format of successfulFormats) delete failedFormats[format];
      const archive = result.archive && (result.successfulFormats?.length || (!result.successfulFormats && formats.length))
        ? await mergeArchives(previousArchive, result.archive, successfulFormats, failedFormats) : null;
      if (discard()) { this.cancel(); return; }
      if (archive) this.#write(archive, result.title || item.title);
      Object.assign(item, result, { successfulFormats, failedFormats, retryInput: result.retryInput || item.retryInput, progress: undefined });
      delete item.archive; delete item.retryFormats; delete item.cancelled; delete item.resumable;
      item.downloadable = Boolean(successfulFormats.length && existsSync(this.file));
      item.status = successfulFormats.length === job.formats.length ? 'success' : successfulFormats.length ? 'partial' : 'error';
      if (item.status === 'error') item.error = Object.values(failedFormats)[0] || '导出失败'; else delete item.error;
      if ((cancelled() || result.cancelled) && item.status !== 'success') this.cancel();
      else if (item.status === 'success') delete item.retryInput;
    } catch (error) {
      if (cancelled() || error?.name === 'AbortError') this.cancel();
      else { item.status = 'error'; item.error = errorMessage(error); item.failedFormats = Object.fromEntries(formats.map(format => [format, item.error])); item.progress = undefined; item.downloadable = this.available; }
    }
  }
}
