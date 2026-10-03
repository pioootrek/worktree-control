import { randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AuthenticatedPrincipal } from "@/server/modules/identity";
import { privateDirectory, syncDirectory } from "@/server/private-storage";
import { userScheduleCommandSchema, userScheduleInputSchema, type ScheduleReason, type UserExportResult, type UserSchedule, type UserScheduleCommand, type UserScheduleOverview } from "@/shared/contracts/user-backups";
import { artifactSchema } from "./user-export-artifact";
import { UserExportRecovery } from "./user-export-recovery";
import { BackupOperations } from "./backup-operations";
import { BackupError } from "./policy";
import { readRecord, recordHash, writeRecord } from "./records";
import { UserBackupError, userBackupPolicySchema, type UserBackupPolicy } from "./user-policy";

const actorSchema = z.object({ principalId: z.string(), principalKind: z.enum(["owner", "agent", "worker", "installation"]), credentialId: z.string(), authenticationMethod: z.enum(["owner_session", "agent_token", "worker_token", "installation_token", "none"]) }).strict();
const reasonSchema = z.enum(["disabled", "forbidden", "policy", "limit", "busy", "changed", "failed", "interrupted"]);
const scheduleSchema = userScheduleInputSchema.extend({ id: z.uuid(), ownerId: z.string(), version: z.number().int().positive(), nextAt: z.number().nullable(), actor: actorSchema, restoreGeneration: z.string(), reason: reasonSchema.nullable(), retention: z.enum(["idle", "succeeded", "failed"]) }).strict();
const executionSchema = z.object({ executionId: z.uuid(), configuration: scheduleSchema, dueAt: z.number(), deadline: z.number().nullable(), state: z.enum(["queued", "running", "succeeded", "failed", "interrupted", "denied"]), reason: reasonSchema.nullable(), finishedAt: z.string().nullable(), destination: z.string(), hash: z.string().nullable(), bytes: z.number().nonnegative() }).strict();
const mutationSchema = z.object({ ownerId: z.string(), key: z.string(), hash: z.string(), response: scheduleSchema }).strict();
const ledgerSchema = z.object({ format: z.literal(1), schedules: z.array(scheduleSchema).max(256), executions: z.array(executionSchema).max(2048), mutations: z.array(mutationSchema).max(1024) }).strict();
type Schedule = z.infer<typeof scheduleSchema>;
export type Execution = z.infer<typeof executionSchema>;

const ARTIFACT_MAX = 4 * 1024 ** 2 - 4096;
export interface UserScheduleDependencies {
  authorize: (actor: AuthenticatedPrincipal, projectId?: string) => void;
  projectName: (projectId: string) => string | null;
  exportDiscussions: (projectId: string, maxBytes: number) => Record<string, unknown>;
  clock?: () => number;
  restoreGeneration?: () => string;
}

/** Durable application schedules; SQLite restore never rewinds this deadline ledger. */
export class UserSchedules {
  readonly policy: UserBackupPolicy;
  private ledger: z.infer<typeof ledgerSchema>;
  private readonly path: string;
  private readonly now: () => number;
  private readonly recovery: UserExportRecovery;
  private closed = false;
  private broken = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(policy: UserBackupPolicy, private readonly backups: BackupOperations, private readonly deps: UserScheduleDependencies) {
    this.policy = userBackupPolicySchema.parse(policy);
    for (const target of this.policy.targets) Object.freeze(target);
    Object.freeze(this.policy.targets); Object.freeze(this.policy.projects); Object.freeze(this.policy);
    this.now = deps.clock ?? Date.now;
    this.path = join(backups.recordDirectory, "user-schedules.json");
    this.ledger = readRecord(this.path, ledgerSchema) ?? { format: 1, schedules: [], executions: [], mutations: [] };
    this.recovery = new UserExportRecovery(backups.recordDirectory, this.policy, () => this.ledger.executions);
    for (const execution of this.ledger.executions) {
      if (execution.state !== "queued" && execution.state !== "running") continue;
      execution.state = "interrupted"; execution.reason = "interrupted"; execution.finishedAt = this.iso();
      // A visible complete publication is recovered only under current policy and authority.
      try {
        if (execution.deadline === null || this.now() >= execution.deadline) throw new UserBackupError("limit");
        this.validate(execution.configuration); const artifact = this.readArtifact(execution);
        syncDirectory(this.target(execution.configuration));
        execution.hash = recordHash(artifact); execution.bytes = lstatSync(execution.destination).size;
        execution.state = "succeeded"; execution.reason = null;
      } catch { /* Preserve interruption and all unrecognized evidence. */ }
    }
    this.save();
  }
  private authenticate(actor: AuthenticatedPrincipal): void {
    if (!((actor.principalKind === "owner" && actor.authenticationMethod === "owner_session") || (actor.principalKind === "agent" && actor.authenticationMethod === "agent_token"))) throw new UserBackupError("forbidden", 403);
    try { this.deps.authorize(actor); } catch { throw new UserBackupError("forbidden", 403); }
  }
  private validate(schedule: Schedule): void {
    this.authenticate(schedule.actor);
    if (schedule.restoreGeneration !== (this.deps.restoreGeneration?.() ?? "")) throw new UserBackupError("forbidden", 403);
    if (!this.policy.enabled || !this.policy.scopes.includes(schedule.scope) || !this.policy.projects.includes(schedule.projectId) || !this.policy.targets.some(value => value.id === schedule.targetId)
      || schedule.intervalSeconds < this.policy.minIntervalSeconds || schedule.retainCount > this.policy.retainCount || schedule.retainDays > this.policy.retainDays
      || this.ledger.schedules.filter(value => value.ownerId === schedule.ownerId).length > this.policy.maxSchedules) throw new UserBackupError("policy", 403);
    try { this.deps.authorize(schedule.actor, schedule.projectId); } catch { throw new UserBackupError("forbidden", 403); }
  }
  private admission(): void {
    if (this.closed || this.broken || this.recovery.unavailable) throw new UserBackupError("busy", 503);
    try { this.backups.assertAdmission(); } catch { throw new UserBackupError("busy", 503); }
  }
  overview(actor: AuthenticatedPrincipal): UserScheduleOverview {
    this.authenticate(actor);
    const { targets, projects, ...policy } = this.policy;
    const allowed = projects.flatMap(id => {
      if (!policy.enabled) return [];
      try { this.deps.authorize(actor, id); const name = this.deps.projectName(id); return name ? [{ id, name }] : []; } catch { return []; }
    });
    const schedules = this.ledger.schedules.filter(value => value.ownerId === actor.principalId).map(value => this.publicSchedule(value, actor));
    return { policy, projects: allowed, targets: policy.enabled && allowed.length ? targets.map(value => value.id) : [], schedules,
      artifacts: this.ledger.executions.filter(value => value.configuration.ownerId === actor.principalId && this.canRead(value.configuration, actor)).slice(-50).reverse().map(value => this.result(value)), maintenance: this.isBusy() };
  }
  command(actor: AuthenticatedPrincipal, input: UserScheduleCommand): UserSchedule | Record<string, unknown> {
    this.authenticate(actor);
    const parsed = userScheduleCommandSchema.safeParse(input); if (!parsed.success) throw new UserBackupError("invalid");
    const command = parsed.data;
    if (this.broken) throw new UserBackupError("busy", 503);
    if (command.action === "artifact") {
      const execution = this.ledger.executions.find(value => value.executionId === command.executionId && value.configuration.ownerId === actor.principalId);
      if (!execution || execution.state !== "succeeded" || !this.canRead(execution.configuration, actor)) throw new UserBackupError("forbidden", 403);
      return this.readArtifact(execution);
    }
    const receipt = this.ledger.mutations.find(value => value.ownerId === actor.principalId && value.key === command.idempotencyKey);
    if (command.action === "status") {
      if (!receipt) throw new UserBackupError("invalid", 404);
      if (!this.canRead(receipt.response, actor)) throw new UserBackupError("forbidden", 403);
      return this.publicSchedule(receipt.response, actor);
    }
    if (receipt) {
      if (receipt.hash !== recordHash(command)) throw new UserBackupError("changed", 409);
      if (!this.canRead(receipt.response, actor)) throw new UserBackupError("forbidden", 403);
      return this.publicSchedule(receipt.response, actor);
    }
    this.admission();
    const existing = this.ledger.schedules.find(value => value.id === command.id);
    if (existing && existing.ownerId !== actor.principalId) throw new UserBackupError("forbidden", 403);
    if ((existing?.version ?? 0) !== command.version) throw new UserBackupError("changed", 409);
    if (this.ledger.mutations.length >= 1024 || (!existing && (this.ledger.schedules.length >= 256 || this.ledger.schedules.filter(value => value.ownerId === actor.principalId).length >= this.policy.maxSchedules))) throw new UserBackupError("limit", 409);
    const schedule: Schedule = { ...command.configuration, id: command.id, ownerId: actor.principalId, actor: { ...actor }, restoreGeneration: this.deps.restoreGeneration?.() ?? "", version: command.version + 1, nextAt: command.configuration.enabled ? this.now() + command.configuration.intervalSeconds * 1000 : null, reason: null, retention: "idle" };
    this.validate(schedule);
    if (existing) this.ledger.schedules[this.ledger.schedules.indexOf(existing)] = schedule; else this.ledger.schedules.push(schedule);
    this.ledger.mutations.push({ ownerId: actor.principalId, key: command.idempotencyKey, hash: recordHash(command), response: { ...schedule } });
    this.save(); return this.publicSchedule(schedule, actor);
  }
  /** Local operator authority is supplied only by the private admin transport. */
  recover(actor: import("./backup-operations").BackupActor, input: unknown): Promise<unknown> {
    if (actor !== "local-admin") return Promise.reject(new UserBackupError("forbidden", 403));
    try { this.admission(); this.recovery.checkRequest(input); }
    catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      try {
        this.backups.enqueueExport("local-admin:user-recovery", 1, async () => {
          try { this.admission(); resolve(this.recovery.command(input)); } catch (error) { reject(error); }
        }, () => reject(new UserBackupError("busy", 503)));
      } catch (error) { reject(error); }
    });
  }
  start(): void { if (this.policy.enabled && !this.closed) { try { this.tick(); } catch { this.broken = true; } this.arm(); } }
  tick(): void {
    if (!this.policy.enabled || this.closed || this.broken || this.isBusy()) return;
    for (const schedule of this.ledger.schedules) {
      if (!schedule.enabled || schedule.nextAt === null || schedule.nextAt > this.now()) continue;
      const dueAt = schedule.nextAt;
      schedule.nextAt = this.now() + schedule.intervalSeconds * 1000;
      // Bound outcomes while retaining every extant artifact and the recent 50 results.
      const recent = new Set(this.ledger.executions.slice(-50).map(value => value.executionId));
      const latest = new Map(this.ledger.executions.map(value => [value.configuration.id, value.executionId]));
      const lastResults = new Set(latest.values());
      this.ledger.executions = this.ledger.executions.filter(value => lastResults.has(value.executionId) || recent.has(value.executionId) || value.state === "queued" || value.state === "running" || existsSync(value.destination) || this.recovery.protected(value.executionId));
      if (this.ledger.executions.length >= 2048) { schedule.reason = "limit"; this.save(); continue; }
      const executionId = randomUUID();
      const execution: Execution = { executionId, configuration: { ...schedule, actor: { ...schedule.actor } }, dueAt, deadline: null, state: "queued", reason: null, finishedAt: null,
        destination: this.policy.targets.find(value => value.id === schedule.targetId) ? join(this.target(schedule), `user-export-${executionId}.json`) : "", hash: null, bytes: 0 };
      this.ledger.executions.push(execution); this.save();
      try {
        this.validate(schedule); this.admission();
        this.backups.enqueueExport(schedule.ownerId, this.policy.queueLimit, () => this.execute(execution), () => { this.finish(execution, "interrupted", "interrupted"); });
        schedule.reason = null;
      } catch (error) { this.finish(execution, "denied", this.reason(error)); schedule.reason = execution.reason; }
      this.save();
    }
  }
  /** Stop timers first; the owning S4a executor drains or interrupts accepted jobs. */
  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private async execute(execution: Execution): Promise<void> {
    const config = execution.configuration;
    let staging: string | null = null;
    try {
      this.admission(); this.validate(config);
      const current = this.ledger.schedules.find(value => value.id === config.id);
      if (!current?.enabled || current.version !== config.version) throw new UserBackupError("changed", 409);
      const deadline = this.now() + this.policy.timeoutSeconds * 1000;
      execution.deadline = deadline; execution.state = "running"; this.save();
      const artifact = { format: 1 as const, source: "user-schedule" as const, ownerId: config.ownerId, scope: config.scope, projectId: config.projectId, targetId: config.targetId, scheduleId: config.id, version: config.version, executionId: execution.executionId, dueAt: new Date(execution.dueAt).toISOString(), data: this.deps.exportDiscussions(config.projectId, Math.min(this.policy.maxBytes, ARTIFACT_MAX)) };
      const bytes = Buffer.byteLength(JSON.stringify({ payload: artifact, sha256: recordHash(artifact) }));
      const used = this.ledger.executions.filter(value => value.configuration.ownerId === config.ownerId && value !== execution).reduce((sum, value) => sum + this.recovery.charge(value), 0);
      if (bytes > ARTIFACT_MAX || used + bytes > this.policy.maxBytes) throw new UserBackupError("limit", 409);
      const parent = privateDirectory(this.target(config)); const disk = statfsSync(parent);
      if (disk.bavail * disk.bsize < bytes + 16 * 1024 ** 2) throw new UserBackupError("limit", 409);
      staging = join(parent, `.user-export-${execution.executionId}.partial`);
      if (this.now() >= deadline) throw new UserBackupError("limit", 409);
      writeRecord(staging, artifact);
      this.validate(config); this.admission();
      if (this.now() >= deadline) throw new UserBackupError("limit", 409);
      this.recovery.recordPublication(execution, staging);
      linkSync(staging, execution.destination); syncDirectory(parent);
      rmSync(staging); staging = null; syncDirectory(parent);
      if (this.now() >= deadline) throw new UserBackupError("limit", 409);
      execution.hash = recordHash(artifact); execution.bytes = bytes;
      this.finish(execution, "succeeded", null);
      if (current.enabled && current.version === config.version && !this.closed) {
        try { this.retain(current); current.retention = "succeeded"; } catch { current.retention = "failed"; }
        this.save();
      }
    } catch (error) { this.finish(execution, "failed", this.reason(error)); }
    finally { /* Uncertain staging/publication evidence is reclaimed only by the operator protocol. */ }
  }
  private retain(schedule: Schedule): void {
    const records = this.ledger.executions.filter(value => value.state === "succeeded" && value.configuration.id === schedule.id && value.configuration.ownerId === schedule.ownerId && value.configuration.projectId === schedule.projectId && value.configuration.targetId === schedule.targetId && value.hash && existsSync(value.destination)).sort((a, b) => b.dueAt - a.dueAt);
    for (const [index, execution] of records.entries()) {
      if (index === 0 || (index < schedule.retainCount && execution.dueAt >= this.now() - schedule.retainDays * 86400_000)) continue;
      this.validate(schedule); this.readArtifact(execution);
      rmSync(execution.destination); syncDirectory(this.target(schedule));
    }
  }
  private readArtifact(execution: Execution): Record<string, unknown> {
    const config = execution.configuration;
    if (execution.destination !== join(this.target(config), `user-export-${execution.executionId}.json`)) throw new UserBackupError("policy", 403);
    const artifact = readRecord(execution.destination, artifactSchema);
    if (!artifact || artifact.source !== "user-schedule" || artifact.ownerId !== config.ownerId || artifact.projectId !== config.projectId || artifact.scope !== config.scope || artifact.targetId !== config.targetId || artifact.scheduleId !== config.id || artifact.version !== config.version || artifact.executionId !== execution.executionId || artifact.dueAt !== new Date(execution.dueAt).toISOString() || (execution.hash !== null && recordHash(artifact) !== execution.hash)) throw new UserBackupError("failed");
    return artifact;
  }
  private canRead(schedule: Schedule, actor: AuthenticatedPrincipal): boolean { try { this.validate({ ...schedule, actor, restoreGeneration: this.deps.restoreGeneration?.() ?? "" }); return schedule.ownerId === actor.principalId; } catch { return false; } }
  private publicSchedule(schedule: Schedule, actor: AuthenticatedPrincipal): UserSchedule {
    const { actor: storedActor, restoreGeneration, nextAt, ...config } = schedule;
    void storedActor; void restoreGeneration;
    let reason: ScheduleReason | null = this.broken ? "busy" : schedule.enabled ? schedule.reason : "disabled";
    try { this.validate({ ...schedule, actor }); if (schedule.enabled) this.validate(schedule); } catch (error) { reason = this.reason(error); }
    const last = [...this.ledger.executions].reverse().find(value => value.configuration.id === schedule.id);
    return { ...config, nextAt: nextAt === null ? null : new Date(nextAt).toISOString(), reason, lastResult: last && this.canRead(last.configuration, actor) ? this.result(last) : null };
  }
  private result(execution: Execution): UserExportResult { return { executionId: execution.executionId, scheduleId: execution.configuration.id, version: execution.configuration.version, dueAt: new Date(execution.dueAt).toISOString(), state: execution.state, reason: execution.reason, finishedAt: execution.finishedAt, artifactAvailable: execution.state === "succeeded" && existsSync(execution.destination) }; }
  private finish(execution: Execution, state: Execution["state"], reason: ScheduleReason | null): void { execution.state = state; execution.reason = reason; execution.finishedAt = this.iso(); this.save(); }
  private target(schedule: Schedule): string { const target = this.policy.targets.find(value => value.id === schedule.targetId); if (!target) throw new UserBackupError("policy", 403); return target.directory; }
  private reason(error: unknown): ScheduleReason { if (error instanceof UserBackupError && error.code !== "invalid") return error.code; if (error instanceof BackupError) return error.code === "backup_limit" ? "limit" : "busy"; return "failed"; }
  private iso(): string { return new Date(this.now()).toISOString(); }
  private isBusy(): boolean { try { this.admission(); return false; } catch { return true; } }
  private save(): void { try { writeRecord(this.path, this.ledger); } catch (error) { this.broken = true; throw error; } }
  private arm(): void { if (this.closed) return; this.timer = setTimeout(() => { try { this.tick(); } catch { this.broken = true; } this.arm(); }, 1000); this.timer.unref(); }
}
