import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { TestSummaryQueries } from "./test-summary-queries";
import { mapTestRun, type TestRunRow } from "./test-run-queries";

export const telemetryMigration = {
  version: 29,
  name: "test-run-phase-summary-history",
  sql: `ALTER TABLE test_runs ADD COLUMN telemetry_json TEXT;
CREATE TABLE IF NOT EXISTS test_run_summaries (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  queued_at TEXT NOT NULL,
  terminal INTEGER NOT NULL CHECK(terminal IN (0,1)),
  bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= 8192),
  summary_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS test_summaries_project_history ON test_run_summaries(project_id,queued_at,run_id);
CREATE INDEX IF NOT EXISTS test_summaries_terminal_history ON test_run_summaries(terminal,queued_at,run_id);
CREATE TABLE IF NOT EXISTS test_summary_coverage (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  records INTEGER NOT NULL CHECK(records >= 0),
  bytes INTEGER NOT NULL CHECK(bytes >= 0),
  evicted INTEGER NOT NULL DEFAULT 0 CHECK(evicted >= 0),
  last_pruned_at TEXT
);`,
};
export const telemetryChecksum = createHash("sha256").update(`${telemetryMigration.version}\0${telemetryMigration.name}\0${telemetryMigration.sql}`).digest("hex");

export function applyTelemetryMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=29").get()) return;
  // The enclosing ordered migration transaction also owns backfill and provenance.
  const columns = database.prepare("PRAGMA table_info(test_runs)").all() as Array<{ name: string }>;
  const sql = columns.some(c => c.name === "telemetry_json") ? telemetryMigration.sql.slice(telemetryMigration.sql.indexOf("CREATE TABLE")) : telemetryMigration.sql;
  database.exec(sql);
  const summaries = new TestSummaryQueries(database);
  // Historical details are already capped at 50/project. No inferred durations.
  let cursor: string | null = null;
  while (true) {
    const rows = (cursor === null
      ? database.prepare("SELECT * FROM test_runs ORDER BY id LIMIT 64").all()
      : database.prepare("SELECT * FROM test_runs WHERE id>? ORDER BY id LIMIT 64").all(cursor)) as TestRunRow[];
    if (!rows.length) break;
    for (const row of rows) summaries.save(mapTestRun(row));
    cursor = rows[rows.length - 1].id;
  }
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(29,?,?,?)")
    .run(new Date().toISOString(), telemetryMigration.name, telemetryChecksum);
}
