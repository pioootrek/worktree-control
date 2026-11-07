import type { AppPaths } from "../paths";
import { maintainSqliteSecurityFence, type SecurityMaintenanceCommand } from "../infrastructure/sqlite";
import { preflightSecurityRecoveryHandoff, acknowledgeRecoveredBackupHandoff } from "../modules/backups";
export type { SecurityMaintenanceCommand } from "../infrastructure/sqlite";

/** Protected offline composition. SQLite owns both locks; application handoffs
 * are validated before any writes and acknowledged only after quarantine. */
export function maintainSecurityFence(paths:AppPaths,command:SecurityMaintenanceCommand) {
  return maintainSqliteSecurityFence(paths,command,{
    preflight:database=>{preflightSecurityRecoveryHandoff(database);},
    acknowledge:acknowledgeRecoveredBackupHandoff,
  });
}
