import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KnowledgeService } from "@/server/modules/knowledge";
import { ControlService } from "@/server/control-service";
import { SqliteStateStore } from "@/server/sqlite-store";
import { acquireControllerLock } from "@/server/controller-lock";
import { createControllerAuthentication } from "@/server/bootstrap/authentication";
import { AuthenticationService, loadAuthenticationProvider, type AuthenticationProviderRuntime } from "@/server/modules/authentication";
import { IdentityService, type ProviderSessionActor } from "@/server/modules/identity";
import type { ProcessManager } from "@/server/process-manager";
import type { ProjectTestCommandResolver } from "@/server/test-command";
import { runtimeReaderFixture, EXISTING_OWNER, SECRET } from "./runtime-reader-fixture";
import { BrowserClient } from "./browser-authentication-fixture";
import { ORIGIN, OWNER_PASSWORD, readCommitted } from "./fixture";
import { gate } from "./strict-fixture";

const route = "/api/runtime/configuration";
type F = Awaited<ReturnType<typeof runtimeReaderFixture>> & { configurationBaseRevision?: number };
const base = (f: F) => f.configurationBaseRevision ?? 0;
const profiles = (f: F) => ({ operation: "profiles", projectId: f.a.id });
const config = (f: F) => ({ operation: "configuration", projectId: f.a.id, worktreePath: f.a.repositoryPath });
const select = (f: F, extra: {expectedRevision?: number; [key:string]:unknown} = {}) => ({ projectId: f.a.id, name: "staging", idempotencyKey: "select", operation: "select_environment_profile", ...extra, expectedRevision: base(f) + (extra.expectedRevision ?? 0) });
const timeout = (f: F, extra: {expectedRevision?: number; [key:string]:unknown} = {}) => ({ projectId: f.a.id, worktreePath: f.a.repositoryPath, presetId: "node:test", timeoutMs: 1234, idempotencyKey: "timeout", operation: "set_test_preset_timeout", ...extra, expectedRevision: base(f) + (extra.expectedRevision ?? 0) });
const assign = (f: F, permissions: string[], principalId = f.human, expectedRevision = 0) => f.run(["runtime-access", "set", ...f.input({ principalId, scope: { kind: "runtime-project", id: f.a.id }, role: "operator", permissions, expectedRevision })]);
async function fixture(permissions = ["profiles:select", "config:write"], verification = false) {
  const f = await runtimeReaderFixture({ mutations: true, configuration: true, verification });
  await f.core(() => { f.store.releaseReservation(f.a.id, "local-user", true); f.store.saveProjectEnvironmentProfile(f.a.id, { name: "staging", environment: { PRIVATE_NAME: SECRET } }, "fixture"); });
  const configurationBaseRevision = await f.core(() => f.store.getProjectConfigurationRevision(f.a.id)!);
  await assign(f, permissions); expect(f.load).not.toHaveBeenCalled();
  await f.enroll(); const http = await f.listen();
  expect((await http.human.login(OWNER_PASSWORD, "runtime-human@fixture.invalid")).status).toBe(200);
  expect((await http.owner.login()).status).toBe(200);
  const second = new BrowserClient(http.human.socketPath);
  expect((await second.login(OWNER_PASSWORD, "runtime-human@fixture.invalid")).status).toBe(200);
  const call = (body: unknown, client = http.human) => client.call(route, { body });
  return { ...f, configurationBaseRevision, http, second, call };
}
const audits = (f: F) => readCommitted(f.paths.databasePath, db => db.prepare("SELECT event_type,details_json FROM audit_events WHERE event_type LIKE 'configuration.%'").all());
const rev = (f: F) => f.core(() => f.store.getProjectConfigurationRevision(f.a.id)! - base(f));
const noLeak = (value: unknown) => expect(JSON.stringify(value)).not.toMatch(/sentinel|PRIVATE_NAME|sessionKey|evidenceKey|generation|credentialId|nativeSessionId|authority|"environment"|executable|vault|token/);
async function take(f: Awaited<ReturnType<typeof fixture>>, key = "claim") {
  const r = await f.http.human.call("/api/runtime/mutate", { body: { operation: "claim", projectId: f.a.id, worktreePath: f.a.repositoryPath, idempotencyKey: key, reason: "configuration", start: false } });
  expect(r.status).toBe(200); return (r.body.claim as { reservationId: string }).reservationId;
}

describe("real provider human profile selection and timeout-only configuration", () => {
  it.each(["profiles:select", "config:write"])("supports explicit %s alone through protected CLI without provider loading or default grants", async permission => {
    const f = await fixture([permission]);
    try {
      const actor = await f.actor(f.http.human);
      expect((await f.core(() => f.composition.identity.describeIdentity(actor))).runtimeAccess).toEqual([{ projectId: f.a.id, actions: [permission], expiresAt: null }]);
      for (const action of ["projects:read", "claims:manage", "runtime:control", "tests:run", permission === "profiles:select" ? "config:write" : "profiles:select"] as const)
        await expect(f.core(() => f.composition.identity.authorizeRuntime(actor, f.a.id, action))).rejects.toMatchObject({ code: "runtime_forbidden" });
      expect((await f.call(permission === "profiles:select" ? profiles(f) : config(f))).status).toBe(200);
      expect((await f.call(permission === "profiles:select" ? select(f) : timeout(f))).status).toBe(200);
      expect((await f.call(permission === "profiles:select" ? config(f) : profiles(f))).status).toBe(403);
      expect((await f.call(profiles(f), f.http.owner)).status).toBe(403);
      expect((await f.call({ ...profiles(f), projectId: f.b.id })).status).toBe(403);
      expect((await f.call({ ...profiles(f), projectId: "00000000-0000-4000-8000-000000000000" })).status).toBe(403);
      expect(await rev(f)).toBe(1); expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
      const listed = await f.run(["runtime-access", "list", "--principal-id", f.human]); expect(JSON.stringify(listed)).toContain(permission);
      await f.revoke(f.human); expect((await f.call(permission === "profiles:select" ? profiles(f) : config(f))).status).toBe(403);
    } finally { await f.close(); }
  });
  it("returns only literal names, discovered IDs/defaults/overrides and shared revision; no-op and clear preserve the contract", async () => {
    const f = await fixture();
    try {
      const p = await f.call(profiles(f)); expect(p.status).toBe(200); noLeak(p.body);
      expect(p.body).toMatchObject({ configurationRevision: base(f), profiles: [{ name: "default" }, { name: "staging" }] });
      const c = await f.call(config(f)); expect(c.body).toMatchObject({ configurationRevision: base(f), presets: [{ id: "node:test", timeoutMs: 5000, overrideTimeoutMs: null }] }); noLeak(c.body);
      const changed = await f.call(select(f)); expect(changed).toMatchObject({ status: 200, body: { outcome: "completed", configurationRevision: base(f) + 1, replayed: false } });
      const replay = await f.call(select(f)); expect(replay.body).toEqual({ ...changed.body, replayed: true });
      expect((await f.call(select(f, { expectedRevision: 1, idempotencyKey: "noop" }))).body).toMatchObject({ outcome: "noop", configurationRevision: base(f) + 1 });
      expect((await f.call(timeout(f, { expectedRevision: 1 }))).body).toMatchObject({ configurationRevision: base(f) + 2 });
      expect((await f.call(config(f))).body.presets).toEqual([{ id: "node:test", timeoutMs: 5000, overrideTimeoutMs: 1234 }]);
      expect((await f.call(timeout(f, { expectedRevision: 2, timeoutMs: null, idempotencyKey: "clear" }))).body).toMatchObject({ outcome: "completed", configurationRevision: base(f) + 3, timeoutMs: null });
      expect((await f.call(timeout(f, { expectedRevision: 3, timeoutMs: null, idempotencyKey: "clear-noop" }))).body.outcome).toBe("noop");
      expect(audits(f)).toHaveLength(3); noLeak(audits(f)); expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it.each(["running", "starting", "stopping", "failed"] as const)("refuses a changed selection with %s owned runtime; existing selection may noop", async phase => {
    const f = await fixture(["profiles:select"]);
    try {
      f.states.set(f.a.id, { phase, worktreePath: f.a.repositoryPath, startedAt: null, pid: phase === "failed" ? 12345 : null });
      expect((await f.call(select(f))).body.code).toBe("runtime_active");
      expect((await f.call(select(f, { name: "default", idempotencyKey: "noop" }))).body.outcome).toBe("noop");
      expect(await rev(f)).toBe(0); expect(audits(f)).toEqual([]); expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it.each([
    { name: "missing" }, { name: "staging", environment: { PRIVATE_NAME: SECRET } }, { name: "../staging" },
  ])("rejects unknown profile or injected profile fields: %j", async extra => {
    const f = await fixture(); try { expect((await f.call(select(f, extra))).status).toBeGreaterThanOrEqual(400); expect(await rev(f)).toBe(0); } finally { await f.close(); }
  });
  it.each([{ presetId: "node:injected" }, { worktreePath: "/not-discovered" }, { presetId: "../../node:test" }, { timeoutMs: 0 }, { timeoutMs: 86400001 },
    { command: "node" }, { profile: "staging" }, { principalId: EXISTING_OWNER }, { authority: {} }, { session: "foreign" }, { timeoutMs: 1, unexpected: true }])("rejects undiscovered presets/paths or injected fields: %j", async extra => {
    const f = await fixture(); try { expect((await f.call(timeout(f, extra))).status).toBeGreaterThanOrEqual(400); expect(await rev(f)).toBe(0); } finally { await f.close(); }
  });
  it("rejects clone/foreign/agent/legacy actors and another original session's lease without manufacturing credentials", async () => {
    const f = await fixture(["claims:manage", "profiles:select", "config:write"]);
    try {
      const actor = await f.actor(f.http.human);
      for (const forged of [{ ...actor }, { ...actor, principalId: EXISTING_OWNER }, f.agentActor, f.oldOwner])
        await expect(f.service.humanConfigurationOperation(forged as ProviderSessionActor, select(f))).rejects.toThrow();
      const id = await take(f);
      expect((await f.call(select(f, { reservationId: id }), f.second)).status).toBe(409);
      await assign(f, ["profiles:select", "config:write"], EXISTING_OWNER);
      expect((await f.call(select(f, { reservationId: id }), f.http.owner)).status).toBe(409);
      expect((await f.call(select(f, { reservationId: id }))).status).toBe(200);
      expect((await f.call(timeout(f, { expectedRevision: 1, reservationId: id }))).status).toBe(200);
      // No separate claims:manage check when consuming the original ceiling.
      expect(f.start).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it.each(["agent", "legacy", "human-sidecar"])("refuses a foreign %s reservation, including stale provider-bound fallthrough", async kind => {
    const f = await fixture(["claims:manage", "config:write"]);
    try {
      let id: string;
      if (kind === "human-sidecar") { id = await take(f); await f.sql("DELETE FROM human_runtime_leases WHERE reservation_id=?", [id]); }
      else id = (await f.core(() => f.store.acquireReservation(kind === "legacy"
        ? { projectId: f.a.id, worktreePath: f.a.repositoryPath, kind: "human", owner: `human:${f.human}` }
        : { projectId: f.a.id, worktreePath: f.a.repositoryPath, kind: "agent", owner: "foreign", ttlSeconds: 600, maximumLifetimeSeconds: 3600, leaseTokenHash: "a".repeat(64), idempotencyKey: "foreign" }))).id;
      expect((await f.call(timeout(f, { reservationId: id }))).status).toBe(409);
      // Missing sidecar expires the marked reservation through existing bookkeeping.
      // Its original ID must still never authorize through a legacy owner-string path.
      if (kind !== "human-sidecar") expect((await f.call(timeout(f, { idempotencyKey: "none" }))).status).toBe(409);
      else expect((await f.call(timeout(f, { reservationId: id, idempotencyKey: "still-bound" }))).status).toBe(409);
      expect(await rev(f)).toBe(0);
    } finally { await f.close(); }
  });
  it("fences a no-claim intent at Git and on receipt replay when a new same-session claim appears", async () => {
    const f = await fixture(["claims:manage", "config:write"]);
    const entered = gate(), resume = gate(); let pending: Promise<unknown> | undefined;
    try {
      f.hooks.git = async () => { entered.open(); await resume.opened; };
      pending = f.call(timeout(f)); await entered.opened; f.hooks.git = undefined;
      // While the project lock is held, trusted fixture creates the same actor's exact human lease.
      const actor = await f.actor(f.http.human);
      await f.core(() => { const a = f.composition.identity.resolveHumanRuntimeAuthority(actor, f.a.id, ["claims:manage"]);
        f.store.humanRuntime().begin(a, f.a.id, "newclaim", "d".repeat(64)); f.store.humanRuntime().claim(a, { projectId: f.a.id, worktreePath: f.a.repositoryPath, reason: "race", key: "newclaim", fingerprint: "d".repeat(64), ttlSeconds: 600 }); });
      resume.open(); expect(await pending).toMatchObject({ status: 409 }); expect(await rev(f)).toBe(0);
    } finally { resume.open(); await pending; await f.close(); }
  });
  it("will not replay under a new same-session lease, regrant, or changed fingerprint", async () => {
    const f = await fixture(["claims:manage", "config:write"]);
    try {
      const id = await take(f); const input = timeout(f, { reservationId: id });
      expect((await f.call(input)).status).toBe(200);
      expect((await f.call({ ...input, timeoutMs: 5555 })).body.code).toBe("idempotency_conflict");
      expect((await f.call(input, f.second)).status).toBe(409);
      await f.http.human.call("/api/runtime/mutate", { body: { operation: "release", projectId: f.a.id, reservationId: id, idempotencyKey: "release" } });
      await take(f, "replacement"); expect((await f.call(input)).status).toBe(409);
      await f.revoke(f.human); await assign(f, ["claims:manage", "config:write"], f.human, 2);
      expect((await f.call(input)).status).toBe(409); expect(await rev(f)).toBe(1); expect(audits(f)).toHaveLength(1);
    } finally { await f.close(); }
  });
  it.each(["revoke", "regrant", "disable", "logout", "expiry", "generation", "configuration", "recovery", "factor-reset"])("rechecks exact original authority after Git idle/readmission: %s", async reason => {
    const f = await fixture(["config:write"]); const entered = gate(), resume = gate(); let pending: Promise<unknown> | undefined;
    try {
      const client = reason === "recovery" ? f.http.owner : f.http.human;
      if (reason === "recovery") await assign(f, ["config:write"], EXISTING_OWNER);
      f.hooks.git = async () => { entered.open(); await resume.opened; };
      pending = f.call(timeout(f), client); await entered.opened;
      expect(f.store.admissionSnapshot().coreActive).toBe(0);
      if (reason === "revoke" || reason === "regrant") { await f.revoke(f.human); if (reason === "regrant") await assign(f, ["config:write"], f.human, 2); }
      if (reason === "disable") await f.sql("UPDATE remote_principals SET status='revoked' WHERE id=?", [f.human]);
      if (reason === "logout") await client.call("/api/auth/sign-out", { body: {} });
      if (reason === "expiry") await f.sql('UPDATE authentication_ba_session SET "expiresAt"=?', [new Date(Date.now() - 60000).toISOString()]);
      if (reason === "generation") await f.sql("UPDATE authentication_account_policies SET generation=generation+1");
      if (reason === "configuration") await f.composition.execute({ command: "auth-provider", action: "configure", input: { module: join(f.root, "runtime-provider.mjs"), origin: "https://next-controller.test", signingSecret: { kind: "preserve" } } });
      if (reason === "recovery") await f.run(["recover", "--principal-id", EXISTING_OWNER, ...f.input({ newPassword: "replacement-config-password-1" })]);
      if (reason === "factor-reset") await f.run(["recover", "--principal-id", f.human, ...f.input({ newPassword: "replacement-human-reset-password-1", factors: "reset" })]);
      resume.open(); expect([401, 403]).toContain((await pending as {status:number}).status); expect(await rev(f)).toBe(0); expect(audits(f)).toEqual([]);
    } finally { resume.open(); await pending; await f.close(); }
  });
  it("rechecks after waiting for the shared project lock and before final receipt delivery", async () => {
    const f = await fixture(); const entered = gate(), resume = gate(); let pending: Promise<unknown> | undefined;
    try {
      f.hooks.git = async () => { entered.open(); await resume.opened; };
      const read = f.call(config(f)); await entered.opened;
      pending = f.call(select(f)); await vi.waitFor(() => expect(f.store.admissionSnapshot().coreActive).toBe(0));
      await f.revoke(f.human); resume.open(); expect(await read).toMatchObject({ status: 403 }); expect(await pending).toMatchObject({ status: 403 }); expect(await rev(f)).toBe(0);
    } finally { resume.open(); await pending; await f.close(); }
  });
  it("does not deliver after committed effect loses authority or the caller aborts", async () => {
    const f = await fixture();
    try {
      const actor = await f.actor(f.http.human), original = f.store.commitHumanConfiguration.bind(f.store), delivery = vi.fn();
      const spy = vi.spyOn(f.store, "commitHumanConfiguration").mockImplementation(input => {
        const receipt = original(input);
        f.store.runtimeMemberships().saveRuntimeMembership({ principalId: f.human, scope: { kind: "runtime-project", id: f.a.id }, expectedRevision: 1 }, "local-admin", new Date().toISOString());
        return receipt;
      });
      // Facade captured the bound port; invoke a fresh facade for this trusted effect seam.
      const service = new ControlService(f.store, f.git, { snapshot: () => ({ phase: "stopped", pid: null }), statusSummary: () => ({ ownsProcess: false }) } as unknown as ProcessManager,
        undefined, undefined, undefined, undefined, f.testCommands as unknown as ProjectTestCommandResolver, undefined, undefined, undefined, undefined, f.composition.identity);
      await expect(service.humanConfigurationOperation(actor, select(f), undefined, delivery)).rejects.toThrow();
      expect(delivery).not.toHaveBeenCalled(); expect(await rev(f)).toBe(1); expect(audits(f)).toHaveLength(1); spy.mockRestore();
    } finally { await f.close(); }
  });
  it("enforces closed HTTP routes, origin/host/body/content type/duplicate JSON and no-store", async () => {
    const f = await fixture();
    try {
      for (const init of [{ headers: { origin: "https://evil.test" } }, { headers: { host: "evil.test" } }, { headers: { "content-type": "text/plain" } },
        { raw: '{"operation":"profiles","operation":"configuration"}' }, { raw: JSON.stringify({ padding: "x".repeat(4096) }) }, { cookie: "" }, { method: "GET", body: undefined }]) {
        const r = await f.http.human.call(route, { body: profiles(f), ...init }); expect(r.status).toBeGreaterThanOrEqual(400); expect(r.headers["cache-control"]).toBe("no-store");
      }
      expect((await f.http.human.call(route + "/extra", { body: profiles(f) })).status).toBe(401);
      expect((await f.http.human.call(route + "?query=1", { body: profiles(f) })).status).toBe(400);
      expect(await rev(f)).toBe(0);
    } finally { await f.close(); }
  });
  it("serializes human and actual scoped-agent CAS on the same configuration revision", async () => {
    const f = await fixture(["config:write"]);
    try {
      const actor = await f.actor(f.http.human);
      const agent = await f.core(() => {
        const identity = new IdentityService(f.store, undefined, undefined, undefined, undefined, f.store);
        identity.setRuntimeDelegation({ principalId: f.agentActor.principalId, projectId: f.a.id, actions: ["config:write"], expectedRevision: 1 }, f.oldOwner);
        return identity.authenticateBearer(identity.issueRuntimeCredential({ principalId: f.agentActor.principalId, label: "configuration CAS", projects: [{ projectId: f.a.id, actions: ["config:write"] }] }, f.oldOwner).token);
      });
      const human = f.service.humanConfigurationOperation(actor, timeout(f));
      const machine = f.core(() => f.service.setScopedTestPresetTimeout(agent, { owner: "agent:mcp:configuration", claimToken: () => { throw new Error("unclaimed"); } },
        { projectId: f.a.id, worktreePath: f.a.repositoryPath, presetId: "node:test", timeoutMs: 3000, expectedRevision: base(f), idempotencyKey: "agent-CAS" }));
      const results = await Promise.allSettled([human, machine]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(r => r.status === "rejected")).toMatchObject([{ reason: { code: "revision_conflict" } }]);
      expect(await rev(f)).toBe(1); expect(audits(f)).toHaveLength(1);
      await expect(f.core(() => f.service.scopedProjectConfiguration(actor, { projectId: f.a.id, worktreePath: f.a.repositoryPath }))).rejects.toThrow();
    } finally { await f.close(); }
  });
  it("rechecks cached receipt authority after a real provider borrow and queued revocation before readmission", async () => {
    const f = await fixture(["config:write"]), entered = gate(), resume = gate(), borrowed = gate(), release = gate();
    let pending: Promise<unknown> | undefined, borrow: Promise<unknown> | undefined, revoke: Promise<unknown> | undefined;
    try {
      const actor = await f.actor(f.http.human), delivered = vi.fn();
      expect((await f.call(timeout(f))).status).toBe(200);
      // Hold the shared project lock with a read while the cached operation queues behind it.
      f.hooks.git = async () => { entered.open(); await resume.opened; };
      const read = f.call(config(f)); await entered.opened;
      pending = f.service.humanConfigurationOperation(actor, timeout(f), undefined, delivered).catch(error => error);
      await vi.waitFor(() => expect(f.store.admissionSnapshot().coreActive).toBe(0));
      borrow = f.store.authenticationProviderStorage().borrow(async () => { borrowed.open(); await release.opened; }); await borrowed.opened;
      revoke = f.composition.execute({ command: "auth-provider", action: "runtime-access-revoke", input: { principalId: f.human, scope: { kind: "runtime-project", id: f.a.id }, expectedRevision: 1 } });
      resume.open(); await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBeGreaterThanOrEqual(2));
      release.open(); await borrow; await revoke; await read;
      expect(await pending).toMatchObject({ code: "runtime_forbidden" }); expect(delivered).not.toHaveBeenCalled(); expect(await rev(f)).toBe(1);
    } finally { resume.open(); release.open(); await Promise.allSettled([pending, borrow, revoke]); await f.close(); }
  });
  it("replays only the original actual session after reopening the real provider/store", async () => {
    const f = await fixture(); let reopened: SqliteStateStore | undefined, composition: ReturnType<typeof createControllerAuthentication> | undefined;
    let lock: ReturnType<typeof acquireControllerLock> | undefined;
    try {
      const receipt = await f.call(timeout(f)); expect(receipt.status).toBe(200);
      const cookie = f.http.human.cookie; await f.detach();
      lock = acquireControllerLock(f.paths.controllerLockPath); reopened = new SqliteStateStore(f.paths.databasePath);
      const store = reopened, authentication = new AuthenticationService(store); store.requireAdmission();
      let loaded: AuthenticationProviderRuntime | undefined;
      composition = createControllerAuthentication({ store, dataDirectory: f.paths.dataDirectory, authentication, actor: "local-admin",
        loadProvider: async input => { loaded = await loadAuthenticationProvider(input); return loaded; } });
      const service = new ControlService(store, f.git, { snapshot: () => ({ phase: "stopped", pid: null }), statusSummary: () => ({ ownsProcess: false }) } as unknown as ProcessManager,
        undefined, undefined, undefined, undefined, f.testCommands as unknown as ProjectTestCommandResolver, undefined, undefined, undefined, undefined, composition.identity);
      await composition.prepareBrowserAuthentication({ origin: ORIGIN, knowledge: new KnowledgeService(store, composition.identity), configuration: service });
      const actor = await loaded!.authenticate(new Headers({ cookie })); expect(actor).not.toBeNull();
      expect(await service.humanConfigurationOperation(actor!, timeout(f))).toEqual({ ...receipt.body, replayed: true });
      expect(await store.admission.run(() => store.getProjectConfigurationRevision(f.a.id))).toBe(base(f) + 1);
      await expect(service.humanConfigurationOperation({ ...actor! }, timeout(f))).rejects.toThrow();
    } finally { await composition?.dispose(); await reopened?.closeAfterDrain(); lock?.release(); await f.close(); }
  });
  it("does not deliver a committed or cached receipt after abort", async () => {
    const f = await fixture(); const controller = new AbortController(), delivery = vi.fn();
    try {
      const actor = await f.actor(f.http.human), commit = f.store.commitHumanConfiguration.bind(f.store);
      const spy = vi.spyOn(f.store, "commitHumanConfiguration").mockImplementation(input => { const result = commit(input); controller.abort(); return result; });
      const service = new ControlService(f.store, f.git, { snapshot: () => ({ phase: "stopped", pid: null }), statusSummary: () => ({ ownsProcess: false }) } as unknown as ProcessManager,
        undefined, undefined, undefined, undefined, f.testCommands as unknown as ProjectTestCommandResolver, undefined, undefined, undefined, undefined, f.composition.identity);
      await expect(service.humanConfigurationOperation(actor, select(f), { signal: controller.signal }, delivery)).rejects.toMatchObject({ code: "cancelled" });
      spy.mockRestore(); expect(delivery).not.toHaveBeenCalled(); expect(await rev(f)).toBe(1);
      await expect(service.humanConfigurationOperation(actor, select(f), { signal: controller.signal }, delivery)).rejects.toThrow();
      expect(delivery).not.toHaveBeenCalled(); expect(audits(f)).toHaveLength(1);
    } finally { await f.close(); }
  });
  it("preserves queued timeout snapshots and applies new timeouts only to future enqueue", async () => {
    const f = await fixture(["tests:run", "config:write"], true), barrier = gate();
    try {
      f.setDelay(100);
      await f.core(() => f.manager!.enqueue({ projectId: f.b.id,
        worktree: { path: f.b.repositoryPath, head: "a".repeat(40), shortHead: "aaaaaaa", branch: "main", dirty: false, detached: false, locked: false, prunable: false },
        command: { preset: { id: "node:test", name: "test", adapter: "node", timeoutMs: 5000 }, executable: process.execPath, args: ["-e", ""], cwd: f.b.repositoryPath },
        environment: { environment: {}, mode: "clean", profile: "unit", inheritedServerProfile: null, variableNames: [] },
        actor: "local-user", sourceObservation: f.observation(), observe: async () => { await barrier.opened; return f.observation(); } }));
      await vi.waitFor(async () => expect((await f.core(() => f.manager!.status())).running).toBe(1));
      const enqueue = (key: string) => f.http.human.call("/api/runtime/tests", { body: { operation: "enqueue", projectId: f.a.id, worktreePath: f.a.repositoryPath, presetId: "node:test", idempotencyKey: key } });
      const first = await enqueue("before"); expect(first.status).toBe(200);
      expect((await f.call(timeout(f, { timeoutMs: 1 }))).status).toBe(200);
      const second = await enqueue("after"); expect(second.status).toBe(200);
      const runs = await f.core(() => f.store.listTestRuns(f.a.id));
      expect(runs.map(r => r.phase)).toEqual(["queued", "queued"]);
      barrier.open();
      await vi.waitFor(async () => expect((await f.core(() => f.store.listTestRuns(f.a.id))).every(r => r.telemetry?.finalizedAt)).toBe(true), { timeout: 10000 });
      const completed = await f.core(() => f.store.listTestRuns(f.a.id));
      expect(completed.find(r => r.id === (first.body.status as {runId:string}).runId)?.phase).toBe("passed");
      expect(completed.find(r => r.id === (second.body.status as {runId:string}).runId)?.phase).toBe("timed_out");
    } finally { barrier.open(); await f.close(); }
  });
});
