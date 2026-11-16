import type Database from "better-sqlite3";
import { schemaTarget } from "./migration-registry";
import { SecurityFence } from "./security-fence";
import { validateDatabase } from "./database-validation";
import { UpgradeError } from "./upgrade-contract";
import { readUpgradeMarker, upgradeState } from "./upgrade-state";

/**
 * The admission check of an ordinary opening of the store. Its one caller is
 * the constructor of `OwnedSqliteDatabase` opened with `ordinary: true`, after
 * ownership inspected the database read-only and before anything enables
 * writes, migrates, attaches the fence or copies the database. Every store
 * (`SqliteStateStore`) and the read-only remote recovery inspection open their
 * database that way; maintenance openings (fence maintenance, the upgrade,
 * backup creation, snapshot verification and restore) do not.
 */

/**
 * What the check reads: the canonical database path, the read-only inspection
 * connection and its schema inspection, as `OwnedSqliteDatabase` holds them in
 * its constructor (which already ran `validateDatabase` at that version).
 */
export interface OrdinaryAdmissionSource {
  readonly canonicalPath: string;
  readonly database: Database.Database;
  readonly inspection: { readonly version: number; readonly fresh: boolean };
}

/**
 * Admits the database to ordinary access at `target` (default: the supported
 * version, validated by `schemaTarget`) or throws. Read-only: it writes
 * nothing, does not hash the database or its WAL, and neither plans nor reads
 * nor writes an upgrade plan.
 *
 * 1. Fence trust first, by `SecurityFence.inspect` (the store's own check): its
 *    refusals (`security_fence_establishment_required`,
 *    `security_fence_recovery_required`) surface unchanged, so a fence problem
 *    always wins and a database rolled back in place goes to recovery, never to
 *    the upgrade. A fresh, initialising database the fence accepts is admitted:
 *    the store creates it at the target.
 * 2. Then the schema version must equal the target and, from step 50 on, the
 *    upgrade marker must be `complete` (the state `current` of
 *    `upgrade-state.ts`); otherwise `upgrade_required`. A database from step 50
 *    on without a marker row is corrupt, not one that needs the upgrade: it gets
 *    `validateDatabase`'s own refusal, which ownership already gave when it
 *    opened the database.
 */
export function assertOrdinaryAdmission(source: OrdinaryAdmissionSource, target?: number): void {
  const version = schemaTarget(target);
  const { canonicalPath, database, inspection } = source;
  SecurityFence.inspect(canonicalPath, database, inspection.fresh);
  if (inspection.fresh) return;
  let { marker } = readUpgradeMarker(database, inspection.version);
  if (marker === "absent" && inspection.version >= 50) {
    validateDatabase(database, inspection.version);
    ({ marker } = readUpgradeMarker(database, inspection.version));
  }
  // The fence admitted it above: only the marker and the version decide now.
  if (upgradeState({ trusted: true, establishmentAllowed: false }, marker, inspection.version, version) !== "current") {
    throw new UpgradeError("upgrade_required", "upgrade inspect", false, "upgrade_needed");
  }
}
