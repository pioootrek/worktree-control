import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export const testPresetTimeoutMigration = {
  version: 31,
  name: "project-test-preset-timeouts",
  sql: "ALTER TABLE projects ADD COLUMN test_preset_timeouts_json TEXT NOT NULL DEFAULT '{}'",
};
export const testPresetTimeoutChecksum = createHash("sha256")
  .update(`${testPresetTimeoutMigration.version}\0${testPresetTimeoutMigration.name}\0${testPresetTimeoutMigration.sql}`).digest("hex");

export function applyTestPresetTimeoutMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=31").get()) return;
  // The ordered schema transaction owns this connection and validates before commit.
  const columns = database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === "test_preset_timeouts_json")) database.exec(testPresetTimeoutMigration.sql);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(31,?,?,?)")
    .run(new Date().toISOString(), testPresetTimeoutMigration.name, testPresetTimeoutChecksum);
}
