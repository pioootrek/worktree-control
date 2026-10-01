import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export const SUPPORTED_SCHEMA_VERSION = 28;
// Versions 1–27 predate checksums. NULL means provenance was not recorded,
// including when these frozen transformations run during a later upgrade.
export const registryMigration = {
  version: 28,
  name: "record-migration-provenance",
  sql: `ALTER TABLE schema_migrations ADD COLUMN name TEXT;
ALTER TABLE schema_migrations ADD COLUMN checksum TEXT;`,
};
export const registryChecksum = createHash("sha256")
  .update(`${registryMigration.version}\0${registryMigration.name}\0${registryMigration.sql}`).digest("hex");

export function applyRegistryMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version = 28").get()) return;
  database.transaction(() => {
    database.exec(registryMigration.sql);
    database.prepare("INSERT INTO schema_migrations(version, applied_at, name, checksum) VALUES (?, ?, ?, ?)")
      .run(registryMigration.version, new Date().toISOString(), registryMigration.name, registryChecksum);
  })();
}
