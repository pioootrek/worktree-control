import type { AppPaths } from "../paths";
import { establishSqliteSecurityFence, maintainSqliteSecurityFence, type SecurityMaintenanceCommand } from "../infrastructure/sqlite";
import { preflightSecurityRecoveryHandoff, acknowledgeRecoveredBackupHandoff } from "../modules/backups";
import { controllerMaintenanceBackup, type MaintenanceBackupOptions } from "./maintenance-backup";
export type { SecurityMaintenanceCommand } from "../infrastructure/sqlite";

/** The application handoff of every fence maintenance composed here. */
const HANDOFF = {
  preflight: (database: string) => { preflightSecurityRecoveryHandoff(database); },
  acknowledge: acknowledgeRecoveredBackupHandoff,
};

/** Protected offline composition. SQLite owns both locks; application handoffs
 * are validated before any writes and acknowledged only after quarantine.
 * `target` is for tests at an explicit lower target; omitted, it is the
 * supported schema, as the `auth fence` command runs it. */
export function maintainSecurityFence(paths:AppPaths,command:SecurityMaintenanceCommand,target?:number) {
  return maintainSqliteSecurityFence(paths,command,HANDOFF,target);
}

/**
 * `auth fence establish --backup-dir` with a pre-establishment backup written
 * by `createControllerBackup` into
 * `<backup.directory>/pre-establishment-v<source schema>-<UUID>`, with the same
 * handoff as {@link maintainSecurityFence}. Only the fence command
 * (`src/cli/security-fence.ts`) calls it (`schema-entry-points.test.ts` guards
 * this). A failed backup is `security_fence_backup_failed`. `target` is for
 * tests at an explicit lower target; omitted, it is the supported schema.
 */
export function establishSecurityFenceWithBackup(paths: AppPaths, command: { action: "establish"; expect: string }, backup: MaintenanceBackupOptions, target?: number) {
  return establishSqliteSecurityFence(paths, command, HANDOFF, controllerMaintenanceBackup(paths, "pre-establishment", backup, target), target);
}
