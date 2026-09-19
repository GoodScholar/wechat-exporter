import express from 'express';
import JSZip from 'jszip';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JobStore } from './jobs.js';
import { exportArticle, fetchResource } from './exporter.js';
import { createVerificationBrowser } from './browser.js';
import { fetchFeed } from './feeds.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const safeName = name => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 80) || '文章';

function openWithSystem(directory) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  return new Promise((resolve, reject) => {
    const child = spawn(command, [directory], { shell: false, stdio: 'ignore' });
    child.once('error', () => reject(new Error('无法打开保存目录，请在文件管理器中手动打开')));
    child.once('spawn', () => resolve());
  });
}

export function createApp({ dataDir = path.join(root, '.data'), exporter, interval, openDirectory = openWithSystem } = {}) {
  const app = express();
  const verification = createVerificationBrowser(dataDir);
  const store = new JobStore(dataDir, exporter || ((url, formats, context) => exportArticle(url, formats, {
    ...context,
    getHtml: async (articleUrl, { signal } = {}) => await verification.read(articleUrl) || (await fetchResource(articleUrl, 'article', { signal })).bytes.toString('utf8')
  })), interval);
  app.locals.store = store;
  app.locals.verification = verification;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) return res.status(403).json({ error: '仅允许本机访问' });
    if (req.method !== 'GET' && (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` || !req.is('application/json'))) return res.status(403).json({ error: '请求来源或格式不正确' });
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    next();
  });
  app.use(express.json({ limit: '150kb' }));
  app.get('/api/settings', (req, res) => res.json({ outputDirectory: store.getOutputDirectory() }));
  app.post('/api/settings', (req, res) => res.json({ outputDirectory: store.setOutputDirectory(req.body.outputDirectory) }));
  app.post('/api/open-directory', async (req, res) => {
    const job = req.body.jobId ? store.findJob(req.body.jobId) : null;
    if (req.body.jobId && !job) throw new Error('找不到这个批次');
    await openDirectory(job?.outputDirectory || store.getOutputDirectory());
    res.json({ message: '已打开保存目录' });
  });
  app.get('/api/jobs', (req, res) => res.json(store.list()));
  app.post('/api/feeds/preview', async (req, res) => res.json(await fetchFeed(req.body.url)));
  app.post('/api/jobs', (req, res) => {
    const job = store.create(req.body.text, req.body.formats);
    res.status(201).json(store.publicJob(job));
  });
  app.post('/api/jobs/:id/retry', (req, res) => {
    const job = store.retry(req.params.id, req.body.itemId);
    res.json(store.publicJob(job));
  });
  app.post('/api/jobs/:id/cancel', (req, res) => {
    const job = store.cancel(req.params.id);
    res.json(store.publicJob(job));
  });
  app.post('/api/verify', async (req, res) => {
    await verification.open(req.body.url);
    res.json({ message: '已打开独立浏览器，请完成验证并保持文章页面打开，然后点击重试失败项' });
  });
  app.get('/api/items/:id/download', (req, res) => {
    const entry = store.findItem(req.params.id);
    if (!entry || !store.hasFile(entry.item, entry.job)) return res.status(404).json({ error: '文件尚未生成' });
    res.download(store.file(entry.item, entry.job), `${safeName(entry.item.title)}.zip`, { dotfiles: 'allow' });
  });
  app.get('/api/jobs/:id/download', (req, res, next) => {
    const job = store.list().find(job => job.id === req.params.id);
    const items = job?.items.filter(item => store.hasFile(item, job));
    if (!items?.length) return res.status(404).json({ error: '此批次还没有可下载文件' });
    const zip = new JSZip();
    for (const item of items) zip.file(`${safeName(item.title)}_${item.id.slice(0, 8)}.zip`, createReadStream(store.file(item, job)));
    res.attachment(`wechat-articles-${job.createdAt.slice(0, 10)}.zip`);
    const stream = zip.generateNodeStream({ streamFiles: true, compression: 'STORE' });
    stream.on('error', error => { if (res.headersSent) res.destroy(error); else next(error); });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
  app.use(express.static(path.join(root, 'public')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(400).json({ error: error.message || '操作失败，请重试' });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp();
  const port = Number(process.env.PORT || 4318);
  const server = app.listen(port, '127.0.0.1', () => console.log(`公众号文章导出：http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(`无法启动：${error.message}`); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    await app.locals.verification.close();
    server.close();
    process.exit(0);
  });
}
