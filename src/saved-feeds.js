import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { normalizeFeedUrl } from './feeds.js';

export class SavedFeeds {
  constructor(directory) {
    this.file = path.join(directory, 'feeds.json');
    this.items = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : [];
  }

  save({ name, url } = {}) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new Error('请填写 1–100 字的订阅源名称');
    url = normalizeFeedUrl(url).href;
    const existing = this.items.find(item => item.url === url);
    const source = { id: existing?.id || randomUUID(), name: name.trim(), url };
    const items = existing ? this.items.map(item => item.id === existing.id ? source : item) : [...this.items, source];
    this.write(items);
    return source;
  }

  remove(id) {
    if (!this.items.some(item => item.id === id)) throw new Error('找不到这个订阅源，请刷新页面');
    this.write(this.items.filter(item => item.id !== id));
  }

  write(items) {
    const temporary = this.file + '.tmp';
    writeFileSync(temporary, JSON.stringify(items, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
    this.items = items;
  }
}
