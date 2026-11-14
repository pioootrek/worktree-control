import { describe, expect, it } from "vitest";
import { FRESH_LOGIN_WINDOW_MS, installationPermissions, projectPermissions } from "@/shared/contracts/operations";
import { OperationRegistry, type ReadOperation } from "./operation";
import { createWorld, P } from "./operations-fixture";
import { OperationRunner } from "./runner";
import { MAX_DESCRIBED_PROJECTS, sessionDescribe } from "./session-describe";

const projectA = P("project-a");
const projectB = P("project-b");

function world() {
  const value = createWorld();
  value.resolver.addProject(projectA).addProject(projectB);
  return { ...value, runner: new OperationRunner(value.runtime()) };
}

describe("session.describe", () => {
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
  });

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
