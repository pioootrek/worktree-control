import { describe, expect, it } from "vitest";
import type { DatabaseAdmission } from "@/server/database-admission";
import type { ProjectId } from "@/shared/contracts/operations";
import type { MutationOperation, PhaseScope } from "./operation";
import { admissionRefusal, createWorld, MemoryIdempotency, P } from "./operations-fixture";
import { onProject } from "./requirements";
import { OperationRunner, type IdempotencyRecord, type RunResult } from "./runner";
import { unhandledDuring } from "./runner-fixture";

/**
 * Decision Z: a failed final write is repaired inside the same admitted
 * completion callback. When writing `completed` throws or returns a thenable,
 * the callback writes `unknown` before it returns, so no other admission can
 * read `completed` in between. The `finally` block writes only for attempts
 * whose completion callback never ran.
 */

type Input = { registrationId: string };
type Public = { projectId: ProjectId };
const projectA = P("project-a");
const REGISTRATION = { kind: "registration" as const, id: "reg-1" };
const INPUT: Input = { registrationId: REGISTRATION.id };
const KEY = { idempotencyKey: "k-1" };

const unconfirmed = { ok: false, error: {
  category: "unavailable", status: 503, reason: "finalization_unconfirmed", retry: "inspect_first", effect: "cleanup_unconfirmed" } };
const previousUnknown = { ok: false, error: {
  category: "outcome_unknown", status: 409, reason: "previous_attempt_outcome_unknown", retry: "inspect_first", effect: "unknown" } };

/**
 * FIFO admission double: each fresh admission starts only after every earlier
 * one settled, and `admissions` numbers them. The operation below never nests
 * admissions and never idles, so nothing else is needed.
 */
function queuedAdmission(): DatabaseAdmission & { admissions: number } {
  let tail: Promise<unknown> = Promise.resolve();
  const counter = { admissions: 0 };
  const enqueue = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const turn = tail.then(() => { counter.admissions++; return operation(); });
    tail = turn.then(() => undefined, () => undefined);
    return turn;
  };
  return Object.assign(counter, {
    run: enqueue, detached: enqueue, idle: <T>(operation: () => Promise<T>) => operation(),
    tryRun: <T>(operation: () => T) => ({ ran: true as const, value: operation() }), outside: <T>(operation: () => T) => operation(),
  });
}

/**
 * A retained mutation with a synchronous effect, and a store whose calls are
 * logged as `<call>:<state>@<admission number>` (a put is logged when attempted).
 */
function build(options: { admission?: DatabaseAdmission & { admissions: number } } = {}) {
  const world = createWorld();
  world.resolver.addProject(projectA).put(REGISTRATION, projectA);
  const alice = world.human("alice");
  world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectA } });
  const idempotency = new MemoryIdempotency();
  const admission = options.admission;
  const runner = new OperationRunner({ ...world.runtime({ idempotency }), ...(admission ? { admission } : {}) });
  const admissionNumber = () => (admission ? admission.admissions : world.admission.events.length);
  const log = { effects: 0, audits: 0, events: [] as string[] };
  const hooks: { beforePut?: (record: IdempotencyRecord) => void; thenableAfter?: { state: string; outcome: "fulfil" | "reject" } } = {};
  const get = idempotency.get.bind(idempotency), put = idempotency.put.bind(idempotency);
  idempotency.get = key => {
    const record = get(key);
    log.events.push(`get:${record?.state ?? "none"}@${admissionNumber()}`);
    return record;
  };
  idempotency.put = (key, record) => {
    hooks.beforePut?.(record);
    log.events.push(`put:${record.state}@${admissionNumber()}`);
    put(key, record);
    const thenable = hooks.thenableAfter;
    if (thenable?.state === record.state) {
      // Landed, then answered with a promise (decision W: a failed call).
      return (thenable.outcome === "fulfil" ? Promise.resolve() : Promise.reject(new Error("late /secret"))) as unknown as void;
    }
  };
  const operation: MutationOperation<Input, Public, Public> = {
    id: "fixture.final_write", kind: "mutation", requirement: { require: onProject("runtime:control", "registration") },
    parse: raw => ({ registrationId: String((raw as Input).registrationId) }),
    resources: input => ({ registration: { kind: "registration", id: input.registrationId } }),
    effect: { mode: "admitted", run: (_input: Input, scope: PhaseScope) => { log.effects++; return { projectId: scope.resources.registration.projectId }; } },
    finalize: () => { log.audits++; },
    retain: true, publicKeys: ["projectId"], project: result => result,
  };
  const run = () => runner.run(operation, alice.context, INPUT, KEY);
  return { world, alice, idempotency, runner, operation, run, log, hooks };
}

describe("a failed final write is repaired in the same completion admission (decision Z)", () => {
  it("never lets a retry queued behind the completion read completed, when the completed write lands and throws", async () => {
    const admission = queuedAdmission();
    const t = build({ admission });
    t.idempotency.failAfterWrite.add("completed");
    const pending: { retry?: Promise<RunResult<Public>> } = {};
    // Inside the completion admission, just before the `completed` write: an identical retry queues behind it.
    t.hooks.beforePut = record => { if (record.state === "completed" && !pending.retry) pending.retry = t.run(); };
    const original = await t.run();
    expect(pending.retry).toBeDefined();
    const retry = await pending.retry!;

    expect(original).toEqual(unconfirmed);
    expect(retry).toEqual(previousUnknown);
    expect(t.log.effects).toBe(1);
    expect(t.log.audits).toBe(1);
    expect(t.idempotency.states()).toEqual(["unknown"]);
    // 1 reserve, 2 effect, 3 completion (completed then unknown), 4 the retry's admission, 5 the original's release.
    expect(t.log.events).toEqual(["get:none@1", "put:reserved@1", "put:started@2", "put:completed@3", "put:unknown@3", "get:unknown@4"]);
    expect(t.log.events.filter(event => event.startsWith("get:completed"))).toEqual([]);
  });

  it("repairs a completed write that lands and throws within the same admission, without a concurrent retry", async () => {
    const t = build();
    t.idempotency.failAfterWrite.add("completed");
    expect(await t.run()).toEqual(unconfirmed);
    expect(t.log.events).toEqual(["get:none@1", "put:reserved@1", "put:started@2", "put:completed@3", "put:unknown@3"]);
    expect(t.idempotency.states()).toEqual(["unknown"]);
    expect(await t.run()).toEqual(previousUnknown);
    expect(t.log.effects).toBe(1);
  });

  it("repairs a completed write that lands and returns a promise, whether it would fulfil or reject", async () => {
    for (const outcome of ["fulfil", "reject"] as const) {
      const t = build();
      t.hooks.thenableAfter = { state: "completed", outcome };
      let result: unknown;
      expect(await unhandledDuring(async () => { result = await t.run(); })).toEqual([]);
      expect(result).toEqual(unconfirmed);
      expect(t.log.events).toEqual(["get:none@1", "put:reserved@1", "put:started@2", "put:completed@3", "put:unknown@3"]);
      expect(t.idempotency.states()).toEqual(["unknown"]);
      t.hooks.thenableAfter = undefined;
      expect(await t.run()).toEqual(previousUnknown);
      expect(t.log.effects).toBe(1);
    }
  });

  it("repairs a completed write that fails without landing", async () => {
    const t = build();
    t.idempotency.failOn.add("completed");
    expect(await t.run()).toEqual(unconfirmed);
    expect(t.log.events).toEqual(["get:none@1", "put:reserved@1", "put:started@2", "put:completed@3", "put:unknown@3"]);
    expect(t.idempotency.states()).toEqual(["unknown"]);
  });

  it("leaves the record to the store adapter when the repair fails too, and never writes again from finally", async () => {
    // The completed write landed: the record stays completed and a retry replays it. This is the documented
    // store-adapter obligation (a store must not report failure for a write that landed), not runner machinery.
    const landed = build();
    landed.idempotency.failAfterWrite.add("completed");
    landed.idempotency.failOn.add("unknown");
    expect(await landed.run()).toEqual(unconfirmed);
    expect(landed.log.events).toEqual(["get:none@1", "put:reserved@1", "put:started@2", "put:completed@3", "put:unknown@3"]);
    expect(landed.idempotency.states()).toEqual(["completed"]);
    landed.idempotency.failAfterWrite.clear();
    landed.idempotency.failOn.clear();
    expect(await landed.run()).toEqual({ ok: true, value: { projectId: projectA }, replayed: true });
    expect(landed.log.effects).toBe(1);

    // Neither write landed: the record stays started and a retry is held, never replayed or run again.
    const neither = build();
    neither.idempotency.failOn.add("completed").add("unknown");
    expect(await neither.run()).toEqual(unconfirmed);
    expect(neither.log.events).toEqual(["get:none@1", "put:reserved@1", "put:started@2", "put:completed@3", "put:unknown@3"]);
    expect(neither.idempotency.states()).toEqual(["started"]);
    neither.idempotency.failOn.clear();
    expect(await neither.run()).toEqual({ ok: false, error: {
      category: "conflict", status: 409, reason: "request_in_progress", retry: "none", effect: "not_started" } });
    expect(neither.log.effects).toBe(1);
  });

  it("writes unknown from finally only when the completion callback never ran", async () => {
    const t = build();
    // The completion admission (the third) is refused before its callback runs, and not retried.
    t.world.admission.onAdmit = event => { if (event.n === 3) throw admissionRefusal("closed"); };
    const result = await t.run();
    expect(result).toEqual(unconfirmed);
    expect(t.log.audits).toBe(0);
    // 4 is the original's release; 5 is finally's single unknown write.
    expect(t.log.events).toEqual(["get:none@1", "put:reserved@1", "put:started@2", "put:unknown@5"]);
    expect(t.idempotency.states()).toEqual(["unknown"]);
    t.world.admission.onAdmit = null;
    expect(await t.run()).toEqual(previousUnknown);
    expect(t.log.effects).toBe(1);
  });
});
