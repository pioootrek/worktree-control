import { SqliteStateStore } from "./infrastructure/sqlite";

export interface MigrationBackupOptions {
  /**
   * Deprecated: accepted because installed service definitions carry it, but
   * ordinary startup no longer migrates an existing database, so it takes no
   * copy. Backups are taken by `auth fence establish --backup-dir` and
   * `upgrade apply --backup-dir`. Start prints {@link MIGRATION_BACKUP_DEPRECATION}.
   */
  backupBeforeMigration: boolean;
  backupDirectory?: string;
}

/** The one notice start prints when `--backup-before-migration` is given. */
export const MIGRATION_BACKUP_DEPRECATION = "--backup-before-migration is deprecated and takes no copy: startup no longer migrates an existing database. Backups are taken by auth fence establish --backup-dir and upgrade apply --backup-dir.";

/**
 * The controller's ordinary opening of its store. The store admits only a
 * database that is current (trusted fence, supported schema, complete upgrade
 * marker) or fresh; anything else is refused before anything is written
 * (`upgrade_required` or a security fence refusal), and no copy is taken here.
 */
export function openControllerStore(databasePath: string): SqliteStateStore {
  return new SqliteStateStore(databasePath);
}

/**
 * The ordinary opening of `service install`'s pre-bootstrap: the same admission
 * as {@link openControllerStore}, so an installation that needs the upgrade,
 * fence establishment or recovery refuses here, before a token is issued or a
 * service definition changes.
 */
export function openCurrentControllerStore(databasePath: string): SqliteStateStore {
  return new SqliteStateStore(databasePath);
}
