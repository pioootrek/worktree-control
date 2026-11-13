import { describe, expect, it } from "vitest";
import { OperationError } from "./errors";
import { OperationRegistry, type AdmittedCommitScope, type IdleCommitScope, type PhaseScope } from "./operation";
import { deferred, fakeStart, input, key, REGISTRATION, setup, tick, type StartInput, type StartInternal, type StartOperation } from "./runner-fixture";

/** Decision N: an explicit commit point on the effect scope, fixed by the operation definition. */

const internal = (scope: PhaseScope): StartInternal => ({ projectId: scope.resources.registration.projectId, pid: 7, processSecret: "s" });

function idleDeclared(base: StartOperation, run: (scope: IdleCommitScope) => Promise<StartInternal>): StartOperation {
  return { ...base, effect: { mode: "idle", commitPoint: "declared", run: (_input: StartInput, scope: IdleCommitScope) => run(scope) } };
}
function admittedDeclared(base: StartOperation, run: (scope: AdmittedCommitScope) => StartInternal): StartOperation {
  return { ...base, acquire: undefined, effect: { mode: "admitted", commitPoint: "declared", run: (_input: StartInput, scope: AdmittedCommitScope) => run(scope) } };
}

describe("commit point: before it", () => {
  it("keeps a typed refusal's category with effect not_started, skips finalization and releases the reservation", async () => {
    for (const thrown of [new OperationError("conflict", "port_in_use"), new OperationError("busy", "worker_busy"),
      new OperationError("conflict", "claimed_done", { effect: "committed" })]) {
      const { world, alice, runner, idempotency } = setup();
      const { operation, log } = fakeStart(world);
      let calls = 0;
      const refusing = idleDeclared(operation, async () => { calls++; throw thrown; });
      const result = await runner.run(refusing, alice.context, input, key("k-1"));
      expect(result).toEqual({ ok: false, error: {
        category: thrown.category, status: thrown.status, reason: thrown.reason, retry: thrown.category === "busy" ? "retry" : "none", effect: "not_started" } });
      expect(log.audit).toEqual([]);
      expect(log).toMatchObject({ lockHeld: false, lockReleases: 1 });
      expect(idempotency.states()).toEqual([]);
      // The reservation was given back: the same key runs fresh.
      expect(await runner.run(refusing, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { reason: thrown.reason, effect: "not_started" } });
      expect(calls).toBe(2);
    }
  });

  it("reports an untyped failure before the commit point as internal with not_started", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation } = fakeStart(world);
    const failing = idleDeclared(operation, async () => { throw new Error("preflight exploded /secret"); });
    expect(await runner.run(failing, alice.context, input, key("k-1"))).toEqual({ ok: false, error: {
      category: "internal", status: 500, reason: "unexpected_failure", retry: "none", effect: "not_started" } });
    expect(idempotency.states()).toEqual([]);
  });

  it("keeps the record reserved until the commit point and marks it started there", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation } = fakeStart(world);
    const seen: string[][] = [];
    const committing = idleDeclared(operation, async scope => {
      seen.push(idempotency.states());
      await scope.commit();
      seen.push(idempotency.states());
      return internal(scope);
    });
    expect(await runner.run(committing, alice.context, input, key("k-1"))).toMatchObject({ ok: true, replayed: false });
    expect(seen).toEqual([["reserved"], ["started"]]);
    expect(idempotency.states()).toEqual(["completed"]);
    expect(await runner.run(committing, alice.context, input, key("k-1"))).toMatchObject({ ok: true, replayed: true });
  });
});

describe("commit point: from it on", () => {
  it("reports anything thrown after the commit as outcome_unknown and records unknown", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, log } = fakeStart(world);
    const failing = idleDeclared(operation, async scope => { await scope.commit(); throw new OperationError("conflict", "port_in_use"); });
    expect(await runner.run(failing, alice.context, input, key("k-1"))).toEqual({ ok: false, error: {
      category: "outcome_unknown", status: 409, reason: "port_in_use", retry: "inspect_first", effect: "unknown" } });
    expect(log.audit).toEqual(["failed"]);
    expect(idempotency.states()).toEqual(["unknown"]);
    expect(await runner.run(failing, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: {
      category: "outcome_unknown", reason: "previous_attempt_outcome_unknown" } });
  });

  it("reports a handler that settles without declaring its commit point as outcome_unknown", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation } = fakeStart(world);
    const silent = idleDeclared(operation, async scope => internal(scope));
    expect(await runner.run(silent, alice.context, input, key("k-1"))).toEqual({ ok: false, error: {
      category: "outcome_unknown", status: 409, reason: "commit_point_not_declared", retry: "inspect_first", effect: "unknown" } });
    expect(idempotency.states()).toEqual(["unknown"]);
  });
});

describe("commit point: a fresh decision before crossing", () => {
  it("reauthorizes after an awaited preflight; a denial there never crosses", async () => {
    for (const change of ["grants", "credential", "moved", "aborted"] as const) {
      const { world, alice, runner, idempotency } = setup();
      world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: world.resolver.listProjects()[1] } });
      const { operation } = fakeStart(world);
      const preflight = deferred();
      const abort = new AbortController();
      let effects = 0;
      const guarded = idleDeclared(operation, async scope => {
        await preflight.promise;
        await scope.commit();
        effects++;
        return internal(scope);
      });
      const pending = runner.run(guarded, alice.context, input, { idempotencyKey: "k-1", signal: abort.signal });
      await tick();
      if (change === "grants") world.grants.revokeAll(alice.id);
      else if (change === "credential") world.verifier.revoke("provider_session", alice.credentialId);
      else if (change === "moved") world.resolver.move(REGISTRATION, world.resolver.listProjects()[1]);
      else abort.abort();
      preflight.resolve();
      const result = await pending;
      expect(result).toMatchObject({ ok: false, error: { effect: "not_started", ...{
        grants: { category: "not_found", reason: "resource_not_found" },
        credential: { category: "unauthenticated", reason: "credential_no_longer_valid" },
        moved: { category: "conflict", reason: "resource_changed" },
        aborted: { category: "unavailable", reason: "request_cancelled", retry: "retry" },
      }[change] } });
      expect(effects).toBe(0);
      expect(idempotency.states()).toEqual([]);
    }
  });

  it("never treats a swallowed commit refusal as crossing", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation } = fakeStart(world);
    const preflight = deferred();
    const swallowing = idleDeclared(operation, async scope => {
      await preflight.promise;
      await scope.commit().catch(() => undefined);
      return internal(scope);
    });
    const pending = runner.run(swallowing, alice.context, input, key("k-1"));
    await tick();
    world.grants.revokeAll(alice.id);
    preflight.resolve();
    // The handler went on after a refusal: the runner cannot know what it did, and never reports a commit.
    expect(await pending).toMatchObject({ ok: false, error: { effect: "unknown", retry: "inspect_first" } });
    expect(idempotency.states()).toEqual(["unknown"]);
  });

  it("refuses a commit after the handler settled", async () => {
    const { world, alice, runner } = setup();
    const { operation } = fakeStart(world);
    const kept: { scope: IdleCommitScope | null } = { scope: null };
    const leaking = idleDeclared(operation, async scope => { kept.scope = scope; await scope.commit(); return internal(scope); });
    expect(await runner.run(leaking, alice.context, input)).toMatchObject({ ok: true });
    await expect(kept.scope!.commit()).rejects.toMatchObject({ category: "internal", reason: "effect_scope_closed" });
  });

  it("marks the point in the same admitted phase for a synchronous effect", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation } = fakeStart(world);
    const states: string[][] = [];
    const ok = admittedDeclared(operation, scope => { states.push(idempotency.states()); scope.commit(); states.push(idempotency.states()); return internal(scope); });
    world.admission.events = [];
    expect(await runner.run(ok, alice.context, input, key("k-1"))).toMatchObject({ ok: true });
    expect(states).toEqual([["reserved"], ["started"]]);
    // No extra admission for the commit: admission, effect, completion, release.
    expect(world.admission.events.map(event => event.kind)).toEqual(["run", "run", "run", "run"]);
    const refusing = admittedDeclared(operation, () => { throw new OperationError("conflict", "row_exists"); });
    expect(await runner.run(refusing, alice.context, input, key("k-2"))).toEqual({ ok: false, error: {
      category: "conflict", status: 409, reason: "row_exists", retry: "none", effect: "not_started" } });
    const late = admittedDeclared(operation, scope => { scope.commit(); throw new OperationError("conflict", "row_exists"); });
    expect(await runner.run(late, alice.context, input, key("k-3"))).toMatchObject({ ok: false, error: { category: "outcome_unknown", effect: "unknown" } });
  });
});

describe("commit point: fixed by the definition", () => {
  it("gives a commit() only to handlers that declare the point; others are past it at entry", async () => {
    const { world, alice, runner } = setup();
    const { operation } = fakeStart(world);
    let hasCommit: boolean | null = null;
    const atEntry: StartOperation = { ...operation, effect: { mode: "idle", run: async (_input: StartInput, scope: PhaseScope) => {
      hasCommit = "commit" in scope;
      throw new OperationError("conflict", "port_in_use");
    } } };
    expect(await runner.run(atEntry, alice.context, input)).toMatchObject({ ok: false, error: { category: "outcome_unknown", reason: "port_in_use" } });
    expect(hasCommit).toBe(false);
  });

  it("rejects an unknown commit point at registration and at run time, before anything happens", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    const malformed = { ...operation, effect: { ...operation.effect, commitPoint: "sometimes" } } as unknown as StartOperation;
    expect(() => new OperationRegistry().register(malformed)).toThrow(/commit point/);
    expect(await runner.run(malformed, alice.context, input)).toEqual({ ok: false, error: {
      category: "internal", status: 500, reason: "invalid_operation", retry: "none", effect: "not_started" } });
    expect(log).toMatchObject({ attempts: 0, lockReleases: 0 });
  });
});
