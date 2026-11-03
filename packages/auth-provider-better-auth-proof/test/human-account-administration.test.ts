import { requestAdminSocket } from "@/server/admin-socket";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeIsolatedBrowserAuthentication } from "@/server/bootstrap/authentication";
import { createControllerServer } from "@/server/http-server";
import { createMcpControllerServer } from "@/server/mcp-http-server";
import { EventStream } from "@/server/events";
import type { ControlService } from "@/server/control-service";
import type { DirectoryBrowser } from "@/server/directory-browser";
import { HumanAccountQueries } from "@/server/infrastructure/sqlite/human-account-queries";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import { HumanAccountService, type ProviderSessionActor } from "@/server/modules/identity";
import { KnowledgeService } from "@/server/modules/knowledge";
import { knowledgePermissions } from "@/shared/contracts/authorization";
import { runtimeActions } from "@/shared/contracts/runtime-access";
import { aroundBrowser, BrowserClient, TRANSPORT_LIMITS } from "./browser-authentication-fixture";
import { cliFixture, onlineCliFixture } from "./cli-provider-fixture";
import { count, ORIGIN, OWNER_PASSWORD, readCommitted } from "./fixture";
import { enrollTotp, enrollPasskey, passkeyLogin } from "./browser-factor-helpers";
import { factorOptions, STEP } from "./integrated-fixture";
import { gate } from "./strict-fixture";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
let peer = 1;
const email = (n: number) => `human${n}@fixture.invalid`;
const enroll = (n: number) => ({ email: email(n), name: `Human ${n}`, password: OWNER_PASSWORD });
const create = async (f: Awaited<ReturnType<typeof onlineCliFixture>>) => ((await f.run(["human", "create"])).principal as { id: string }).id;
async function project(f: Awaited<ReturnType<typeof onlineCliFixture>>, id: string) {
  await f.runCore(() => f.store.saveKnowledgeProject({ id, name: id, status: "active", revision: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, "fixture"));
  return id;
}
const membership = (principalId: string, id: string, expectedRevision = 0, role = "operator", permissions = ["knowledge:read", "knowledge:write"]) =>
  ({ principalId, scope: { kind: "knowledge-project", id }, expectedRevision, role, permissions });
async function set(f: Awaited<ReturnType<typeof onlineCliFixture>>, input: ReturnType<typeof membership>) { return f.run(["knowledge-access", "set", ...f.input(input)]); }
async function setup(options: Parameters<typeof onlineCliFixture>[0] = {}) {
  const f = await onlineCliFixture(options);
  let cleanupHttp: ReturnType<typeof createControllerServer> | undefined;
  try {
  const h1 = await create(f), h2 = await create(f), k1 = await project(f, "k1"), k2 = await project(f, "k2");
  await f.run(["enroll", "--principal-id", h1, ...f.input(enroll(1))]);
  await f.run(["enroll", "--principal-id", h2, ...f.input(enroll(2))]);
  const composed = composeIsolatedBrowserAuthentication({ store: f.store, authentication: f.authentication,
    runtime: f.runtime(), origin: ORIGIN, admission: f.store.admission, maxInFlight: 8,
    trustedFixturePeer: `198.18.10.${peer++}`, limits: TRANSPORT_LIMITS });
  const http = createControllerServer({ service: {} as ControlService, directoryBrowser: {} as DirectoryBrowser,
    identity: composed.identity, authentication: f.authentication, browserAuthentication: composed.browserAuthentication,
    admission: f.store.admission, events: new EventStream(f.store.admission), webRoot: f.root, host: "127.0.0.1", port: 0, accessToken: "fixture",
    mcpStatus: () => ({ phase: "disabled", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "bearer", activeSessions: 0 }) });
  cleanupHttp = http;
  const path = join(f.root, "human-browser.sock");
  await new Promise<void>((resolve, reject) => { http.server.once("error", reject); http.server.listen(path, resolve); });
  const a = new BrowserClient(path), b = new BrowserClient(path);
  expect(await a.login(OWNER_PASSWORD, email(1))).toMatchObject({ status: 200, body: { authenticated: true } });
  expect(await b.login(OWNER_PASSWORD, email(2))).toMatchObject({ status: 200, body: { authenticated: true } });
  expect(await a.session()).toMatchObject({ status: 200, body: { principal: { id: h1, kind: "human" } } });
  expect(await b.session()).toMatchObject({ status: 200, body: { principal: { id: h2, kind: "human" } } });
  const actor = async (client: BrowserClient) => { const value = await f.runtime().authenticate(new Headers({ cookie: client.cookie })); expect(value).not.toBeNull(); return value!; };
  return { ...f, h1, h2, k1, k2, a, b, ...composed, actor, close: async () => { await http.close(); await f.close(); } };
  } catch (error) { await cleanupHttp?.close(); await f.close(); throw error; }
}
const content = (client: BrowserClient, operation: string, input: unknown) => client.call("/api/knowledge", { body: { operation, input } });
const task = (projectId: string, key = "write") => ({ projectId, title: "visible needle", description: "human content", idempotencyKey: key });
async function sql(f: Awaited<ReturnType<typeof onlineCliFixture>>, sql: string, values: Array<string | number | null> = []) {
  const storage = f.store.authenticationProviderStorage(), connection = storage.createProviderConnection();
  try { await storage.borrow(async () => { connection.prepare(sql).run(values); }); } finally { connection.close(); }
}

describe("protected ordinary humans and real isolated Knowledge cookies", () => {
  it("shares offline/private-IPC lifecycle and membership operations without importing a provider", async () => {
    const f = cliFixture();
    try {
      const human = (await f.run(["human", "create"])).principal as { id: string; kind: string };
      const store = new SqliteStateStore(f.paths.databasePath), now = new Date().toISOString();
      store.saveKnowledgeProject({ id: "k", name: "k", status: "active", revision: 1, createdAt: now, updatedAt: now }, "fixture");
      await store.closeAfterDrain();
      expect(await f.run(["knowledge-access", "set", ...f.input(membership(human.id, "k"))])).toMatchObject({ revision: 1 });
      expect(await f.run(["human", "list", "--limit", "1"])).toMatchObject({ items: [{ id: human.id, kind: "human", enrollment: "absent" }], nextAfter: null });
      expect(await f.run(["human", "disable", "--principal-id", human.id])).toMatchObject({ changed: true });
      expect(await f.run(["human", "disable", "--principal-id", human.id])).toMatchObject({ changed: false });
      expect(count(f.paths.databasePath, "principal_credentials")).toBe(0); expect(count(f.paths.databasePath, "authentication_ba_user")).toBe(0);
    } finally { f.remove(); }
    const online = await onlineCliFixture({ beforeLoad: async () => { throw Error("must not load"); } });
    try {
      const id = await create(online), k = await project(online, "k");
      await set(online, membership(id, k));
      expect(await online.run(["knowledge-access", "list", "--principal-id", id])).toMatchObject({ items: [{ revision: 1 }], nextAfter: null });
      await online.run(["knowledge-access", "revoke", ...online.input({ principalId: id, scope: { kind: "knowledge-project", id: k }, expectedRevision: 1 })]);
      await online.run(["human", "disable", "--principal-id", id]);
      expect(online.loads()).toBe(0);
    } finally { await online.close(); }
  });

  it("keeps two humans/projects isolated with filtered discovery/counts/search/history and explicit role ceilings", async () => {
    const f = await setup();
    try {
      expect(count(f.paths.databasePath, "principal_credentials")).toBe(0);
      expect(await content(f.a, "projects", {})).toMatchObject({ status: 200, body: { items: [], nextOffset: null } });
      await set(f, membership(f.h1, f.k1, 0, "reader")); await set(f, membership(f.h2, f.k2));
      const made = await content(f.b, "create_task", task(f.k2)); expect(made).toMatchObject({ status: 200, body: { replayed: false, value: { createdBy: f.h2 } } });
      const id = (made.body.value as { id: string }).id;
      expect(await content(f.a, "tasks", { projectId: f.k1 })).toMatchObject({ status: 200, body: { total: 0, counts: { all: 0 }, items: [] } });
      expect(await content(f.b, "search", { projectId: f.k2, query: "needle" })).toMatchObject({ status: 200, body: { items: [{ id, projectId: f.k2 }] } });
      expect(await content(f.b, "tasks", { projectId: f.k2, query: "needle" })).toMatchObject({ status: 200, body: { total: 1, counts: { all: 1, active: 1 }, items: [{ id }] } });
      expect(await content(f.b, "history", { projectId: f.k2, recordKind: "task", recordId: id })).toMatchObject({ status: 200,
        body: { items: [expect.objectContaining({ principalId: f.h2, authenticationMethod: "provider_session" })] } });
      for (const [client, own, other] of [[f.a, f.k1, f.k2], [f.b, f.k2, f.k1]] as const) {
        expect(await content(client, "projects", { limit: 1 })).toMatchObject({ status: 200, body: { items: [{ id: own }], nextOffset: null } });
        for (const [operation, input] of [["tasks", { projectId: other, query: "needle" }], ["task", { projectId: other, taskId: id }],
          ["history", { projectId: other, recordKind: "task", recordId: id }], ["search", { projectId: other, query: "needle" }]] as const) {
          expect(await content(client, operation, input)).toMatchObject({ status: 403, body: { code: "knowledge_forbidden" } });
        }
      }
      expect(await content(f.a, "create_task", task(f.k1))).toMatchObject({ status: 403 }); // reader intersects the broader explicit grant
      await set(f, membership(f.h2, f.k2, 1, "operator", ["knowledge:read"]));
      expect(await content(f.b, "create_task", task(f.k2, "read-only"))).toMatchObject({ status: 403 });
      const metadata = await f.providerKnowledge.describeIdentity(await f.actor(f.a));
      expect(metadata).toMatchObject({ principal: { kind: "human" }, credential: null, knowledgeGrants: [{ projectId: f.k1, permissions: ["knowledge:read"] }] });
      const text = JSON.stringify(metadata); for (const privateValue of [email(1), OWNER_PASSWORD, f.a.cookie]) expect(text).not.toContain(privateValue);
    } finally { await f.close(); }
  });

  it("requires both rows and denies supplementary actions even if broader grants are stored", async () => {
    const f = await setup();
    try {
      await set(f, membership(f.h1, f.k1)); const actor = await f.actor(f.a);
      await sql(f, "DELETE FROM knowledge_role_bindings WHERE principal_id=?", [f.h1]);
      expect((await f.providerKnowledge.describeIdentity(actor)).knowledgeGrants).toEqual([]);
      await expect(f.providerKnowledge.execute({ operation: "tasks", input: { projectId: f.k1 } }, actor)).rejects.toMatchObject({ code: "knowledge_forbidden" });
      await set(f, membership(f.h1, f.k1));
      await sql(f, "DELETE FROM knowledge_project_grants WHERE principal_id=?", [f.h1]);
      expect((await f.providerKnowledge.describeIdentity(actor)).knowledgeGrants).toEqual([]);
      await set(f, membership(f.h1, f.k1, 1));
      await sql(f, "UPDATE knowledge_project_grants SET permissions_json=? WHERE principal_id=?", [JSON.stringify(knowledgePermissions), f.h1]);
      for (const permission of knowledgePermissions.filter(p => p !== "knowledge:read" && p !== "knowledge:write")) {
        await expect(f.runCore(() => f.identity.authorizeKnowledge(actor, f.k1, permission))).rejects.toMatchObject({ code: "knowledge_forbidden" });
      }
      expect((await f.providerKnowledge.describeIdentity(actor)).knowledgeGrants).toEqual([{ projectId: f.k1, permissions: ["knowledge:read", "knowledge:write"] }]);
      await sql(f, "UPDATE knowledge_role_bindings SET revoked_at='2026-11-02T00:00:00.000Z' WHERE principal_id=?", [f.h1]);
      expect((await f.providerKnowledge.describeIdentity(actor)).knowledgeGrants).toEqual([]);
    } finally { await f.close(); }
  });

  it.each(["narrow", "revoke", "disable"] as const)("applies %s before queued effects and retained-result replay", async action => {
    const f = await setup(), release = gate(), entered = gate();
    let held: Promise<unknown> | undefined;
    try {
      await set(f, membership(f.h1, f.k1)); const actor = await f.actor(f.a);
      const request = { operation: "create_task", input: task(f.k1) };
      expect(await f.providerKnowledge.execute(request, actor)).toMatchObject({ replayed: false });
      const storage = f.store.authenticationProviderStorage();
      held = storage.borrow(async () => {
        storage.runControllerOperation(() => {
          const humans = new HumanAccountService(f.store.humanAccounts(), "local-admin");
          if (action === "narrow") humans.set(membership(f.h1, f.k1, 1, "reader"));
          else if (action === "revoke") humans.revoke({ principalId: f.h1, scope: { kind: "knowledge-project", id: f.k1 }, expectedRevision: 1 });
          else humans.disable(f.h1);
        });
        entered.open(); await release.opened;
      });
      await entered.opened;
      const replay = f.providerKnowledge.execute(request, actor).catch(error => error);
      const effect = f.providerKnowledge.execute({ ...request, input: task(f.k1, "queued") }, actor).catch(error => error);
      release.open(); await held;
      const code = action === "disable" ? "invalid_credential" : "knowledge_forbidden";
      expect(await replay).toMatchObject({ code }); expect(await effect).toMatchObject({ code });
      expect(count(f.paths.databasePath, "knowledge_tasks")).toBe(1);
      expect(count(f.paths.databasePath, "authentication_ba_session")).toBe(action === "disable" ? 1 : 2); // First reclamation joins disable; other human remains.
      expect(await content(f.b, "create_task", task(f.k1))).toMatchObject({ status: 403 });
    } finally { release.open(); await held; await f.close(); }
  });

  it("recovers global session capacity after disabling a non-owner and preserves other humans", async () => {
    const f = await setup({ sessionPolicy: { sessionRows: 3, sessionReconcileBatch: 1 } });
    try {
      await set(f, membership(f.h1, f.k1)); const actor = await f.actor(f.a);
      expect((await f.a.login(OWNER_PASSWORD, email(1))).status).toBe(200);
      expect(count(f.paths.databasePath, "authentication_ba_session")).toBe(3);
      expect((await f.b.login(OWNER_PASSWORD, email(2))).status).toBe(503);
      expect(await f.run(["human", "disable", "--principal-id", f.h1])).toMatchObject({ changed: true });
      expect(count(f.paths.databasePath, "authentication_ba_session")).toBe(1);
      await expect(f.providerKnowledge.describeIdentity(actor)).rejects.toMatchObject({ code: "invalid_credential" });
      expect((await f.a.session()).body).toEqual({ authenticated: false });
      expect((await f.b.session()).status).toBe(200);
      expect((await f.b.login(OWNER_PASSWORD, email(2))).status).toBe(200);
      expect((await f.a.login(OWNER_PASSWORD, email(1))).status).toBeGreaterThanOrEqual(400);
      expect(count(f.paths.databasePath, "authentication_ba_session")).toBe(2);
      expect(await f.run(["human", "disable", "--principal-id", f.h1])).toMatchObject({ changed: false });
    } finally { await f.close(); }
  });

  it("reports committed revocation on interrupted reclamation and resumes on a repeated disable", async () => {
    const f = await setup();
    try {
      expect((await f.a.login(OWNER_PASSWORD, email(1))).status).toBe(200);
      const interrupted = vi.spyOn(HumanAccountQueries.prototype, "removeDisabledHumanSession").mockImplementationOnce(() => { throw Error("fixture interrupted reclamation"); });
      await expect(f.run(["human", "disable", "--principal-id", f.h1])).rejects.toMatchObject({ code: "provider_failed", committed: true });
      interrupted.mockRestore();
      expect((await f.a.session()).body).toEqual({ authenticated: false });
      expect(count(f.paths.databasePath, "authentication_ba_session")).toBe(2);
      expect(await f.run(["human", "disable", "--principal-id", f.h1])).toMatchObject({ changed: false });
      expect(count(f.paths.databasePath, "authentication_ba_session")).toBe(1);
      expect(readCommitted(f.paths.databasePath, db => db.prepare("SELECT count(*) n FROM controller_audit_events WHERE event_type='identity.human_disabled'").get())).toEqual({ n: 1 });
    } finally { await f.close(); }
  });

  it("denies a successful human login retained until disable committed, with no late capacity leak", async () => {
    const f = await setup();
    try {
      const original = f.runtime().browser.bind(f.runtime());
      vi.spyOn(f.runtime(), "browser").mockImplementation((...args) => args[0] !== "sign-in" ? original(...args) : aroundBrowser(async () => {
        const lifetime = original(...args); await lifetime.result;
        await f.run(["human", "disable", "--principal-id", f.h1]); return lifetime;
      }));
      const result = await f.a.login(OWNER_PASSWORD, email(1));
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(count(f.paths.databasePath, "authentication_ba_session")).toBe(1);
      expect((await f.b.session()).body).toMatchObject({ authenticated: true });
      expect((await f.a.session()).body).toEqual({ authenticated: false });
    } finally { await f.close(); }
  });

  it("denies runtime links before lookup/replay while preserving Knowledge archive/restore", async () => {
    const f = await setup();
    try {
      await set(f, membership(f.h1, f.k1)); const actor = await f.actor(f.a);
      const knowledge = new KnowledgeService(f.store, f.identity);
      const lookup = vi.spyOn(f.store, "hasRuntimeProject"), receipt = vi.spyOn(f.store, "findIdempotentResult");
      for (const runtime of ["known", "unknown", null]) {
        await expect(f.runCore(() => knowledge.setRuntimeLink(f.k1, runtime, 1, { idempotencyKey: "same" }, actor))).rejects.toMatchObject({ code: "knowledge_forbidden" });
      }
      expect(lookup).not.toHaveBeenCalled(); expect(receipt).not.toHaveBeenCalled();
      expect(await content(f.a, "archive_project", { projectId: f.k1, expectedRevision: 1, idempotencyKey: "archive" })).toMatchObject({ status: 200 });
      expect(await content(f.a, "restore_project", { projectId: f.k1, expectedRevision: 2, idempotencyKey: "restore" })).toMatchObject({ status: 200 });
    } finally { await f.close(); }
  });

  it("rejects cloned/kind-forged/foreign-runtime actors and changed current mapping/kind", async () => {
    const f = await setup(), other = await setup();
    try {
      await set(f, membership(f.h1, f.k1)); const actor = await f.actor(f.a);
      for (const forged of [{ ...actor }, structuredClone(actor), { ...actor, principalKind: "owner" }, await other.actor(other.a)]) {
        await expect(f.providerKnowledge.describeIdentity(forged as ProviderSessionActor)).rejects.toMatchObject({ code: "invalid_credential" });
      }
      await sql(f, "UPDATE remote_principals SET kind='owner' WHERE id=?", [f.h1]);
      await expect(f.providerKnowledge.describeIdentity(actor)).rejects.toMatchObject({ code: "invalid_credential" });
      await sql(f, "UPDATE remote_principals SET kind='human' WHERE id=?", [f.h1]);
      await sql(f, "UPDATE authentication_provider_subjects SET linked_at='2026-11-01T00:00:00.000Z' WHERE principal_id=?", [f.h1]);
      await expect(f.providerKnowledge.describeIdentity(actor)).rejects.toMatchObject({ code: "invalid_credential" });
    } finally { await other.close(); await f.close(); }
  });

  it("denies human recovery and all administrative/runtime/vault/unconverted entry points in open boot", async () => {
    const f = await setup();
    try {
      await set(f, membership(f.h1, f.k1)); const actor = await f.actor(f.a);
      await expect(f.run(["recover", "--principal-id", f.h1, ...f.input({ newPassword: "fixture-reset-denied-123" })])).rejects.toMatchObject({ code: "principal_unavailable" });
      for (const action of runtimeActions) await expect(f.runCore(() => f.identity.authorizeRuntime(actor, f.k1, action))).rejects.toMatchObject({ code: "runtime_forbidden" });
      for (const effect of [() => f.identity.createAgent(actor), () => f.identity.issueAgentToken({ principalId: "agent", label: "denied" }, actor),
        () => f.identity.createWorker(actor), () => f.identity.requireOwnerSession(actor)]) await expect(f.runCore(effect)).rejects.toMatchObject({ code: "owner_authentication_required" });
      for (const path of ["/api/identity/admin", "/api/projects", "/api/backups", "/api/dev-vault", "/api/remote-verification", "/api/events"]) {
        expect((await f.a.call(path, { body: { command: "auth-provider", action: "human-create", actor: "local-cli" } })).status).toBe(401);
      }
      const password = "fixture-human-self-changed-123";
      expect(await f.a.call("/api/auth/change-password", { body: { currentPassword: OWNER_PASSWORD, newPassword: password } })).toMatchObject({ status: 200 });
      expect(await new BrowserClient(f.a.socketPath).login(password, email(1))).toMatchObject({ status: 200 });
    } finally { await f.close(); }
  });

  it("denies a human cookie at the actual separate MCP listener even in open boot", async () => {
    const f = await setup();
    const mcp = createMcpControllerServer({ service: { admission: f.store.admission } as unknown as ControlService,
      identity: f.identity, authentication: f.authentication, accessToken: "fixture", port: 0 });
    try {
      const socket = join(f.root, "human-mcp.sock");
      await new Promise<void>(resolve => mcp.server.listen(socket, resolve));
      const client = new BrowserClient(socket); client.cookie = f.a.cookie;
      expect((await client.call("/mcp", { omitOrigin: true, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } })).status).toBe(401);
      expect((await mcp.diagnosticsSnapshot()).sessions).toEqual([]);
    } finally { await mcp.close(); await f.close(); }
  });

  it.each(["totp", "passkey"] as const)("preserves selected optional %s protection without adding authority", async method => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-02T12:00:05Z"));
    const f = await setup({ factors: factorOptions() });
    try {
      await set(f, membership(f.h1, f.k1, 0, "reader"));
      if (method === "totp") {
        const authenticator = await enrollTotp(f.a);
        vi.setSystemTime(Date.now() + STEP * 2);
        expect(await f.a.login(OWNER_PASSWORD, email(1))).toMatchObject({ status: 200, body: { authenticated: false, outcome: "challenge" } });
        expect(await content(f.a, "tasks", { projectId: f.k1 })).toMatchObject({ status: 401 });
        expect(await f.a.call("/api/auth/two-factor/verify-totp", { body: { code: authenticator.code() } })).toMatchObject({ status: 200, body: { authenticated: true } });
      } else {
        const authenticator = await enrollPasskey(f.a);
        expect(await f.a.login(OWNER_PASSWORD, email(1))).toMatchObject({ status: 401 });
        expect(await passkeyLogin(f.a, authenticator, { counter: 1 })).toMatchObject({ status: 200, body: { authenticated: true } });
      }
      expect(await content(f.a, "tasks", { projectId: f.k1 })).toMatchObject({ status: 200 });
      expect(await content(f.a, "create_task", task(f.k1))).toMatchObject({ status: 403 });
      const actor = await f.actor(f.a);
      await expect(f.runCore(() => f.identity.requireOwnerSession(actor))).rejects.toMatchObject({ code: "owner_authentication_required" });
    } finally { await f.close(); }
  });

  it("refuses enrollment after disable before the actual borrow and at final native link after hashing", async () => {
    const wait = gate(); const first = await onlineCliFixture({ beforeLoad: () => wait.opened });
    try {
      const id = await create(first);
      const pending = first.run(["enroll", "--principal-id", id, ...first.input(enroll(1))]).catch(error => error);
      await vi.waitFor(() => expect(first.loads()).toBe(1));
      await first.run(["human", "disable", "--principal-id", id]); wait.open();
      expect(await pending).toMatchObject({ code: "principal_unavailable" });
      expect(count(first.paths.databasePath, "authentication_ba_user")).toBe(0);
    } finally { wait.open(); await first.close(); }
    let disable: (() => void) | undefined, calls = 0;
    const provisioned = vi.fn(async () => undefined);
    const late = await onlineCliFixture({ faults: { afterProvisionedUser: provisioned }, beforeProviderTransaction: () => { if (disable) { const op = disable; disable = undefined; calls++; op(); } } });
    try {
      const id = await create(late);
      disable = () => new HumanAccountService(late.store.humanAccounts(), "local-admin").disable(id);
      await expect(late.run(["enroll", "--principal-id", id, ...late.input(enroll(1))])).rejects.toMatchObject({ code: "principal_unavailable" });
      expect(calls).toBe(1); expect(provisioned).toHaveBeenCalledOnce();
      expect(await late.runCore(() => late.store.getPrincipal(id))).toMatchObject({ status: "revoked" });
      for (const table of ["authentication_ba_user", "authentication_ba_account", "authentication_provider_subjects"]) expect(count(late.paths.databasePath, table)).toBe(0);
    } finally { await late.close(); }
  });

  it("settles an accepted human creation after IPC response timeout without automatic replay", async () => {
    const f = await onlineCliFixture(), entered = gate(), release = gate();
    let holding: Promise<unknown> | undefined;
    try {
      const storage = f.store.authenticationProviderStorage();
      holding = storage.borrow(async () => { entered.open(); await release.opened; });
      await entered.opened;
      const result = await requestAdminSocket(f.paths.adminSocketPath, { command: "auth-provider", action: "human-create" }, 15, 16 * 1024).catch(error => error);
      expect(result).toMatchObject({ code: "admin_timeout" }); expect(result).not.toHaveProperty("committed");
      release.open(); await holding;
      await vi.waitFor(() => expect(count(f.paths.databasePath, "remote_principals")).toBe(3)); // installation, legacy owner, one human
      expect(readCommitted(f.paths.databasePath, db => db.prepare("SELECT count(*) n FROM controller_audit_events WHERE event_type='identity.human_created'").get())).toEqual({ n: 1 });
      expect(await f.run(["human", "list"])).toMatchObject({ items: [{ kind: "human" }], nextAfter: null });
      expect(f.loads()).toBe(0);
    } finally { release.open(); await holding; await f.close(); }
  });

  it("keeps committed denial after a failed native invalidation notification", async () => {
    let fail = false;
    const f = await setup({ onInvalidation: () => { if (fail) throw Error("private notification failure"); } });
    try {
      await set(f, membership(f.h1, f.k1)); const actor = await f.actor(f.a); fail = true;
      await expect(f.runtime().revokeSubject({ principalId: f.h1, actor: "fixture" })).rejects.toMatchObject({ code: "invalidation_failed", committed: true });
      await expect(f.providerKnowledge.describeIdentity(actor)).rejects.toMatchObject({ code: "invalid_credential" });
      await f.run(["human", "disable", "--principal-id", f.h1]);
      expect(await f.runCore(() => f.store.getPrincipal(f.h1))).toMatchObject({ status: "revoked" });
      expect(readCommitted(f.paths.databasePath, db => db.prepare("SELECT status FROM authentication_provider_subjects WHERE principal_id=?").get(f.h1))).toEqual({ status: "revoked" });
    } finally { await f.close(); }
  });
});
