import { describe, expect, it } from "vitest";
import type { ProjectId } from "@/shared/contracts/operations";
import { createListenerBoundary, mintOfflineContext } from "./authentication-context";
import type { ReadOperation } from "./operation";
import { presented } from "./operations-fixture";
import { onProject } from "./requirements";
import { OperationRunner, type RunResult } from "./runner";
import { collect, fakeStart, input, key, manualStream, projectA, REGISTRATION, setup, unhandledDuring, type ProjectEvent, type StartOperation } from "./runner-fixture";

/**
 * Decision W: callbacks whose contract is synchronous are checked at run time.
 * A thenable is a failed step, whether it rejects or fulfils, and its
 * rejection is never unhandled.
 */

const thrown = (run: () => unknown): unknown => { try { run(); return null; } catch (error) { return error; } };
const unconfirmed = { ok: false, error: {
  category: "unavailable", status: 503, reason: "finalization_unconfirmed", retry: "inspect_first", effect: "cleanup_unconfirmed" } };
const previousUnknown = { ok: false, error: {
  category: "outcome_unknown", status: 409, reason: "previous_attempt_outcome_unknown", retry: "inspect_first", effect: "unknown" } };

describe("completion callbacks are synchronous (decision W)", () => {
  const cases = [
    ["finalize rejects", { finalizeAsync: "reject" }],
    ["finalize fulfils", { finalizeAsync: "fulfil" }],
    ["lease release rejects", { releaseAsync: "reject" }],
    ["lease release fulfils", { releaseAsync: "fulfil" }],
  ] as const;

  it("records unknown, reports cleanup_unconfirmed and answers a retry with outcome_unknown", async () => {
    for (const [name, hooks] of cases) {
      const { world, alice, runner, idempotency } = setup();
      const { operation, log } = fakeStart(world, hooks);
      let first: RunResult<unknown> | null = null, retry: RunResult<unknown> | null = null;
      const unhandled = await unhandledDuring(async () => {
        first = await runner.run(operation, alice.context, input, key("k-1"));
        retry = await runner.run(operation, alice.context, input, key("k-1"));
      });
      expect(unhandled, name).toEqual([]);
      expect(first, name).toEqual(unconfirmed);
      expect(idempotency.states(), name).toEqual(["unknown"]);
      expect(idempotency.calls, name).not.toContain("completed");
      expect(retry, name).toEqual(previousUnknown);
      // One effect; the lease release was called exactly once and never again.
      expect(log.attempts, name).toBe(1);
      expect(log.lockReleases, name).toBe(1);
      // A rejected release may leave the lock held: the runner reports it, it does not pretend otherwise.
      expect(log.lockHeld, name).toBe(hooks === cases[2][1]);
    }
  });

  it("reports cleanup_unconfirmed without an idempotency key, and without finalize", async () => {
    for (const [name, hooks] of cases) {
      const { world, alice, runner } = setup();
      const { operation } = fakeStart(world, hooks);
      let result: RunResult<unknown> | null = null;
      expect(await unhandledDuring(async () => { result = await runner.run(operation, alice.context, input); }), name).toEqual([]);
      expect(result, name).toEqual(unconfirmed);
    }
    for (const releaseAsync of ["reject", "fulfil"] as const) {
      const { world, alice, runner } = setup();
      const { operation } = fakeStart(world, { releaseAsync });
      const bare: StartOperation = { ...operation, finalize: undefined };
      let result: RunResult<unknown> | null = null;
      expect(await unhandledDuring(async () => { result = await runner.run(bare, alice.context, input); })).toEqual([]);
      expect(result, releaseAsync).toEqual(unconfirmed);
    }
  });

  it("an idempotency store that answers a write with a promise is a failed write, never a confirmed completion", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, log } = fakeStart(world);
    const put = idempotency.put.bind(idempotency);
    idempotency.put = (k, record) => {
      put(k, record);
      return (record.state === "completed" ? Promise.reject(new Error("late /secret")) : undefined) as never;
    };
    let first: RunResult<unknown> | null = null, retry: RunResult<unknown> | null = null;
    expect(await unhandledDuring(async () => {
      first = await runner.run(operation, alice.context, input, key("k-1"));
      retry = await runner.run(operation, alice.context, input, key("k-1"));
    })).toEqual([]);
    expect(first).toEqual(unconfirmed);
    expect(idempotency.states()).toEqual(["unknown"]);
    expect(retry).toEqual(previousUnknown);
    expect(log.attempts).toBe(1);
  });

  it("a store get that returns a promise fails closed before anything happens", async () => {
    const { world, alice, runner, idempotency } = setup();
    const { operation, log } = fakeStart(world);
    idempotency.get = () => Promise.reject(new Error("late /secret")) as never;
    let result: RunResult<unknown> | null = null;
    expect(await unhandledDuring(async () => { result = await runner.run(operation, alice.context, input, key("k-1")); })).toEqual([]);
    expect(result).toEqual({ ok: false, error: { category: "internal", status: 500, reason: "idempotency_store_not_synchronous", retry: "none", effect: "not_started" } });
    expect(log.attempts).toBe(0);
  });
});

describe("other synchronous callbacks (decision W)", () => {
  const readOf = (change: Partial<ReadOperation<object, object, { projectId: ProjectId }>>): ReadOperation<object, object, { projectId: ProjectId }> => ({
    id: "fixture.sync_read", kind: "read", requirement: { require: onProject("project:read", "registration") },
    parse: () => ({}), resources: () => ({ registration: REGISTRATION }), read: () => ({}),
    publicKeys: ["projectId"], project: () => ({ projectId: projectA }), ...change,
  });
  const late = () => Promise.reject(new Error("late /secret")) as never;

  it("refuses a thenable from parse, resources and the projector without an unhandled rejection", async () => {
    const cases: [string, Partial<ReadOperation<object, object, { projectId: ProjectId }>>][] = [
      ["parse_not_synchronous", { parse: late }],
      ["resources_not_synchronous", { resources: late }],
      ["projection_not_synchronous", { project: late }],
    ];
    for (const [reason, change] of cases) {
      const { alice, runner } = setup();
      let result: RunResult<unknown> | null = null;
      expect(await unhandledDuring(async () => { result = await runner.run(readOf(change), alice.context, {}); }), reason).toEqual([]);
      expect(result, reason).toEqual({ ok: false, error: { category: "internal", status: 500, reason, retry: "none", effect: null } });
    }
  });

  it("refuses a thenable from the grants snapshot or the runtime instead of deciding on it", async () => {
    for (const reason of ["grants_not_synchronous", "runtime_not_synchronous"] as const) {
      const { world, alice } = setup();
      const runtime = world.runtime();
      if (reason === "grants_not_synchronous") world.grants.grantsFor = late;
      else runtime.grants = late;
      let result: RunResult<unknown> | null = null;
      expect(await unhandledDuring(async () => { result = await new OperationRunner(runtime).run(readOf({}), alice.context, {}); }), reason).toEqual([]);
      expect(result, reason).toEqual({ ok: false, error: { category: "internal", status: 500, reason, retry: "none", effect: null } });
    }
  });

  it("treats a listener or offline lock answering with a promise as closed, never as open", () => {
    const { world } = setup();
    for (const answer of [Promise.resolve(true), Promise.reject(new Error("late /secret")), 1]) {
      if (answer instanceof Promise) answer.catch(() => undefined);
      const unix = createListenerBoundary({ mode: "better-auth", listener: "unix", verifier: world.verifier, open: () => answer as never });
      expect(thrown(() => unix.mint(presented()))).toMatchObject({ category: "unauthenticated", reason: "listener_closed" });
      expect(thrown(() => mintOfflineContext({ mode: "better-auth", lockHeld: () => answer as never })))
        .toMatchObject({ category: "unauthenticated", reason: "offline_lock_not_held" });
    }
  });

  it("revokes a context whose listener later answers with a promise", async () => {
    const { world, runner } = setup();
    const state: { open: unknown } = { open: true };
    const unix = createListenerBoundary({ mode: "better-auth", listener: "unix", verifier: world.verifier, open: () => state.open as boolean });
    const context = unix.mint(presented());
    expect(await runner.run(readOf({}), context, {})).toMatchObject({ ok: true });
    state.open = Promise.resolve(true);
    expect(await runner.run(readOf({}), context, {})).toEqual({ ok: false, error: {
      category: "unauthenticated", status: 401, reason: "listener_closed", retry: "reauthenticate", effect: null } });
  });

  it("treats a verifier answering with a promise as no credential", async () => {
    const { world, alice, runner } = setup();
    world.verifier.current = late;
    let result: RunResult<unknown> | null = null;
    expect(await unhandledDuring(async () => { result = await runner.run(readOf({}), alice.context, {}); })).toEqual([]);
    expect(result).toMatchObject({ ok: false, error: { category: "unauthenticated", reason: "credential_no_longer_valid" } });
  });

  it("refuses a stream whose open() returns a promise and absorbs an observer that returns one", async () => {
    const { world, alice } = setup();
    const runtime = world.runtime();
    runtime.observer = { streamDisposalFailed: () => Promise.reject(new Error("observer /secret")) as never };
    const runner = new OperationRunner(runtime);
    const asyncOpen = { ...manualStream({ next: () => Promise.resolve({ done: true, value: undefined }) }), open: late };
    let opened: unknown = null;
    expect(await unhandledDuring(async () => { opened = await runner.stream(asyncOpen, alice.context, { projectId: projectA }); })).toEqual([]);
    expect(opened).toEqual({ ok: false, error: { category: "internal", status: 500, reason: "invalid_stream", retry: "none", effect: null } });
    const failing = manualStream({
      next: () => Promise.reject(new Error("next /secret")),
      return: () => Promise.reject(new Error("return /secret")),
    } as AsyncIterator<ProjectEvent>);
    let items: unknown[] = [];
    expect(await unhandledDuring(async () => {
      const stream = await runner.stream(failing, alice.context, { projectId: projectA });
      if (!stream.ok) throw new Error("not opened");
      items = await collect(stream.events);
    })).toEqual([]);
    expect(items).toEqual([{ error: { category: "internal", status: 500, reason: "unexpected_failure", retry: "none", effect: null } }]);
  });
});
