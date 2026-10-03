import { join } from "node:path";
import { z } from "zod";
import type { BackupActor, BackupOperations } from "./backup-operations";
import { BackupError, type BackupPolicy } from "./policy";
import { readRecord, recordHash, writeRecord } from "./records";
import type { RestoreOperation, RestorePreview } from "@/shared/contracts/backups";
import { backupCommandSchema } from "@/shared/contracts/backups";
import { executeControllerRestoreRequest, finishControllerRestoreRequest, getControllerRestoreRequestStatus, requestControllerRestoreAsync, type RestoreRequestPolicy } from "@/server/restore-requests";
import { restoreActorSchema, type RestoreActor } from "@/server/infrastructure/sqlite";
import { privateDirectory } from "@/server/private-storage";
import type { AuthenticationPolicy, AuthenticationStore } from "@/server/modules/authentication";
import type { IdentityStore } from "@/server/modules/identity";
import { BackupCatalog } from "./catalog";

const authenticationSchema = z.object({ mode: z.enum(["legacy", "open", "token", "better-auth"]), generation: z.number().int().nonnegative(), token: z.object({ id: z.uuid(), prefix: z.string(), verifierHash: z.string().regex(/^[0-9a-f]{64}$/), createdAt: z.iso.datetime() }).strict().nullable() }).strict();
const handoffSchema = z.object({ format: z.literal(1), actor: restoreActorSchema, operationId: z.uuid(), createdAt: z.iso.datetime(), state: z.enum(["requested", "maintenance", "executing", "verified", "interrupted", "failed"]), authentication: authenticationSchema.nullable(), local: z.boolean() }).strict();
export type RestoreHandoff = z.infer<typeof handoffSchema>;
const handoffPath = (database: string) => join(privateDirectory(`${database}.backup-operations`), "handoff.json");
const publicStatus = (record: RestoreHandoff): RestoreOperation => ({ operationId: record.operationId, backupId: record.actor.backupId, createdAt: record.createdAt, state: record.state });
const sameActor = (actor: BackupActor): string => typeof actor === "string" ? actor : `installation:${actor.credentialId}`;
/** Offline transports must not trust a replaced database before startup finishes its security fence. */
export function assertBackupHandoffCompleted(database: string): void {
  const record = readRecord(join(`${database}.backup-operations`, "handoff.json"), handoffSchema);
  if (record?.state === "executing") throw new Error("Start the controller to complete restore authentication recovery before offline administration.");
}
/** Read-only guard called under canonical ownership; does not run recovery. */
export function assertNoUnfinishedBackupHandoff(database: string): RestoreHandoff | null {
  const record = readRecord(join(`${database}.backup-operations`, "handoff.json"), handoffSchema);
  if (record && record.state !== "verified" && record.state !== "failed" && record.state !== "interrupted") throw new BackupError("backup_busy", 409);
  return record;
}
function executionPolicy(record: RestoreHandoff, policy: BackupPolicy, catalog: BackupCatalog): RestoreRequestPolicy {
  return {
    authorize(actorId, backupId) {
      if (record.actor.actorId !== actorId || record.actor.backupId !== backupId || (!record.local && (!policy.uiActions.includes("restore") || record.authentication?.mode !== "token" || record.actor.actorId !== `installation:${record.authentication.token?.id}`))) throw new BackupError("backup_forbidden", 403);
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
  if (!record.authentication) throw new Error("Missing restore authentication fence; preserve recovery material.");
  store.saveAuthenticationPolicy(record.authentication, "authentication.restore_fenced", "local-admin");
  for (const principal of store.listPrincipals()) {
    for (const credential of store.listPrincipalCredentials(principal.id)) store.revokeCredential(credential.id, new Date().toISOString(), "restore-fence");
  }
  record.state = "verified"; writeRecord(handoffPath(database), record);
}
export class RestoreOperations {
  private busy = false;
  private previewing = false;
  private pending: { actorId: string; backupId: string; key: string; promise: Promise<RestoreOperation> } | null = null;
  constructor(private readonly backups: BackupOperations, private readonly database: string, private readonly attachments: string, private readonly deps: {
    authentication: () => AuthenticationPolicy;
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
      const manifest = await this.backups.catalog.verifyAsync(id);
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
      const result = await this.pending.promise;
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
    const status = await requestControllerRestoreAsync(this.database, sameActor(actor), { backupId: input.backupId, idempotencyKey: input.idempotencyKey, confirmation: input.confirmation }, policy, () => this.backups.catalog.verifyAsync(input.backupId));
    this.backups.authorize(actor, "restore");
    this.backups.assertAdmission();
    if (status.state === "verified") return { ...status, state: "verified" };
    const record: RestoreHandoff = { format: 1, actor: { actorId: sameActor(actor), backupId: input.backupId, idempotencyKey: input.idempotencyKey }, operationId: status.operationId, createdAt: status.createdAt, state: "requested", authentication: null, local: actor === "local-admin" };
    writeRecord(handoffPath(this.database), record);
    this.busy = true; this.deps.enterMaintenance();
    return publicStatus(record);
  }
  /** Schedule only after HTTP/admin response completion (or disconnect). Admission is durable. */
  launch(actor: BackupActor, input: { backupId: string; idempotencyKey: string }): void {
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
