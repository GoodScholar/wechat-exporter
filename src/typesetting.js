import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sanitizeHtml from 'sanitize-html';
import { marked } from 'marked';

const fields = ['title', 'author', 'account', 'publishedAt', 'body'];
const emptyDocument = () => ({ title: '', author: '', account: '', publishedAt: '', body: '', revision: 0, savedAt: '' });

function normalizeDocument(value) {
  const document = emptyDocument();
  for (const field of fields) {
    if (typeof value?.[field] !== 'string') return invalidDocument();
    document[field] = value[field];
  }
  if (!Number.isSafeInteger(value?.revision) || value.revision < 0) return invalidDocument('排版文稿修订号无效');
  document.revision = value.revision;
  if (value?.savedAt !== undefined && typeof value.savedAt !== 'string') return invalidDocument('排版文稿保存时间无效');
  document.savedAt = value?.savedAt || '';
  return document;
}

function invalidDocument(message = '排版文稿格式无效') {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

async function writeAtomically(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}

export class TypesettingStore {
  constructor(dataDir, { writeAtomically: replaceFile = writeAtomically, removeFile = unlink } = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'typesetting-document.json');
    this.backup = path.join(dataDir, 'typesetting-document.backup.json');
    this.manifest = path.join(dataDir, 'typesetting-document.manifest.json');
    this.versions = path.join(dataDir, 'typesetting-versions');
    this.document = null;
    this.versionId = null;
    this.writes = Promise.resolve();
    this.replaceFile = replaceFile;
    this.removeFile = removeFile;
  }

  async load() {
    if (this.document) return this.document;
    try {
      const manifest = JSON.parse(await readFile(this.manifest, 'utf8'));
      for (const versionId of [manifest.current, manifest.recovery]) {
        if (typeof versionId !== 'string') continue;
        try {
          this.document = normalizeDocument(JSON.parse(await readFile(path.join(this.versions, `${versionId}.json`), 'utf8')));
          this.versionId = versionId;
          return this.document;
        } catch { /* Try the recovery version before legacy files. */ }
      }
    } catch { /* Legacy documents have no manifest. */ }
    for (const file of [this.file, this.backup]) {
      try {
        this.document = normalizeDocument(JSON.parse(await readFile(file, 'utf8')));
        return this.document;
      } catch { /* Try recovery copy, then begin with an empty document. */ }
    }
    this.document = emptyDocument();
    return this.document;
  }

  async save(input) {
    const operation = async () => {
      const current = await this.load();
      const next = normalizeDocument(input);
      const sameContent = fields.every(field => next[field] === current[field]);
      if (next.revision < current.revision || (next.revision === current.revision && !sameContent)) {
        const error = new Error('文稿已更新，请刷新后重试');
        error.status = 409;
        throw error;
      }
      if (next.revision === current.revision) return current;
      next.savedAt = new Date().toISOString();
      const serialized = JSON.stringify(next, null, 2);
      const versionId = randomUUID();
      const recoveryId = this.versionId || (current.revision ? randomUUID() : versionId);
      await mkdir(this.versions, { recursive: true });
      if (!this.versionId && current.revision) await this.replaceFile(path.join(this.versions, `${recoveryId}.json`), JSON.stringify(current, null, 2));
      await this.replaceFile(path.join(this.versions, `${versionId}.json`), serialized);
      await this.replaceFile(this.manifest, JSON.stringify({ current: versionId, recovery: recoveryId }, null, 2));
      this.document = next;
      this.versionId = versionId;
      try {
        const keep = new Set([versionId, recoveryId]);
        for (const name of await readdir(this.versions)) if (name.endsWith('.json') && !keep.has(name.slice(0, -5))) await this.removeFile(path.join(this.versions, name));
      } catch { /* Cleanup is post-commit and never changes the visible manifest. */ }
      return next;
    };
    const result = this.writes.then(operation, operation);
    this.writes = result.catch(() => {});
    return result;
  }
}

export function renderTypesettingMarkdown(body) {
  if (!body.trim()) return { html: '' };
  const html = sanitizeHtml(marked.parse(body, { gfm: true, breaks: true }), {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'h1', 'h2', 'span'],
    allowedAttributes: { a: ['href', 'title'], img: ['src', 'alt', 'width', 'height'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'], code: ['class'] },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowProtocolRelative: false
  });
  return { html };
}
