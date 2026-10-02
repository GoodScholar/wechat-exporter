import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sanitizeHtml from 'sanitize-html';
import { marked } from 'marked';

const fields = ['title', 'author', 'account', 'publishedAt', 'body'];
const emptyDocument = () => ({ title: '', author: '', account: '', publishedAt: '', body: '', revision: 0 });

function normalizeDocument(value) {
  const document = emptyDocument();
  for (const field of fields) {
    if (typeof value?.[field] !== 'string') return invalidDocument();
    document[field] = value[field];
  }
  if (!Number.isSafeInteger(value?.revision) || value.revision < 0) return invalidDocument('排版文稿修订号无效');
  document.revision = value.revision;
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
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'typesetting-document.json');
    this.backup = path.join(dataDir, 'typesetting-document.backup.json');
    this.document = null;
    this.writes = Promise.resolve();
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
      if (next.revision < current.revision || (next.revision === current.revision && JSON.stringify(next) !== JSON.stringify(current))) {
        const error = new Error('文稿已更新，请刷新后重试');
        error.status = 409;
        throw error;
      }
      if (next.revision === current.revision) return current;
      const serialized = JSON.stringify(next, null, 2);
      await mkdir(this.dataDir, { recursive: true });
      await writeAtomically(this.file, serialized);
      await writeAtomically(this.backup, serialized);
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
