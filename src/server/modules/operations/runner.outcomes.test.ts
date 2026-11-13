import { describe, expect, it } from "vitest";
import type { ProjectId } from "@/shared/contracts/operations";
import { mintOfflineContext } from "./authentication-context";
import { OperationError } from "./errors";
import type { PhaseScope, ReadOperation } from "./operation";
import { MAX_RELEASE_NODES } from "./release";
import { onProject } from "./requirements";
import { fakeStart, input, key, projectA, REGISTRATION, setup, unhandledDuring, type StartInput, type StartOperation } from "./runner-fixture";
import type { RunResult } from "./runner";

/** An OperationError whose overridden method throws: its holder must never call it. */
class RogueError extends OperationError {
  override toPublic(): never { throw new Error("toPublic must not be called /secret"); }
  override withEffect(): never { throw new Error("withEffect must not be called /secret"); }
}
/** A thrown value that throws on every inspection. */
const hostile = () => new Proxy({}, {
  get: () => { throw new Error("get /secret"); }, getPrototypeOf: () => { throw new Error("prototype /secret"); },
  getOwnPropertyDescriptor: () => { throw new Error("descriptor /secret"); }, has: () => { throw new Error("has /secret"); },
  ownKeys: () => { throw new Error("keys /secret"); },
});
const accessorError = () => Object.defineProperties(new Error("x"), {
  name: { get: () => { throw new Error("name /secret"); } }, code: { get: () => { throw new Error("code /secret"); } },
  effect: { get: () => { throw new Error("effect /secret"); } },
});

function wellFormed(result: RunResult<unknown>) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(Object.keys(result.error).sort()).toEqual(["category", "effect", "reason", "retry", "status"]);
  expect(JSON.stringify(result)).not.toContain("secret");
}

describe("lease release before the idempotency record (decision R)", () => {
  it("releases the lease before writing completed", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, log } = fakeStart(world);
    const heldAtWrite: boolean[] = [];
    const put = idempotency.put.bind(idempotency);
    idempotency.put = (k, record) => { if (record.state === "completed") heldAtWrite.push(log.lockHeld); put(k, record); };
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: true });
    expect(heldAtWrite).toEqual([false]);
  });

  it("records unknown when the lease release fails, so a retry never replays success", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, log } = fakeStart(world, { releaseThrows: true });
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toEqual({ ok: false, error: {
      category: "unavailable", status: 503, reason: "finalization_unconfirmed", retry: "inspect_first", effect: "cleanup_unconfirmed" } });
    expect(idempotency.states()).toEqual(["unknown"]);
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toEqual({ ok: false, error: {
      category: "outcome_unknown", status: 409, reason: "previous_attempt_outcome_unknown", retry: "inspect_first", effect: "unknown" } });
    expect(log).toMatchObject({ attempts: 1, lockReleases: 1 });
  });
});

describe("a failure at each reservation transition", () => {
  it("get and the reserved write: nothing happens and nothing leaks", async () => {
    for (const transition of ["get", "reserved"] as const) {
      const { world, alice, runner, idempotency } = setup();
      const { operation, log } = fakeStart(world);
      idempotency.failOn.add(transition);
      const result = await runner.run(operation, alice.context, input, key("k-1"));
      expect(result).toEqual({ ok: false, error: { category: "internal", status: 500, reason: "unexpected_failure", retry: "none", effect: "not_started" } });
      expect(log).toMatchObject({ attempts: 0, lockReleases: 0 });
      expect(idempotency.states()).toEqual([]);
    }
  });

  it("the started write: the effect never runs and the reservation is given back", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, log } = fakeStart(world);
    idempotency.failOn.add("started");
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "internal", effect: "not_started" } });
    expect(log).toMatchObject({ attempts: 0, lockHeld: false, lockReleases: 1 });
    expect(idempotency.states()).toEqual([]);
  });

  it("the completed write: the effect is reported unconfirmed and the record falls back to unknown", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, log } = fakeStart(world);
    idempotency.failOn.add("completed");
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: {
      category: "unavailable", reason: "finalization_unconfirmed", effect: "cleanup_unconfirmed", retry: "inspect_first" } });
    expect(idempotency.states()).toEqual(["unknown"]);
    idempotency.failOn.clear();
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "outcome_unknown" } });
    expect(log.attempts).toBe(1);
  });

  it("the unknown write: the record stays started, so a retry is held, never replayed or rerun", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, log } = fakeStart(world, { effect: () => { throw new Error("spawn failed"); } });
    idempotency.failOn.add("unknown");
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "outcome_unknown", effect: "unknown" } });
    expect(idempotency.states()).toEqual(["started"]);
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "conflict", reason: "request_in_progress" } });
    expect(log.attempts).toBe(1);
  });

  it("the release of a reservation that never began: the key stays held", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, log } = fakeStart(world);
    world.admission.onAdmit = event => { if (event.n === 2) world.grants.revokeAll(alice.id); };
    idempotency.failOn.add("release");
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "not_found", effect: "not_started" } });
    expect(idempotency.states()).toEqual(["reserved"]);
    world.admission.onAdmit = null;
    world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectA } });
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "conflict", reason: "request_in_progress" } });
    expect(log.attempts).toBe(0);
  });

  it("a malformed record read back from the store fails closed", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, log } = fakeStart(world);
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: true });
    for (const record of idempotency.entries.values()) (record as { resources: unknown }).resources = { __proto__: null, "bad slot": 1 };
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "internal", reason: "invalid_idempotency_record" } });
    expect(log.attempts).toBe(1);
  });
});

describe("shared idempotency principals", () => {
  it("deduplicates one key across installation callers and across operator callers", async () => {
    const { world, runner } = setup();
    const { operation, log } = fakeStart(world);
    const first = world.installation("api"), second = world.installation("mcp");
    expect(await runner.run(operation, first.context, input, key("k-1"))).toMatchObject({ ok: true, replayed: false });
    expect(await runner.run(operation, second.context, input, key("k-1"))).toMatchObject({ ok: true, replayed: true });
    const unix = world.operator();
    const offline = mintOfflineContext({ mode: "better-auth", lockHeld: () => true });
    expect(await runner.run(operation, unix, input, key("k-1"))).toMatchObject({ ok: true, replayed: false });
    expect(await runner.run(operation, offline, input, key("k-1"))).toMatchObject({ ok: true, replayed: true });
    // Different principals never share: the installation and the operator ran once each.
    expect(log.attempts).toBe(2);
  });
});

describe("retained inputs are JSON-domain (decision V)", () => {
  it("rejects input outside the JSON domain before anything happens", async () => {
    const getter = Object.defineProperty({ registrationId: "reg-1" }, "late", { enumerable: true, get: () => "x" });
    const many = { registrationId: "reg-1", list: Array.from({ length: MAX_RELEASE_NODES }, () => 0) };
    for (const raw of [{ registrationId: "reg-1", at: new Date(0) }, getter, new Proxy({ registrationId: "reg-1" }, {}),
      { registrationId: "reg-1", n: Number.NaN }, { registrationId: "reg-1", toJSON: () => ({}) }, many]) {
      const { world, alice, runner, idempotency } = setup();
      const { operation, log } = fakeStart(world);
      for (const options of [key("k-1"), {}]) {
        expect(await runner.run(operation, alice.context, raw, options)).toEqual({ ok: false, error: {
          category: "invalid_request", status: 400, reason: "invalid_input", retry: "none", effect: "not_started" } });
      }
      expect(log.attempts).toBe(0);
      expect(idempotency.states()).toEqual([]);
    }
  });

  it("fingerprints the canonical form: key order and -0 do not matter, a Date never equals its string", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    const parsed: unknown[] = [];
    const recording: StartOperation = { ...operation, parse: raw => { parsed.push(raw); return operation.parse(raw); } };
    expect(await runner.run(recording, alice.context, { registrationId: "reg-1", n: -0, extra: { b: 1, a: 2 } }, key("k-1"))).toMatchObject({ ok: true, replayed: false });
    expect(await runner.run(recording, alice.context, { extra: { a: 2, b: 1 }, n: 0, registrationId: "reg-1" }, key("k-1"))).toMatchObject({ ok: true, replayed: true });
    expect(await runner.run(recording, alice.context, { registrationId: "reg-1", n: 1, extra: { a: 2, b: 1 } }, key("k-1"))).toMatchObject({ ok: false, error: { reason: "idempotency_conflict" } });
    // parse receives the canonical copy: plain data, -0 already 0.
    expect(Object.is((parsed[0] as { n: number }).n, 0)).toBe(true);
    expect(log.attempts).toBe(1);
  });
});

describe("an admitted effect that returns a promise", () => {
  it("never leaves an unhandled rejection and reports an unknown outcome", async () => {
    for (const commitPoint of ["entry", "declared"] as const) {
      const { world, alice, runner, idempotency } = setup();
      const { operation } = fakeStart(world);
      const asynchronous = { ...operation, acquire: undefined, effect: { mode: "admitted", commitPoint,
        run: () => Promise.reject(new Error("late /secret")) } } as unknown as StartOperation;
      let result: RunResult<unknown> | null = null;
      const unhandled = await unhandledDuring(async () => { result = await runner.run(asynchronous, alice.context, input, key("k-1")); });
      expect(unhandled).toEqual([]);
      expect(result).toEqual({ ok: false, error: {
        category: "outcome_unknown", status: 409, reason: "admitted_effect_not_synchronous", retry: "inspect_first", effect: "unknown" } });
      expect(idempotency.states()).toEqual(["unknown"]);
    }
  });

  it("a read returning a rejecting promise is refused without an unhandled rejection", async () => {
    const { alice, runner } = setup();
    const read = { id: "fixture.async_read", kind: "read", requirement: { require: onProject("project:read", "registration") },
      parse: () => ({}), resources: () => ({ registration: REGISTRATION }), read: () => Promise.reject(new Error("late /secret")),
      publicKeys: ["projectId"], project: () => ({ projectId: projectA }) } as unknown as ReadOperation<object, unknown, { projectId: ProjectId }>;
    let result: RunResult<unknown> | null = null;
    expect(await unhandledDuring(async () => { result = await runner.run(read, alice.context, {}); })).toEqual([]);
    expect(result).toEqual({ ok: false, error: { category: "internal", status: 500, reason: "read_not_synchronous", retry: "none", effect: null } });
  });
});

describe("total sanitization (decision S)", () => {
  const readOperation = (project: () => unknown): ReadOperation<object, object, { projectId: ProjectId }> => ({
    id: "fixture.read", kind: "read", requirement: { require: onProject("project:read", "registration") },
    parse: () => ({}), resources: () => ({ registration: REGISTRATION }), read: () => ({}),
    publicKeys: ["projectId"], project: project as () => { projectId: ProjectId },
  });

  it("releases a well-formed error from run whatever a read throws, with or without an aborted signal", async () => {
    for (const thrown of [() => new RogueError("conflict", "rogue"), hostile, accessorError]) {
      for (const aborting of [false, true]) {
        const { alice, runner } = setup();
        const abort = new AbortController();
        const result = await runner.run(readOperation(() => { if (aborting) abort.abort(); throw thrown(); }), alice.context, {}, { signal: abort.signal });
        wellFormed(result);
      }
    }
    const { alice, runner } = setup();
    expect(await runner.run(readOperation(() => { throw new RogueError("conflict", "rogue"); }), alice.context, {})).toEqual({ ok: false, error: {
      category: "conflict", status: 409, reason: "rogue", retry: "none", effect: null } });
  });

  it("releases a well-formed error from a replay whose projection throws or fails serialization", async () => {
    for (const replayed of [() => { throw new RogueError("conflict", "rogue", { effect: "not_started" }); }, () => { throw hostile(); },
      () => ({ projectId: projectA, started: true, toJSON: () => ({ secret: 1 }) })]) {
      const { world, alice, runner } = setup();
      const { operation } = fakeStart(world);
      let calls = 0;
      const projecting: StartOperation = { ...operation, project: result => (++calls === 1 ? { projectId: result.projectId, started: true } : replayed() as never) };
      expect(await runner.run(projecting, alice.context, input, key("k-1"))).toMatchObject({ ok: true, replayed: false });
      const replay = await runner.run(projecting, alice.context, input, key("k-1"));
      wellFormed(replay);
      expect(replay).toMatchObject({ ok: false, error: { effect: "not_started" } });
    }
  });

  it("releases a well-formed error after an effect whatever finalization or the projector throws", async () => {
    const { world, alice, runner } = setup();
    const { operation } = fakeStart(world);
    const failing: StartOperation = { ...operation, effect: { mode: "idle", run: async (_input: StartInput, _scope: PhaseScope) => { throw hostile(); } } };
    const result = await runner.run(failing, alice.context, input);
    wellFormed(result);
    expect(result).toMatchObject({ ok: false, error: { category: "outcome_unknown", effect: "unknown" } });
  });
});

describe("a store write that lands and then throws, at each transition", () => {
  it("reserved: the reservation is given back, nothing runs, and a retry runs fresh", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, log } = fakeStart(world);
    idempotency.failAfterWrite.add("reserved");
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toEqual({ ok: false, error: {
      category: "internal", status: 500, reason: "unexpected_failure", retry: "none", effect: "not_started" } });
    expect(log).toMatchObject({ attempts: 0, lockReleases: 0 });
    expect(idempotency.states()).toEqual([]);
    idempotency.failAfterWrite.clear();
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: true, replayed: false });
    expect(log.attempts).toBe(1);
  });

  it("started: the effect never runs, the record is removed, and a retry runs fresh", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, log } = fakeStart(world);
    idempotency.failAfterWrite.add("started");
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "internal", effect: "not_started" } });
    expect(log).toMatchObject({ attempts: 0, lockHeld: false, lockReleases: 1 });
    expect(idempotency.states()).toEqual([]);
    idempotency.failAfterWrite.clear();
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: true, replayed: false });
    expect(log.attempts).toBe(1);
  });

  it("completed: the written completion is overwritten with unknown, so no retry replays success", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, log } = fakeStart(world);
    idempotency.failAfterWrite.add("completed");
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toEqual({ ok: false, error: {
      category: "unavailable", status: 503, reason: "finalization_unconfirmed", retry: "inspect_first", effect: "cleanup_unconfirmed" } });
    expect(idempotency.calls).toEqual(["get", "reserved", "started", "completed", "unknown"]);
    expect(idempotency.states()).toEqual(["unknown"]);
    idempotency.failAfterWrite.clear();
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "outcome_unknown", reason: "previous_attempt_outcome_unknown" } });
    expect(log).toMatchObject({ attempts: 1, lockHeld: false, lockReleases: 1 });
  });

  it("unknown: the record stays unknown and a retry is never run again", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, log } = fakeStart(world, { effect: () => { throw new Error("spawn failed"); } });
    idempotency.failAfterWrite.add("unknown");
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "outcome_unknown", effect: "unknown" } });
    expect(idempotency.states()).toEqual(["unknown"]);
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "outcome_unknown", reason: "previous_attempt_outcome_unknown" } });
    expect(log.attempts).toBe(1);
  });

  it("release: the reservation of an attempt that never began is gone, and a retry runs once", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, log } = fakeStart(world);
    world.admission.onAdmit = event => { if (event.n === 2) world.grants.revokeAll(alice.id); };
    idempotency.failAfterWrite.add("release");
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "not_found", effect: "not_started" } });
    expect(idempotency.states()).toEqual([]);
    world.admission.onAdmit = null;
    world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectA } });
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: true, replayed: false });
    expect(log.attempts).toBe(1);
  });
});
