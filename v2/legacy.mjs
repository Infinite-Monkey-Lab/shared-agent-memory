import { stat } from 'node:fs/promises';
import { KnowledgeGraphManager, withFileLock } from '../node_modules/@modelcontextprotocol/server-memory/dist/index.js';
import { digest } from './store.mjs';

// This is the only legacy read path. Never write the JSONL or manipulate its lock.
export function legacyImporter(file, store) {
  const manager = new KnowledgeGraphManager(file);
  let signature = null;
  return async function sync() {
    const info = await stat(file).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    // A missing source is unavailable, not proof that old memories were deleted.
    if (!info) return { state: 'source_missing' };
    const next = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (signature === next) return { state: 'unchanged' };
    return withFileLock(`${file}.lock`, async () => {
      const before = await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!before) return { state: 'source_missing' };
      const { graph, unreadable } = await manager.loadGraphWithUnreadable();
      if (unreadable.length) throw new Error('legacy_source_invalid');
      // Re-stat under the same lock used by original writers.
      const current = await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!current) return { state: 'source_missing' };
      if (before.ino !== current.ino || before.size !== current.size || before.mtimeMs !== current.mtimeMs) throw new Error('legacy_source_changed');
      const result = store.importGraph(graph, digest(graph));
      signature = `${current.dev}:${current.ino}:${current.size}:${current.mtimeMs}:${current.ctimeMs}`;
      return { state: 'ok', ...result };
    }, { timeoutMs: 3000 });
  };
}
