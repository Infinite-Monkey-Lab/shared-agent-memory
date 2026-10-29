import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connect, graph } from './client.mjs';

test('export preserves UTF-8 observations and relationships; corrupt input leaves the last good export intact', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'shared-memory-export-'));
  const memory = path.join(dir, 'memory.jsonl');
  const output = path.join(dir, 'exports', 'memory.md');
  await writeFile(memory, [
    { type: 'entity', name: 'user:example', entityType: 'user-preference', observations: ['用示例工具查看文档。', '第二行\n后续内容'] },
    { type: 'entity', name: 'project:alpha', entityType: 'project', observations: [] },
    { type: 'relation', from: 'user:example', to: 'project:alpha', relationType: 'works_on' },
  ].map(JSON.stringify).join('\n') + '\n');
  const { exportMemory } = await import('../export.mjs');
  await exportMemory(memory, output);
  const markdown = await readFile(output, 'utf8');
  assert.match(markdown, /用示例工具查看文档。/);
  assert.match(markdown, /第二行\n  后续内容/);
  assert.match(markdown, /user:example.*works\\?_on.*project:alpha/);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await writeFile(memory, '{broken JSON\n');
  await assert.rejects(exportMemory(memory, output));
  assert.equal(await readFile(output, 'utf8'), markdown);
});

test('three live MCP processes see each other’s writes without loss and refresh the ExampleApp export', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'shared-memory-mcp-'));
  const memory = path.join(dir, 'memory.jsonl');
  const clients = [];
  t.after(async () => { await Promise.all(clients.map(client => client.close())); });
  for (let i = 0; i < 3; i++) clients.push(await connect(memory));
  const tools = await clients[0].request('tools/list');
  assert.ok(tools.tools.some(tool => tool.name === 'search_nodes'));
  await clients[0].call('create_entities', { entities: [{ name: 'user:example', entityType: 'user-preference', observations: ['使用 ExampleApp。'] }] });
  assert.equal(graph(await clients[1].call('search_nodes', { query: 'ExampleApp' })).entities[0].name, 'user:example');
  await Promise.all(Array.from({ length: 24 }, (_, i) => clients[i % 3].call('create_entities', {
    entities: [{ name: `project:item-${i}`, entityType: 'test', observations: [`并发记录 ${i}`] }],
  })));
  const result = graph(await clients[2].call('search_nodes', { query: 'project:item-' }));
  assert.equal(result.entities.length, 24);
  assert.equal(new Set(result.entities.map(entity => entity.name)).size, 24);
  let markdown = '';
  for (let i = 0; i < 60; i++) {
    markdown = await readFile(path.join(dir, 'exports', 'memory.md'), 'utf8').catch(() => '');
    if (markdown.includes('project:item-23') && (markdown.match(/^## project:item-/gm) ?? []).length === 24) break;
    await delay(100);
  }
  assert.match(markdown, /使用 ExampleApp。/);
  assert.equal((markdown.match(/^## project:item-/gm) ?? []).length, 24);
  assert.equal((await stat(`${memory}.sqlite3`)).mode & 0o777, 0o600);
});

test('test clients never overwrite an export path inherited from the caller environment', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'shared-memory-isolation-'));
  const outsideExport = path.join(dir, 'outside.md');
  const memory = path.join(dir, 'test-store', 'memory.jsonl');
  await writeFile(outsideExport, 'keep this existing export');
  const previous = process.env.MEMORY_EXPORT_PATH;
  let client;
  try {
    process.env.MEMORY_EXPORT_PATH = outsideExport;
    client = await connect(memory);
  } finally {
    if (previous === undefined) delete process.env.MEMORY_EXPORT_PATH;
    else process.env.MEMORY_EXPORT_PATH = previous;
  }
  try {
    await client.call('create_entities', { entities: [{ name: 'test:isolated', entityType: 'test', observations: ['isolated data'] }] });
  } finally {
    await client.close();
  }
  assert.equal(await readFile(outsideExport, 'utf8'), 'keep this existing export');
  assert.match(await readFile(path.join(dir, 'test-store', 'exports', 'memory.md'), 'utf8'), /isolated data/);
});
