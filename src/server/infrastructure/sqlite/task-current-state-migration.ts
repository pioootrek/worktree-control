import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export const taskCurrentStateMigration = {
  version: 33,
  name: "knowledge-task-current-state",
  sql: "ALTER TABLE knowledge_tasks ADD COLUMN current_state_json TEXT",
};
export const taskCurrentStateChecksum = createHash("sha256")
  .update(`${taskCurrentStateMigration.version}\0${taskCurrentStateMigration.name}\0${taskCurrentStateMigration.sql}`).digest("hex");

export function applyTaskCurrentStateMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=33").get()) return;
  // The ordered schema transaction owns this connection and validates before commit.
  const columns = database.prepare("PRAGMA table_info(knowledge_tasks)").all() as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === "current_state_json")) database.exec(taskCurrentStateMigration.sql);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(33,?,?,?)")
    .run(new Date().toISOString(), taskCurrentStateMigration.name, taskCurrentStateChecksum);
}
