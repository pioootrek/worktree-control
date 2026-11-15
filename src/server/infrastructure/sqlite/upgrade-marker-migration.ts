import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Provisional step 50 (integration branch): the explicit upgrade marker. It is
 * applied and recognised only with an explicit schema target of 50; the
 * supported version stays 49 until a later pull request activates it, and this
 * step may still change until the release candidate.
 *
 * `complete` on a fresh installation; `pending` on a database migrated from an
 * earlier schema, and again after `auth fence resume` (the quarantine). Who can
 * set it to `complete` skips the data upgrade, so the table is fenced like the
 * schema-49 authority tables.
 */
export const UPGRADE_MARKER_VERSION = 50;
/** Fence coverage added by step 50. The frozen schema-49 list is not extended. */
export const UPGRADE_MARKER_SECURITY_TABLES = ["upgrade_marker"] as const;
export const upgradeMarkerTriggers = UPGRADE_MARKER_SECURITY_TABLES.flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(event => ({
  name: `security_${table}_${event.toLowerCase()}`,
  sql: `CREATE TRIGGER security_${table}_${event.toLowerCase()} BEFORE ${event} ON ${table} BEGIN SELECT worktree_security_pending(); UPDATE security_checkpoint SET epoch=lower(hex(randomblob(32))) WHERE singleton=1; END`,
})));
const table = `CREATE TABLE upgrade_marker (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  state TEXT NOT NULL CHECK(state IN ('pending','complete')),
  changed_at TEXT NOT NULL
)`;
/** The only part that differs between a fresh and a migrated database is the bound state. */
const initialRow = "INSERT INTO upgrade_marker(singleton,state,changed_at) VALUES(1,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
/**
 * `sql` is the complete text the step executes, in order, and the checksum
 * covers it. It is never executed as one script: the initial row binds its state.
 */
export const upgradeMarkerMigration = {
  version: UPGRADE_MARKER_VERSION, name: "explicit-upgrade-marker",
  sql: `${table};
${initialRow};
${upgradeMarkerTriggers.map(trigger => `${trigger.sql};`).join("\n")}`,
};
export const upgradeMarkerChecksum = createHash("sha256")
  .update(`${upgradeMarkerMigration.version}\0${upgradeMarkerMigration.name}\0${upgradeMarkerMigration.sql}`).digest("hex");

/**
 * Safe in ordinary startup, where the schema runs before the fence registers
 * `worktree_security_pending`: the initial row is written before the table's
 * triggers exist, and the step writes no row of an already fenced table (only
 * `upgrade_marker` itself and `schema_migrations`, which is not fenced).
 *
 * `fresh` is true only when the schema transaction began on an empty database.
 */
export function applyUpgradeMarkerMigration(database: Database.Database, fresh: boolean): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=50").get()) return;
  database.exec(table);
  database.prepare(initialRow).run(fresh ? "complete" : "pending");
  for (const trigger of upgradeMarkerTriggers) database.exec(trigger.sql);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(50,?,?,?)")
    .run(new Date().toISOString(), upgradeMarkerMigration.name, upgradeMarkerChecksum);
}
