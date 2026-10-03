import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sanitizeHtml from 'sanitize-html';
import { marked } from 'marked';

const fields = ['title', 'author', 'account', 'publishedAt', 'body'];
const themeSettingKeys = Object.freeze(['primaryColor', 'fontSize', 'lineHeight', 'blockSpacing']);
const themeSettingDefaults = Object.freeze({ primaryColor: '#0F4C81', fontSize: '16px', lineHeight: '1.75', blockSpacing: '1' });
const themeSettingOptions = Object.freeze({
  primaryColor: Object.freeze(['#0F4C81', '#009874', '#FA5151', '#FECE00', '#92617E', '#55C9EA', '#B76E79', '#556B2F', '#333333', '#A9A9A9', '#FFB7C5']),
  fontSize: Object.freeze(['14px', '15px', '16px', '17px', '18px']),
  lineHeight: Object.freeze(['1.5', '1.65', '1.75', '1.9', '2.05']),
  blockSpacing: Object.freeze(['0.75', '0.9', '1', '1.15', '1.35'])
});

export const typesettingThemeNames = Object.freeze(['default', 'grace', 'simple']);

export function createDefaultThemeSettings() {
  return Object.fromEntries(typesettingThemeNames.map(theme => [theme, { ...themeSettingDefaults }]));
}

const hasOwn = (value, key) => typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, key);
const hasExactKeys = (value, keys) => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => hasOwn(value, key));

function normalizeTheme(theme) {
  if (!typesettingThemeNames.includes(theme)) return invalidDocument('排版主题无效');
  return theme;
}

function normalizeThemeSettings(settings) {
  if (!hasExactKeys(settings, themeSettingKeys)) return invalidDocument('排版主题设置无效');
  const normalized = {};
  for (const key of themeSettingKeys) {
    if (!themeSettingOptions[key].includes(settings[key])) return invalidDocument('排版主题设置无效');
    normalized[key] = settings[key];
  }
  return normalized;
}

function normalizeDocumentThemeSettings(settings) {
  if (!hasExactKeys(settings, typesettingThemeNames)) return invalidDocument('排版主题设置无效');
  return Object.fromEntries(typesettingThemeNames.map(theme => [theme, normalizeThemeSettings(settings[theme])]));
}

export function normalizeTypesettingPresentation(value) {
  if (!hasExactKeys(value, ['theme', 'settings'])) return invalidDocument('排版主题配置无效');
  return { theme: normalizeTheme(value.theme), settings: normalizeThemeSettings(value.settings) };
}

const emptyDocument = () => ({
  title: '', author: '', account: '', publishedAt: '', body: '', revision: 0, savedAt: '',
  theme: 'default', themeSettings: createDefaultThemeSettings(), convertExternalLinksToFootnotes: false
});

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
  const hasTheme = hasOwn(value, 'theme');
  const hasThemeSettings = hasOwn(value, 'themeSettings');
  if (hasTheme !== hasThemeSettings) return invalidDocument('排版主题配置无效');
  if (hasTheme) {
    document.theme = normalizeTheme(value.theme);
    document.themeSettings = normalizeDocumentThemeSettings(value.themeSettings);
  }
  if (hasOwn(value, 'convertExternalLinksToFootnotes')) {
    if (typeof value.convertExternalLinksToFootnotes !== 'boolean') return invalidDocument();
    document.convertExternalLinksToFootnotes = value.convertExternalLinksToFootnotes;
  }
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
      const sameContent = fields.every(field => next[field] === current[field])
        && next.theme === current.theme
        && next.convertExternalLinksToFootnotes === current.convertExternalLinksToFootnotes
        && typesettingThemeNames.every(theme => themeSettingKeys.every(key => next.themeSettings[theme][key] === current.themeSettings[theme][key]));
      if (next.revision < current.revision || (next.revision === current.revision && !sameContent)) {
        const error = new Error('文稿已更新，请刷新后重试');
        error.status = 409;
        throw error;
      }
      if (next.revision === current.revision) return current;
      next.savedAt = new Date().toISOString();
      const serialized = JSON.stringify(next, null, 2);
      const currentId = randomUUID();
      const recoveryId = randomUUID();
      await mkdir(this.versions, { recursive: true });
      await this.replaceFile(path.join(this.versions, `${currentId}.json`), serialized);
      await this.replaceFile(path.join(this.versions, `${recoveryId}.json`), serialized);
      await this.replaceFile(this.manifest, JSON.stringify({ current: currentId, recovery: recoveryId }, null, 2));
      this.document = next;
      try {
        const keep = new Set([currentId, recoveryId]);
        for (const name of await readdir(this.versions)) if (name.endsWith('.json') && !keep.has(name.slice(0, -5))) await this.removeFile(path.join(this.versions, name));
      } catch { /* Cleanup is post-commit and never changes the visible manifest. */ }
      return next;
    };
    const result = this.writes.then(operation, operation);
    this.writes = result.catch(() => {});
    return result;
  }
}

export function renderTypesettingMarkdown(body, presentation) {
  const normalizedPresentation = normalizeTypesettingPresentation(presentation);
  if (!body.trim()) return { html: '', presentation: normalizedPresentation };
  const html = sanitizeHtml(marked.parse(body, { gfm: true, breaks: true }), {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'h1', 'h2', 'span'],
    allowedAttributes: { a: ['href', 'title'], img: ['src', 'alt', 'width', 'height'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'], code: ['class'] },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowProtocolRelative: false
  });
  return { html, presentation: normalizedPresentation };
}
