import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/jobs.js';

async function settled(store) {
  for (let i = 0; i < 100; i++) {
    if (store.list().every(job => job.items.every(item => ['success', 'error'].includes(item.status)))) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('队列没有完成');
}

test('批量部分失败不阻塞后续文章，重试恢复，重启保留下载且重复文章复用', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-export-'));
  let fail = true;
  try {
    const store = new JobStore(dir, async url => {
      if (url.endsWith('/fail') && fail) throw new Error('微信要求验证');
      return { title: '文章', warnings: [], archive: Buffer.from('exported') };
    }, 0);
    const job = store.create('https://mp.weixin.qq.com/s/fail\nhttps://mp.weixin.qq.com/s/ok', ['html']);
    await settled(store);
    assert.deepEqual(job.items.map(x => x.status), ['error', 'success']);
    assert.equal((await readFile(store.file(job.items[1]))).toString(), 'exported');
    fail = false;
    store.retry(job.id);
    await settled(store);
    assert.deepEqual(job.items.map(x => x.status), ['success', 'success']);
    const restored = new JobStore(dir, async () => { throw new Error('不应再次下载'); }, 0);
    assert.equal(restored.list()[0].items[0].status, 'success');
    const duplicate = restored.create('https://mp.weixin.qq.com/s/ok', ['html']);
    await settled(restored);
    assert.equal(duplicate.items[0].status, 'success');
    assert.equal(duplicate.items[0].cached, true);
    assert.throws(() => restored.create('https://example.com', ['html']));
    assert.throws(() => restored.create('https://mp.weixin.qq.com/s/ok', ['unknown']));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
