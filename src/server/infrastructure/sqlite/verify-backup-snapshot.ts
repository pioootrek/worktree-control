import { join } from "node:path";
import { BACKUP_LIMITS, ensureStagingCapacity, parseManifest, readBoundedJson, stageVerifiedBackup, validateBackup, validateBackupFiles, type ControllerBackupManifest } from "./backup-validation";
import { durableJson } from "../../private-storage";

/** Only the disposable clone is opened as SQLite; the catalog source stays immutable. */
export function verifyBackupSnapshot(source: string, scratch: string, temporary: string, maxBytes: number = BACKUP_LIMITS.totalBytes): ControllerBackupManifest {
  const manifest = parseManifest(readBoundedJson(join(source, "manifest.json"), BACKUP_LIMITS.manifestBytes, true));
  if (manifest.database.size + manifest.attachments.reduce((sum, file) => sum + file.size, 0) > maxBytes) throw new Error("Backup verification exceeds its byte limit.");
  ensureStagingCapacity(scratch, manifest);
  validateBackupFiles(source, manifest);
  const staged = stageVerifiedBackup(source, temporary, manifest);
  durableJson(join(temporary, "manifest.json"), staged);
  validateBackup(temporary, staged, true);
  return manifest;
}
