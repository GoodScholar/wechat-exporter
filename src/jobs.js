import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseLinks } from './article.js';

export class JobStore {
  constructor(directory, exporter, interval = 1500) {
    this.directory = directory;
    this.exporter = exporter;
    this.interval = interval;
    this.running = false;
    mkdirSync(path.join(directory, 'exports'), { recursive: true });
    this.manifest = path.join(directory, 'jobs.json');
    this.jobs = existsSync(this.manifest) ? JSON.parse(readFileSync(this.manifest, 'utf8')) : [];
    for (const job of this.jobs) for (const item of job.items) {
      if (['queued', 'running'].includes(item.status)) { item.status = 'error'; item.error = '上次运行已中断，请点击重试'; }
      if (item.status === 'success' && !existsSync(this.file(item))) { item.status = 'error'; item.error = '导出文件已被移除，请重新导出'; }
    }
    this.save();
  }

  save() {
    writeFileSync(this.manifest + '.tmp', JSON.stringify(this.jobs, null, 2));
    renameSync(this.manifest + '.tmp', this.manifest);
  }

  file(item) { return path.join(this.directory, 'exports', `${item.id}.zip`); }
  list() { return this.jobs; }

  create(text, formats) {
    if (!Array.isArray(formats) || !formats.length || formats.some(f => !['markdown', 'html', 'pdf'].includes(f))) throw new Error('请至少选择一种有效的导出格式');
    if (this.jobs.some(job => job.items.some(item => ['queued', 'running'].includes(item.status)))) throw new Error('当前批次仍在导出，请完成后再添加新批次');
    const { urls, invalid, duplicates } = parseLinks(text);
    if (!urls.length) throw new Error('没有找到有效文章链接，请粘贴 mp.weixin.qq.com/s 开头的链接');
    const job = { id: randomUUID(), createdAt: new Date().toISOString(), formats: [...new Set(formats)].sort(), invalid, duplicates, items: urls.map(url => ({ id: randomUUID(), url, status: 'queued', title: '', warnings: [] })) };
    this.jobs.unshift(job);
    this.save();
    void this.run();
    return job;
  }

  retry(id) {
    const job = this.jobs.find(job => job.id === id);
    if (!job) throw new Error('找不到这个批次');
    for (const item of job.items.filter(item => item.status === 'error')) { item.status = 'queued'; delete item.error; }
    this.save();
    void this.run();
    return job;
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const job = [...this.jobs].reverse().find(job => job.items.some(item => item.status === 'queued'));
        if (!job) break;
        const item = job.items.find(item => item.status === 'queued');
        item.status = 'running';
        this.save();
        try {
          const cached = this.jobs.filter(other => other.formats.join() === job.formats.join()).flatMap(other => other.items).find(other => other.url === item.url && other.status === 'success' && !other.warnings.length && existsSync(this.file(other)));
          if (cached) {
            copyFileSync(this.file(cached), this.file(item));
            const { id, url } = item;
            Object.assign(item, cached, { id, url, cached: true });
          } else {
            const { archive, ...metadata } = await this.exporter(item.url, job.formats);
            writeFileSync(this.file(item), archive);
            Object.assign(item, metadata, { status: 'success' });
          }
        } catch (error) {
          item.status = 'error';
          item.error = error.name === 'TimeoutError' ? '网络请求超时，请稍后重试或进行浏览器验证' : error.message === 'fetch failed' ? '无法连接微信，请检查网络或进行浏览器验证' : error.message;
        }
        this.save();
        if (this.jobs.some(job => job.items.some(item => item.status === 'queued'))) await delay(this.interval);
      }
    } catch (error) {
      console.error('任务记录保存失败：', error.message);
      for (const job of this.jobs) for (const item of job.items) if (['queued', 'running'].includes(item.status)) { item.status = 'error'; item.error = '无法写入本地文件，请检查磁盘空间和目录权限'; }
    } finally { this.running = false; }
  }
}
