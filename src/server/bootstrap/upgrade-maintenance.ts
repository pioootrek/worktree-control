import type { AppPaths } from "../paths";
import { applySqliteUpgrade, inspectSqliteUpgrade, type UpgradeApplyResult, type UpgradeInspection } from "../infrastructure/sqlite";
import { controllerMaintenanceBackup, type MaintenanceBackupOptions } from "./maintenance-backup";
export type { UpgradeApplyResult, UpgradeInspection } from "../infrastructure/sqlite";
export type { MaintenanceBackupOptions } from "./maintenance-backup";

/*
 * The explicit offline upgrade's composition (integration branch, provisional).
 * Only `src/cli/upgrade.ts` imports this file, and no registered command
 * imports that one: the activation mounts both (`provisional-schema.test.ts`
 * guards this). `target` exists for tests at the provisional target; omitted,
 * it resolves to the supported schema, where the upgrade refuses as
 * unsupported before any lock or file.
 */

/** `upgrade inspect`: reads the state and, only when an upgrade is needed, writes the plan. */
export function inspectUpgrade(paths: AppPaths, decisions?: unknown, target?: number): UpgradeInspection {
  return inspectSqliteUpgrade(paths, target, decisions);
}

/**
 * `upgrade apply --expect <plan hash>`: executes exactly that plan after a
 * pre-upgrade backup written by `createControllerBackup` into
 * `<backup.directory>/pre-upgrade-v<source schema>-<UUID>`.
 */
export function applyUpgrade(paths: AppPaths, command: { expect: string }, backup: MaintenanceBackupOptions, target?: number): Promise<UpgradeApplyResult> {
  return applySqliteUpgrade(paths, command, controllerMaintenanceBackup(paths, "pre-upgrade", backup, target), target);
}
