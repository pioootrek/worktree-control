import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { rebuildTable } from "./verification-project-migration";

const launchPresetConstraint = [
  "CHECK(launch_preset IN ('auto', 'node', 'django', 'none'))",
  "CHECK(launch_preset IN ('auto', 'node', 'django', 'none', 'godot-web'))",
] as const;
const configurationColumn = "ALTER TABLE projects ADD COLUMN godot_web_json TEXT";

export const godotWebMigration = {
  version: 35,
  name: "godot-web-runtime-preset",
  // Freeze the constraint replacement and added column as this migration's provenance.
  sql: JSON.stringify([launchPresetConstraint, configurationColumn]),
};
export const godotWebChecksum = createHash("sha256")
  .update(`${godotWebMigration.version}\0${godotWebMigration.name}\0${godotWebMigration.sql}`).digest("hex");

/** Explicit opt-in only: existing rows keep their preset and a NULL configuration. */
export function applyGodotWebMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(godotWebMigration.version)) return;
  // initializeSchema owns the sole connection, enclosing transaction and FK validation.
  if (!database.inTransaction || database.pragma("foreign_keys", { simple: true })) throw new Error("Migration 35 requires the ordered schema transaction with FK enforcement disabled.");
  rebuildTable(database, "projects", launchPresetConstraint[0], launchPresetConstraint[1]);
  const columns = database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === "godot_web_json")) database.exec(configurationColumn);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(?,?,?,?)")
    .run(godotWebMigration.version, new Date().toISOString(), godotWebMigration.name, godotWebChecksum);
}
