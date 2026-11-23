import { AuthenticationRequestBudget } from "@/server/bootstrap/authentication-request-budget";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileProviderConfiguration } from "@/server/authentication-provider-configuration";
import { buildOperationsRuntime, type OperationsRuntimeOptions } from "@/server/bootstrap/operations-runtime";
import { createControllerOperationEligibility, CONTROLLER_OPERATION_SESSION_POLICY } from "@/server/bootstrap/authentication-provider-lifetime";
import { SqliteStateStore } from "@/server/infrastructure/sqlite/sqlite-state-store";
import { resolveAppPaths } from "@/server/paths";
import { ownedFixtureDatabase } from "@/server/unmanaged-sqlite-fixture";
import type { VerifiedProviderSession } from "@/server/modules/authentication";
import { installationPermissions, projectPermissions, roleDefinitions } from "@/shared/contracts/operations";
import type { AuthenticationContext } from "./authentication-context";
import { OperationRegistry } from "./operation";
import { sessionDescribe, MAX_DESCRIBED_PROJECTS } from "./session-describe";
import { hash, iso, token, none, presentedBearer, NOW } from "./adapters/credential-verifier-fixture";
import { createProviderWorld } from "./adapters/provider-session-fixture";

const roots: string[] = [], stores: SqliteStateStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(mode = "better-auth", withProvider = false, admissionTimeoutMs?: number) {
  const root = mkdtempSync(join(tmpdir(), "operations-composition-")); roots.push(root);
  const store = new SqliteStateStore(resolveAppPaths(join(root, "data")).databasePath, undefined, { admission: "strict", admissionTimeoutMs }); stores.push(store);
  const database = ownedFixtureDatabase(store);
  const clock = { now: NOW };
  const state = { maintenance: false, stopping: false, ready: true, runtime: true };
  // Read the actual disk configuration through the existing adapter. No provider is loaded.
  const entry = join(root, "provider.mjs"); writeFileSync(entry, "export {};\n", { mode: 0o600 });
  const configuration = new FileProviderConfiguration(join(root, "provider.json"));
  configuration.configure({ module: entry, origin: "https://fixture.example", signingSecret: { kind: "generate" } }, false);
  const pinned = configuration.read()!;
  const providerRuntime = { isSessionAuthorityEligible: () => state.runtime };
  const eligibility = createControllerOperationEligibility({
    maintenance: () => state.maintenance, stopping: () => state.stopping,
    configurationRestartRequired: () => {
      const current = configuration.read();
      return !current || current.entry !== pinned.entry || current.baseURL !== pinned.baseURL || current.secret !== pinned.secret;
    },
    runtime: () => state.ready ? providerRuntime : undefined,
  });
  const provider = createProviderWorld(clock);
  if (withProvider) {
    // Human contexts use the module's provider-session fixture: real AccountProtection
    // and verifier, memory native/session rows. All accounts/grants/directory and
    // admission below are real SQLite. No external provider is available here.
    const storage = store.authenticationProviderStorage();
    vi.spyOn(store, "authenticationProviderStorage").mockReturnValue({ ...storage,
      currentSession: (id, sessionId) => {
        // A real read proves the fixture is never consulted outside core admission.
        store.getAuthenticationPolicy();
        return provider.store.currentSession(id, sessionId);
      },
    });
  }
  const project = (id: string, status: "active" | "archived" = "active") => store.saveKnowledgeProject({
    id, name: id, status, revision: 1, createdAt: iso(NOW), updatedAt: iso(NOW),
  }, "fixture");
  const grant = (account: string, role: string, projectId: string | null) => database.prepare(
    "INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES(?,?,?,?,?)",
  ).run(account, role, projectId === null ? "installation" : "project", projectId, iso(NOW));
  const agent = (id = "agent") => {
    store.savePrincipal({ id, kind: "agent", status: "active" }, "fixture");
    const credentialId = randomUUID(), secret = token("wts", credentialId);
    store.saveCredential({ id: credentialId, principalId: id, kind: "agent_token", label: "fixture", tokenPrefix: `wts_${credentialId}`,
      verifierHash: hash(secret), status: "active", expiresAt: null, createdAt: iso(NOW), revokedAt: null, lastUsedAt: null }, "fixture");
    return { credentialId, secret };
  };
  const installationSecret = token("wsi");
  await store.admission.run(() => {
    const policy = store.getAuthenticationPolicy();
    store.saveAuthenticationPolicy({ ...policy, mode: mode === "legacy" ? "legacy" : mode as "open" | "token" | "better-auth",
      token: { id: installationSecret.slice(4, 40), prefix: installationSecret.slice(0, 40), verifierHash: hash(installationSecret), createdAt: iso(NOW) } }, "fixture", "fixture");
    project("project-a"); project("project-b", "archived"); project("invalid project id");
  });
  const logs = { controller: vi.fn() };
  const options: OperationsRuntimeOptions = { store, activeMode: mode, now: () => clock.now, logs,
    listeners: { api: () => true, mcp: () => true, worker: () => true, unix: () => true },
    eligibility, projectReads: { placement: { statusSummary: () => ({ phase: "stopped", worktreePath: null, startedAt: null }) }, git: { listTrees: async () => [], worktreeDirty: async () => false } }, requestBudget: new AuthenticationRequestBudget(16, 4), provider: withProvider ? {
      ...providerRuntime, providerId: "better-auth", reader: store.authenticationProviderStorage(),
      resolveRequest: () => ({ result: Promise.resolve(null), settled: Promise.resolve() }),
    } : null };
  const build = (override: Partial<OperationsRuntimeOptions> = {}) => {
    const built = buildOperationsRuntime({ ...options, ...override });
    if (!built.supported) throw new Error("expected supported mode");
    return built;
  };
  const composition = mode === "legacy" ? null : build();
  const context = async (presented = none(), session: VerifiedProviderSession | null = null, listener: "api" | "mcp" | "worker" | "unix" = "api") => {
    const result = await composition!.mint(listener, presented, session, {});
    if (!result.ok) throw new Error(`mint refused: ${result.error.reason}`);
    return result.context;
  };
  const read = async (context: AuthenticationContext) => {
    const result = await composition!.runner.run(sessionDescribe, context, {});
    if (!result.ok) throw new Error(`read refused: ${result.error.reason}`);
    return result.value;
  };
  const human = async (id: string) => {
    await store.admission.run(() => store.humanAccounts().createHumanPrincipal({ id, kind: "human", status: "active" }, "fixture"));
    const session = provider.passwordLogin(provider.account(id));
    return { session, presented: { ...none(), browserHeaders: true, providerSession: { secret: "synthetic-cookie" } } };
  };
  const changeConfiguration = () => configuration.configure({ module: entry, origin: "https://changed.example", signingSecret: { kind: "preserve" } }, false);
  return { root, store, database, project, grant, agent, installationSecret, provider, providerRuntime, composition, build, options,
    context, read, human, state, eligibility, clock, changeConfiguration, logs };
}
const providerUnavailable = { ok: false, error: { category: "unavailable", status: 503, reason: "provider_session_unavailable", retry: "retry", effect: null } };
const unauthenticated = (reason: string) => ({ ok: false, error: { category: "unauthenticated", reason } });

describe("real operations composition under strict admission", () => {
  it("reports an eligibility admission that cannot run inside mint as busy, not an invalid cookie", async () => {
    const f = await fixture("better-auth", true), h = await f.human("human");
    const admission = f.store.admission;
    vi.spyOn(f.store, "admission", "get").mockReturnValue(admission);
    const tryRun = vi.spyOn(admission, "tryRun").mockReturnValue({ ran: false });
    expect(f.composition!.providerSessionEligibility()).toBe("busy");
    expect(await f.composition!.mint("api", h.presented, h.session, {})).toEqual({ ok: false,
      error: { category: "busy", status: 503, reason: "admission_refused", retry: "retry", effect: null } });
    tryRun.mockRestore();
    expect(await f.composition!.mint("api", h.presented, h.session, {})).toMatchObject({ ok: true });
  });

  it("gives mint the same contention refusal as run while a provider holds real admission", async () => {
    const f = await fixture("token", false, 20);
    const presented = presentedBearer(f.installationSecret), context = await f.context(presented);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const borrowing = f.store.authenticationProviderStorage().borrow(async () => { enter(); await released; });
    try {
      await entered;
      const normal = await f.composition!.runner.run(sessionDescribe, context, {});
      expect(normal).toEqual({ ok: false, error: { category: "busy", status: 503, reason: "admission_refused", retry: "retry", effect: null } });
      const minted = await f.composition!.mint("api", presented, null, {});
      expect(minted).toEqual(normal);
      expect(await f.composition!.mintOffline(() => true, {})).toEqual(normal);
    } finally {
      release();
      await borrowing;
    }
    // The same token still works after contention ends.
    expect(await f.composition!.mint("api", presented, null, {})).toMatchObject({ ok: true });
    expect(await f.composition!.mintOffline(() => true, {})).toMatchObject({ ok: true });
  });

  it("gives mint the runner's cancellation error for an already aborted signal", async () => {
    const f = await fixture("token");
    const presented = presentedBearer(f.installationSecret), context = await f.context(presented);
    const controller = new AbortController(); controller.abort(new Error("sensitive synthetic abort"));
    const normal = await f.composition!.runner.run(sessionDescribe, context, {}, { signal: controller.signal });
    expect(normal).toEqual({ ok: false, error: { category: "unavailable", status: 503, reason: "request_cancelled", retry: "retry", effect: null } });
    expect(await f.composition!.mint("api", presented, null, { signal: controller.signal })).toEqual(normal);
    expect(await f.composition!.mintOffline(() => true, { signal: controller.signal })).toEqual(normal);
  });

  it("reports an unexpected clock throw inside admitted mint as a sanitized internal error", async () => {
    const f = await fixture("token");
    const now = vi.fn(() => { throw new Error("sensitive synthetic clock detail"); });
    const composition = f.build({ now });
    expect(await composition.mint("api", presentedBearer(f.installationSecret), null, {})).toEqual({
      ok: false, error: { category: "internal", status: 500, reason: "unexpected_failure", retry: "none", effect: null },
    });
    expect(now).toHaveBeenCalledTimes(1);
  });

  it.each(["open", "token"])("describes the %s installation and each served listener", async mode => {
    const f = await fixture(mode);
    const presented = mode === "token" ? presentedBearer(f.installationSecret) : none();
    for (const listener of ["api", "mcp", "worker", "unix"] as const) {
      const value = await f.read(await f.context(listener === "unix" ? none() : presented, null, listener));
      expect(value).toMatchObject({ actor: { kind: listener === "unix" ? "operator" : "installation" }, mode, listener, fullAuthority: true,
        installationPermissions: [...installationPermissions], projectsTruncated: false });
      expect(value.projects).toEqual(["project-a", "project-b"].map(projectId => ({ projectId, permissions: [...projectPermissions] })));
    }
  });

  it.each(["none", "reader", "executor"] as const)("describes an agent with %s roles", async role => {
    // A provider is present, but bearer requests use only controller eligibility.
    const f = await fixture("better-auth", true);
    const { secret } = await f.store.admission.run(() => {
      const credential = f.agent(); if (role !== "none") f.grant("agent", role, "project-b"); return credential;
    });
    const value = await f.read(await f.context(presentedBearer(secret)));
    expect(value).toMatchObject({ actor: { kind: "agent", accountId: "agent" }, fullAuthority: false, installationPermissions: [] });
    expect(value.projects).toEqual(role === "none" ? [] : [{ projectId: "project-b", permissions: projectPermissions.filter(p => roleDefinitions[role].permissions.includes(p)) }]);
  });

  it.each(["admin", "secrets"] as const)("describes a human with %s only using the provider-session fixture", async role => {
    const f = await fixture("better-auth", true);
    const h = await f.human("human");
    await f.store.admission.run(() => f.grant("human", role, role === "admin" ? null : "project-b"));
    const value = await f.read(await f.context(h.presented, h.session));
    expect(value).toMatchObject({ actor: { kind: "human", accountId: "human" }, fullAuthority: false });
    expect(value.installationPermissions).toEqual(installationPermissions.filter(p => roleDefinitions[role].permissions.includes(p)));
    expect(value.projects).toEqual((role === "admin" ? ["project-a", "project-b"] : ["project-b"]).map(projectId => ({
      projectId, permissions: projectPermissions.filter(p => roleDefinitions[role].permissions.includes(p)),
    })));
    if (role === "admin") expect(value.projects.flatMap(p => p.permissions).some(p => p.startsWith("secrets:"))).toBe(false);
  });

  it("uses controller eligibility for a providerless account-mode boot, including offline CLI", async () => {
    const f = await fixture("better-auth");
    const storage = vi.spyOn(f.store, "authenticationProviderStorage");
    const c = f.build();
    expect(storage).not.toHaveBeenCalled();
    const { secret } = await f.store.admission.run(() => f.agent());
    const minted = await c.mint("api", presentedBearer(secret), null, {});
    expect(minted.ok).toBe(true);
    if (!minted.ok) throw new Error("expected agent");
    expect(await c.runner.run(sessionDescribe, minted.context, {})).toMatchObject({ ok: true, value: { actor: { kind: "agent" } } });
    const offline = await c.mintOffline(() => true, {});
    if (!offline.ok) throw new Error("expected offline operator");
    expect(c.eligible()).toBe(true);
    expect(c.providerSessionEligible()).toBe(false);
    expect(await c.runner.run(sessionDescribe, offline.context, {})).toMatchObject({ ok: true, value: { actor: { kind: "operator" }, fullAuthority: true } });
    expect(await c.mint("api", { ...none(), providerSession: { secret: "synthetic-cookie" } }, null, {}))
      .toEqual(providerUnavailable);
    f.state.maintenance = true;
    expect(c.eligible()).toBe(false);
    expect(await c.mint("api", presentedBearer(secret), null, {})).toMatchObject(unauthenticated("listener_closed"));
    expect(await c.mintOffline(() => true, {})).toMatchObject(unauthenticated("offline_lock_not_held"));
    expect(await c.runner.run(sessionDescribe, offline.context, {})).toMatchObject(unauthenticated("offline_lock_not_held"));
  });

  it.each(["open", "token", "better-auth"])("fences offline mint and revalidation on maintenance and stopping in %s mode", async mode => {
    const f = await fixture(mode), c = f.composition!;
    // A real strict store read proves both mint-time lock checks run in admission.
    const lockHeld = () => { f.store.getAuthenticationPolicy(); return true; };
    for (const change of ["maintenance", "stopping"] as const) {
      const offline = await c.mintOffline(lockHeld, {});
      if (!offline.ok) throw new Error("expected offline operator");
      expect(await c.runner.run(sessionDescribe, offline.context, {})).toMatchObject({
        ok: true, value: { actor: { kind: "operator", accountId: null }, mode, listener: "offline", fullAuthority: true },
      });
      f.state[change] = true;
      expect(await c.mintOffline(lockHeld, {})).toMatchObject(unauthenticated("offline_lock_not_held"));
      expect(await c.runner.run(sessionDescribe, offline.context, {})).toMatchObject(unauthenticated("offline_lock_not_held"));
      f.state[change] = false;
    }
  });

  it.each(["not-ready", "ineligible", "configuration"] as const)("keeps agent and operator access when the provider is %s", async change => {
    const f = await fixture("better-auth", true), c = f.composition!;
    const { secret } = await f.store.admission.run(() => f.agent());
    const requests = (["api", "mcp", "worker", "unix"] as const).map(listener => ({
      listener,
      presented: listener === "unix" ? none() : presentedBearer(secret),
      kind: listener === "unix" ? "operator" : "agent",
    }));
    const retained: AuthenticationContext[] = [];
    for (const request of requests) retained.push(await f.context(request.presented, null, request.listener));
    const offline = await c.mintOffline(() => true, {});
    if (!offline.ok) throw new Error("expected offline operator");
    if (change === "configuration") f.changeConfiguration();
    else if (change === "not-ready") f.state.ready = false;
    else f.state.runtime = false;
    expect(c.eligible()).toBe(true);
    expect(c.providerSessionEligible?.()).toBe(false);
    for (const [index, request] of requests.entries()) {
      const fresh = await f.context(request.presented, null, request.listener);
      for (const context of [retained[index], fresh]) {
        expect(await f.store.admission.run(() => context.revalidate())).toMatchObject({ actor: { kind: request.kind } });
        expect(await f.read(context)).toMatchObject({ actor: { kind: request.kind }, listener: request.listener });
        const commit = vi.fn();
        expect(await c.runner.readRelease(sessionDescribe, context, {}, {
          eligible: c.eligible, connected: () => true, deadline: NOW + 1000, commit,
        })).toEqual({ status: "committed" });
        expect(commit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actor: expect.objectContaining({ kind: request.kind }) }));
      }
    }
    const freshOffline = await c.mintOffline(() => true, {});
    if (!freshOffline.ok) throw new Error("expected offline operator despite provider fence");
    for (const context of [offline.context, freshOffline.context]) {
      expect(await f.store.admission.run(() => context.revalidate())).toMatchObject({ actor: { kind: "operator", via: "offline" } });
      expect(await f.read(context)).toMatchObject({ actor: { kind: "operator" }, listener: "offline", fullAuthority: true });
      const commit = vi.fn();
      expect(await c.runner.readRelease(sessionDescribe, context, {}, {
        eligible: c.eligible, connected: () => true, deadline: NOW + 1000, commit,
      })).toEqual({ status: "committed" });
      expect(commit).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["maintenance", "stopping"] as const)("fences every agent and operator path during %s with a provider present", async change => {
    const f = await fixture("better-auth", true), c = f.composition!;
    const { secret } = await f.store.admission.run(() => f.agent());
    const retained = [];
    for (const listener of ["api", "mcp", "worker", "unix"] as const) {
      const presented = listener === "unix" ? none() : presentedBearer(secret);
      retained.push({ listener, presented, context: await f.context(presented, null, listener) });
    }
    const offline = await c.mintOffline(() => true, {});
    if (!offline.ok) throw new Error("expected offline operator");
    f.state[change] = true;
    expect(c.eligible()).toBe(false);
    expect(c.providerSessionEligible?.()).toBe(false);
    for (const { listener, presented, context } of retained) {
      expect(await c.mint(listener, presented, null, {})).toMatchObject(unauthenticated("listener_closed"));
      await f.store.admission.run(() => expect(() => context.revalidate()).toThrowError(expect.objectContaining({ category: "unauthenticated", reason: "listener_closed" })));
      expect(await c.runner.run(sessionDescribe, context, {})).toMatchObject(unauthenticated("listener_closed"));
    }
    expect(await c.mintOffline(() => true, {})).toMatchObject(unauthenticated("offline_lock_not_held"));
    expect(await c.runner.run(sessionDescribe, offline.context, {})).toMatchObject(unauthenticated("offline_lock_not_held"));
  });

  it("refuses lost, throwing and thenable offline locks at mint and revalidation", async () => {
    const f = await fixture("better-auth"), c = f.composition!;
    for (const invalid of [
      () => false,
      () => { throw new Error("sensitive synthetic lock detail"); },
      () => Promise.resolve(true) as never,
      () => Promise.reject(new Error("synthetic lock rejection")) as never,
      () => ({ then(resolve: (held: boolean) => void) { resolve(true); } }) as never,
    ]) {
      let lockHeld = () => true;
      const offline = await c.mintOffline(() => lockHeld(), {});
      if (!offline.ok) throw new Error("expected offline operator");
      lockHeld = invalid;
      expect(await c.mintOffline(() => lockHeld(), {})).toMatchObject(unauthenticated("offline_lock_not_held"));
      expect(await c.runner.run(sessionDescribe, offline.context, {})).toMatchObject(unauthenticated("offline_lock_not_held"));
    }
    // A lock lost between mint and its immediate revalidation returns no context.
    const lockHeld = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    expect(await c.mintOffline(lockHeld, {})).toMatchObject(unauthenticated("offline_lock_not_held"));
    expect(lockHeld).toHaveBeenCalledTimes(2);
  });

  // Inserts 500 durable rows to prove the production count bound.
  it("bounds the listing, omits invalid IDs and includes archived projects", async () => {
    const f = await fixture("open");
    expect((await f.read(await f.context())).projects.map(project => project.projectId)).toEqual(["project-a", "project-b"]);
    await f.store.admission.run(() => { for (let n = 0; n < MAX_DESCRIBED_PROJECTS; n++) f.project(`extra-${String(n).padStart(4, "0")}`); });
    const value = await f.read(await f.context());
    expect(value.projects).toHaveLength(MAX_DESCRIBED_PROJECTS);
    expect(value.projectsTruncated).toBe(true);
    expect(value.projects.some(p => p.projectId === "invalid project id")).toBe(false);
  }, 20_000);

  it("reads new grants after an earlier read and between mint and execution", async () => {
    const f = await fixture("better-auth", true);
    const { secret } = await f.store.admission.run(() => { const a = f.agent(); f.grant("agent", "reader", "project-b"); return a; });
    const context = await f.context(presentedBearer(secret));
    expect((await f.read(context)).projects.map(p => p.projectId)).toEqual(["project-b"]);
    await f.store.admission.run(() => f.database.prepare("DELETE FROM account_grants WHERE account_id='agent'").run());
    expect((await f.read(context)).projects).toEqual([]);
    await f.store.admission.run(() => f.grant("agent", "reader", "project-a"));
    const next = await f.context(presentedBearer(secret));
    await f.store.admission.run(() => f.database.prepare("DELETE FROM account_grants WHERE account_id='agent'").run());
    expect((await f.read(next)).projects).toEqual([]);
  });

  it.each(["credential", "account", "fingerprint", "rotation"])("refuses a changed %s after mint", async change => {
    const f = await fixture("better-auth", true);
    const a = await f.store.admission.run(() => f.agent());
    const context = await f.context(presentedBearer(a.secret));
    await f.store.admission.run(() => {
      if (change === "account") f.store.savePrincipal({ id: "agent", kind: "agent", status: "revoked" }, "fixture");
      else if (change === "fingerprint") f.database.prepare("UPDATE principal_credentials SET created_at=? WHERE id=?").run(iso(NOW - 1), a.credentialId);
      else if (change === "rotation") f.database.prepare("UPDATE principal_credentials SET verifier_hash=? WHERE id=?").run(hash(token("wts", a.credentialId)), a.credentialId);
      else f.store.revokeCredential(a.credentialId, iso(NOW), "fixture");
    });
    expect(await f.composition!.runner.run(sessionDescribe, context, {})).toMatchObject(unauthenticated("credential_no_longer_valid"));
  });

  it("invalidates installation contexts on token rotation and shares the injected clock", async () => {
    const f = await fixture("token");
    const context = await f.context(presentedBearer(f.installationSecret));
    await f.store.admission.run(() => {
      const policy = f.store.getAuthenticationPolicy();
      f.store.saveAuthenticationPolicy({ ...policy, token: { ...policy.token!, verifierHash: hash(token("wsi")) } }, "fixture", "fixture");
    });
    expect(await f.composition!.runner.run(sessionDescribe, context, {})).toMatchObject(unauthenticated("credential_no_longer_valid"));
    expect(f.composition!.runtime.now).toBe(f.options.now);
  });

  it.each(["open", "token"])("ignores a pending next-start mode selection during a %s boot", async mode => {
    const f = await fixture(mode);
    const context = await f.context(mode === "open" ? none() : presentedBearer(f.installationSecret));
    await f.store.admission.run(() => f.store.saveAuthenticationPolicy({ ...f.store.getAuthenticationPolicy(), mode: "better-auth" }, "fixture", "fixture"));
    expect((await f.read(context)).mode).toBe(mode);
    expect((await f.read(await f.context(mode === "open" ? none() : presentedBearer(f.installationSecret)))).mode).toBe(mode);
  });

  it.each(["maintenance", "stopping", "configuration", "runtime", "not-ready"] as const)("fences human sessions after %s between resolve and mint and between mint and execution", async change => {
    const f = await fixture("better-auth", true);
    const h = await f.human("human");
    const context = await f.context(h.presented, h.session);
    expect((await f.read(context)).actor.kind).toBe("human");
    if (change === "configuration") f.changeConfiguration();
    else if (change === "runtime") f.state.runtime = false;
    else if (change === "not-ready") f.state.ready = false;
    else f.state[change] = true;
    const controllerClosed = change === "maintenance" || change === "stopping";
    const c = f.composition!;
    expect(c.eligible()).toBe(!controllerClosed);
    expect(c.providerSessionEligible?.()).toBe(false);
    for (const resolved of [h.session, null]) {
      expect(await c.mint("api", h.presented, resolved, {})).toMatchObject(controllerClosed ? unauthenticated("listener_closed") : providerUnavailable);
    }
    const reason = controllerClosed ? "listener_closed" : "credential_no_longer_valid";
    await f.store.admission.run(() => expect(() => context.revalidate()).toThrowError(expect.objectContaining({ category: "unauthenticated", reason })));
    expect(await c.runner.run(sessionDescribe, context, {})).toMatchObject(unauthenticated(reason));
    const commit = vi.fn();
    expect(await c.runner.readRelease(sessionDescribe, context, {}, {
      eligible: c.eligible, connected: () => true, deadline: NOW + 1000, commit,
    })).toMatchObject({ status: "refused", error: { category: "unauthenticated", reason } });
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(["open", "token"])("fences maintenance in %s mode without a provider", async mode => {
    const f = await fixture(mode); f.state.maintenance = true;
    expect(f.eligibility.controllerEligible()).toBe(false);
    expect(f.composition!.eligible()).toBe(false);
    expect(await f.composition!.mint("unix", none(), null, {})).toMatchObject(unauthenticated("listener_closed"));
  });

  it("returns unknown_mode for legacy and other unknown modes without constructing ports or boundaries", async () => {
    const f = await fixture("legacy");
    const ports = vi.spyOn(f.store, "machineCredentialReader").mockImplementation(() => { throw new Error("must not construct"); });
    const boundary = vi.spyOn(f.store, "projectDirectoryReader").mockImplementation(() => { throw new Error("must not construct"); });
    for (const activeMode of ["legacy", "unknown"]) {
      const built = buildOperationsRuntime({ ...f.options, activeMode });
      expect(built.supported).toBe(false);
      expect(built.eligible()).toBe(false);
      expect(built.providerSessionEligible()).toBe(false);
      expect(Object.isFrozen(built)).toBe(true);
      expect("boundaries" in built).toBe(false);
      expect(await built.mint("api", none(), null, {})).toMatchObject(unauthenticated("unknown_mode"));
      const lockHeld = vi.fn(() => true);
      expect(await built.mintOffline(lockHeld, {})).toMatchObject(unauthenticated("unknown_mode"));
      expect(lockHeld).not.toHaveBeenCalled();
    }
    expect(ports).not.toHaveBeenCalled(); expect(boundary).not.toHaveBeenCalled();
  });

  it("sanitizes a throwing or thenable policy reader", async () => {
    const f = await fixture("open");
    const reader = vi.spyOn(f.store, "getAuthenticationPolicy");
    reader.mockImplementation(() => { throw new Error("sensitive synthetic detail"); });
    expect(await f.composition!.mint("api", none(), null, {})).toMatchObject(unauthenticated("invalid_credential"));
    reader.mockReturnValue(Promise.reject(new Error("synthetic failure")) as never);
    expect(await f.composition!.mint("api", none(), null, {})).toMatchObject(unauthenticated("invalid_credential"));
  });

  it("refuses closed/throwing/thenable listener predicates, clocks and eligibility", async () => {
    const f = await fixture("open");
    for (const open of [() => false, () => { throw new Error("synthetic"); }, () => Promise.reject(new Error("synthetic")) as never]) {
      expect(await f.build({ listeners: { api: open } }).mint("api", none(), null, {})).toMatchObject(unauthenticated("listener_closed"));
    }
    const now = () => Promise.reject(new Error("synthetic")) as never;
    expect(await f.build({ now }).mint("api", none(), null, {})).toMatchObject(unauthenticated("invalid_credential"));
    const eligibility = { ...f.eligibility, controllerEligible: () => Promise.reject(new Error("synthetic")) as never };
    expect(await f.build({ eligibility }).mint("api", none(), null, {})).toMatchObject(unauthenticated("listener_closed"));
  });

  it("refuses mixed credentials, unserved listeners and unresolved cookies", async () => {
    const f = await fixture("better-auth", true), h = await f.human("human");
    const a = await f.store.admission.run(() => f.agent());
    expect(await f.composition!.mint("api", { ...h.presented, bearers: presentedBearer(a.secret).bearers }, h.session, {}))
      .toMatchObject(unauthenticated("mixed_credentials"));
    expect(await f.composition!.mint("api", h.presented, null, {})).toMatchObject(unauthenticated("invalid_credential"));
    expect(await f.build({ listeners: {} }).mint("api", none(), null, {})).toMatchObject(unauthenticated("listener_closed"));
  });

  it("keeps session and credential row identifiers out of DTOs and diagnostics, including a zero-role human", async () => {
    const f = await fixture("better-auth", true), h = await f.human("human");
    const a = await f.store.admission.run(() => f.agent());
    const human = await f.read(await f.context(h.presented, h.session));
    expect(human.projects).toEqual([]); expect(human.installationPermissions).toEqual([]);
    const agent = await f.read(await f.context(presentedBearer(a.secret)));
    f.composition!.runtime.observer.streamDisposalFailed({ operationId: "session.describe", kind: "timed_out" });
    const released = JSON.stringify([human, agent, f.logs.controller.mock.calls]);
    expect(released).not.toContain(h.session.sessionId); expect(released).not.toContain(a.credentialId);
    expect(released).not.toMatch(/sessionId|credentialId|verifierHash|last_used_at/);
  });

  it("pins the production registry and logs disposal failures without thrown values or credential facts", async () => {
    const f = await fixture("open"), c = f.composition!;
    const all = ["knowledge.create_thread", "project.list", "project.status", "project.worktrees", "session.describe"];
    expect(c.registry.ids()).toEqual(all);
    expect(Object.isFrozen(c.registry)).toBe(true);
    expect("register" in c.registry).toBe(false);
    const another = { ...sessionDescribe, id: "session.another" };
    expect(() => (c.registry as unknown as OperationRegistry).register(another)).toThrow(TypeError);
    expect(() => OperationRegistry.prototype.register.call(c.registry, another)).toThrow(TypeError);
    const { get, ids, idsOn, availableOn } = c.registry;
    expect(get("session.describe")?.id).toBe("session.describe");
    expect(get("session.another")).toBeUndefined();
    expect(ids()).toEqual(all);
    for (const listener of ["api", "mcp", "worker", "unix", "offline"] as const) {
      // Project reads and the thread write are HTTP (API and unix), MCP and CLI operations; the worker listener serves describe only.
      expect(idsOn(listener)).toEqual(listener === "worker" ? ["session.describe"] : all);
      for (const id of all) expect(availableOn(id, listener)).toBe(id === "session.describe" || listener !== "worker");
      expect(availableOn("session.describe", listener)).toBe(true);
      expect(availableOn("session.another", listener)).toBe(false);
    }
    expect(Object.isFrozen(c)).toBe(true); expect(Object.isFrozen(c.boundaries)).toBe(true);
    // The store returns a new wrapper on each access. Exercise the owned gate
    // instead of comparing wrapper identity: strict SQLite refuses this outside it.
    expect(await c.runtime.admission.run(() => f.store.getAuthenticationPolicy().mode)).toBe("open");
    c.runtime.observer.streamDisposalFailed({ operationId: "session.describe", kind: "timed_out" });
    expect(f.logs.controller).toHaveBeenCalledExactlyOnceWith("operations.stream_disposal_failed", { operationId: "session.describe", kind: "timed_out" });
    expect(CONTROLLER_OPERATION_SESSION_POLICY).toEqual({ stagedCapacity: 16, stagedTtlMs: 5000 });
  });
});

it("keeps the old guard's errors, precedence and configuration-read throws", () => {
  const state = { maintenance: false, stopping: false, configuration: false };
  const configurationRestartRequired = vi.fn(() => state.configuration);
  const policy = createControllerOperationEligibility({ maintenance: () => state.maintenance, stopping: () => state.stopping,
    configurationRestartRequired, runtime: () => ({ isSessionAuthorityEligible: () => true }) });
  expect(() => policy.guard()).not.toThrow();
  state.maintenance = true; configurationRestartRequired.mockClear();
  expect(() => policy.guard()).toThrowError(expect.objectContaining({ code: "maintenance", message: "Controller provider administration is in maintenance." }));
  expect(configurationRestartRequired).not.toHaveBeenCalled();
  state.maintenance = false; state.stopping = true;
  expect(() => policy.guard()).toThrowError(expect.objectContaining({ code: "maintenance" }));
  state.stopping = false; state.configuration = true;
  expect(() => policy.guard()).toThrowError(expect.objectContaining({ code: "provider_configuration_restart_required", message: "Provider configuration requires a new owner boot." }));
  const original = new Error("configuration read failed");
  configurationRestartRequired.mockImplementation(() => { throw original; });
  expect(() => policy.guard()).toThrow(original);
  expect(policy.providerSessionEligible()).toBe(false);
});

it("fails closed on thenables and throws in every eligibility input", () => {
  const inputs = { maintenance: () => false, stopping: () => false, configurationRestartRequired: () => false,
    runtime: () => ({ isSessionAuthorityEligible: () => true }) };
  for (const key of ["maintenance", "stopping", "configurationRestartRequired", "runtime"] as const) {
    for (const value of [() => Promise.reject(new Error("synthetic")), () => { throw new Error("synthetic"); }]) {
      const policy = createControllerOperationEligibility({ ...inputs, [key]: value } as typeof inputs);
      expect(policy.providerSessionEligible()).toBe(false);
    }
  }
  const policy = createControllerOperationEligibility({ ...inputs, runtime: () => ({ isSessionAuthorityEligible: () => Promise.resolve(true) as never }) });
  expect(policy.providerSessionEligible()).toBe(false);
});
