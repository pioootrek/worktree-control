import { describe, expect, it, vi } from "vitest";
import type { ProjectId } from "@/shared/contracts/operations";
import type { EffectScope, MutationOperation, Receipt } from "./operation";
import { onProject } from "./requirements";
import type { MutationReleaseOptions } from "./runner";
import { admittedWrite, answer, projectA, projectB, recordingDelivery, REGISTRATION, setup, unhandledDuring } from "./runner-fixture";

/**
 * D2b-1 decision 5: the buffered shape of `mutationRelease` (`stage`, used by
 * MCP). Every case asserts one effect (`counts.runs`), one staging attempt and
 * at most one write to the caller. The final phase is the last admission; its
 * position is asserted, so a repeated phase fails by construction.
 */

type Value = { value: number };
const keyed = (idempotencyKey = "k-1") => ({ idempotencyKey });
const runs = (world: ReturnType<typeof setup>["world"]) => world.admission.events.filter(event => event.kind === "run").length;

/** A stage that records whether it ran inside admission and what it received; `then` runs before it resolves. */
function stager(world: ReturnType<typeof setup>["world"], then: () => void | Promise<void> = () => undefined) {
  const seen: { value: unknown; admitted: boolean }[] = [];
  const stage = vi.fn(async (value: unknown) => {
    seen.push({ value: structuredClone(value), admitted: world.admission.admitted });
    await Promise.resolve();
    await then();
  });
  return { stage, seen };
}

describe("buffered first release", () => {
  it.each([true, false])("stages outside admission, then commits in a final reserved phase (keyed: %s)", async withKey => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, counts } = admittedWrite(world);
    const { stage, seen } = stager(world);
    const { options, writes } = recordingDelivery<Value>(world, { ...(withKey ? keyed() : {}), stage });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(seen).toEqual([{ value: { value: 1 }, admitted: false }]);
    // Phase 1, phase 3, completion, step 5, the final phase.
    expect(writes).toEqual([{ kind: "commit", value: { value: 1 }, admitted: true, admission: 5 }]);
    expect(world.admission.events.at(-1)).toMatchObject({ kind: "run", reserved: true });
    expect(counts).toMatchObject({ runs: 1, projections: 2 });
    expect(stage).toHaveBeenCalledTimes(1);
    expect(idempotency.states()).toEqual(withKey ? ["completed"] : []);
  });

  it("a revocation during staging discards the buffer; the fresh denial is refused once in the final phase", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, counts } = admittedWrite(world);
    const { stage } = stager(world, () => { world.grants.revokeAll(alice.id); });
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), stage });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([{ kind: "refuse", value: answer("not_found", 404, "resource_not_found", "none", "committed"), admitted: true, admission: 5 }]);
    expect(counts.runs).toBe(1);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(idempotency.states()).toEqual(["completed"]);
  });

  it("a changed projection is refused as release_payload_changed with effect committed", async () => {
    const { world, alice, runner } = setup();
    let projections = 0;
    const { operation, counts } = admittedWrite(world, { project: () => ({ value: ++projections }) });
    const { stage } = stager(world);
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), stage });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([{ kind: "refuse", value: answer("conflict", 409, "release_payload_changed", "none", "committed"), admitted: true, admission: 5 }]);
    expect(counts.runs).toBe(1);
  });

  it("a resource moved during staging is refused as resource_changed", async () => {
    const { world, alice, runner } = setup();
    world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectB } });
    const { operation } = admittedWrite(world);
    const { stage } = stager(world, () => { world.resolver.move(REGISTRATION, projectB); });
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), stage });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([{ kind: "refuse", value: answer("conflict", 409, "resource_changed", "none", "committed"), admitted: true, admission: 5 }]);
  });

  it("a rejected stage returns the fixed release_stage_failed with effect committed; nothing is written", async () => {
    const unhandled = await unhandledDuring(async () => {
      const { world, alice, runner, idempotency } = setup();
      const { operation, counts } = admittedWrite(world);
      const { stage } = stager(world, () => { throw new Error("sdk refused /secret"); });
      const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), stage });
      expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options))
        .toEqual({ status: "refused", error: answer("internal", 500, "release_stage_failed", "none", "committed") });
      expect(writes).toEqual([]);
      expect(runs(world)).toBe(4);
      expect(counts.runs).toBe(1);
      expect(stage).toHaveBeenCalledTimes(1);
      expect(idempotency.states()).toEqual(["completed"]);
    });
    expect(unhandled).toEqual([]);
  });

  it.each([false, true])("a cancellation during staging returns request_cancelled with effect committed (stage also rejects: %s)", async rejects => {
    const { world, alice, runner } = setup();
    const { operation, counts } = admittedWrite(world);
    const controller = new AbortController();
    const { stage } = stager(world, () => { controller.abort(); if (rejects) throw new Error("aborted"); });
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), stage, signal: controller.signal });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options))
      .toEqual({ status: "refused", error: answer("unavailable", 503, "request_cancelled", "none", "committed") });
    expect(writes).toEqual([]);
    expect(runs(world)).toBe(4);
    expect(counts.runs).toBe(1);
  });

  it.each<[string, (world: ReturnType<typeof setup>["world"], deadline: number) => [Partial<MutationReleaseOptions<Value>>, () => void], string]>([
    ["disconnected", () => { let calls = 0; return [{ connected: () => ++calls <= 3 }, () => undefined]; }, "request_cancelled"],
    ["ineligible", () => { let calls = 0; return [{ eligible: () => ++calls <= 3 }, () => undefined]; }, "release_not_eligible"],
    ["past the deadline", (world, deadline) => [{ deadline }, () => { world.clock.now = deadline; }], "release_timed_out"],
  ])("the final phase applies the release policy (%s): returned, never written", async (_name, policy, reason) => {
    const { world, alice, runner } = setup();
    const { operation, counts } = admittedWrite(world);
    const [extra, during] = policy(world, world.clock.now + 10);
    const { stage } = stager(world, during);
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), ...extra, stage });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options))
      .toEqual({ status: "refused", error: answer("unavailable", 503, reason, "none", "committed") });
    expect(writes).toEqual([]);
    expect(runs(world)).toBe(5);
    expect(counts.runs).toBe(1);
  });

  it("the deadline reached during the final projection: the staged value is not written", async () => {
    const { world, alice, runner } = setup();
    const deadline = world.clock.now + 10;
    let projections = 0;
    const { operation } = admittedWrite(world, { project: result => { if (++projections === 2) world.clock.now = deadline; return { value: result.n }; } });
    const { stage } = stager(world);
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), deadline, stage });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options))
      .toEqual({ status: "refused", error: answer("unavailable", 503, "release_timed_out", "none", "committed") });
    expect(writes).toEqual([]);
  });

  it("a thenable commit in the final phase is commit_failed, once", async () => {
    const unhandled = await unhandledDuring(async () => {
      const { world, alice, runner } = setup();
      const { operation, counts } = admittedWrite(world);
      const { stage } = stager(world);
      const commit = vi.fn(async () => { throw new Error("late /secret"); });
      const { options } = recordingDelivery<Value>(world, { ...keyed(), stage, commit: commit as unknown as (value: Value) => void });
      expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options))
        .toEqual({ status: "commit_failed", error: answer("internal", 500, "release_commit_failed", "none", "committed") });
      expect(commit).toHaveBeenCalledTimes(1);
      expect(stage).toHaveBeenCalledTimes(1);
      expect(counts.runs).toBe(1);
    });
    expect(unhandled).toEqual([]);
  });

  it.each(["expires", "is replaced"])("a record that %s during staging causes no second reservation, lookup or effect", async change => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, counts } = admittedWrite(world);
    const { stage } = stager(world, () => {
      const [[storeKey, record]] = [...idempotency.entries];
      if (change === "expires") idempotency.entries.delete(storeKey);
      else idempotency.entries.set(storeKey, { ...record, attempt: "another-attempt", state: "reserved" });
    });
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), stage });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes.map(write => write.kind)).toEqual(["commit"]);
    expect(idempotency.calls).toEqual(["get", "reserved", "started", "completed"]);
    expect(counts.runs).toBe(1);
  });
});

describe("buffered replay", () => {
  async function completed() {
    const state = setup();
    const write = admittedWrite(state.world);
    expect(await state.runner.mutationRelease(write.operation, state.alice.context, { n: 1 }, recordingDelivery<Value>(state.world, keyed()).options))
      .toEqual({ status: "committed" });
    state.world.admission.events = [];
    state.idempotency.calls.length = 0;
    write.counts.projections = 0;
    return { ...state, ...write };
  }

  it("projects in phase 1, stages, and commits in the final phase without reading the record again", async () => {
    for (const change of ["none", "expires", "is replaced"] as const) {
      const { world, alice, runner, idempotency, operation, counts } = await completed();
      const { stage, seen } = stager(world, () => {
        const [[storeKey, record]] = [...idempotency.entries];
        if (change === "expires") idempotency.entries.delete(storeKey);
        if (change === "is replaced") idempotency.entries.set(storeKey, { ...record, result: { n: 9, projectId: null } });
      });
      const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), stage });
      expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options), change).toEqual({ status: "committed" });
      expect(seen).toEqual([{ value: { value: 1 }, admitted: false }]);
      expect(writes).toEqual([{ kind: "commit", value: { value: 1 }, admitted: true, admission: 2 }]);
      expect(idempotency.calls).toEqual(["get"]);
      expect(counts).toMatchObject({ runs: 1, projections: 2 });
    }
  });

  it.each<[string, (state: Awaited<ReturnType<typeof completed>>) => void, ReturnType<typeof answer>]>([
    ["current authority lost", ({ world, alice }) => { world.grants.revokeAll(alice.id); }, answer("not_found", 404, "resource_not_found", "none", "not_started")],
    ["historical authority lost (moved to a project still visible)", ({ world, alice }) => {
      world.grants.revokeAll(alice.id);
      world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectB } });
      world.resolver.move(REGISTRATION, projectB);
    }, answer("not_found", 404, "resource_not_found", "none", "not_started")],
    ["the resolution changed", ({ world, alice }) => {
      world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectB } });
      world.resolver.move(REGISTRATION, projectB);
    }, answer("conflict", 409, "resource_changed", "none", "not_started")],
  ])("the final phase repeats the current and the historical decision: %s", async (_name, change, expected) => {
    const state = await completed();
    const { world, alice, runner, operation, idempotency } = state;
    const stored = structuredClone([...idempotency.entries.values()]);
    const { stage } = stager(world, () => change(state));
    const { options, writes } = recordingDelivery<Value>(world, { ...keyed(), stage });
    expect(await runner.mutationRelease(operation, alice.context, { n: 1 }, options)).toEqual({ status: "committed" });
    expect(writes).toEqual([{ kind: "refuse", value: expected, admitted: true, admission: 2 }]);
    expect([...idempotency.entries.values()]).toEqual(stored);
  });
});

interface IssueInput { accountId: string }
interface Issued { accountId: string; tokenId: string; revision: number; token: string; projectId: ProjectId | null }
type Issue = MutationOperation<IssueInput, Issued, { accountId: string; tokenId: string; revision: number; token?: string }>;
const TOKEN = "wct_live_stage_secret";

describe("buffered secret-bearing release", () => {
  it("stages the first response with its secret once and replays only the receipt", async () => {
    const { world, alice, runner, idempotency } = setup();
    world.grants.grant({ accountId: alice.id, role: "maintainer", scope: { kind: "project", projectId: projectA } });
    let issued = 0;
    const operation: Issue = {
      id: "fixture.stage_token_issue", kind: "mutation",
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
    const first = stager(world);
    const one = recordingDelivery<object>(world, { ...keyed(), stage: first.stage });
    expect(await runner.mutationRelease(operation, alice.context, { accountId: "bob" }, one.options)).toEqual({ status: "committed" });
    expect(one.writes.map(write => write.value)).toEqual([{ accountId: "bob", tokenId: "token-1", revision: 1, token: TOKEN }]);
    expect(JSON.stringify([...idempotency.entries.values()])).not.toContain(TOKEN);
    const second = stager(world);
    const two = recordingDelivery<object>(world, { ...keyed(), stage: second.stage });
    expect(await runner.mutationRelease(operation, alice.context, { accountId: "bob" }, two.options)).toEqual({ status: "committed" });
    expect(second.seen.map(seen => seen.value)).toEqual([{ accountId: "bob", tokenId: "token-1", revision: 1 }]);
    expect(two.writes.map(write => write.value)).toEqual([{ accountId: "bob", tokenId: "token-1", revision: 1 }]);
    expect(issued).toBe(1);
  });
});

interface RegInput { registrationId: string }
type RegResult = { registrationId: string };

describe("buffered release of declared transitions", () => {
  function detach(state: ReturnType<typeof setup>) {
    const counts = { runs: 0 };
    const operation: MutationOperation<RegInput, RegResult, RegResult> = {
      id: "fixture.stage_registration_detach", kind: "mutation",
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
      retain: true, publicKeys: ["registrationId"], project: result => result,
    };
    return { operation, counts };
  }
  const raw = { registrationId: REGISTRATION.id };

  it("releases the first result and its replay through transitionRelease in the final phase", async () => {
    const state = setup();
    const { operation, counts } = detach(state);
    for (const admission of [5, 7]) {
      const { stage } = stager(state.world);
      const { options, writes } = recordingDelivery<RegResult>(state.world, { ...keyed(), stage });
      expect(await state.runner.mutationRelease(operation, state.alice.context, raw, options)).toEqual({ status: "committed" });
      expect(writes).toEqual([{ kind: "commit", value: raw, admitted: true, admission }]);
    }
    expect(counts.runs).toBe(1);
  });

  it.each<[string, (state: ReturnType<typeof setup>) => void, ReturnType<typeof answer>, ReturnType<typeof answer>]>([
    ["historical authority lost", state => { state.world.grants.revokeAll(state.alice.id); },
      answer("not_found", 404, "resource_not_found", "none", "committed"), answer("not_found", 404, "resource_not_found", "none", "not_started")],
    ["the id reused", state => { state.world.resolver.put(REGISTRATION, projectA); },
      answer("conflict", 409, "resource_changed", "none", "committed"), answer("conflict", 409, "resource_changed", "none", "not_started")],
  ])("a change during staging (%s) is refused in the final phase, first release and replay alike", async (_name, change, fresh, replayed) => {
    for (const replay of [false, true]) {
      const state = setup();
      const { operation, counts } = detach(state);
      if (replay) await state.runner.mutationRelease(operation, state.alice.context, raw, recordingDelivery<RegResult>(state.world, keyed()).options);
      const { stage } = stager(state.world, () => change(state));
      const { options, writes } = recordingDelivery<RegResult>(state.world, { ...keyed(), stage });
      expect(await state.runner.mutationRelease(operation, state.alice.context, raw, options)).toEqual({ status: "committed" });
      expect(writes.map(write => [write.kind, write.value, write.admitted]), String(replay)).toEqual([["refuse", replay ? replayed : fresh, true]]);
      expect(counts.runs).toBe(1);
      expect(state.idempotency.states()).toEqual(["completed"]);
    }
  });
});
