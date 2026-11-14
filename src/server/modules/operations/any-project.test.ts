import { describe, expect, it } from "vitest";
import { isInstallationPermission, type ProjectId } from "@/shared/contracts/operations";
import type { AuthenticationContext } from "./authentication-context";
import { decide } from "./decide";
import { OperationRegistry, type MutationOperation, type ReadOperation } from "./operation";
import { createWorld, P } from "./operations-fixture";
import { anyProject, collection, type OperationRequirement } from "./requirements";
import { OperationRunner } from "./runner";

/**
 * `any_project(permission)` (`29cf8fa5` delta 4, review `ce8aa214` F7):
 * aggregates require the permission on at least one current project. It is
 * decided at every decision point, not by a projector, and it is not the
 * broader visibility of decision M.
 */
const projectA = P("project-a");
const projectB = P("project-b");
const projectC = P("project-c");
const aggregate: OperationRequirement = { require: anyProject("project:read") };

function world(projects: ProjectId[]) {
  const fixture = createWorld();
  for (const project of projects) fixture.resolver.addProject(project);
  const alice = fixture.human("alice");
  return { world: fixture, alice };
}

const decideFor = (fixture: ReturnType<typeof createWorld>, context: AuthenticationContext, requirement = aggregate) =>
  decide({ authority: context.revalidate(), requirement, resources: Object.freeze(Object.create(null)), grants: fixture.grants,
    now: fixture.clock.now, projects: fixture.resolver.listProjects() });
const denied = { allowed: false, category: "forbidden", reason: "permission_denied" };

describe("any_project: the decision", () => {
  it("full authority passes, also on an installation without projects", () => {
    const { world: fixture } = world([]);
    for (const context of [fixture.installation().context, fixture.operator()]) expect(decideFor(fixture, context)).toMatchObject({ allowed: true });
  });

  it("an admin on an installation without projects does not pass: there is no project to hold it on", () => {
    const { world: fixture, alice } = world([]);
    fixture.grants.grant({ accountId: alice.id, role: "admin", scope: { kind: "installation" } });
    expect(decideFor(fixture, alice.context)).toEqual(denied);
    fixture.resolver.addProject(projectA);
    expect(decideFor(fixture, alice.context)).toMatchObject({ allowed: true });
  });

  it("an account with zero, one and several projects", () => {
    const { world: fixture, alice } = world([projectA, projectB, projectC]);
    expect(decideFor(fixture, alice.context)).toEqual(denied);
    fixture.grants.grant({ accountId: alice.id, role: "reader", scope: { kind: "project", projectId: projectB } });
    expect(decideFor(fixture, alice.context)).toMatchObject({ allowed: true });
    fixture.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectA } });
    fixture.grants.grant({ accountId: alice.id, role: "reader", scope: { kind: "project", projectId: projectC } });
    expect(decideFor(fixture, alice.context)).toMatchObject({ allowed: true });
  });

  it("visibility is not enough: secrets-only and executor-only projects do not count", () => {
    const { world: fixture, alice } = world([projectA, projectB]);
    const robot = fixture.agent("robot");
    fixture.grants.grant({ accountId: alice.id, role: "secrets", scope: { kind: "project", projectId: projectA } });
    fixture.grants.grant({ accountId: robot.id, role: "executor", scope: { kind: "project", projectId: projectB } });
    expect(decideFor(fixture, alice.context)).toEqual(denied);
    expect(decideFor(fixture, robot.context)).toEqual(denied);
  });

  it("a grant on a project that no longer exists does not count", () => {
    const { world: fixture, alice } = world([projectA]);
    fixture.grants.grant({ accountId: alice.id, role: "reader", scope: { kind: "project", projectId: projectB } });
    expect(decideFor(fixture, alice.context)).toEqual(denied);
  });

  it("is separate from collection filtering: a collection allows a caller without roles, an aggregate does not", () => {
    const { world: fixture, alice } = world([projectA]);
    expect(decideFor(fixture, alice.context, { require: collection("project:read") })).toMatchObject({ allowed: true });
    expect(decideFor(fixture, alice.context)).toEqual(denied);
  });

  it("fails closed when no project list was supplied", () => {
    const { world: fixture, alice } = world([projectA]);
    fixture.grants.grant({ accountId: alice.id, role: "reader", scope: { kind: "project", projectId: projectA } });
    expect(decide({ authority: alice.context.revalidate(), requirement: aggregate, resources: Object.freeze(Object.create(null)), grants: fixture.grants, now: fixture.clock.now }))
      .toEqual({ allowed: false, category: "forbidden", reason: "project_list_unavailable" });
  });

  it("is a registrable requirement; `projects:remove` is no longer a permission", () => {
    const read: ReadOperation<object, object, object> = {
      id: "fixture.capacity", kind: "read", requirement: aggregate, parse: () => ({}), resources: () => ({}), read: () => ({}), publicKeys: [], project: () => ({}),
    };
    expect(new OperationRegistry().register(read).requirement).toEqual(aggregate);
    expect(isInstallationPermission("projects:remove")).toBe(false);
    expect(() => new OperationRegistry().register({ ...read, requirement: { require: { kind: "installation", permission: "projects:remove" } } } as unknown as typeof read))
      .toThrow(TypeError);
  });
});

describe("any_project: in the runner", () => {
  const capacity = (counter: { reads: number }): ReadOperation<object, { slots: number }, { slots: number }> => ({
    id: "fixture.capacity_read", kind: "read", requirement: aggregate, parse: () => ({}), resources: () => ({}),
    read: () => { counter.reads++; return { slots: 4 }; }, publicKeys: ["slots"], project: value => value,
  });

  it("decides at admission and reads nothing for a caller without an eligible project", async () => {
    const { world: fixture, alice } = world([projectA]);
    const counter = { reads: 0 };
    const runner = new OperationRunner(fixture.runtime());
    expect(await runner.run(capacity(counter), alice.context, {}))
      .toEqual({ ok: false, error: { category: "forbidden", status: 403, reason: "permission_denied", retry: "none", effect: null } });
    expect(counter.reads).toBe(0);
    fixture.grants.grant({ accountId: alice.id, role: "reader", scope: { kind: "project", projectId: projectA } });
    expect(await runner.run(capacity(counter), alice.context, {})).toEqual({ ok: true, value: { slots: 4 }, replayed: false });
  });

  it("is decided again before release: revocation during a mutation withholds the result", async () => {
    const { world: fixture, alice } = world([projectA]);
    fixture.grants.grant({ accountId: alice.id, role: "reader", scope: { kind: "project", projectId: projectA } });
    const mutation: MutationOperation<object, { done: boolean }, { done: boolean }> = {
      id: "fixture.aggregate_mutation", kind: "mutation", requirement: aggregate, parse: () => ({}), resources: () => ({}),
      effect: { mode: "admitted", run: () => { fixture.grants.revokeAll(alice.id); return { done: true }; } },
      publicKeys: ["done"], project: value => value,
    };
    expect(await new OperationRunner(fixture.runtime()).run(mutation, alice.context, {}))
      .toEqual({ ok: false, error: { category: "forbidden", status: 403, reason: "permission_denied", retry: "none", effect: "committed" } });
  });

  it("a failing project list is sanitized and nothing is resolved", async () => {
    const { world: fixture, alice } = world([projectA]);
    fixture.grants.grant({ accountId: alice.id, role: "reader", scope: { kind: "project", projectId: projectA } });
    const runtime = fixture.runtime();
    const runner = new OperationRunner({ ...runtime, resolver: { resolve: ref => fixture.resolver.resolve(ref), listProjects: () => { throw new Error("list /secret"); } } });
    const before = fixture.resolver.resolveCalls;
    expect(await runner.run(capacity({ reads: 0 }), alice.context, {}))
      .toEqual({ ok: false, error: { category: "internal", status: 500, reason: "unexpected_failure", retry: "none", effect: null } });
    expect(fixture.resolver.resolveCalls).toBe(before);
  });
});
