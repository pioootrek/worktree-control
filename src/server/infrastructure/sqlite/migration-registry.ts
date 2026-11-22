import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
/**
 * What this release creates and runs: the default schema target and
 * recognition ceiling, and the highest step this code knows. An ordinary
 * opening of the store admits only a database at this version with a complete
 * upgrade marker (`ordinary-admission.ts`); an older one goes through the
 * explicit offline upgrade.
 */
export const SUPPORTED_SCHEMA_VERSION = 53;
/**
 * The schema the security fence was introduced at (step 49, a released fact
 * that never moves): the lowest source the explicit upgrade accepts and the
 * lowest explicit schema target or recognition ceiling. A comparison that
 * means "the fence's base" uses this constant, one that means "the version
 * this release runs" uses SUPPORTED_SCHEMA_VERSION.
 */
export const SECURITY_FENCE_SCHEMA_VERSION = 49;

/**
 * A schema target or recognition ceiling: from the fence base up to the
 * supported version; an omitted target is the supported version. Every target
 * and ceiling passes through here, so a value above SUPPORTED_SCHEMA_VERSION is
 * refused whichever alias, re-export or wrapper passed it. Explicit lower
 * targets (49 to 52) remain for the steps themselves and for versioned
 * fixtures and snapshots.
 */
export function schemaTarget(target?: number): number {
  // Only an omitted target takes the default, as a default parameter would.
  const value = target === undefined ? SUPPORTED_SCHEMA_VERSION : target;
  if (!Number.isSafeInteger(value) || value < SECURITY_FENCE_SCHEMA_VERSION || value > SUPPORTED_SCHEMA_VERSION) throw new Error("Unsupported schema target.");
  return value;
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
