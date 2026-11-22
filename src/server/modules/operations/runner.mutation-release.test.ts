import { describe, expect, it, vi } from "vitest";
import type { PublicOperationError } from "@/shared/contracts/operations";
import { OperationError } from "./errors";
import type { EffectScope, MutationOperation, ReadOperation } from "./operation";
import { MemoryIdempotency } from "./operations-fixture";
import { authenticated } from "./requirements";
import { OperationRunner, type IdempotencyKey, type IdempotencyRecord, type MutationReleaseOptions } from "./runner";
import {
  admittedWrite, answer, gatedAdmission, projectB, recordingDelivery, REGISTRATION, setup, unhandledDuring, type WriteResult,
} from "./runner-fixture";

/**
 * D2b-1: `OperationRunner.mutationRelease` over the fixture store. Every
 * answer is asserted with its five public fields and, separately, the durable
 * record. "Inside admission" is the fixture admission's flag at the moment of
 * the write; "once" is an exact count of admissions and handler calls, so a
 * repeated phase or handler fails the assertion by construction. The
 * negative control at the end shows the flag is false for a write made after
 * the runner returned, as a transport does with `run()`.
 */

type Value = { value: number };
const keyed = (idempotencyKey = "k-1") => ({ idempotencyKey });
const runs = (world: ReturnType<typeof setup>["world"]) => world.admission.events.filter(event => event.kind === "run").length;
/** The only record of a store, deep-copied. */
const only = (idempotency: MemoryIdempotency): IdempotencyRecord | undefined => structuredClone([...idempotency.entries.values()][0]);
const refuseWrite = (error: PublicOperationError, admission: number) => ({ kind: "refuse", value: error, admitted: true, admission });

describe("mutationRelease: a success", () => {
  it("commits the released value inside step 5, once, after one handler call", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, counts } = admittedWrite(world);
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    // Phase 1, phase 3, the completion of step 4, step 5.
    expect(writes).toEqual([{ kind: "commit", value: { value: 1 }, admitted: true, admission: 4 }]);
    expect(runs(world)).toBe(4);
    expect(counts).toMatchObject({ runs: 1, inside: 1, finalizes: 1, projections: 1 });
    expect(idempotency.states()).toEqual(["completed"]);
  });

  it("commits an unkeyed success without a record", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, counts } = admittedWrite(world);
    const { options, writes } = recordingDelivery<Value>(world);
    expect(await runner.mutationRelease(operation, alice.context, { n: 2 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([{ kind: "commit", value: { value: 2 }, admitted: true, admission: 4 }]);
    expect(counts.runs).toBe(1);
    expect(idempotency.calls).toEqual([]);
  });
});

describe("mutationRelease: decision 4, before the effect", () => {
  it.each([
    ["typed", () => { throw new OperationError("conflict", "project_archived"); }, answer("conflict", 409, "project_archived", "none", "not_started")],
    ["untyped", () => { throw new Error("refused before commit /secret"); }, answer("internal", 500, "unexpected_failure", "none", "not_started")],
  ])("a fresh declared handler's %s refusal before its commit point: refused in phase 3, reservation released first", async (_name, before, expected) => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, counts } = admittedWrite(world, { before });
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(expected, 2)]);
    expect(JSON.stringify(writes)).not.toContain("secret");
    // Released inside the refusing phase: no completion admission follows, and `finally` did not repeat it.
    expect(idempotency.calls).toEqual(["get", "reserved", "release"]);
    expect(idempotency.entries.size).toBe(0);
    expect(runs(world)).toBe(2);
    expect(counts).toMatchObject({ runs: 1, finalizes: 0 });
  });

  it("an input error is refused in one admitted phase before any store call", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, counts } = admittedWrite(world);
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: "one" }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(answer("invalid_request", 400, "invalid_input", "none", "not_started"), 1)]);
    expect(idempotency.calls).toEqual([]);
    expect(counts.runs).toBe(0);
  });

  it.each([
    ["a different fingerprint", (record: IdempotencyRecord) => record, { n: 2 }, answer("conflict", 409, "idempotency_conflict", "none", "not_started")],
    ["a reserved record", (record: IdempotencyRecord) => { record.state = "reserved"; delete record.result; return record; }, { n: 1 },
      answer("conflict", 409, "request_in_progress", "none", "not_started")],
    ["a started record", (record: IdempotencyRecord) => { record.state = "started"; delete record.result; return record; }, { n: 1 },
      answer("conflict", 409, "request_in_progress", "none", "not_started")],
    ["a matching unknown record", (record: IdempotencyRecord) => { record.state = "unknown"; delete record.result; return record; }, { n: 1 },
      answer("outcome_unknown", 409, "previous_attempt_outcome_unknown", "inspect_first", "unknown")],
  ])("an answer from %s is refused in phase 1 and leaves the record alone", async (_name, change, raw, expected) => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, counts } = admittedWrite(world);
    await runner.mutationRelease(operation, alice.context, { n: 1 }, recordingDelivery<Value>(world, keyed()).options);
    const [[storeKey, record]] = [...idempotency.entries];
    idempotency.entries.set(storeKey, change(record));
    const stored = only(idempotency);
    world.admission.events = [];
    idempotency.calls.length = 0;
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, raw, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(expected, 1)]);
    expect(only(idempotency)).toEqual(stored);
    expect(idempotency.calls).toEqual(["get"]);
    expect(counts.runs).toBe(1);
  });

  it("a capacity refusal of the reservation is refused in phase 1 after the (no-op) release", async () => {
    const { world, alice, runner, idempotency } = setup();
    const put = idempotency.put.bind(idempotency);
    idempotency.put = (key: IdempotencyKey, record: IdempotencyRecord) => {
      if (record.state === "reserved") { idempotency.calls.push("reserved"); throw new OperationError("busy", "idempotency_capacity", { retry: "retry" }); }
      put(key, record);
    };
    const { operation, counts } = admittedWrite(world);
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(answer("busy", 503, "idempotency_capacity", "retry", "not_started"), 1)]);
    expect(idempotency.calls).toEqual(["get", "reserved", "release"]);
    expect(idempotency.entries.size).toBe(0);
    expect(counts.runs).toBe(0);
  });
});

describe("mutationRelease: the release policy before the effect", () => {
  const notEligible = answer("unavailable", 503, "release_not_eligible", "none", "not_started");
  const timedOut = answer("unavailable", 503, "release_timed_out", "retry", "not_started");
  const cancelledAnswer = answer("unavailable", 503, "request_cancelled", "retry", "not_started");

  it.each<[string, (world: ReturnType<typeof setup>["world"]) => Partial<MutationReleaseOptions<Value>>, PublicOperationError]>([
    ["ineligible", () => ({ eligible: () => false }), notEligible],
    ["past the deadline", world => ({ deadline: world.clock.now }), timedOut],
    ["disconnected", () => ({ connected: () => false }), cancelledAnswer],
    ["eligible as a thenable", () => ({ eligible: () => Promise.resolve(true) as unknown as boolean }), notEligible],
  ])("phase 1 %s: returned without a write and before any store call", async (_name, policy, expected) => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, counts } = admittedWrite(world);
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), ...policy(world) });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "refused", error: expected });
    expect(writes).toEqual([]);
    expect(idempotency.calls).toEqual([]);
    expect(counts.runs).toBe(0);
  });

  it("an aborted signal: the admission is refused before its callback, returned as a cancellation", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation } = admittedWrite(world);
    const controller = new AbortController();
    controller.abort();
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), signal: controller.signal });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "refused", error: cancelledAnswer });
    expect(writes).toEqual([]);
    expect(runs(world)).toBe(0);
    expect(idempotency.calls).toEqual([]);
  });

  it.each<[string, (world: ReturnType<typeof setup>["world"], deadline: number) => Partial<MutationReleaseOptions<Value>>, PublicOperationError]>([
    ["ineligible", () => { let calls = 0; return { eligible: () => ++calls === 1 }; }, notEligible],
    ["past the deadline", (world, deadline) => {
      world.admission.onAdmit = event => { if (event.n === 2) world.clock.now = deadline; };
      return { deadline };
    }, timedOut],
    ["disconnected", () => { let calls = 0; return { connected: () => ++calls === 1 }; }, cancelledAnswer],
  ])("phase 3 %s: the owned reservation is released in that phase, nothing is written", async (_name, policy, expected) => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, counts } = admittedWrite(world);
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), ...policy(world, world.clock.now + 10) });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "refused", error: expected });
    expect(writes).toEqual([]);
    expect(idempotency.calls).toEqual(["get", "reserved", "release"]);
    expect(idempotency.entries.size).toBe(0);
    expect(runs(world)).toBe(2);
    expect(counts.runs).toBe(0);
  });

  it("the deadline reached inside the handler before its commit point: the refusal is not written, the reservation is released", async () => {
    const { world, alice, runner, idempotency } = setup();
    const deadline = world.clock.now + 10;
    const { operation } = admittedWrite(world, { before: () => { world.clock.now = deadline; throw new OperationError("conflict", "project_archived"); } });
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), deadline });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "refused", error: timedOut });
    expect(writes).toEqual([]);
    expect(idempotency.entries.size).toBe(0);
  });
});

describe("mutationRelease: decision 4, after the effect", () => {
  const notFound = (retry: string, effect: "committed" | "cleanup_unconfirmed") => answer("not_found", 404, "resource_not_found", retry, effect);

  it("a fresh denial after a confirmed success: the fresh reason with effect committed; the record stays completed", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation } = admittedWrite(world, { finalize: () => world.grants.revokeAll(alice.id) });
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(notFound("none", "committed"), 4)]);
    expect(idempotency.states()).toEqual(["completed"]);
  });

  it("a busy refusal after a begun effect is not released as busy", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation } = admittedWrite(world, { project: () => { throw new OperationError("busy", "projection_busy", { retry: "retry" }); } });
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(answer("unavailable", 503, "projection_busy", "none", "committed"), 4)]);
    expect(idempotency.states()).toEqual(["completed"]);
  });

  it.each<[string, (world: ReturnType<typeof setup>["world"], deadline: number) => Partial<MutationReleaseOptions<Value>>, PublicOperationError]>([
    ["ineligible", () => { let calls = 0; return { eligible: () => ++calls <= 2 }; }, answer("unavailable", 503, "release_not_eligible", "none", "committed")],
    ["past the deadline", (world, deadline) => {
      world.admission.onAdmit = event => { if (event.n === 4) world.clock.now = deadline; };
      return { deadline };
    }, answer("unavailable", 503, "release_timed_out", "none", "committed")],
    ["disconnected", () => { let calls = 0; return { connected: () => ++calls <= 2 }; }, answer("unavailable", 503, "request_cancelled", "none", "committed")],
  ])("a policy refusal in step 5 after a confirmed success (%s) is returned with effect committed, never written", async (_name, policy, expected) => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, counts } = admittedWrite(world);
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), ...policy(world, world.clock.now + 10) });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "refused", error: expected });
    expect(writes).toEqual([]);
    expect(counts.runs).toBe(1);
    expect(idempotency.states()).toEqual(["completed"]);
  });

  it("the deadline reached during the projection: the success is not written", async () => {
    const { world, alice, runner, idempotency } = setup();
    const deadline = world.clock.now + 10;
    const { operation } = admittedWrite(world, { project: result => { world.clock.now = deadline; return { value: result.n }; } });
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), deadline });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options))
      .toEqual({ status: "refused", error: answer("unavailable", 503, "release_timed_out", "none", "committed") });
    expect(writes).toEqual([]);
    expect(idempotency.states()).toEqual(["completed"]);
  });

  it("an unknown effect: outcome_unknown with the classified reason; with a fresh denial, that denial's reason", async () => {
    for (const revoked of [false, true]) {
      const { world, alice, runner, idempotency } = setup();
      const { operation } = admittedWrite(world, {
        after: () => { throw new OperationError("conflict", "effect_failed"); },
        finalize: () => { if (revoked) world.grants.revokeAll(alice.id); },
      });
      const { options, writes } = recordingDelivery<Value>(world, keyed());
      expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
      const reason = revoked ? "resource_not_found" : "effect_failed";
      expect(writes, String(revoked)).toEqual([refuseWrite(answer("outcome_unknown", 409, reason, "inspect_first", "unknown"), 4)]);
      expect(idempotency.states()).toEqual(["unknown"]);
    }
  });

  it("a failed finalization: cleanup unconfirmed; with a fresh denial, that denial with inspect_first", async () => {
    for (const revoked of [false, true]) {
      const { world, alice, runner, idempotency } = setup();
      const { operation } = admittedWrite(world, {
        finalize: () => { if (revoked) world.grants.revokeAll(alice.id); throw new Error("audit store down /secret"); },
      });
      const { options, writes } = recordingDelivery<Value>(world, keyed());
      expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
      expect(writes, String(revoked)).toEqual([refuseWrite(revoked ? notFound("inspect_first", "cleanup_unconfirmed")
        : answer("unavailable", 503, "finalization_unconfirmed", "inspect_first", "cleanup_unconfirmed"), 4)]);
      expect(idempotency.states()).toEqual(["unknown"]);
    }
  });

  it.each<[string, (store: MemoryIdempotency) => void, string, string]>([
    ["repaired at once", store => { store.failAfterWrite.add("completed"); }, "unknown", "outcome_unknown"],
    ["landed, its repair failed: replays", store => { store.failAfterWrite.add("completed"); store.failOn.add("unknown"); }, "completed", "replay"],
    ["refused, its repair failed: stays started", store => { store.failOn.add("completed"); store.failOn.add("unknown"); }, "started", "request_in_progress"],
  ])("decision Z, a final write %s: cleanup unconfirmed to the caller", async (_name, inject, record, retry) => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, counts } = admittedWrite(world);
    inject(idempotency);
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(answer("unavailable", 503, "finalization_unconfirmed", "inspect_first", "cleanup_unconfirmed"), 4)]);
    expect(idempotency.states()).toEqual([record]);
    idempotency.failOn.clear(); idempotency.failAfterWrite.clear();
    const again = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, again.options)).toEqual({ status: "committed" });
    expect(again.writes.map(write => write.kind === "commit" ? "replay" : (write.value as PublicOperationError).reason.replace("previous_attempt_outcome_unknown", "outcome_unknown")))
      .toEqual([retry]);
    expect(counts.runs).toBe(1);
  });

  it("an unconfirmed transition: conflict/transition_unconfirmed with effect committed; the record is unknown", async () => {
    const { world, alice, runner, idempotency } = setup();
    const operation: MutationOperation<{ n: number }, WriteResult, Value> = {
      ...admittedWrite(world).operation,
      transitions: ["registration"],
      effect: { mode: "admitted", run: (value: { n: number }, scope: EffectScope) => {
        // Reported removed, but the registration still resolves: the resolver cannot confirm it.
        scope.transition("registration", { kind: "removed" });
        return { n: value.n, projectId: scope.resources.registration.projectId };
      } },
    };
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(answer("conflict", 409, "transition_unconfirmed", "none", "committed"), 4)]);
    expect(idempotency.states()).toEqual(["unknown"]);
  });
});

describe("mutationRelease: one delivery attempt", () => {
  const failed = (retry: string, effect: "not_started" | "committed" | "cleanup_unconfirmed") => answer("internal", 500, "release_commit_failed", retry, effect);

  it.each<[string, (sink: string[]) => (value: unknown) => void]>([
    ["throws before any byte", () => () => { throw new Error("socket gone /secret"); }],
    ["throws after a partial write", sink => () => { sink.push("partial"); throw new Error("socket gone /secret"); }],
    ["returns a thenable", sink => (async () => { sink.push("async"); throw new Error("late /secret"); }) as unknown as (value: unknown) => void],
  ])("a commit that %s is commit_failed with effect committed; nothing else is written; the record stays completed", async (_name, make) => {
    const unhandled = await unhandledDuring(async () => {
      const { world, alice, runner, idempotency } = setup();
      const { operation, counts } = admittedWrite(world);
      const sink: string[] = [];
      const commit = vi.fn(make(sink));
      const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), commit });
      expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "commit_failed", error: failed("none", "committed") });
      expect(commit).toHaveBeenCalledTimes(1);
      expect(writes).toEqual([]);
      expect(sink.length).toBeLessThanOrEqual(1);
      expect(counts.runs).toBe(1);
      expect(idempotency.states()).toEqual(["completed"]);
    });
    expect(unhandled).toEqual([]);
  });

  it.each<[string, Parameters<typeof admittedWrite>[1], PublicOperationError, string[]]>([
    ["a refusal before the commit point (not_started)", { before: () => { throw new OperationError("conflict", "project_archived"); } }, failed("none", "not_started"), []],
    ["cleanup unconfirmed", { finalize: () => { throw new Error("audit down"); } }, failed("inspect_first", "cleanup_unconfirmed"), ["unknown"]],
    ["an unknown effect", { after: () => { throw new Error("effect failed"); } },
      answer("outcome_unknown", 409, "release_commit_failed", "inspect_first", "unknown"), ["unknown"]],
  ])("a refuse that throws while reporting %s is commit_failed with that effect; the record is not changed by it", async (_name, hooks, expected, record) => {
    const { world, alice, runner, idempotency } = setup();
    const { operation } = admittedWrite(world, hooks);
    const refuse = vi.fn(() => { throw new Error("socket gone"); });
    const { options } = recordingDelivery<Value>(world, { ...keyed(), refuse });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "commit_failed", error: expected });
    expect(refuse).toHaveBeenCalledTimes(1);
    expect(idempotency.states()).toEqual(record);
  });

  it("a refuse that fails while reporting a previous unknown outcome is a delivery failure of this invocation", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation } = admittedWrite(world, { after: () => { throw new Error("effect failed"); } });
    await runner.mutationRelease(operation, alice.context, { n: 1 }, recordingDelivery<Value>(world, keyed()).options);
    const stored = only(idempotency);
    const refuse = vi.fn(() => { throw new Error("socket gone"); });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, recordingDelivery<Value>(world, { ...keyed(), refuse }).options))
      .toEqual({ status: "commit_failed", error: failed("none", "not_started") });
    expect(only(idempotency)).toEqual(stored);
  });
});

describe("mutationRelease: replay of a completed record", () => {
  async function completed() {
    const state = setup();
    const write = admittedWrite(state.world);
    expect(await state.runner.mutationRelease(write.operation, state.alice.context, { n: 1 }, recordingDelivery<Value>(state.world, keyed()).options))
      .toEqual({ status: "committed" });
    state.world.admission.events = [];
    state.idempotency.calls.length = 0;
    return { ...state, ...write, stored: only(state.idempotency) };
  }

  it("commits the replay inside phase 1; the handler does not run again", async () => {
    const { world, alice, runner, idempotency, operation, counts, stored } = await completed();
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([{ kind: "commit", value: { value: 1 }, admitted: true, admission: 1 }]);
    expect(runs(world)).toBe(1);
    expect(counts.runs).toBe(1);
    expect(idempotency.calls).toEqual(["get"]);
    expect(only(idempotency)).toEqual(stored);
  });

  it("an ordinary denial of a replay carries this invocation's not_started; the record is untouched", async () => {
    const { world, alice, runner, idempotency, operation, stored } = await completed();
    world.grants.revokeAll(alice.id);
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(answer("not_found", 404, "resource_not_found", "none", "not_started"), 1)]);
    expect(only(idempotency)).toEqual(stored);
  });

  it("a moved resource refuses the replay as resource_changed; the record is untouched", async () => {
    const { world, alice, runner, idempotency, operation, stored } = await completed();
    world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectB } });
    world.resolver.move(REGISTRATION, projectB);
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(answer("conflict", 409, "resource_changed", "none", "not_started"), 1)]);
    expect(only(idempotency)).toEqual(stored);
  });

  it("a failed delivery of a replay is commit_failed with not_started; the record is untouched", async () => {
    const { world, alice, runner, idempotency, operation, stored } = await completed();
    const commit = vi.fn(() => { throw new Error("socket gone"); });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, recordingDelivery<Value>(world, { ...keyed(), commit }).options))
      .toEqual({ status: "commit_failed", error: answer("internal", 500, "release_commit_failed", "none", "not_started") });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(only(idempotency)).toEqual(stored);
  });

  it("the deadline reached during the replay's projection: the replay is not written", async () => {
    const { world, alice, runner, idempotency, stored } = await completed();
    const deadline = world.clock.now + 10;
    const { operation } = admittedWrite(world, { project: result => { world.clock.now = deadline; return { value: result.n }; } });
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), deadline });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options))
      .toEqual({ status: "refused", error: answer("unavailable", 503, "release_timed_out", "retry", "not_started") });
    expect(writes).toEqual([]);
    expect(only(idempotency)).toEqual(stored);
  });
});

describe("mutationRelease: refusals found before any admission", () => {
  it.each<[string, (state: ReturnType<typeof setup>) => { runner: OperationRunner; operation: MutationOperation<{ n: number }, WriteResult, Value>; key: string }, PublicOperationError]>([
    ["a malformed key", state => ({ runner: state.runner, operation: admittedWrite(state.world).operation, key: "not a key!" }),
      answer("invalid_request", 400, "invalid_idempotency_key", "none", "not_started")],
    ["a key on an operation without retain", state => ({ runner: state.runner, operation: { ...admittedWrite(state.world).operation, retain: undefined }, key: "k-1" }),
      answer("invalid_request", 400, "idempotency_not_supported", "none", "not_started")],
    ["a key without a store", state => ({ runner: new OperationRunner(state.world.runtime()), operation: admittedWrite(state.world).operation, key: "k-1" }),
      answer("unavailable", 503, "idempotency_unavailable", "none", "not_started")],
    ["a key without a fingerprint key", state => ({
      runner: new OperationRunner({ ...state.world.runtime({ idempotency: state.idempotency }), fingerprintKey: undefined }),
      operation: admittedWrite(state.world).operation, key: "k-1",
    }), answer("unavailable", 503, "idempotency_unavailable", "none", "not_started")],
  ])("%s is refused in one admitted phase that revalidated the context", async (_name, make, expected) => {
    const state = setup();
    const { runner, operation, key } = make(state);
    const { options, writes } = recordingDelivery<Value>(state.world, keyed(key));
    expect(await runner.mutationRelease(operation, state.alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(expected, 1)]);
    expect(state.idempotency.calls).toEqual([]);
  });

  it("a context that no longer validates receives that answer instead of the input error", async () => {
    const { world, alice, runner } = setup();
    const { operation } = admittedWrite(world);
    world.verifier.revoke("provider_session", alice.credentialId);
    const { options, writes } = recordingDelivery<Value>(world);
    expect(await runner.mutationRelease(operation, alice.context, { n: "one" }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(answer("unauthenticated", 401, "credential_no_longer_valid", "reauthenticate", "not_started"), 1)]);
  });

  it("the delivery policy is checked before an early revalidation denial is written", async () => {
    const { world, alice, runner } = setup();
    const { operation } = admittedWrite(world);
    world.verifier.revoke("provider_session", alice.credentialId);
    const { options, writes } = recordingDelivery<Value>(world, { eligible: () => false });
    expect(await runner.mutationRelease(operation, alice.context, { n: "one" }, options))
      .toEqual({ status: "refused", error: answer("unavailable", 503, "release_not_eligible", "none", "not_started") });
    expect(writes).toEqual([]);
  });

  it("in phase 1, a revalidation that throws before the policy check still meets the policy before its write", async () => {
    for (const eligible of [true, false]) {
      const { world, alice, runner, idempotency } = setup();
      const { operation } = admittedWrite(world);
      world.verifier.revoke("provider_session", alice.credentialId);
      const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), eligible: () => eligible });
      const result = await runner.mutationRelease(operation, alice.context, { n: 1 }, options);
      if (eligible) {
        expect(result).toEqual({ status: "committed" });
        expect(writes).toEqual([refuseWrite(answer("unauthenticated", 401, "credential_no_longer_valid", "reauthenticate", "not_started"), 1)]);
      } else {
        expect(result).toEqual({ status: "refused", error: answer("unavailable", 503, "release_not_eligible", "none", "not_started") });
        expect(writes).toEqual([]);
      }
      expect(idempotency.calls).toEqual([]);
    }
  });

  it("in step 5, a revalidation that throws before the policy check still meets the policy before its write", async () => {
    for (const eligibleAtRelease of [true, false]) {
      const { world, alice, runner, idempotency } = setup();
      const { operation } = admittedWrite(world, { finalize: () => world.verifier.revoke("provider_session", alice.credentialId) });
      let calls = 0;
      const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), eligible: () => ++calls <= 2 || eligibleAtRelease });
      const result = await runner.mutationRelease(operation, alice.context, { n: 1 }, options);
      if (eligibleAtRelease) {
        expect(result).toEqual({ status: "committed" });
        expect(writes).toEqual([refuseWrite(answer("unauthenticated", 401, "credential_no_longer_valid", "none", "committed"), 4)]);
      } else {
        expect(result).toEqual({ status: "refused", error: answer("unavailable", 503, "release_not_eligible", "none", "committed") });
        expect(writes).toEqual([]);
      }
      expect(idempotency.states()).toEqual(["completed"]);
    }
  });
});

describe("mutationRelease: the reservation rule", () => {
  it("an immediate retry after a confirmed release runs fresh", async () => {
    const { world, alice, runner, idempotency } = setup();
    let refuseOnce = true;
    const { operation, counts } = admittedWrite(world, { before: () => { if (refuseOnce) { refuseOnce = false; throw new OperationError("conflict", "project_archived"); } } });
    const first = recordingDelivery<Value>(world, keyed());
    await runner.mutationRelease(operation, alice.context, { n: 1 }, first.options);
    expect(first.writes.map(write => write.kind)).toEqual(["refuse"]);
    const retry = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, retry.options)).toEqual({ status: "committed" });
    expect(retry.writes).toEqual([{ kind: "commit", value: { value: 1 }, admitted: true, admission: 6 }]);
    expect(counts.runs).toBe(2);
    expect(idempotency.states()).toEqual(["completed"]);
  });

  it.each<[string, (store: MemoryIdempotency) => void, string[]]>([
    ["throws before deleting", store => { store.failOn.add("release"); }, ["reserved"]],
    ["deletes and then throws", store => { store.failAfterWrite.add("release"); }, []],
    ["returns a thenable", store => {
      const release = store.release.bind(store);
      store.release = (key, attempt) => { release(key, attempt); return Promise.reject(new Error("late /secret")) as unknown as void; };
    }, []],
  ])("a release that %s keeps the original refusal; `finally` never repeats it", async (_name, inject, record) => {
    const unhandled = await unhandledDuring(async () => {
      const { world, alice, runner, idempotency } = setup();
      inject(idempotency);
      const { operation } = admittedWrite(world, { before: () => { throw new OperationError("conflict", "project_archived"); } });
      const { options, writes } = recordingDelivery<Value>(world, keyed());
      expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
      expect(writes).toEqual([refuseWrite(answer("conflict", 409, "project_archived", "none", "not_started"), 2)]);
      expect(idempotency.calls).toEqual(["get", "reserved", "release"]);
      expect(runs(world)).toBe(2);
      expect(idempotency.states()).toEqual(record);
    });
    expect(unhandled).toEqual([]);
  });

  it("a reservation that landed and then threw is given back in phase 1 before its refusal", async () => {
    const { world, alice, runner, idempotency } = setup();
    idempotency.failAfterWrite.add("reserved");
    const { operation, counts } = admittedWrite(world);
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(answer("internal", 500, "unexpected_failure", "none", "not_started"), 1)]);
    expect(idempotency.calls).toEqual(["get", "reserved", "release"]);
    expect(idempotency.entries.size).toBe(0);
    expect(counts.runs).toBe(0);
  });

  it("a phase 3 admission refused before its callback keeps the reserved completion path", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, counts } = admittedWrite(world);
    world.admission.onAdmit = event => { if (event.n === 2) throw Object.assign(new Error("admission busy"), { name: "ExclusiveConnectionError", code: "busy" }); };
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options))
      .toEqual({ status: "refused", error: answer("busy", 503, "admission_refused", "retry", "not_started") });
    expect(writes).toEqual([]);
    expect(counts.runs).toBe(0);
    // The reserved completion released it: phase 1, the refused phase 3, the completion.
    expect(world.admission.events.map(event => event.reserved)).toEqual([false, false, true]);
    expect(idempotency.entries.size).toBe(0);
  });
});

describe("mutationRelease: guards", () => {
  const invalidOperation = answer("internal", 500, "invalid_operation", "none", "not_started");

  it("a read is internal/invalid_operation, written in one admitted phase", async () => {
    const { world, alice, runner } = setup();
    const read: ReadOperation<object, Value, Value> = {
      id: "fixture.not_a_mutation", kind: "read", requirement: { require: authenticated() },
      parse: () => ({}), resources: () => ({}), read: () => ({ value: 1 }), project: value => value, publicKeys: ["value"],
    };
    const { options, writes } = recordingDelivery<Value>(world);
    expect(await runner.mutationRelease(read, alice.context, {}, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(invalidOperation, 1)]);
  });

  it.each<[string, (operation: MutationOperation<{ n: number }, WriteResult, Value>, log: string[]) => MutationOperation<{ n: number }, WriteResult, Value>]>([
    ["an acquire", (operation, log) => ({ ...operation, acquire: async () => { log.push("acquire"); return { release: () => undefined }; } })],
    ["an idle effect", (operation, log) => ({
      ...operation, effect: { mode: "idle", run: async (value: { n: number }) => { log.push("idle"); return { n: value.n, projectId: null }; } },
    })],
  ])("%s is internal/invalid_operation before any reservation, parse or handler", async (_name, change) => {
    const { world, alice, runner, idempotency } = setup();
    const log: string[] = [];
    const base = admittedWrite(world);
    const parse = vi.fn(base.operation.parse);
    const operation = change({ ...base.operation, parse }, log);
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(invalidOperation, 1)]);
    expect(idempotency.calls).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
    expect(log).toEqual([]);
    expect(base.counts.runs).toBe(0);
  });

  it.each<[string, Partial<Record<keyof MutationReleaseOptions<Value>, unknown>>]>([
    ["no refuse", { refuse: undefined }], ["no eligible", { eligible: undefined }], ["no connected", { connected: "yes" }],
    ["a non-finite deadline", { deadline: Number.NaN }], ["no deadline", { deadline: undefined }],
  ])("invalid options without a usable refusal or policy (%s) are returned locally, without an admission", async (_name, change) => {
    const { world, alice, runner } = setup();
    const { operation, counts } = admittedWrite(world);
    const { options, writes } = recordingDelivery<Value>(world);
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, { ...options, ...change } as MutationReleaseOptions<Value>))
      .toEqual({ status: "refused", error: answer("invalid_request", 400, "invalid_input", "none", "not_started") });
    expect(writes).toEqual([]);
    expect(runs(world)).toBe(0);
    expect(counts.runs).toBe(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ["expectedCanonical", { expectedCanonical: "{}" }], ["a buffered refusal", { refusal: { stage: async () => undefined, commit: () => undefined } }],
    ["no commit", { commit: undefined }], ["a non-function stage", { stage: "later" }],
  ])("invalid options with a usable refusal (%s) are refused in one admitted phase", async (_name, change) => {
    const { world, alice, runner } = setup();
    const { operation, counts } = admittedWrite(world);
    const { options, writes } = recordingDelivery<Value>(world);
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, { ...options, ...change } as MutationReleaseOptions<Value>)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(answer("invalid_request", 400, "invalid_input", "none", "not_started"), 1)]);
    expect(counts.runs).toBe(0);
  });

  it("the listener exclusion is checked before the input is parsed", async () => {
    const { world, alice, runner, idempotency } = setup();
    const base = admittedWrite(world);
    const parse = vi.fn(base.operation.parse);
    const operation = { ...base.operation, parse, excludedListeners: ["api"] as const };
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: "one" }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(answer("not_found", 404, "operation_not_registered", "none", "not_started"), 1)]);
    expect(parse).not.toHaveBeenCalled();
    expect(idempotency.calls).toEqual([]);
  });

  it.each([false, true])("calls the callbacks captured before admission, with the options object as receiver (reassigned: %s)", async reassign => {
    const { world, alice } = setup();
    const idempotency = new MemoryIdempotency();
    const gated = gatedAdmission(world);
    const runner = new OperationRunner({ ...world.runtime({ idempotency }), admission: gated.admission });
    const { operation } = admittedWrite(world);
    class Release implements MutationReleaseOptions<Value> {
      deadline = Number.MAX_SAFE_INTEGER;
      idempotencyKey = "k-1";
      calls = { eligible: 0, connected: 0, commit: 0, refuse: 0 };
      values: Value[] = [];
      eligible() { this.calls.eligible++; return true; }
      connected() { this.calls.connected++; return true; }
      commit(value: Value) { this.calls.commit++; this.values.push(value); }
      refuse() { this.calls.refuse++; }
    }
    const release = new Release();
    const pending = runner.mutationRelease(operation, alice.context, { n: 1 }, release);
    const replacements = { eligible: vi.fn(() => false), connected: vi.fn(() => false), commit: vi.fn(), refuse: vi.fn() };
    if (reassign) Object.assign(release, replacements);
    gated.open();
    expect(await pending).toEqual({ status: "committed" });
    // Phase 1, phase 3 and step 5 each check the policy once.
    expect(release.calls).toEqual({ eligible: 3, connected: 3, commit: 1, refuse: 0 });
    expect(release.values).toEqual([{ value: 1 }]);
    for (const replacement of Object.values(replacements)) expect(replacement).not.toHaveBeenCalled();
  });
});

describe("mutationRelease: run() is unchanged", () => {
  it("run() of the same write returns its value without any delivery callback", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, counts } = admittedWrite(world);
    expect(await runner.run(operation, alice.context, { n: 1 }, keyed())).toEqual({ ok: true, value: { value: 1 }, replayed: false });
    expect(await runner.run(operation, alice.context, { n: 1 }, keyed())).toEqual({ ok: true, value: { value: 1 }, replayed: true });
    expect(counts.runs).toBe(1);
    expect(idempotency.states()).toEqual(["completed"]);
  });

  it("negative control: a write made after run() returned is observed outside admission", async () => {
    const { world, alice, runner } = setup();
    const { operation } = admittedWrite(world, { before: () => { throw new OperationError("conflict", "project_archived"); } });
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    const result = await runner.run(operation, alice.context, { n: 1 }, keyed());
    if (result.ok) throw new Error("fixture write succeeded");
    options.refuse(result.error);
    expect(writes).toEqual([{ kind: "refuse", value: answer("conflict", 409, "project_archived", "none", "not_started"), admitted: false, admission: 3 }]);
  });
});
