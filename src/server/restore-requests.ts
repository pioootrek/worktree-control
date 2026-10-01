import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, opendirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { BACKUP_LIMITS, parseManifest, readBoundedJson, sha256Schema, validateBackup, validateBackupFiles, ensureStagingCapacity, stageVerifiedBackup } from "./infrastructure/sqlite";
import { acquireDatabaseOwnership } from "./infrastructure/sqlite";
import { durableJson, privateDirectory, syncDirectory } from "./private-storage";
import { getOwnedRestoreStatus, prepareOwnedRestore, recoverOwnedRestore, restoreActorSchema, type RestoreActor } from "./infrastructure/sqlite";

const requestInputSchema = z.object({ backupId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/), idempotencyKey: z.string().min(1).max(256), confirmation: z.literal("replace-entire-installation") }).strict();
export type RestoreRequestInput = z.infer<typeof requestInputSchema>;
const recordSchema = z.object({
  formatVersion: z.literal(1), operationId: z.uuid(), actor: restoreActorSchema,
  createdAt: z.iso.datetime(), source: z.string().min(1).max(4096), manifestHash: sha256Schema,
  state: z.enum(["requested", "verified"]),
}).strict();
const checksum = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Record = z.infer<typeof recordSchema>;
export interface RestoreRequestStatus { operationId: string; backupId: string; state: "requested" | "verified"; createdAt: string }
export interface RestoreRequestPolicy {
  /** Must enforce operator installation authority and deployment policy, also at execution. */
  authorize(actorId: string, backupId: string): void;
  /** Resolves a catalog ID inside operator-controlled destinations; never a client path. */
  resolveBackup(backupId: string): string;
}
const status = (record: Record): RestoreRequestStatus => ({ operationId: record.operationId, backupId: record.actor.backupId, state: record.state, createdAt: record.createdAt });
const keyFor = (actor: RestoreActor) => checksum([actor.actorId, actor.idempotencyKey]);
function requestDirectory(databasePath: string): string { return privateDirectory(`${resolve(databasePath)}.restore-requests`); }
function readRecord(path: string): Record {
  const envelope = z.object({ payload: recordSchema, sha256: sha256Schema }).strict().parse(readBoundedJson(path, 32 * 1024, true, true));
  if (envelope.sha256 !== checksum(envelope.payload)) throw new Error("Corrupt restore request; preserve it for inspection.");
  // Complete an interrupted immutable publication only for its own known alias.
  if (lstatSync(path).nlink !== 1) {
    const temporary = join(dirname(path), `.request-${envelope.payload.operationId}`), target = lstatSync(path);
    let alias;
    try { alias = lstatSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; if (lstatSync(path).nlink !== 1) throw new Error("Unsafe restore request alias."); }
    if (alias) {
      if (!alias.isFile() || target.nlink !== 2 || alias.dev !== target.dev || alias.ino !== target.ino) throw new Error("Unsafe restore request alias.");
      rmSync(temporary, { force: true }); syncDirectory(dirname(path));
    }
  }
  return envelope.payload;
}
function sameRequest(record: Record, actor: RestoreActor): void {
  if (record.actor.actorId !== actor.actorId || record.actor.idempotencyKey !== actor.idempotencyKey || record.actor.backupId !== actor.backupId) throw new Error("Restore idempotency key conflicts with a different request.");
}

/** Admission only: may run with an open database, never changes live files or starts processes. */
export function requestControllerRestore(databasePath: string, actorId: string, value: unknown, policy: RestoreRequestPolicy): RestoreRequestStatus {
  const input = requestInputSchema.parse(value), actor = restoreActorSchema.parse({ actorId, backupId: input.backupId, idempotencyKey: input.idempotencyKey });
  policy.authorize(actorId, input.backupId);
  const directory = requestDirectory(databasePath), path = join(directory, `${keyFor(actor)}.json`);
  try { const record = readRecord(path); sameRequest(record, actor); syncDirectory(directory); syncDirectory(dirname(directory)); return status(record); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const entries = opendirSync(directory); let count = 0;
  try { while (entries.readSync()) if (++count >= 1024) throw new Error("Restore request history limit reached; operator review is required."); }
  finally { entries.closeSync(); }
  const source = resolve(policy.resolveBackup(input.backupId)), manifest = parseManifest(readBoundedJson(join(source, "manifest.json"), BACKUP_LIMITS.manifestBytes));
  validateBackupFiles(source, manifest); ensureStagingCapacity(directory, manifest);
  const preview = mkdtempSync(join(directory, ".preview-"));
  try {
    const staged = stageVerifiedBackup(source, preview, manifest); durableJson(join(preview, "manifest.json"), staged); validateBackup(preview, staged, true);
  } finally { rmSync(preview, { recursive: true, force: true }); }
  const record: Record = { formatVersion: 1, operationId: randomUUID(), actor, createdAt: new Date().toISOString(), source, manifestHash: checksum(manifest), state: "requested" };
  const temporary = join(directory, `.request-${record.operationId}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify({ payload: record, sha256: checksum(record) })); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temporary, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  finally { rmSync(temporary, { force: true }); syncDirectory(directory); syncDirectory(dirname(directory)); }
  const accepted = readRecord(path); sameRequest(accepted, actor); return status(accepted);
}

/**
 * Explicit handoff executor. The controller must first enter maintenance, stop
 * its verified owned processes, close SQLite and release its database lock.
 * An open owner makes this call fail, never replace live data. S4 owns that UI
 * lifecycle; offline CLI already holds its controller lock without a connection.
 */
export function executeControllerRestoreRequest(databasePath: string, attachmentDirectory: string, actor: RestoreActor, policy: RestoreRequestPolicy): RestoreRequestStatus {
  restoreActorSchema.parse(actor); policy.authorize(actor.actorId, actor.backupId);
  const ownership = acquireDatabaseOwnership(databasePath);
  try {
    const path = join(requestDirectory(ownership.path), `${keyFor(actor)}.json`), record = readRecord(path); sameRequest(record, actor);
    syncDirectory(dirname(path)); syncDirectory(dirname(dirname(path)));
    if (record.state === "verified") return status(record);
    const previous = getOwnedRestoreStatus(ownership.path, record.operationId);
    if (previous?.operationId !== record.operationId) {
      if (resolve(policy.resolveBackup(actor.backupId)) !== record.source) throw new Error("Restore catalog destination changed since confirmation.");
      prepareOwnedRestore(record.source, ownership.path, attachmentDirectory, record.actor, { operationId: record.operationId, manifestHash: record.manifestHash });
      recoverOwnedRestore(ownership.path);
    } else if (previous.state !== "verified") throw new Error("Restore did not reach a verified state.");
    record.state = "verified"; durableJson(path, { payload: record, sha256: checksum(record) });
    return status(record);
  } finally { ownership.lock.release(); }
}

/** Bounded status for reconnection, with current operator authorization and no DB open. */
export function getControllerRestoreRequestStatus(databasePath: string, actor: RestoreActor, policy: RestoreRequestPolicy): RestoreRequestStatus {
  restoreActorSchema.parse(actor); policy.authorize(actor.actorId, actor.backupId);
  const canonical = join(privateDirectory(dirname(resolve(databasePath))), basename(databasePath));
  const record = readRecord(join(requestDirectory(canonical), `${keyFor(actor)}.json`)); sameRequest(record, actor);
  // A visible journal rename can precede a failed directory fsync. Only the
  // locked executor acknowledges completion and repairs a missing receipt.
  return status(record);
}

/** Retention protection from durable S3b receipts, including interrupted requests. */
export function protectedControllerRestoreBackupIds(databasePath: string): Set<string> {
  const directory = `${resolve(databasePath)}.restore-requests`;
  let entries;
  try { entries = opendirSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set(); throw error; }
  const result = new Set<string>();
  let visited = 0;
  try { for (;;) {
    const entry = entries.readSync(); if (!entry) break;
    if (++visited > 1024) throw new Error("Restore request history exceeds its bound.");
    if (/^[0-9a-f]{64}\.json$/.test(entry.name)) result.add(readRecord(join(directory, entry.name)).actor.backupId);
  } } finally { entries.closeSync(); }
  return result;
}
