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
  // Scoped leases bind both principal and credential; older and human leases bind neither.
  if (version >= 36 && database.prepare(`SELECT 1 FROM reservations WHERE (principal_id IS NULL) <> (credential_id IS NULL)
    OR (principal_id IS NOT NULL AND kind <> 'agent') LIMIT 1`).get()) fail("lease binding");
  if (version >= 37 && database.prepare("SELECT 1 FROM projects WHERE typeof(configuration_revision) <> 'integer' OR configuration_revision < 0 LIMIT 1").get()) fail("configuration revision");
  // Historical provider mappings remain owner-only; ordinary humans begin at schema 42.
  if (version >= 38 && database.prepare(`SELECT 1 FROM authentication_provider_subjects s
    JOIN remote_principals p ON p.id=s.principal_id WHERE ${version >= 42 ? "p.kind NOT IN ('owner','human')" : "p.kind<>'owner'"} LIMIT 1`).get()) fail("provider subject principal");
  if (version >= 42 && database.prepare(`SELECT 1 FROM principal_credentials c JOIN remote_principals p ON p.id=c.principal_id
    WHERE (c.kind='owner_session' AND p.kind<>'owner') OR (c.kind='agent_token' AND p.kind<>'agent')
      OR (c.kind='worker_token' AND p.kind<>'worker') LIMIT 1`).get()) fail("credential principal kind");
  if (version >= 45 && database.prepare(`SELECT 1 FROM runtime_human_memberships m
    JOIN remote_principals p ON p.id=m.principal_id WHERE p.kind NOT IN ('owner','human') LIMIT 1`).get()) fail("runtime membership principal");
  // Evidence and trust describe one provider account. Selected-protection flags are
  // checked per account at every decision, so one inconsistent row refuses only itself.
  if (version >= 40 && database.prepare(`SELECT 1 FROM authentication_session_evidence e
    JOIN "authentication_ba_session" s ON s."id"=e.session_id WHERE s."userId"<>e.subject LIMIT 1`).get()) fail("session evidence subject");
  if (version >= 40 && database.prepare(`SELECT 1 FROM authentication_passkey_trust t
    JOIN "authentication_ba_passkey" c ON c."id"=t.native_id WHERE c."userId"<>t.subject OR c."credentialID"<>t.credential_id LIMIT 1`).get()) fail("passkey trust subject");
  // A marker never authorizes, but malformed state must not reach destructive recovery. A native
  // row without a marker is unclassified and valid; only a marker makes a claim to check here.
  if (version >= 41 && database.prepare(`SELECT 1 FROM authentication_session_issuance i
    LEFT JOIN authentication_session_evidence e ON e.session_id=i.session_id
    LEFT JOIN "authentication_ba_session" s ON s."id"=i.session_id
    WHERE i.state NOT IN ('pending','may_publish') OR e.session_id IS NULL OR s."id" IS NULL OR e.original_deadline<>i.original_deadline
      OR i.original_deadline IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',i.original_deadline) LIMIT 1`).get()) fail("session issuance");
  if (version >= 44 && database.prepare(`SELECT 1 FROM test_run_requesters b
    JOIN test_runs r ON r.id=b.run_id JOIN principal_credentials c ON c.id=b.credential_id
    JOIN remote_principals p ON p.id=b.principal_id
    WHERE r.project_id<>b.project_id OR r.actor<>b.session_owner OR c.principal_id<>b.principal_id
      OR c.kind<>'agent_token' OR p.kind<>'agent' LIMIT 1`).get()) fail("test requester binding");
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
