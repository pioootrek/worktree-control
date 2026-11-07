import { SecurityFenceError, securityRecoveryBoundary } from "../../infrastructure/sqlite";
import { admitWithRetry } from "@/server/database-admission";
import { join } from "node:path";
import { z } from "zod";
import type { BackupActor, BackupOperations } from "./backup-operations";
import { BackupError, type BackupPolicy } from "./policy";
import { readRecord, recordHash, writeRecord } from "./records";
import type { RestoreOperation, RestorePreview } from "@/shared/contracts/backups";
import { backupCommandSchema } from "@/shared/contracts/backups";
import { acknowledgeVerifiedControllerRestoreRequest, executeControllerRestoreRequest, finishControllerRestoreRequest, getControllerRestoreRequestStatus, requestControllerRestoreAsync, type RestoreRequestPolicy } from "@/server/restore-requests";
import { getOwnedRestoreStatus, restoreActorSchema, type RestoreActor } from "@/server/infrastructure/sqlite";
import { privateDirectory } from "@/server/private-storage";
import type { AuthenticationMode, AuthenticationPolicy, AuthenticationStore } from "@/server/modules/authentication";
import type { IdentityStore } from "@/server/modules/identity";
import { BackupCatalog } from "./catalog";

const authenticationSchema = z.object({ mode: z.enum(["legacy", "open", "token", "better-auth"]), generation: z.number().int().nonnegative(), token: z.object({ id: z.uuid(), prefix: z.string(), verifierHash: z.string().regex(/^[0-9a-f]{64}$/), createdAt: z.iso.datetime() }).strict().nullable() }).strict();
const handoffFields = {
  actor: restoreActorSchema, operationId: z.uuid(), createdAt: z.iso.datetime(),
  state: z.enum(["requested", "maintenance", "executing", "verified", "interrupted", "failed"]),
  authentication: authenticationSchema.nullable(), local: z.boolean(),
};
// Format 1 predates pending selections: its policy mode was also execution authority.
const handoffSchema = z.union([
  z.object({ format: z.literal(1), ...handoffFields }).strict(),
  z.object({ format: z.literal(2), ...handoffFields,
    executionMode: z.enum(["legacy", "open", "token", "better-auth"]),
  }).strict().superRefine((record, context) => {
    if (record.local !== (record.actor.actorId === "local-admin")
      || (record.authentication?.token && record.authentication.token.prefix !== `wsi_${record.authentication.token.id}`)
      || (["maintenance", "executing", "verified"].includes(record.state) && !record.authentication)
      || (!record.local && (record.executionMode !== "token"
        || (record.authentication !== null && record.actor.actorId !== `installation:${record.authentication?.token?.id}`)))) {
      context.addIssue({ code: "custom", message: "Invalid restore execution authority." });
    }
  }),
]);
export type RestoreHandoff = z.infer<typeof handoffSchema>;
const handoffPath = (database: string) => join(privateDirectory(`${database}.backup-operations`), "handoff.json");
const publicStatus = (record: RestoreHandoff): RestoreOperation => ({ operationId: record.operationId, backupId: record.actor.backupId, createdAt: record.createdAt, state: record.state });
const sameActor = (actor: BackupActor): string => typeof actor === "string" ? actor : `installation:${actor.credentialId}`;
/** A restore handoff awaits completion by controller startup; distinct from an unreadable record. */
export class BackupHandoffPendingError extends Error {
  constructor() {
    super("Start the controller to complete restore authentication recovery before offline administration.");
    this.name = "BackupHandoffPendingError";
  }
}
/** Offline transports must not trust a replaced database before startup finishes its security fence. */
export function assertBackupHandoffCompleted(database: string): void {
  const record = readRecord(join(`${database}.backup-operations`, "handoff.json"), handoffSchema);
  if (record?.state === "executing") throw new BackupHandoffPendingError();
}
/** Read-only guard called under canonical ownership; does not run recovery. */
export function assertNoUnfinishedBackupHandoff(database: string): RestoreHandoff | null {
  const record = readRecord(join(`${database}.backup-operations`, "handoff.json"), handoffSchema);
  if (record && record.state !== "verified" && record.state !== "failed" && record.state !== "interrupted") throw new BackupError("backup_busy", 409);
  return record;
}
/** Protected maintenance may acknowledge only a completely verified matching move. */
export function preflightSecurityRecoveryHandoff(database:string):RestoreHandoff|null {
  const record=readRecord(join(`${database}.backup-operations`,"handoff.json"),handoffSchema);
  if(record?.state!=="executing") return assertNoUnfinishedBackupHandoff(database);
  const journal=getOwnedRestoreStatus(database);
  if(!journal || journal.state!=="verified" || journal.operationId!==record.operationId) throw new BackupError("backup_invalid");
  return record;
}
/** Only called after protected quarantine. Never rewrites the captured authentication policy. */
export function acknowledgeRecoveredBackupHandoff(database: string): void {
  const record = preflightSecurityRecoveryHandoff(database);
  if (record?.state !== "executing") return;
  const journal = getOwnedRestoreStatus(database);
  if (!journal || journal.state !== "verified" || journal.operationId !== record.operationId) throw new BackupError("backup_invalid");
  acknowledgeVerifiedControllerRestoreRequest(database,record.actor,record.operationId);
  record.state = "verified";
  writeRecord(handoffPath(database), record);
}
function executionPolicy(record: RestoreHandoff, policy: BackupPolicy, catalog: BackupCatalog): RestoreRequestPolicy {
  return {
    authorize(actorId, backupId) {
      if (record.actor.actorId !== actorId || record.actor.backupId !== backupId || (!record.local && (!policy.uiActions.includes("restore") || (record.format === 1 ? record.authentication?.mode : record.executionMode) !== "token" || record.actor.actorId !== `installation:${record.authentication?.token?.id}`))) throw new BackupError("backup_forbidden", 403);
    },
    resolveBackup: id => catalog.path(id),
  };
}

/** Called under the controller lock before opening ordinary SQLite. */
export function recoverBackupHandoff(database: string, attachments: string, policy: BackupPolicy): RestoreHandoff | null {
  const path = handoffPath(database), record = readRecord(path, handoffSchema);
  if (!record) return null;
  if (record.state === "executing") {
    const catalog = new BackupCatalog(policy.directory, privateDirectory(`${database}.backup-operations`));
    executeControllerRestoreRequest(database, attachments, record.actor, executionPolicy(record, policy, catalog));
    return record; // Security fence must finish before any listener is constructed.
  }
  if (record.state === "requested" || record.state === "maintenance") { record.state = "interrupted"; writeRecord(path, record); }
  if (record.state === "failed" || record.state === "interrupted") finishControllerRestoreRequest(database, record.actor, record.operationId, record.state);
  return null;
}
/** Replay after crash is safe; completion comes after all credential invalidation. */
export function finishBackupHandoff(database: string, record: RestoreHandoff, store: AuthenticationStore & Pick<IdentityStore, "listPrincipals" | "listPrincipalCredentials" | "revokeCredential">): void {
  const fence=securityRecoveryBoundary(database);
  if(!fence || fence.restore!==record.operationId) throw new SecurityFenceError("security_fence_recovery_required");
  // Reading the policy also checks this store's exact checkpoint. The captured
  // pre-restore token/policy remains historical handoff evidence, never new authority.
  store.getAuthenticationPolicy();
  const current=preflightSecurityRecoveryHandoff(database);
  if(!current || current.operationId!==record.operationId || current.state!=="verified") throw new SecurityFenceError("security_fence_recovery_required");
}
export class RestoreOperations {
  private busy = false;
  private previewing = false;
  private pending: { actorId: string; backupId: string; key: string; promise: Promise<RestoreOperation> } | null = null;
  constructor(private readonly backups: BackupOperations, private readonly database: string, private readonly attachments: string, private readonly deps: {
    authentication: () => AuthenticationPolicy;
    /** Immutable active boot mode; configured policy is captured separately at launch. */
    executionMode: () => AuthenticationMode;
    enterMaintenance: () => void;
    restart: (execute: () => void) => Promise<void>;
    failure: (error: unknown) => void;
  }) {}
  async preview(actor: BackupActor, id: string): Promise<RestorePreview> {
    this.backups.authorize(actor, "restore");
    this.backups.assertAdmission();
    if (this.busy || this.previewing || this.pending) throw new BackupError("backup_busy", 503);
    this.previewing = true;
    try {
      // Verification hashes the copy; it holds no database admission. Authority is reread afterwards.
      const manifest = await this.backups.admission.idle(() => this.backups.catalog.verifyAsync(id));
      this.backups.authorize(actor, "restore");
      this.backups.assertAdmission();
      if (recordHash(manifest) !== recordHash(this.backups.catalog.manifest(id))) throw new BackupError("backup_invalid");
      const backup = this.backups.catalog.list().find(copy => copy.id === id);
      if (!backup) throw new BackupError("backup_invalid");
      return { backup: { ...backup, verification: "verified" }, scope: "entire-installation", invalidatesScopedCredentials: true, stopsManagedProcessesAndTests: true };
    } finally { this.previewing = false; }
  }
  async admit(actor: BackupActor, value: unknown): Promise<RestoreOperation> {
    const input = backupCommandSchema.parse(value);
    if (input.action !== "restore") throw new BackupError("backup_invalid");
    this.backups.authorize(actor, "restore");
    const previous = readRecord(handoffPath(this.database), handoffSchema);
    const same = previous && previous.actor.actorId === sameActor(actor) && previous.actor.idempotencyKey === input.idempotencyKey;
    if (same && previous.actor.backupId !== input.backupId) throw new BackupError("backup_invalid");
    if (same && previous.state !== "interrupted" && previous.state !== "failed") return publicStatus(previous);
    this.backups.assertAdmission();
    if (this.pending) {
      if (this.pending.actorId !== sameActor(actor) || this.pending.key !== input.idempotencyKey) throw new BackupError("backup_busy", 503);
      if (this.pending.backupId !== input.backupId) throw new BackupError("backup_invalid");
      const pending = this.pending.promise;
      const result = await this.backups.admission.idle(() => pending);
      this.backups.authorize(actor, "restore");
      return result;
    }
    if (this.busy || this.previewing) throw new BackupError("backup_busy", 503);
    const promise = this.admitVerified(actor, input);
    this.pending = { actorId: sameActor(actor), backupId: input.backupId, key: input.idempotencyKey, promise };
    try { return await promise; } finally { this.pending = null; }
  }
  private async admitVerified(actor: BackupActor, input: Extract<z.infer<typeof backupCommandSchema>, { action: "restore" }>): Promise<RestoreOperation> {
    const previous = readRecord(handoffPath(this.database), handoffSchema);
    if (previous?.state === "failed" || previous?.state === "interrupted") finishControllerRestoreRequest(this.database, previous.actor, previous.operationId, previous.state);
    const policy = this.requestPolicy(actor);
    const status = await requestControllerRestoreAsync(this.database, sameActor(actor), { backupId: input.backupId, idempotencyKey: input.idempotencyKey, confirmation: input.confirmation }, policy, () => this.backups.admission.idle(() => this.backups.catalog.verifyAsync(input.backupId)));
    this.backups.authorize(actor, "restore");
    this.backups.assertAdmission();
    if (status.state === "verified") return { ...status, state: "verified" };
    const record: RestoreHandoff = { format: 2, executionMode: this.deps.executionMode(), actor: { actorId: sameActor(actor), backupId: input.backupId, idempotencyKey: input.idempotencyKey }, operationId: status.operationId, createdAt: status.createdAt, state: "requested", authentication: null, local: actor === "local-admin" };
    writeRecord(handoffPath(this.database), record);
    this.busy = true; this.deps.enterMaintenance();
    return publicStatus(record);
  }
  /**
   * Schedule only after HTTP/admin response completion (or disconnect). Admission is durable.
   * Response callbacks are detached, so the fence is read under its own admission.
   */
  launch(actor: BackupActor, input: { backupId: string; idempotencyKey: string }): void {
    if (!this.busy) return;
    void admitWithRetry(this.backups.admission, () => this.launchAdmitted(actor, input), { reserved: true }).catch(error => this.deps.failure(error));
  }
  private launchAdmitted(actor: BackupActor, input: { backupId: string; idempotencyKey: string }): void {
    if (!this.busy) return;
    const record = readRecord(handoffPath(this.database), handoffSchema);
    if (!record || record.state !== "requested") return;
    record.state = "maintenance";
    try {
      this.backups.authorize(actor, "restore");
      record.authentication = this.deps.authentication();
      writeRecord(handoffPath(this.database), record);
    } catch (error) { record.state = "failed"; writeRecord(handoffPath(this.database), record); finishControllerRestoreRequest(this.database, record.actor, record.operationId, "failed"); this.deps.failure(error); return; }
    void this.deps.restart(() => {
      // Every async drain completed; no auth/admin write can now race this fence.
      record.state = "executing"; writeRecord(handoffPath(this.database), record);
      executeControllerRestoreRequest(this.database, this.attachments, { ...record.actor, backupId: input.backupId, idempotencyKey: input.idempotencyKey }, executionPolicy(record, this.backups.policy, this.backups.catalog));
    }).catch(error => {
      // `executing` stays replayable through S3b; do not erase recovery evidence.
      if (record.state !== "executing") { record.state = "failed"; writeRecord(handoffPath(this.database), record); finishControllerRestoreRequest(this.database, record.actor, record.operationId, "failed"); }
      this.deps.failure(error);
    });
  }
  status(actor: BackupActor, backupId: string, key: string): RestoreOperation {
    this.backups.authorize(actor);
    const identity: RestoreActor = { actorId: sameActor(actor), backupId, idempotencyKey: key };
    let status;
    try { status = getControllerRestoreRequestStatus(this.database, identity, this.requestPolicy(actor, false)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BackupError("backup_invalid", 404);
      throw error;
    }
    const handoff = readRecord(handoffPath(this.database), handoffSchema);
    return handoff?.operationId === status.operationId ? publicStatus(handoff) : { ...status };
  }
  private requestPolicy(actor: BackupActor, action = true): RestoreRequestPolicy {
    return { authorize: actorId => { if (actorId !== sameActor(actor)) throw new BackupError("backup_forbidden", 403); this.backups.authorize(actor, action ? "restore" : undefined); if (action) this.backups.assertAdmission(); }, resolveBackup: id => this.backups.catalog.path(id) };
  }
}
