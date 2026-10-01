import { lstatSync, mkdtempSync, opendirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backupIdSchema, type BackupEntry } from "@/shared/contracts/backups";
import { BACKUP_LIMITS, parseManifest, readBoundedJson, verifyBackupSnapshot, type ControllerBackupManifest } from "@/server/infrastructure/sqlite";
import { privateDirectory } from "@/server/private-storage";
import { BackupError } from "./policy";
import { SnapshotVerifier } from "./snapshot-verifier";
export const manifestBytes = (manifest: ControllerBackupManifest): number => manifest.database.size + manifest.attachments.reduce((sum, file) => sum + file.size, 0);
/** Catalog paths are resolved exclusively from IDs inside the CLI destination. */
export class BackupCatalog {
  private readonly verifier: SnapshotVerifier;
  readonly verifyingIds = new Set<string>();
  constructor(private readonly root: string | undefined, private readonly scratch: string, private readonly maxBytes: number = BACKUP_LIMITS.totalBytes, timeoutSeconds = 300) { this.verifier = new SnapshotVerifier(scratch, timeoutSeconds, maxBytes); }
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
          entries.push({ id: item.name, createdAt: manifest.createdAt, sizeBytes: manifestBytes(manifest), compatibility: "supported", verification: "unverified", protected: item.name.startsWith("pre-migration-") });
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
  async verifyAsync(id: string): Promise<ControllerBackupManifest> {
    if (this.verifyingIds.has(id)) throw new BackupError("backup_busy", 503);
    this.verifyingIds.add(id);
    try { return await this.verifyPathAsync(this.path(id)); }
    finally { this.verifyingIds.delete(id); }
  }
  async verifyPathAsync(source: string): Promise<ControllerBackupManifest> {
    privateDirectory(source);
    const manifest = parseManifest(readBoundedJson(join(source, "manifest.json"), BACKUP_LIMITS.manifestBytes, true));
    if (manifestBytes(manifest) > this.maxBytes) throw new BackupError("backup_limit");
    return this.verifier.verify(source);
  }
  async close(): Promise<void> { await this.verifier.close(); }
  /** Only server-recorded destinations or catalog paths may reach this method. */
  verifyPath(source: string): ControllerBackupManifest {
    const stat = lstatSync(source);
    if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new BackupError("backup_invalid");
    privateDirectory(source);
    const temporary = mkdtempSync(join(this.scratch, ".verify-"));
    try {
      return verifyBackupSnapshot(source, this.scratch, temporary);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}
