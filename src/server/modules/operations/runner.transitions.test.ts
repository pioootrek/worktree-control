import { describe, expect, it } from "vitest";
import type { ProjectId } from "@/shared/contracts/operations";
import { OperationRegistry, type AdmittedCommitScope, type EffectScope, type MutationOperation, type TransitionResult } from "./operation";
import { createWorld, MemoryIdempotency, P } from "./operations-fixture";
import { allOf, claimHolder, onProject, type ResolvedResources, type ResourceRef } from "./requirements";
import { OperationRunner } from "./runner";

/**
 * Expected transitions (`29cf8fa5` delta 2, review `ce8aa214` F2): an
 * operation whose own effect changes or removes the resource it was
 * authorized against can release and replay its receipt, while historical
 * authority, unrelated concurrent changes and later changes still refuse.
 */
const projectA = P("project-a");
const projectB = P("project-b");
const CLAIM = { kind: "claim" as const, id: "claim-1" };
const REG = { kind: "registration" as const, id: "reg-1" };
const key = (idempotencyKey: string) => ({ idempotencyKey });

function world() {
  const fixture = createWorld();
  fixture.resolver.addProject(projectA).addProject(projectB).put(REG, projectA);
  const alice = fixture.human("alice");
  fixture.grants.grant({ accountId: alice.id, role: "maintainer", scope: { kind: "project", projectId: projectA } });
  fixture.grants.grant({ accountId: alice.id, role: "maintainer", scope: { kind: "project", projectId: projectB } });
  fixture.resolver.put(CLAIM, projectA, { kind: "claim", holder: alice.session });
  const idempotency = new MemoryIdempotency();
  const runner = new OperationRunner(fixture.runtime({ idempotency }));
  return { world: fixture, alice, idempotency, runner };
}

interface ClaimInput { claimId: string }
interface ClaimResult { claimId: string; projectId: ProjectId }
type ClaimRelease = MutationOperation<ClaimInput, ClaimResult, { claimId: string; released: boolean }>;

/** `claim.release`: the effect removes the holder relation its own requirement (`claim_holder`) relies on. */
function claimRelease(fixture: ReturnType<typeof createWorld>, options: {
  declare?: boolean; report?: TransitionResult | "none"; change?: boolean; extraSlot?: boolean; seen?: ResolvedResources[];
} = {}): ClaimRelease {
  const declare = options.declare ?? true;
  return {
    id: "fixture.claim_release", kind: "mutation",
    requirement: { require: options.extraSlot
      ? allOf(onProject("claims:manage", "claim"), claimHolder("claim"), onProject("project:read", "project"))
      : allOf(onProject("claims:manage", "claim"), claimHolder("claim")) },
    parse: raw => ({ claimId: String((raw as ClaimInput).claimId) }),
    resources: (input): Record<string, ResourceRef> => (options.extraSlot
      ? { claim: { kind: "claim", id: input.claimId }, project: { kind: "project", id: projectA } }
      : { claim: { kind: "claim", id: input.claimId } }),
    ...(declare ? { transitions: ["claim"] } : {}),
    effect: {
      mode: "admitted",
      run: (input: ClaimInput, scope: EffectScope) => {
        if (options.change !== false) fixture.resolver.setRelation(CLAIM, { kind: "claim", holder: null });
        const report = options.report ?? { kind: "changed", projectId: scope.resources.claim.projectId, relation: { kind: "claim", holder: null } };
        if (declare && report !== "none") scope.transition("claim", report);
        return { claimId: input.claimId, projectId: scope.resources.claim.projectId };
      },
    },
    retain: true,
    publicKeys: ["claimId", "released"],
    project: (result, release) => { options.seen?.push(release.resources); return { claimId: result.claimId, released: true }; },
  };
}

describe("expected transitions: claim.release", () => {
  it("without a declared transition, a successful release cannot deliver its own receipt", async () => {
    const { world: fixture, alice, runner } = world();
    const result = await runner.run(claimRelease(fixture, { declare: false }), alice.context, { claimId: CLAIM.id });
    // The effect happened, but the release decision on the current relation refuses it.
    expect(fixture.resolver.resolve(CLAIM)?.relation).toEqual({ kind: "claim", holder: null });
    expect(result).toEqual({ ok: false, error: { category: "conflict", status: 409, reason: "claim_not_held", retry: "none", effect: "committed" } });
  });

  it("with the declared transition, releases the receipt and replays it", async () => {
    const { world: fixture, alice, runner, idempotency } = world();
    const seen: ResolvedResources[] = [];
    const operation = claimRelease(fixture, { seen });
    expect(await runner.run(operation, alice.context, { claimId: CLAIM.id }, key("k-1")))
      .toEqual({ ok: true, value: { claimId: CLAIM.id, released: true }, replayed: false });
    expect(idempotency.states()).toEqual(["completed"]);
    // The projector sees the commit-point resolution only: what the caller could see before the effect.
    expect(seen[0].claim.relation).toEqual({ kind: "claim", holder: alice.session });
    expect(await runner.run(operation, alice.context, { claimId: CLAIM.id }, key("k-1")))
      .toEqual({ ok: true, value: { claimId: CLAIM.id, released: true }, replayed: true });
  });

  it("replay is refused after a later change of the declared slot", async () => {
    const { world: fixture, alice, runner } = world();
    const operation = claimRelease(fixture);
    expect(await runner.run(operation, alice.context, { claimId: CLAIM.id }, key("k-1"))).toMatchObject({ ok: true });
    const bob = fixture.human("bob");
    fixture.resolver.setRelation(CLAIM, { kind: "claim", holder: bob.session });
    expect(await runner.run(operation, alice.context, { claimId: CLAIM.id }, key("k-1")))
      .toEqual({ ok: false, error: { category: "conflict", status: 409, reason: "resource_changed", retry: "none", effect: "not_started" } });
  });

  it("replay keeps historical authority: a caller who lost the project gets not_found", async () => {
    const { world: fixture, alice, runner } = world();
    const operation = claimRelease(fixture);
    expect(await runner.run(operation, alice.context, { claimId: CLAIM.id }, key("k-1"))).toMatchObject({ ok: true });
    fixture.grants.revokeAll(alice.id);
    expect(await runner.run(operation, alice.context, { claimId: CLAIM.id }, key("k-1")))
      .toEqual({ ok: false, error: { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: "not_started" } });
  });

  it("revocation after the effect withholds the receipt", async () => {
    const { world: fixture, alice, runner } = world();
    const operation = claimRelease(fixture);
    const revoking: ClaimRelease = { ...operation, effect: { mode: "admitted", run: (input: ClaimInput, scope: EffectScope) => {
      const value = (operation.effect.run as (i: ClaimInput, s: EffectScope) => ClaimResult)(input, scope);
      fixture.grants.revokeAll(alice.id);
      return value;
    } } };
    const result = await runner.run(revoking, alice.context, { claimId: CLAIM.id });
    expect(result).toEqual({ ok: false, error: { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: "committed" } });
  });

  it("an unrelated concurrent change of an undeclared slot is still resource_changed", async () => {
    const { world: fixture, alice, runner } = world();
    const operation = claimRelease(fixture, { extraSlot: true });
    const racing: ClaimRelease = { ...operation, effect: { mode: "admitted", run: (input: ClaimInput, scope: EffectScope) => {
      const value = (operation.effect.run as (i: ClaimInput, s: EffectScope) => ClaimResult)(input, scope);
      fixture.resolver.put({ kind: "project", id: projectA }, projectA);
      return value;
    } } };
    expect(await runner.run(racing, alice.context, { claimId: CLAIM.id }))
      .toEqual({ ok: false, error: { category: "conflict", status: 409, reason: "resource_changed", retry: "none", effect: "committed" } });
  });

  it("an unreported or contradicted result releases nothing and records unknown", async () => {
    for (const variant of ["unreported", "contradicted", "unchanged-claim"] as const) {
      const { world: fixture, alice, runner, idempotency } = world();
      const operation = variant === "unreported" ? claimRelease(fixture, { report: "none" })
        : variant === "contradicted" ? claimRelease(fixture, { report: { kind: "removed" } })
        : claimRelease(fixture, { report: { kind: "unchanged" } });
      expect(await runner.run(operation, alice.context, { claimId: CLAIM.id }, key("k-1")), variant)
        .toEqual({ ok: false, error: { category: "conflict", status: 409, reason: "transition_unconfirmed", retry: "none", effect: "committed" } });
      expect(idempotency.states(), variant).toEqual(["unknown"]);
      expect(await runner.run(operation, alice.context, { claimId: CLAIM.id }, key("k-1")), variant).toMatchObject({
        ok: false, error: { category: "outcome_unknown", reason: "previous_attempt_outcome_unknown", effect: "unknown" } });
    }
  });

  it("a retried key is decided on the record's resolution before its state is reported", async () => {
    const notFound = { ok: false, error: { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: "not_started" } };
    for (const variant of ["unknown", "started", "reserved", "fingerprint"] as const) {
      const { world: fixture, alice, runner, idempotency } = world();
      const operation = claimRelease(fixture, { report: "none" });
      // The first attempt ends `unknown` (its transition was never reported).
      expect(await runner.run(operation, alice.context, { claimId: CLAIM.id }, key("k-1")), variant)
        .toMatchObject({ ok: false, error: { reason: "transition_unconfirmed" } });
      if (variant === "started" || variant === "reserved") for (const record of idempotency.entries.values()) record.state = variant;
      // With access, the record's state is reported.
      const retry = () => runner.run(operation, alice.context, { claimId: variant === "fingerprint" ? "claim-2" : CLAIM.id }, key("k-1"));
      expect(await retry(), variant).toMatchObject({ ok: false, error: {
        reason: variant === "unknown" ? "previous_attempt_outcome_unknown" : variant === "fingerprint" ? "idempotency_conflict" : "request_in_progress" } });
      // Without it, nothing about the attempt is: not even a conflict or an unknown outcome.
      fixture.grants.revokeAll(alice.id);
      expect(await retry(), variant).toEqual(notFound);
    }
  });

  it("a change the handler reports but never made is not confirmed", async () => {
    const { world: fixture, alice, runner } = world();
    const result = await runner.run(claimRelease(fixture, { change: false }), alice.context, { claimId: CLAIM.id });
    expect(result).toMatchObject({ ok: false, error: { reason: "transition_unconfirmed", effect: "committed" } });
  });

  it("transition() is refused before the commit point and for an undeclared slot", async () => {
    const { world: fixture, alice, runner } = world();
    const early: ClaimRelease = { ...claimRelease(fixture), effect: { mode: "admitted", commitPoint: "declared", run: (input: ClaimInput, scope: AdmittedCommitScope) => {
      scope.transition("claim", { kind: "removed" });
      scope.commit();
      return { claimId: input.claimId, projectId: projectA };
    } } };
    expect(await runner.run(early, alice.context, { claimId: CLAIM.id }))
      .toEqual({ ok: false, error: { category: "internal", status: 500, reason: "transition_before_commit", retry: "none", effect: "not_started" } });
    const undeclared: ClaimRelease = { ...claimRelease(fixture), effect: { mode: "admitted", run: (input: ClaimInput, scope: EffectScope) => {
      scope.transition("other", { kind: "removed" });
      return { claimId: input.claimId, projectId: projectA };
    } } };
    expect(await runner.run(undeclared, alice.context, { claimId: CLAIM.id }))
      .toMatchObject({ ok: false, error: { category: "outcome_unknown", reason: "undeclared_transition", effect: "unknown" } });
  });
});

interface RegInput { registrationId: string }
type RegResult = { registrationId: string };

describe("expected transitions: registration.detach and registration.move", () => {
  const detach = (fixture: ReturnType<typeof createWorld>): MutationOperation<RegInput, RegResult, RegResult> => ({
    id: "fixture.registration_detach", kind: "mutation",
    requirement: { require: onProject("project:manage", "registration") },
    parse: raw => ({ registrationId: String((raw as RegInput).registrationId) }),
    resources: input => ({ registration: { kind: "registration", id: input.registrationId } }),
    transitions: ["registration"],
    effect: { mode: "admitted", run: (input: RegInput, scope: EffectScope) => {
      fixture.resolver.delete(REG);
      scope.transition("registration", { kind: "removed" });
      return { registrationId: input.registrationId };
    } },
    retain: true, publicKeys: ["registrationId"], project: result => result,
  });

  it("detach releases and replays after its own removal, and refuses replay once the id is reused", async () => {
    const { world: fixture, alice, runner } = world();
    const operation = detach(fixture);
    expect(await runner.run(operation, alice.context, { registrationId: REG.id }, key("k-1"))).toEqual({ ok: true, value: { registrationId: REG.id }, replayed: false });
    expect(fixture.resolver.resolve(REG)).toBeNull();
    expect(await runner.run(operation, alice.context, { registrationId: REG.id }, key("k-1"))).toEqual({ ok: true, value: { registrationId: REG.id }, replayed: true });
    // A fresh request without the key: the registration no longer exists.
    expect(await runner.run(operation, alice.context, { registrationId: REG.id })).toMatchObject({ ok: false, error: { category: "not_found", effect: "not_started" } });
    fixture.resolver.put(REG, projectA);
    expect(await runner.run(operation, alice.context, { registrationId: REG.id }, key("k-1")))
      .toMatchObject({ ok: false, error: { category: "conflict", reason: "resource_changed" } });
  });

  const move = (fixture: ReturnType<typeof createWorld>): MutationOperation<RegInput, RegResult, RegResult> => ({
    id: "fixture.registration_move", kind: "mutation",
    requirement: { require: allOf(onProject("project:manage", "source"), onProject("project:manage", "destination")) },
    parse: raw => ({ registrationId: String((raw as RegInput).registrationId) }),
    resources: input => ({ source: { kind: "registration", id: input.registrationId }, destination: { kind: "project", id: projectB } }),
    transitions: ["source"],
    effect: { mode: "admitted", run: (input: RegInput, scope: EffectScope) => {
      fixture.resolver.move(REG, projectB);
      scope.transition("source", { kind: "changed", projectId: projectB, relation: null });
      return { registrationId: input.registrationId };
    } },
    retain: true, publicKeys: ["registrationId"], project: result => result,
  });

  it("move releases and replays; replay needs authority over both the source and the destination", async () => {
    for (const lost of ["none", "source", "destination"] as const) {
      const { world: fixture, alice, runner } = world();
      const operation = move(fixture);
      expect(await runner.run(operation, alice.context, { registrationId: REG.id }, key("k-1")), lost).toMatchObject({ ok: true, replayed: false });
      expect(fixture.resolver.resolve(REG)?.projectId).toBe(projectB);
      if (lost !== "none") {
        fixture.grants.revokeAll(alice.id);
        const kept = lost === "source" ? projectB : projectA;
        fixture.grants.grant({ accountId: alice.id, role: "maintainer", scope: { kind: "project", projectId: kept } });
      }
      const replay = await runner.run(operation, alice.context, { registrationId: REG.id }, key("k-1"));
      if (lost === "none") expect(replay).toEqual({ ok: true, value: { registrationId: REG.id }, replayed: true });
      else expect(replay, lost).toEqual({ ok: false, error: { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: "not_started" } });
    }
  });

  it("move without the declared transition cannot deliver its receipt", async () => {
    const { world: fixture, alice, runner } = world();
    const undeclared: MutationOperation<RegInput, RegResult, RegResult> = { ...move(fixture), transitions: undefined,
      effect: { mode: "admitted", run: (input: RegInput) => { fixture.resolver.move(REG, projectB); return { registrationId: input.registrationId }; } } };
    expect(await runner.run(undeclared, alice.context, { registrationId: REG.id }))
      .toEqual({ ok: false, error: { category: "conflict", status: 409, reason: "resource_changed", retry: "none", effect: "committed" } });
  });
});

describe("expected transitions: definitions", () => {
  it("rejects malformed transition lists at registration and slots the operation does not reference at run time", async () => {
    const { world: fixture, alice, runner } = world();
    const base = claimRelease(fixture);
    for (const transitions of [[], ["claim", "claim"], ["__proto__"], [1]]) {
      expect(() => new OperationRegistry().register({ ...base, transitions } as unknown as ClaimRelease)).toThrow(TypeError);
    }
    expect(new OperationRegistry().register(base).transitions).toEqual(["claim"]);
    expect(await runner.run({ ...base, transitions: ["elsewhere"] }, alice.context, { claimId: CLAIM.id }))
      .toEqual({ ok: false, error: { category: "internal", status: 500, reason: "invalid_operation", retry: "none", effect: "not_started" } });
    expect(fixture.resolver.resolve(CLAIM)?.relation).toEqual({ kind: "claim", holder: alice.session });
  });
});
