import { describe, expect, it } from "vitest";
import type { ProjectId } from "@/shared/contracts/operations";
import type { AuthenticationContext } from "./authentication-context";
import { decide, intentOriginDigest } from "./decide";
import type { EffectScope, MutationOperation, PhaseScope, ReadOperation } from "./operation";
import { A, createWorld, InMemoryGrants, MemoryIdempotency, P, presented } from "./operations-fixture";
import {
  allOf, anyProject, claimHolder, collection, intentOrigin, onProject, requestSubmitter, runOriginatingSession, sameProject, scheduleOwner,
  workerAssignment, type OperationRequirement, type ResourceRef, type ResourceRelation,
} from "./requirements";
import { copyRelation, copyResolution, resolveAll, sameResolution } from "./resolver";
import { OperationRunner } from "./runner";
import { deferred, fakeStart, tick } from "./runner-fixture";
import { sessionDescribe } from "./session-describe";

/**
 * Parentless resources (C0b): a resolution may state `projectId: null`, "no
 * project". Full authority acts on it; every account gets exactly the answer
 * of a missing resource, whatever it holds and whatever the other slots are.
 */
const projectA = P("project-a");
const projectB = P("project-b");
const LOOSE = { kind: "registration" as const, id: "reg-loose" };
const MISSING = { kind: "registration" as const, id: "reg-missing" };
const IN_A = { kind: "registration" as const, id: "reg-a" };
const key = (idempotencyKey: string) => ({ idempotencyKey });
const notFound = (effect: string | null) => ({ ok: false, error: { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect } });

function world() {
  const fixture = createWorld();
  fixture.resolver.addProject(projectA).addProject(projectB).put(LOOSE, null).put(IN_A, projectA);
  // A human with a project role, a human admin (installation scope), and an agent with a project role.
  const maintainer = fixture.human("maintainer");
  fixture.grants.grant({ accountId: maintainer.id, role: "maintainer", scope: { kind: "project", projectId: projectA } });
  const admin = fixture.human("admin");
  fixture.grants.grant({ accountId: admin.id, role: "admin", scope: { kind: "installation" } });
  const robot = fixture.agent("robot");
  fixture.grants.grant({ accountId: robot.id, role: "operator", scope: { kind: "project", projectId: projectA } });
  fixture.verifier.register(null, "anonymous_installation", "anonymous", { kind: "installation" });
  const open: AuthenticationContext = fixture.boundary("open", "api").mint(presented());
  const idempotency = new MemoryIdempotency();
  const runner = new OperationRunner(fixture.runtime({ idempotency }));
  const accounts = { maintainer: maintainer.context, admin: admin.context, robot: robot.context };
  const full = { token: fixture.installation().context, open, operator: fixture.operator() };
  return { fixture, runner, idempotency, accounts, full, maintainer, admin, robot };
}

/** A read guarded by `requirement` over the given slots; `reads` counts reads that ran. */
function guarded(requirement: OperationRequirement, refs: Record<string, ResourceRef>, counter = { reads: 0 }): ReadOperation<object, { ok: boolean }, { ok: boolean }> {
  return {
    id: "fixture.parentless_read", kind: "read", requirement, parse: () => ({}), resources: () => refs,
    read: () => { counter.reads++; return { ok: true }; }, publicKeys: ["ok"], project: value => value,
  };
}

describe("parentless resources through the runner", () => {
  const runtimeControl = { require: onProject("runtime:control", "registration") };

  it("lets the operator and the installation act on a parentless registration", async () => {
    const { fixture, runner, full } = world();
    for (const [name, context] of Object.entries(full)) {
      const { operation, log } = fakeStart(fixture);
      expect(await runner.run(operation, context, { registrationId: LOOSE.id }), name)
        .toEqual({ ok: true, value: { projectId: null, started: true }, replayed: false });
      expect(log.effects, name).toEqual(["start (no project)"]);
    }
  });

  it("refuses every account with exactly the answer for a missing resource, admin and agent included", async () => {
    const { fixture, runner, accounts } = world();
    for (const [name, context] of Object.entries(accounts)) {
      const { operation, log } = fakeStart(fixture, { requirement: runtimeControl });
      const missing = await runner.run(operation, context, { registrationId: MISSING.id });
      expect(missing, name).toEqual(notFound("not_started"));
      expect(await runner.run(operation, context, { registrationId: LOOSE.id }), name).toEqual(missing);
      // The keyed form answers identically and records nothing.
      expect(await runner.run({ ...operation }, context, { registrationId: LOOSE.id }, key(`k-${name}`)), name).toEqual(missing);
      expect(log.effects, name).toEqual([]);
    }
    // Reads answer the same as a missing resource as well, and never run.
    const counter = { reads: 0 };
    for (const [name, context] of Object.entries(accounts)) {
      const read = { require: onProject("project:read", "item") };
      expect(await runner.run(guarded(read, { item: LOOSE }, counter), context, {}), name)
        .toEqual(await runner.run(guarded(read, { item: MISSING }, counter), context, {}));
    }
    expect(counter.reads).toBe(0);
  });

  it("a second, ordinary slot opens no path, whichever slot the requirement names", async () => {
    const { runner, accounts, full } = world();
    const counter = { reads: 0 };
    const refs = { loose: LOOSE, ordinary: IN_A };
    const requirements: OperationRequirement[] = [
      { require: onProject("project:read", "ordinary") },
      { require: onProject("project:read", "loose") },
      { require: allOf(onProject("project:read", "ordinary"), onProject("project:read", "loose")) },
      { require: collection("project:read") },
      { require: anyProject("project:read") },
    ];
    for (const requirement of requirements) {
      for (const [name, context] of Object.entries(accounts)) {
        expect(await runner.run(guarded(requirement, refs, counter), context, {}), name).toEqual(notFound(null));
        // The ordinary slot alone is allowed: the refusal comes from the parentless slot only.
        if (requirement.require.kind === "project" && requirement.require.resource === "ordinary") {
          expect(await runner.run(guarded(requirement, { ordinary: IN_A }, counter), context, {}), name).toMatchObject({ ok: true });
        }
      }
    }
    expect(counter.reads).toBe(3);
    for (const requirement of requirements) {
      for (const [name, context] of Object.entries(full)) {
        expect(await runner.run(guarded(requirement, refs, counter), context, {}), name).toMatchObject({ ok: true });
      }
    }
  });

  it("same_project holds for full authority when every slot is parentless, never for mixed, split or missing slots", async () => {
    const { fixture, runner, full, accounts } = world();
    const other = { kind: "registration" as const, id: "reg-loose-2" };
    const looseClaim = { kind: "claim" as const, id: "claim-loose" };
    fixture.resolver.put(other, null).put(looseClaim, null, { kind: "claim", holder: null });
    const requirement = { require: sameProject("first", "second") };
    // A parentless registration and its claim bound together, as a claim operation binds them.
    const claimOnLoose = { require: allOf(onProject("claims:manage", "registration"), sameProject("registration", "claim")) };
    for (const [name, context] of Object.entries(full)) {
      // All parentless: one value, so the binding holds.
      expect(await runner.run(guarded(requirement, { first: LOOSE, second: other }), context, {}), name).toMatchObject({ ok: true });
      expect(await runner.run(guarded(claimOnLoose, { registration: LOOSE, claim: looseClaim }), context, {}), name).toMatchObject({ ok: true });
      // Parentless and project slots mixed, in either order: no shared value.
      expect(await runner.run(guarded(requirement, { first: LOOSE, second: IN_A }), context, {}), name).toEqual(notFound(null));
      expect(await runner.run(guarded(requirement, { first: IN_A, second: LOOSE }), context, {}), name).toEqual(notFound(null));
      expect(await runner.run(guarded(claimOnLoose, { registration: IN_A, claim: looseClaim }), context, {}), name).toEqual(notFound(null));
      // Different projects, and a missing slot.
      expect(await runner.run(guarded(requirement, { first: IN_A, second: { kind: "project", id: projectB } }), context, {}), name).toEqual(notFound(null));
      expect(await runner.run(guarded(requirement, { first: LOOSE, second: MISSING }), context, {}), name).toEqual(notFound(null));
      expect(await runner.run(guarded(requirement, { first: IN_A, second: { kind: "project", id: projectA } }), context, {}), name).toMatchObject({ ok: true });
    }
    // No account reaches the binding: visibility masks the parentless slots first, admin and agent included.
    const counter = { reads: 0 };
    for (const [name, context] of Object.entries(accounts)) {
      expect(await runner.run(guarded(requirement, { first: LOOSE, second: other }, counter), context, {}), name).toEqual(notFound(null));
      expect(await runner.run(guarded(claimOnLoose, { registration: LOOSE, claim: looseClaim }, counter), context, {}), name).toEqual(notFound(null));
    }
    expect(counter.reads).toBe(0);
  });

  it("a parentless claim, run, schedule, request or attempt is refused for its own holder, owner or assignee", async () => {
    const { fixture, runner, maintainer, robot, accounts } = world();
    const counter = { reads: 0 };
    const cases: [string, ResourceRef, ResourceRelation, OperationRequirement, AuthenticationContext][] = [
      ["claim", { kind: "claim", id: "claim-1" }, { kind: "claim", holder: maintainer.session },
        { require: allOf(onProject("claims:manage", "item"), claimHolder("item")) }, accounts.maintainer],
      ["test run", { kind: "test_run", id: "run-1" }, { kind: "test_run", origin: { sessionId: maintainer.session.id, credentialId: maintainer.credentialId } },
        { require: allOf(onProject("tests:run", "item"), runOriginatingSession("item")) }, accounts.maintainer],
      ["schedule", { kind: "schedule", id: "schedule-1" }, { kind: "schedule", owner: { kind: "account", accountId: maintainer.id } },
        { require: allOf(onProject("knowledge:export", "item"), scheduleOwner("item")) }, accounts.maintainer],
      ["remote request", { kind: "remote_request", id: "request-1" }, { kind: "remote_request", submitter: { kind: "account", accountId: maintainer.id } },
        { require: allOf(onProject("tests:run", "item"), requestSubmitter("item")) }, accounts.maintainer],
      ["worker attempt", { kind: "worker_attempt", id: "attempt-1" }, { kind: "worker_attempt", assignee: { accountId: robot.id, sessionId: robot.session.id } },
        { require: allOf(onProject("worker:execute", "item"), workerAssignment("item")) }, accounts.robot],
    ];
    for (const [name, ref, relation, requirement, owner] of cases) {
      // In the owner's project, the relation lets the owner through; parentless, nothing does.
      fixture.resolver.put(ref, projectA, relation);
      if (name === "worker attempt") fixture.grants.grant({ accountId: robot.id, role: "executor", scope: { kind: "project", projectId: projectA } });
      expect(await runner.run(guarded(requirement, { item: ref }, counter), owner, {}), name).toMatchObject({ ok: true });
      fixture.resolver.put(ref, null, relation);
      const missing = await runner.run(guarded(requirement, { item: { kind: ref.kind, id: "missing" } }, counter), owner, {});
      expect(missing, name).toEqual(notFound(null));
      expect(await runner.run(guarded(requirement, { item: ref }, counter), owner, {}), name).toEqual(missing);
    }
  });

  it("intent_origin compares the origin's project with the resolved project exactly, parentless included", async () => {
    const { fixture, runner, accounts, full } = world();
    // A live installation caller whose own credential and principal the saved origin names, so only the projects can differ.
    const caller = fixture.installation();
    const INTENT = { kind: "test_intent" as const, id: "intent-1" };
    const saved = (projectId: ProjectId | null): ResourceRelation => {
      const bound = { principal: { kind: "installation" as const }, credentialId: caller.credentialId, credentialGeneration: 1,
        projectId, worktree: "/w/main", preset: "node:test", key: "k-1" };
      return { kind: "test_intent", origin: { ...bound, digestVersion: 1, digest: intentOriginDigest(1, bound) } };
    };
    const lookup = { require: allOf(onProject("tests:run", "item"), intentOrigin("item")) };
    const look = (context: AuthenticationContext) => runner.run(guarded(lookup, { item: INTENT }), context, {});
    const missing = await runner.run(guarded(lookup, { item: { kind: "test_intent", id: "missing" } }), caller.context, {});
    expect(missing).toEqual(notFound(null));

    fixture.resolver.put(INTENT, projectA, saved(projectA));
    expect(await look(caller.context), "project origin, same project").toMatchObject({ ok: true });
    fixture.resolver.put(INTENT, null, saved(null));
    expect(await look(caller.context), "parentless origin, parentless resolution").toMatchObject({ ok: true });
    fixture.resolver.put(INTENT, projectA, saved(null));
    expect(await look(caller.context), "parentless origin, project resolution").toEqual(missing);
    fixture.resolver.put(INTENT, null, saved(projectA));
    expect(await look(caller.context), "project origin, parentless resolution").toEqual(missing);

    // On the parentless intent, every account gets the answer for a missing intent, and an operator, without a credential, never adopts it.
    fixture.resolver.put(INTENT, null, saved(null));
    for (const [name, context] of Object.entries(accounts)) expect(await look(context), name).toEqual(missing);
    expect(await look(full.operator), "operator").toEqual(missing);
  });

  it("the version 1 intent digest of an existing origin is fixed, and a parentless project is bound apart from the string \"null\"", () => {
    const existing = { principal: { kind: "account" as const, accountId: A("alice") }, credentialId: "provider-alice", credentialGeneration: 1,
      projectId: projectA, worktree: "/w/main", preset: "node:test", key: "k-1" };
    // Computed with the version 1 algorithm as of ecbc00b9, before parentless origins existed; a change to the encoding of existing origins fails here.
    expect(intentOriginDigest(1, existing)).toBe("67c468b1ee6e5a702f23b94adb53ff4301fb7aa1bab6bc27e4838c3a8e551f62");
    const parentless = intentOriginDigest(1, { ...existing, projectId: null });
    expect(parentless).not.toBe(intentOriginDigest(1, { ...existing, projectId: P("null") }));
    expect(parentless).not.toBe(intentOriginDigest(1, existing));
    // A missing project is never digested as if it were parentless.
    expect(() => intentOriginDigest(1, { ...existing, projectId: undefined as unknown as null })).toThrow(TypeError);
    const withoutProject: Record<string, unknown> = { ...existing };
    delete withoutProject.projectId;
    expect(() => intentOriginDigest(1, withoutProject as unknown as typeof existing)).toThrow(TypeError);
  });

  it("a saved origin states its project explicitly: null or a non-empty string, never missing", () => {
    const origin = { principal: { kind: "installation" }, credentialId: "c", credentialGeneration: 1, worktree: "/w", preset: "p", key: "k", digest: "d", digestVersion: 1 };
    expect(copyRelation({ kind: "test_intent", origin: { ...origin, projectId: null } })).toMatchObject({ origin: { projectId: null } });
    expect(copyRelation({ kind: "test_intent", origin: { ...origin, projectId: "project-a" } })).toMatchObject({ origin: { projectId: "project-a" } });
    expect(copyRelation({ kind: "test_intent", origin }), "missing").toBeUndefined();
    for (const value of [undefined, "", 7, false, { id: "project-a" }]) {
      expect(copyRelation({ kind: "test_intent", origin: { ...origin, projectId: value } }), String(value)).toBeUndefined();
    }
  });

  it("releases parentless items to full authority only and never lists them among projects", async () => {
    const { runner, accounts, full } = world();
    const rows = [{ id: "loose", projectId: null }, { id: "in-a", projectId: projectA }] as { id: string; projectId: ProjectId | null }[];
    const list: ReadOperation<object, { ids: string[]; page: string[] }, { ids: string[]; page: string[] }> = {
      id: "fixture.parentless_list", kind: "read", requirement: { require: collection("project:read") }, parse: () => ({}), resources: () => ({}),
      read: (_input, scope: PhaseScope) => ({
        ids: scope.release.filter(rows, row => row.projectId, "project:read").map(row => row.id),
        page: scope.release.page(rows, { projectOf: row => row.projectId, keyOf: row => row.id, permission: "project:read", limit: 10, cursor: null }).items.map(row => row.id),
      }),
      publicKeys: ["ids", "page"], project: value => value,
    };
    for (const [name, context] of Object.entries(full)) {
      expect(await runner.run(list, context, {}), name).toEqual({ ok: true, value: { ids: ["loose", "in-a"], page: ["in-a", "loose"] }, replayed: false });
    }
    for (const [name, context] of Object.entries(accounts)) {
      expect(await runner.run(list, context, {}), name).toEqual({ ok: true, value: { ids: ["in-a"], page: ["in-a"] }, replayed: false });
    }
    for (const context of [...Object.values(full), accounts.admin]) {
      const described = await runner.run(sessionDescribe, context, {});
      if (!described.ok) throw new Error(JSON.stringify(described.error));
      expect(described.value.projects.map(project => project.projectId)).toEqual([projectA, projectB]);
    }
  });
});

describe("parentless resources: replay, recheck and version", () => {
  it("a retained record with a parentless resolution round-trips and replays", async () => {
    const { fixture, runner, idempotency, full } = world();
    const { operation, log } = fakeStart(fixture);
    expect(await runner.run(operation, full.token, { registrationId: LOOSE.id }, key("k-1"))).toMatchObject({ ok: true, replayed: false });
    const [record] = [...idempotency.entries.values()];
    expect(record.resources.registration.projectId).toBeNull();
    expect(copyResolution(record.resources)?.registration.projectId).toBeNull();
    expect(await runner.run(operation, full.token, { registrationId: LOOSE.id }, key("k-1")))
      .toEqual({ ok: true, value: { projectId: null, started: true }, replayed: true });
    expect(log.effects).toHaveLength(1);
  });

  it("reparenting from no project to a project and back is caught by the version; a stale version is refused", async () => {
    const changed = { ok: false, error: { category: "conflict", status: 409, reason: "resource_changed", retry: "none", effect: "not_started" } };
    // Parentless -> project: the caller may use the destination, the replay is still refused.
    {
      const { fixture, runner, full } = world();
      const { operation, log } = fakeStart(fixture);
      expect(await runner.run(operation, full.token, { registrationId: LOOSE.id }, key("k-1"))).toMatchObject({ ok: true });
      fixture.resolver.move(LOOSE, projectA);
      expect(await runner.run(operation, full.token, { registrationId: LOOSE.id }, key("k-1"))).toEqual(changed);
      // ...and back to parentless: same project value as at retention, newer version: stale, refused.
      fixture.resolver.move(LOOSE, null);
      expect(fixture.resolver.resolve(LOOSE)?.projectId).toBeNull();
      expect(await runner.run(operation, full.token, { registrationId: LOOSE.id }, key("k-1"))).toEqual(changed);
      expect(log.effects).toEqual(["start (no project)"]);
    }
    // Project -> parentless: full authority gets resource_changed, an account the answer for a missing resource.
    {
      const { fixture, runner, full, maintainer } = world();
      const { operation, log } = fakeStart(fixture);
      expect(await runner.run(operation, full.token, { registrationId: IN_A.id }, key("k-1"))).toMatchObject({ ok: true });
      expect(await runner.run(operation, maintainer.context, { registrationId: IN_A.id }, key("k-1"))).toMatchObject({ ok: true });
      fixture.resolver.move(IN_A, null);
      expect(await runner.run(operation, full.token, { registrationId: IN_A.id }, key("k-1"))).toEqual(changed);
      const masked = await runner.run(operation, maintainer.context, { registrationId: IN_A.id }, key("k-1"));
      expect(masked).toEqual(notFound("not_started"));
      expect(JSON.stringify(masked)).not.toContain("project-a");
      expect(log.effects).toEqual(["start project-a", "start project-a"]);
    }
  });

  it("the recheck after the lock wait refuses a reparenting in either direction", async () => {
    for (const [from, to] of [[null, projectA], [projectA, null]] as const) {
      const { fixture, runner, full } = world();
      fixture.resolver.put(LOOSE, from);
      const lock = deferred();
      const { operation, log } = fakeStart(fixture, { lockWait: lock.promise });
      const pending = runner.run(operation, full.operator, { registrationId: LOOSE.id });
      await tick();
      fixture.resolver.move(LOOSE, to);
      lock.resolve();
      expect(await pending, `${from} -> ${to}`).toMatchObject({ ok: false, error: { category: "conflict", reason: "resource_changed", effect: "not_started" } });
      expect(log.effects).toEqual([]);
    }
  });

  it("sameResolution distinguishes parentless from a project and compares versions", () => {
    const { fixture } = world();
    const refs = { r: LOOSE };
    const before = resolveAll(fixture.resolver, refs);
    expect(sameResolution(before, resolveAll(fixture.resolver, refs))).toBe(true);
    fixture.resolver.move(LOOSE, projectA);
    const moved = resolveAll(fixture.resolver, refs);
    expect(sameResolution(before, moved)).toBe(false);
    fixture.resolver.move(LOOSE, null);
    const back = resolveAll(fixture.resolver, refs);
    expect(back.r.projectId).toBeNull();
    expect(sameResolution(before, back)).toBe(false);
    // Same version, project changed to or from `null` in a copy: still different.
    const forged = copyResolution({ r: { ...back.r, projectId: projectA } });
    expect(forged && sameResolution(back, forged)).toBe(false);
  });

  it("a transition may report a slot that became parentless; a wrong report stays unconfirmed", async () => {
    const detach = (report: ProjectId | null): MutationOperation<object, { ok: boolean }, { ok: boolean }> => ({
      id: "fixture.registration_unparent", kind: "mutation", requirement: { require: onProject("project:manage", "registration") },
      parse: () => ({}), resources: () => ({ registration: IN_A }), transitions: ["registration"],
      effect: { mode: "admitted", run: (_input: object, scope: EffectScope) => {
        fixtureRef.current!.resolver.move(IN_A, null);
        scope.transition("registration", { kind: "changed", projectId: report, relation: null });
        return { ok: true };
      } },
      retain: true, publicKeys: ["ok"], project: value => value,
    });
    const fixtureRef: { current: ReturnType<typeof createWorld> | null } = { current: null };
    {
      const { fixture, runner, full } = world();
      fixtureRef.current = fixture;
      expect(await runner.run(detach(null), full.operator, {}, key("k-1"))).toEqual({ ok: true, value: { ok: true }, replayed: false });
      expect(await runner.run(detach(null), full.operator, {}, key("k-1"))).toEqual({ ok: true, value: { ok: true }, replayed: true });
    }
    {
      const { fixture, runner, full } = world();
      fixtureRef.current = fixture;
      expect(await runner.run(detach(projectA), full.operator, {}))
        .toMatchObject({ ok: false, error: { category: "conflict", reason: "transition_unconfirmed", effect: "committed" } });
    }
  });
});

describe("parentless resources: malformed project values stay rejected", () => {
  const malformed: [string, unknown][] = [["absent", undefined], ["empty", ""], ["a number", 7], ["an object", { id: "project-a" }], ["false", false]];

  it("a resolver answer with a malformed project is not found, also for full authority", async () => {
    for (const [name, value] of malformed) {
      const { fixture, runner, full } = world();
      const resolve = fixture.resolver.resolve.bind(fixture.resolver);
      fixture.resolver.resolve = ref => {
        const answer = resolve(ref);
        return answer && ref.id === LOOSE.id ? ({ ...answer, projectId: value } as never) : answer;
      };
      expect(await runner.run(guarded({ require: onProject("project:read", "item") }, { item: LOOSE }), full.operator, {}), name).toEqual(notFound(null));
      expect(copyResolution({ item: { ref: LOOSE, projectId: value, version: 1, relation: null } }), name).toBeNull();
    }
    expect(copyResolution({ item: { ref: LOOSE, projectId: null, version: 1, relation: null } })?.item.projectId).toBeNull();
  });

  it("decide fails closed on a malformed project in a resources record, whoever decides", () => {
    const grants = new InMemoryGrants();
    for (const [name, value] of malformed) {
      const resources = { item: { ref: LOOSE, projectId: value as ProjectId, version: 1, relation: null } };
      const decision = decide({ authority: { actor: { kind: "installation" }, mode: "token", listener: "api", evidence: null, coordinationSession: null },
        requirement: { require: onProject("project:read", "item") }, resources, grants, now: 0 });
      expect(decision, name).toEqual({ allowed: false, category: "not_found", reason: "resource_not_found" });
    }
  });

  it("a transition report with a malformed project is refused", async () => {
    for (const [name, value] of malformed) {
      const { runner, full } = world();
      const operation: MutationOperation<object, { ok: boolean }, { ok: boolean }> = {
        id: "fixture.bad_report", kind: "mutation", requirement: { require: onProject("project:manage", "registration") },
        parse: () => ({}), resources: () => ({ registration: IN_A }), transitions: ["registration"],
        effect: { mode: "admitted", run: (_input: object, scope: EffectScope) => {
          scope.transition("registration", { kind: "changed", projectId: value as ProjectId, relation: null });
          return { ok: true };
        } },
        publicKeys: ["ok"], project: result => result,
      };
      expect(await runner.run(operation, full.operator, {}), name).toMatchObject({ ok: false, error: { category: "outcome_unknown" } });
    }
  });

  it("any_project counts only real projects: a stray null in the project list grants nothing", () => {
    const grants = new InMemoryGrants().account(A("admin"), "human").grant({ accountId: A("admin"), role: "admin", scope: { kind: "installation" } });
    const authority = { actor: { kind: "human" as const, accountId: A("admin") }, mode: "better-auth" as const, listener: "api" as const, evidence: null, coordinationSession: null };
    const requirement = { require: anyProject("project:read") };
    expect(decide({ authority, requirement, resources: {}, grants, now: 0, projects: [null as unknown as ProjectId] }))
      .toEqual({ allowed: false, category: "forbidden", reason: "permission_denied" });
    expect(decide({ authority, requirement, resources: {}, grants, now: 0, projects: [projectA] })).toMatchObject({ allowed: true });
  });
});
