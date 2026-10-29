import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { open } from 'node:fs/promises';
import os from 'node:os';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { MemoryStore } from './store.mjs';
import { legacyImporter } from './legacy.mjs';
import { exportStore } from './export.mjs';
import { createMemoryServer } from './server.mjs';

process.umask(0o077);
const root = path.join(os.homedir(), '.agent-memory');
export function resolvePaths(env = process.env) {
  const legacy = path.resolve(env.MEMORY_FILE_PATH ?? path.join(root, 'memory.jsonl'));
  const database = path.resolve(env.MEMORY_DB_PATH ?? (env.MEMORY_FILE_PATH ? legacy.replace(/\.jsonl$/u, '') + '.sqlite3' : path.join(root, 'memory.sqlite3')));
  const output = path.resolve(env.MEMORY_EXPORT_PATH ?? path.join(path.dirname(database), 'exports/memory.md'));
  if (new Set([legacy, database, output]).size !== 3) throw new Error('conflicting_storage_paths');
  return { legacy, database, output };
}

async function main() {
  const paths = resolvePaths();
  const store = new MemoryStore(paths.database);
  const sync = legacyImporter(paths.legacy, store);
  let generation = -1;
  const refresh = async () => {
    const version = store.version();
    let current = false;
    let file;
    try {
      file = await open(paths.output, 'r');
      const header = Buffer.alloc(256);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      current = header.subarray(0, bytesRead).toString('utf8').includes(`<!-- shared-memory-v2 generation:${version} -->`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { await file?.close(); }
    // A v1 process can still overwrite the shared reading copy on shutdown.
    // The DB generation stamp detects that without repeatedly reading the body.
    if (generation !== version || !current) generation = await exportStore(store, paths.output);
  };
  let queue = Promise.resolve();
  const run = operation => {
    const task = queue.then(operation);
    queue = task.catch(() => {});
    return task;
  };
  await sync();
  await refresh();
  let handle;
  let closing = false;
  const interval = setInterval(() => {
    if (!closing) run(async () => { await sync(); await refresh(); }).catch(() => {
      // Never log content, source paths, or turn an unavailable source into empty recall.
      console.error('[shared-memory] background_sync_unavailable');
    });
  }, 500);
  interval.unref();
  handle = serveStdio(() => createMemoryServer(store, run, sync, refresh), {
    onerror: () => { console.error('[shared-memory] transport_error'); process.exitCode = 1; },
  });
  async function stop() {
    if (closing) return;
    closing = true;
    clearInterval(interval);
    await queue;
    await handle.close();
    store.close();
  }
  process.stdin.on('end', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[shared-memory] ${/^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : 'startup_failed'}`);
    process.exitCode = 1;
  });
}

export { main };
