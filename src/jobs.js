import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, statSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import { setTimeout as delay } from 'node:timers/promises';
import { parseLinks } from './article.js';

const validFormats = ['markdown', 'html', 'pdf'];
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

export class JobStore {
  constructor(directory, exporter, interval = 1500) {
    this.directory = directory;
    this.exporter = exporter;
    this.interval = interval;
    this.running = false;
    this.active = new Map();
    mkdirSync(directory, { recursive: true });
    this.defaultOutputDirectory = path.join(directory, 'exports');
    mkdirSync(this.defaultOutputDirectory, { recursive: true });
    this.settingsPath = path.join(directory, 'settings.json');
    this.settings = existsSync(this.settingsPath) ? JSON.parse(readFileSync(this.settingsPath, 'utf8')) : { outputDirectory: this.defaultOutputDirectory };
    try { this.settings.outputDirectory = this.validateOutputDirectory(this.settings.outputDirectory); } catch { this.settings.outputDirectory = this.defaultOutputDirectory; }
    this.manifest = path.join(directory, 'jobs.json');
    this.jobs = existsSync(this.manifest) ? JSON.parse(readFileSync(this.manifest, 'utf8')) : [];
    for (const job of this.jobs) {
      job.formats = unique(job.formats || []);
      job.outputDirectory ||= this.defaultOutputDirectory;
      for (const item of job.items || []) this.normalizeItem(job, item);
    }
    this.save();
    this.saveSettings();
  }

  validateOutputDirectory(value) {
    if (typeof value !== 'string') throw new Error('保存目录必须是字符串');
    if (!value.trim()) return this.defaultOutputDirectory;
    const expanded = value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
    if (!path.isAbsolute(expanded)) throw new Error('保存目录必须是绝对路径或 ~/ 路径');
    const directory = path.resolve(expanded);
    mkdirSync(directory, { recursive: true });
    if (!statSync(directory).isDirectory()) throw new Error('保存路径不是目录');
    accessSync(directory, constants.W_OK);
    return directory;
  }

  saveSettings() { writeFileSync(this.settingsPath + '.tmp', JSON.stringify(this.settings, null, 2)); renameSync(this.settingsPath + '.tmp', this.settingsPath); }
  getOutputDirectory() { return this.settings.outputDirectory; }
  setOutputDirectory(value) { this.settings.outputDirectory = this.validateOutputDirectory(value); this.saveSettings(); return this.getOutputDirectory(); }

  normalizeItem(job, item) {
    if (['queued', 'running'].includes(item.status)) { item.status = 'error'; item.error = '上次运行已中断，请点击重试'; }
    item.warnings ||= [];
    item.successfulFormats ||= item.status === 'success' ? [...job.formats] : [];
    item.failedFormats ||= item.status === 'error' ? Object.fromEntries(job.formats.filter(format => !item.successfulFormats.includes(format)).map(format => [format, item.error || '导出失败'])) : {};
    item.successfulFormats = unique(item.successfulFormats);
    if (item.successfulFormats.length && !existsSync(this.file(item, job))) {
      item.status = 'error'; item.error = '导出文件已被移除，请重新导出'; item.failedFormats = Object.fromEntries(job.formats.map(format => [format, item.error])); item.successfulFormats = [];
      delete item.cached;
    }
    item.downloadable = Boolean(item.successfulFormats.length && existsSync(this.file(item, job)));
  }

  save() { writeFileSync(this.manifest + '.tmp', JSON.stringify(this.jobs, null, 2)); renameSync(this.manifest + '.tmp', this.manifest); }
  file(item, job) { return item.filePath || path.join(job?.outputDirectory || this.defaultOutputDirectory, `${item.id}.zip`); }
  findJob(id) { return this.jobs.find(job => job.id === id); }
  findItem(id) { return this.jobs.flatMap(job => job.items.map(item => ({ job, item }))).find(entry => entry.item.id === id); }
  hasFile(item, job) { return Boolean(item.downloadable && existsSync(this.file(item, job))); }
  list() { return this.jobs.map(({ cancelRequested, ...job }) => ({ ...job, items: job.items.map(({ retryInput, retryFormats, ...item }) => ({ ...item })) })); }
  publicJob(job) { return this.list().find(candidate => candidate.id === job.id); }

  create(text, formats) {
    if (!Array.isArray(formats) || !formats.length || formats.some(format => !validFormats.includes(format))) throw new Error('请至少选择一种有效的导出格式');
    if (this.jobs.some(job => job.items.some(item => ['queued', 'running'].includes(item.status)))) throw new Error('当前批次仍在导出，请完成后再添加新批次');
    const { urls, invalid, duplicates } = parseLinks(text);
    if (!urls.length) throw new Error('没有找到有效文章链接，请粘贴 mp.weixin.qq.com/s 开头的链接');
    const job = { id: randomUUID(), createdAt: new Date().toISOString(), formats: unique(formats), outputDirectory: this.getOutputDirectory(), invalid, duplicates,
      items: urls.map(url => ({ id: randomUUID(), url, status: 'queued', title: '', warnings: [], successfulFormats: [], failedFormats: {}, downloadable: false })) };
    this.jobs.unshift(job); this.save(); void this.run(); return job;
  }

  retry(id, itemId) {
    const job = this.findJob(id);
    if (!job) throw new Error('找不到这个批次');
    const items = itemId ? job.items.filter(item => item.id === itemId) : job.items;
    if (itemId && !items.length) throw new Error('找不到这篇文章');
    for (const item of items) if (['error', 'partial', 'cancelled'].includes(item.status)) {
      this.normalizeItem(job, item);
      item.retryFormats = job.formats.filter(format => !item.successfulFormats.includes(format));
      if (item.retryFormats.length) { item.status = 'queued'; item.progress = undefined; delete item.error; }
    }
    delete job.cancelRequested;
    this.save(); void this.run(); return job;
  }

  cancel(id) {
    const job = this.findJob(id);
    if (!job) throw new Error('找不到这个批次');
    job.cancelRequested = true;
    for (const item of job.items) { if (item.status === 'queued') this.markCancelled(job, item); if (item.status === 'running') this.active.get(item.id)?.abort(); }
    this.save(); return job;
  }

  markCancelled(job, item) {
    item.status = 'cancelled'; item.progress = undefined; item.failedFormats = { ...item.failedFormats };
    for (const format of job.formats) if (!item.successfulFormats.includes(format) && !item.failedFormats[format]) item.failedFormats[format] = '已取消';
    item.downloadable = this.hasFile(item, job); delete item.error;
  }

  archivePath(job, item, title) { return path.join(job.outputDirectory, `${job.createdAt.slice(0, 10)}_${safeName(title)}_${item.id.slice(0, 8)}.zip`); }
  writeArchive(job, item, archive, title) {
    mkdirSync(job.outputDirectory, { recursive: true });
    const destination = item.filePath || this.archivePath(job, item, title);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    writeFileSync(temporary, archive); renameSync(temporary, destination); item.filePath = destination;
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const job = [...this.jobs].reverse().find(candidate => candidate.items.some(item => item.status === 'queued'));
        if (!job) break;
        const item = job.items.find(candidate => candidate.status === 'queued');
        const formats = item.retryFormats?.length ? item.retryFormats : job.formats;
        const controller = new AbortController();
        this.active.set(item.id, controller);
        item.status = 'running'; item.progress = { stage: item.retryInput ? 'format' : 'fetch' }; this.save();
        try {
          const cached = !item.retryInput && this.jobs.filter(other => other.id !== job.id && other.formats.join() === job.formats.join())
            .flatMap(other => other.items.map(candidate => ({ job: other, item: candidate })))
            .find(candidate => candidate.item.url === item.url && candidate.item.status === 'success' && !candidate.item.warnings.length && candidate.item.successfulFormats.join() === job.formats.join() && this.hasFile(candidate.item, candidate.job));
          if (cached) {
            const destination = this.archivePath(job, item, cached.item.title); mkdirSync(job.outputDirectory, { recursive: true }); copyFileSync(this.file(cached.item, cached.job), destination);
            const { id, url } = item; Object.assign(item, cached.item, { id, url, filePath: destination, cached: true, progress: undefined });
          } else {
            const previousArchive = this.hasFile(item, job) ? readFileSync(this.file(item, job)) : null;
            const result = await this.exporter(item.url, formats, { signal: controller.signal, retryInput: item.retryInput, previousArchive,
              onProgress: progress => { if (!controller.signal.aborted) { item.progress = progress; this.save(); } } });
            const cancelled = () => controller.signal.aborted || job.cancelRequested || result.cancelled;
            // 带有正文缓存的结果包含可恢复的阶段成果；普通导出器的迟到结果仍丢弃。
            const checkpoint = Boolean(result.retryInput?.article);
            if (cancelled() && !checkpoint) this.markCancelled(job, item);
            else {
              const successfulFormats = unique([...(item.successfulFormats || []), ...(result.successfulFormats || (result.archive ? formats : []))]);
              const failedFormats = { ...item.failedFormats, ...(result.failedFormats || {}) };
              for (const format of successfulFormats) delete failedFormats[format];
              const archive = result.archive && (result.successfulFormats?.length || (!result.successfulFormats && formats.length))
                ? await mergeArchives(previousArchive, result.archive, successfulFormats, failedFormats) : null;
              if (cancelled() && !checkpoint) this.markCancelled(job, item);
              else {
                if (archive) this.writeArchive(job, item, archive, result.title || item.title);
                Object.assign(item, result, { successfulFormats, failedFormats, retryInput: result.retryInput || item.retryInput, progress: undefined });
                delete item.archive; delete item.retryFormats; delete item.cancelled;
                item.downloadable = Boolean(successfulFormats.length && existsSync(this.file(item, job)));
                item.status = successfulFormats.length === job.formats.length ? 'success' : successfulFormats.length ? 'partial' : 'error';
                if (item.status === 'error') item.error = Object.values(failedFormats)[0] || '导出失败'; else delete item.error;
                if (cancelled() && item.status !== 'success') this.markCancelled(job, item);
                else if (item.status === 'success') delete item.retryInput;
              }
            }
          }
        } catch (error) {
          if (controller.signal.aborted || job.cancelRequested || error?.name === 'AbortError') this.markCancelled(job, item);
          else { item.status = 'error'; item.error = errorMessage(error); item.failedFormats = Object.fromEntries(formats.map(format => [format, item.error])); item.progress = undefined; item.downloadable = this.hasFile(item, job); }
        } finally { this.active.delete(item.id); this.save(); }
        if (this.jobs.some(candidate => candidate.items.some(item => item.status === 'queued'))) await delay(this.interval);
      }
    } catch (error) {
      console.error('任务记录保存失败：', error.message);
      for (const job of this.jobs) for (const item of job.items) if (['queued', 'running'].includes(item.status)) { item.status = 'error'; item.error = '无法写入本地文件，请检查磁盘空间和目录权限'; }
    } finally { this.running = false; }
  }
}
