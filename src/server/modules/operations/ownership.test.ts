import { describe, expect, it } from "vitest";
import type { ProjectId } from "@/shared/contracts/operations";
import type { AuthenticationContext } from "./authentication-context";
import { durablePrincipal, intentOriginDigest } from "./decide";
import type { EffectScope, MutationOperation, ReadOperation } from "./operation";
import { A, createWorld, P, presented } from "./operations-fixture";
import { decideForPrincipal } from "./principal";
import { createReleaseContext } from "./release";
import { effectivePermissions } from "./grants";
import {
  allOf, authenticated, intentOrigin, onProject, requestSubmitter, scheduleOwner,
  type IntentOrigin, type OperationRequirement, type ResourceRef, type StoredPrincipal,
} from "./requirements";
import { resolveAll } from "./resolver";
import { OperationRunner } from "./runner";

/**
 * Durable ownership and stored principals: `schedule_owner` (`29cf8fa5`
 * delta 5), `remote_request` with `request_submitter` and the application
 * authorization interface (delta 6), and `intent_origin` (OPEN-21).
 */
const projectA = P("project-a");
const projectB = P("project-b");
const notFound = { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: null };

function world() {
  const fixture = createWorld();
  fixture.resolver.addProject(projectA).addProject(projectB);
  const alice = fixture.human("alice");
  const bob = fixture.human("bob");
  for (const id of [alice.id, bob.id]) {
    fixture.grants.grant({ accountId: id, role: "maintainer", scope: { kind: "project", projectId: projectA } });
  }
  return { world: fixture, alice, bob, runner: new OperationRunner(fixture.runtime()) };
}

/** A read guarded by `requirement` over one slot; `reads` counts reads that ran. */
function guarded(requirement: OperationRequirement, ref: ResourceRef, counter = { reads: 0 }): ReadOperation<object, { ok: boolean }, { ok: boolean }> {
  return {
    id: "fixture.guarded_read", kind: "read", requirement, parse: () => ({}), resources: () => ({ item: ref }),
    read: () => { counter.reads++; return { ok: true }; }, publicKeys: ["ok"], project: value => value,
  };
}

describe("schedule_owner", () => {
  const SCHEDULE = { kind: "schedule" as const, id: "schedule-1" };
  const owned = (owner: StoredPrincipal, project: ProjectId = projectA) => (fixture: ReturnType<typeof createWorld>) =>
    fixture.resolver.put(SCHEDULE, project, { kind: "schedule", owner });
  const requirement = { require: allOf(onProject("knowledge:export", "item"), scheduleOwner("item")) };

  it("lets an account act on its own schedule only; any other owner is not_found, like a missing or invisible one", async () => {
    const { world: fixture, alice, bob, runner } = world();
    owned({ kind: "account", accountId: alice.id })(fixture);
    const counter = { reads: 0 };
    expect(await runner.run(guarded(requirement, SCHEDULE, counter), alice.context, {})).toEqual({ ok: true, value: { ok: true }, replayed: false });
    const foreign = await runner.run(guarded(requirement, SCHEDULE, counter), bob.context, {});
    expect(foreign).toEqual({ ok: false, error: notFound });
    for (const owner of [{ kind: "installation" }, { kind: "operator" }] as StoredPrincipal[]) {
      owned(owner)(fixture);
      expect(await runner.run(guarded(requirement, SCHEDULE, counter), alice.context, {})).toEqual(foreign);
    }
    expect(await runner.run(guarded(requirement, { kind: "schedule", id: "missing" }, counter), alice.context, {})).toEqual(foreign);
    owned({ kind: "account", accountId: alice.id }, projectB)(fixture);
    expect(await runner.run(guarded(requirement, SCHEDULE, counter), alice.context, {})).toEqual(foreign);
    expect(counter.reads).toBe(1);
  });

  it("ownership is masked before permissions: the answer does not depend on conjunction order", async () => {
    const { world: fixture, alice, bob, runner } = world();
    owned({ kind: "account", accountId: alice.id })(fixture);
    fixture.grants.revokeAll(bob.id);
    fixture.grants.grant({ accountId: bob.id, role: "reader", scope: { kind: "project", projectId: projectA } });
    for (const require of [allOf(onProject("knowledge:export", "item"), scheduleOwner("item")), allOf(scheduleOwner("item"), onProject("knowledge:export", "item"))]) {
      expect(await runner.run(guarded({ require }, SCHEDULE), bob.context, {})).toEqual({ ok: false, error: notFound });
    }
    // Own schedule, missing permission: only then is the refusal a permission denial.
    owned({ kind: "account", accountId: bob.id })(fixture);
    expect(await runner.run(guarded(requirement, SCHEDULE), bob.context, {})).toMatchObject({ ok: false, error: { category: "forbidden", reason: "permission_denied" } });
  });

  it("full authority manages every schedule, including the operator's", async () => {
    const { world: fixture, runner } = world();
    for (const owner of [{ kind: "account", accountId: A("alice") }, { kind: "installation" }, { kind: "operator" }] as StoredPrincipal[]) {
      owned(owner)(fixture);
      for (const context of [fixture.installation().context, fixture.operator()]) {
        expect(await runner.run(guarded(requirement, SCHEDULE), context, {})).toMatchObject({ ok: true });
      }
    }
  });

  it("records the durable owner: an account, `operator` in better-auth, otherwise `installation`", () => {
    const { world: fixture, alice } = world();
    expect(durablePrincipal(alice.context.revalidate())).toEqual({ kind: "account", accountId: alice.id });
    expect(durablePrincipal(fixture.operator().revalidate())).toEqual({ kind: "operator" });
    expect(durablePrincipal(fixture.boundary("token", "unix").mint(presented()).revalidate())).toEqual({ kind: "installation" });
    expect(durablePrincipal(fixture.installation().context.revalidate())).toEqual({ kind: "installation" });
  });

  it("filters items by durable owner at release", () => {
    const { world: fixture, alice } = world();
    const authority = alice.context.revalidate();
    const release = createReleaseContext(authority, effectivePermissions(authority.actor, fixture.grants), Object.freeze(Object.create(null)));
    expect(release.owns({ kind: "account", accountId: alice.id })).toBe(true);
    for (const owner of [{ kind: "account", accountId: A("bob") }, { kind: "installation" }, { kind: "operator" }, null] as (StoredPrincipal | null)[]) {
      expect(release.owns(owner)).toBe(false);
    }
    const full = fixture.operator().revalidate();
    expect(createReleaseContext(full, effectivePermissions(full.actor, fixture.grants), Object.freeze(Object.create(null))).owns({ kind: "operator" })).toBe(true);
  });
});

describe("remote_request and request_submitter", () => {
  const REQUEST = { kind: "remote_request" as const, id: "request-1" };
  const cancel = { require: allOf(onProject("tests:run", "item"), requestSubmitter("item")) };

  it("only the stored submitter cancels; full authority is not exempt", async () => {
    const { world: fixture, alice, bob, runner } = world();
    fixture.resolver.put(REQUEST, projectA, { kind: "remote_request", submitter: { kind: "account", accountId: alice.id } });
    expect(await runner.run(guarded(cancel, REQUEST), alice.context, {})).toMatchObject({ ok: true });
    const refused = { ok: false, error: { category: "forbidden", status: 403, reason: "not_submitter", retry: "none", effect: null } };
    expect(await runner.run(guarded(cancel, REQUEST), bob.context, {})).toEqual(refused);
    expect(await runner.run(guarded(cancel, REQUEST), fixture.installation().context, {})).toEqual(refused);
    fixture.resolver.setRelation(REQUEST, { kind: "remote_request", submitter: { kind: "installation" } });
    expect(await runner.run(guarded(cancel, REQUEST), fixture.installation().context, {})).toMatchObject({ ok: true });
  });

  it("masks a missing and an invisible request identically", async () => {
    const { world: fixture, alice, runner } = world();
    fixture.resolver.put(REQUEST, projectB, { kind: "remote_request", submitter: { kind: "account", accountId: alice.id } });
    const read = { require: onProject("tests:run", "item") };
    const invisible = await runner.run(guarded(read, REQUEST), alice.context, {});
    expect(invisible).toEqual({ ok: false, error: notFound });
    expect(await runner.run(guarded(read, { kind: "remote_request", id: "missing" }), alice.context, {})).toEqual(invisible);
  });

  it("evaluates the stored submitter's current grants without replacing the caller's context", async () => {
    const { world: fixture, alice, runner } = world();
    const robot = fixture.agent("robot", "worker");
    fixture.grants.grant({ accountId: robot.id, role: "executor", scope: { kind: "project", projectId: projectA } });
    fixture.resolver.put(REQUEST, projectA, { kind: "remote_request", submitter: { kind: "account", accountId: alice.id } });
    const submitterNeeds: OperationRequirement = { require: onProject("tests:run", "request") };
    const seen: unknown[] = [];
    const poll: MutationOperation<object, { assigned: boolean }, { assigned: boolean }> = {
      id: "fixture.worker_poll", kind: "mutation", requirement: { require: onProject("worker:execute", "request") },
      parse: () => ({}), resources: () => ({ request: REQUEST }),
      effect: { mode: "admitted", run: (_input: object, scope: EffectScope) => {
        const relation = scope.resources.request.relation;
        if (relation?.kind !== "remote_request") throw new Error("no submitter");
        const decision = decideForPrincipalViaScope(scope, relation.submitter, submitterNeeds);
        seen.push(decision, scope.authority.actor);
        return { assigned: decision.allowed };
      } },
      publicKeys: ["assigned"], project: value => value,
    };
    expect(await runner.run(poll, robot.context, {})).toEqual({ ok: true, value: { assigned: true }, replayed: false });
    expect(seen[1]).toEqual({ kind: "agent", accountId: robot.id });
    fixture.grants.revokeAll(alice.id);
    expect(await runner.run(poll, robot.context, {})).toEqual({ ok: true, value: { assigned: false }, replayed: false });
    expect(seen[2]).toEqual({ allowed: false, category: "not_found", reason: "resource_not_found" });
  });

  it("stored principals: a disabled account holds nothing, full authority holds everything, sessions are never assumed", () => {
    const { world: fixture, alice } = world();
    const resources = resolveAll(fixture.resolver, { project: { kind: "project", id: projectA } });
    const base = { resources, grants: fixture.grants, now: fixture.clock.now, mode: "better-auth" as const, listener: "worker" as const };
    const needs = { require: onProject("tests:run", "project") };
    expect(decideForPrincipal({ ...base, principal: { kind: "account", accountId: alice.id }, requirement: needs })).toMatchObject({ allowed: true });
    expect(decideForPrincipal({ ...base, principal: { kind: "account", accountId: A("nobody") }, requirement: needs })).toMatchObject({ allowed: false, category: "not_found" });
    expect(decideForPrincipal({ ...base, principal: { kind: "operator" }, requirement: needs })).toMatchObject({ allowed: true });
    expect(decideForPrincipal({ ...base, principal: { kind: "account", accountId: alice.id }, requirement: { ...needs, freshLogin: true } }))
      .toEqual({ allowed: false, category: "login_stale", reason: "fresh_login_required" });
    expect(decideForPrincipal({ ...base, principal: { kind: "mallory" } as unknown as StoredPrincipal, requirement: needs }))
      .toEqual({ allowed: false, category: "forbidden", reason: "invalid_principal" });
  });

  it("stored principals: an unknown or disabled account fails closed where no grant is needed", () => {
    const { world: fixture, alice } = world();
    const base = { resources: {}, grants: fixture.grants, now: fixture.clock.now, mode: "better-auth" as const, listener: "worker" as const };
    const unknown = { kind: "account" as const, accountId: A("nobody") };
    const unavailable = { allowed: false, category: "forbidden", reason: "principal_unavailable" };
    expect(decideForPrincipal({ ...base, principal: unknown, requirement: { require: authenticated() } })).toEqual(unavailable);
    expect(decideForPrincipal({ ...base, principal: unknown, requirement: { require: authenticated(), agents: false } })).toEqual(unavailable);
    // Disabled: the grants store no longer records a kind for the account, whatever grants remain stored.
    fixture.grants.kinds.delete(alice.id);
    const disabled = { kind: "account" as const, accountId: alice.id };
    expect(decideForPrincipal({ ...base, principal: disabled, requirement: { require: authenticated() } })).toEqual(unavailable);
    expect(decideForPrincipal({ ...base, principal: disabled, requirement: { require: authenticated(), agents: false } })).toEqual(unavailable);
    // A referenced resource is still masked first, as for any account holding nothing.
    const resources = resolveAll(fixture.resolver, { project: { kind: "project", id: projectA } });
    expect(decideForPrincipal({ ...base, resources, principal: disabled, requirement: { require: onProject("tests:run", "project") } }))
      .toEqual({ allowed: false, category: "not_found", reason: "resource_not_found" });
    // A known account still passes an `authenticated` requirement, and `agents: false` still refuses an agent.
    const robot = fixture.agent("robot");
    expect(decideForPrincipal({ ...base, principal: { kind: "account", accountId: robot.id }, requirement: { require: authenticated() } })).toMatchObject({ allowed: true });
    expect(decideForPrincipal({ ...base, principal: { kind: "account", accountId: robot.id }, requirement: { require: authenticated(), agents: false } }))
      .toEqual({ allowed: false, category: "forbidden", reason: "human_only" });
  });

  it("is closed outside the synchronous admitted phase", async () => {
    const { world: fixture, alice, runner } = world();
    fixture.resolver.put(REQUEST, projectA, { kind: "remote_request", submitter: { kind: "account", accountId: alice.id } });
    const kept: { scope: EffectScope | null } = { scope: null };
    const idle: MutationOperation<object, { ok: boolean }, { ok: boolean }> = {
      id: "fixture.idle_principal", kind: "mutation", requirement: { require: onProject("tests:run", "request") },
      parse: () => ({}), resources: () => ({ request: REQUEST }),
      effect: { mode: "idle", run: async (_input: object, scope: EffectScope) => {
        kept.scope = scope;
        scope.authorizePrincipal({ kind: "account", accountId: alice.id }, { require: onProject("tests:run", "request") });
        return { ok: true };
      } },
      publicKeys: ["ok"], project: value => value,
    };
    expect(await runner.run(idle, alice.context, {})).toMatchObject({ ok: false, error: { category: "outcome_unknown", reason: "phase_closed" } });
    expect(() => kept.scope!.authorizePrincipal({ kind: "installation" }, { require: onProject("tests:run", "request") })).toThrow(/phase_closed/);
  });
});

/** The scope's interface, as an effect handler calls it. */
function decideForPrincipalViaScope(scope: EffectScope, principal: StoredPrincipal, requirement: OperationRequirement) {
  return scope.authorizePrincipal(principal, requirement);
}

describe("intent_origin", () => {
  const INTENT = { kind: "test_intent" as const, id: "intent-1" };
  const lookup = { require: allOf(onProject("tests:run", "item"), intentOrigin("item")) };

  /** A saved origin whose digest binds its fields; `change` is applied afterwards, so it can break the binding. */
  function origin(principal: StoredPrincipal, credentialId: string, change: Partial<IntentOrigin> = {}): IntentOrigin {
    const bound = { principal, credentialId, credentialGeneration: 1, projectId: projectA, worktree: "/w/main", preset: "node:test", key: "k-1" };
    return { ...bound, digestVersion: 1, digest: intentOriginDigest(1, bound), ...change };
  }
  const save = (fixture: ReturnType<typeof createWorld>, value: IntentOrigin, project: ProjectId = projectA) =>
    fixture.resolver.put(INTENT, project, { kind: "test_intent", origin: value });

  it("lets the original principal look up under the original credential, also from a new coordination session", async () => {
    const { world: fixture, alice, runner } = world();
    save(fixture, origin({ kind: "account", accountId: alice.id }, alice.credentialId));
    expect(await runner.run(guarded(lookup, INTENT), alice.context, {})).toMatchObject({ ok: true });
    fixture.verifier.update("provider_session", alice.credentialId, current => ({ ...current, coordinationSession: { id: "session-new", generation: 1, credentialId: alice.credentialId } }));
    const renewed: AuthenticationContext = fixture.boundary("better-auth", "api").mint(presented({ providerSession: { secret: "cookie-alice" }, browserHeaders: true }));
    expect(await runner.run(guarded(lookup, INTENT), renewed, {})).toMatchObject({ ok: true });
  });

  it("another principal, another credential or a rotated credential sees not_found, like a missing or invisible intent", async () => {
    const { world: fixture, alice, bob, runner } = world();
    const missing = await runner.run(guarded(lookup, { kind: "test_intent", id: "missing" }), alice.context, {});
    expect(missing).toEqual({ ok: false, error: notFound });
    save(fixture, origin({ kind: "account", accountId: alice.id }, alice.credentialId));
    expect(await runner.run(guarded(lookup, INTENT), bob.context, {})).toEqual(missing);
    for (const change of [{ credentialId: "provider-other" }, { credentialGeneration: 2 }] as Partial<IntentOrigin>[]) {
      save(fixture, origin({ kind: "account", accountId: alice.id }, alice.credentialId, change));
      expect(await runner.run(guarded(lookup, INTENT), alice.context, {})).toEqual(missing);
    }
    save(fixture, origin({ kind: "account", accountId: alice.id }, alice.credentialId), projectB);
    expect(await runner.run(guarded(lookup, INTENT), alice.context, {})).toEqual(missing);
    // Full authority is not exempt: an operator has no credential and never adopts an account's intent.
    save(fixture, origin({ kind: "account", accountId: alice.id }, alice.credentialId));
    expect(await runner.run(guarded(lookup, INTENT), fixture.operator(), {})).toEqual(missing);
  });

  it("refuses an unknown digest version and a digest that does not bind the record", async () => {
    const { world: fixture, alice, runner } = world();
    save(fixture, origin({ kind: "account", accountId: alice.id }, alice.credentialId, { digestVersion: 2 }));
    expect(await runner.run(guarded(lookup, INTENT), alice.context, {}))
      .toMatchObject({ ok: false, error: { category: "forbidden", reason: "intent_digest_unsupported" } });
    save(fixture, origin({ kind: "account", accountId: alice.id }, alice.credentialId, { digest: "0".repeat(64) }));
    expect(await runner.run(guarded(lookup, INTENT), alice.context, {}))
      .toMatchObject({ ok: false, error: { category: "forbidden", reason: "intent_digest_mismatch" } });
    expect(() => intentOriginDigest(2, origin({ kind: "installation" }, "c"))).toThrow(TypeError);
  });
});
