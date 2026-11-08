import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/** Additive, empty membership aggregate. No principal, credential or role backfill. */
export const runtimeMembershipMigration = {
  version: 45, name: "human-runtime-memberships",
  sql: `CREATE TABLE runtime_human_memberships (
  principal_id TEXT NOT NULL REFERENCES remote_principals(id),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK(scope_kind='runtime-project'),
  role TEXT NOT NULL CHECK(role='reader'),
  permissions_json TEXT NOT NULL CHECK(permissions_json='["projects:read"]'),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(principal_id,project_id)
);`,
};
export const runtimeMembershipChecksum = createHash("sha256")
  .update(`${runtimeMembershipMigration.version}\0${runtimeMembershipMigration.name}\0${runtimeMembershipMigration.sql}`).digest("hex");
export function applyRuntimeMembershipMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=45").get()) return;
  database.exec(runtimeMembershipMigration.sql);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(?,?,?,?)")
    .run(45, new Date().toISOString(), runtimeMembershipMigration.name, runtimeMembershipChecksum);
}
