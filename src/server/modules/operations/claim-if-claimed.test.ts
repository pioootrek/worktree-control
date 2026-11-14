import { describe, expect, it } from "vitest";
import type { ProjectId } from "@/shared/contracts/operations";
import type { AuthenticationContext } from "./authentication-context";
import { decide } from "./decide";
import { OperationRegistry, type IdleCommitScope, type Lease, type MutationOperation } from "./operation";
import { createWorld, MemoryIdempotency, P } from "./operations-fixture";
import { allOf, claimHolderIfClaimed, onProject, sameProject, type OperationRequirement } from "./requirements";
import { resolveAll } from "./resolver";
import { OperationRunner } from "./runner";

/**
 * `claim_holder_if_claimed` (owner decision `42019833`, `29cf8fa5` delta 3):
 * with no claim anyone holding the permission may act; with a claim only its
 * holder. Full authority is not exempt. The absence is rechecked under the
 * caller's lifecycle coordination before each effect, including after the
 * stop inside a restart.
 */
const projectA = P("project-a");
const projectB = P("project-b");
const CLAIM_A = { kind: "project_claim" as const, id: projectA };
const CLAIM_B = { kind: "project_claim" as const, id: projectB };
const requirement: OperationRequirement = {
  require: allOf(onProject("runtime:control", "project"), claimHolderIfClaimed("claim"), sameProject("project", "claim")),
};

function world() {
  const fixture = createWorld();
  fixture.resolver.addProject(projectA).addProject(projectB)
    .put(CLAIM_A, projectA, { kind: "claim", holder: null }).put(CLAIM_B, projectB, { kind: "claim", holder: null });
  const alice = fixture.human("alice");
  const bob = fixture.human("bob");
  const agent = fixture.agent("robot");
  for (const id of [alice.id, bob.id, agent.id]) fixture.grants.grant({ accountId: id, role: "operator", scope: { kind: "project", projectId: projectA } });
  return { world: fixture, alice, bob, agent };
}

function decision(fixture: ReturnType<typeof createWorld>, context: AuthenticationContext, refs = { project: { kind: "project" as const, id: projectA }, claim: CLAIM_A }) {
  return decide({ authority: context.revalidate(), requirement, resources: resolveAll(fixture.resolver, refs), grants: fixture.grants, now: fixture.clock.now });
}

describe("claim_holder_if_claimed: the decision", () => {
  it("allows anyone holding the permission when no claim exists, including full authority without a session", () => {
    const { world: fixture, alice, agent } = world();
    const installation = fixture.boundary("open", "api");
    fixture.verifier.register(null, "anonymous_installation", "anonymous", { kind: "installation" });
    for (const context of [alice.context, agent.context, fixture.installation().context, installation.mint({ bearers: [], providerSession: null, legacySecret: false, browserHeaders: false }), fixture.operator()]) {
      expect(decision(fixture, context)).toMatchObject({ allowed: true });
    }
  });

  it("allows only the holder's coordination session when a claim exists; full authority is not exempt", () => {
    const { world: fixture, alice, bob, agent } = world();
    fixture.resolver.setRelation(CLAIM_A, { kind: "claim", holder: alice.session });
    expect(decision(fixture, alice.context)).toMatchObject({ allowed: true });
    const held = { allowed: false, category: "claim_held", reason: "claim_held_by_another_session" };
    for (const context of [bob.context, agent.context, fixture.installation().context, fixture.operator()]) expect(decision(fixture, context)).toEqual(held);
    fixture.resolver.setRelation(CLAIM_A, { kind: "claim", holder: agent.session });
    expect(decision(fixture, agent.context)).toMatchObject({ allowed: true });
    expect(decision(fixture, alice.context)).toEqual(held);
  });

  it("refuses a relation of the wrong kind", () => {
    const { world: fixture, alice } = world();
    fixture.resolver.setRelation(CLAIM_A, null);
    expect(decision(fixture, alice.context)).toEqual({ allowed: false, category: "forbidden", reason: "relation_unavailable" });
  });

  it("masks a missing and an invisible project claim identically, and a claim of another project is not_found", async () => {
    const { world: fixture, alice } = world();
    const runner = new OperationRunner(fixture.runtime());
    const read = (claim: { kind: "project_claim"; id: string }) => runner.run({
      id: "fixture.claim_read", kind: "read", requirement,
      parse: () => ({}), resources: () => ({ project: { kind: "project", id: projectA }, claim }),
      read: () => ({ ok: true }), publicKeys: ["ok"], project: value => value,
    }, alice.context, {});
    const missing = await read({ kind: "project_claim", id: "project-missing" });
    const invisible = await read(CLAIM_B);
    expect(missing).toEqual({ ok: false, error: { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: null } });
    expect(invisible).toEqual(missing);
    // Visible to the caller, but the claim of another project: `same_project` refuses it as not_found.
    fixture.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectB } });
    expect(await read(CLAIM_B)).toEqual(missing);
    expect(await read(CLAIM_A)).toEqual({ ok: true, value: { ok: true }, replayed: false });
  });

  it("is registered as a predicate and `same_project` validates its slots", () => {
    expect(new OperationRegistry().register({
      id: "fixture.registered", kind: "read", requirement, parse: () => ({}), resources: () => ({}), read: () => ({}), publicKeys: [], project: () => ({}),
    }).requirement).toEqual(requirement);
    for (const require of [{ kind: "same_project", resources: ["only"] }, { kind: "same_project", resources: ["a", "a"] }, { kind: "same_project", resources: ["__proto__", "b"] }]) {
      expect(() => new OperationRegistry().register({
        id: "fixture.bad", kind: "read", requirement: { require } as unknown as OperationRequirement,
        parse: () => ({}), resources: () => ({}), read: () => ({}), publicKeys: [], project: () => ({}),
      })).toThrow(TypeError);
    }
  });
});

interface RestartInput { projectId: string }
interface RestartResult { projectId: ProjectId }

/** `runtime.restart`: declared commit point before the stop; the claim's absence is rechecked before the start. */
function restart(fixture: ReturnType<typeof createWorld>, hooks: { betweenSteps?: () => void; skipRecheck?: boolean } = {}) {
  const log = { steps: [] as string[], lockHeld: false };
  const operation: MutationOperation<RestartInput, RestartResult, RestartResult> = {
    id: "fixture.runtime_restart", kind: "mutation", requirement,
    parse: raw => ({ projectId: String((raw as RestartInput).projectId) }),
    resources: input => ({ project: { kind: "project", id: input.projectId }, claim: { kind: "project_claim", id: input.projectId } }),
    async acquire(): Promise<Lease> { log.lockHeld = true; return { release: () => { log.lockHeld = false; } }; },
    effect: {
      mode: "idle", commitPoint: "declared",
      async run(input: RestartInput, scope: IdleCommitScope) {
        await scope.commit();
        log.steps.push("stop");
        hooks.betweenSteps?.();
        if (!hooks.skipRecheck) await scope.recheck();
        log.steps.push("start");
        return { projectId: scope.resources.project.projectId };
      },
    },
    retain: true, publicKeys: ["projectId"], project: result => result,
  };
  return { operation, log };
}

describe("claim_holder_if_claimed: rechecked between the steps of a restart", () => {
  it("restarts an unclaimed server and a server claimed by the caller", async () => {
    for (const claimed of [false, true]) {
      const { world: fixture, alice } = world();
      if (claimed) fixture.resolver.setRelation(CLAIM_A, { kind: "claim", holder: alice.session });
      const { operation, log } = restart(fixture);
      expect(await new OperationRunner(fixture.runtime()).run(operation, alice.context, { projectId: projectA }))
        .toEqual({ ok: true, value: { projectId: projectA }, replayed: false });
      expect(log.steps).toEqual(["stop", "start"]);
      expect(log.lockHeld).toBe(false);
    }
  });

  it("refuses a foreign claim before anything happens", async () => {
    const { world: fixture, alice, bob } = world();
    fixture.resolver.setRelation(CLAIM_A, { kind: "claim", holder: bob.session });
    const { operation, log } = restart(fixture);
    expect(await new OperationRunner(fixture.runtime()).run(operation, alice.context, { projectId: projectA }))
      .toEqual({ ok: false, error: { category: "claim_held", status: 409, reason: "claim_held_by_another_session", retry: "none", effect: "not_started" } });
    expect(log.steps).toEqual([]);
  });

  it("a claim taken during the lock wait refuses the restart before the stop", async () => {
    const { world: fixture, alice, bob } = world();
    const { operation, log } = restart(fixture);
    const waiting: typeof operation = { ...operation, async acquire() {
      fixture.resolver.setRelation(CLAIM_A, { kind: "claim", holder: bob.session });
      return operation.acquire!({ projectId: projectA }, undefined);
    } };
    expect(await new OperationRunner(fixture.runtime()).run(waiting, alice.context, { projectId: projectA }))
      .toMatchObject({ ok: false, error: { category: "claim_held", effect: "not_started" } });
    expect(log.steps).toEqual([]);
  });

  it("a claim taken after the stop refuses the start and reports the stop as committed", async () => {
    const { world: fixture, alice, bob } = world();
    const idempotency = new MemoryIdempotency();
    const { operation, log } = restart(fixture, { betweenSteps: () => fixture.resolver.setRelation(CLAIM_A, { kind: "claim", holder: bob.session }) });
    const runner = new OperationRunner(fixture.runtime({ idempotency }));
    expect(await runner.run(operation, alice.context, { projectId: projectA }, { idempotencyKey: "k-1" }))
      .toEqual({ ok: false, error: { category: "claim_held", status: 409, reason: "claim_held_by_another_session", retry: "none", effect: "committed" } });
    expect(log.steps).toEqual(["stop"]);
    expect(log.lockHeld).toBe(false);
    // A retry is told to inspect: the restart was not completed.
    expect(idempotency.states()).toEqual(["unknown"]);
  });

  it("revocation after the stop refuses the start without revealing more", async () => {
    const { world: fixture, alice } = world();
    const { operation, log } = restart(fixture, { betweenSteps: () => fixture.grants.revokeAll(alice.id) });
    expect(await new OperationRunner(fixture.runtime()).run(operation, alice.context, { projectId: projectA }))
      .toEqual({ ok: false, error: { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: "committed" } });
    expect(log.steps).toEqual(["stop"]);
  });

  it("full authority does not pass a foreign claim taken after the stop", async () => {
    const { world: fixture, bob } = world();
    const installation = fixture.installation("api");
    const { operation, log } = restart(fixture, { betweenSteps: () => fixture.resolver.setRelation(CLAIM_A, { kind: "claim", holder: bob.session }) });
    expect(await new OperationRunner(fixture.runtime()).run(operation, installation.context, { projectId: projectA }))
      .toMatchObject({ ok: false, error: { category: "claim_held", effect: "committed" } });
    expect(log.steps).toEqual(["stop"]);
  });

  it("recheck() after the handler settled is refused", async () => {
    const { world: fixture, alice } = world();
    const kept: { scope: IdleCommitScope | null } = { scope: null };
    const { operation } = restart(fixture);
    const keeping: typeof operation = { ...operation, effect: { mode: "idle", commitPoint: "declared", async run(input: RestartInput, scope: IdleCommitScope) {
      kept.scope = scope;
      await scope.commit();
      return { projectId: projectA };
    } } };
    expect(await new OperationRunner(fixture.runtime()).run(keeping, alice.context, { projectId: projectA })).toMatchObject({ ok: true });
    await expect(kept.scope!.recheck()).rejects.toMatchObject({ category: "internal", reason: "effect_scope_closed" });
  });
});
