import { lstatSync, realpathSync, unlinkSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { readBoundedJson } from "@/server/infrastructure/sqlite";
import { syncDirectory, validatePrivateDirectory } from "@/server/private-storage";
import { artifactSchema } from "./user-export-artifact";
import { readRecord, recordHash, writeRecord } from "./records";
import type { Execution } from "./user-schedules";
import { UserBackupError, type UserBackupPolicy } from "./user-policy";

const identitySchema = z.object({ dev: z.number(), ino: z.number(), uid: z.number(), mode: z.number(), size: z.number(), mtimeMs: z.number(), birthtimeMs: z.number() }).strict();
const directorySchema = identitySchema.pick({ dev: true, ino: true, uid: true, mode: true });
const snapshotSchema = z.object({ executionId: z.uuid(), binding: z.string().length(64), directory: directorySchema, file: identitySchema, checksum: z.string().length(64), staging: z.boolean() }).strict();
const recoverySchema = snapshotSchema.extend({ confirmation: z.string().length(64), phase: z.enum(["publication", "pending", "completed"]) }).strict();
const ledgerSchema = z.object({ format: z.literal(1), entries: z.array(recoverySchema).max(2048) }).strict();
const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("preview"), executionId: z.uuid() }).strict(),
  z.object({ action: z.literal("cleanup"), executionId: z.uuid(), confirmation: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
type Snapshot = z.infer<typeof snapshotSchema>;
type Entry = z.infer<typeof recoverySchema>;
const fileIdentity = (stat: Stats) => ({ dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs });
const parentIdentity = (stat: Stats) => ({ dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode });
function statOptional(path: string): Stats | null {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function refuse(): never { throw new UserBackupError("changed", 409); }
function privateOwned(stat: Stats): boolean { return (!process.getuid || stat.uid === process.getuid()) && !(stat.mode & 0o077); }

/** Operator recovery journal, outside mutation receipts and SQLite restore. No independent locks. */
export class UserExportRecovery {
  private readonly path: string;
  private ledger: z.infer<typeof ledgerSchema>;
  unavailable = false;
  constructor(recordDirectory: string, private readonly policy: UserBackupPolicy, private readonly executions: () => readonly Execution[]) {
    this.path = join(recordDirectory, "user-export-recovery.json");
    this.ledger = readRecord(this.path, ledgerSchema) ?? { format: 1, entries: [] };
    if (new Set(this.ledger.entries.map(value => value.executionId)).size !== this.ledger.entries.length) refuse();
  }
  protected(id: string): boolean {
    const entry = this.entry(id);
    if (entry?.phase === "pending") return true;
    const execution = this.executions().find(value => value.executionId === id);
    const target = execution && this.policy.targets.find(value => value.id === execution.configuration.targetId);
    return Boolean(entry && entry.phase === "publication" && target && statOptional(join(target.directory, `.user-export-${id}.partial`)));
  }
  charge(execution: Execution): number {
    const entry = this.entry(execution.executionId);
    // The saved physical charge survives an absent but not durably settled unlink.
    return Math.max(statOptional(execution.destination)?.size ?? 0, entry?.phase === "pending" ? entry.file.size : 0);
  }
  checkRequest(input: unknown): void {
    const parsed = commandSchema.safeParse(input); if (!parsed.success) throw new UserBackupError("invalid");
    if (parsed.data.action !== "list") this.execution(parsed.data.executionId);
  }
  command(input: unknown): unknown {
    this.checkRequest(input);
    const command = commandSchema.parse(input);
    if (command.action === "list") return this.executions().filter(value => value.state === "failed" || value.state === "interrupted").map(value => {
      try { return this.preview(value); }
      catch { return { executionId: value.executionId, ownerId: value.configuration.ownerId, state: value.state, eligible: false }; }
    });
    const execution = this.execution(command.executionId);
    if (command.action === "preview") return this.preview(execution);
    let entry = this.entry(execution.executionId);
    if (entry?.phase === "completed") {
      if (entry.confirmation !== command.confirmation) refuse();
      return this.result(execution, entry);
    }
    if (entry?.phase === "pending") {
      if (entry.confirmation !== command.confirmation) refuse();
      this.remaining(execution, entry);
    } else {
      const snapshot = this.inspect(execution);
      if (recordHash(snapshot) !== command.confirmation) refuse();
      entry = { ...snapshot, confirmation: command.confirmation, phase: "pending" };
      this.put(entry); // Durable intent precedes any unlink. Failed fsync fences new work.
    }
    const { parent, destination, staging } = this.paths(execution);
    // Every surviving name is checked before each unlink; absence needs the saved intent.
    this.remaining(execution, entry);
    if (statOptional(staging)) { unlinkSync(staging); syncDirectory(parent); }
    this.remaining(execution, entry);
    if (statOptional(destination)) { unlinkSync(destination); syncDirectory(parent); }
    syncDirectory(parent);
    this.remaining(execution, entry);
    if (statOptional(destination) || statOptional(staging)) refuse();
    entry = { ...entry, phase: "completed" };
    this.put(entry); // Charge changes only after this durable boundary.
    return this.result(execution, entry);
  }
  /** Pin new publication identity before linking final name; historical exports use operator preview. */
  recordPublication(execution: Execution, staging: string): void {
    const paths = this.paths(execution);
    if (paths.staging !== staging || statOptional(paths.destination)) refuse();
    const snapshot = this.snapshot(execution, staging, true);
    const stat = lstatSync(staging); if (stat.nlink !== 1) refuse();
    this.put({ ...snapshot, confirmation: recordHash(snapshot), phase: "publication" });
  }
  private execution(id: string): Execution {
    const execution = this.executions().find(value => value.executionId === id);
    if (!execution) throw new UserBackupError("invalid", 404);
    if (execution.state !== "failed" && execution.state !== "interrupted") throw new UserBackupError("changed", 409);
    return execution;
  }
  private entry(id: string): Entry | undefined { return this.ledger.entries.find(value => value.executionId === id); }
  private paths(execution: Execution): { parent: string; destination: string; staging: string } {
    const config = execution.configuration;
    const target = this.policy.targets.find(value => value.id === config.targetId);
    if (!target || config.scope !== "knowledge-discussions") throw new UserBackupError("policy", 403);
    const parent = resolve(target.directory);
    if (realpathSync(parent) !== parent) refuse(); // No directory aliases, including ancestor symlinks.
    validatePrivateDirectory(parent);
    const stat = lstatSync(parent); if (!stat.isDirectory() || !privateOwned(stat)) refuse();
    const destination = join(parent, `user-export-${execution.executionId}.json`);
    if (execution.destination !== destination) refuse();
    return { parent, destination, staging: join(parent, `.user-export-${execution.executionId}.partial`) };
  }
  private binding(execution: Execution): string {
    return recordHash({ executionId: execution.executionId, configuration: execution.configuration, dueAt: execution.dueAt, destination: execution.destination, deadline: execution.deadline });
  }
  private snapshot(execution: Execution, path: string, staging: boolean): Snapshot {
    const paths = this.paths(execution), before = lstatSync(path);
    if (!before.isFile() || !privateOwned(before)) refuse();
    const envelope = z.object({ payload: artifactSchema, sha256: z.string() }).strict().parse(readBoundedJson(path, 4 * 1024 ** 2, true, true));
    const artifact = envelope.payload, config = execution.configuration, checksum = recordHash(artifact);
    if (envelope.sha256 !== checksum || (execution.hash !== null && execution.hash !== checksum)
      || artifact.ownerId !== config.ownerId || artifact.scope !== config.scope || artifact.projectId !== config.projectId || artifact.targetId !== config.targetId
      || artifact.scheduleId !== config.id || artifact.version !== config.version || artifact.executionId !== execution.executionId || artifact.dueAt !== new Date(execution.dueAt).toISOString()) refuse();
    const after = lstatSync(path);
    if (recordHash(fileIdentity(before)) !== recordHash(fileIdentity(after)) || before.nlink !== after.nlink) refuse();
    return { executionId: execution.executionId, binding: this.binding(execution), directory: parentIdentity(lstatSync(paths.parent)), file: fileIdentity(after), checksum, staging };
  }
  private inspect(execution: Execution): Snapshot {
    const { destination, staging } = this.paths(execution), final = lstatSync(destination), alias = statOptional(staging);
    if (alias && (!alias.isFile() || alias.dev !== final.dev || alias.ino !== final.ino)) refuse();
    if (final.nlink !== (alias ? 2 : 1)) refuse();
    const snapshot = this.snapshot(execution, destination, Boolean(alias));
    const entry = this.entry(execution.executionId);
    if (entry && (entry.binding !== snapshot.binding || recordHash(entry.directory) !== recordHash(snapshot.directory) || recordHash(entry.file) !== recordHash(snapshot.file) || entry.checksum !== snapshot.checksum)) refuse();
    return snapshot;
  }
  private remaining(execution: Execution, entry: Entry): void {
    const paths = this.paths(execution);
    if (entry.binding !== this.binding(execution) || recordHash(entry.directory) !== recordHash(parentIdentity(lstatSync(paths.parent)))) refuse();
    const final = statOptional(paths.destination), alias = statOptional(paths.staging);
    if (alias && !entry.staging) refuse();
    const count = Number(Boolean(final)) + Number(Boolean(alias));
    for (const [path, stat] of [[paths.destination, final], [paths.staging, alias]] as const) {
      if (!stat) continue;
      if (!stat.isFile() || stat.nlink !== count || recordHash(fileIdentity(stat)) !== recordHash(entry.file)) refuse();
      const snapshot = this.snapshot(execution, path, Boolean(alias));
      if (snapshot.checksum !== entry.checksum || recordHash(snapshot.file) !== recordHash(entry.file)) refuse();
    }
  }
  private preview(execution: Execution): unknown {
    const entry = this.entry(execution.executionId);
    if (entry && entry.phase !== "publication") {
      if (entry.phase === "pending") this.remaining(execution, entry);
      return this.result(execution, entry);
    }
    const snapshot = this.inspect(execution);
    return { executionId: execution.executionId, ownerId: execution.configuration.ownerId, scheduleId: execution.configuration.id, projectId: execution.configuration.projectId, targetId: execution.configuration.targetId, state: execution.state, eligible: true, bytes: snapshot.file.size, staging: snapshot.staging, confirmation: recordHash(snapshot) };
  }
  private result(execution: Execution, entry: Entry): unknown {
    return { executionId: execution.executionId, ownerId: execution.configuration.ownerId, state: entry.phase, executionState: execution.state, bytes: entry.file.size, confirmation: entry.confirmation, eligible: entry.phase === "pending" };
  }
  private put(entry: Entry): void {
    const live = new Set(this.executions().map(value => value.executionId));
    // Pending intents are never retired. Publication evidence is pinned by execution pruning.
    const entries = this.ledger.entries.filter(value => value.executionId !== entry.executionId && (live.has(value.executionId) || value.phase === "pending"));
    if (entries.length >= 2048) throw new UserBackupError("limit", 409);
    const ledger = { format: 1 as const, entries: [...entries, entry] };
    try { writeRecord(this.path, ledger); this.ledger = ledger; }
    catch (error) { this.unavailable = true; throw error; }
  }
}
