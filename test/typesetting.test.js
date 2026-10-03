import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';
import { browserOptions } from '../src/browser.js';
import { createDefaultThemeSettings, normalizeTypesettingPresentation, renderTypesettingMarkdown, TypesettingStore, typesettingThemeNames } from '../src/typesetting.js';

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function post(base, route, body) {
  return fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

const historyShortcut = (platform, redo = false) => `${platform === 'darwin' ? 'Meta' : 'Control'}+${redo ? 'Shift+' : ''}Z`;

const expectedThemeSettings = {
  default: { primaryColor: '#0F4C81', fontSize: '16px', lineHeight: '1.75', blockSpacing: '1' },
  grace: { primaryColor: '#0F4C81', fontSize: '16px', lineHeight: '1.75', blockSpacing: '1' },
  simple: { primaryColor: '#0F4C81', fontSize: '16px', lineHeight: '1.75', blockSpacing: '1' }
};

const documentWithTheme = (overrides = {}) => ({
  title: '主题文稿', author: '作者', account: '公众号', publishedAt: '2026-10-02', body: '正文',
  theme: 'default', themeSettings: createDefaultThemeSettings(), revision: 1, ...overrides
});

const representativeMarkdown = `# 一级标题

一段含有 *强调* 的文字和[链接](https://example.com)。

- 列表一
- 列表二

> 引用文字

\`\`\`js
const answer = 42;
\`\`\`

![图片](https://example.com/image.png)

---

| 表头 A | 表头 B |
| --- | --- |
| 单元格 A | 单元格 B |`;

test('三套主题对代表性 Markdown 生成完全相同的语义 HTML', () => {
  const renders = typesettingThemeNames.map(theme => renderTypesettingMarkdown({
    body: representativeMarkdown,
    presentation: { theme, settings: expectedThemeSettings[theme] },
    convertExternalLinksToFootnotes: false
  }));
  assert.ok(renders[0].html.includes('<h1>一级标题</h1>'));
  assert.ok(renders[0].html.includes('<table>'));
  assert.deepEqual(renders.map(render => render.html), [renders[0].html, renders[0].html, renders[0].html]);
  assert.deepEqual(renders.map(render => render.presentation), typesettingThemeNames.map(theme => ({
    theme,
    settings: expectedThemeSettings[theme]
  })));
});

test('预览 presentation 拒绝顶层额外键', () => {
  const presentation = { theme: 'default', settings: expectedThemeSettings.default };
  for (const extra of [{ extra: 'ignored' }, { customCss: 'body{display:none}' }]) {
    assert.throws(() => normalizeTypesettingPresentation({ ...presentation, ...extra }), error => error.status === 400);
  }
});

test('预览 API 拒绝顶层 customCss', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-render-top-level-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  try {
    const response = await post(server.base, '/api/typesetting/render', {
      body: representativeMarkdown,
      theme: 'default',
      settings: expectedThemeSettings.default,
      customCss: 'body{display:none}'
    });
    assert.equal(response.status, 400);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('预览 API 只返回白名单 presentation 并原子拒绝非法主题值', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-render-presentation-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  try {
    const settings = { primaryColor: '#009874', fontSize: '18px', lineHeight: '2.05', blockSpacing: '1.35' };
    const accepted = await post(server.base, '/api/typesetting/render', { body: representativeMarkdown, theme: 'grace', settings });
    assert.equal(accepted.status, 200);
    const payload = await accepted.json();
    assert.deepEqual(payload.presentation, { theme: 'grace', settings });
    assert.deepEqual(Object.keys(payload).sort(), ['blocked', 'diagnostics', 'html', 'presentation']);

    const invalidPresentations = [
      { body: representativeMarkdown, theme: 'unknown', settings },
      { body: representativeMarkdown, theme: 'grace', settings: { primaryColor: '#009874', fontSize: '18px', lineHeight: '2.05' } },
      { body: representativeMarkdown, theme: 'grace', settings: { ...settings, unsafe: 'value' } },
      { body: representativeMarkdown, theme: 'grace', settings: { ...settings, primaryColor: 'red; background:url(https://example.com/x)' } },
      { body: representativeMarkdown, theme: 'grace', settings: { ...settings, fontSize: '999px' } }
    ];
    for (const body of invalidPresentations) assert.equal((await post(server.base, '/api/typesetting/render', body)).status, 400);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('三套主题样式全部作用域化且不加载外部资源', async () => {
  const css = await readFile(new URL('../public/typesetting-theme.css', import.meta.url), 'utf8');
  for (const theme of typesettingThemeNames) {
    assert.match(css, new RegExp(`\\.typeset-preview\\.typeset-theme-${theme}`));
    assert.match(css, new RegExp(`\\.typeset-preview\\.typeset-theme-${theme} h[1-3]`));
  }
  for (const variable of ['--md-primary-color', '--md-font-size', '--md-line-height', '--md-block-spacing']) assert.match(css, new RegExp(variable));
  assert.doesNotMatch(css, /@import|@font-face|<script|https?:\/\/|url\(/i);
  assert.doesNotMatch(css, /(^|,|})\s*(?:h[1-6]|p|blockquote|ul|ol|li|pre|code|img|a|hr|table|th|td)\b/m);
});

test('第三方说明记录三套主题、设置来源、固定提交和许可证', async () => {
  const notices = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  for (const source of [
    'packages/shared/src/configs/theme-css/default.css',
    'packages/shared/src/configs/theme-css/grace.css',
    'packages/shared/src/configs/theme-css/simple.css',
    'packages/shared/src/configs/style.ts',
    'apps/web/src/stores/theme.ts',
    'a7c17fc4cda92e3c13aa7e24f06615cfa4219b31',
    'WTFPL v2'
  ]) assert.match(notices, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(notices, /主色|字号|行距|段间距/);
});

test('浏览器原生撤销快捷键按宿主平台映射', () => {
  assert.equal(historyShortcut('darwin'), 'Meta+Z');
  assert.equal(historyShortcut('darwin', true), 'Meta+Shift+Z');
  assert.equal(historyShortcut('linux'), 'Control+Z');
  assert.equal(historyShortcut('linux', true), 'Control+Shift+Z');
});

test('排版文稿经真实 HTTP 保存、渲染、重启和备份恢复，过时修订不会覆盖较新正文', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-'));
  const dataDir = path.join(root, '.data');
  let server = await serve(createApp({ dataDir, interval: 0 }));
  try {
    const exportPage = await (await fetch(server.base + '/')).text();
    assert.match(exportPage, /文章导出/);
    assert.match(exportPage, /公众号排版/);
    assert.doesNotMatch(exportPage, /素材|发布/);
    const initial = await (await fetch(server.base + '/api/typesetting/document')).json();
    assert.deepEqual(initial.document, {
      title: '', author: '', account: '', publishedAt: '', body: '', revision: 0, savedAt: '',
      theme: 'default', themeSettings: expectedThemeSettings, convertExternalLinksToFootnotes: false
    });
    const unsafe = '# 标题\n\n<script>alert(1)</script><img src="javascript:alert(1)" onerror="alert(2)">\n\n[危险](javascript:alert(3))';
    const preview = await (await post(server.base, '/api/typesetting/render', {
      body: unsafe,
      theme: 'default',
      settings: expectedThemeSettings.default
    })).json();
    assert.match(preview.html, /<h1/);
    assert.doesNotMatch(preview.html, /script|onerror|javascript:/i);
    assert.equal((await post(server.base, '/api/typesetting/document', { title: '第一篇', author: '作者', account: '公众号', publishedAt: '2026-10-02', body: '较旧的正文', revision: 1 })).status, 200);
    assert.equal((await post(server.base, '/api/typesetting/document', { title: '第一篇', author: '作者', account: '公众号', publishedAt: '2026-10-02', body: '较新的正文', revision: 2 })).status, 200);
    const stale = await post(server.base, '/api/typesetting/document', { title: '旧标题', author: '作者', account: '公众号', publishedAt: '2026-10-02', body: '旧正文', revision: 1 });
    assert.equal(stale.status, 409);
    const saved = (await (await fetch(server.base + '/api/typesetting/document')).json()).document;
    assert.equal(saved.body, '较新的正文');
    assert.match(saved.savedAt, /^\d{4}-\d{2}-\d{2}T/);
    await server.close();
    server = await serve(createApp({ dataDir, interval: 0 }));
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.author, '作者');
    const manifest = JSON.parse(await readFile(path.join(dataDir, 'typesetting-document.manifest.json'), 'utf8'));
    assert.notEqual(manifest.current, manifest.recovery);
    assert.equal(await readFile(path.join(dataDir, 'typesetting-versions', `${manifest.current}.json`), 'utf8'), await readFile(path.join(dataDir, 'typesetting-versions', `${manifest.recovery}.json`), 'utf8'));
    await writeFile(path.join(dataDir, 'typesetting-versions', `${manifest.current}.json`), '{corrupted');
    await server.close();
    server = await serve(createApp({ dataDir, interval: 0 }));
    const restored = await (await fetch(server.base + '/api/typesetting/document')).json();
    assert.equal(restored.document.body, '较新的正文');
    assert.equal(restored.document.revision, 2);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('首次保存会保留与 current 物理独立的同版本 recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-first-recovery-'));
  const dataDir = path.join(root, '.data');
  const store = new TypesettingStore(dataDir);
  try {
    const saved = await store.save({ title: '第一篇', author: '作者', account: '公众号', publishedAt: '2026-10-02', body: '第一版正文', revision: 1 });
    const manifest = JSON.parse(await readFile(store.manifest, 'utf8'));
    assert.notEqual(manifest.current, manifest.recovery);
    assert.equal(await readFile(path.join(store.versions, `${manifest.current}.json`), 'utf8'), await readFile(path.join(store.versions, `${manifest.recovery}.json`), 'utf8'));
    await writeFile(path.join(store.versions, `${manifest.current}.json`), '{corrupted');
    assert.deepEqual(await new TypesettingStore(dataDir).load(), saved);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('旧排版文稿补齐三套默认主题并在下次保存后跨重启持久化', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-theme-migration-'));
  const store = new TypesettingStore(path.join(root, '.data'));
  const legacy = { title: '旧标题', author: '旧作者', account: '旧公众号', publishedAt: '2026-09-01', body: '旧正文', revision: 1, savedAt: '' };
  try {
    assert.deepEqual(typesettingThemeNames, ['default', 'grace', 'simple']);
    assert.equal(Object.isFrozen(typesettingThemeNames), true);
    const firstDefaults = createDefaultThemeSettings();
    const secondDefaults = createDefaultThemeSettings();
    assert.deepEqual(firstDefaults, expectedThemeSettings);
    firstDefaults.default.primaryColor = '#009874';
    assert.equal(firstDefaults.grace.primaryColor, '#0F4C81');
    assert.equal(secondDefaults.default.primaryColor, '#0F4C81');

    await mkdir(store.dataDir, { recursive: true });
    await writeFile(store.file, JSON.stringify(legacy), 'utf8');
    const migrated = await store.load();
    assert.deepEqual(migrated, { ...legacy, theme: 'default', themeSettings: expectedThemeSettings, convertExternalLinksToFootnotes: false });

    const saved = await store.save({ ...migrated, revision: 2 });
    assert.deepEqual(await new TypesettingStore(store.dataDir).load(), saved);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('排版文稿拒绝不完整、额外或越界的主题设置且不改变已保存版本', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-theme-validation-'));
  const dataDir = path.join(root, '.data');
  const store = new TypesettingStore(dataDir);
  const server = await serve(createApp({ dataDir, interval: 0, typesettingStore: store }));
  try {
    const saved = await store.save(documentWithTheme());
    const manifest = JSON.parse(await readFile(store.manifest, 'utf8'));
    const persisted = {
      manifest: await readFile(store.manifest, 'utf8'),
      current: await readFile(path.join(store.versions, `${manifest.current}.json`), 'utf8'),
      recovery: await readFile(path.join(store.versions, `${manifest.recovery}.json`), 'utf8')
    };
    const missingSetting = { ...saved.themeSettings.default };
    delete missingSetting.lineHeight;
    const invalidDocuments = [
      { ...saved, revision: 2, themeSettings: undefined },
      { ...saved, revision: 2, themeSettings: { ...saved.themeSettings, extra: createDefaultThemeSettings().default } },
      { ...saved, revision: 2, themeSettings: { ...saved.themeSettings, default: missingSetting } },
      { ...saved, revision: 2, themeSettings: { ...saved.themeSettings, default: { ...saved.themeSettings.default, arbitrary: 'value' } } },
      { ...saved, revision: 2, themeSettings: { ...saved.themeSettings, default: { ...saved.themeSettings.default, primaryColor: '#FFFFFF' } } }
    ];
    for (const document of invalidDocuments) assert.equal((await post(server.base, '/api/typesetting/document', document)).status, 400);

    assert.deepEqual(normalizeTypesettingPresentation({ theme: 'grace', settings: saved.themeSettings.grace }), {
      theme: 'grace', settings: expectedThemeSettings.grace
    });
    for (const presentation of [
      { theme: 'unknown', settings: saved.themeSettings.default },
      { theme: 'default', settings: missingSetting },
      { theme: 'default', settings: { ...saved.themeSettings.default, primaryColor: '#FFFFFF' } }
    ]) assert.throws(() => normalizeTypesettingPresentation(presentation), error => error.status === 400);

    assert.deepEqual({
      manifest: await readFile(store.manifest, 'utf8'),
      current: await readFile(path.join(store.versions, `${manifest.current}.json`), 'utf8'),
      recovery: await readFile(path.join(store.versions, `${manifest.recovery}.json`), 'utf8')
    }, persisted);
    assert.deepEqual(await new TypesettingStore(dataDir).load(), saved);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('主题及非当前主题设置参与修订冲突和内容相等判断', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-theme-revision-'));
  const store = new TypesettingStore(path.join(root, '.data'));
  try {
    const saved = await store.save(documentWithTheme());
    assert.equal(await store.save({ ...saved }), saved);
    await assert.rejects(store.save({ ...saved, theme: 'grace' }), error => error.status === 409);
    const changedNonCurrentTheme = createDefaultThemeSettings();
    changedNonCurrentTheme.simple.primaryColor = '#009874';
    await assert.rejects(store.save({ ...saved, themeSettings: changedNonCurrentTheme }), error => error.status === 409);
    await assert.rejects(store.save({ ...saved, theme: 'simple', revision: 0 }), error => error.status === 409);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('主题设置写入失败时旧配置仍是内存和重启后的唯一可见状态', async () => {
  for (const phase of ['current-version', 'recovery-version', 'manifest']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-theme-write-failure-'));
    let failWrites = false;
    let candidateWrites = 0;
    const writeAtomically = async (file, text) => {
      if (failWrites && file.includes('typesetting-versions')) {
        candidateWrites++;
        if (phase === 'current-version' && candidateWrites === 1 || phase === 'recovery-version' && candidateWrites === 2) throw new Error('disk denied');
      }
      if (failWrites && phase === 'manifest' && file.endsWith('typesetting-document.manifest.json')) throw new Error('disk denied');
      await writeFile(file, text, 'utf8');
    };
    const store = new TypesettingStore(path.join(root, '.data'), { writeAtomically });
    try {
      const saved = await store.save(documentWithTheme());
      const manifest = JSON.parse(await readFile(store.manifest, 'utf8'));
      const persisted = {
        manifest: await readFile(store.manifest, 'utf8'),
        current: await readFile(path.join(store.versions, `${manifest.current}.json`), 'utf8'),
        recovery: await readFile(path.join(store.versions, `${manifest.recovery}.json`), 'utf8')
      };
      const nextSettings = createDefaultThemeSettings();
      nextSettings.grace.primaryColor = '#FA5151';
      failWrites = true;
      candidateWrites = 0;
      await assert.rejects(store.save({ ...saved, theme: 'grace', themeSettings: nextSettings, revision: 2 }), /disk denied/);
      assert.deepEqual({
        manifest: await readFile(store.manifest, 'utf8'),
        current: await readFile(path.join(store.versions, `${manifest.current}.json`), 'utf8'),
        recovery: await readFile(path.join(store.versions, `${manifest.recovery}.json`), 'utf8')
      }, persisted, phase);
      assert.deepEqual(await store.load(), saved, phase);
      assert.deepEqual(await new TypesettingStore(store.dataDir).load(), saved, phase);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('旧文稿默认关闭外链脚注并在下次保存后跨重启持久化', async () => {
  for (const source of ['current-version', 'recovery-version', 'legacy-current', 'legacy-backup']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-footnote-migration-'));
    const store = new TypesettingStore(path.join(root, '.data'));
    const legacy = documentWithTheme({ title: `expected-${source}`, body: `expected-body-${source}`, revision: 0, savedAt: '' });
    const decoy = documentWithTheme({ title: `decoy-${source}`, body: `decoy-body-${source}`, revision: 0, savedAt: '' });
    try {
      await mkdir(store.dataDir, { recursive: true });
      if (source === 'current-version' || source === 'recovery-version') {
        await mkdir(store.versions, { recursive: true });
        await writeFile(path.join(store.versions, 'current.json'), source === 'current-version' ? JSON.stringify(legacy) : '{corrupted', 'utf8');
        await writeFile(path.join(store.versions, 'recovery.json'), JSON.stringify(source === 'current-version' ? decoy : legacy), 'utf8');
        await writeFile(store.manifest, JSON.stringify({ current: 'current', recovery: 'recovery' }), 'utf8');
      } else {
        await writeFile(store.file, source === 'legacy-current' ? JSON.stringify(legacy) : '{corrupted', 'utf8');
        await writeFile(store.backup, JSON.stringify(source === 'legacy-current' ? decoy : legacy), 'utf8');
      }

      const migrated = await store.load();
      assert.equal(migrated.title, legacy.title, source);
      assert.equal(migrated.body, legacy.body, source);
      assert.equal(migrated.convertExternalLinksToFootnotes, false, source);
      assert.equal(migrated.revision, 0, source);
      const saved = await store.save({ ...migrated, convertExternalLinksToFootnotes: true, revision: 1 });
      assert.equal(saved.convertExternalLinksToFootnotes, true, source);
      assert.equal((await new TypesettingStore(store.dataDir).load()).convertExternalLinksToFootnotes, true, source);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('外链脚注开关参与内容相等、revision 冲突和幂等判断', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-footnote-revision-'));
  const store = new TypesettingStore(path.join(root, '.data'));
  try {
    const saved = await store.save(documentWithTheme({ convertExternalLinksToFootnotes: false }));
    assert.equal(await store.save({ ...saved }), saved);
    await assert.rejects(store.save({ ...saved, convertExternalLinksToFootnotes: true }), error => error.status === 409);
    await assert.rejects(store.save({ ...saved, convertExternalLinksToFootnotes: true, revision: 0 }), error => error.status === 409);
    await assert.rejects(store.save({ ...saved, convertExternalLinksToFootnotes: 'true', revision: 2 }), error => error.status === 400);

    const enabled = await store.save({ ...saved, convertExternalLinksToFootnotes: true, revision: 2 });
    assert.equal(enabled.convertExternalLinksToFootnotes, true);
    assert.equal(await store.save({ ...enabled }), enabled);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('外链脚注开关写入任一提交阶段失败时旧值仍唯一可见', async () => {
  for (const phase of ['current-version', 'recovery-version', 'manifest']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-footnote-write-failure-'));
    let failWrites = false;
    let candidateWrites = 0;
    const writeAtomically = async (file, text) => {
      if (failWrites && file.includes('typesetting-versions')) {
        candidateWrites++;
        if (phase === 'current-version' && candidateWrites === 1 || phase === 'recovery-version' && candidateWrites === 2) throw new Error('disk denied');
      }
      if (failWrites && phase === 'manifest' && file.endsWith('typesetting-document.manifest.json')) throw new Error('disk denied');
      await writeFile(file, text, 'utf8');
    };
    const store = new TypesettingStore(path.join(root, '.data'), { writeAtomically });
    try {
      const saved = await store.save(documentWithTheme({ convertExternalLinksToFootnotes: false }));
      const manifest = JSON.parse(await readFile(store.manifest, 'utf8'));
      const persisted = {
        manifest: await readFile(store.manifest, 'utf8'),
        current: await readFile(path.join(store.versions, `${manifest.current}.json`), 'utf8'),
        recovery: await readFile(path.join(store.versions, `${manifest.recovery}.json`), 'utf8')
      };
      failWrites = true;
      candidateWrites = 0;
      await assert.rejects(store.save({ ...saved, convertExternalLinksToFootnotes: true, revision: 2 }), /disk denied/);
      assert.deepEqual({
        manifest: await readFile(store.manifest, 'utf8'),
        current: await readFile(path.join(store.versions, `${manifest.current}.json`), 'utf8'),
        recovery: await readFile(path.join(store.versions, `${manifest.recovery}.json`), 'utf8')
      }, persisted, phase);
      assert.equal((await store.load()).convertExternalLinksToFootnotes, false, phase);
      assert.equal((await new TypesettingStore(store.dataDir).load()).convertExternalLinksToFootnotes, false, phase);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('慢的旧预览响应不能覆盖较新的预览', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-preview-race-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    let releaseFirst;
    let firstFetched;
    const firstReady = new Promise(resolve => { firstFetched = resolve; });
    let renders = 0;
    await page.route('**/api/typesetting/render', async route => {
      const response = await route.fetch();
      if (renders++ === 0) { firstFetched(); await new Promise(resolve => { releaseFirst = resolve; }); }
      await route.fulfill({ response });
    });
    await page.getByLabel('Markdown 正文').fill('# 第一版');
    await firstReady;
    await page.getByLabel('Markdown 正文').fill('# 第二版');
    await page.getByRole('heading', { name: '第二版' }).waitFor({ timeout: 1000 });
    releaseFirst();
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole('heading', { name: '第二版' }).count(), 1);
    assert.equal(await page.getByRole('heading', { name: '第一版' }).count(), 0);
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('工作台切换三套主题时正文结构不变且即时应用服务端 presentation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-theme-switch-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.getByLabel('Markdown 正文').fill('# 相同结构\n\n正文');
    await page.getByRole('heading', { name: '相同结构' }).waitFor({ timeout: 1500 });
    const html = await page.locator('#preview').innerHTML();
    for (const [theme, color] of [['grace', '#009874'], ['simple', '#FA5151']]) {
      await page.locator('#document-theme').selectOption(theme);
      await page.getByLabel('主色').selectOption(color);
      await page.waitForFunction(({ theme, color }) => {
        const preview = document.querySelector('#preview');
        return preview.classList.contains(`typeset-theme-${theme}`) && preview.style.getPropertyValue('--md-primary-color') === color;
      }, { theme, color });
      assert.equal(await page.locator('#preview').innerHTML(), html);
      assert.equal(await page.locator('#document-theme').inputValue(), theme);
    }
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('每套主题独立记忆四项设置并只重置当前主题', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-theme-isolation-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.getByLabel('主色').selectOption('#009874');
    await page.getByLabel('字号').selectOption('18px');
    await page.locator('#document-theme').selectOption('grace');
    assert.equal(await page.getByLabel('主色').inputValue(), '#0F4C81');
    await page.getByLabel('行距').selectOption('2.05');
    await page.getByRole('button', { name: '恢复当前主题默认值' }).click();
    assert.equal(await page.getByLabel('行距').inputValue(), '1.75');
    await page.locator('#document-theme').selectOption('default');
    assert.equal(await page.getByLabel('主色').inputValue(), '#009874');
    assert.equal(await page.getByLabel('字号').inputValue(), '18px');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('主题设置自动保存并在刷新和服务重启后恢复', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-theme-persistence-'));
  const dataDir = path.join(root, '.data');
  let server = await serve(createApp({ dataDir, interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    const saves = [];
    await page.route('**/api/typesetting/document', async route => {
      if (route.request().method() === 'POST') saves.push(route.request().postDataJSON());
      await route.continue();
    });
    await page.goto(server.base + '/typesetting');
    const saved = page.waitForResponse(response => response.url().endsWith('/api/typesetting/document') && response.request().method() === 'POST' && response.ok());
    await page.locator('#document-theme').selectOption('simple');
    await page.getByLabel('段间距').selectOption('1.35');
    await saved;
    assert.deepEqual(saves.at(-1).themeSettings.default, expectedThemeSettings.default);
    assert.equal(saves.at(-1).themeSettings.simple.blockSpacing, '1.35');
    await page.reload();
    await page.locator('#document-theme').waitFor();
    assert.equal(await page.locator('#document-theme').inputValue(), 'simple');
    assert.equal(await page.getByLabel('段间距').inputValue(), '1.35');
    await server.close();
    server = await serve(createApp({ dataDir, interval: 0 }));
    await page.goto(server.base + '/typesetting');
    await page.locator('#document-theme').waitFor();
    assert.equal(await page.locator('#document-theme').inputValue(), 'simple');
    assert.equal(await page.getByLabel('段间距').inputValue(), '1.35');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('慢的旧主题预览不会覆盖较新的主题类和变量', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-theme-preview-race-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    let releaseFirst;
    let firstReached;
    const first = new Promise(resolve => { firstReached = resolve; });
    let renders = 0;
    await page.route('**/api/typesetting/render', async route => {
      const response = await route.fetch();
      if (renders++ === 0) { firstReached(); await new Promise(resolve => { releaseFirst = resolve; }); }
      await route.fulfill({ response });
    });
    await page.locator('#document-theme').selectOption('grace');
    await first;
    await page.locator('#document-theme').selectOption('simple');
    await page.waitForFunction(() => {
      const preview = document.querySelector('#preview');
      return preview.classList.contains('typeset-theme-simple') && preview.style.getPropertyValue('--md-primary-color') === '#0F4C81';
    });
    releaseFirst();
    await page.waitForTimeout(100);
    const presentation = await page.locator('#preview').evaluate(preview => ({
      classes: [...preview.classList].filter(name => name.startsWith('typeset-theme-')),
      primaryColor: preview.style.getPropertyValue('--md-primary-color')
    }));
    assert.deepEqual(presentation, { classes: ['typeset-theme-simple'], primaryColor: '#0F4C81' });
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('工作台不会静默水合缺失主题设置的文稿响应', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-theme-hydration-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    const previews = [];
    await page.route('**/api/typesetting/document', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ document: { title: '', author: '', account: '', publishedAt: '', body: '', revision: 0, savedAt: '', theme: 'grace' } })
    }));
    await page.route('**/api/typesetting/render', async route => {
      previews.push(route.request().postDataJSON());
      await route.continue();
    });
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#document-theme').inputValue(), 'default');
    assert.equal(await page.getByLabel('主色').inputValue(), '#0F4C81');
    assert.deepEqual(previews.map(request => request.theme), ['default']);
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('畸形的预览 200 不会部分覆盖上一份主题 presentation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-theme-preview-malformed-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.locator('#document-theme').selectOption('grace');
    await page.getByLabel('主色').selectOption('#009874');
    await page.waitForFunction(() => document.querySelector('#preview').classList.contains('typeset-theme-grace'));
    const before = await page.locator('#preview').evaluate(preview => ({ html: preview.innerHTML, className: preview.className, style: preview.getAttribute('style') }));
    await page.route('**/api/typesetting/render', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ html: '<h1>不应显示</h1>', presentation: { theme: 'simple', settings: { primaryColor: '#FA5151' } } })
    }));
    await page.locator('#document-theme').selectOption('simple');
    await page.waitForTimeout(300);
    assert.deepEqual(await page.locator('#preview').evaluate(preview => ({ html: preview.innerHTML, className: preview.className, style: preview.getAttribute('style') })), before);
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('文章导入和富文本粘贴不会重置或污染主题设置', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-theme-content-regression-'));
  const server = await serve(createApp({
    dataDir: path.join(root, '.data'), interval: 0,
    fetchArticle: async () => '<html><head><meta property="og:title" content="导入标题"></head><body><div id="js_content"><p>导入正文</p></div></body></html>'
  }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    const saved = page.waitForResponse(response => response.url().endsWith('/api/typesetting/document') && response.request().method() === 'POST' && response.ok());
    await page.locator('#document-theme').selectOption('grace');
    await page.getByLabel('主色').selectOption('#FECE00');
    await page.getByLabel('Markdown 正文').fill('导入前正文');
    await saved;
    let releaseImport;
    let importReached;
    const reached = new Promise(resolve => { importReached = resolve; });
    await page.route('**/api/typesetting/import', async route => {
      const response = await route.fetch();
      importReached();
      await new Promise(resolve => { releaseImport = resolve; });
      await route.fulfill({ response });
    });
    await page.evaluate(() => { window.confirm = () => true; });
    await page.getByLabel('导入公众号文章链接').fill('https://mp.weixin.qq.com/s/local');
    await page.getByRole('button', { name: '导入文章' }).click();
    await reached;
    assert.equal(await page.locator('#document-theme').isDisabled(), true);
    for (const label of ['主色', '字号', '行距', '段间距']) assert.equal(await page.getByLabel(label).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '恢复当前主题默认值' }).isDisabled(), true);
    releaseImport();
    await page.getByText('文章已导入', { exact: false }).waitFor();
    assert.equal(await page.locator('#document-theme').inputValue(), 'grace');
    assert.equal(await page.getByLabel('主色').inputValue(), '#FECE00');
    const beforePaste = (await (await fetch(server.base + '/api/typesetting/document')).json()).document;
    const savedPaste = page.waitForResponse(response => response.url().endsWith('/api/typesetting/document') && response.request().method() === 'POST' && response.ok());
    assert.equal((await dispatchPaste(page, { html: '<p><strong>粘贴正文</strong></p>' })).defaultPrevented, true);
    await page.getByText('已转换富文本', { exact: false }).waitFor();
    await savedPaste;
    const afterPaste = (await (await fetch(server.base + '/api/typesetting/document')).json()).document;
    assert.equal(await page.locator('#document-theme').inputValue(), 'grace');
    assert.equal(await page.getByLabel('主色').inputValue(), '#FECE00');
    assert.equal(afterPaste.theme, beforePaste.theme);
    assert.deepEqual(afterPaste.themeSettings, beforePaste.themeSettings);
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('主题设置在窄屏可操作且页面不产生横向溢出', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-theme-mobile-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(server.base + '/typesetting');
    await page.locator('#document-theme').selectOption('simple');
    await page.getByLabel('字号').selectOption('14px');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('自动保存等待期、请求期和 hidden 刷新有可观察状态与时序', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-timing-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    const saves = [];
    const previews = [];
    let releaseSave;
    let saveHeld;
    const firstSaveHeld = new Promise(resolve => { saveHeld = resolve; });
    let holdNextSave = true;
    await page.route('**/api/typesetting/document', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      saves.push(Date.now());
      const response = await route.fetch();
      if (holdNextSave) { await new Promise(resolve => { releaseSave = resolve; saveHeld(); }); }
      await route.fulfill({ response });
    });
    await page.route('**/api/typesetting/render', async route => { previews.push(Date.now()); await route.continue(); });
    const started = Date.now();
    await page.getByLabel('Markdown 正文').fill('# 时序');
    assert.equal(await page.getByText('未保存', { exact: true }).count(), 1);
    await page.waitForTimeout(120);
    assert.equal(previews.length, 0);
    assert.equal(saves.length, 0);
    await page.waitForTimeout(250);
    assert.equal(previews.length, 1);
    assert.ok(previews[0] - started >= 150);
    await page.waitForTimeout(50);
    assert.equal(saves.length, 0);
    await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === '保存中', undefined, { timeout: 1000 });
    await Promise.race([
      firstSaveHeld,
      new Promise((_, reject) => setTimeout(() => reject(new Error('自动保存请求未在 1000ms 内进入拦截路由')), 1000)),
    ]);
    assert.equal(saves.length, 1);
    assert.ok(saves[0] - started >= 450);
    assert.ok(saves[0] - started < 1000, '自动保存请求必须在约 500ms 防抖后的一秒内启动');
    releaseSave();
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1000 });
    assert.ok(Date.now() - started < 1000, '自动保存完成必须在输入后的一秒内可见');
    holdNextSave = false;
    const hiddenStarted = Date.now();
    await page.getByLabel('Markdown 正文').fill('# hidden 刷新');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === '已保存', undefined, { timeout: 1000 });
    assert.equal(saves.length, 2);
    assert.ok(saves[1] - hiddenStarted < 300);
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, '# hidden 刷新');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('并发保存冲突保留未保存状态并给出重新载入提示', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-conflict-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const first = await browser.newPage();
    const second = await browser.newPage();
    await Promise.all([first.goto(server.base + '/typesetting'), second.goto(server.base + '/typesetting')]);
    await Promise.all([first.waitForTimeout(250), second.waitForTimeout(250)]);
    await first.getByLabel('Markdown 正文').fill('第一位编辑者');
    await first.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
    await second.getByLabel('Markdown 正文').fill('第二位编辑者');
    await second.getByText('未保存', { exact: true }).waitFor({ timeout: 1500 });
    await second.getByText('其他页面', { exact: false }).waitFor();
    assert.doesNotMatch(await second.locator('#save-message').textContent(), /数据目录/);
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, '第一位编辑者');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('工作台约 500ms 自动保存、预览防抖、页面隐藏刷新并展示保存状态', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-ui-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.getByLabel('Markdown 正文').fill('# 新文稿');
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 2000 });
    await page.getByRole('heading', { name: '新文稿' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: '新文稿' }).evaluate(element => getComputedStyle(element).borderBottomColor), 'rgb(15, 76, 129)');
    await page.getByLabel('Markdown 正文').fill('# 隐藏刷新');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1000 });
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, '# 隐藏刷新');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('工作台保存失败时保留未保存状态并给出可操作提示', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-failure-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0, typesettingStore: {
    load: async () => documentWithTheme({ title: '', author: '', account: '', publishedAt: '', body: '', revision: 0, savedAt: '' }),
    save: async () => { throw new Error('磁盘不可写'); }
  } }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    assert.equal((await post(server.base, '/api/typesetting/document', { title: '', author: '', account: '', publishedAt: '', body: '无法保存', revision: 1 })).status, 500);
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.getByLabel('Markdown 正文').fill('无法保存');
    await page.getByText('未保存', { exact: true }).waitFor({ timeout: 2000 });
    await page.getByText('请检查本机数据目录', { exact: false }).waitFor();
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('自动保存遇到慢响应时，最新输入仍会成为已保存文稿', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-race-'));
  const store = new TypesettingStore(path.join(root, '.data'));
  let releaseFirst;
  let firstSaved;
  const firstReached = new Promise(resolve => { firstSaved = resolve; });
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0, typesettingStore: {
    load: () => store.load(),
    async save(document) {
      const saved = await store.save(document);
      if (document.body === '第一版') { firstSaved(); await new Promise(resolve => { releaseFirst = resolve; }); }
      return saved;
    }
  } }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.getByLabel('Markdown 正文').fill('第一版');
    await firstReached;
    await page.getByLabel('Markdown 正文').fill('第二版');
    await page.waitForTimeout(650);
    releaseFirst();
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 2000 });
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, '第二版');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

async function dispatchPaste(page, { html = '', text = '' }) {
  return await page.evaluate(({ html, text }) => {
    const clipboard = new DataTransfer();
    if (text) clipboard.setData('text/plain', text);
    if (html) clipboard.setData('text/html', html);
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard });
    const body = document.querySelector('#document-body');
    body.dispatchEvent(event);
    if (!event.defaultPrevented && text) {
      body.setRangeText(text, body.selectionStart, body.selectionEnd, 'end');
      body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
    }
    return { defaultPrevented: event.defaultPrevented, value: body.value };
  }, { html, text });
}

test('纯文本粘贴保持原生路径；富文本确认后按触发选区插入并自动保存', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-rich-paste-ui-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    await page.route('https://example.test/**', route => route.abort());
    let conversionRequests = 0;
    await page.route('**/api/typesetting/rich-text', async route => { conversionRequests++; await route.continue(); });

    const plainPaste = await dispatchPaste(page, { text: '纯文本' });
    assert.equal(plainPaste.defaultPrevented, false, '纯文本必须不阻止浏览器原生粘贴');
    assert.equal(plainPaste.value, '纯文本', '合成事件的原生默认插入等价路径应更新正文');
    assert.equal(conversionRequests, 0, '纯文本不得请求转换 API');

    await page.getByLabel('标题').fill('原有标题');
    await page.getByLabel('Markdown 正文').fill('甲乙丙');
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
    const before = await (await fetch(server.base + '/api/typesetting/document')).json();
    const previewBefore = await page.locator('#preview').innerHTML();
    await page.evaluate(() => { window.confirm = () => false; document.querySelector('#document-body').setSelectionRange(1, 2); });
    assert.equal((await dispatchPaste(page, { html: '<strong>取消内容</strong>' })).defaultPrevented, true);
    await page.waitForTimeout(100);
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '甲乙丙');
    assert.equal(await page.locator('#preview').innerHTML(), previewBefore);
    assert.deepEqual(await (await fetch(server.base + '/api/typesetting/document')).json(), before);
    assert.equal(conversionRequests, 0, '取消不得请求转换 API');

    await page.evaluate(() => { window.confirm = () => true; document.querySelector('#document-body').setSelectionRange(1, 2); });
    assert.equal((await dispatchPaste(page, { html: '<strong>粗体</strong><video src="https://example.test/video.mp4"></video>' })).defaultPrevented, true);
    await page.waitForFunction(() => document.querySelector('#document-body').value.includes('**粗体**') && document.querySelector('#document-body').value.includes('特殊内容：视频'));
    assert.match(await page.getByLabel('Markdown 正文').inputValue(), /^甲[\s\S]*粗体[\s\S]*特殊内容：视频[\s\S]*丙$/);
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
    await page.getByText('粗体', { exact: true }).waitFor();
    await page.getByText('特殊内容：视频', { exact: false }).waitFor();
    const saved = (await (await fetch(server.base + '/api/typesetting/document')).json()).document;
    assert.equal(saved.title, '原有标题');
    assert.match(saved.body, /\*\*粗体\*\*/);
    assert.match(saved.body, /特殊内容：视频/);
    assert.equal(conversionRequests, 1);
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('富文本转换失败或旧响应到达时不修改当前文稿', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-rich-paste-race-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    await page.getByLabel('Markdown 正文').fill('失败前正文');
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
    const before = await (await fetch(server.base + '/api/typesetting/document')).json();
    const previewBefore = await page.locator('#preview').innerHTML();
    await page.evaluate(() => { window.confirm = () => true; document.querySelector('#document-body').setSelectionRange(1, 3); });
    await page.route('**/api/typesetting/rich-text', route => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'EMPTY_RICH_TEXT', message: '富文本中没有可转换的可读内容。', action: '请保留正文文字后重试。' } }) }));
    assert.equal((await dispatchPaste(page, { html: '<p>不会插入</p>' })).defaultPrevented, true);
    await page.getByText('请保留正文文字后重试。', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '失败前正文');
    assert.equal(await page.locator('#preview').innerHTML(), previewBefore);
    assert.deepEqual(await (await fetch(server.base + '/api/typesetting/document')).json(), before);
    await page.unroute('**/api/typesetting/rich-text');

    let release;
    let requestReached;
    const responseHeld = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { requestReached = resolve; });
    await page.route('**/api/typesetting/rich-text', async route => {
      requestReached();
      const response = await route.fetch();
      await responseHeld;
      await route.fulfill({ response });
    });
    await page.evaluate(() => document.querySelector('#document-body').setSelectionRange(1, 3));
    assert.equal((await dispatchPaste(page, { html: '<strong>旧结果</strong>' })).defaultPrevented, true);
    await reached;
    await page.getByLabel('Markdown 正文').fill('临时新编辑');
    await page.getByLabel('Markdown 正文').fill('失败前正文');
    await page.evaluate(() => document.querySelector('#document-body').setSelectionRange(1, 3));
    release();
    await page.getByText('正文或选区已变化，请重新粘贴后重试。', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '失败前正文');
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, '失败前正文');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('块级富文本插入行内选区时保留 Markdown 与预览的块边界', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-rich-paste-block-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    await page.getByLabel('Markdown 正文').fill('甲乙丙');
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
    await page.evaluate(() => { window.confirm = () => true; document.querySelector('#document-body').setSelectionRange(1, 2); });
    assert.equal((await dispatchPaste(page, { html: '<h1>插入标题</h1>' })).defaultPrevented, true);
    await page.getByRole('heading', { name: '插入标题' }).waitFor();
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '甲\n\n# 插入标题\n\n丙');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('多段富文本插入选区时保留两侧 Markdown 块边界', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-rich-paste-paragraphs-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    await page.getByLabel('Markdown 正文').fill('甲乙丙');
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
    await page.evaluate(() => { window.confirm = () => true; document.querySelector('#document-body').setSelectionRange(1, 2); });
    assert.equal((await dispatchPaste(page, { html: '<div>第一段</div><div>第二段</div>' })).defaultPrevented, true);
    await page.getByText('第二段', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '甲\n\n第一段\n\n第二段\n\n丙');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('单块和不同既有换行的富文本插入均保留两侧块边界', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-rich-paste-boundaries-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    await page.evaluate(() => { window.confirm = () => true; });
    for (const scenario of [
      { body: '甲乙丙', start: 1, end: 2, html: '<p>单段</p>', expected: '甲\n\n单段\n\n丙' },
      { body: '甲乙丙', start: 1, end: 2, html: '<div>单块</div>', expected: '甲\n\n单块\n\n丙' },
      { body: '甲\n乙\n丙', start: 2, end: 3, html: '<p>第一段</p><p>第二段</p>', expected: '甲\n\n第一段\n\n第二段\n\n丙' },
      { body: '甲\n\n乙\n\n丙', start: 3, end: 4, html: '<table><tr><td>表格</td></tr></table>', expected: '甲\n\n<table><tbody><tr><td>表格</td></tr></tbody></table>\n\n丙' }
    ]) {
      await page.getByLabel('Markdown 正文').fill(scenario.body);
      await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
      await page.evaluate(({ start, end }) => document.querySelector('#document-body').setSelectionRange(start, end), scenario);
      assert.equal((await dispatchPaste(page, { html: scenario.html })).defaultPrevented, true);
      await page.waitForFunction(expected => document.querySelector('#document-body').value === expected, scenario.expected);
    }
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('富文本转换期间 selection 移开再恢复仍会丢弃旧响应', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-rich-paste-selection-aba-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    await page.getByLabel('Markdown 正文').fill('甲乙丙');
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
    await page.evaluate(() => { window.confirm = () => true; document.querySelector('#document-body').setSelectionRange(1, 2); });
    let release;
    let requestReached;
    const held = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { requestReached = resolve; });
    await page.route('**/api/typesetting/rich-text', async route => {
      requestReached();
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    });
    assert.equal((await dispatchPaste(page, { html: '<strong>旧结果</strong>' })).defaultPrevented, true);
    await reached;
    await page.evaluate(() => { window.selectionEvents = 0; document.querySelector('#document-body').addEventListener('select', () => { window.selectionEvents++; }, { once: true }); document.querySelector('#document-body').setSelectionRange(0, 0); });
    await page.waitForFunction(() => window.selectionEvents === 1);
    await page.evaluate(() => document.querySelector('#document-body').setSelectionRange(1, 2));
    release();
    await page.getByText('正文或选区已变化，请重新粘贴后重试。', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '甲乙丙');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('同一 JavaScript 任务内 selection 移开再恢复仍会丢弃旧富文本响应', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-rich-paste-sync-selection-aba-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    await page.getByLabel('Markdown 正文').fill('甲乙丙');
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
    await page.evaluate(() => { window.confirm = () => true; document.querySelector('#document-body').setSelectionRange(1, 2); });
    let release;
    let requestReached;
    const held = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { requestReached = resolve; });
    await page.route('**/api/typesetting/rich-text', async route => {
      requestReached();
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    });
    assert.equal((await dispatchPaste(page, { html: '<strong>旧结果</strong>' })).defaultPrevented, true);
    await reached;
    await page.evaluate(() => {
      const body = document.querySelector('#document-body');
      body.setSelectionRange(0, 0);
      body.setSelectionRange(1, 2);
    });
    release();
    await page.getByText('正文或选区已变化，请重新粘贴后重试。', { exact: true }).waitFor({ timeout: 1500 });
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '甲乙丙');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('富文本插入进入原生撤销栈，转义标签不触发外部资源请求', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-rich-paste-undo-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    const page = await browser.newPage();
    let resourceRequests = 0;
    await page.route('https://tracker.invalid/**', route => { resourceRequests++; return route.abort(); });
    await page.goto(server.base + '/typesetting');
    await page.waitForTimeout(250);
    await page.getByLabel('Markdown 正文').fill('甲乙丙');
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 1500 });
    await page.evaluate(() => { window.confirm = () => true; document.querySelector('#document-body').setSelectionRange(1, 2); });
    assert.equal((await dispatchPaste(page, { html: '<p>\\\\&lt;img src="https://tracker.invalid/pixel"&gt;</p>' })).defaultPrevented, true);
    await page.getByText('已转换富文本', { exact: false }).waitFor();
    assert.equal(await page.locator('#preview img').count(), 0);
    assert.equal(resourceRequests, 0);
    await page.getByLabel('Markdown 正文').focus();
    await page.keyboard.press(historyShortcut(process.platform));
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '甲乙丙');
    await page.keyboard.press(historyShortcut(process.platform, true));
    assert.match(await page.getByLabel('Markdown 正文').inputValue(), /tracker\.invalid/);
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
