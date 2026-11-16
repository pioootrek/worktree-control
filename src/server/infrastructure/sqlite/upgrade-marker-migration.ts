import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { schemaTarget } from "./migration-registry";

/**
 * Step 50: the explicit upgrade marker, applied by the default target (the
 * supported version) and by an explicit target of 50 or more. It may still
 * change until the release candidate; a database migrated by an unreleased
 * build is disposable. The ordinary admission check (`ordinary-admission.ts`)
 * admits a database only when its marker is `complete`.
 *
 * `complete` on a fresh installation; `pending` on a database migrated from an
 * earlier schema, and again after `auth fence resume` (the quarantine). Who can
 * set it to `complete` skips the data upgrade, so the table is fenced like the
 * schema-49 authority tables.
 *
 * `plan_hash` is the hash of the upgrade plan whose apply set the marker to
 * `complete` (see `upgrade-maintenance.ts`), so a repeated apply can answer
 * "already applied" after the plan file is gone. `pending` has none; a
 * `complete` without one is a fresh installation, which never needed a plan.
 * The quarantine clears it together with setting `pending`.
 *
 * SQLite's text `length` and `GLOB` stop at the first NUL character, so the
 * CHECK also bounds the stored bytes: 64 characters in 64 bytes are 64 ASCII
 * characters with no NUL, which `GLOB` then limits to lowercase hex, as
 * `validateDatabase` requires.
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
  changed_at TEXT NOT NULL,
  plan_hash TEXT CHECK(plan_hash IS NULL OR (typeof(plan_hash)='text' AND length(plan_hash)=64 AND length(CAST(plan_hash AS BLOB))=64 AND NOT plan_hash GLOB '*[^0-9a-f]*')),
  CHECK(state='complete' OR plan_hash IS NULL)
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
  // A direct call checks the step against the supported version, as initializeSchema's target does.
  schemaTarget(UPGRADE_MARKER_VERSION);
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=50").get()) return;
  database.exec(table);
  database.prepare(initialRow).run(fresh ? "complete" : "pending");
  for (const trigger of upgradeMarkerTriggers) database.exec(trigger.sql);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(50,?,?,?)")
    .run(new Date().toISOString(), upgradeMarkerMigration.name, upgradeMarkerChecksum);
}
