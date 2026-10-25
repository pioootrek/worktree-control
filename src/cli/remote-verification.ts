import { LinuxWorkerRecoveryHost } from "@/server/infrastructure/git";
import { openRemoteRecoveryInspection } from "@/server/infrastructure/sqlite";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { AppPaths } from "@/server/paths";
import { acquireControllerLock } from "@/server/controller-lock";
import { SqliteStateStore } from "@/server/sqlite-store";
import { cliCredential, OWNER_CREDENTIAL_VARIABLES, OWNER_CREDENTIAL_REQUIRED } from "./credentials";
import { authenticateOfflineActor } from "./offline-actor";
import { WorkerRecoveryService, remoteDependencySetupSchema, remotePreparationTimeoutSchema } from "@/server/modules/remote-verification";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const remoteName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const absolutePath = z.string().refine(isAbsolute, "Absolute path required");
const mapping = z.object({ projectId: identifier, localProjectId: identifier, sourceCachePath: absolutePath, sourceRemote: remoteName, presetIds: z.array(identifier).min(1).max(16),
  dependencySetup: remoteDependencySetupSchema.optional(), preparationTimeoutMs: remotePreparationTimeoutSchema.optional(),
}).strict();
const listener = z.object({
  host: z.string().min(1), port: z.number().int().min(1).max(65535),
  keyFile: absolutePath.optional(), certFile: absolutePath.optional(), allowLoopbackHttpFixture: z.boolean().default(false),
}).strict().superRefine((input, context) => {
  if (!!input.keyFile !== !!input.certFile || !input.keyFile && !(input.allowLoopbackHttpFixture && ["127.0.0.1", "::1"].includes(input.host))) context.addIssue({ code: "custom", message: "TLS required except explicit loopback HTTP fixture" });
});
export const remoteVerificationConfigSchema = z.object({
  version: z.literal(1),
  listener: listener.optional(),
  worker: z.object({
    workerId: identifier, origin: z.string().url(), tokenFile: absolutePath,
    workspaceRoot: absolutePath, allowLoopbackHttpFixture: z.boolean().default(false), mappings: z.array(mapping).min(1).max(16),
  }).strict().optional(),
}).strict().refine(value => value.listener || value.worker, "A listener or outbound worker is required");
export type RemoteVerificationConfig = z.infer<typeof remoteVerificationConfigSchema>;

/** Reject shared or symlinked credential files rather than silently repairing permissions. */
export function readRemoteWorkerToken(path: string): string {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.mode & 0o077 || typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error("Worker token must be in an owner-only regular file.");
  if (metadata.size > 1024) throw new Error("Invalid worker token file.");
  const token = readFileSync(path, "utf8").trim();
  if (!/^wts_[0-9a-f-]{36}_[0-9a-f]{64}$/.test(token)) throw new Error("Invalid worker token file.");
  return token;
}
export function loadRemoteVerificationConfig(path: string | undefined): RemoteVerificationConfig | null {
  if (!path) return null;
  try { return remoteVerificationConfigSchema.parse(JSON.parse(readFileSync(path, "utf8"))); }
  catch { throw new Error("Invalid remote verification configuration."); }
}

const provisionSchema = z.object({
  project: z.object({ id: identifier, name: z.string().min(1).max(120), sourceRemote: remoteName }).strict(),
  worker: z.object({ id: identifier, name: z.string().min(1).max(120), principalId: identifier.optional() }).strict(),
  localProjectId: identifier, presetIds: z.array(identifier).min(1).max(16),
  callerPrincipalIds: z.array(identifier).max(16),
  workerTokenFile: absolutePath.optional(),
}).strict();

/** Local owner-only provisioning; the singleton lock refuses writes to a running controller. */
export async function runRemoteVerificationCommand(args: string[], paths: AppPaths, write: (line: string) => void = console.log): Promise<void> {
  const option = (name: string) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name}.`); return args[i + 1]!; };
  const action = args[0];
  if (!["provision", "revoke-token", "inspect", "reconcile"].includes(action)) throw new Error("Usage: remote-verification provision --file FILE | revoke-token --credential-id ID | inspect [--attempt-id ID] | reconcile --attempt-id ID --operation-id ID");
  if (action === "inspect" || action === "reconcile") {
    const expected = action === "inspect" ? ["--attempt-id"] : ["--attempt-id", "--operation-id"];
    for (let i = 1; i < args.length; i += 2) {
      if (!expected.includes(args[i]) || !args[i + 1] || args.indexOf(args[i]) !== i) throw new Error("invalid_recovery_arguments");
    }
    const attemptId = action === "reconcile" || args.includes("--attempt-id") ? identifier.parse(option("--attempt-id")) : null;
    const operationId = action === "reconcile" ? identifier.parse(option("--operation-id")) : null;
    const lock = acquireControllerLock(paths.controllerLockPath);
    try {
      if (action === "inspect") {
        const inspection = openRemoteRecoveryInspection(paths.databasePath);
        try {
          const credential = cliCredential(process.env, OWNER_CREDENTIAL_VARIABLES);
          if (!credential) throw new Error(OWNER_CREDENTIAL_REQUIRED);
          const actor = inspection.identity.authenticateBearer(credential);
          const recovery = new WorkerRecoveryService(inspection.connection, new LinuxWorkerRecoveryHost(paths.databasePath), inspection.identity);
          write(JSON.stringify(attemptId ? recovery.inspect(attemptId, actor) : recovery.inspectAll(actor)));
        } finally { inspection.close(); }
      } else {
        const store = new SqliteStateStore(paths.databasePath);
        try {
          const { identity, actor } = authenticateOfflineActor(store, cliCredential(process.env, OWNER_CREDENTIAL_VARIABLES), OWNER_CREDENTIAL_REQUIRED);
          const recovery = new WorkerRecoveryService(store.remoteConnection, new LinuxWorkerRecoveryHost(paths.databasePath), identity);
          write(JSON.stringify(recovery.reconcile(attemptId!, operationId!, actor)));
        } finally { store.close(); }
      }
    } finally { lock.release(); }
    return;
  }
  const input = action === "provision" ? provisionSchema.parse(JSON.parse(readFileSync(option("--file"), "utf8"))) : null;
  const lock = acquireControllerLock(paths.controllerLockPath);
  let store: SqliteStateStore | null = null;
  try {
    store = new SqliteStateStore(paths.databasePath);
    const { identity, actor } = authenticateOfflineActor(store, cliCredential(process.env, OWNER_CREDENTIAL_VARIABLES), OWNER_CREDENTIAL_REQUIRED);
    identity.requireOwnerSession(actor);
    if (action === "revoke-token") {
      identity.revokeCredential(option("--credential-id"), actor);
      write(JSON.stringify({ revoked: true })); return;
    }
    const config = input!;
    if (!store.getProject(config.localProjectId)) throw new Error("Registered local project required.");
    for (const id of config.callerPrincipalIds) {
      const principal = store.getPrincipal(id);
      if (!principal || !["owner", "agent"].includes(principal.kind) || principal.status !== "active") throw new Error("Active owner or agent caller required.");
    }
    const existingWorker = store.getRemoteWorker(config.worker.id);
    const principal = config.worker.principalId ? store.getPrincipal(config.worker.principalId) : existingWorker ? store.getPrincipal(existingWorker.principalId) : null;
    if (config.worker.principalId && principal && principal.kind !== "worker") throw new Error("Worker principal required.");
    let workerPrincipalId: string;
    if (principal) workerPrincipalId = principal.id;
    else if (config.worker.principalId) {
      // Import the broker's stable worker identity on a separate worker installation.
      workerPrincipalId = config.worker.principalId;
      store.savePrincipal({ id: workerPrincipalId, kind: "worker", status: "active" }, actor.principalId);
    } else workerPrincipalId = identity.createWorker(actor).id;
    const result = store.remoteConnection.atomic(() => {
      store!.saveRemoteProjectIdentity({ ...config.project, status: "active" }, actor.principalId);
      store!.saveRemoteWorker({ id: config.worker.id, name: config.worker.name, principalId: workerPrincipalId, status: "active", lastContactAt: null }, actor.principalId);
      store!.saveRemoteWorkerProjectGrant({ workerId: config.worker.id, projectId: config.project.id, localProjectId: config.localProjectId, presetIds: config.presetIds, revokedAt: null }, actor.principalId);
      for (const principalId of config.callerPrincipalIds) store!.saveRemotePrincipalProjectGrant({ principalId, projectId: config.project.id, permissions: ["submit", "read"], revokedAt: null }, actor.principalId);
      return config.workerTokenFile ? identity.issueWorkerToken({ principalId: workerPrincipalId, label: `remote-verification:${config.worker.id}`.slice(0, 120) }, actor) : null;
    });
    if (result && config.workerTokenFile) {
      try { writeFileSync(resolve(config.workerTokenFile), `${result.token}\n`, { mode: 0o600, flag: "wx" }); }
      catch { identity.revokeCredential(result.credential.id, actor); throw new Error("Worker token file could not be created; new credential revoked."); }
    }
    write(JSON.stringify({ projectId: config.project.id, workerId: config.worker.id, workerPrincipalId, credentialId: result?.credential.id ?? null }));
  } finally { store?.close(); lock.release(); }
}
