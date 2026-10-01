import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, readdirSync, statfsSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { inspectSchema, snapshotAttachments, SUPPORTED_SCHEMA_VERSION } from "./schema-inspection";
import { validateDatabase } from "./database-validation";
import { syncDirectory } from "../../private-storage";

export const BACKUP_LIMITS = { manifestBytes: 8 * 1024 * 1024, attachments: 50_000, fileBytes: 64 * 1024 ** 3, totalBytes: 128 * 1024 ** 3, entries: 100_000 } as const;
const size = z.number().int().min(0).max(BACKUP_LIMITS.fileBytes);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const backupManifestSchema = z.object({
  formatVersion: z.literal(1), applicationVersion: z.string().min(1).max(128),
  createdAt: z.iso.datetime({ offset: true }),
  database: z.object({ file: z.literal("state.sqlite3"), size, sha256: sha256Schema, schemaVersion: z.number().int().min(1).max(SUPPORTED_SCHEMA_VERSION) }).strict(),
  attachments: z.array(z.object({ file: z.string().regex(/^[a-f0-9]{2}\/[a-f0-9]{64}$/), size, sha256: sha256Schema }).strict()).max(BACKUP_LIMITS.attachments),
}).strict().superRefine((manifest, context) => {
  const seen = new Set<string>(); let total = manifest.database.size;
  for (const entry of manifest.attachments) {
    if (entry.file !== `${entry.sha256.slice(0, 2)}/${entry.sha256}` || seen.has(entry.sha256)) context.addIssue({ code: "custom", message: "Ambiguous attachment path or duplicate hash." });
    seen.add(entry.sha256); total += entry.size;
  }
  if (total > BACKUP_LIMITS.totalBytes) context.addIssue({ code: "custom", message: "Backup exceeds staging budget." });
});
export type ControllerBackupManifest = z.infer<typeof backupManifestSchema>;

/** No links or special files, including each ancestor inside the selected tree. */
export function regularFile(path: string, privateMode = false, allowHardlinks = false): number {
  const info = lstatSync(path);
  if (!info.isFile() || (!allowHardlinks && info.nlink !== 1) || (privateMode && ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())))) throw new Error("Backup requires regular files without aliases and private staging permissions.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || (!allowHardlinks && opened.nlink !== 1) || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("Backup file identity changed.");
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
export function directory(path: string, privateMode = false): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || (privateMode && ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())))) throw new Error("Backup requires real directories and private staging permissions.");
}
export function hashFile(path: string, limit: number = BACKUP_LIMITS.fileBytes, sync = false, allowHardlinks = false): { size: number; sha256: string } {
  const fd = regularFile(path, false, allowHardlinks); const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let size = 0;
  try {
    if (fstatSync(fd).size > limit) throw new Error("Backup file exceeds size limit.");
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, size); if (!count) break;
      size += count; if (size > limit) throw new Error("Backup file exceeds size limit.");
      digest.update(buffer.subarray(0, count));
    }
    if (size !== fstatSync(fd).size) throw new Error("Backup file changed while reading.");
    if (sync) fsyncSync(fd);
    return { size, sha256: digest.digest("hex") };
  } finally { closeSync(fd); }
}
export function readBoundedJson(path: string, limit: number, privateMode = false, allowHardlinks = false): unknown {
  const fd = regularFile(path, privateMode, allowHardlinks);
  try {
    const size = fstatSync(fd).size; if (size > limit) throw new Error("Backup JSON exceeds size limit.");
    const bytes = Buffer.alloc(size); let offset = 0;
    while (offset < size) { const count = readSync(fd, bytes, offset, size - offset, offset); if (!count) throw new Error("Incomplete backup JSON."); offset += count; }
    if (fstatSync(fd).size !== size) throw new Error("Backup JSON changed while reading.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text); assertUnambiguousJson(text); return value;
  } finally { closeSync(fd); }
}
export function parseManifest(value: unknown): ControllerBackupManifest {
  const parsed = backupManifestSchema.safeParse(value);
  if (!parsed.success) throw new Error("Unsupported or invalid backup manifest (types, paths, versions or limits).");
  return parsed.data;
}

/** Exact tree shape: no undeclared payloads or SQLite sidecars in a snapshot. */
export function validateBackup(root: string, manifest: ControllerBackupManifest, privateMode = false): void {
  validateBackupFiles(root, manifest, privateMode);
  validateSnapshot(join(root, "state.sqlite3"), manifest);
}
export function validateBackupFiles(root: string, manifest: ControllerBackupManifest, privateMode = false): void {
  directory(root, privateMode);
  const top = boundedNames(root, 5);
  // Historical Backup API snapshots were inspected in WAL mode. Only an empty
  // WAL plus its bounded disposable SHM index can accompany the declared DB.
  if (!privateMode && top.includes("state.sqlite3-wal")) {
    const wal = regularFile(join(root, "state.sqlite3-wal"));
    try { if (fstatSync(wal).size !== 0) throw new Error("Backup contains an authoritative WAL sidecar."); } finally { closeSync(wal); }
    top.splice(top.indexOf("state.sqlite3-wal"), 1);
    if (top.includes("state.sqlite3-shm")) {
      const shm = regularFile(join(root, "state.sqlite3-shm"));
      try { if (fstatSync(shm).size > 16 * 1024 * 1024) throw new Error("Backup SHM exceeds limit."); } finally { closeSync(shm); }
      top.splice(top.indexOf("state.sqlite3-shm"), 1);
    }
  }
  if (JSON.stringify(top) !== JSON.stringify(["attachments", "manifest.json", "state.sqlite3"])) throw new Error("Backup has incomplete or unexpected files/sidecars.");
  const databaseFile = join(root, "state.sqlite3"); regularAndMatch(databaseFile, manifest.database, privateMode);
  validateAttachmentFiles(join(root, "attachments"), manifest.attachments, privateMode);
}
export function validateAttachmentFiles(attachmentRoot: string, attachments: ControllerBackupManifest["attachments"], privateMode = false): void {
  directory(attachmentRoot, privateMode);
  const expected = new Map(attachments.map(entry => [entry.file, entry]));
  const found = new Set<string>(); let entries = 0;
  for (const shard of boundedNames(attachmentRoot, 256)) {
    if (!/^[a-f0-9]{2}$/.test(shard)) throw new Error("Unexpected backup attachment directory.");
    const shardPath = join(attachmentRoot, shard); directory(shardPath, privateMode);
    const files = boundedNames(shardPath, BACKUP_LIMITS.attachments - entries); if (!files.length) throw new Error("Unexpected empty backup attachment directory.");
    for (const name of files) {
      if (++entries > BACKUP_LIMITS.attachments) throw new Error("Backup exceeds attachment limit.");
      const key = `${shard}/${name}`, entry = expected.get(key);
      if (!entry) throw new Error("Backup contains an undeclared attachment.");
      regularAndMatch(join(shardPath, name), entry, privateMode); found.add(key);
    }
  }
  if (found.size !== expected.size) throw new Error("Backup attachment manifest is incomplete.");
}
export function validateSnapshot(path: string, manifest: ControllerBackupManifest): void {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const actual = inspectSchema(database).version;
    if (actual !== manifest.database.schemaVersion) throw new Error("Unsupported or inconsistent database schema version.");
    validateDatabase(database, actual);
    const required = snapshotAttachments(database);
    if (JSON.stringify(required) !== JSON.stringify(manifest.attachments.map(({ sha256, size }) => ({ sha256, size })).sort((a, b) => a.sha256.localeCompare(b.sha256)))) throw new Error("Backup attachment manifest is incomplete or conflicts with database metadata.");
  } finally { database.close(); }
}
export function regularAndMatch(path: string, expected: { size: number; sha256: string }, privateMode = false): void {
  const fd = regularFile(path, privateMode); closeSync(fd);
  const actual = hashFile(path);
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new Error("Backup integrity check failed (size or SHA-256).");
}
export function copyVerifiedFile(source: string, destination: string, expected: { size: number; sha256: string }): void {
  const input = regularFile(source);
  let output: number;
  try { output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { closeSync(input); throw error; }
  try {
    if (fstatSync(input).size !== expected.size) throw new Error("Backup file size changed.");
    const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let offset = 0;
    for (;;) {
      const count = readSync(input, buffer, 0, buffer.length, offset); if (!count) break;
      offset += count; if (offset > expected.size) throw new Error("Backup file grew while staging.");
      digest.update(buffer.subarray(0, count)); let written = 0;
      while (written < count) { const n = writeSync(output, buffer, written, count - written); if (!n) throw new Error("Backup write made no progress."); written += n; }
    }
    if (offset !== expected.size || digest.digest("hex") !== expected.sha256) throw new Error("Backup integrity check failed while staging.");
    fsyncSync(output);
  } finally { closeSync(input); closeSync(output); }
  regularAndMatch(destination, expected, true);
}
export function copyBackup(source: string, target: string, manifest: ControllerBackupManifest): void {
  directory(source); directory(join(source, "attachments"));
  mkdirSync(join(target, "attachments"), { mode: 0o700 });
  copyVerifiedFile(join(source, "state.sqlite3"), join(target, "state.sqlite3"), manifest.database);
  for (const entry of manifest.attachments) {
    const shard = dirname(join(target, "attachments", entry.file));
    mkdirSync(shard, { recursive: true, mode: 0o700 });
    directory(dirname(join(source, "attachments", entry.file)));
    copyVerifiedFile(join(source, "attachments", entry.file), join(target, "attachments", entry.file), entry);
  }
}
export function syncTree(root: string): void {
  directory(root, true);
  for (const name of readdirSync(root)) {
    const path = join(root, name), info = lstatSync(path);
    if (info.isDirectory()) syncTree(path); else { const fd = regularFile(path, true); try { fsyncSync(fd); } finally { closeSync(fd); } }
  }
  syncDirectory(root);
}

/** Space is admission policy, never a substitute for handling ENOSPC on writes/fsync. */
export function ensureStagingCapacity(parent: string, manifest: ControllerBackupManifest): void {
  const total = manifest.database.size + manifest.attachments.reduce((sum, entry) => sum + entry.size, 0);
  const space = statfsSync(parent);
  if (space.bavail * space.bsize < total + 16 * 1024 * 1024) throw new Error("Insufficient free space for restore staging and journal reserve.");
}

/** Normalize only verified private bytes. Never open the external source in SQLite. */
export function stageVerifiedBackup(source: string, target: string, manifest: ControllerBackupManifest): ControllerBackupManifest {
  copyBackup(source, target, manifest);
  const path = join(target, "state.sqlite3"), database = new Database(path, { fileMustExist: true });
  try {
    database.pragma("trusted_schema = OFF");
    if (database.pragma("journal_mode = DELETE", { simple: true }) !== "delete") throw new Error("Backup snapshot could not become self-contained.");
  } finally { database.close(); }
  const staged = { ...manifest, database: { ...manifest.database, ...hashFile(path, BACKUP_LIMITS.fileBytes, true) } };
  return staged;
}

/** Limits directory materialization before returning a sorted list. */
export function boundedNames(path: string, limit: number): string[] {
  const handle = opendirSync(path), names: string[] = [];
  try {
    for (;;) { const entry = handle.readSync(); if (!entry) break; if (names.length >= limit) throw new Error("Backup directory exceeds entry limit."); names.push(entry.name); }
  } finally { handle.closeSync(); }
  return names.sort();
}
function assertUnambiguousJson(text: string): void {
  const stack: Array<{ object: boolean; key: boolean; seen: Set<string> }> = [];
  const tokens = /"(?:\\.|[^"\\])*"|[{}\[\],:]/g;
  for (let match; (match = tokens.exec(text));) {
    const token = match[0], top = stack.at(-1);
    if (token === "{" || token === "[") {
      if (stack.length >= 32) throw new Error("Backup JSON exceeds nesting limit.");
      stack.push({ object: token === "{", key: true, seen: new Set() });
    } else if (token === "}" || token === "]") stack.pop();
    else if (top?.object && token === ":") top.key = false;
    else if (top?.object && token === ",") top.key = true;
    else if (top?.object && top.key && token.startsWith('"')) {
      const key = JSON.parse(token) as string;
      if (top.seen.has(key)) throw new Error("Backup JSON contains duplicate keys.");
      top.seen.add(key);
    }
  }
}
