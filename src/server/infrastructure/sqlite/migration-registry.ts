import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export const SUPPORTED_SCHEMA_VERSION = 49;
/**
 * Highest schema step this code knows. Steps above SUPPORTED_SCHEMA_VERSION are
 * provisional (integration branch only) and apply or are recognised only where a
 * caller passes an explicit target; every default stays SUPPORTED_SCHEMA_VERSION.
 * Activation raises SUPPORTED_SCHEMA_VERSION; no call site changes.
 */
export const PROVISIONAL_SCHEMA_VERSION = 50;

/** A schema target or recognition ceiling: from the supported version up to the provisional one. */
export function schemaTarget(target: number = SUPPORTED_SCHEMA_VERSION): number {
  if (!Number.isSafeInteger(target) || target < SUPPORTED_SCHEMA_VERSION || target > PROVISIONAL_SCHEMA_VERSION) throw new Error("Unsupported schema target.");
  return target;
}
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
