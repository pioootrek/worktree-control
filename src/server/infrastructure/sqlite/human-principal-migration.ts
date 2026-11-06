import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { rebuildTable } from "./verification-project-migration";

const from = "CHECK(kind IN ('owner', 'agent', 'worker', 'installation'))";
const to = "CHECK(kind IN ('owner', 'agent', 'worker', 'installation', 'human'))";
export const humanPrincipalMigration = {
  version: 42, name: "ordinary-human-principals", sql: JSON.stringify([["remote_principals", from, to]]),
};
export const humanPrincipalChecksum = createHash("sha256")
  .update(`${humanPrincipalMigration.version}\0${humanPrincipalMigration.name}\0${humanPrincipalMigration.sql}`).digest("hex");

export function applyHumanPrincipalMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=42").get()) return;
  if (!database.inTransaction || database.pragma("foreign_keys", { simple: true })) throw new Error("Migration 42 requires the ordered schema transaction with FK enforcement disabled.");
  rebuildTable(database, "remote_principals", from, to);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(42,?,?,?)")
    .run(new Date().toISOString(), humanPrincipalMigration.name, humanPrincipalChecksum);
}
