import { describe, expect, it } from "vitest";
import { roles, type Role } from "@/shared/contracts/operations";
import type { Actor } from "./authentication-context";
import { effectivePermissions, grantAllowed, type GrantScope } from "./grants";
import { A, InMemoryGrants, P } from "./operations-fixture";

const alice = A("alice");
const bot = A("bot");
const human: Actor = { kind: "human", accountId: alice };
const agent: Actor = { kind: "agent", accountId: bot };
const projectA = P("project-a");
const projectB = P("project-b");
const onA: GrantScope = { kind: "project", projectId: projectA };
const whole: GrantScope = { kind: "installation" };

function world() {
  return new InMemoryGrants().account(alice, "human").account(bot, "agent");
}

describe("grant validation", () => {
  it("validates recipient kind and scope when granting", () => {
    const table = Object.fromEntries(roles.map((role: Role) => [role, {
      humanProject: grantAllowed(role, "human", onA), agentProject: grantAllowed(role, "agent", onA),
      humanInstallation: grantAllowed(role, "human", whole), agentInstallation: grantAllowed(role, "agent", whole),
    }]));
    expect(table).toEqual({
      reader: { humanProject: true, agentProject: true, humanInstallation: false, agentInstallation: false },
      operator: { humanProject: true, agentProject: true, humanInstallation: false, agentInstallation: false },
      maintainer: { humanProject: true, agentProject: false, humanInstallation: false, agentInstallation: false },
      secrets: { humanProject: true, agentProject: true, humanInstallation: false, agentInstallation: false },
      executor: { humanProject: false, agentProject: true, humanInstallation: false, agentInstallation: false },
      admin: { humanProject: false, agentProject: false, humanInstallation: true, agentInstallation: false },
    });
  });

  it("re-validates stored grants: wrong recipient kind or scope yields nothing", () => {
    const grants = world()
      .grant({ accountId: bot, role: "maintainer", scope: onA })
      .grant({ accountId: bot, role: "admin", scope: whole })
      .grant({ accountId: alice, role: "executor", scope: onA })
      .grant({ accountId: alice, role: "admin", scope: onA })
      .grant({ accountId: alice, role: "reader", scope: whole })
      .grant({ accountId: alice, role: "superuser" as Role, scope: onA });
    for (const actor of [human, agent]) {
      const effective = effectivePermissions(actor, grants);
      expect([...effective.project(projectA)]).toEqual([]);
      expect([...effective.installation]).toEqual([]);
      expect([...effective.everyProject]).toEqual([]);
    }
  });

  it("never turns a project grant into an installation permission", () => {
    const grants = world();
    for (const role of roles.filter(role => role !== "admin")) grants.grant({ accountId: alice, role, scope: onA });
    const effective = effectivePermissions(human, grants);
    expect([...effective.installation]).toEqual([]);
    expect([...effective.project(projectB)]).toEqual([]);
    expect(effective.project(projectA).has("roles:manage")).toBe(true);
  });

  it("gives admin maintainer on every project but never secrets", () => {
    const grants = world().grant({ accountId: alice, role: "admin", scope: whole });
    const effective = effectivePermissions(human, grants);
    for (const project of [projectA, projectB]) {
      expect(effective.project(project).has("project:manage")).toBe(true);
      expect(effective.project(project).has("secrets:read")).toBe(false);
      expect(effective.project(project).has("secrets:write")).toBe(false);
      expect(effective.project(project).has("worker:execute")).toBe(false);
    }
    expect(effective.installation.has("vault:recover")).toBe(true);
    // An explicit secrets grant adds secrets on that project only.
    grants.grant({ accountId: alice, role: "secrets", scope: onA });
    const withSecrets = effectivePermissions(human, grants);
    expect(withSecrets.project(projectA).has("secrets:read")).toBe(true);
    expect(withSecrets.project(projectB).has("secrets:read")).toBe(false);
  });

  it("uses the stored account kind, never the actor's claim, and ignores other accounts' grants", () => {
    const grants = world().grant({ accountId: alice, role: "reader", scope: onA });
    expect([...effectivePermissions({ kind: "agent", accountId: alice }, grants).project(projectA)]).toEqual([]);
    expect([...effectivePermissions({ kind: "human", accountId: A("unknown") }, grants).project(projectA)]).toEqual([]);
    const leaky = { accountKind: () => "human" as const, grantsFor: () => [{ accountId: A("mallory"), role: "admin" as const, scope: whole }] };
    expect([...effectivePermissions(human, leaky).installation]).toEqual([]);
  });

  it("sums roles on one project", () => {
    const grants = world().grant({ accountId: bot, role: "reader", scope: onA }).grant({ accountId: bot, role: "executor", scope: onA });
    const effective = effectivePermissions(agent, grants);
    expect(effective.project(projectA).has("project:read")).toBe(true);
    expect(effective.project(projectA).has("worker:execute")).toBe(true);
    expect(effective.project(projectA).has("tests:run")).toBe(false);
  });
});

describe("permission sets are immutable and fresh (decision P)", () => {
  it("cannot be widened by a holder, for an unknown account, a known account or full authority", () => {
    const ghost: Actor = { kind: "human", accountId: A("ghost") };
    for (const actor of [ghost, human, { kind: "installation" } as Actor]) {
      const grants = world().grant({ accountId: alice, role: "reader", scope: onA });
      const first = effectivePermissions(actor, grants);
      for (const set of [first.installation, first.everyProject, first.project(projectA)]) {
        expect(() => (set as unknown as Set<string>).add("accounts:manage")).toThrow(TypeError);
        expect(() => Set.prototype.add.call(set, "accounts:manage")).toThrow(TypeError);
        expect(() => Set.prototype.delete.call(set, "project:read")).toThrow(TypeError);
      }
      expect(Object.isFrozen(first)).toBe(true);
      const second = effectivePermissions(actor, grants);
      expect(second).not.toBe(first);
      expect(second.installation).not.toBe(first.installation);
      expect(first.project(projectA)).not.toBe(first.project(projectA));
    }
    expect(effectivePermissions(ghost, world()).installation.has("accounts:manage")).toBe(false);
  });

  it("keeps the frozen contract tables closed", async () => {
    const contracts = await import("@/shared/contracts/operations");
    for (const list of [contracts.projectPermissions, contracts.installationPermissions, contracts.roles, contracts.effectStates,
      contracts.retryDispositions, contracts.errorCategories, contracts.actorKinds, contracts.authenticationModes, contracts.listenerKinds]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
    expect(() => (contracts.effectStates as unknown as string[]).push("whatever")).toThrow(TypeError);
  });
});

describe("visibility (decision M)", () => {
  it("is any valid project role on the project, admin everywhere, or full authority; never a permission", () => {
    const grants = world()
      .grant({ accountId: bot, role: "executor", scope: onA })
      .grant({ accountId: alice, role: "secrets", scope: { kind: "project", projectId: projectB } })
      .grant({ accountId: alice, role: "executor", scope: onA });
    const botView = effectivePermissions(agent, grants);
    expect([botView.visible(projectA), botView.visible(projectB)]).toEqual([true, false]);
    expect([...botView.project(projectA)]).toEqual(["worker:execute"]);
    const aliceView = effectivePermissions(human, grants);
    // executor is not valid for a human: no visibility from it.
    expect([aliceView.visible(projectA), aliceView.visible(projectB)]).toEqual([false, true]);
    expect([...aliceView.project(projectB)]).toEqual(["secrets:read", "secrets:write"]);
    const admin = effectivePermissions(human, world().grant({ accountId: alice, role: "admin", scope: whole }));
    expect([admin.visible(projectA), admin.visible(projectB)]).toEqual([true, true]);
    expect(effectivePermissions({ kind: "operator", via: "unix" }, world()).visible(projectB)).toBe(true);
  });
});
