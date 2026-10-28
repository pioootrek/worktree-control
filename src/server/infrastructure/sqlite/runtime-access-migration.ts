import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Additive: no delegation or credential ceiling is backfilled, so existing
 * agent tokens keep no runtime access. Existing leases keep a NULL binding.
 * Registered-project deletion cascades to both runtime-access tables.
 */
export const runtimeAccessMigration = {
  version: 36,
  name: "scoped-agent-runtime-access",
  sql: `CREATE TABLE IF NOT EXISTS runtime_delegations (
    principal_id TEXT NOT NULL REFERENCES remote_principals(id) ON DELETE RESTRICT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    sponsor_id TEXT NOT NULL REFERENCES remote_principals(id) ON DELETE RESTRICT,
    actions_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    expires_at TEXT,
    updated_at TEXT NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY(principal_id, project_id)
  );
  CREATE TABLE IF NOT EXISTS runtime_credential_scopes (
    credential_id TEXT NOT NULL REFERENCES principal_credentials(id) ON DELETE RESTRICT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    actions_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(credential_id, project_id)
  );
  ALTER TABLE reservations ADD COLUMN principal_id TEXT REFERENCES remote_principals(id);
  ALTER TABLE reservations ADD COLUMN credential_id TEXT REFERENCES principal_credentials(id);`,
};
export const runtimeAccessChecksum = createHash("sha256")
  .update(`${runtimeAccessMigration.version}\0${runtimeAccessMigration.name}\0${runtimeAccessMigration.sql}`).digest("hex");

/** Runs inside the schema owner's transaction after migration 35. */
export function applyRuntimeAccessMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(runtimeAccessMigration.version)) return;
  const columns = new Set((database.prepare("PRAGMA table_info(reservations)").all() as Array<{ name: string }>).map(({ name }) => name));
  // The checksum covers the canonical SQL; a column already present (re-applied lineage) is not added twice.
  for (const statement of runtimeAccessMigration.sql.split(";").map(part => part.trim()).filter(Boolean)) {
    const added = /^ALTER TABLE reservations ADD COLUMN (\w+)/.exec(statement)?.[1];
    if (!added || !columns.has(added)) database.exec(statement);
  }
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(?,?,?,?)")
    .run(runtimeAccessMigration.version, new Date().toISOString(), runtimeAccessMigration.name, runtimeAccessChecksum);
}
