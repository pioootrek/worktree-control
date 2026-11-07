import { describe, expect, it, vi } from "vitest";
import { IdentityService, type ProviderSessionActor } from "@/server/modules/identity";
import { ProviderRuntimeReadApplication } from "@/server/modules/authentication";
import { cliFixture } from "./cli-provider-fixture";
import { runtimeReaderFixture, EXISTING_OWNER, SECRET } from "./runtime-reader-fixture";
import { OWNER_PASSWORD, readCommitted } from "./fixture";
import { gate } from "./strict-fixture";

const list = { operation: "list-projects" };
const route = "/api/runtime/read";
type Fixture = Awaited<ReturnType<typeof runtimeReaderFixture>>;
async function login(f: Fixture) {
  await f.enroll(); const http = await f.listen();
  expect((await http.owner.login()).status).toBe(200);
  expect((await http.human.login(OWNER_PASSWORD, "runtime-human@fixture.invalid")).status).toBe(200);
  return http;
}
describe("real shared provider human runtime reader", () => {
  it("uses protected offline CLI and private IPC for explicit membership without loading any provider", async () => {
    const f = cliFixture();
    try {
      // Offline workflow owns its ordinary singleton store. No provider configuration exists.
      const human = (await f.run(["human", "create"])).principal as { id: string };
      const { SqliteStateStore } = await import("@/server/sqlite-store");
      const store = new SqliteStateStore(f.paths.databasePath);
      const p = store.addProject({ name: "Offline", repositoryPath: "/code/offline", port: 3721, executable: "node", args: [] }); store.close();
      const input = { principalId: human.id, scope: { kind: "runtime-project", id: p.id }, role: "reader", permissions: ["projects:read"], expectedRevision: 0 };
      expect(await f.run(["runtime-access", "set", ...f.input(input)])).toMatchObject({ revision: 1 });
      expect(await f.run(["runtime-access", "list", "--principal-id", human.id, "--limit", "1"])).toMatchObject({ items: [{ revision: 1 }], nextAfter: null });
      const current = new SqliteStateStore(f.paths.databasePath);
      try { expect(current.hasAuthenticationProviderData()).toBe(false); } finally { current.close(); }
    } finally { f.remove(); }
    const online = await runtimeReaderFixture();
    try {
      await online.set(EXISTING_OWNER); expect(online.load).not.toHaveBeenCalled();
      expect(await online.run(["runtime-access", "list", "--principal-id", EXISTING_OWNER])).toMatchObject({ items: [{ revision: 1 }], nextAfter: null });
      await expect(online.set(EXISTING_OWNER)).rejects.toMatchObject({ code: "membership_revision_conflict" });
      expect(await online.revoke(EXISTING_OWNER)).toMatchObject({ revision: 2, revokedAt: expect.any(String) });
      await expect(online.set(EXISTING_OWNER, online.a.id, 1)).rejects.toMatchObject({ code: "membership_revision_conflict" });
      expect(await online.set(EXISTING_OWNER, online.a.id, 2)).toMatchObject({ revision: 3, revokedAt: null });
      expect(online.load).not.toHaveBeenCalled();
    } finally { await online.close(); }
  });

  it("filters two real cookies, preserves the existing owner/history, and exposes only safe read fields with no own lease", async () => {
    const f = await runtimeReaderFixture();
    try {
      const before = await f.core(() => ({ principal: f.store.getPrincipal(EXISTING_OWNER), grants: f.store.listKnowledgeProjectGrants(EXISTING_OWNER), credentials: f.store.listPrincipalCredentials(EXISTING_OWNER) }));
      const history = readCommitted(f.paths.databasePath, db => db.prepare("SELECT * FROM knowledge_history").all());
      const http = await login(f), owner = await f.actor(http.owner), human = await f.actor(http.human);
      for (const client of [http.owner, http.human]) expect(await client.call(route, { body: list })).toMatchObject({ status: 200, body: { projects: [] } });
      await f.run(["knowledge-access", "set", ...f.input({ principalId: f.human, scope: { kind: "knowledge-project", id: f.a.id }, role: "reader", permissions: ["knowledge:read"], expectedRevision: 0 })]);
      expect(await http.human.call(route, { body: list })).toMatchObject({ status: 200, body: { projects: [] } });
      await f.set(EXISTING_OWNER); await f.set(f.human, f.b.id);
      expect(await f.app.execute(list, owner)).toMatchObject({ projects: [{ id: f.a.id, actions: ["projects:read"] }] });
      expect(await http.owner.call(route, { body: list })).toMatchObject({ status: 200, body: { projects: [{ id: f.a.id }] } });
      expect(await http.human.call(route, { body: list })).toMatchObject({ status: 200, body: { projects: [{ id: f.b.id }] } });
      expect((await f.app.execute(list, human) as { projects: unknown[] }).projects).toHaveLength(1);
      const hidden = await http.human.call(route, { body: { operation: "project-status", projectId: f.a.id } });
      const missing = await http.human.call(route, { body: { operation: "project-status", projectId: "unknown" } });
      expect(hidden.status).toBe(403); expect(missing.body).toEqual(hidden.body);
      await f.set(f.human);
      const status = await http.human.call(route, { body: { operation: "project-status", projectId: f.a.id } });
      expect(status).toMatchObject({ status: 200, body: { status: { claim: "other", ownClaim: null, actions: ["projects:read"] } }, headers: { "cache-control": "no-store" } });
      expect(Object.keys(status.body.status as object).sort()).toEqual(["id", "name", "port", "actions", "phase", "worktreePath", "claim", "selectedWorktreePath", "startedAt", "managedServer", "ownClaim"].sort());
      const trees = await http.human.call(route, { body: { operation: "list-worktrees", projectId: f.a.id } });
      expect(trees).toMatchObject({ status: 200, body: { worktrees: [{ path: "/code/a", branch: "main" }] } });
      expect(JSON.stringify([status.body, trees.body, await f.core(() => f.composition.identity.describeIdentity(human))])).not.toContain(SECRET);
      // Even a caller supplying an agent's real owner string cannot make a provider actor own it.
      expect(await f.core(() => f.service.scopedProjectStatus(human, { owner: `agent:mcp:${SECRET}` }, f.a.id))).toMatchObject({ claim: "other", ownClaim: null });
      expect(await f.core(() => f.composition.identity.describeIdentity(owner))).toMatchObject({ credential: null, runtimeAccess: [{ projectId: f.a.id, actions: ["projects:read"] }] });
      expect(await f.core(() => ({ principal: f.store.getPrincipal(EXISTING_OWNER), grants: f.store.listKnowledgeProjectGrants(EXISTING_OWNER), credentials: f.store.listPrincipalCredentials(EXISTING_OWNER) }))).toEqual(before);
      expect(readCommitted(f.paths.databasePath, db => db.prepare("SELECT * FROM knowledge_history").all())).toEqual(history);
      expect(await f.core(() => f.store.listPrincipals("owner"))).toEqual([before.principal]);
      expect(f.load).toHaveBeenCalledOnce();
      const agentStatus = await f.core(() => f.service.scopedProjectStatus(f.agentActor, { owner: `agent:mcp:${SECRET}` }, f.a.id));
      expect(agentStatus).toMatchObject({ claim: "own", ownClaim: { worktreePath: "/code/a" }, actions: ["projects:read", "claims:manage", "tests:run"] });
    } finally { await f.close(); }
  });

  it("never lets a reader mutate or use copied, foreign, missing-authority or bearer-owner actors", async () => {
    const f = await runtimeReaderFixture(), other = await runtimeReaderFixture();
    try {
      const http = await login(f); await f.set(EXISTING_OWNER); await f.set(f.human);
      const actor = await f.actor(http.human);
      for (const action of ["claims:manage", "runtime:control", "profiles:select", "config:write", "tests:run"] as const) {
        await expect(f.core(() => f.composition.identity.authorizeRuntime(actor, f.a.id, action))).rejects.toMatchObject({ code: "runtime_forbidden" });
      }
      await expect(f.core(() => f.service.scopedCompactProjectStatus(actor, { owner: "agent:mcp:spoof" }, f.a.id))).rejects.toMatchObject({ code: "project_access_denied" });
      await expect(f.core(() => f.service.waitForScopedStatusChange(actor, { owner: "agent:mcp:spoof" }, { projectId: f.a.id, cursor: "spoof" }))).rejects.toMatchObject({ code: "project_access_denied" });
      expect(f.service.statusWaitDiagnostics().waiters).toBe(0);
      await expect(f.core(() => f.composition.identity.requireOwnerSession(actor))).rejects.toMatchObject({ code: "owner_authentication_required" });
      await expect(f.core(() => f.service.claimScopedProject(actor, { owner: `agent:mcp:${SECRET}` }, { projectId: f.a.id, worktreePath: "/code/a", reason: "spoof", idempotencyKey: "spoof" }))).rejects.toMatchObject({ code: "project_access_denied" });
      await expect(f.app.execute(list, { ...actor } as ProviderSessionActor)).rejects.toMatchObject({ code: "invalid_credential" });
      await expect(other.app.execute(list, actor)).rejects.toMatchObject({ code: "invalid_credential" });
      await login(other); await other.set(EXISTING_OWNER);
      // Both loaded runtimes contain this same stable owner ID. Object ownership still differs.
      await expect(other.app.execute(list, await f.actor(http.owner))).rejects.toMatchObject({ code: "invalid_credential" });
      const identityWithoutAuthority = new IdentityService(f.store, undefined, undefined, undefined, undefined, f.store, undefined, f.store.runtimeMemberships());
      await expect(new ProviderRuntimeReadApplication(f.store.admission, identityWithoutAuthority, f.service).execute(list, actor)).rejects.toMatchObject({ code: "invalid_credential" });
      await expect(f.core(() => f.composition.identity.authorizeRuntime(f.oldOwner, f.a.id, "projects:read"))).rejects.toMatchObject({ code: "runtime_forbidden" });
      for (const path of ["/api/projects", "/api/dashboard", "/api/capacity", "/api/logs", "/api/auth/provider", "/api/runtime/claim", "/api/runtime/read/unknown"]) {
        expect((await http.human.call(path, { body: {}, headers: { authorization: `Bearer ${f.installationToken}` } })).status).toBe(401);
      }
      for (const body of [{ ...list, role: "manager" }, { ...list, actor: { role: "owner" } }, { operation: "claim-project", projectId: f.a.id },
        { operation: "list-worktrees", projectId: f.a.id, scope: { kind: "knowledge-project", id: f.a.id } }]) expect((await http.human.call(route, { body })).status).toBe(400);
      expect((await http.human.call(route, { method: "GET" })).status).toBe(405);
      expect((await http.human.call(`${route}?role=manager`, { body: list })).status).toBe(400);
      expect((await http.human.call(route, { body: list, cookie: "", headers: { authorization: `Bearer ${f.installationToken}` } })).status).toBe(401);
    } finally { await f.close(); await other.close(); }
  });

  it.each(["revoke", "disable", "logout", "recovery", "factor-reset", "expiry", "role", "permissions", "membership-delete", "subject-revoke", "owner-disable", "permissions-malformed"] as const)("suppresses the HTTP and direct retained result after %s during Git discovery", async reason => {
    const f = await runtimeReaderFixture(), entered = gate(), resume = gate();
    let pending: Promise<unknown> | undefined;
    try {
      const http = await login(f), ownerRead = reason === "recovery" || reason === "owner-disable";
      const principalId = ownerRead ? EXISTING_OWNER : f.human, client = ownerRead ? http.owner : http.human;
      await f.set(principalId); const actor = await f.actor(client);
      f.hooks.git = async () => { entered.open(); await resume.opened; };
      pending = client.call(route, { body: { operation: "list-worktrees", projectId: f.a.id } });
      await entered.opened;
      expect(f.store.admissionSnapshot().coreActive).toBe(0);
      if (reason === "revoke") await f.revoke(f.human);
      if (reason === "disable") await f.run(["human", "disable", "--principal-id", f.human]);
      if (reason === "logout") expect((await http.human.call("/api/auth/sign-out", { body: {} })).status).toBe(200);
      if (reason === "recovery") await f.run(["recover", "--principal-id", EXISTING_OWNER, ...f.input({ newPassword: "replacement-human-password-1" })]);
      if (reason === "factor-reset") await f.run(["recover", "--principal-id", f.human, ...f.input({ newPassword: "replacement-human-reset-password-1", factors: "reset" })]);
      if (reason === "owner-disable") await f.sql("UPDATE remote_principals SET status='revoked' WHERE id=?", [EXISTING_OWNER]);
      if (reason === "expiry") await f.sql('UPDATE authentication_ba_session SET "expiresAt"=?', [new Date(Date.now() - 60_000).toISOString()]);
      if (reason === "membership-delete") await f.sql("DELETE FROM runtime_human_memberships WHERE principal_id=?", [f.human]);
      if (reason === "subject-revoke") await f.sql("UPDATE authentication_provider_subjects SET status='revoked',revoked_at=? WHERE principal_id=?", [new Date().toISOString(), f.human]);
      if (reason === "role" || reason === "permissions" || reason === "permissions-malformed") {
        // Simulate corrupted current rows; policy must still refuse a retained actor.
        await f.sql("PRAGMA ignore_check_constraints=ON");
        try { await f.sql(reason === "role" ? "UPDATE runtime_human_memberships SET role='manager'" : reason === "permissions-malformed" ? "UPDATE runtime_human_memberships SET permissions_json='null'" : `UPDATE runtime_human_memberships SET permissions_json='["tests:run"]'`); }
        finally { await f.sql("PRAGMA ignore_check_constraints=OFF"); }
      }
      resume.open(); const result = await pending as { status: number; body: unknown };
      expect([401, 403]).toContain(result.status); expect(JSON.stringify(result.body)).not.toContain("/code/a");
      f.hooks.git = undefined;
      await expect(f.app.execute({ operation: "list-worktrees", projectId: f.a.id }, actor)).rejects.toMatchObject({ code: expect.stringMatching(/invalid_credential|runtime_forbidden|project_access_denied/) });
    } finally { resume.open(); await pending?.catch(() => {}); await f.close(); }
  });

  it("checks the current session after provider authentication waits for fresh application admission", async () => {
    const f = await runtimeReaderFixture(), entered = gate(), resume = gate(); let pending: Promise<unknown> | undefined;
    try {
      const http = await login(f); await f.set(f.human);
      const authenticate = f.runtime().authenticateRequest.bind(f.runtime());
      vi.spyOn(f.runtime(), "authenticateRequest").mockImplementationOnce((...args) => {
        const call = authenticate(...args);
        return { settled: call.settled, result: call.result.then(async actor => { entered.open(); await resume.opened; return actor; }) };
      });
      pending = http.human.call(route, { body: { operation: "project-status", projectId: f.a.id } });
      await entered.opened; await f.revoke(f.human); resume.open();
      expect(await pending).toMatchObject({ status: 403, body: { code: "project_access_denied" } });
    } finally { resume.open(); await pending?.catch(() => {}); await f.close(); }
  });

  it("rechecks after a real provider borrow and a queued revoke ahead of Git readmission", async () => {
    const f = await runtimeReaderFixture(), entered = gate(), resume = gate(), borrowed = gate(), release = gate();
    let pending: ReturnType<typeof f.app.execute> | undefined, borrow: Promise<unknown> | undefined, revoke: Promise<unknown> | undefined;
    try {
      const http = await login(f); await f.set(f.human); const actor = await f.actor(http.human);
      f.hooks.git = async () => { entered.open(); await resume.opened; };
      pending = f.app.execute({ operation: "list-worktrees", projectId: f.a.id }, actor);
      const outcome = pending.catch(error => error); await entered.opened;
      borrow = f.store.authenticationProviderStorage().borrow(async () => { borrowed.open(); await release.opened; });
      await borrowed.opened;
      revoke = f.composition.execute({ command: "auth-provider", action: "runtime-access-revoke", input: {
        principalId: f.human, scope: { kind: "runtime-project", id: f.a.id }, expectedRevision: 1 } });
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBe(1));
      resume.open(); await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBe(2));
      release.open(); await borrow; await revoke;
      expect(await outcome).toMatchObject({ code: "project_access_denied" });
    } finally { resume.open(); release.open(); await Promise.allSettled([pending, borrow, revoke]); await f.close(); }
  });

  it("holds the shared HTTP slot until cancelled discovery actually settles and emits no result", async () => {
    const f = await runtimeReaderFixture(), entered = gate(), resume = gate();
    const slow: Array<{ abort(): void; completed: Promise<unknown> }> = [];
    try {
      const http = await login(f); await f.set(f.human);
      f.hooks.git = async () => { entered.open(); await resume.opened; };
      const request = http.human.start(route);
      const cancelled = request.completed.catch(error => error);
      request.send(JSON.stringify({ operation: "list-worktrees", projectId: f.a.id }));
      await entered.opened;
      // Occupy the other 15 real controller slots with bounded, incomplete bodies.
      for (let i = 0; i < 15; i++) {
        const call = http.human.start(route);
        slow.push({ abort: call.abort, completed: call.completed.catch(error => error) });
        call.write('{"operation":');
      }
      await vi.waitFor(async () => expect((await http.human.call(route, { body: list })).status).toBe(503));
      request.abort(); await cancelled;
      expect((await http.human.call(route, { body: list })).status).toBe(503);
      expect(await f.core(() => f.store.getPrincipal(f.human))).toMatchObject({ status: "active" });
      for (const call of slow) call.abort();
      await Promise.all(slow.map(call => call.completed));
      resume.open();
      await vi.waitFor(async () => expect((await http.human.call(route, { body: list })).status).toBe(200));
    } finally {
      for (const call of slow) call.abort();
      resume.open(); await Promise.allSettled(slow.map(call => call.completed)); await f.close();
    }
  });

  it("applies runtime-specific origin, peer, cookie, strict JSON and body bounds through the same closed adapter", async () => {
    const f = await runtimeReaderFixture();
    try {
      const http = await login(f); await f.set(f.human);
      for (const [headers, status] of [[{ origin: "https://foreign.invalid" }, 403], [{ host: "foreign.invalid" }, 421],
        [{ "sec-fetch-site": "cross-site" }, 403], [{ "content-encoding": "gzip" }, 400]] as const) {
        expect((await http.human.call(route, { body: list, headers })).status).toBe(status);
      }
      expect((await http.human.call(route, { body: list, omitOrigin: true })).status).toBe(403);
      expect((await http.human.call(route, { raw: '{"operation":"list-projects","operation":"list-projects"}' })).status).toBe(400);
      expect((await http.human.call(route, { raw: JSON.stringify({ operation: "list-projects", excess: "x".repeat(5000) }) })).status).toBe(413);
      expect((await http.human.call(route, { body: list, cookie: `${http.human.cookie}; ${http.human.cookie}` })).status).toBe(400);
      const response = await http.human.call(route, { body: list });
      expect(response.headers["set-cookie"]).toBeUndefined(); expect(response.headers["cache-control"]).toBe("no-store");
    } finally { await f.close(); }
  });
});
