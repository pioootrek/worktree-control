import { describe, expect, it, vi } from "vitest";
import type { ProjectId, PublicOperationError } from "@/shared/contracts/operations";
import { OperationError } from "./errors";
import type { EffectScope, MutationOperation, Receipt } from "./operation";
import type { MemoryIdempotency } from "./operations-fixture";
import { onProject } from "./requirements";
import { OperationRunner, type IdempotencyRecord, type MutationReleaseOptions } from "./runner";
import { admittedWrite, answer, projectA, projectB, recordingDelivery, REGISTRATION, setup, unhandledDuring } from "./runner-fixture";

/**
 * D2b-1 over the fixture store, the paths `runner.mutation-release.test.ts`
 * leaves open (review `d2b1-review-sol.md`, "Test gaps"): the order of the
 * reservation release and the refusal, the refusals delivered in phase 3, the
 * policy after an unknown or unconfirmed effect, aborts between and after the
 * phases, the deadline and the clock at the last write, identity against
 * reason, failed refusal deliveries, a release refused by the store (amendment
 * C2), and the direct shape of secret and transition releases. Each answer is
 * asserted with its five public fields, the admitted phase that wrote it, the
 * handler count and the record.
 */

type Value = { value: number };
type World = ReturnType<typeof setup>["world"];
const keyed = (idempotencyKey = "k-1") => ({ idempotencyKey });
const runs = (world: World) => world.admission.events.filter(event => event.kind === "run").length;
const only = (idempotency: MemoryIdempotency): IdempotencyRecord | undefined => structuredClone([...idempotency.entries.values()][0]);
const refuseWrite = (error: PublicOperationError, admission: number) => ({ kind: "refuse", value: error, admitted: true, admission });

/** One ordered trace of the store's release and the caller's refusal, each with the admission flag and the records at that moment. */
function traced(state: ReturnType<typeof setup>) {
  const { world, idempotency } = state;
  const trace: { step: string; admitted: boolean; records: string[] }[] = [];
  const release = idempotency.release.bind(idempotency);
  idempotency.release = (key, attempt) => {
    trace.push({ step: "release", admitted: world.admission.admitted, records: idempotency.states() });
    release(key, attempt);
  };
  const refuse = (error: PublicOperationError) => {
    trace.push({ step: `refuse ${error.reason}`, admitted: world.admission.admitted, records: idempotency.states() });
  };
  return { trace, refuse };
}

describe("reservation before answer: phase 3 refusals, in one ordered trace", () => {
  it.each<[string, (state: ReturnType<typeof setup>) => Parameters<typeof admittedWrite>[1], PublicOperationError, number]>([
    ["a typed refusal of the handler", () => ({ before: () => { throw new OperationError("conflict", "project_archived"); } }),
      answer("conflict", 409, "project_archived", "none", "not_started"), 1],
    ["a fresh authorization denial", ({ world, alice }) => {
      world.admission.onAdmit = event => { if (event.n === 2) world.grants.revokeAll(alice.id); };
      return {};
    }, answer("not_found", 404, "resource_not_found", "none", "not_started"), 0],
    ["a credential revalidation denial", ({ world, alice }) => {
      world.admission.onAdmit = event => { if (event.n === 2) world.verifier.revoke("provider_session", alice.credentialId); };
      return {};
    }, answer("unauthenticated", 401, "credential_no_longer_valid", "reauthenticate", "not_started"), 0],
    ["a changed resolution", ({ world, alice }) => {
      world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectB } });
      world.admission.onAdmit = event => { if (event.n === 2) world.resolver.move(REGISTRATION, projectB); };
      return {};
    }, answer("conflict", 409, "resource_changed", "none", "not_started"), 0],
  ])("%s: the reservation is released inside phase 3 before the refusal is written there; no phase follows", async (_name, arrange, expected, handlerRuns) => {
    const state = setup();
    const { world, alice, runner, idempotency } = state;
    const hooks = arrange(state);
    const { operation, counts } = admittedWrite(world, hooks);
    const { trace, refuse } = traced(state);
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    const recorded = options.refuse;
    options.refuse = error => { refuse(error); recorded.call(options, error); };
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(trace).toEqual([
      { step: "release", admitted: true, records: ["reserved"] },
      { step: `refuse ${expected.reason}`, admitted: true, records: [] },
    ]);
    expect(writes).toEqual([refuseWrite(expected, 2)]);
    expect(runs(world)).toBe(2);
    expect(idempotency.calls).toEqual(["get", "reserved", "release"]);
    expect(counts.runs).toBe(handlerRuns);
    expect(counts.finalizes).toBe(0);
  });
});

describe("a release the store refuses (amendment C2)", () => {
  it("the original refusal is written once, `finally` does not repeat the release, the record is left to the store", async () => {
    const state = setup();
    const { world, alice, runner, idempotency } = state;
    // The SQLite adapter's refusal while a broken handler left its transaction open.
    idempotency.release = () => { idempotency.calls.push("release"); throw new OperationError("internal", "idempotency_in_transaction"); };
    const { operation, counts } = admittedWrite(world, { before: () => { throw new OperationError("conflict", "project_archived"); } });
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(answer("conflict", 409, "project_archived", "none", "not_started"), 2)]);
    expect(idempotency.calls).toEqual(["get", "reserved", "release"]);
    expect(runs(world)).toBe(2);
    expect(idempotency.states()).toEqual(["reserved"]);
    expect(counts.runs).toBe(1);
  });
});

describe("the release policy after an unknown or unconfirmed effect", () => {
  const policies: [string, (world: World, deadline: number) => Partial<MutationReleaseOptions<Value>>, string][] = [
    ["ineligible", () => { let calls = 0; return { eligible: () => ++calls <= 2 }; }, "release_not_eligible"],
    ["past the deadline", (world, deadline) => {
      world.admission.onAdmit = event => { if (event.n === 4) world.clock.now = deadline; };
      return { deadline };
    }, "release_timed_out"],
    ["disconnected", () => { let calls = 0; return { connected: () => ++calls <= 2 }; }, "request_cancelled"],
  ];
  const effects: [string, Parameters<typeof admittedWrite>[1], (reason: string) => PublicOperationError][] = [
    ["an unknown effect", { after: () => { throw new Error("effect failed /secret"); } }, reason => answer("outcome_unknown", 409, reason, "inspect_first", "unknown")],
    ["cleanup_unconfirmed", { finalize: () => { throw new Error("audit down /secret"); } }, reason => answer("unavailable", 503, reason, "inspect_first", "cleanup_unconfirmed")],
  ];
  it.each(effects.flatMap(([effect, hooks, expected]) => policies.map(([policy, make, reason]) => [effect, policy, hooks, make, expected(reason)] as const)))(
    "%s, then %s in step 5: returned with that effect and inspect_first, never written; the record is unknown",
    async (_effect, _policy, hooks, make, expected) => {
      const { world, alice, runner, idempotency } = setup();
      const { operation, counts } = admittedWrite(world, hooks);
      const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), ...make(world, world.clock.now + 10) });
      expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "refused", error: expected });
      expect(JSON.stringify(expected)).not.toContain("secret");
      expect(writes).toEqual([]);
      expect(runs(world)).toBe(4);
      expect(counts.runs).toBe(1);
      expect(idempotency.states()).toEqual(["unknown"]);
    });
});

describe("cancellation between and after the phases", () => {
  it("an abort after phase 1: the abort check refuses before phase 3; the reserved completion releases the record", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, counts } = admittedWrite(world);
    const controller = new AbortController();
    let calls = 0;
    // Aborted once phase 1's callback has returned, before the next admission.
    const connected = () => { if (++calls === 1) queueMicrotask(() => controller.abort()); return true; };
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), connected, signal: controller.signal });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options))
      .toEqual({ status: "refused", error: answer("unavailable", 503, "request_cancelled", "retry", "not_started") });
    expect(writes).toEqual([]);
    expect(calls).toBe(1);
    expect(world.admission.events.map(event => [event.kind, event.reserved])).toEqual([["run", false], ["run", true]]);
    expect(idempotency.calls).toEqual(["get", "reserved", "release"]);
    expect(idempotency.entries.size).toBe(0);
    expect(counts.runs).toBe(0);
  });

  it("an abort at the entry of phase 3: the policy refuses there and gives the reservation back in that phase", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, counts } = admittedWrite(world);
    const controller = new AbortController();
    world.admission.onAdmit = event => { if (event.n === 2) controller.abort(); };
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), signal: controller.signal });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options))
      .toEqual({ status: "refused", error: answer("unavailable", 503, "request_cancelled", "retry", "not_started") });
    expect(writes).toEqual([]);
    expect(runs(world)).toBe(2);
    expect(idempotency.calls).toEqual(["get", "reserved", "release"]);
    expect(counts.runs).toBe(0);
  });

  it.each<[string, (abort: () => void) => Parameters<typeof admittedWrite>[1]]>([
    ["past the commit point", abort => ({ after: abort })],
    ["during finalization", abort => ({ finalize: abort })],
  ])("an abort %s: completion still writes completed; step 5 returns request_cancelled with effect committed", async (_name, hooks) => {
    const { world, alice, runner, idempotency } = setup();
    const controller = new AbortController();
    const { operation, counts } = admittedWrite(world, hooks(() => controller.abort()));
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), signal: controller.signal });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options))
      .toEqual({ status: "refused", error: answer("unavailable", 503, "request_cancelled", "none", "committed") });
    expect(writes).toEqual([]);
    expect(world.admission.events.map(event => event.reserved)).toEqual([false, false, true, true]);
    expect(counts).toMatchObject({ runs: 1, finalizes: 1, projections: 0 });
    expect(idempotency.states()).toEqual(["completed"]);
  });
});

describe("the deadline immediately before a step-5 refusal", () => {
  it("a projector that reaches the deadline and refuses: release_timed_out is returned, the refusal is not written", async () => {
    const { world, alice, runner, idempotency } = setup();
    const deadline = world.clock.now + 10;
    const { operation, counts } = admittedWrite(world, { project: () => { world.clock.now = deadline; throw new OperationError("conflict", "projection_refused"); } });
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), deadline });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options))
      .toEqual({ status: "refused", error: answer("unavailable", 503, "release_timed_out", "none", "committed") });
    expect(writes).toEqual([]);
    expect(runs(world)).toBe(4);
    expect(counts.runs).toBe(1);
    expect(idempotency.states()).toEqual(["completed"]);
  });
});

describe("the clock at the final write", () => {
  type Fault = "throws" | "a thenable" | "NaN" | "Infinity";
  /** A runtime clock that answers normally until `arm`; the next read after it is the fault, once. */
  function faultyClock(state: ReturnType<typeof setup>, fault: Fault) {
    const { world, idempotency } = state;
    const armed = { value: false };
    const runner = new OperationRunner({
      ...world.runtime({ idempotency }),
      now: (): number => {
        if (!armed.value) return world.clock.now;
        armed.value = false;
        if (fault === "throws") throw new Error("clock failed /secret");
        if (fault === "a thenable") return Promise.reject(new Error("late clock /secret")) as unknown as number;
        return fault === "NaN" ? Number.NaN : Number.POSITIVE_INFINITY;
      },
    });
    return { runner, arm: () => { armed.value = true; } };
  }
  const faults: Fault[] = ["throws", "a thenable", "NaN", "Infinity"];

  it.each(faults.flatMap(fault => (["success", "refusal"] as const).map(write => [fault, write] as const)))(
    "a clock that %s at the %s write: release_timed_out with effect committed, nothing written",
    async (fault, write) => {
      const unhandled = await unhandledDuring(async () => {
        const state = setup();
        const { world, alice, idempotency } = state;
        const { runner, arm } = faultyClock(state, fault);
        // The projection is the last step before the write: its clock read is the deadline check of `deliver`.
        const { operation, counts } = admittedWrite(world, {
          project: result => { arm(); if (write === "refusal") throw new OperationError("conflict", "projection_refused"); return { value: result.n }; },
        });
        const { options, writes } = recordingDelivery<Value>(world, keyed());
        expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options))
          .toEqual({ status: "refused", error: answer("unavailable", 503, "release_timed_out", "none", "committed") });
        expect(writes).toEqual([]);
        expect(counts.runs).toBe(1);
        expect(idempotency.states()).toEqual(["completed"]);
      });
      expect(unhandled).toEqual([]);
    });
});

describe("identity, not reason, selects the returned fallback", () => {
  it.each<[string, Parameters<typeof admittedWrite>[1], PublicOperationError, number]>([
    ["a handler before its commit point throws release_not_eligible", { before: () => { throw new OperationError("unavailable", "release_not_eligible"); } },
      answer("unavailable", 503, "release_not_eligible", "none", "not_started"), 2],
    ["a handler before its commit point throws request_cancelled", { before: () => { throw new OperationError("unavailable", "request_cancelled", { retry: "retry" }); } },
      answer("unavailable", 503, "request_cancelled", "retry", "not_started"), 2],
    ["a projector after the effect throws release_timed_out", { project: () => { throw new OperationError("unavailable", "release_timed_out", { retry: "retry" }); } },
      answer("unavailable", 503, "release_timed_out", "none", "committed"), 4],
  ])("%s: written through refuse inside admission, not returned", async (_name, hooks, expected, admission) => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, counts } = admittedWrite(world, hooks);
    const { options, writes } = recordingDelivery<Value>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([refuseWrite(expected, admission)]);
    expect(counts.runs).toBe(1);
    expect(idempotency.states()).toEqual(admission === 2 ? [] : ["completed"]);
  });
});

describe("a refusal delivery that fails: one attempt", () => {
  const branches: [string, (sink: string[]) => (error: PublicOperationError) => void, string[]][] = [
    ["throws before any byte", () => () => { throw new Error("socket gone /secret"); }, []],
    ["throws after a partial write", sink => () => { sink.push("partial"); throw new Error("socket gone /secret"); }, ["partial"]],
    ["returns a thenable", sink => (async () => { sink.push("async"); throw new Error("late /secret"); }) as unknown as (error: PublicOperationError) => void, ["async"]],
  ];
  const situations: [string, (world: World, aliceId: ReturnType<typeof setup>["alice"]["id"]) => Parameters<typeof admittedWrite>[1], PublicOperationError, string[]][] = [
    ["a refusal before the commit point", () => ({ before: () => { throw new OperationError("conflict", "project_archived"); } }),
      answer("internal", 500, "release_commit_failed", "none", "not_started"), []],
    ["a fresh denial after a confirmed success", (world, id) => ({ finalize: () => world.grants.revokeAll(id) }),
      answer("internal", 500, "release_commit_failed", "none", "committed"), ["completed"]],
    ["an unknown effect", () => ({ after: () => { throw new Error("effect failed /secret"); } }),
      answer("outcome_unknown", 409, "release_commit_failed", "inspect_first", "unknown"), ["unknown"]],
  ];
  it.each(situations.flatMap(([situation, hooks, expected, record]) => branches.map(([branch, make, partial]) => [situation, branch, hooks, expected, record, make, partial] as const)))(
    "%s, then a refuse that %s: commit_failed with that effect, written at most once, the record not changed by it",
    async (_situation, _branch, hooks, expected, record, make, partial) => {
      const unhandled = await unhandledDuring(async () => {
        const { world, alice, runner, idempotency } = setup();
        const { operation, counts } = admittedWrite(world, hooks(world, alice.id));
        const sink: string[] = [];
        const refuse = vi.fn(make(sink));
        const commit = vi.fn();
        const { options } = recordingDelivery<Value>(world, { ...keyed(), refuse, commit });
        expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "commit_failed", error: expected });
        expect(refuse).toHaveBeenCalledTimes(1);
        expect(commit).not.toHaveBeenCalled();
        expect(sink).toEqual(partial);
        expect(counts.runs).toBe(1);
        expect(idempotency.states()).toEqual(record);
      });
      expect(unhandled).toEqual([]);
    });
});

interface IssueInput { accountId: string }
interface Issued { accountId: string; tokenId: string; revision: number; token: string; projectId: ProjectId | null }
type Issue = MutationOperation<IssueInput, Issued, { accountId: string; tokenId: string; revision: number; token?: string }>;
const TOKEN = "wct_live_direct_secret";

describe("direct release of a secret-bearing result", () => {
  it("writes the secret once in step 5 and replays only the receipt in phase 1", async () => {
    const { world, alice, runner, idempotency } = setup();
    world.grants.grant({ accountId: alice.id, role: "maintainer", scope: { kind: "project", projectId: projectA } });
    let issued = 0;
    const operation: Issue = {
      id: "fixture.direct_token_issue", kind: "mutation",
      requirement: { require: onProject("roles:manage", "project") },
      parse: raw => ({ accountId: String((raw as IssueInput).accountId) }),
      resources: () => ({ project: { kind: "project", id: projectA } }),
      effect: { mode: "admitted", run: (value: IssueInput, scope: EffectScope) => {
        issued++;
        return { accountId: value.accountId, tokenId: `token-${issued}`, revision: issued, token: TOKEN, projectId: scope.resources.project.projectId };
      } },
      retain: true,
      secret: {
        receipt: result => ({ accountId: result.accountId, tokenId: result.tokenId, revision: result.revision }),
        projectReceipt: (value: Receipt) => ({ accountId: String(value.accountId), tokenId: String(value.tokenId), revision: Number(value.revision) }),
      },
      publicKeys: ["accountId", "tokenId", "revision", "token"],
      project: result => ({ accountId: result.accountId, tokenId: result.tokenId, revision: result.revision, token: result.token }),
    };
    const first = recordingDelivery<object>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { accountId: "bob" }, first.options)).toEqual({ status: "committed" });
    expect(first.writes).toEqual([{ kind: "commit", value: { accountId: "bob", tokenId: "token-1", revision: 1, token: TOKEN }, admitted: true, admission: 4 }]);
    expect(only(idempotency)).toMatchObject({ state: "completed", result: { accountId: "bob", tokenId: "token-1", revision: 1 } });
    expect(JSON.stringify([...idempotency.entries.values()])).not.toContain(TOKEN);
    const replay = recordingDelivery<object>(world, keyed());
    expect(await runner.mutationRelease(operation, alice.context, { accountId: "bob" }, replay.options)).toEqual({ status: "committed" });
    // The replay is the fifth admission: its phase 1.
    expect(replay.writes).toEqual([{ kind: "commit", value: { accountId: "bob", tokenId: "token-1", revision: 1 }, admitted: true, admission: 5 }]);
    expect(issued).toBe(1);
  });
});

interface RegInput { registrationId: string }
type RegResult = { registrationId: string };

describe("direct release of declared transitions", () => {
  function detach(state: ReturnType<typeof setup>, finalize?: () => void) {
    const counts = { runs: 0 };
    const operation: MutationOperation<RegInput, RegResult, RegResult> = {
      id: "fixture.direct_registration_detach", kind: "mutation",
      requirement: { require: onProject("runtime:control", "registration") },
      parse: raw => ({ registrationId: String((raw as RegInput).registrationId) }),
      resources: value => ({ registration: { kind: "registration", id: value.registrationId } }),
      transitions: ["registration"],
      effect: { mode: "admitted", run: (value: RegInput, scope: EffectScope) => {
        counts.runs++;
        state.world.resolver.delete(REGISTRATION);
        scope.transition("registration", { kind: "removed" });
        return { registrationId: value.registrationId };
      } },
      ...(finalize ? { finalize } : {}),
      retain: true, publicKeys: ["registrationId"], project: result => result,
    };
    return { operation, counts };
  }
  const raw = { registrationId: REGISTRATION.id };

  it("commits the first result in step 5 and its replay in phase 1, through transitionRelease; the record holds the confirmed removal", async () => {
    const state = setup();
    const { operation, counts } = detach(state);
    const first = recordingDelivery<RegResult>(state.world, keyed());
    expect(await state.runner.mutationRelease(operation, state.alice.context, raw, first.options)).toEqual({ status: "committed" });
    expect(first.writes).toEqual([{ kind: "commit", value: raw, admitted: true, admission: 4 }]);
    expect(only(state.idempotency)).toMatchObject({ state: "completed", result: raw, transitions: { registration: null } });
    const stored = only(state.idempotency);
    const replay = recordingDelivery<RegResult>(state.world, keyed());
    expect(await state.runner.mutationRelease(operation, state.alice.context, raw, replay.options)).toEqual({ status: "committed" });
    expect(replay.writes).toEqual([{ kind: "commit", value: raw, admitted: true, admission: 5 }]);
    expect(only(state.idempotency)).toEqual(stored);
    expect(counts.runs).toBe(1);
  });

  it("historical authority lost: refused in step 5 with effect committed, and in the replay's phase 1 with not_started", async () => {
    const state = setup();
    const { operation, counts } = detach(state, () => state.world.grants.revokeAll(state.alice.id));
    const first = recordingDelivery<RegResult>(state.world, keyed());
    expect(await state.runner.mutationRelease(operation, state.alice.context, raw, first.options)).toEqual({ status: "committed" });
    expect(first.writes).toEqual([refuseWrite(answer("not_found", 404, "resource_not_found", "none", "committed"), 4)]);
    expect(state.idempotency.states()).toEqual(["completed"]);
    const stored = only(state.idempotency);
    const replay = recordingDelivery<RegResult>(state.world, keyed());
    expect(await state.runner.mutationRelease(operation, state.alice.context, raw, replay.options)).toEqual({ status: "committed" });
    expect(replay.writes).toEqual([refuseWrite(answer("not_found", 404, "resource_not_found", "none", "not_started"), 5)]);
    expect(only(state.idempotency)).toEqual(stored);
    expect(counts.runs).toBe(1);
  });
});
