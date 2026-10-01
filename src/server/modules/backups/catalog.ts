import { lstatSync, mkdtempSync, opendirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backupIdSchema, type BackupEntry } from "@/shared/contracts/backups";
import { BACKUP_LIMITS, ensureStagingCapacity, parseManifest, readBoundedJson, stageVerifiedBackup, validateBackup, type ControllerBackupManifest } from "@/server/infrastructure/sqlite";
import { durableJson, privateDirectory } from "@/server/private-storage";
import { BackupError } from "./policy";
export const manifestBytes = (manifest: ControllerBackupManifest): number => manifest.database.size + manifest.attachments.reduce((sum, file) => sum + file.size, 0);
/** Catalog paths are resolved exclusively from IDs inside the CLI destination. */
export class BackupCatalog {
  constructor(private readonly root: string | undefined, private readonly scratch: string) {}
  path(id: string): string {
    if (!backupIdSchema.safeParse(id).success || !this.root) throw new BackupError("backup_invalid");
    const path = join(privateDirectory(this.root), id), stat = lstatSync(path);
    if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new BackupError("backup_invalid");
    return path;
  }
  manifest(id: string): ControllerBackupManifest { return parseManifest(readBoundedJson(join(this.path(id), "manifest.json"), BACKUP_LIMITS.manifestBytes, true)); }
  list(): BackupEntry[] {
    if (!this.root) return [];
    const entries: BackupEntry[] = [], directory = opendirSync(privateDirectory(this.root)); let visited = 0;
    try {
      for (;;) {
        const item = directory.readSync(); if (!item) break;
        if (++visited > 4096) throw new BackupError("backup_limit");
        if (!backupIdSchema.safeParse(item.name).success) continue;
        if (entries.length >= 1024) throw new BackupError("backup_limit");
        try {
          const manifest = this.manifest(item.name);
          entries.push({ id: item.name, createdAt: manifest.createdAt, sizeBytes: manifestBytes(manifest), compatibility: "supported", verification: "verified", protected: item.name.startsWith("pre-migration-") });
        } catch {
          entries.push({ id: item.name, createdAt: null, sizeBytes: null, compatibility: "unsupported", verification: "failed", protected: true });
        }
      }
    } finally { directory.closeSync(); }
    return entries.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  }
  verify(id: string): ControllerBackupManifest {
    return this.verifyPath(this.path(id));
  }
  /** Only server-recorded destinations or catalog paths may reach this method. */
  verifyPath(source: string): ControllerBackupManifest {
    const stat = lstatSync(source);
    if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new BackupError("backup_invalid");
    privateDirectory(source);
    const manifest = parseManifest(readBoundedJson(join(source, "manifest.json"), BACKUP_LIMITS.manifestBytes, true));
    ensureStagingCapacity(this.scratch, manifest);
    const temporary = mkdtempSync(join(this.scratch, ".verify-"));
    try {
      const staged = stageVerifiedBackup(source, temporary, manifest);
      durableJson(join(temporary, "manifest.json"), staged); validateBackup(temporary, staged, true);
      return manifest;
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}
