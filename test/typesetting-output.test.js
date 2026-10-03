import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readJson = async relativePath => JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));

test('输出依赖和共享 Markdown fixture 固定版本与完整 artifact shape', async () => {
  const packageJson = await readJson('../package.json');
  const lock = await readJson('../package-lock.json');

  assert.equal(packageJson.dependencies.juice, '11.0.3');
  assert.equal(lock.packages['node_modules/juice'].version, '11.0.3');

  const fixtures = await readJson('./fixtures/typesetting-output-artifacts.json');
  assert.ok(Array.isArray(fixtures));
  assert.ok(fixtures.length > 0);

  for (const item of fixtures) {
    assert.deepEqual(Object.keys(item).sort(), ['artifact', 'document', 'name']);
    assert.equal(typeof item.name, 'string');
    assert.deepEqual(Object.keys(item.document).sort(), ['account', 'author', 'body', 'publishedAt', 'title']);
    assert.equal(Object.values(item.document).every(value => typeof value === 'string'), true);
    assert.deepEqual(Object.keys(item.artifact).sort(), ['content', 'filename', 'mimeType']);
    assert.equal(item.artifact.mimeType, 'text/markdown;charset=utf-8');
    assert.equal(typeof item.artifact.filename, 'string');
    assert.match(item.artifact.content, /^---\ntitle: /u);
    assert.equal(item.artifact.content.endsWith('\n'), true);
    assert.equal(item.artifact.content.endsWith('\n\n'), false);
  }

  const whitespace = fixtures.find(item => item.name === '正文空白逐字节保留');
  assert.ok(whitespace);
  assert.equal(whitespace.document.body, '  开头\r\n行尾  \r末行空白  \n\n');
  assert.equal(whitespace.artifact.content.split('---\n\n')[1], '  开头\n行尾  \n末行空白  \n');
});
