import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';
import { browserOptions } from '../src/browser.js';
import { TypesettingStore } from '../src/typesetting.js';

const articleUrl = 'https://mp.weixin.qq.com/s?__biz=abc&mid=1&idx=2&sn=xyz';
const articleHtml = `<!doctype html><html><body>
  <h1 id="activity-name">可导入文章</h1><a id="js_name">测试公众号</a>
  <span id="js_author_name">测试作者</span><span id="publish_time">2026年9月19日 10:00</span>
  <div id="js_content"><h2>第一节</h2><p>正文<strong>重点</strong>与<a href="https://example.com">链接</a>。</p><img data-src="https://fixture.invalid/example.png" alt="配图"><blockquote>引用</blockquote><ul><li>条目</li></ul><table><tr><th>列</th></tr><tr><td>值</td></tr></table><pre><code>const x = 1;</code></pre></div>
</body></html>`;

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function post(base, route, body) {
  return fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function seed(base, body = '原有正文') {
  const response = await post(base, '/api/typesetting/document', { title: '原有标题', author: '原作者', account: '原公众号', publishedAt: '2026-09-01', body, revision: 1 });
  assert.equal(response.status, 200);
}

async function fixturePage(browser) {
  const page = await browser.newPage();
  await page.route('https://fixture.invalid/**', route => route.fulfill({ status: 204 }));
  return page;
}

test('导入 API 将普通文章一次性保存为独立元信息和语义 Markdown，重启不会重新抓取', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-'));
  const dataDir = path.join(root, '.data');
  let fetches = 0;
  let server = await serve(createApp({ dataDir, interval: 0, fetchArticle: async url => { fetches++; assert.equal(url, articleUrl); return articleHtml; } }));
  try {
    const response = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 0, confirmed: false, fetchArticle: null, typesetting: null });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(Object.fromEntries(['title', 'author', 'account', 'publishedAt'].map(field => [field, result.document[field]])), {
      title: '可导入文章', author: '测试作者', account: '测试公众号', publishedAt: '2026-09-19'
    });
    assert.match(result.document.body, /## 第一节/);
    assert.match(result.document.body, /\*\*重点\*\*/);
    assert.match(result.document.body, /\[链接\]\(https:\/\/example.com\)/);
    assert.match(result.document.body, /https:\/\/fixture.invalid\/example.png/);
    assert.doesNotMatch(result.document.body, /^# 可导入文章/m);
    assert.equal(fetches, 1);
    await server.close();
    server = await serve(createApp({ dataDir, interval: 0, fetchArticle: async () => { throw new Error('重启读取文稿不应抓取来源'); } }));
    const restored = await (await fetch(server.base + '/api/typesetting/document')).json();
    assert.equal(restored.document.body, result.document.body);
    assert.equal(fetches, 1);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('文章导入替换内容但保留当前主题和全部非当前主题设置', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-theme-'));
  const dataDir = path.join(root, '.data');
  const themeSettings = {
    default: { primaryColor: '#0F4C81', fontSize: '14px', lineHeight: '1.5', blockSpacing: '0.75' },
    grace: { primaryColor: '#009874', fontSize: '15px', lineHeight: '1.65', blockSpacing: '0.9' },
    simple: { primaryColor: '#FA5151', fontSize: '18px', lineHeight: '2.05', blockSpacing: '1.35' }
  };
  const expectedPresentation = JSON.stringify({ theme: 'grace', themeSettings });
  let mode = 'success';
  const fetchArticle = async () => {
    if (mode === 'network') throw new Error('socket closed');
    return articleHtml;
  };
  let server = await serve(createApp({ dataDir, interval: 0, fetchArticle }));
  const assertPresentation = async () => {
    const document = (await (await fetch(server.base + '/api/typesetting/document')).json()).document;
    assert.equal(JSON.stringify({ theme: document.theme, themeSettings: document.themeSettings }), expectedPresentation);
  };
  try {
    const saved = await post(server.base, '/api/typesetting/document', {
      title: '原有标题', author: '原作者', account: '原公众号', publishedAt: '2026-09-01', body: '原有正文',
      theme: 'grace', themeSettings, revision: 1
    });
    assert.equal(saved.status, 200);

    const imported = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 1, confirmed: true });
    assert.equal(imported.status, 200);
    const document = (await imported.json()).document;
    assert.deepEqual(Object.fromEntries(['title', 'author', 'account', 'publishedAt'].map(field => [field, document[field]])), {
      title: '可导入文章', author: '测试作者', account: '测试公众号', publishedAt: '2026-09-19'
    });
    assert.match(document.body, /## 第一节/);
    assert.equal(JSON.stringify({ theme: document.theme, themeSettings: document.themeSettings }), expectedPresentation);

    await server.close();
    server = await serve(createApp({ dataDir, interval: 0, fetchArticle }));
    await assertPresentation();

    const unconfirmed = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 2, confirmed: false });
    assert.equal(unconfirmed.status, 409);
    await assertPresentation();

    mode = 'network';
    const failed = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 2, confirmed: true });
    assert.equal(failed.status, 502);
    await assertPresentation();

    const conflict = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 1, confirmed: true });
    assert.equal(conflict.status, 409);
    await assertPresentation();
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('文章导入成功失败冲突和原子恢复均保留外链脚注开关', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-footnotes-'));
  const dataDir = path.join(root, '.data');
  const store = new TypesettingStore(dataDir);
  let mode = 'success';
  const fetchArticle = async () => {
    if (mode === 'network') throw new Error('socket closed');
    return articleHtml;
  };
  let server;
  const assertFootnotesEnabled = async () => {
    const visible = (await (await fetch(server.base + '/api/typesetting/document')).json()).document;
    assert.equal(visible.convertExternalLinksToFootnotes, true);
    assert.equal((await new TypesettingStore(dataDir).load()).convertExternalLinksToFootnotes, true);
    return visible;
  };
  try {
    const current = await store.save({
      title: '原有标题', author: '原作者', account: '原公众号', publishedAt: '2026-09-01', body: '原有正文',
      convertExternalLinksToFootnotes: true, revision: 1
    });
    server = await serve(createApp({ dataDir, interval: 0, typesettingStore: store, fetchArticle }));

    const imported = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 1, confirmed: true });
    assert.equal(imported.status, 200);
    const document = (await imported.json()).document;
    assert.deepEqual(Object.fromEntries(['title', 'author', 'account', 'publishedAt'].map(field => [field, document[field]])), {
      title: '可导入文章', author: '测试作者', account: '测试公众号', publishedAt: '2026-09-19'
    });
    assert.match(document.body, /## 第一节/);
    assert.equal(document.theme, current.theme);
    assert.deepEqual(document.themeSettings, current.themeSettings);
    assert.equal(document.convertExternalLinksToFootnotes, true);
    assert.equal((await assertFootnotesEnabled()).revision, 2);

    const unconfirmed = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 2, confirmed: false });
    assert.equal(unconfirmed.status, 409);
    assert.equal((await unconfirmed.json()).error.code, 'CONFIRM_REQUIRED');
    await assertFootnotesEnabled();

    mode = 'network';
    const failed = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 2, confirmed: true });
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).error.code, 'NETWORK_READ');
    await assertFootnotesEnabled();

    const conflict = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 1, confirmed: true });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, 'REVISION_CONFLICT');
    await assertFootnotesEnabled();
  } finally {
    if (server) await server.close();
    await rm(root, { recursive: true, force: true });
  }

  for (const phase of ['current-version', 'recovery-version', 'manifest']) {
    const phaseRoot = await mkdtemp(path.join(os.tmpdir(), `wechat-typesetting-import-footnotes-${phase}-`));
    const phaseDataDir = path.join(phaseRoot, '.data');
    let failingPhase = '';
    let candidateWrites = 0;
    const writeAtomically = async (file, text) => {
      if (failingPhase && file.includes('typesetting-versions')) {
        candidateWrites++;
        if ((phase === 'current-version' && candidateWrites === 1) || (phase === 'recovery-version' && candidateWrites === 2)) throw new Error('disk denied');
      }
      if (failingPhase === 'manifest' && file.endsWith('typesetting-document.manifest.json')) throw new Error('disk denied');
      const temporary = `${file}.test`;
      await writeFile(temporary, text, 'utf8');
      await rename(temporary, file);
    };
    const phaseStore = new TypesettingStore(phaseDataDir, { writeAtomically });
    let phaseServer;
    try {
      await phaseStore.save({
        title: '旧标题', author: '', account: '', publishedAt: '', body: '旧正文',
        convertExternalLinksToFootnotes: true, revision: 1
      });
      failingPhase = phase;
      candidateWrites = 0;
      phaseServer = await serve(createApp({ dataDir: phaseDataDir, interval: 0, typesettingStore: phaseStore, fetchArticle: async () => articleHtml }));
      const response = await post(phaseServer.base, '/api/typesetting/import', { url: articleUrl, revision: 1, confirmed: true });
      assert.equal(response.status, 500, phase);
      assert.equal((await response.json()).error.code, 'PERSISTENCE_FAILED', phase);
      const visible = (await (await fetch(phaseServer.base + '/api/typesetting/document')).json()).document;
      assert.equal(visible.body, '旧正文', phase);
      assert.equal(visible.convertExternalLinksToFootnotes, true, phase);
      const recovered = await new TypesettingStore(phaseDataDir).load();
      assert.equal(recovered.body, '旧正文', phase);
      assert.equal(recovered.convertExternalLinksToFootnotes, true, phase);
    } finally {
      if (phaseServer) await phaseServer.close();
      await rm(phaseRoot, { recursive: true, force: true });
    }
  }
});

test('任一版本候选或 manifest 提交失败时，旧文稿在内存和重启后仍是唯一可见状态', async () => {
  for (const phase of ['current-version', 'recovery-version', 'manifest']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-persistence-'));
    const dataDir = path.join(root, '.data');
    let failingPhase = '';
    let candidateWrites = 0;
    const writeAtomically = async (file, text) => {
      if (failingPhase && file.includes('typesetting-versions')) {
        candidateWrites++;
        if (phase === 'current-version' && candidateWrites === 1 || phase === 'recovery-version' && candidateWrites === 2) throw new Error('disk denied');
      }
      if (failingPhase === phase && phase === 'manifest' && file.endsWith('typesetting-document.manifest.json')) throw new Error('disk denied');
      const temporary = `${file}.test`;
      await writeFile(temporary, text, 'utf8');
      await rename(temporary, file);
    };
    const store = new TypesettingStore(dataDir, { writeAtomically });
    try {
      await store.save({ title: '旧标题', author: '', account: '', publishedAt: '', body: '旧正文', revision: 1 });
      const manifest = await readFile(store.manifest, 'utf8');
      failingPhase = phase;
      candidateWrites = 0;
      const server = await serve(createApp({ dataDir, interval: 0, typesettingStore: store, fetchArticle: async () => articleHtml }));
      try {
        const response = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 1, confirmed: true });
        assert.equal(response.status, 500, phase);
        assert.equal((await response.json()).error.code, 'PERSISTENCE_FAILED');
        assert.equal(await readFile(store.manifest, 'utf8'), manifest);
        assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, '旧正文');
        assert.equal((await new TypesettingStore(dataDir).load()).body, '旧正文');
      } finally { await server.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('迁移旧主/备份文稿后，任一候选写入失败不会暴露候选导入', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-migration-'));
  const dataDir = path.join(root, '.data');
  let rejectCandidate = false;
  let candidateWrites = 0;
  const writeAtomically = async (file, text) => {
    if (rejectCandidate && file.includes('typesetting-versions') && ++candidateWrites === 2) throw new Error('recovery denied');
    const temporary = `${file}.test`;
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, file);
  };
  const store = new TypesettingStore(dataDir, { writeAtomically });
  try {
    const legacy = JSON.stringify({ title: '旧标题', author: '', account: '', publishedAt: '', body: '旧正文', revision: 1, savedAt: '' });
    await mkdir(dataDir, { recursive: true });
    await writeFile(store.file, legacy, 'utf8');
    await writeFile(store.backup, legacy, 'utf8');
    assert.equal((await store.load()).body, '旧正文');
    rejectCandidate = true;
    const server = await serve(createApp({ dataDir, interval: 0, typesettingStore: store, fetchArticle: async () => articleHtml }));
    try {
      const response = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 1, confirmed: true });
      assert.equal(response.status, 500);
      assert.equal((await response.json()).error.code, 'PERSISTENCE_FAILED');
      assert.equal(await readFile(store.file, 'utf8'), legacy);
      assert.equal(await readFile(store.backup, 'utf8'), legacy);
      assert.equal((await new TypesettingStore(dataDir).load()).body, '旧正文');
    } finally { await server.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('旧固定文稿迁移为 manifest 后，新进程从版本文稿继续读取', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-migration-success-'));
  const dataDir = path.join(root, '.data');
  const store = new TypesettingStore(dataDir);
  const legacy = JSON.stringify({ title: '旧标题', author: '', account: '', publishedAt: '', body: '旧正文', revision: 1, savedAt: '' });
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(store.file, legacy, 'utf8');
    await writeFile(store.backup, legacy, 'utf8');
    assert.equal((await store.load()).body, '旧正文');
    await store.save({ title: '新标题', author: '', account: '', publishedAt: '', body: '新正文', revision: 2 });
    assert.ok(JSON.parse(await readFile(store.manifest, 'utf8')).current);
    assert.equal(await readFile(store.file, 'utf8'), legacy);
    assert.equal(await readFile(store.backup, 'utf8'), legacy);
    assert.equal((await new TypesettingStore(dataDir).load()).body, '新正文');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('提交后清理旧版本失败不破坏已提交文稿', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-cleanup-'));
  const dataDir = path.join(root, '.data');
  let failCleanup = false;
  const store = new TypesettingStore(dataDir, { removeFile: async file => { if (failCleanup) throw new Error('cleanup denied'); await rm(file); } });
  try {
    await store.save({ title: '第一版', author: '', account: '', publishedAt: '', body: '正文一', revision: 1 });
    await store.save({ title: '第二版', author: '', account: '', publishedAt: '', body: '正文二', revision: 2 });
    failCleanup = true;
    await store.save({ title: '第三版', author: '', account: '', publishedAt: '', body: '正文三', revision: 3 });
    assert.equal((await new TypesettingStore(dataDir).load()).body, '正文三');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('导入 API 拒绝未确认替换，并对所有分类失败保留持久化文稿', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-errors-'));
  const dataDir = path.join(root, '.data');
  let mode = 'success';
  let fetches = 0;
  const fixtures = {
    verification: '<html><body>环境异常，请完成验证<script>var item_show_type=8</script></body></html>',
    unavailable: '<html><body>该内容已被发布者删除<script>var item_show_type=8</script></body></html>',
    empty: '<html><body><div id="js_content"></div></body></html>',
    image: '<html><body><script>var item_show_type = 8;</script><div id="js_content"><img src="https://fixture.invalid/picture.png"></div></body></html>',
    unsupported: '<html><body><script>var item_show_type = 12;</script></body></html>',
    sanitizedEmpty: '<html><body><div id="js_content"><script>var hidden = "data";</script><style>.x{display:none}</style></div></body></html>'
  };
  const server = await serve(createApp({ dataDir, interval: 0, fetchArticle: async () => {
    fetches++;
    if (mode === 'network') throw new Error('socket closed');
    return fixtures[mode] || articleHtml;
  } }));
  try {
    await seed(server.base);
    const manifest = path.join(dataDir, 'typesetting-document.manifest.json');
    const original = await readFile(manifest, 'utf8');
    const unconfirmed = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 1, confirmed: false });
    assert.equal(unconfirmed.status, 409);
    assert.deepEqual((await unconfirmed.json()).error, { code: 'CONFIRM_REQUIRED', message: '当前文稿已有内容，请确认替换后再导入。', action: '确认替换当前文稿后重试。' });
    assert.equal(fetches, 0);
    assert.equal(await readFile(manifest, 'utf8'), original);

    const cases = [
      ['invalid', 'https://example.com/a', 'INVALID_LINK', 400],
      ['verification', articleUrl, 'ACCESS_VERIFICATION', 403],
      ['unavailable', articleUrl, 'ARTICLE_UNAVAILABLE', 410],
      ['empty', articleUrl, 'EMPTY_BODY', 422],
      ['sanitizedEmpty', articleUrl, 'EMPTY_BODY', 422],
      ['image', articleUrl, 'IMAGE_MESSAGE', 422],
      ['unsupported', articleUrl, 'UNSUPPORTED_MESSAGE', 422],
      ['network', articleUrl, 'NETWORK_READ', 502],
    ];
    for (const [nextMode, url, code, status] of cases) {
      mode = nextMode;
      const response = await post(server.base, '/api/typesetting/import', { url, revision: 1, confirmed: true });
      assert.equal(response.status, status, code);
      const result = await response.json();
      assert.equal(result.error.code, code);
      assert.match(result.error.message, /[\u4e00-\u9fff]/);
      assert.match(result.error.action, /[\u4e00-\u9fff]/);
      assert.equal(await readFile(manifest, 'utf8'), original, `${code} 不能修改文稿文件`);
      assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, '原有正文');
    }
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('导入保存异常返回稳定 typed error 而非通用 400', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-save-error-'));
  const typesettingStore = { load: async () => ({ title: '', author: '', account: '', publishedAt: '', body: '', revision: 0, savedAt: '' }), save: async () => { throw new Error('disk denied'); } };
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0, typesettingStore, fetchArticle: async () => articleHtml }));
  try {
    const response = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 0, confirmed: false });
    assert.equal(response.status, 500);
    assert.deepEqual((await response.json()).error, { code: 'PERSISTENCE_FAILED', message: '无法保存导入文稿，请检查本机数据目录。', action: '检查数据目录权限后重试。' });
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('未知解析异常回退为完整的不支持类型错误', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-unknown-'));
  const dataDir = path.join(root, '.data');
  const server = await serve(createApp({ dataDir, interval: 0, fetchArticle: async () => Symbol('not-html') }));
  try {
    const response = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 0, confirmed: false });
    assert.equal(response.status, 422);
    assert.deepEqual((await response.json()).error, { code: 'UNSUPPORTED_MESSAGE', message: '该消息类型暂不支持导入编辑。', action: '请返回文章导出功能查看原文。' });
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('发布日期仅保存真实日历日期', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-date-'));
  const dataDir = path.join(root, '.data');
  const server = await serve(createApp({ dataDir, interval: 0, fetchArticle: async () => articleHtml.replace('2026年9月19日 10:00', '2026年13月45日') }));
  try {
    const response = await post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 0, confirmed: false });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).document.publishedAt, '');
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('抓取期间的修订冲突返回稳定错误且不覆盖较新文稿', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-conflict-'));
  const dataDir = path.join(root, '.data');
  let release;
  const fetched = new Promise(resolve => { release = resolve; });
  const server = await serve(createApp({ dataDir, interval: 0, fetchArticle: async () => { await fetched; return articleHtml; } }));
  try {
    const importing = post(server.base, '/api/typesetting/import', { url: articleUrl, revision: 0, confirmed: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    await post(server.base, '/api/typesetting/document', { title: '更新者', author: '', account: '', publishedAt: '', body: '较新正文', revision: 1 });
    release();
    const response = await importing;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'REVISION_CONFLICT');
    const current = (await (await fetch(server.base + '/api/typesetting/document')).json()).document;
    assert.equal(current.body, '较新正文');
    assert.equal(current.title, '更新者');
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('工作台取消替换不请求导入，成功导入更新字段和预览，图片消息提供文章导出入口', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-ui-'));
  const dataDir = path.join(root, '.data');
  let mode = 'success';
  let fetches = 0;
  const server = await serve(createApp({ dataDir, interval: 0, fetchArticle: async () => {
    fetches++;
    return mode === 'image' ? '<script>var item_show_type=8;</script><div id="js_content"><img src="https://fixture.invalid/picture.png"></div>' : articleHtml;
  } }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    await seed(server.base);
    const page = await fixturePage(browser);
    await page.goto(server.base + '/typesetting');
    await page.getByLabel('导入公众号文章链接').fill(articleUrl);
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: '导入文章' }).click();
    await page.waitForTimeout(80);
    assert.equal(fetches, 0);
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '原有正文');
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, '原有正文');

    await page.getByLabel('Markdown 正文').fill('');
    await page.getByLabel('标题').fill('');
    await page.getByLabel('作者').fill('');
    await page.getByLabel('公众号名称').fill('');
    await page.getByLabel('发布日期').fill('');
    await page.waitForTimeout(600);
    await page.getByLabel('导入公众号文章链接').fill(articleUrl);
    await page.getByRole('button', { name: '导入文章' }).click();
    await page.getByLabel('标题').waitFor({ state: 'visible' });
    await page.getByLabel('标题').evaluate(input => new Promise(resolve => {
      const timer = setInterval(() => { if (input.value === '可导入文章') { clearInterval(timer); resolve(); } }, 10);
    }));
    await page.getByRole('heading', { name: '第一节' }).waitFor();
    assert.equal(await page.getByLabel('发布日期').inputValue(), '2026-09-19');

    mode = 'image';
    const previousTitle = await page.getByLabel('标题').inputValue();
    const previousBody = await page.getByLabel('Markdown 正文').inputValue();
    await page.getByLabel('导入公众号文章链接').fill(articleUrl);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '导入文章' }).click();
    const exportLink = page.getByRole('link', { name: '返回文章导出' });
    await exportLink.waitFor();
    assert.equal(await exportLink.getAttribute('href'), '/');
    assert.equal(await page.getByLabel('标题').inputValue(), previousTitle);
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), previousBody);
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, previousBody);
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('工作台在慢导入前先保存待处理编辑，并在抓取期间锁定字段避免覆盖新输入', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-ui-race-'));
  const dataDir = path.join(root, '.data');
  let release;
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  const server = await serve(createApp({ dataDir, interval: 0, fetchArticle: async () => { started(); await delayed; return articleHtml; } }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    await seed(server.base);
    const page = await fixturePage(browser);
    await page.goto(server.base + '/typesetting');
    await page.getByLabel('Markdown 正文').fill('待保存编辑');
    await page.getByLabel('导入公众号文章链接').fill(articleUrl);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '导入文章' }).click();
    await reading;
    assert.equal(await page.getByLabel('Markdown 正文').isDisabled(), true);
    assert.equal(await page.getByLabel('标题').isDisabled(), true);
    release();
    await page.getByLabel('标题').evaluate(input => new Promise(resolve => {
      const timer = setInterval(() => { if (input.value === '可导入文章') { clearInterval(timer); resolve(); } }, 10);
    }));
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.title, '可导入文章');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('工作台导入会排空级联自动保存，避免使用旧修订号自发冲突', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-save-queue-'));
  const dataDir = path.join(root, '.data');
  const server = await serve(createApp({ dataDir, interval: 0, fetchArticle: async () => articleHtml }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    await seed(server.base);
    const page = await fixturePage(browser);
    let releaseFirst;
    let firstStarted;
    const firstSave = new Promise(resolve => { firstStarted = resolve; });
    let saves = 0;
    await page.route('**/api/typesetting/document', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      if (saves++ === 0) { firstStarted(); await new Promise(resolve => { releaseFirst = resolve; }); }
      await route.continue();
    });
    await page.goto(server.base + '/typesetting');
    await page.getByLabel('Markdown 正文').fill('第一版');
    await firstSave;
    await page.getByLabel('Markdown 正文').fill('第二版');
    await page.getByLabel('导入公众号文章链接').fill(articleUrl);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '导入文章' }).click();
    releaseFirst();
    await page.getByLabel('标题').evaluate(input => new Promise(resolve => {
      const timer = setInterval(() => { if (input.value === '可导入文章') { clearInterval(timer); resolve(); } }, 10);
    }));
    assert.ok(saves >= 2);
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.title, '可导入文章');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('导入前保存失败只尝试一次，恢复编辑控件并保留文稿', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-save-failure-ui-'));
  const dataDir = path.join(root, '.data');
  let importRequests = 0;
  const server = await serve(createApp({ dataDir, interval: 0, fetchArticle: async () => { importRequests++; return articleHtml; } }));
  const browser = await chromium.launch({ ...browserOptions(), headless: true });
  try {
    await seed(server.base);
    const page = await fixturePage(browser);
    let saves = 0;
    await page.route('**/api/typesetting/document', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      saves++;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '磁盘不可写' }) });
    });
    await page.goto(server.base + '/typesetting');
    await page.getByLabel('Markdown 正文').fill('无法保存的新正文');
    await page.getByLabel('导入公众号文章链接').fill(articleUrl);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '导入文章' }).click();
    await page.getByText('当前编辑未能保存', { exact: false }).waitFor();
    await page.waitForTimeout(120);
    assert.equal(saves, 1);
    assert.equal(importRequests, 0);
    assert.equal(await page.getByLabel('Markdown 正文').isDisabled(), false);
    assert.equal(await page.getByRole('button', { name: '导入文章' }).isDisabled(), false);
    assert.equal(await page.getByLabel('Markdown 正文').inputValue(), '无法保存的新正文');
    assert.equal((await (await fetch(server.base + '/api/typesetting/document')).json()).document.body, '原有正文');
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('仅排版页 CSP 允许 self 与 HTTPS 图片并拒绝 http data blob', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-typesetting-import-csp-'));
  const server = await serve(createApp({ dataDir: path.join(root, '.data'), interval: 0 }));
  try {
    const exportResponse = await fetch(server.base + '/');
    const typesettingResponse = await fetch(server.base + '/typesetting');
    const aliasResponse = await fetch(server.base + '/typesetting.html', { redirect: 'manual' });
    const imageSources = response => response.headers.get('content-security-policy').split(';')
      .map(directive => directive.trim().split(/\s+/)).find(([name]) => name === 'img-src').slice(1);
    assert.deepEqual(imageSources(exportResponse), ["'self'", 'data:']);
    assert.deepEqual(imageSources(typesettingResponse), ["'self'", 'https:']);
    assert.equal(typesettingResponse.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(aliasResponse.status, 308);
    assert.equal(aliasResponse.headers.get('location'), '/typesetting');
    assert.deepEqual(imageSources(aliasResponse), ["'self'", 'https:']);
    assert.equal(aliasResponse.headers.get('referrer-policy'), 'no-referrer');
    for (const aliasPath of [
      '/typesetting%2ehtml', '/typesetting%2Ehtml', '/%74ypesetting.html',
      '/%54ypesetting.html', '/TYPESETTING%2eHTML', '/%74YPESETTING.HTML'
    ]) {
      const encodedAliasResponse = await fetch(server.base + aliasPath, { redirect: 'manual' });
      assert.ok([200, 308, 404].includes(encodedAliasResponse.status), aliasPath);
      if (encodedAliasResponse.status === 404) {
        assert.doesNotMatch(await encodedAliasResponse.text(), /公众号排版/, aliasPath);
        continue;
      }
      if (encodedAliasResponse.status === 308) assert.equal(encodedAliasResponse.headers.get('location'), '/typesetting', aliasPath);
      assert.deepEqual(imageSources(encodedAliasResponse), ["'self'", 'https:'], aliasPath);
      assert.equal(encodedAliasResponse.headers.get('referrer-policy'), 'no-referrer', aliasPath);
    }
    assert.doesNotMatch(await typesettingResponse.text(), /<link rel="icon" href="data:/);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
