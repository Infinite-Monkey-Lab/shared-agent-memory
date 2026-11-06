import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { terms, bounded } from './search.mjs';

function fail(code) { throw new Error(code); }
function text(value, label, max = 20000) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max || value.includes('\0')) fail(`invalid_${label}`);
  return value;
}
function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`invalid_${label}`);
  return value;
}
function canonical(x) {
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])]));
  return x;
}
export function digest(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function projectFor(name, explicit) {
  const inferred = /^project:(\/.*):[^:]+$/u.exec(name)?.[1] ?? null;
  if (explicit != null && (typeof explicit !== 'string' || !path.isAbsolute(explicit) || explicit.includes('\0'))) fail('invalid_project');
  const project = explicit == null ? (inferred == null ? null : path.normalize(inferred)) : path.normalize(explicit);
  if (inferred && project !== path.normalize(inferred)) fail('project_mismatch');
  return project == null ? null : path.normalize(project);
}

export class MemoryStore {
  constructor(file) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;');
    // Initial journal-mode transitions can return SQLITE_BUSY without invoking
    // SQLite's busy handler when several processes open a fresh database.
    const deadline = Date.now() + 10000;
    for (;;) {
      try { this.db.exec('PRAGMA journal_mode=WAL'); break; }
      catch (error) {
        if ((error.errcode & 255) !== 5 || Date.now() >= deadline) { this.db.close(); throw error; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    if (this.db.prepare('PRAGMA user_version').get().user_version > 2) fail('unsupported_schema');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (name TEXT PRIMARY KEY, entityType TEXT NOT NULL, deleted_at TEXT);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, entity_name TEXT NOT NULL REFERENCES entities(name), kind TEXT NOT NULL,
        project TEXT, content TEXT NOT NULL, source_agent TEXT NOT NULL, source_session TEXT,
        attribution TEXT NOT NULL CHECK(attribution IN ('user-stated','agent-inferred','unknown')),
        occurred_at TEXT, created_at TEXT NOT NULL, revision INTEGER NOT NULL,
        root_id TEXT NOT NULL, supersedes TEXT, status TEXT NOT NULL CHECK(status IN ('active','superseded','deleted')),
        reason TEXT, replaced_by TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS active_content ON memories(entity_name,content) WHERE status='active';
      CREATE INDEX IF NOT EXISTS memory_scope ON memories(project,status);
      CREATE INDEX IF NOT EXISTS memory_root ON memories(root_id,revision);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED, words, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS relations (from_name TEXT, to_name TEXT, relationType TEXT, native INTEGER DEFAULT 0, legacy INTEGER DEFAULT 0, blocked INTEGER DEFAULT 0, PRIMARY KEY(from_name,to_name,relationType));
      CREATE TABLE IF NOT EXISTS requests (request_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_links (identity TEXT PRIMARY KEY, memory_id TEXT NOT NULL, owned INTEGER NOT NULL, present INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta VALUES ('generation','0');
      PRAGMA user_version=2;
    `);
  }
  close() { this.db.close(); }
  version() { return Number(this.db.prepare("SELECT value FROM meta WHERE key='generation'").get().value); }
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='generation'");
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  request(action, input, operation) {
    return this.transaction(() => {
      const key = input.request_key;
      const hash = digest({ action, input });
      if (key !== undefined) {
        text(key, 'request_key', 256);
        const previous = this.db.prepare('SELECT * FROM requests WHERE request_key=?').get(key);
        if (previous) {
          if (previous.payload_hash !== hash) fail('request_key_conflict');
          return JSON.parse(previous.result);
        }
      }
      const result = operation();
      if (key !== undefined) this.db.prepare('INSERT INTO requests VALUES (?,?,?)').run(key, hash, JSON.stringify(result));
      return result;
    });
  }
  entity(name, kind) {
    text(name, 'entity_name', 1024); text(kind, 'kind', 128);
    this.db.prepare('INSERT INTO entities(name,entityType) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET deleted_at=NULL').run(name, kind);
  }
  insert(input, previous = null) {
    const name = text(input.entity_name, 'entity_name', 1024);
    const content = text(input.content, 'content');
    const kind = input.kind ?? 'fact';
    const project = projectFor(name, input.project);
    const attribution = input.attribution ?? 'unknown';
    if (!['user-stated', 'agent-inferred', 'unknown'].includes(attribution)) fail('invalid_attribution');
    if (input.occurred_at != null && (typeof input.occurred_at !== 'string' || !Number.isFinite(Date.parse(input.occurred_at)))) fail('invalid_occurred_at');
    const agent = text(input.source_agent ?? 'unknown', 'source_agent', 128);
    const session = input.source_session == null ? null : text(input.source_session, 'source_session', 512);
    this.entity(name, kind);
    const duplicate = this.db.prepare("SELECT * FROM memories WHERE entity_name=? AND content=? AND status='active'").get(name, content);
    if (duplicate) {
      if (previous) fail('active_content_conflict');
      if (duplicate.project !== project || duplicate.kind !== kind) fail('memory_metadata_conflict');
      return duplicate;
    }
    const id = randomUUID();
    const row = {
      id, entity_name: name, kind, project, content, source_agent: agent, source_session: session,
      attribution, occurred_at: input.occurred_at ?? null, created_at: new Date().toISOString(),
      revision: previous ? previous.revision + 1 : 1, root_id: previous?.root_id ?? id,
      supersedes: previous?.id ?? null, status: 'active', reason: input.reason ?? null, replaced_by: null,
    };
    this.db.prepare(`INSERT INTO memories (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
    this.db.prepare('INSERT INTO memory_fts(memory_id,words) VALUES (?,?)').run(id, terms(`${content} ${name}`).join(' '));
    return row;
  }
  remember(input) { return this.request('remember', input, () => this.insert(input)); }
  active(input) {
    text(input.id, 'id', 128);
    integer(input.expected_revision, 'expected_revision', 1, Number.MAX_SAFE_INTEGER);
    const old = this.db.prepare('SELECT * FROM memories WHERE id=?').get(input.id);
    if (!old || old.status !== 'active' || old.revision !== input.expected_revision) fail('revision_conflict');
    return old;
  }
  correct(input) {
    return this.request('correct', input, () => {
      const old = this.active(input);
      text(input.content, 'content');
      if (input.content === old.content) return old;
      this.db.prepare("UPDATE memories SET status='superseded' WHERE id=?").run(old.id);
      const current = this.insert({ ...input, entity_name: old.entity_name, kind: old.kind, project: old.project }, old);
      this.db.prepare('UPDATE memories SET replaced_by=? WHERE id=?').run(current.id, old.id);
      return current;
    });
  }
  forget(input) {
    return this.request('forget', input, () => {
      const old = this.active(input);
      this.db.prepare("UPDATE memories SET status='deleted',reason=? WHERE id=?").run(input.reason ?? null, old.id);
      return { ...old, status: 'deleted', reason: input.reason ?? null };
    });
  }
  history({ id, limit = 50 }) {
    text(id, 'id', 128); integer(limit, 'limit', 1, 100);
    const row = this.db.prepare('SELECT root_id FROM memories WHERE id=?').get(id);
    if (!row) return { items: [], truncated: false };
    const rows = this.db.prepare('SELECT * FROM memories WHERE root_id=? ORDER BY revision LIMIT ?').all(row.root_id, limit + 1);
    return { items: rows.slice(0, limit), truncated: rows.length > limit };
  }
  search({ query, project = null, limit = 8, character_budget = 4000, include_history = false }) {
    text(query, 'query', 2048); integer(limit, 'limit', 1, 20); integer(character_budget, 'character_budget', 200, 20000);
    const scope = projectFor('', project);
    const tokens = terms(query, 128);
    if (!tokens.length) return { state: 'empty', retrieval: 'lexical', items: [], used_characters: 0, truncated: false };
    const expression = tokens.map(term => `"${term.replaceAll('"', '""')}"*`).join(' OR ');
    const rows = this.db.prepare(`SELECT m.*,bm25(memory_fts) AS rank FROM memory_fts
      JOIN memories m ON m.id=memory_fts.memory_id JOIN entities e ON e.name=m.entity_name
      WHERE memory_fts MATCH ? AND (m.project IS NULL OR m.project=?) AND e.deleted_at IS NULL
      AND (? OR m.status='active') ORDER BY rank,m.created_at DESC,m.id LIMIT ?`).all(expression, scope, include_history ? 1 : 0, limit + 1);
    const result = bounded(rows.map(({ rank, ...row }) => ({ ...row, matched_by: ['lexical'] })), limit, character_budget);
    return { state: result.items.length ? 'grounded' : 'empty', retrieval: 'lexical', ...result };
  }
  graph(names = null, query = null) {
    // A single read transaction keeps the entity/observation/relation view coherent.
    this.db.exec('SAVEPOINT graph_read');
    try {
      let entities = this.db.prepare('SELECT name,entityType FROM entities WHERE deleted_at IS NULL ORDER BY name').all().map(entity => ({
        ...entity, observations: this.db.prepare("SELECT content FROM memories WHERE entity_name=? AND status='active' ORDER BY created_at,id").all(entity.name).map(row => row.content),
      }));
      if (names) { const selected = new Set(names); entities = entities.filter(e => selected.has(e.name)); }
      if (query != null) {
        const needle = query.toLowerCase();
        entities = entities.filter(e => [e.name, e.entityType, ...e.observations].some(value => value.toLowerCase().includes(needle)));
      }
      const selected = new Set(entities.map(e => e.name));
      const relations = this.db.prepare('SELECT from_name AS "from",to_name AS "to",relationType FROM relations WHERE blocked=0 AND (native=1 OR legacy=1) ORDER BY from_name,to_name,relationType').all().filter(r => selected.has(r.from) || selected.has(r.to));
      return { entities, relations };
    } finally { this.db.exec('RELEASE graph_read'); }
  }
  legacy(name, args) {
    if (name === 'read_graph') return this.graph();
    if (name === 'open_nodes') return this.graph(args.names);
    if (name === 'search_nodes') { text(args.query, 'query', 2048); return this.graph(null, args.query); }
    return this.transaction(() => {
      if (name === 'create_entities') {
        const entities = [], skipped = [];
        for (const e of args.entities) {
          const exists = this.db.prepare('SELECT name FROM entities WHERE name=? AND deleted_at IS NULL').get(e.name);
          if (exists) { skipped.push(e.name); continue; }
          this.entity(e.name, e.entityType);
          for (const content of e.observations) this.insert({ entity_name: e.name, kind: e.entityType, content });
          entities.push(this.graph([e.name]).entities[0]);
        }
        return { entities, skipped };
      }
      if (name === 'add_observations') {
        const results = [];
        for (const item of args.observations) {
          const entity = this.db.prepare('SELECT * FROM entities WHERE name=? AND deleted_at IS NULL').get(item.entityName);
          if (!entity) fail('entity_not_found');
          const added = [];
          for (const content of item.contents) {
            const exists = this.db.prepare("SELECT id FROM memories WHERE entity_name=? AND content=? AND status='active'").get(item.entityName, content);
            if (!exists) { this.insert({ entity_name: item.entityName, kind: entity.entityType, content }); added.push(content); }
          }
          results.push({ entityName: item.entityName, addedObservations: added });
        }
        return { results };
      }
      if (name === 'create_relations') {
        const created = [];
        for (const r of args.relations) {
          const exists = this.db.prepare('SELECT 1 FROM relations WHERE from_name=? AND to_name=? AND relationType=? AND (native=1 OR legacy=1)').get(r.from, r.to, r.relationType);
          this.db.prepare('INSERT INTO relations(from_name,to_name,relationType,native) VALUES (?,?,?,1) ON CONFLICT DO UPDATE SET native=1,blocked=0').run(r.from, r.to, r.relationType);
          if (!exists) created.push(r);
        }
        return { relations: created };
      }
      let count = 0;
      if (name === 'delete_observations') {
        for (const e of args.deletions) for (const content of e.observations) count += this.db.prepare("UPDATE memories SET status='deleted',reason='legacy delete_observations' WHERE entity_name=? AND content=? AND status='active'").run(e.entityName, content).changes;
      } else if (name === 'delete_entities') {
        for (const entity of args.entityNames) {
          count += this.db.prepare('UPDATE entities SET deleted_at=? WHERE name=? AND deleted_at IS NULL').run(new Date().toISOString(), entity).changes;
          this.db.prepare("UPDATE memories SET status='deleted',reason='legacy delete_entities' WHERE entity_name=? AND status='active'").run(entity);
          this.db.prepare('UPDATE relations SET native=0,legacy=0,blocked=1 WHERE from_name=? OR to_name=?').run(entity, entity);
        }
      } else if (name === 'delete_relations') {
        for (const r of args.relations) {
          count += this.db.prepare('UPDATE relations SET native=0,legacy=0,blocked=1 WHERE from_name=? AND to_name=? AND relationType=? AND (native=1 OR legacy=1)').run(r.from, r.to, r.relationType).changes;
          this.db.prepare('INSERT INTO relations(from_name,to_name,relationType,blocked) VALUES (?,?,?,1) ON CONFLICT DO UPDATE SET blocked=1').run(r.from, r.to, r.relationType);
        }
      } else fail('unknown_tool');
      return { success: true, deletedCount: count };
    });
  }
  importGraph(graph, hash) {
    if (!graph || !Array.isArray(graph.entities) || !Array.isArray(graph.relations) || graph.entities.some(e => !e || typeof e.name !== 'string' || !e.name.trim() || typeof e.entityType !== 'string' || !Array.isArray(e.observations) || e.observations.some(o => typeof o !== 'string' || !o.trim())) || graph.relations.some(r => !r || ['from', 'to', 'relationType'].some(k => typeof r[k] !== 'string' || !r[k].trim()))) fail('invalid_legacy_graph');
    return this.transaction(() => {
      if (this.db.prepare("SELECT value FROM meta WHERE key='legacy_digest'").get()?.value === hash) return { unchanged: true };
      this.db.exec('UPDATE legacy_links SET present=0; UPDATE relations SET legacy=0');
      for (const e of graph.entities) {
        // Do not revive a native-deleted entity when an unchanged legacy snapshot is replayed.
        const entity = this.db.prepare('SELECT * FROM entities WHERE name=?').get(e.name);
        if (entity?.deleted_at) continue;
        if (!entity) this.entity(e.name, e.entityType);
        for (const content of e.observations) {
          const identity = digest([e.name, content]);
          const link = this.db.prepare('SELECT * FROM legacy_links WHERE identity=?').get(identity);
          if (link) { this.db.prepare('UPDATE legacy_links SET present=1 WHERE identity=?').run(identity); continue; }
          // A stale legacy client may emit content already corrected or deleted
          // natively, even if that content has never appeared in a legacy import.
          const existed = this.db.prepare("SELECT id FROM memories WHERE entity_name=? AND content=? ORDER BY created_at DESC LIMIT 1").get(e.name, content);
          const row = existed ?? this.insert({ entity_name: e.name, kind: e.entityType, content, source_agent: 'legacy-import' });
          this.db.prepare('INSERT INTO legacy_links VALUES (?,?,?,1)').run(identity, row.id, existed ? 0 : 1);
        }
      }
      this.db.exec("UPDATE memories SET status='deleted',reason='legacy source removed' WHERE status='active' AND id IN (SELECT memory_id FROM legacy_links WHERE present=0 AND owned=1)");
      for (const r of graph.relations) {
        if (this.db.prepare('SELECT 1 FROM entities WHERE name IN (?,?) AND deleted_at IS NOT NULL').get(r.from, r.to)) continue;
        if (this.db.prepare('SELECT 1 FROM relations WHERE from_name=? AND to_name=? AND relationType=? AND blocked=1').get(r.from, r.to, r.relationType)) continue;
        this.db.prepare('INSERT INTO relations(from_name,to_name,relationType,legacy) VALUES (?,?,?,1) ON CONFLICT DO UPDATE SET legacy=1').run(r.from, r.to, r.relationType);
      }
      this.db.prepare("INSERT INTO meta VALUES ('legacy_digest',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(hash);
      return { unchanged: false, entities: graph.entities.length, observations: graph.entities.reduce((n, e) => n + e.observations.length, 0) };
    });
  }
}
