import { backup } from 'node:sqlite';
import { mkdir, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from './store.mjs';
import { legacyImporter } from './legacy.mjs';
import { exportStore } from './export.mjs';
import { resolvePaths } from './start.mjs';

async function main() {
  const command = process.argv[2] ?? 'status';
  if (!['status', 'migrate', 'export', 'backup'].includes(command)) throw new Error('invalid_command');
  const paths = resolvePaths();
  const store = new MemoryStore(paths.database);
  try {
    if (command === 'migrate') await legacyImporter(paths.legacy, store)();
    if (command === 'migrate' || command === 'export') await exportStore(store, paths.output);
    if (command === 'backup') {
      const target = process.argv[3];
      if (!target || !path.isAbsolute(target)) throw new Error('absolute_backup_path_required');
      if ([paths.legacy, paths.database, paths.output].includes(path.resolve(target))) throw new Error('conflicting_backup_path');
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await backup(store.db, temporary);
        // link is exclusive: an existing backup is never replaced, even in a race.
        await link(temporary, target);
      } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
    }
    console.log(JSON.stringify({ command, version: '0.2.0', integrity: store.db.prepare('PRAGMA integrity_check').get().integrity_check, generation: store.version(), counts: store.db.prepare('SELECT status,COUNT(*) count FROM memories GROUP BY status').all() }));
  } finally { store.close(); }
}

main().catch(error => {
  console.error(`[shared-memory] ${error.code === 'EEXIST' ? 'backup_already_exists' : /^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : 'maintenance_failed'}`);
  process.exitCode = 1;
});
