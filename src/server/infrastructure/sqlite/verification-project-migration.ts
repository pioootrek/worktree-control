import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

const constraints = [
  ["projects", "CHECK(launch_preset IN ('auto', 'node', 'django'))", "CHECK(launch_preset IN ('auto', 'node', 'django', 'none'))"],
  ["test_runs", "CHECK(adapter IN ('node', 'django'))", "CHECK(adapter IN ('node', 'django', 'godot'))"],
] as const;

export const verificationProjectMigration = {
  version: 30,
  name: "verification-only-projects-and-godot",
  // Freeze the ordered replacements as the provenance of this data-preserving rebuild.
  sql: JSON.stringify(constraints),
};
export const verificationProjectChecksum = createHash("sha256")
  .update(`${verificationProjectMigration.version}\0${verificationProjectMigration.name}\0${verificationProjectMigration.sql}`).digest("hex");

export function applyVerificationProjectMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=30").get()) return;
  // initializeSchema owns the sole connection, enclosing transaction and FK validation.
  if (!database.inTransaction || database.pragma("foreign_keys", { simple: true })) throw new Error("Migration 30 requires the ordered schema transaction with FK enforcement disabled.");
  for (const [table, from, to] of constraints) rebuildTable(database, table, from, to);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(30,?,?,?)")
    .run(new Date().toISOString(), verificationProjectMigration.name, verificationProjectChecksum);
}

/** Replaces one table constraint; skips tables already carrying it so repaired migration records can rerun safely. */
export function rebuildTable(database: Database.Database, table: string, from: string, to: string): void {
  const current = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
  if (!current) throw new Error(`Missing table ${table}.`);
  if (current.sql.includes(to)) return;
  if (!current.sql.includes(from)) throw new Error(`Unexpected ${table} definition; refusing to rebuild it.`);
  const next = current.sql.replace(from, to);
  const indexes = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
    .all(table) as Array<{ sql: string }>;
  const replacement = `${table}_rebuild`;
  database.exec(next.replace(/^CREATE TABLE (?:IF NOT EXISTS )?"?\w+"?/, `CREATE TABLE ${replacement}`));
  database.exec(`
    INSERT INTO ${replacement} SELECT * FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE ${replacement} RENAME TO ${table};
  `);
  for (const index of indexes) database.exec(index.sql);
}
