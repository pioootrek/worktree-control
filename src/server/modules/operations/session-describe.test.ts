import { describe, expect, it } from "vitest";
import { FRESH_LOGIN_WINDOW_MS, installationPermissions, projectPermissions, type ProjectId } from "@/shared/contracts/operations";
import { OperationRegistry, type ReadOperation } from "./operation";
import { createWorld, P } from "./operations-fixture";
import { OperationRunner } from "./runner";
import { MAX_DESCRIBED_BYTES, MAX_DESCRIBED_PROJECTS, sessionDescribe } from "./session-describe";

const projectA = P("project-a");
const projectB = P("project-b");

function world() {
  const value = createWorld();
  value.resolver.addProject(projectA).addProject(projectB);
  return { ...value, runner: new OperationRunner(value.runtime()) };
}

describe("session.describe", () => {
  it("never lists a non-project entry of the project list, not even to full authority", async () => {
    const w = world();
    const list = w.resolver.listProjects.bind(w.resolver);
    // No compliant resolver does this; `visible(null)` holds for full authority, so only the filter keeps "no project" out.
    w.resolver.listProjects = () => [...list(), null as unknown as ProjectId, "" as ProjectId];
    const admin = w.human("admin");
    w.grants.grant({ accountId: admin.id, role: "admin", scope: { kind: "installation" } });
    for (const [name, context] of [["installation", w.installation("api").context], ["operator", w.operator()], ["admin", admin.context]] as const) {
      const described = await w.runner.run(sessionDescribe, context, {});
      expect(described.ok && described.value.projects.map(project => project.projectId), name).toEqual([projectA, projectB]);
    }
  });

  it("works for a human account with zero roles", async () => {
    const w = world();
    const alice = w.human("alice");
    expect(await w.runner.run(sessionDescribe, alice.context, undefined)).toEqual({ ok: true, replayed: false, value: {
      actor: { kind: "human", accountId: "alice" }, mode: "better-auth", listener: "api", fullAuthority: false,
      installationPermissions: [], projects: [], projectsTruncated: false,
      freshLogin: { state: "satisfied", validUntil: new Date(w.clock.now - 1_000 + FRESH_LOGIN_WINDOW_MS).toISOString() },
    } });
  });

  it("lists every visible project with the permissions actually held, and installation permissions", async () => {
    const w = world();
    const alice = w.human("alice", { authenticatedAt: w.clock.now - FRESH_LOGIN_WINDOW_MS });
    w.grants.grant({ accountId: alice.id, role: "reader", scope: { kind: "project", projectId: projectA } })
      .grant({ accountId: alice.id, role: "secrets", scope: { kind: "project", projectId: projectA } })
      .grant({ accountId: alice.id, role: "secrets", scope: { kind: "project", projectId: projectB } });
    const result = await w.runner.run(sessionDescribe, alice.context, {});
    expect(result).toMatchObject({ ok: true, value: {
      projects: [
        { projectId: projectA, permissions: ["project:read", "logs:read", "storage:read", "config:read", "tests:read",
          "knowledge:read", "attachments:read", "secrets:read", "secrets:write"] },
        // Visible through the secrets role alone (decision M): listed with exactly what is held.
        { projectId: projectB, permissions: ["secrets:read", "secrets:write"] },
      ],
      installationPermissions: [], freshLogin: { state: "stale", validUntil: null },
    } });
  });

  it("describes admin, agents and full authority", async () => {
    const w = world();
    const admin = w.human("admin");
    w.grants.grant({ accountId: admin.id, role: "admin", scope: { kind: "installation" } });
    const described = await w.runner.run(sessionDescribe, admin.context, {});
    expect(described.ok && described.value.installationPermissions).toEqual([...installationPermissions]);
    expect(described.ok && described.value.projects.map(project => project.permissions.includes("secrets:read"))).toEqual([false, false]);

    const bot = w.agent("bot");
    expect(await w.runner.run(sessionDescribe, bot.context, {})).toMatchObject({ ok: true, value: {
      actor: { kind: "agent", accountId: "bot" }, listener: "mcp", projects: [], freshLogin: { state: "unavailable", validUntil: null } } });

    const installation = await w.runner.run(sessionDescribe, w.installation("api").context, {});
    expect(installation).toMatchObject({ ok: true, value: { actor: { kind: "installation", accountId: null }, mode: "token", fullAuthority: true,
      freshLogin: { state: "exempt" }, projects: [{ projectId: projectA, permissions: [...projectPermissions] }, { projectId: projectB }] } });
    expect(await w.runner.run(sessionDescribe, w.operator(), {})).toMatchObject({ ok: true, value: { actor: { kind: "operator" }, listener: "unix" } });
  });

  it("bounds the listed projects without counting invisible ones", async () => {
    const w = createWorld();
    for (let index = 0; index < MAX_DESCRIBED_PROJECTS + 1; index++) w.resolver.addProject(P(`p-${String(index).padStart(4, "0")}`));
    const result = await new OperationRunner(w.runtime()).run(sessionDescribe, w.installation().context, {});
    expect(result.ok && [result.value.projects.length, result.value.projectsTruncated]).toEqual([MAX_DESCRIBED_PROJECTS, true]);
    const alice = w.human("alice");
    const own = await new OperationRunner(w.runtime()).run(sessionDescribe, alice.context, {});
    expect(own.ok && own.value.projectsTruncated).toBe(false);
  }, 30_000);

  it("keeps all 500 UUID-length projects and truncates only above 500", async () => {
    const w = createWorld(), runner = new OperationRunner(w.runtime()), context = w.installation().context;
    const ids = Array.from({ length: MAX_DESCRIBED_PROJECTS }, (_, n) => P(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`));
    for (const id of [...ids].reverse()) w.resolver.addProject(id);
    const exact = await runner.run(sessionDescribe, context, {});
    if (!exact.ok) throw new Error("description required");
    expect(exact.value.projects).toEqual(ids.map(projectId => ({ projectId, permissions: [...projectPermissions] })));
    expect(exact.value.projectsTruncated).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(exact.value))).toBeLessThanOrEqual(MAX_DESCRIBED_BYTES);
    w.resolver.addProject(P("z-extra"));
    const over = await runner.run(sessionDescribe, context, {});
    expect(over).toMatchObject({ ok: true, value: { projects: exact.value.projects, projectsTruncated: true } });
  }, 30_000);

  it.each([0, 1])("accounts for the complete DTO when the last project puts it %i bytes over budget", async over => {
    const w = createWorld(), runner = new OperationRunner(w.runtime()), context = w.installation().context;
    const empty = await runner.run(sessionDescribe, context, {});
    if (!empty.ok) throw new Error("description required");
    const permissions = [...projectPermissions];
    const entry = (projectId: ProjectId) => ({ projectId, permissions });
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
    const fullEntryBytes = bytes(entry(P("p".repeat(160))));
    // Build the first prefix that would overflow with maximum IDs, then shorten
    // earlier IDs so that the FINAL entry fits exactly or exceeds by one byte.
    const count = Math.floor((MAX_DESCRIBED_BYTES - bytes(empty.value) + 1) / (fullEntryBytes + 1)) + 1;
    const ids = Array.from({ length: count }, (_, n) => `p${String(n).padStart(159, "0")}`);
    let remove = bytes({ ...empty.value, projects: ids.map(id => entry(P(id))) }) - MAX_DESCRIBED_BYTES - over;
    for (let n = 0; remove > 0; n++) {
      const cut = Math.min(remove, 150);
      // Retain each ID's distinct suffix and deterministic order.
      ids[n] = ids[n].slice(0, 1) + ids[n].slice(1 + cut);
      remove -= cut;
    }
    const ordered = ids.map(P).sort();
    const full = { ...empty.value, projects: ordered.map(entry) };
    expect(bytes(full)).toBe(MAX_DESCRIBED_BYTES + over);
    for (const id of [...ordered].reverse()) w.resolver.addProject(id);
    const described = await runner.run(sessionDescribe, context, {});
    if (!described.ok) throw new Error("description required");
    expect(described.value.projects).toEqual(full.projects.slice(0, count - over));
    expect(described.value.projectsTruncated).toBe(over === 1);
    expect(bytes(described.value)).toBeLessThanOrEqual(MAX_DESCRIBED_BYTES);
    if (over === 0) expect(bytes(described.value)).toBe(MAX_DESCRIBED_BYTES);
    // With another visible project, true is a byte shorter than false. Even the
    // formerly one-byte-over prefix now fits, but that next project does not.
    w.resolver.addProject(P("z-extra"));
    const truncated = await runner.run(sessionDescribe, context, {});
    if (!truncated.ok) throw new Error("description required");
    expect(truncated.value.projects).toEqual(full.projects);
    expect(truncated.value.projectsTruncated).toBe(true);
    expect(bytes(truncated.value)).toBe(MAX_DESCRIBED_BYTES + over - 1);
  }, 30_000);

  it("is a fresh decision every time, never cached", async () => {
    const w = world();
    const alice = w.human("alice");
    w.grants.grant({ accountId: alice.id, role: "reader", scope: { kind: "project", projectId: projectA } });
    expect(await w.runner.run(sessionDescribe, alice.context, {})).toMatchObject({ ok: true, value: { projects: [{ projectId: projectA }] } });
    w.grants.revokeAll(alice.id);
    expect(await w.runner.run(sessionDescribe, alice.context, {})).toMatchObject({ ok: true, value: { projects: [] } });
    w.verifier.revoke("provider_session", alice.credentialId);
    expect(await w.runner.run(sessionDescribe, alice.context, {})).toMatchObject({ ok: false, error: { category: "unauthenticated" } });
  });

  it("lists an executor-only project for an agent with worker:execute only (decision M)", async () => {
    const w = world();
    const bot = w.agent("bot");
    w.grants.grant({ accountId: bot.id, role: "executor", scope: { kind: "project", projectId: projectB } });
    expect(await w.runner.run(sessionDescribe, bot.context, {})).toMatchObject({ ok: true, value: {
      projects: [{ projectId: projectB, permissions: ["worker:execute"] }], installationPermissions: [] } });
  });

  it("rejects input", async () => {
    const w = world();
    expect(await w.runner.run(sessionDescribe, w.operator(), { projectId: "x" })).toMatchObject({ ok: false, error: { category: "invalid_request" } });
  });
});

describe("operation registry", () => {
  it("rejects duplicate and malformed IDs", () => {
    const registry = new OperationRegistry();
    registry.register(sessionDescribe);
    expect(() => registry.register({ ...sessionDescribe })).toThrow(/Duplicate/);
    expect(() => registry.register({ ...sessionDescribe, id: "Session Describe" })).toThrow(/Invalid/);
    expect(() => registry.register({ ...sessionDescribe, id: "describe" })).toThrow(/Invalid/);
    expect(registry.ids()).toEqual(["session.describe"]);
  });

  it("validates requirements, slots and allowlists, and registers a deeply frozen copy", () => {
    const registry = new OperationRegistry();
    const base = { ...sessionDescribe, id: "fixture.base" } as unknown as ReadOperation<Record<string, never>, never, never>;
    const bad = (change: Record<string, unknown>) => ({ ...base, ...change }) as typeof base;
    expect(() => registry.register(bad({ id: "fixture.proto", requirement: { require: { kind: "project", permission: "project:read", resource: "__proto__" } } }))).toThrow(/slot/);
    expect(() => registry.register(bad({ id: "fixture.typo", requirement: { require: { kind: "project", permission: "runtime:contrl", resource: "r" } } }))).toThrow(/permission/);
    expect(() => registry.register(bad({ id: "fixture.empty", requirement: { require: { kind: "all", of: [] } } }))).toThrow(/conjunction/);
    expect(() => registry.register(bad({ id: "fixture.keys", publicKeys: ["__proto__"] }))).toThrow(/allowlist/);
    expect(() => registry.register(bad({ id: "fixture.flag", requirement: { require: { kind: "authenticated" }, agents: true } }))).toThrow(/agents/);
    const shared = { require: { kind: "all", of: [{ kind: "project", permission: "project:read", resource: "r" }] } };
    const keys = ["actor"];
    const registered = registry.register(bad({ id: "fixture.ok", requirement: shared, publicKeys: keys }));
    // Later changes to the objects that were passed in change nothing registered.
    (shared.require.of[0] as { permission: string }).permission = "secrets:read";
    keys.push("secret");
    expect(registered.requirement).toEqual({ require: { kind: "all", of: [{ kind: "project", permission: "project:read", resource: "r" }] } });
    expect(registered.publicKeys).toEqual(["actor"]);
    expect(Object.isFrozen(registered.requirement.require)).toBe(true);
    expect(Object.isFrozen(registered.publicKeys)).toBe(true);
    expect(Object.isFrozen(sessionDescribe)).toBe(true);
    expect(Object.isFrozen(sessionDescribe.publicKeys)).toBe(true);
  });
});
