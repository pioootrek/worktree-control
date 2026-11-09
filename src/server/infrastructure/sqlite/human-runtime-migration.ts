import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/** No grant backfill. Legacy reservation rows retain their exact format and authority. */
export const humanRuntimeMigration = {
  version: 46, name: "provider-bound-human-runtime",
  sql: `CREATE TABLE runtime_human_memberships_v46 (
  principal_id TEXT NOT NULL REFERENCES remote_principals(id),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK(scope_kind='runtime-project'),
  role TEXT NOT NULL CHECK(role IN ('reader','operator')),
  permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json) AND json_type(permissions_json)='array'
    AND json_array_length(permissions_json) BETWEEN 1 AND 3
    AND (role='operator' OR permissions_json='["projects:read"]')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(principal_id,project_id)
);
INSERT INTO runtime_human_memberships_v46 SELECT * FROM runtime_human_memberships;
DROP TABLE runtime_human_memberships;
ALTER TABLE runtime_human_memberships_v46 RENAME TO runtime_human_memberships;
ALTER TABLE reservations ADD COLUMN provider_bound INTEGER NOT NULL DEFAULT 0 CHECK(provider_bound IN (0,1));
CREATE TABLE human_runtime_leases (
  reservation_id TEXT PRIMARY KEY REFERENCES reservations(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES remote_principals(id),
  session_key TEXT NOT NULL CHECK(length(session_key)=64),
  evidence_key TEXT NOT NULL CHECK(length(evidence_key)=64),
  generation INTEGER NOT NULL CHECK(generation>=0),
  membership_revision INTEGER NOT NULL CHECK(membership_revision BETWEEN 1 AND 9007199254740991),
  permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
  expires_at TEXT NOT NULL,
  maximum_expires_at TEXT NOT NULL,
  session_deadline TEXT NOT NULL,
  CHECK(expires_at<=maximum_expires_at AND maximum_expires_at<=session_deadline)
);
CREATE TABLE human_runtime_intents (
  session_key TEXT NOT NULL CHECK(length(session_key)=64),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 120),
  principal_id TEXT NOT NULL REFERENCES remote_principals(id),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  membership_revision INTEGER NOT NULL CHECK(membership_revision>=1),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
  reservation_id TEXT REFERENCES reservations(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('pending','complete')),
  result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(result_json)<=8192)),
  retain_until TEXT NOT NULL,
  PRIMARY KEY(session_key,idempotency_key),
  CHECK((state='pending' AND result_json IS NULL) OR (state='complete' AND result_json IS NOT NULL))
);`,
};
export const humanRuntimeChecksum = createHash("sha256")
  .update(`${humanRuntimeMigration.version}\0${humanRuntimeMigration.name}\0${humanRuntimeMigration.sql}`).digest("hex");
export function applyHumanRuntimeMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=46").get()) return;
  database.exec(humanRuntimeMigration.sql);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(46,?,?,?)")
    .run(new Date().toISOString(), humanRuntimeMigration.name, humanRuntimeChecksum);
}
