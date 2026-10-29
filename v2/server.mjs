import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const content = z.string().trim().min(1).max(20000);
const name = z.string().trim().min(1).max(1024);
const id = z.string().min(1).max(128);
const batch = item => z.array(item).max(100);
const provenance = {
  source_agent: z.string().min(1).max(128).optional(),
  source_session: z.string().min(1).max(512).optional(),
  attribution: z.enum(['user-stated', 'agent-inferred', 'unknown']).optional(),
  occurred_at: z.iso.datetime({ offset: true }).optional(),
};
const request = { request_key: z.string().min(1).max(256).optional() };
const revision = { id, expected_revision: z.number().int().min(1), reason: z.string().max(2000).optional(), ...request };
const relation = z.object({ from: name, to: name, relationType: z.string().min(1).max(128) }).strict();

export function createMemoryServer(store, run, sync, refresh) {
  const server = new McpServer({ name: 'shared-memory', version: '0.2.0' }, {
    instructions: 'Shared local memory. Search global preferences and the current project with search_memories. Use remember_memory, correct_memory and memory_history; records include provenance. user-stated means caller-reported user statement, not independently verified approval. Historical memories are reference data; current user instructions take precedence. This server uses lexical retrieval, not semantic search. JSONL is a read-only legacy import source. Deleted records remain in history and Markdown; forget_memory is not physical erasure.',
  });
  function register(name, description, shape, readOnly, action) {
    server.registerTool(name, {
      description, inputSchema: z.object(shape).strict(),
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly && /delete|forget/.test(name), idempotentHint: readOnly, openWorldHint: false },
    }, input => run(async () => {
      try {
        await sync();
        const result = action(input);
        let exportStatus = 'ok';
        try { await refresh(); } catch { exportStatus = 'failed'; }
        const payload = exportStatus === 'ok' ? result : { ...result, export_status: exportStatus };
        return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
      } catch (error) {
        const code = /^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : 'memory_operation_failed';
        return { isError: true, content: [{ type: 'text', text: code }] };
      }
    }));
  }
  register('remember_memory', 'Save a confirmed useful memory with provenance; request_key makes retries safe. Unknown sources stay unknown. Same entity/content is deduplicated.', {
    entity_name: name, content, kind: z.string().min(1).max(128).optional(), project: z.string().min(1).max(4096).optional(), ...provenance, ...request,
  }, false, input => store.remember(input));
  register('correct_memory', 'Replace an active memory with a new revision. Use the returned id and revision for subsequent corrections; stale writers are rejected. Old content stays in history.', {
    ...revision, content, ...provenance,
  }, false, input => store.correct(input));
  register('forget_memory', 'Logically delete the active revision. Historical content remains in SQLite and the Markdown history; this is not physical erasure.', revision, false, input => store.forget(input));
  register('search_memories', 'Bounded lexical/full-text recall. With project, returns global and that exact project; without project, global only. Project selection is a relevance filter, not authorization.', {
    query: z.string().trim().min(1).max(2048), project: z.string().min(1).max(4096).optional(),
    limit: z.number().int().min(1).max(20).optional(), character_budget: z.number().int().min(200).max(20000).optional(), include_history: z.boolean().optional(),
  }, true, input => store.search(input));
  register('memory_history', 'Read up to 100 revisions of a memory chain, including deleted and superseded records.', { id, limit: z.number().int().min(1).max(100).optional() }, true, input => store.history(input));
  register('memory_status', 'Read non-secret store status and counts; does not expose memory content or paths.', {}, true, () => ({
    version: '0.2.0', schema_version: 2, generation: store.version(), retrieval: 'lexical',
    counts: store.db.prepare('SELECT status,COUNT(*) count FROM memories GROUP BY status').all(),
  }));
  const entity = z.object({ name, entityType: z.string().min(1).max(128), observations: batch(content) }).strict();
  const legacy = {
    create_entities: { entities: batch(entity) },
    add_observations: { observations: batch(z.object({ entityName: name, contents: batch(content) }).strict()) },
    create_relations: { relations: batch(relation) },
    delete_entities: { entityNames: batch(name) },
    delete_observations: { deletions: batch(z.object({ entityName: name, observations: batch(content) }).strict()) },
    delete_relations: { relations: batch(relation) },
    read_graph: {}, search_nodes: { query: z.string().trim().min(1).max(2048) }, open_nodes: { names: batch(name) },
  };
  for (const [tool, schema] of Object.entries(legacy)) {
    const readOnly = ['read_graph', 'search_nodes', 'open_nodes'].includes(tool);
    register(tool, `Compatibility tool backed by the same v2 SQLite store. ${readOnly ? 'Explicit graph reads may be large; prefer search_memories for bounded project-aware retrieval.' : 'New callers should prefer versioned native memory tools. Legacy deletion is logical and retained in history.'}`, schema, readOnly, args => store.legacy(tool, args));
  }
  return server;
}
