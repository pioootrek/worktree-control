import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { OwnedSqliteDatabase, SqliteStateStore, SUPPORTED_SCHEMA_VERSION } from "./infrastructure/sqlite";
import { createControllerBackup } from "./controller-backup";

export interface MigrationBackupOptions {
  backupBeforeMigration: boolean;
  backupDirectory?: string;
}

/** Opens once under database ownership; optional verified backup precedes every migration effect. */
export async function openControllerStore(databasePath: string, options: MigrationBackupOptions & {
  applicationVersion: string;
  attachmentDirectory: string;
}): Promise<SqliteStateStore> {
  if (options.backupBeforeMigration && !options.backupDirectory) throw new Error("--backup-before-migration requires --backup-dir.");
  const inspected = new OwnedSqliteDatabase(databasePath, true);
  try {
    if (options.backupBeforeMigration && !inspected.inspection.fresh && inspected.inspection.version < SUPPORTED_SCHEMA_VERSION) {
      await createControllerBackup(inspected, join(options.backupDirectory!, `pre-migration-v${inspected.inspection.version}-${randomUUID()}`), options);
    }
    return new SqliteStateStore(databasePath, inspected);
  } catch (error) { inspected.close(); throw error; }
}
