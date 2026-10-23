import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export const remoteConnectionMigration = {
  version: 32, name: "connected-remote-verification",
  sql: `CREATE TABLE IF NOT EXISTS remote_verification_cancellations (
    request_id TEXT PRIMARY KEY REFERENCES remote_verification_requests(id), requested_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS remote_verification_reports (
    attempt_id TEXT NOT NULL REFERENCES remote_verification_attempts(id), sequence INTEGER NOT NULL,
    payload_json TEXT NOT NULL, PRIMARY KEY(attempt_id, sequence)
  );
  CREATE TABLE IF NOT EXISTS remote_worker_receipts (
    attempt_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL
  );`,
};
export const remoteConnectionChecksum = createHash("sha256")
  .update(`${remoteConnectionMigration.version}\0${remoteConnectionMigration.name}\0${remoteConnectionMigration.sql}`).digest("hex");
export function applyRemoteConnectionMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=32").get()) return;
  database.exec(remoteConnectionMigration.sql);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(32,?,?,?)")
    .run(new Date().toISOString(), remoteConnectionMigration.name, remoteConnectionChecksum);
}
