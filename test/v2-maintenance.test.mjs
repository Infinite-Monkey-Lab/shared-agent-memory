import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('maintenance backup is a consistent SQLite snapshot, preserves history and never overwrites an existing backup', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'memory-v2-maintenance-'));
  const file = path.join(dir, 'memory.sqlite3');
  const target = path.join(dir, 'backup.sqlite3');
  const { MemoryStore } = await import('../v2/store.mjs');
  const store = new MemoryStore(file);
  t.after(() => store.close());
  const first = store.remember({ entity_name: 'user:example', content: '默认 npm' });
  store.correct({ id: first.id, expected_revision: 1, content: '默认 pnpm' });
  const command = fileURLToPath(new URL('../v2/maintenance.mjs', import.meta.url));
  const options = { env: { ...process.env, MEMORY_DB_PATH: file, MEMORY_FILE_PATH: path.join(dir, 'legacy.jsonl'), MEMORY_EXPORT_PATH: path.join(dir, 'export.md') } };
  await promisify(execFile)(process.execPath, [command, 'backup', target], options);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(target, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('SELECT content,status FROM memories ORDER BY revision').all().map(x => [x.content, x.status]), [['默认 npm', 'superseded'], ['默认 pnpm', 'active']]);
  } finally { db.close(); }
  if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600);
  const bytes = await readFile(target);
  await assert.rejects(promisify(execFile)(process.execPath, [command, 'backup', target], options));
  assert.deepEqual(await readFile(target), bytes);
});
