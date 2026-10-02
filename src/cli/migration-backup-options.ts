import { BACKUP_OPERATION_FLAGS } from "./backup-policy-options";
import { resolve } from "node:path";
import type { MigrationBackupOptions } from "../server/controller-storage";

/** Validate operator arguments before opening SQLite or modifying a service definition. */
export function parseMigrationBackupOptions(args: string[], allowed = true): MigrationBackupOptions {
  let backupBeforeMigration = false;
  let backupDirectory: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (!flag.startsWith("--backup")) continue;
    if (!allowed) throw new Error("Backup startup options apply only to start or service install.");
    if (BACKUP_OPERATION_FLAGS.includes(flag as typeof BACKUP_OPERATION_FLAGS[number])) { index++; continue; }
    if (flag === "--backup-before-migration") {
      if (backupBeforeMigration || (args[index + 1] && !args[index + 1].startsWith("--"))) throw new Error("--backup-before-migration is a boolean flag and must occur once.");
      backupBeforeMigration = true;
    } else if (flag === "--backup-dir") {
      const value = args[++index];
      if (backupDirectory || !value?.trim() || value.startsWith("--") || value.includes("\0")) throw new Error("--backup-dir requires one directory and must occur once.");
      backupDirectory = resolve(value);
    } else { throw new Error(`Unsupported backup option: ${flag.split("=")[0]}`); }
  }
  if (backupBeforeMigration && !backupDirectory) throw new Error("--backup-before-migration requires --backup-dir.");
  return { backupBeforeMigration, ...(backupDirectory ? { backupDirectory } : {}) };
}
