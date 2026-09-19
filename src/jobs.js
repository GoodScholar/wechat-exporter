import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, statSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ArticleArchive } from './archive.js';
import { setTimeout as delay } from 'node:timers/promises';
import { parseLinks } from './article.js';

const validFormats = ['markdown', 'html', 'pdf'];
const unique = values => [...new Set(values)].sort();

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
      for (const item of job.items || []) this.archive(item, job).restore();
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

  save() { writeFileSync(this.manifest + '.tmp', JSON.stringify(this.jobs, null, 2)); renameSync(this.manifest + '.tmp', this.manifest); }
  archive(item, job) { return new ArticleArchive(item, job || { outputDirectory: this.defaultOutputDirectory }); }
  file(item, job) { return this.archive(item, job).file; }
  findJob(id) { return this.jobs.find(job => job.id === id); }
  findItem(id) { return this.jobs.flatMap(job => job.items.map(item => ({ job, item }))).find(entry => entry.item.id === id); }
  hasFile(item, job) { return this.archive(item, job).available; }
  list() { return this.jobs.map(({ cancelRequested, ...job }) => ({ ...job, items: job.items.map(item => this.archive(item, job).snapshot()) })); }
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
    for (const item of items) this.archive(item, job).retry();
    delete job.cancelRequested;
    this.save(); void this.run(); return job;
  }

  cancel(id) {
    const job = this.findJob(id);
    if (!job) throw new Error('找不到这个批次');
    job.cancelRequested = true;
    for (const item of job.items) { if (item.status === 'queued') this.archive(item, job).cancel(); if (item.status === 'running') this.active.get(item.id)?.abort(); }
    this.save(); return job;
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const job = [...this.jobs].reverse().find(candidate => candidate.items.some(item => item.status === 'queued'));
        if (!job) break;
        const item = job.items.find(candidate => candidate.status === 'queued');
        const controller = new AbortController();
        this.active.set(item.id, controller);
        try {
          const cached = this.jobs.filter(other => other.id !== job.id)
            .flatMap(other => other.items.map(candidate => this.archive(candidate, other)))
            .find(candidate => candidate.reusableFor(item.url, job.formats));
          await this.archive(item, job).run(this.exporter, { signal: controller.signal, cached, onProgress: () => this.save() });
        } finally { this.active.delete(item.id); this.save(); }
        if (this.jobs.some(candidate => candidate.items.some(item => item.status === 'queued'))) await delay(this.interval);
      }
    } catch (error) {
      console.error('任务记录保存失败：', error.message);
      for (const job of this.jobs) for (const item of job.items) if (['queued', 'running'].includes(item.status)) { item.status = 'error'; item.error = '无法写入本地文件，请检查磁盘空间和目录权限'; }
    } finally { this.running = false; }
  }
}
