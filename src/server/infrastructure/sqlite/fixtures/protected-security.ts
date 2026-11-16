import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { resolveAppPaths, type AppPaths } from "../../../paths";
import { establishSecurityFenceWithBackup, maintainSecurityFence } from "../../../bootstrap/security-maintenance";
import { applyUpgrade, inspectUpgrade } from "../../../bootstrap/upgrade-maintenance";
import type { SqliteStateStore } from "../sqlite-state-store";
import { openStoreAt49, RELEASED_SCHEMA_VERSION } from "./released-schema";

/**
 * Explicit protected OS operator acts for older/restored TEST fixtures. Never a
 * store flag. Each runs the product's own offline maintenance (the bootstrap
 * compositions of `auth fence` and `upgrade`) on a fixture's database.
 */
export interface FixtureMaintenanceOptions {
  /** Where the installation's Knowledge attachments are (default: beside the database). */
  attachmentDirectory?: string;
  /** Where the upgrade writes its pre-upgrade backup (default: `<database>.fixture-backups`). */
  backupDirectory?: string;
}
function paths(databasePath: string, options: FixtureMaintenanceOptions = {}): AppPaths {
  const resolved = { ...resolveAppPaths(dirname(databasePath)), databasePath };
  return options.attachmentDirectory ? { ...resolved, knowledgeAttachmentDirectory: options.attachmentDirectory } : resolved;
}

/**
 * Establishes the fence on an older (pre-fence) fixture at `target`, by
 * default the released schema 49: the historical steps run, nothing from step
 * 50 on. Open the result with `openStoreAt49`; at the supported version it
 * would be refused as `upgrade_required` until {@link upgradeFixture}.
 */
export function establishFixtureSecurity(databasePath: string, target: number = RELEASED_SCHEMA_VERSION): void {
  const p = paths(databasePath), status = maintainSecurityFence(p, { action: "inspect" }, target);
  if (!status.establishmentAllowed) throw new Error(`Fixture ${basename(databasePath)} is not an unestablished installation.`);
  maintainSecurityFence(p, { action: "establish", expect: status.preflight }, target);
}

/**
 * The explicit upgrade of a fixture, as the operator runs it: `upgrade
 * inspect`, then `upgrade apply --expect <its plan hash>` with a pre-upgrade
 * backup. The database must be in "upgrade needed" (or already current, which
 * inspect reports without a plan). Returns the plan hash (null when current).
 */
export async function upgradeFixture(databasePath: string, options: FixtureMaintenanceOptions = {}): Promise<string | null> {
  const p = paths(databasePath, options), inspection = inspectUpgrade(p);
  if (inspection.state === "current") return null;
  if (inspection.state !== "upgrade_needed" || !inspection.planHash) throw new Error(`Fixture ${basename(databasePath)} is in state ${inspection.state}, not upgrade needed.`);
  const directory = options.backupDirectory ?? `${databasePath}.fixture-backups`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  await applyUpgrade(p, { expect: inspection.planHash }, { directory, applicationVersion: "fixture" });
  return inspection.planHash;
}

/**
 * `auth fence resume` of a restored or rolled-back fixture at the supported
 * schema, then (unless `upgrade: false`) the explicit upgrade the resumed
 * database needs before an ordinary opening: after a restore the operator
 * runs resume, inspect and apply. The quarantine and the upgrade reset
 * authority; projects, Knowledge and history stay.
 */
export async function resumeFixtureSecurity(databasePath: string, mode: "token" | "open" | "better-auth" = "token", options: FixtureMaintenanceOptions & { upgrade?: boolean } = {}): Promise<void> {
  const p = paths(databasePath, options), status = maintainSecurityFence(p, { action: "inspect" });
  maintainSecurityFence(p, { action: "resume", expect: status.preflight, mode });
  if (options.upgrade !== false) await upgradeFixture(databasePath, options);
}

/**
 * Opens a pre-fence fixture the way the historical tests mean it: the fence is
 * established at the released schema 49 (the operator's `auth fence establish`,
 * with its pre-establishment backup in `backupDirectory` when one is given),
 * then the store is opened at 49 by the test-side opener. An ordinary start no
 * longer migrates or backs up; this fixture names the maintenance that does.
 */
export async function openProtectedUpgradeFixture(databasePath: string, options: { backupDirectory?: string; applicationVersion: string; attachmentDirectory: string }): Promise<SqliteStateStore> {
  const p = paths(databasePath, { attachmentDirectory: options.attachmentDirectory });
  const status = maintainSecurityFence(p, { action: "inspect" }, RELEASED_SCHEMA_VERSION);
  if (!status.trusted) {
    if (!status.establishmentAllowed) throw new Error(`Fixture ${basename(databasePath)} is not an unestablished installation.`);
    if (options.backupDirectory) {
      await establishSecurityFenceWithBackup(p, { action: "establish", expect: status.preflight },
        { directory: options.backupDirectory, applicationVersion: options.applicationVersion }, RELEASED_SCHEMA_VERSION);
    } else maintainSecurityFence(p, { action: "establish", expect: status.preflight }, RELEASED_SCHEMA_VERSION);
  }
  return openStoreAt49(databasePath);
}
