import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { withFileLock } from './node_modules/@modelcontextprotocol/server-memory/dist/index.js';

export const defaultMemoryPath = fileURLToPath(new URL('../memory.jsonl', import.meta.url));

function text(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]#]/g, '\\$&');
}

// Reuse the store's lock: concurrent exporters must read AFTER taking the lock.
export async function exportMemory(memoryPath, outputPath) {
  return withFileLock(`${memoryPath}.lock`, async () => {
    const records = (await readFile(memoryPath, 'utf8')).split('\n').filter(line => line.trim()).map(JSON.parse);
    const entities = [];
    const relations = [];
    for (const record of records) {
      if (record.type === 'entity' && typeof record.name === 'string' && typeof record.entityType === 'string'
        && Array.isArray(record.observations) && record.observations.every(value => typeof value === 'string')) {
        entities.push(record);
      } else if (record.type === 'relation' && ['from', 'to', 'relationType'].every(key => typeof record[key] === 'string')) {
        relations.push(record);
      } else {
        throw new Error('Invalid memory record; previous Markdown export retained');
      }
    }
    entities.sort((a, b) => a.name.localeCompare(b.name));
    const lines = [
      '# 共享 Agent 记忆', '',
      '> 自动生成的 Typora 阅读副本。修改本文件不会回写记忆，请通过 shared-memory MCP 更新。', '',
    ];
    if (!entities.length) lines.push('目前没有记忆。', '');
    for (const entity of entities) {
      lines.push(`## ${text(entity.name).replace(/\r?\n/g, ' ')}`, '', `类型：${text(entity.entityType).replace(/\r?\n/g, ' ')}`, '');
      for (const observation of entity.observations) lines.push(`- ${text(observation).replace(/\r?\n/g, '\n  ')}`);
      lines.push('');
    }
    if (relations.length) {
      lines.push('## 关系', '');
      for (const relation of relations) lines.push(`- ${text(relation.from)} → ${text(relation.relationType)} → ${text(relation.to)}`.replace(/\r?\n/g, ' '));
      lines.push('');
    }
    await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    const temporary = `${outputPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, lines.join('\n'), { mode: 0o600, flag: 'wx' });
      await rename(temporary, outputPath);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const memory = path.resolve(process.env.MEMORY_FILE_PATH ?? defaultMemoryPath);
  const output = path.resolve(process.env.MEMORY_EXPORT_PATH ?? path.join(path.dirname(memory), 'exports/memory.md'));
  await exportMemory(memory, output);
  console.error(`Markdown exported to ${output}`);
}
