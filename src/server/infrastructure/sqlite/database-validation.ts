import type Database from "better-sqlite3";
import { AuthenticationQueries } from "./authentication-queries";

export function validateDatabase(database: Database.Database, version: number): void {
  const integrity = database.pragma("integrity_check(1)") as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new Error("SQLite integrity check failed; startup stopped.");
  if (database.prepare("PRAGMA foreign_key_check").get()) throw new Error("SQLite foreign key check failed; startup stopped.");
  const fail = (rule: string) => { throw new Error(`SQLite application invariant failed (${rule}); startup stopped.`); };
  if (version >= 4 && database.prepare(`SELECT 1 FROM reservations WHERE released_at IS NULL AND NOT (
    (kind='human' AND expires_at IS NULL AND maximum_expires_at IS NULL AND token_hash IS NULL)
    OR (kind='agent' AND expires_at IS NOT NULL AND maximum_expires_at IS NOT NULL AND token_hash IS NOT NULL AND idempotency_key IS NOT NULL)) LIMIT 1`).get()) fail("active lease");
  if (version >= 25) {
    try { new AuthenticationQueries(database).getAuthenticationPolicy(); } catch { fail("authentication policy"); }
    if (!database.prepare("SELECT 1 FROM remote_principals WHERE id='installation' AND kind='installation' AND status='active'").get()) fail("installation principal");
  }
  if (version >= 19) {
    if (database.prepare(`SELECT 1 FROM knowledge_replies r JOIN knowledge_threads t ON t.id=r.thread_id
      WHERE r.project_id<>t.project_id LIMIT 1`).get()) fail("reply project");
    const records = `SELECT 'thread' kind,id,project_id FROM knowledge_threads
      UNION ALL SELECT 'reply',id,project_id FROM knowledge_replies
      UNION ALL SELECT 'task',id,project_id FROM knowledge_tasks`;
    // Relation readers deliberately retain unavailable/foreign endpoints and hide their data.
    if (version >= 21 && database.prepare(`WITH records AS (${records} UNION ALL SELECT 'memory',id,project_id FROM knowledge_memories)
      SELECT 1 FROM knowledge_attachments a WHERE NOT EXISTS(SELECT 1 FROM records r
        WHERE r.kind=a.record_kind AND r.id=a.record_id AND r.project_id=a.project_id) LIMIT 1`).get()) fail("attachment target");
  }
  if (version >= 22 && database.prepare(`SELECT 1 FROM knowledge_import_batches WHERE cursor>total_items
    OR (status='published' AND (cursor<>total_items OR published_at IS NULL)) LIMIT 1`).get()) fail("import progress");
}

export function configureDurability(database: Database.Database): void {
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 3000");
  assertDurability(database);
}
export function assertDurability(database: Database.Database): void {
  if (database.pragma("journal_mode", { simple: true }) !== "wal"
    || database.pragma("synchronous", { simple: true }) !== 2
    || database.pragma("foreign_keys", { simple: true }) !== 1
    || database.pragma("busy_timeout", { simple: true }) !== 3000) {
    throw new Error("SQLite effective durability settings differ from WAL/FULL/FK/3000ms; startup stopped.");
  }
}
