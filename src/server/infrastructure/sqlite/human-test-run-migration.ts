import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/** Human job attribution is separate from machine credentials; no rights/history backfill. */
export const humanTestRunMigration = {
  version: 47, name: "provider-bound-human-test-runs",
  sql: `CREATE TABLE runtime_human_memberships_v47 (
  principal_id TEXT NOT NULL REFERENCES remote_principals(id),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK(scope_kind='runtime-project'),
  role TEXT NOT NULL CHECK(role IN ('reader','operator')),
  permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json) AND json_type(permissions_json)='array'
    AND json_array_length(permissions_json) BETWEEN 1 AND 4
    AND (role='operator' OR permissions_json='["projects:read"]')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(principal_id,project_id)
);
INSERT INTO runtime_human_memberships_v47 SELECT * FROM runtime_human_memberships;
DROP TABLE runtime_human_memberships;
ALTER TABLE runtime_human_memberships_v47 RENAME TO runtime_human_memberships;
ALTER TABLE test_runs ADD COLUMN provider_bound INTEGER NOT NULL DEFAULT 0 CHECK(provider_bound IN (0,1));
CREATE TABLE human_test_run_requesters (
  run_id TEXT PRIMARY KEY REFERENCES test_runs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES remote_principals(id),
  session_owner TEXT NOT NULL CHECK(length(session_owner) BETWEEN 1 AND 160),
  authority_json TEXT NOT NULL CHECK(json_valid(authority_json)),
  reference_json TEXT NOT NULL CHECK(json_valid(reference_json)),
  reservation_id TEXT,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64)
);
CREATE TABLE human_test_run_intents (
  principal_id TEXT NOT NULL REFERENCES remote_principals(id),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 120),
  session_key TEXT NOT NULL CHECK(length(session_key)=64),
  run_id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
  retain_until TEXT NOT NULL,
  PRIMARY KEY(principal_id,idempotency_key)
);`,
};
export const humanTestRunChecksum = createHash("sha256")
  .update(`${humanTestRunMigration.version}\0${humanTestRunMigration.name}\0${humanTestRunMigration.sql}`).digest("hex");
export function applyHumanTestRunMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=47").get()) return;
  database.exec(humanTestRunMigration.sql);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(47,?,?,?)")
    .run(new Date().toISOString(), humanTestRunMigration.name, humanTestRunChecksum);
}
