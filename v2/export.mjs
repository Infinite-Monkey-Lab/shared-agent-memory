import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from '../node_modules/@modelcontextprotocol/server-memory/dist/index.js';

function escape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]#]/g, '\\$&').replace(/\r?\n/g, '\n  ');
}

export async function exportStore(store, output) {
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  // Snapshot AFTER the export lock: competing processes cannot publish old snapshots last.
  return withFileLock(`${output}.lock`, async () => {
    store.db.exec('BEGIN');
    let graph, history, generation;
    try {
      generation = store.version();
      graph = store.graph();
      history = store.db.prepare("SELECT * FROM memories WHERE status!='active' ORDER BY entity_name,created_at,id").all();
      graph.details = store.db.prepare("SELECT * FROM memories WHERE status='active' ORDER BY created_at,id").all();
      store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    const lines = ['# 共享 Agent 记忆 · 第二版', `<!-- shared-memory-v2 generation:${generation} -->`, '', '> 自动生成的 Typora 阅读副本；编辑不会回写。请通过 shared-memory MCP 更正。', ''];
    for (const entity of graph.entities) {
      lines.push(`## ${escape(entity.name).replaceAll('\n', ' ')}`, '', `类型：${escape(entity.entityType)}`, '');
      for (const memory of graph.details.filter(m => m.entity_name === entity.name)) {
        lines.push(`- ${escape(memory.content)}`, `  - ID：${memory.id}；版本：${memory.revision}；范围：${escape(memory.project ?? '全局')}`, `  - 来源：${escape(memory.source_agent)}；归属：${memory.attribution}；事件时间：${escape(memory.occurred_at ?? '未知')}；记录时间：${memory.created_at}`);
        if (memory.source_session) lines.push(`  - 来源会话：${escape(memory.source_session)}`);
      }
      lines.push('');
    }
    if (!graph.entities.length) lines.push('目前没有有效记忆。', '');
    if (graph.relations.length) {
      lines.push('## 关系', '');
      for (const r of graph.relations) lines.push(`- ${escape(r.from)} → ${escape(r.relationType)} → ${escape(r.to)}`);
      lines.push('');
    }
    if (history.length) {
      lines.push('## 历史记录（已替代或删除，不作为当前事实）', '');
      for (const m of history) lines.push(`- [${m.status}] ${escape(m.entity_name)}：${escape(m.content)}`, `  - ID：${m.id}；版本：${m.revision}；后继：${m.replaced_by ?? '无'}；原因：${escape(m.reason ?? '未知')}`);
      lines.push('');
    }
    const temporary = `${output}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, lines.join('\n'), { mode: 0o600, flag: 'wx' });
      await rename(temporary, output);
    } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
    return generation;
  }, { timeoutMs: 3000 });
}
