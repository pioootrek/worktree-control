import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

// Knowledge task state owns version 33; the vault follows it in the same schema transaction.
export const devVaultMigration = {
  version: 34,
  name: "encrypted-dev-environment-vault",
  sql: `CREATE TABLE IF NOT EXISTS dev_environment_vaults (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
    version INTEGER NOT NULL CHECK(version > 0),
    ciphertext TEXT NOT NULL CHECK(length(ciphertext) BETWEEN 40 AND 5700000)
  )`,
};
export const devVaultChecksum = createHash("sha256")
  .update(`${devVaultMigration.version}\0${devVaultMigration.name}\0${devVaultMigration.sql}`).digest("hex");

export function applyDevVaultMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(devVaultMigration.version)) return;
  database.exec(devVaultMigration.sql);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(?,?,?,?)")
    .run(devVaultMigration.version, new Date().toISOString(), devVaultMigration.name, devVaultChecksum);
}
