import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/** Expand explicit human actions without backfill; share the existing bounded intent ledger. */
export const humanConfigurationMigration = {
  version: 48, name: "provider-bound-human-configuration",
  sql: `CREATE TABLE runtime_human_memberships_v48 (
  principal_id TEXT NOT NULL REFERENCES remote_principals(id),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK(scope_kind='runtime-project'),
  role TEXT NOT NULL CHECK(role IN ('reader','operator')),
  permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json) AND json_type(permissions_json)='array'
    AND json_array_length(permissions_json) BETWEEN 1 AND 6
    AND (role='operator' OR permissions_json='["projects:read"]')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(principal_id,project_id)
);
INSERT INTO runtime_human_memberships_v48 SELECT * FROM runtime_human_memberships;
DROP TABLE runtime_human_memberships;
ALTER TABLE runtime_human_memberships_v48 RENAME TO runtime_human_memberships;
ALTER TABLE human_runtime_intents ADD COLUMN configuration_bound INTEGER NOT NULL DEFAULT 0 CHECK(configuration_bound IN (0,1));
ALTER TABLE human_runtime_intents ADD COLUMN configuration_context_json TEXT
  CHECK(configuration_context_json IS NULL OR (json_valid(configuration_context_json) AND length(configuration_context_json)<=8192));`,
};
export const humanConfigurationChecksum = createHash("sha256")
  .update(`${humanConfigurationMigration.version}\0${humanConfigurationMigration.name}\0${humanConfigurationMigration.sql}`).digest("hex");
export function applyHumanConfigurationMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=48").get()) return;
  database.exec(humanConfigurationMigration.sql);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(48,?,?,?)")
    .run(new Date().toISOString(), humanConfigurationMigration.name, humanConfigurationChecksum);
}
