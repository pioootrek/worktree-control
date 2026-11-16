import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AppPaths } from "../paths";
import { createControllerBackup } from "../controller-backup";
import type { MaintenanceBackup } from "../infrastructure/sqlite";

/** Where the operator wants the maintenance backup and the version recorded in its manifest. */
export interface MaintenanceBackupOptions { directory: string; applicationVersion: string }
/** The name prefix of each maintenance backup, beside the historical `pre-migration-` (see `src/shared/contracts/backups.ts`). */
export type MaintenanceBackupKind = "pre-upgrade" | "pre-establishment";

/**
 * The one composition of the bound maintenance backup: the explicit
 * upgrade's pre-upgrade backup and fence establishment's pre-establishment
 * backup. The tree is written by the real
 * `createControllerBackup` into `<directory>/<kind>-v<source schema>-<UUID>`,
 * with the installation's Knowledge attachments, and accepted by the SQLite
 * layer only as this run's bound copy (`takeBoundBackup`).
 *
 * `target` is the run's schema target and becomes the backup's schema ceiling
 * (a test at an explicit lower target backs up at that ceiling). Omitted, the
 * ceiling is the supported schema, as for every other backup.
 */
export function controllerMaintenanceBackup(paths: AppPaths, kind: MaintenanceBackupKind, options: MaintenanceBackupOptions, target?: number): MaintenanceBackup {
  return async (source, context) => {
    const root = join(options.directory, `${kind}-v${context.schemaVersion}-${randomUUID()}`);
    const manifest = await createControllerBackup(source, root, {
      applicationVersion: options.applicationVersion, attachmentDirectory: paths.knowledgeAttachmentDirectory, schemaCeiling: target,
    });
    return { root, manifest };
  };
}
