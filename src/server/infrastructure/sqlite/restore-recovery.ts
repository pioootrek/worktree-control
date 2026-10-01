import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, openSync, readSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { BACKUP_LIMITS, backupManifestSchema, boundedNames, ensureStagingCapacity, directory, hashFile, parseManifest, readBoundedJson, regularAndMatch, sha256Schema, syncTree, stageVerifiedBackup, validateBackup, validateBackupFiles, validateAttachmentFiles, validateSnapshot } from "./backup-validation";
import { durableJson, privateDirectory, syncDirectory } from "../../private-storage";

const identitySchema = z.object({ device: z.number().int().nonnegative(), inode: z.number().int().positive(), kind: z.enum(["file", "directory"]), size: z.number().int().nonnegative(), sha256: sha256Schema }).strict();
type Identity = z.infer<typeof identitySchema>;
export const restoreActorSchema = z.object({ actorId: z.string().min(1).max(256), backupId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/), idempotencyKey: z.string().min(1).max(256) }).strict();
export type RestoreActor = z.infer<typeof restoreActorSchema>;
const journalSchema = z.object({
  formatVersion: z.literal(1), operationId: z.uuid(), createdAt: z.iso.datetime(), databasePath: z.string().min(1).max(4096), attachmentDirectory: z.string().min(1).max(4096),
  actor: restoreActorSchema, sourceManifestHash: sha256Schema, manifest: backupManifestSchema,
  previous: z.array(identitySchema.nullable()).length(6), staged: z.array(identitySchema).length(2),
  completed: z.number().int().min(0).max(8), intent: z.number().int().min(0).max(7).nullable(),
  state: z.enum(["prepared", "securing_previous", "previous_secured", "database_installed", "attachments_installed", "verified"]),
}).strict();
type Journal = z.infer<typeof journalSchema>;
const envelopeSchema = z.object({ payload: journalSchema, sha256: sha256Schema }).strict();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const localFilesystems = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994]); // ext, XFS, Btrfs, tmpfs (process tests)
const journalLimit = 16 * 1024 * 1024;
export const restoreRoot = (databasePath: string) => `${databasePath}.restore`;
const recoveryError = (detail: string): never => { throw new Error(`Restore recovery stopped: ${detail}. Preserve the database, attachments and its .restore directory; recover an isolated copy with a compatible release before retrying.`); };
function info(path: string) { try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
function stateFor(completed: number): Journal["state"] {
  return completed === 0 ? "prepared" : completed < 6 ? "securing_previous" : completed === 6 ? "previous_secured" : completed === 7 ? "database_installed" : "attachments_installed";
}

function writeJournal(root: string, journal: Journal): void { durableJson(join(root, "journal.json"), { payload: journal, sha256: digest(journal) }); }
function readJournal(root: string, databasePath: string): Journal {
  let journal: Journal;
  try {
    directory(root, true);
    const envelope = envelopeSchema.parse(readBoundedJson(join(root, "journal.json"), journalLimit, true));
    journal = envelope.payload;
    if (envelope.sha256 !== digest(journal) || journal.databasePath !== databasePath
      || (journal.intent !== null && journal.intent !== journal.completed)
      || (journal.state === "verified" ? journal.completed !== 8 || journal.intent !== null : journal.state !== stateFor(journal.completed))) recoveryError("inconsistent journal");
  } catch { recoveryError("invalid or corrupt journal"); }
  return journal!;
}

/** Bounded old-set fingerprint includes retained objects, not only SQL references. */
function identity(path: string, sync = false): Identity {
  const rootInfo = lstatSync(path); const device = rootInfo.dev, mount = mountId(path);
  if (process.getuid && rootInfo.uid !== process.getuid()) recoveryError("foreign file ownership");
  if (rootInfo.isFile()) { const bytes = hashFile(path, BACKUP_LIMITS.fileBytes, sync); return { device, inode: rootInfo.ino, kind: "file", ...bytes }; }
  if (!rootInfo.isDirectory()) recoveryError("symlink or special file");
  const tree = createHash("sha256"); let entries = 0, size = 0;
  const walk = (current: string, relative: string, depth: number) => {
    if (depth > 8) recoveryError("old attachment tree exceeds depth limit");
    for (const name of boundedNames(current, BACKUP_LIMITS.entries - entries)) {
      if (++entries > BACKUP_LIMITS.entries) recoveryError("old attachment tree exceeds entry limit");
      const file = join(current, name), stat = lstatSync(file), key = `${relative}/${name}`;
      if (stat.dev !== device || mountId(file) !== mount || (process.getuid && stat.uid !== process.getuid())) recoveryError("unsupported attachment mount or ownership");
      if (stat.isDirectory()) { tree.update(JSON.stringify([key, "directory"])); walk(file, key, depth + 1); }
      else if (stat.isFile()) { const bytes = hashFile(file, BACKUP_LIMITS.fileBytes, sync, true); size += bytes.size; if (size > BACKUP_LIMITS.totalBytes) recoveryError("old attachment tree exceeds byte limit"); tree.update(JSON.stringify([key, bytes])); }
      else recoveryError("symlink or special attachment file");
    }
    if (sync) syncDirectory(current);
  };
  walk(path, "", 0); return { device, inode: rootInfo.ino, kind: "directory", size, sha256: tree.digest("hex") };
}
function matches(path: string, expected: Identity): boolean {
  const stat = info(path); if (!stat || stat.dev !== expected.device || stat.ino !== expected.inode) return false;
  return JSON.stringify(identity(path)) === JSON.stringify(expected);
}
function targets(databasePath: string, attachmentDirectory: string): string[] {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`, `${databasePath}.initializing`, attachmentDirectory];
}
/** Device numbers alone do not detect same-device bind mounts or mounted files. */
function mountId(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = openSync(`/proc/self/fdinfo/${fd}`, constants.O_RDONLY);
    try {
      const buffer = Buffer.alloc(4096), count = readSync(metadata, buffer, 0, buffer.length, 0);
      if (count === buffer.length) throw new Error("Unsupported restore mount metadata size.");
      const id = buffer.subarray(0, count).toString("utf8").match(/^mnt_id:\s*(\d+)$/m)?.[1];
      if (!id) throw new Error("Unsupported restore filesystem mount inspection.");
      return id;
    } finally { closeSync(metadata); }
  } finally { closeSync(fd); }
}
function layout(databasePath: string, attachmentDirectory: string, roots: string[] = []): void {
  if (process.platform !== "linux") throw new Error("Unsupported restore filesystem platform; Linux local filesystems are required.");
  const parent = dirname(databasePath), device = statSync(parent).dev, mount = mountId(parent);
  for (const path of [parent, dirname(attachmentDirectory), ...roots]) {
    directory(path, true);
    if (statSync(path).dev !== device || mountId(path) !== mount || !localFilesystems.has(statfsSync(path).type)) throw new Error("Unsupported restore filesystem layout; all targets must use one supported local device.");
    syncDirectory(path); // Discover permission/fsync refusal before touching active data.
  }
  const attachment = resolve(attachmentDirectory), root = restoreRoot(databasePath);
  const reserved = [...targets(databasePath, attachmentDirectory).slice(0, 5), `${databasePath}.owner.lock`, root];
  if (attachment === parent || parent.startsWith(attachment + sep) || reserved.some(path => path === attachment || path.startsWith(attachment + sep) || attachment.startsWith(path + sep))) throw new Error("Unsupported restore path overlap.");
  for (const path of targets(databasePath, attachmentDirectory)) { const stat = info(path); if (stat && (stat.dev !== device || mountId(path) !== mount)) throw new Error("Unsupported restore filesystem layout (mounted target)."); }
}
function validateInstalled(journal: Journal): void {
  regularAndMatch(journal.databasePath, journal.manifest.database, true);
  const root = journal.attachmentDirectory;
  validateAttachmentFiles(root, journal.manifest.attachments, true);
  for (const sidecar of targets(journal.databasePath, root).slice(1, 5)) if (info(sidecar)) recoveryError("stale SQLite sidecar");
  validateSnapshot(journal.databasePath, journal.manifest);
}

/** Caller holds the canonical database ownership lock and has no SQLite connection. */
export function recoverOwnedRestore(databasePath: string): void {
  const root = restoreRoot(databasePath); if (!info(root)) return;
  const journal = readJournal(root, databasePath); if (journal.state === "verified") return;
  layout(databasePath, journal.attachmentDirectory, [root, join(root, "previous"), join(root, "new")]);
  const current = targets(databasePath, journal.attachmentDirectory);
  const moves = current.map((from, index) => ({ from, to: join(root, "previous", String(index)), identity: journal.previous[index] }));
  moves.push({ from: join(root, "new", "state.sqlite3"), to: databasePath, identity: journal.staged[0] });
  moves.push({ from: join(root, "new", "attachments"), to: journal.attachmentDirectory, identity: journal.staged[1] });
  // Check the complete plan before resuming, including earlier completed renames.
  for (let step = 0; step < moves.length; step++) {
    const move = moves[step], source = info(move.from), destination = info(move.to);
    if (step < 6 && move.identity === null) {
      const installStep = step === 0 ? 6 : step === 5 ? 7 : null;
      const installed = installStep !== null && (journal.completed > installStep || journal.intent === installStep) && source && matches(move.from, journal.staged[installStep - 6]);
      if (destination || (source && !installed)) recoveryError("unexpected old target");
      continue;
    }
    if (step < journal.completed) {
      if (!destination || !matches(move.to, move.identity!)) recoveryError("changed completed replacement");
      // Old source paths may now hold the new generation, checked by later moves.
      continue;
    }
    if (step === journal.completed && journal.intent === step && !source && destination && matches(move.to, move.identity!)) continue;
    // Before old targets are secured, new destinations may still hold old data.
    const destinationIsOld = step >= 6 && journal.completed < 6 && journal.previous[step === 6 ? 0 : 5] !== null && matches(move.to, journal.previous[step === 6 ? 0 : 5]!);
    if (!source || !matches(move.from, move.identity!) || (destination && !destinationIsOld)) recoveryError("missing or conflicting replacement files");
  }
  // Validate actual candidate bytes, wherever the interrupted rename put them.
  const candidateDatabase = info(moves[6].from) ? moves[6].from : databasePath;
  const candidateAttachments = info(moves[7].from) ? moves[7].from : journal.attachmentDirectory;
  regularAndMatch(candidateDatabase, journal.manifest.database, true);
  validateAttachmentFiles(candidateAttachments, journal.manifest.attachments, true);
  const remaining = ["manifest.json", ...(info(moves[6].from) ? ["state.sqlite3"] : []), ...(info(moves[7].from) ? ["attachments"] : [])].sort();
  if (JSON.stringify(boundedNames(join(root, "new"), 3)) !== JSON.stringify(remaining)
    || JSON.stringify(parseManifest(readBoundedJson(join(root, "new", "manifest.json"), BACKUP_LIMITS.manifestBytes, true))) !== JSON.stringify(journal.manifest)) recoveryError("changed private staging manifest or tree");
  validateSnapshot(candidateDatabase, journal.manifest);
  for (let step = journal.completed; step < moves.length; step++) {
    const move = moves[step]; journal.intent = step; writeJournal(root, journal);
    if (move.identity !== null && info(move.from)) {
      if (info(move.to) || !matches(move.from, move.identity!)) recoveryError("replacement identity changed");
      renameSync(move.from, move.to);
    }
    syncDirectory(dirname(move.from)); syncDirectory(dirname(move.to));
    journal.completed = step + 1; journal.intent = null; journal.state = stateFor(journal.completed); writeJournal(root, journal);
  }
  validateInstalled(journal);
  journal.state = "verified"; writeJournal(root, journal);
}

export function prepareOwnedRestore(sourceInput: string, databasePath: string, attachmentInput: string, actor: RestoreActor, expected?: { operationId: string; manifestHash: string }): string {
  const source = resolve(sourceInput); directory(source);
  const attachmentDirectory = join(privateDirectory(dirname(resolve(attachmentInput))), basename(attachmentInput));
  layout(databasePath, attachmentDirectory);
  // Archive only a completed operation. No pruning of previous generations in S3b.
  const root = restoreRoot(databasePath);
  const manifest = parseManifest(readBoundedJson(join(source, "manifest.json"), BACKUP_LIMITS.manifestBytes));
  if (expected && digest(manifest) !== expected.manifestHash) throw new Error("Restore backup changed since confirmation.");
  validateBackupFiles(source, manifest);
  if (manifest.attachments.length && !attachmentInput) throw new Error("Restore requires an attachment target.");
  ensureStagingCapacity(dirname(databasePath), manifest);
  const staging = mkdtempSync(join(dirname(databasePath), `.${basename(databasePath)}.restore-stage-`));
  let published = false;
  try {
    const next = join(staging, "new"); mkdirSync(next, { mode: 0o700 }); mkdirSync(join(staging, "previous"), { mode: 0o700 });
    const stagedManifest = stageVerifiedBackup(source, next, manifest); durableJson(join(next, "manifest.json"), stagedManifest);
    validateBackup(next, stagedManifest, true); syncTree(next);
    const previous = targets(databasePath, attachmentDirectory).map(path => info(path) ? identity(path, true) : null);
    const operationId = expected?.operationId ?? randomUUID();
    const journal: Journal = { formatVersion: 1, operationId, createdAt: new Date().toISOString(), databasePath, attachmentDirectory, actor: restoreActorSchema.parse(actor), sourceManifestHash: digest(manifest), manifest: stagedManifest, previous, staged: [identity(join(next, "state.sqlite3")), identity(join(next, "attachments"))], completed: 0, intent: null, state: "prepared" };
    writeJournal(staging, journal); syncDirectory(join(staging, "previous")); syncDirectory(staging);
    if (info(root)) {
      const previous = readJournal(root, databasePath);
      if (previous.state !== "verified") recoveryError("an unfinished operation already exists");
      const archive = `${root}-${previous.operationId}`;
      if (info(archive)) recoveryError("archive destination already exists");
      renameSync(root, archive); syncDirectory(dirname(root));
    }
    renameSync(staging, root); published = true; syncDirectory(dirname(root));
    return operationId;
  } finally { if (!published) rmSync(staging, { recursive: true, force: true }); }
}
export function getOwnedRestoreStatus(databasePath: string, requestedOperationId?: string): { operationId: string; state: Journal["state"]; actor: RestoreActor } | null {
  let root = restoreRoot(databasePath);
  if (requestedOperationId) {
    if (!z.uuid().safeParse(requestedOperationId).success) recoveryError("invalid operation identifier");
    const active = info(root) ? readJournal(root, databasePath) : null;
    if (active?.operationId !== requestedOperationId) root = `${root}-${requestedOperationId}`;
  }
  if (!info(root)) return null;
  const { operationId, state, actor } = readJournal(root, databasePath); return { operationId, state, actor };
}
