import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Additive: every existing project starts at revision 0. Each configuration
 * write (profiles, test environments, preset timeouts, launch settings)
 * increments it in the same transaction as the change and its audit event.
 * Non-negative integers are an application invariant checked by `validateDatabase`.
 */
export const configurationRevisionMigration = {
  version: 37,
  name: "project-configuration-revision",
  sql: "ALTER TABLE projects ADD COLUMN configuration_revision INTEGER NOT NULL DEFAULT 0",
};
export const configurationRevisionChecksum = createHash("sha256")
  .update(`${configurationRevisionMigration.version}\0${configurationRevisionMigration.name}\0${configurationRevisionMigration.sql}`).digest("hex");

/** Runs inside the schema owner's transaction after migration 36. */
export function applyConfigurationRevisionMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(configurationRevisionMigration.version)) return;
  const columns = database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === "configuration_revision")) database.exec(configurationRevisionMigration.sql);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(?,?,?,?)")
    .run(configurationRevisionMigration.version, new Date().toISOString(), configurationRevisionMigration.name, configurationRevisionChecksum);
}
