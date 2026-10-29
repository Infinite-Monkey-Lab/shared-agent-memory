import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function fixture(t) {
  const { MemoryStore } = await import('../v2/store.mjs');
  const store = new MemoryStore(path.join(mkdtempSync(path.join(tmpdir(), 'memory-v2-store-')), 'memory.sqlite3'));
  t.after(() => store.close());
  return store;
}

test('structured memory persists provenance, and request retries cannot alter a committed write', async t => {
  const s = await fixture(t);
  const input = { entity_name: 'user:example', content: '使用 ExampleApp 查看 Markdown。', kind: 'user-preference', request_key: 'remember-1' };
  const first = s.remember(input);
  assert.equal(first.attribution, 'unknown');
  assert.equal(first.occurred_at, null);
  assert.equal(first.source_agent, 'unknown');
  assert.equal(first.revision, 1);
  assert.equal(s.remember(input).id, first.id);
  assert.throws(() => s.remember({ ...input, content: 'different' }), /request_key_conflict/);
  assert.equal(s.search({ query: '我用什么看 Markdown？' }).items[0].id, first.id);
});

test('correction preserves history, rejects stale writers and survives an idempotent retry', async t => {
  const s = await fixture(t);
  const old = s.remember({ entity_name: 'user:example', content: '默认 npm', attribution: 'user-stated' });
  const input = { id: old.id, expected_revision: 1, content: '默认 pnpm', reason: '用户改变偏好', request_key: 'correction-1', attribution: 'user-stated' };
  const current = s.correct(input);
  assert.equal(current.revision, 2);
  assert.equal(current.supersedes, old.id);
  assert.equal(s.correct(input).id, current.id);
  assert.throws(() => s.correct({ ...input, request_key: 'another-request' }), /revision_conflict/);
  assert.deepEqual(s.history({ id: current.id }).items.map(m => [m.content, m.status]), [['默认 npm', 'superseded'], ['默认 pnpm', 'active']]);
  assert.equal(s.search({ query: 'npm' }).items.some(m => m.id === old.id), false);
  s.forget({ id: current.id, expected_revision: 2, reason: '用户要求删除' });
  assert.equal(s.search({ query: 'pnpm' }).items.length, 0);
  assert.equal(s.history({ id: old.id }).items[1].status, 'deleted');
});

test('scope is applied before candidate limiting; global preferences accompany only the selected project', async t => {
  const s = await fixture(t);
  s.remember({ entity_name: 'user:example', content: '全局选择 pnpm' });
  s.remember({ entity_name: 'project:/repo/a:packages', content: '此项目选择 npm' });
  for (let i = 0; i < 25; i++) s.remember({ entity_name: 'project:/repo/b:packages', content: `选择 npm 开发方案 ${i}` });
  const scoped = s.search({ query: '选择', project: '/repo/a', limit: 20 });
  assert.equal(scoped.items.length, 2);
  assert.deepEqual(new Set(scoped.items.map(x => x.project)), new Set([null, '/repo/a']));
  assert.equal(s.search({ query: '选择' }).items.length, 1);
  assert.throws(() => s.remember({ entity_name: 'project:/repo/a:packages', content: 'bad', project: '/repo/b' }), /project_mismatch/);
});

test('Unicode result budgets truncate honestly and garbage queries do not return unrelated memories', async t => {
  const s = await fixture(t);
  s.remember({ entity_name: 'user:example', content: `Markdown ${'😀'.repeat(400)}` });
  const result = s.search({ query: 'Markdown', character_budget: 200 });
  assert.equal(result.truncated, true);
  assert.equal(result.used_characters, 200);
  assert.equal([...result.items[0].content].length, 200);
  assert.equal(result.items[0].truncated, true);
  assert.equal(s.search({ query: 'zzzznoexist' }).items.length, 0);
  assert.equal(s.search({ query: '！！！' }).items.length, 0);
  assert.throws(() => s.search({ query: 'x', limit: 0 }), /limit/);
});

test('legacy tools share native lifecycle, preserve relation discovery, and restore entities without erasing history', async t => {
  const s = await fixture(t);
  const entity = { name: 'user:example', entityType: 'user-preference', observations: ['默认 npm'] };
  assert.equal(s.legacy('create_entities', { entities: [entity] }).entities.length, 1);
  assert.deepEqual(s.legacy('create_entities', { entities: [entity] }).skipped, ['user:example']);
  const id = s.search({ query: 'npm' }).items[0].id;
  s.correct({ id, expected_revision: 1, content: '默认 pnpm' });
  assert.deepEqual(s.legacy('open_nodes', { names: ['user:example'] }).entities[0].observations, ['默认 pnpm']);
  s.legacy('create_relations', { relations: [{ from: 'user:example', to: 'outside', relationType: 'works_on' }] });
  assert.equal(s.legacy('search_nodes', { query: 'pnpm' }).relations.length, 1);
  s.legacy('delete_entities', { entityNames: ['user:example'] });
  assert.equal(s.graph().entities.length, 0);
  s.legacy('create_entities', { entities: [{ ...entity, observations: ['默认 yarn'] }] });
  assert.equal(s.history({ id }).items.length, 2);
  assert.deepEqual(s.graph().entities[0].observations, ['默认 yarn']);
});

test('legacy import is atomic, repeatable and does not resurrect a superseded fact', async t => {
  const s = await fixture(t);
  const graph = { entities: [{ name: 'user:example', entityType: 'user-preference', observations: ['默认 npm'] }], relations: [] };
  s.importGraph(graph, 'digest1');
  const old = s.search({ query: 'npm' }).items[0];
  assert.equal(old.source_agent, 'legacy-import');
  assert.equal(old.attribution, 'unknown');
  s.correct({ id: old.id, expected_revision: 1, content: '默认 pnpm' });
  s.importGraph(graph, 'digest2');
  assert.equal(s.history({ id: old.id }).items.length, 2);
  assert.equal(s.search({ query: 'npm' }).items.some(x => x.id === old.id), false);
  s.importGraph({ ...graph, entities: [...graph.entities, { name: 'user:new', entityType: 'fact', observations: ['late write'] }] }, 'digest3');
  assert.equal(s.search({ query: 'late write' }).items.length, 1);
  assert.throws(() => s.importGraph({ entities: [{ name: 'broken' }], relations: [] }, 'bad'), /invalid_legacy_graph/);
  assert.equal(s.search({ query: 'pnpm' }).items.length, 1);
});

test('late legacy snapshots cannot revive native-corrected content or a deleted entity', async t => {
  const s = await fixture(t);
  const old = s.remember({ entity_name: 'user:example', content: '默认 npm' });
  s.correct({ id: old.id, expected_revision: 1, content: '默认 pnpm' });
  s.importGraph({ entities: [{ name: 'user:example', entityType: 'fact', observations: ['默认 npm'] }], relations: [] }, 'late-old');
  assert.equal(s.search({ query: 'npm' }).items.some(m => m.content === '默认 npm'), false);
  s.legacy('delete_entities', { entityNames: ['user:example'] });
  s.importGraph({ entities: [{ name: 'user:example', entityType: 'fact', observations: ['新的旧客户端观察'] }], relations: [] }, 'late-new');
  assert.equal(s.graph().entities.length, 0);
});

test('full-text indexing covers the tail of long valid memories', async t => {
  const s = await fixture(t);
  s.remember({ entity_name: 'user:example', content: Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ') + ' tailkeyword' });
  assert.equal(s.search({ query: 'tailkeyword' }).items.length, 1);
});

test('native relation deletion survives legacy replay until an explicit native recreation', async t => {
  const s = await fixture(t);
  const relation = { from: 'user:example', to: 'outside', relationType: 'works_on' };
  const graph = { entities: [{ name: 'user:example', entityType: 'fact', observations: ['偏好'] }], relations: [relation] };
  s.importGraph(graph, 'relations1');
  s.legacy('delete_relations', { relations: [relation] });
  s.importGraph(graph, 'relations2');
  assert.equal(s.graph().relations.length, 0);
  s.legacy('create_relations', { relations: [relation] });
  assert.equal(s.graph().relations.length, 1);
});
