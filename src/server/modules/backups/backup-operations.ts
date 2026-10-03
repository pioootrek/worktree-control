import { protectedControllerRestoreBackupIds } from "@/server/restore-requests";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, rmSync, statfsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { BackupOperation, BackupOverview } from "@/shared/contracts/backups";
import { backupKeySchema } from "@/shared/contracts/backups";
import type { AuthenticatedPrincipal } from "@/server/modules/identity";
import { createControllerBackup } from "@/server/controller-backup";
import { privateDirectory, syncDirectory } from "@/server/private-storage";
import { BackupCatalog, manifestBytes } from "./catalog";
import { BackupError, backupPolicySchema, type BackupPolicy } from "./policy";
import { readRecord, recordHash, writeRecord } from "./records";
import { RemoteBackups } from "./remote-backups";
import type { RemoteBackupTransport } from "./remote-policy";
import type { BackupMonitorMetadata } from "./monitor";

const operationSchema = z.object({
  operationId: z.uuid(), backupId: z.string(), actorId: z.string(), key: backupKeySchema,
  state: z.enum(["queued", "running", "succeeded", "failed", "interrupted"]),
  createdAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(),
  error: z.enum(["backup_failed", "backup_interrupted", "backup_limit"]).nullable(),
  destination: z.string(), scheduled: z.boolean(), manifestHash: z.string().nullable(),
  // Do not default during parsing: defaults would change historical signed ledger payloads.
  remoteRequired: z.boolean().optional(),
}).strict();
type Operation = z.infer<typeof operationSchema>;
const MANUAL_HISTORY_LIMIT = 1024;
// Maximum retained copies, recent retired deadlines and pending operations.
const SERVICE_HISTORY_LIMIT = 1000 + 50 + 32;
const ledgerSchema = z.object({ format: z.literal(1), nextAt: z.number().nullable(), intervalSeconds: z.number().nullable(), scheduledThrough: z.number().nullable().default(null), scheduleError: z.enum(["backup_failed", "backup_limit"]).nullable().default(null), retention: z.enum(["idle", "succeeded", "failed"]), operations: z.array(operationSchema).max(MANUAL_HISTORY_LIMIT + SERVICE_HISTORY_LIMIT) }).strict();
type Ledger = z.infer<typeof ledgerSchema>;
export type BackupActor = AuthenticatedPrincipal | "local-admin" | "scheduler";
export interface BackupDependencies {
  databasePath: string; attachmentDirectory: string; applicationVersion: string;
  source: { backup: (destination: string, options?: { progress: () => number }) => Promise<void> };
  estimateBytes: () => number;
  authorize: (actor: AuthenticatedPrincipal) => boolean;
  maintenance: () => boolean;
  manageSchedule?: boolean;
  clock?: () => number;
  remoteTransport?: RemoteBackupTransport;
}
const publicOperation = ({ operationId, backupId, state, createdAt, finishedAt, error }: Operation): BackupOperation => ({ operationId, backupId, state, createdAt, finishedAt, error });
const actorId = (actor: BackupActor) => typeof actor === "string" ? actor : `installation:${actor.credentialId}`;

/** One bounded executor for service, web and local administration. No SQLite ownership here. */
export class BackupOperations {
  readonly policy: BackupPolicy;
  readonly catalog: BackupCatalog;
  readonly recordDirectory: string;
  readonly remote: RemoteBackups;
  private readonly path: string;
  private ledger: Ledger;
  private persistenceFailed = false;
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly actors = new Map<string, BackupActor>();
  private readonly exports: Array<{ ownerId: string; execute: () => Promise<void>; interrupt: () => void; settled?: () => void }> = [];
  private exportOwner: string | null = null;
  private readonly now: () => number;
  constructor(policy: BackupPolicy, private readonly deps: BackupDependencies) {
    this.policy = backupPolicySchema.parse(policy);
    Object.freeze(this.policy.uiActions); Object.freeze(this.policy);
    this.now = deps.clock ?? Date.now;
    this.recordDirectory = privateDirectory(`${deps.databasePath}.backup-operations`);
    this.path = join(this.recordDirectory, "ledger.json");
    this.catalog = new BackupCatalog(this.policy.directory, this.recordDirectory, this.policy.maxBytes, this.policy.timeoutSeconds);
    this.ledger = readRecord(this.path, ledgerSchema) ?? { format: 1, nextAt: null, intervalSeconds: null, scheduledThrough: null, scheduleError: null, retention: "idle", operations: [] };
    for (const operation of this.ledger.operations) {
      if (operation.state !== "queued" && operation.state !== "running") continue;
      operation.state = "interrupted"; operation.error = "backup_interrupted"; operation.finishedAt = this.iso();
      // An interrupted receipt after S3 publication may be reconciled, never recreated.
      if (existsSync(operation.destination)) {
        try {
          const manifest = this.catalog.verifyPath(operation.destination);
          operation.state = "succeeded"; operation.error = null; operation.manifestHash = recordHash(manifest);
        } catch { /* Preserve interruption; leave unrecognized material intact. */ }
      }
    }
    if (this.deps.manageSchedule !== false) {
      if (this.policy.intervalSeconds === null) this.ledger.nextAt = null;
      else if (this.ledger.intervalSeconds !== this.policy.intervalSeconds || this.ledger.nextAt === null) this.ledger.nextAt = this.now() + this.policy.intervalSeconds * 1000;
      this.ledger.intervalSeconds = this.policy.intervalSeconds;
    }
    this.save();
    this.remote = new RemoteBackups(deps.remoteTransport, {
      directory: this.policy.directory, recordDirectory: this.recordDirectory, catalog: this.catalog, now: this.now,
      maintenance: deps.maintenance,
      retired: backupId => !this.ledger.operations.some(operation => operation.backupId === backupId),
      unrecorded: () => this.ledger.operations.filter(operation => operation.remoteRequired && operation.state === "succeeded" && !this.remote.hasReceipt(operation.backupId)).length,
      enqueue: (execute, interrupt, settled) => this.enqueueExport("installation-transfer", 1, execute, interrupt, settled),
    });
  }
  authorize(actor: BackupActor, action?: "create" | "restore"): void {
    if (typeof actor === "string") return;
    if (actor.authenticationMethod !== "installation_token" || !this.deps.authorize(actor) || (action && !this.policy.uiActions.includes(action))) throw new BackupError("backup_forbidden", 403);
  }
  assertAdmission(): void {
    if (this.closed || this.persistenceFailed || this.deps.maintenance()) throw new BackupError("backup_busy", 503);
  }
  /** User exports share this executor and capacity; they never enter the test queue. */
  enqueueExport(ownerId: string, ownerLimit: number, execute: () => Promise<void>, interrupt: () => void, settled?: () => void): void {
    this.assertAdmission();
    const backups = this.ledger.operations.filter(value => value.state === "queued" || value.state === "running").length;
    if (backups + this.exports.length + (this.exportOwner ? 1 : 0) >= this.policy.queueLimit
      || this.exports.filter(value => value.ownerId === ownerId).length + (this.exportOwner === ownerId ? 1 : 0) >= ownerLimit) throw new BackupError("backup_limit", 409);
    this.exports.push({ ownerId, execute, interrupt, settled }); this.pump();
  }
  overview(actor: BackupActor): BackupOverview {
    this.authorize(actor);
    const { directory, ...policy } = this.policy;
    const protectedIds = this.protectedIds();
    const copies = this.catalog.list().map(copy => {
      const record = this.ledger.operations.find(operation => operation.backupId === copy.id && operation.state === "succeeded");
      if (!record) return { ...copy, protected: true };
      try { if (record.manifestHash !== recordHash(this.catalog.manifest(copy.id))) return { ...copy, verification: "failed" as const, protected: true }; }
      catch { return { ...copy, verification: "failed" as const, protected: true }; }
      return { ...copy, verification: "verified" as const, protected: !record.scheduled || protectedIds.has(copy.id) };
    });
    return { policy: { ...policy, destinationConfigured: Boolean(directory) }, schedule: { nextAt: this.ledger.nextAt === null ? null : new Date(this.ledger.nextAt).toISOString(), lastOperation: this.lastScheduled(), error: this.ledger.scheduleError, retention: this.ledger.retention }, maintenance: this.deps.maintenance(), copies, operations: this.ledger.operations.slice(-50).reverse().map(publicOperation) };
  }
  /** CLI-only metadata; no catalog scan, manifest hydration, paths, identities or keys. */
  monitorMetadata(): BackupMonitorMetadata {
    const records = this.ledger.operations.filter(operation => this.policy.directory && operation.destination === join(this.policy.directory, operation.backupId));
    const latest = records.at(-1), successful = records.findLast(operation => operation.state === "succeeded");
    let dataAt = successful?.createdAt ?? null;
    let error: BackupMonitorMetadata["local"]["error"] = this.persistenceFailed ? "metadata_unavailable" : this.ledger.scheduleError ?? (this.ledger.retention === "failed" ? "retention_failed" : null);
    if (successful) {
      try {
        const directory = lstatSync(successful.destination), manifest = lstatSync(join(successful.destination, "manifest.json")), database = lstatSync(join(successful.destination, "state.sqlite3"));
        if (!directory.isDirectory() || !manifest.isFile() || !database.isFile()
          || [directory, manifest, database].some(stat => (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))) throw new Error("Missing or unsafe recorded copy.");
      } catch { dataAt = null; error = "metadata_unavailable"; }
    }
    const remote = this.remote.status();
    return { format: 1, observedAt: this.iso(), scheduleEnabled: this.policy.intervalSeconds !== null, maintenance: this.deps.maintenance(),
      local: { dataAt, lastAttempt: latest ? { dataAt: latest.createdAt, state: latest.state, error: latest.error } : null, error },
      remote: { enabled: remote.enabled, dataAt: remote.enabled ? remote.lastConfirmed?.dataAt ?? null : null, confirmedAt: remote.enabled ? remote.lastConfirmed?.confirmedAt ?? null : null, pending: remote.pending, error: remote.error } };
  }
  create(actor: BackupActor, key: string, destination?: string): BackupOperation {
    this.authorize(actor, "create"); backupKeySchema.parse(key);
    const previous = this.ledger.operations.find(operation => operation.actorId === actorId(actor) && operation.key === key);
    if (previous) {
      if (destination && resolve(destination) !== previous.destination) throw new BackupError("backup_invalid");
      return publicOperation(previous);
    }
    this.assertAdmission();
    if (!destination && !this.policy.directory) throw new BackupError("backup_invalid");
    if (destination && actor !== "local-admin") throw new BackupError("backup_forbidden", 403);
    if (!destination && this.remote.enabled) {
      const reserved = this.ledger.operations.filter(value => value.remoteRequired && !this.remote.hasReceipt(value.backupId) && (value.state === "queued" || value.state === "running" || value.state === "succeeded")).length;
      this.remote.assertCapacity(reserved);
    }
    const scheduledAt = actor === "scheduler" && /^service:[0-9]+$/.test(key) ? Number(key.slice(8)) : null;
    if (actor === "scheduler" && (scheduledAt === null || scheduledAt <= (this.ledger.scheduledThrough ?? -1))) throw new BackupError("backup_invalid", 409);
    this.pruneScheduledHistory();
    const scheduled = actor === "scheduler";
    if (this.ledger.operations.filter(operation => operation.scheduled === scheduled).length >= (scheduled ? SERVICE_HISTORY_LIMIT : MANUAL_HISTORY_LIMIT) || this.ledger.operations.filter(operation => operation.state === "queued" || operation.state === "running").length + this.exports.length + (this.exportOwner ? 1 : 0) >= this.policy.queueLimit) throw new BackupError("backup_limit", 409);
    const id = `backup-${randomUUID()}`;
    const operation: Operation = { operationId: randomUUID(), backupId: id, actorId: actorId(actor), key, state: "queued", createdAt: this.iso(), finishedAt: null, error: null, destination: destination ? resolve(destination) : join(this.policy.directory!, id), scheduled: actor === "scheduler", manifestHash: null, remoteRequired: !destination && this.remote.enabled };
    this.ledger.operations.push(operation);
    if (scheduledAt !== null) this.ledger.scheduledThrough = scheduledAt;
    try { this.save(); } catch {
      operation.state = "interrupted"; operation.error = "backup_interrupted"; operation.finishedAt = this.iso();
      this.persistenceFailed = true; throw new BackupError("backup_failed", 503);
    }
    this.actors.set(operation.operationId, actor);
    this.pump(); return publicOperation(operation);
  }
  status(actor: BackupActor, key: string): BackupOperation {
    this.authorize(actor); backupKeySchema.parse(key);
    const operation = this.ledger.operations.find(operation => operation.actorId === actorId(actor) && operation.key === key);
    if (!operation) throw new BackupError("backup_invalid", 404);
    return publicOperation(operation);
  }
  start(): void {
    this.reconcileRemote(); this.remote.start();
    if (this.deps.manageSchedule !== false && this.policy.intervalSeconds !== null && !this.closed) { try { this.tick(); } catch { this.ledger.scheduleError = "backup_failed"; } this.arm(); }
  }
  /** At most one overdue admission; advancing the deadline never depends on manual creation. */
  tick(): void {
    if (this.deps.manageSchedule === false || this.closed || this.deps.maintenance() || this.policy.intervalSeconds === null || this.ledger.nextAt === null || this.now() < this.ledger.nextAt) return;
    const deadline = this.ledger.nextAt;
    this.ledger.nextAt = this.now() + this.policy.intervalSeconds * 1000;
    this.save();
    try { this.create("scheduler", `service:${deadline}`); this.ledger.scheduleError = null; this.save(); }
    catch (error) {
      this.ledger.scheduleError = error instanceof BackupError && error.code === "backup_limit" ? "backup_limit" : "backup_failed"; this.save();
    }
  }
  async drain(): Promise<void> { while (this.active) await this.active; }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = null;
    for (const task of this.exports.splice(0)) task.interrupt();
    for (const operation of this.ledger.operations) if (operation.state === "queued") { operation.state = "interrupted"; operation.error = "backup_interrupted"; operation.finishedAt = this.iso(); }
    try { this.save(); } finally { await this.remote.close(); await this.catalog.close(); await this.drain(); }
  }
  private pump(): void {
    if (this.active || this.closed || this.persistenceFailed) return;
    const operation = this.ledger.operations.find(value => value.state === "queued" && value.scheduled)
      ?? this.ledger.operations.find(value => value.state === "queued");
    if (!operation) {
      const task = this.exports.shift(); if (!task) return;
      this.exportOwner = task.ownerId;
      this.active = Promise.resolve().then(task.execute).catch(() => { this.persistenceFailed = true; }).finally(() => { this.active = null; this.exportOwner = null; this.pump(); task.settled?.(); });
      return;
    }
    const actor = this.actors.get(operation.operationId);
    this.active = this.execute(operation, actor).finally(() => { this.active = null; this.actors.delete(operation.operationId); this.pump(); });
  }
  private async execute(operation: Operation, actor: BackupActor | undefined): Promise<void> {
    try {
      if (!actor || this.deps.maintenance()) throw new BackupError("backup_busy");
      this.authorize(actor, "create");
      operation.state = "running"; this.save();
      const deadline = this.now() + this.policy.timeoutSeconds * 1000;
      const estimate = this.deps.estimateBytes();
      const current = this.catalog.list().reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
      const parent = privateDirectory(resolve(operation.destination, ".."));
      const disk = statfsSync(parent);
      if (estimate + current > this.policy.maxBytes || disk.bavail * disk.bsize < estimate + 16 * 1024 ** 2) throw new BackupError("backup_limit");
      const manifest = await createControllerBackup(this.deps.source, operation.destination, { applicationVersion: this.deps.applicationVersion, attachmentDirectory: this.deps.attachmentDirectory, maxBytes: this.policy.maxBytes - current, deadline, now: this.now });
      operation.manifestHash = recordHash(manifest); operation.state = "succeeded"; operation.error = null;
    } catch (error) { operation.state = "failed"; operation.error = error instanceof BackupError && error.code === "backup_limit" ? "backup_limit" : "backup_failed"; }
    operation.finishedAt = this.iso();
    try { this.save(); } catch { operation.state = "failed"; operation.error = "backup_failed"; this.persistenceFailed = true; return; }
    if (operation.state === "succeeded") { this.reconcileRemote(); this.remote.tick(); }
    if (operation.state === "succeeded" && operation.scheduled && this.policy.intervalSeconds !== null && !this.closed) {
      try { await this.retain(); this.ledger.retention = "succeeded"; }
      catch { this.ledger.retention = "failed"; }
      try { this.save(); } catch { this.ledger.retention = "failed"; this.persistenceFailed = true; }
    }
  }
  private async retain(): Promise<void> {
    const protectedIds = this.protectedIds();
    const records = this.ledger.operations.filter(value => value.scheduled && value.state === "succeeded").sort((a,b) => b.createdAt.localeCompare(a.createdAt));
    for (const [index, operation] of records.entries()) {
      if (protectedIds.has(operation.backupId) || this.catalog.verifyingIds.has(operation.backupId) || !this.policy.directory || operation.destination !== join(this.policy.directory, operation.backupId) || !existsSync(operation.destination)) continue;
      if (index < this.policy.retainCount && Date.parse(operation.createdAt) >= this.now() - this.policy.retainDays * 86400 * 1000) continue;
      const stat = lstatSync(operation.destination);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BackupError("backup_invalid");
      const manifest = await this.catalog.verifyAsync(operation.backupId);
      if (this.closed || this.protectedIds().has(operation.backupId)) continue;
      const current = lstatSync(this.catalog.path(operation.backupId));
      if (current.dev !== stat.dev || current.ino !== stat.ino || recordHash(this.catalog.manifest(operation.backupId)) !== recordHash(manifest)) throw new BackupError("backup_invalid");
      if (recordHash(manifest) !== operation.manifestHash || manifestBytes(manifest) > this.policy.maxBytes) throw new BackupError("backup_invalid");
      rmSync(operation.destination, { recursive: true }); syncDirectory(this.policy.directory);
    }
  }
  private protectedIds(): Set<string> {
    const ids = protectedControllerRestoreBackupIds(this.deps.databasePath);
    for (const id of this.remote.protectedIds()) ids.add(id);
    for (const operation of this.ledger.operations) if (operation.remoteRequired && operation.state === "succeeded" && !this.remote.hasReceipt(operation.backupId)) ids.add(operation.backupId);
    const last = [...this.ledger.operations].reverse().find(value => value.state === "succeeded");
    const scheduled = [...this.ledger.operations].reverse().find(value => value.scheduled && value.state === "succeeded");
    if (last) ids.add(last.backupId);
    if (scheduled) ids.add(scheduled.backupId);
    return ids;
  }

  private lastScheduled(): BackupOperation | null { const last = [...this.ledger.operations].reverse().find(value => value.scheduled); return last ? publicOperation(last) : null; }
  private reconcileRemote(): void {
    if (!this.remote.enabled) return;
    for (const operation of this.ledger.operations) {
      if (!operation.remoteRequired || operation.state !== "succeeded" || !operation.manifestHash || this.remote.hasReceipt(operation.backupId)) continue;
      // Keep local success separate. An unsaved or invalid remote intent stays pinned.
      try { this.remote.record(operation.backupId, operation.manifestHash, operation.createdAt); } catch { break; }
    }
  }
  private pruneScheduledHistory(): void {
    // The persisted high-water mark prevents replay after pruning old service deadlines.
    const recent = new Set(this.ledger.operations.slice(-50).map(value => value.operationId));
    this.ledger.operations = this.ledger.operations.filter(value => !value.scheduled || recent.has(value.operationId) || value.state === "queued" || value.state === "running" || existsSync(value.destination));
  }
  private iso(): string { return new Date(this.now()).toISOString(); }
  private save(): void { writeRecord(this.path, this.ledger); }
  private arm(): void {
    if (this.closed || this.policy.intervalSeconds === null) return;
    this.timer = setTimeout(() => { try { this.tick(); } catch { this.ledger.scheduleError = "backup_failed"; } this.arm(); }, Math.min(60_000, Math.max(1, (this.ledger.nextAt ?? this.now()) - this.now())));
    this.timer.unref();
  }
}
