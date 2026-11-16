import type Database from "better-sqlite3";
import type { UpgradeNextStep, UpgradeState } from "./upgrade-contract";

/**
 * The recognition of the four states of an installation's database (see
 * `docs/architecture.md`), shared by the explicit offline upgrade
 * (`upgrade-maintenance.ts`, from `SecurityFence.preflight`) and the ordinary
 * admission check (`ordinary-admission.ts`, from `SecurityFence.inspect`). Both
 * decide trust with the fence and read the marker here; neither writes.
 */

/** The marker's state: absent below step 50 and when its row is missing. */
export type UpgradeMarkerState = "absent" | "pending" | "complete";
/** The operator's next step in each state. */
export const UPGRADE_NEXT_STEP: Readonly<Record<UpgradeState, UpgradeNextStep>> = { current: "none", upgrade_needed: "upgrade apply", pre_fence: "auth fence establish", fenced: "auth fence resume" };

/**
 * The marker of a database at `schemaVersion` (read-only): none below step 50,
 * otherwise its row's state and the plan hash a `complete` marker records
 * (null on a fresh installation).
 */
export function readUpgradeMarker(database: Database.Database, schemaVersion: number): { marker: UpgradeMarkerState; appliedPlan: string | null } {
  const row = schemaVersion >= 50 ? database.prepare("SELECT state,plan_hash FROM upgrade_marker WHERE singleton=1").get() as { state: "pending" | "complete"; plan_hash: string | null } | undefined : undefined;
  return { marker: row?.state ?? "absent", appliedPlan: row?.state === "complete" ? row.plan_hash : null };
}

/**
 * The state, from the fence's verdict, the marker and the schema version.
 * `current` needs a trusted fence, the requested target reached and a
 * `complete` marker; below step 50 no database has a marker, so at such a
 * target (the released 49, which only the ordinary admission check asks for;
 * the upgrade's targets are 50 and above) the target reached suffices. A
 * trusted database below the target is `upgrade_needed` whatever its marker
 * says, so a completed step-50 database still needs the steps up to 51.
 */
export function upgradeState(fence: { trusted: boolean; establishmentAllowed: boolean }, marker: UpgradeMarkerState, schemaVersion: number, target: number): UpgradeState {
  if (!fence.trusted) return fence.establishmentAllowed ? "pre_fence" : "fenced";
  return schemaVersion === target && (marker === "complete" || target < 50) ? "current" : "upgrade_needed";
}
