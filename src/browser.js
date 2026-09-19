import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { normalizeUrl } from './article.js';

export function browserOptions() {
  if (process.env.CHROME_PATH) return { executablePath: process.env.CHROME_PATH };
  if (existsSync(chromium.executablePath())) return {};
  if (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) return { channel: 'chrome' };
  return {};
}

export async function makePdf(html) {
  let browser;
  try { browser = await chromium.launch({ ...browserOptions(), headless: true }); }
  catch { throw new Error('PDF 需要 Chromium，请在工具目录运行 npm run setup:browser 后重试'); }
  try {
    const page = await browser.newPage({ javaScriptEnabled: false });
    await page.route('**/*', route => route.abort());
    await page.setContent(html, { waitUntil: 'load', timeout: 20000 });
    return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' }, timeout: 30000 });
  } finally { await browser.close(); }
}

export function createVerificationBrowser(dataDir) {
  let context;
  let launching;
  const pages = new Map();
  return {
    async open(url) {
      url = normalizeUrl(url);
      if (!context) {
        if (!launching) launching = (async () => {
          await mkdir(dataDir, { recursive: true });
          context = await chromium.launchPersistentContext(path.join(dataDir, 'browser-profile'), { ...browserOptions(), headless: false, viewport: { width: 1080, height: 800 } });
          context.on('close', () => { context = null; pages.clear(); });
          return context;
        })().finally(() => { launching = null; });
        await launching;
      }
      let page = pages.get(url);
      if (!page || page.isClosed()) {
        page = await context.newPage();
        pages.set(url, page);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
      await page.bringToFront();
    },
    async read(url) {
      const page = pages.get(url);
      if (!page || page.isClosed()) return null;
      try {
        if (normalizeUrl(page.url()) !== url) return null;
      } catch { return null; }
      return page.content();
    },
    async close() { if (context) await context.close(); }
  };
}
