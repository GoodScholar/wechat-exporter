import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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

async function readStored(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export class TypesettingStore {
  constructor(dataDir, { writeAtomically: replaceFile = writeAtomically } = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'typesetting-document.json');
    this.backup = path.join(dataDir, 'typesetting-document.backup.json');
    this.document = null;
    this.writes = Promise.resolve();
    this.replaceFile = replaceFile;
  }

  async load() {
    if (this.document) return this.document;
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
      const previousBackup = await readStored(this.backup);
      await mkdir(this.dataDir, { recursive: true });
      await this.replaceFile(this.backup, serialized);
      try { await this.replaceFile(this.file, serialized); }
      catch (error) {
        try {
          if (previousBackup === null) await unlink(this.backup);
          else await this.replaceFile(this.backup, previousBackup);
        } catch { /* The original primary remains authoritative if recovery-copy rollback also fails. */ }
        throw error;
      }
      this.document = next;
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
