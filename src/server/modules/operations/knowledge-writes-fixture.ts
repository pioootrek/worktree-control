import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileProviderConfiguration } from "@/server/authentication-provider-configuration";
import { createControllerOperationEligibility } from "@/server/bootstrap/authentication-provider-lifetime";
import { AuthenticationRequestBudget } from "@/server/bootstrap/authentication-request-budget";
import { initializeOperationRetention, type OperationRetention } from "@/server/bootstrap/operation-retention";
import { SqliteStateStore } from "@/server/infrastructure/sqlite/sqlite-state-store";
import { resolveAppPaths, type AppPaths } from "@/server/paths";
import { ownedFixtureDatabase } from "@/server/unmanaged-sqlite-fixture";
import type { PublicOperationError } from "@/shared/contracts/operations";
import { hash, iso, none, NOW, presentedBearer, token } from "./adapters/credential-verifier-fixture";
import { createProviderWorld } from "./adapters/provider-session-fixture";
import type { AuthenticationContext } from "./authentication-context";
import { createKnowledgeWrites, type KnowledgeWritePorts } from "./knowledge-writes";
import type { AnyOperation } from "./operation";
import type { MutationReleaseOptions, MutationReleaseResult } from "./runner";

/**
 * Real-store fixture of `knowledge.create_thread` (D2b-2) for the operation and
 * transport suites: a SQLite store under strict admission with the
 * controller's retention (idempotency store and fingerprint key), synthetic
 * accounts, grants and Knowledge projects, all in its own temporary data,
 * state and key paths. It never imports the shared composition: each suite
 * builds it from `runtimeOptions()`, so the composition guard keeps its exact
 * importer list.
 */
export type Mode = "open" | "token" | "better-auth";
/** `legacy`: a stored mode outside the contract; the composition builds no registry for it. */
export type StoredMode = Mode | "legacy";
export interface Written { kind: "commit" | "refuse"; value: unknown; admitted: number }

export async function knowledgeFixture(mode: StoredMode, setup: { retention?: boolean; humans?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "knowledge-writes-"));
  const paths: AppPaths = resolveAppPaths(join(root, "data"), join(root, "state"));
  const clock = { now: NOW };
  const logs = { lines: [] as Array<{ message: string; details: unknown }>, controller(message: string, details?: unknown) { logs.lines.push({ message, details }); } };
  const installationSecret = token("wsi");
  const provider = createProviderWorld(clock);
  const providerState = { runtime: true };
  const entry = join(root, "provider.mjs"); writeFileSync(entry, "export {};\n", { mode: 0o600 });
  const configuration = new FileProviderConfiguration(join(root, "provider.json"));
  configuration.configure({ module: entry, origin: "https://fixture.example", signingSecret: { kind: "generate" } }, false);
  const pinned = configuration.read()!;
  const providerRuntime = { isSessionAuthorityEligible: () => providerState.runtime };
  const eligibility = createControllerOperationEligibility({
    maintenance: () => false, stopping: () => false,
    configurationRestartRequired: () => {
      const current = configuration.read();
      return !current || current.entry !== pinned.entry || current.baseURL !== pinned.baseURL || current.secret !== pinned.secret;
    },
    runtime: () => providerRuntime,
  });
  const agents = new Map<string, string>();
  const closers: Array<() => void> = [];

  const open = async () => {
    const store = new SqliteStateStore(paths.databasePath);
    closers.push(() => { try { store.close(); } catch { /* already closed */ } });
    const retention: OperationRetention | null = setup.retention === false ? null
      : await initializeOperationRetention({ store, now: () => clock.now, logs });
    if (setup.retention !== false && !retention) throw new Error("retention unavailable");
    // From here every statement needs an admitted operation of the real gate, as in the controller.
    store.requireAdmission();
    if (setup.humans) {
      const storage = store.authenticationProviderStorage();
      store.authenticationProviderStorage = () => ({ ...storage,
        // A real read proves the fixture is never consulted outside core admission.
        currentSession: (id, sessionId) => { store.getAuthenticationPolicy(); return provider.store.currentSession(id, sessionId); },
      });
    }
    return { store, retention, database: ownedFixtureDatabase(store) };
  };
  let current = await open();
  const admitted = <T>(work: () => T) => current.store.admission.run(work);

  await admitted(() => {
    const { store } = current;
    const policy = store.getAuthenticationPolicy();
    store.saveAuthenticationPolicy({ ...policy, mode,
      token: { id: installationSecret.slice(4, 40), prefix: installationSecret.slice(0, 40), verifierHash: hash(installationSecret), createdAt: iso(NOW) } }, "fixture", "fixture");
    for (const id of ["project-a", "project-b"]) store.saveKnowledgeProject({ id, name: id, status: "active", revision: 1, createdAt: iso(NOW), updatedAt: iso(NOW) }, "fixture");
  });

  const grantNow = (account: string, role: string, projectId: string) => current.database.prepare(
    "INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES(?,?,'project',?,?)").run(account, role, projectId, iso(NOW));
  /** An agent principal with one active token, and optional grants. */
  const agent = async (id: string, grants: ReadonlyArray<[role: string, projectId: string]> = []) => {
    const credentialId = randomUUID(), secret = token("wts", credentialId);
    await admitted(() => {
      current.store.savePrincipal({ id, kind: "agent", status: "active" }, "fixture");
      current.store.saveCredential({ id: credentialId, principalId: id, kind: "agent_token", label: "fixture", tokenPrefix: `wts_${credentialId}`,
        verifierHash: hash(secret), status: "active", expiresAt: null, createdAt: iso(NOW), revokedAt: null, lastUsedAt: null }, "fixture");
      for (const [role, projectId] of grants) grantNow(id, role, projectId);
    });
    agents.set(id, secret);
    return presentedBearer(secret);
  };
  /** A human principal with a provider session (better-auth), and optional grants. */
  const human = async (id: string, grants: ReadonlyArray<[role: string, projectId: string]> = []) => {
    await admitted(() => {
      current.store.humanAccounts().createHumanPrincipal({ id, kind: "human", status: "active" }, "fixture");
      for (const [role, projectId] of grants) grantNow(id, role, projectId);
    });
    const session = provider.passwordLogin(provider.account(id));
    return { session, presented: { ...none(), browserHeaders: true, providerSession: { secret: "synthetic-cookie" } } };
  };
  const grant = (account: string, role: string, projectId: string) => admitted(() => { grantNow(account, role, projectId); });
  const revoke = (account: string, role?: string) => admitted(() => {
    if (role) current.database.prepare("DELETE FROM account_grants WHERE account_id=? AND role=?").run(account, role);
    else current.database.prepare("DELETE FROM account_grants WHERE account_id=?").run(account);
  });
  /** Archives or restores a project through the store's own project write (the next revision). */
  const setProjectStatus = (projectId: string, status: "active" | "archived") => admitted(() => {
    const existing = current.store.getKnowledgeProject(projectId);
    if (!existing) throw new Error("no such project");
    current.store.saveKnowledgeProject({ ...existing, status, revision: existing.revision + 1, updatedAt: iso(NOW) }, "fixture");
  });

  /** What the bootstrap composition needs; the suite adds `knowledge` and listener overrides. */
  const runtimeOptions = () => ({
    store: current.store, activeMode: mode, now: () => clock.now, logs,
    listeners: { api: () => true, mcp: () => true, worker: () => true, unix: () => true },
    eligibility, requestBudget: new AuthenticationRequestBudget(16, 4),
    projectReads: { placement: { statusSummary: () => ({ phase: "stopped", worktreePath: null, startedAt: null }) }, git: { listTrees: async () => [], worktreeDirty: async () => false } },
    provider: setup.humans ? { ...providerRuntime, providerId: "better-auth" as const, reader: current.store.authenticationProviderStorage(),
      resolveRequest: () => ({ result: Promise.resolve(null), settled: Promise.resolve() }) } : null,
    retention: current.retention,
  });

  /** Changes observed through the operation's total notification port. */
  const notifications: string[] = [];
  /** The operation over the real writer, with optional port overrides for fault injection. */
  const operation = (ports: Partial<KnowledgeWritePorts> = {}) => createKnowledgeWrites({
    writer: ports.writer ?? current.store.knowledgeThreadWriter(),
    changed: ports.changed ?? (projectId => { notifications.push(projectId); }),
    id: ports.id ?? randomUUID,
  }).createThread;

  /**
   * One `mutationRelease` with direct delivery. Each write records the real
   * gate's count of admitted participants at the moment it ran.
   */
  const release = async (runner: { mutationRelease(operation: AnyOperation, context: AuthenticationContext, raw: unknown, options: MutationReleaseOptions<object>): Promise<MutationReleaseResult> },
    op: AnyOperation, context: AuthenticationContext, raw: unknown, options: Partial<MutationReleaseOptions<object>> = {}) => {
    const writes: Written[] = [];
    const record = (kind: Written["kind"], value: unknown) => writes.push({ kind, value: structuredClone(value), admitted: current.store.admissionSnapshot().coreActive });
    const result = await runner.mutationRelease(op, context, raw, {
      eligible: () => true, connected: () => true, deadline: Number.MAX_SAFE_INTEGER,
      commit(value) { record("commit", value); }, refuse(error) { record("refuse", error); },
      ...options,
    });
    return { result, writes };
  };

  type Row = Record<string, unknown>;
  const threads = () => admitted(() => current.database.prepare("SELECT * FROM knowledge_threads ORDER BY created_at, id").all() as Row[]);
  const history = () => admitted(() => current.database.prepare("SELECT project_id,record_kind,record_id,operation,previous_json,principal_id,authentication_method,revision,created_at FROM knowledge_history WHERE record_kind='thread' ORDER BY id").all() as Row[]);
  const legacyIdempotency = () => admitted(() => (current.database.prepare("SELECT count(*) AS n FROM knowledge_idempotency").get() as { n: number }).n);
  const records = () => admitted(() => (current.database.prepare("SELECT idempotency_key,principal,state FROM operation_idempotency ORDER BY idempotency_key").all() as Row[])
    .map(row => `${String(row.idempotency_key)} ${String(row.principal)} ${String(row.state)}`));

  /** Closes this owner and opens the next one on the same files: the next controller start, with its repair. */
  const reopen = async () => { current.store.close(); current = await open(); };
  const cleanup = () => { for (const close of closers.splice(0).reverse()) close(); rmSync(root, { recursive: true, force: true }); };

  return {
    root, paths, clock, logs, installationSecret, provider, providerState, agents, notifications,
    get store() { return current.store; }, get database() { return current.database; }, get retention() { return current.retention; },
    admitted, agent, human, grant, revoke, setProjectStatus, runtimeOptions, operation, release, threads, history, legacyIdempotency, records, reopen, cleanup,
  };
}
export type KnowledgeFixture = Awaited<ReturnType<typeof knowledgeFixture>>;

/** The five public fields. */
export const answer = (category: string, status: number, reason: string, retry: string, effect: string | null): PublicOperationError =>
  ({ category, status, reason, retry, effect }) as PublicOperationError;
