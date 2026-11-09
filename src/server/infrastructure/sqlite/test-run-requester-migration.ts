import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/** No backfill: retained compatibility jobs cannot become scoped-agent jobs. */
export const testRunRequesterMigration = {
  version: 44,
  name: "test-run-requester",
  sql: `CREATE TABLE test_run_requesters (
  run_id TEXT NOT NULL PRIMARY KEY REFERENCES test_runs(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES remote_principals(id),
  credential_id TEXT NOT NULL REFERENCES principal_credentials(id),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_owner TEXT NOT NULL CHECK(length(session_owner) BETWEEN 11 AND 512 AND session_owner LIKE 'agent:mcp:%'),
  reservation_id TEXT,
  lease_token_hash TEXT,
  CHECK((reservation_id IS NULL AND lease_token_hash IS NULL) OR
    (reservation_id IS NOT NULL AND length(reservation_id) BETWEEN 1 AND 160 AND
     lease_token_hash IS NOT NULL AND length(lease_token_hash)=64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*'))
);`,
};
export const testRunRequesterChecksum = createHash("sha256")
  .update(`${testRunRequesterMigration.version}\0${testRunRequesterMigration.name}\0${testRunRequesterMigration.sql}`).digest("hex");

export function applyTestRunRequesterMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=44").get()) return;
  database.exec(testRunRequesterMigration.sql);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(?,?,?,?)")
    .run(44, new Date().toISOString(), testRunRequesterMigration.name, testRunRequesterChecksum);
}
