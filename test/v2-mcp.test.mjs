import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connect, graph } from './client.mjs';

async function fixture(t, seed) {
  const dir = await mkdtemp(path.join(tmpdir(), 'memory-v2-mcp-'));
  const memory = path.join(dir, 'memory.jsonl');
  if (seed) await writeFile(memory, seed);
  const clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.close())); });
  async function client(protocol = '2025-11-25') {
    const c = await connect(memory, protocol, { entry: '../v2/start.mjs' });
    clients.push(c);
    return c;
  }
  return { dir, memory, client };
}

test('MCP native writes are annotated as mutations and interoperable with old tools in three processes', async t => {
  const f = await fixture(t);
  const a = await f.client('2024-11-05'), b = await f.client(), c = await f.client();
  const tools = (await a.request('tools/list')).tools;
  assert.equal(tools.find(t => t.name === 'remember_memory').annotations.readOnlyHint, false);
  assert.equal(tools.find(t => t.name === 'search_memories').annotations.readOnlyHint, true);
  const old = graph(await a.call('remember_memory', { entity_name: 'user:example', content: '默认 npm', attribution: 'user-stated', source_agent: 'test' }));
  assert.equal(graph(await b.call('search_nodes', { query: 'npm' })).entities.length, 1);
  const races = await Promise.allSettled([b, c].map((client, i) => client.call('correct_memory', { id: old.id, expected_revision: 1, content: `新工具 ${i}` })));
  assert.equal(races.filter(x => x.status === 'fulfilled').length, 1);
  assert.match(races.find(x => x.status === 'rejected').reason.message, /revision_conflict/);
  await Promise.all(Array.from({ length: 24 }, (_, i) => [a, b, c][i % 3].call('remember_memory', { entity_name: 'user:concurrency', content: `并发记录 ${i}` })));
  const h = graph(await a.call('memory_history', { id: old.id }));
  assert.equal(h.items.length, 2);
  const g = graph(await c.call('read_graph', {}));
  assert.equal(g.entities.find(e => e.name === 'user:concurrency').observations.length, 24);
  const md = await readFile(path.join(f.dir, 'exports/memory.md'), 'utf8');
  assert.match(md, /历史/);
  assert.match(md, /并发记录 23/);
  assert.equal((await stat(path.join(f.dir, 'memory.jsonl.sqlite3'))).mode & 0o777, 0o600);
});

test('legacy import keeps the original intact, accepts late writes and does not hide failure as empty', async t => {
  const seed = JSON.stringify({ type: 'entity', name: 'user:example', entityType: 'user-preference', observations: ['使用 ExampleApp 查看 Markdown'] }) + '\n';
  const f = await fixture(t, seed);
  const c = await f.client();
  assert.equal(await readFile(f.memory, 'utf8'), seed);
  const first = graph(await c.call('search_memories', { query: '我用什么看 Markdown？' })).items[0];
  assert.equal(first.source_agent, 'legacy-import');
  assert.equal(first.occurred_at, null);
  await writeFile(f.memory, seed + JSON.stringify({ type: 'entity', name: 'user:late', entityType: 'fact', observations: ['迟到的数据'] }) + '\n');
  assert.equal(graph(await c.call('search_memories', { query: '迟到' })).items.length, 1);
  await c.call('correct_memory', { id: first.id, expected_revision: 1, content: '用新的 Markdown 阅读器' });
  const valid = await readFile(path.join(f.dir, 'exports/memory.md'), 'utf8');
  await writeFile(f.memory, '{corrupt\n');
  await assert.rejects(c.call('search_memories', { query: 'Markdown' }), /legacy_source_invalid/);
  assert.equal(await readFile(path.join(f.dir, 'exports/memory.md'), 'utf8'), valid);
  await writeFile(f.memory, seed);
  assert.equal(graph(await c.call('memory_history', { id: first.id })).items.length, 2);
});

test('multiple MCP clients initialize simultaneously against a new SQLite database', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => f.client()));
  const failed = results.find(x => x.status === 'rejected');
  if (failed) throw failed.reason;
  const clients = results.map(x => x.value);
  for (const c of clients) assert.equal(graph(await c.call('search_memories', { query: '不存在' })).state, 'empty');
});

test('another process refreshes ExampleApp after a client exits and leaves no stale export', async t => {
  const f = await fixture(t);
  const a = await f.client(), b = await f.client();
  await a.call('remember_memory', { entity_name: 'user:example', content: '使用 ExampleApp' });
  await b.call('remember_memory', { entity_name: 'user:example', content: '稍后追加的偏好' });
  await b.close();
  await delay(600);
  assert.match(await readFile(path.join(f.dir, 'exports/memory.md'), 'utf8'), /稍后追加的偏好/);
});

test('a legacy file disappearing while waiting for its lock never deletes imported memories', async t => {
  const { MemoryStore } = await import('../v2/store.mjs');
  const { legacyImporter } = await import('../v2/legacy.mjs');
  const { withFileLock } = await import('../node_modules/@modelcontextprotocol/server-memory/dist/index.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'memory-v2-disappear-'));
  const file = path.join(dir, 'memory.jsonl');
  const seed = JSON.stringify({ type: 'entity', name: 'user:example', entityType: 'fact', observations: ['不能丢失的偏好'] });
  await writeFile(file, seed);
  const store = new MemoryStore(path.join(dir, 'memory.sqlite3'));
  t.after(() => store.close());
  await legacyImporter(file, store)();
  let pending;
  await withFileLock(`${file}.lock`, async () => {
    pending = legacyImporter(file, store)();
    // sync has completed its initial stat and is waiting on our real source lock.
    await delay(50);
    await unlink(file);
  });
  await pending.catch(() => {});
  assert.equal(store.search({ query: '偏好' }).items.length, 1);
});

test('v2 repairs the reading copy if a still-running v1 exporter overwrites it', async t => {
  const f = await fixture(t);
  const client = await f.client();
  await client.call('remember_memory', { entity_name: 'user:example', content: '第二版新增偏好' });
  const file = path.join(f.dir, 'exports/memory.md');
  await writeFile(file, '# 共享 Agent 记忆\n旧版导出，不含新增内容\n');
  let markdown = '';
  for (let i = 0; i < 15; i++) {
    await delay(100);
    markdown = await readFile(file, 'utf8');
    if (markdown.includes('第二版新增偏好')) break;
  }
  assert.match(markdown, /第二版新增偏好/);
});
