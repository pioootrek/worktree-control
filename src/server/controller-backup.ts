import { attachmentObjectPath, publishAttachmentObject } from "./attachment-objects";
import { durableJson, privateDirectory, syncDirectory } from "./private-storage";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import { acquireDatabaseOwnership, inspectSchema, snapshotAttachments } from "./infrastructure/sqlite";

import { hashFile, parseManifest, syncTree, validateBackup, type ControllerBackupManifest } from "./infrastructure/sqlite";
import { prepareOwnedRestore, recoverOwnedRestore, type RestoreActor } from "./infrastructure/sqlite";
export type { ControllerBackupManifest } from "./infrastructure/sqlite";
interface BackupSource { backup(destination: string): Promise<void>; schemaVersion?(): number }

export async function createControllerBackup(source: BackupSource, destination: string, options: {applicationVersion:string;attachmentDirectory:string;clock?:()=>string}): Promise<ControllerBackupManifest> {
  try {
    lstatSync(destination);
    throw new Error("Backup destination already exists.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  privateDirectory(dirname(destination)); const staging=mkdtempSync(join(dirname(destination),`.${basename(destination)}.partial-`)); mkdirSync(join(staging,"attachments"),{recursive:true,mode:0o700});
  try {
    // The owner keeps every published object immutable and retained through this
    // await and the copy below. SQL deletion/rollback never unlinks live objects;
    // offline restore is excluded by the existing database ownership lock.
    const databaseFile=join(staging,"state.sqlite3"); closeSync(openSync(databaseFile,"wx",0o600)); await source.backup(databaseFile);
    chmodSync(databaseFile, 0o600);
    const snapshot=new Database(databaseFile,{fileMustExist:true});
    let required: Array<{sha256:string;size:number}>;
    let schemaVersion: number;
    try {
      if (snapshot.pragma("journal_mode = DELETE", { simple: true }) !== "delete") throw new Error("Backup snapshot could not become self-contained.");
      schemaVersion = inspectSchema(snapshot).version;
      required = snapshotAttachments(snapshot);
    } finally { snapshot.close(); }
    const attachments=required.map(({sha256,size})=>{ const file=join(sha256.slice(0,2),sha256);
      if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size < 0) throw new Error("Invalid attachment metadata.");
      const from = attachmentObjectPath(options.attachmentDirectory, { sha256, size });
      publishAttachmentObject(join(staging, "attachments"), { sha256, size }, { path: from });
      return {file,size,sha256};
    });
    const manifest: ControllerBackupManifest={formatVersion:1,applicationVersion:options.applicationVersion,createdAt:(options.clock??(()=>new Date().toISOString()))(),database:{file:"state.sqlite3",size:lstatSync(databaseFile).size,sha256:hashFile(databaseFile).sha256,schemaVersion},attachments};
    parseManifest(manifest);
    durableJson(join(staging,"manifest.json"), manifest);
    validateBackup(staging, manifest, true); syncTree(staging);
    renameSync(staging,destination); syncDirectory(dirname(destination)); return manifest;
  } catch(error) { rmSync(staging,{recursive:true,force:true}); throw error; }
}

export function restoreControllerBackup(source: string, databasePath: string, attachmentDirectory?: string, actor?: RestoreActor): void {
  const ownership = acquireDatabaseOwnership(databasePath);
  try {
    prepareOwnedRestore(source, ownership.path, attachmentDirectory ?? join(dirname(ownership.path), "knowledge-attachments"), actor ?? {
      actorId: `local-uid:${process.getuid?.() ?? "unknown"}`, backupId: "offline-cli", idempotencyKey: randomUUID(),
    });
    recoverOwnedRestore(ownership.path);
  } finally { ownership.lock.release(); }
}
