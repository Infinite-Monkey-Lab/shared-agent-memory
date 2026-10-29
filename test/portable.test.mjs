import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { resolvePaths } from '../v2/start.mjs';

test('default data paths are shared in the current user home, independent of the checkout location', () => {
  const paths = resolvePaths({});
  assert.equal(paths.database, path.join(os.homedir(), '.agent-memory', 'memory.sqlite3'));
  assert.equal(paths.legacy, path.join(os.homedir(), '.agent-memory', 'memory.jsonl'));
  assert.equal(paths.output, path.join(os.homedir(), '.agent-memory', 'exports', 'memory.md'));
});

test('explicit isolated paths are preserved and collisions are rejected', () => {
  const root = path.join(os.tmpdir(), 'shared-memory-example');
  const options = { MEMORY_FILE_PATH: path.join(root, 'old.jsonl'), MEMORY_DB_PATH: path.join(root, 'database.sqlite3'), MEMORY_EXPORT_PATH: path.join(root, 'export.md') };
  assert.deepEqual(resolvePaths(options), { legacy: options.MEMORY_FILE_PATH, database: options.MEMORY_DB_PATH, output: options.MEMORY_EXPORT_PATH });
  assert.throws(() => resolvePaths({ ...options, MEMORY_EXPORT_PATH: options.MEMORY_DB_PATH }), /conflicting_storage_paths/);
});
