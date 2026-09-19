import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

async function serve(dataDir) {
  const server = createApp({ dataDir }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: async () => fetch(base + '/api/feeds'),
    post: (body, route = '/api/feeds', origin) => fetch(base + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body)
    }),
    close: () => new Promise(resolve => server.close(resolve))
  };
}

test('常用订阅源规范化去重、改名并跨服务重启保留，删除不影响导出记录', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-saved-feeds-'));
  let server = await serve(dir);
  try {
    const empty = await server.get();
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), []);
    const manifest = await readFile(path.join(dir, 'jobs.json'), 'utf8');
    const created = await server.post({ name: ' 技术阅读 ', url: ' http://localhost:8001/feed/all.xml#top ' });
    assert.equal(created.status, 200);
    const source = await created.json();
    assert.equal(source.name, '技术阅读');
    assert.equal(source.url, 'http://localhost:8001/feed/all.xml');
    assert.ok(source.id);
    const renamed = await (await server.post({ name: '我的技术订阅', url: 'http://localhost:8001/feed/all.xml' })).json();
    assert.equal(renamed.id, source.id);
    await server.close();
    server = await serve(dir);
    assert.deepEqual(await (await server.get()).json(), [renamed]);
    const deleted = await server.post({}, `/api/feeds/${source.id}/delete`);
    assert.equal(deleted.status, 200);
    await server.close();
    server = await serve(dir);
    assert.deepEqual(await (await server.get()).json(), []);
    assert.equal(await readFile(path.join(dir, 'jobs.json'), 'utf8'), manifest);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('保存订阅源拒绝无效名称、危险地址及跨站修改，失败不覆盖已保存数据', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-saved-validation-'));
  const server = await serve(dir);
  try {
    const good = { name: '离线源也能保存', url: 'http://127.0.0.1:1/feed' };
    assert.equal((await server.post(good)).status, 200);
    for (const invalid of [
      { ...good, name: '' }, { ...good, name: 'a'.repeat(101) },
      { ...good, url: 'file:///tmp/feed' }, { ...good, url: 'http://user:pass@localhost/feed' },
      { ...good, url: '不是网址' }, { ...good, url: 'https://example.com/' + 'a'.repeat(4096) }
    ]) assert.equal((await server.post(invalid)).status, 400);
    assert.equal((await server.post(good, '/api/feeds', 'https://example.com')).status, 403);
    const [saved] = await (await server.get()).json();
    assert.equal((await server.post({}, `/api/feeds/${saved.id}/delete`, 'https://example.com')).status, 403);
    assert.equal((await server.post({}, '/api/feeds/missing/delete')).status, 400);
    assert.deepEqual(await (await server.get()).json(), [saved]);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
