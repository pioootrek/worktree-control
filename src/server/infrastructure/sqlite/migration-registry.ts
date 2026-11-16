import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { provisionalSchemaEnabled } from "./provisional-schema-gate";

/**
 * What this release creates by default and the default schema target and
 * recognition ceiling: the version this release runs. The activation raises it.
 */
export const SUPPORTED_SCHEMA_VERSION = 49;
/**
 * The schema the security fence was introduced at (step 49, a released fact
 * that never moves): the lowest source the explicit upgrade accepts and the
 * lowest explicit schema target or recognition ceiling. It equals
 * SUPPORTED_SCHEMA_VERSION only until the activation raises the latter; a
 * comparison that means "the fence's base" uses this constant, one that means
 * "the version this release runs" uses SUPPORTED_SCHEMA_VERSION.
 */
export const SECURITY_FENCE_SCHEMA_VERSION = 49;
/**
 * Highest schema step this code knows. Steps above SUPPORTED_SCHEMA_VERSION are
 * provisional (integration branch only): they apply or are recognised only with
 * an explicit target AND the process-wide switch of `provisional-schema-gate.ts`
 * turned on, which only tests do. Every default stays SUPPORTED_SCHEMA_VERSION.
 * Activation raises SUPPORTED_SCHEMA_VERSION; no call site changes.
 */
export const PROVISIONAL_SCHEMA_VERSION = 52;

/** The bounds of {@link schemaTarget}; see {@link schemaTargetRange}. */
export interface SchemaTargetRange { lowest: number; highest: number; fallback: number }
/**
 * The bounds {@link schemaTarget} checks against, for a supported version and
 * the state of the provisional switch: from the fence base to the supported
 * version, or to the provisional one while the switch is on; an omitted target
 * is the supported version. Only bounds, never a check: production code
 * validates a target through `schemaTarget` alone, which passes the module's
 * own supported version and switch. Tests pass a higher supported version to
 * show that the lower bound is the fence base, not the supported version.
 */
export function schemaTargetRange(supported: number, provisional: boolean): SchemaTargetRange {
  return { lowest: SECURITY_FENCE_SCHEMA_VERSION, highest: provisional ? PROVISIONAL_SCHEMA_VERSION : supported, fallback: supported };
}

/**
 * A schema target or recognition ceiling: from the fence base up to the
 * supported version, or the provisional one while the switch is on. Every
 * target and ceiling passes through here, so a value above
 * SUPPORTED_SCHEMA_VERSION is refused while the provisional switch is off,
 * whichever alias, re-export or wrapper passed it.
 */
export function schemaTarget(target?: number): number {
  const range = schemaTargetRange(SUPPORTED_SCHEMA_VERSION, provisionalSchemaEnabled());
  // Only an omitted target takes the default, as a default parameter would.
  const value = target === undefined ? range.fallback : target;
  if (!Number.isSafeInteger(value) || value < range.lowest || value > range.highest) throw new Error("Unsupported schema target.");
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
