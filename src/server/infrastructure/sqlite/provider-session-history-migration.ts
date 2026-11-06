import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { rebuildTable } from "./verification-project-migration";

const before = "CHECK(authentication_method IN ('owner_session', 'agent_token', 'worker_token', 'installation_token', 'none'))";
const after = "CHECK(authentication_method IN ('owner_session', 'agent_token', 'worker_token', 'installation_token', 'none', 'provider_session'))";
/** Only honest audit attribution changes. Provider storage revision remains 1; no identity/grant backfill. */
export const providerSessionHistoryMigration = {
  version: 39,
  name: "provider-session-knowledge-history",
  sql: `knowledge_history: ${before} -> ${after}; preserve AUTOINCREMENT watermark`,
};
export const providerSessionHistoryChecksum = createHash("sha256")
  .update(`${providerSessionHistoryMigration.version}\0${providerSessionHistoryMigration.name}\0${providerSessionHistoryMigration.sql}`).digest("hex");

/** Joins the sole owner's ordered schema transaction; preserves rows, IDs, indexes and prior methods. */
export function applyProviderSessionHistoryMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=39").get()) return;
  if (!database.inTransaction || database.pragma("foreign_keys", { simple: true })) throw new Error("Migration 39 requires the ordered schema transaction with FK enforcement disabled.");
  const sequence = database.prepare("SELECT seq FROM sqlite_sequence WHERE name='knowledge_history'").get() as { seq: number } | undefined;
  rebuildTable(database, "knowledge_history", before, after);
  if (sequence) {
    const updated = database.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name='knowledge_history'").run(sequence.seq);
    if (!updated.changes) database.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('knowledge_history',?)").run(sequence.seq);
  }
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(?,?,?,?)")
    .run(providerSessionHistoryMigration.version, new Date().toISOString(), providerSessionHistoryMigration.name, providerSessionHistoryChecksum);
}
