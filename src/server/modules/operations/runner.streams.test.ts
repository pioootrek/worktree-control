import { describe, expect, it } from "vitest";
import type { AuthenticationContext } from "./authentication-context";
import { OperationError } from "./errors";
import { OperationRunner } from "./runner";
import {
  collect, deferred, manualStream, projectA, setup, tick, unhandledDuring,
  type EventOperation, type ProjectEvent,
} from "./runner-fixture";

/** Decision T: the stream protocol, source failures, disposal and its observer. */

const event = (seq: number): IteratorResult<ProjectEvent> => ({ done: false, value: { projectId: projectA, seq, holderSession: "s" } });
const sanitized = { category: "internal", status: 500, reason: "unexpected_failure", retry: "none", effect: null };

async function open(context: AuthenticationContext, runner: OperationRunner, operation: EventOperation, signal?: AbortSignal) {
  const opened = await runner.stream(operation, context, { projectId: projectA }, { signal });
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  return opened.events;
}

/** An iterator whose first result is `first`, counting `return()` calls; `close` decides how disposal behaves. */
function source(first: () => unknown, close: () => unknown = () => ({ done: true, value: undefined })) {
  const counts = { next: 0, returns: 0 };
  const iterator = {
    next: () => { counts.next++; return counts.next === 1 ? Promise.resolve(event(1)) : Promise.resolve(first()); },
    return: () => { counts.returns++; return close(); },
  };
  return { iterator: iterator as unknown as AsyncIterator<ProjectEvent>, counts };
}

describe("malformed iterator results are source failures", () => {
  it("ends with one sanitized error item and disposes the source once", async () => {
    const malformed: [string, () => unknown, string][] = [
      ["throwing done", () => ({ get done(): boolean { throw new Error("done /secret"); }, value: 1 }), "unexpected_failure"],
      ["throwing value", () => ({ done: false, get value(): unknown { throw new Error("value /secret"); } }), "unexpected_failure"],
      ["not an object", () => 42, "invalid_stream"],
      ["null", () => null, "invalid_stream"],
      ["non-boolean done", () => ({ done: "yes", value: 1 }), "invalid_stream"],
    ];
    for (const [name, result, reason] of malformed) {
      const { world, alice, runner } = setup();
      const { iterator, counts } = source(result);
      const items = await collect(await open(alice.context, runner, manualStream(iterator)));
      expect(items, name).toEqual([{ event: { seq: 1, projectId: projectA } }, { error: { ...sanitized, reason } }]);
      expect(counts.returns, name).toBe(1);
      expect(world.disposalFailures, name).toEqual([]);
    }
  });

  it("disposes a source created before its validation failed", async () => {
    const { alice, runner } = setup();
    let returns = 0;
    const broken = manualStream({ return: async () => { returns++; return { done: true, value: undefined }; } } as unknown as AsyncIterator<ProjectEvent>);
    expect(await runner.stream(broken, alice.context, { projectId: projectA })).toEqual({ ok: false, error: { ...sanitized, reason: "invalid_stream" } });
    expect(returns).toBe(1);
  });
});

describe("disposal failures", () => {
  it("after a source failure: reported, and the stream still ends with exactly one error item", async () => {
    for (const close of [() => { throw new Error("close /secret"); }, () => Promise.reject(new Error("close /secret")), () => new Promise(() => undefined)]) {
      const { world, alice, runner } = setup();
      const { iterator, counts } = source(() => { throw new Error("next /secret"); }, close);
      const items = await collect(await open(alice.context, runner, manualStream(iterator)));
      expect(items).toEqual([{ event: { seq: 1, projectId: projectA } }, { error: sanitized }]);
      expect(counts.returns).toBe(1);
      expect(world.disposalFailures).toHaveLength(1);
      expect(world.disposalFailures[0]).toMatchObject({ operationId: "fixture.manual_events" });
    }
  });

  it("after abort of the request: the stream ends done and the failure is reported", async () => {
    const { world, alice, runner } = setup();
    const abort = new AbortController();
    const { iterator, counts } = source(() => new Promise(() => undefined), () => Promise.reject(new Error("close /secret")));
    const events = await open(alice.context, runner, manualStream(iterator), abort.signal);
    expect(await events.next()).toMatchObject({ done: false });
    const pending = events.next();
    await tick();
    abort.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    await tick();
    expect(counts.returns).toBe(1);
    expect(world.disposalFailures).toEqual([{ operationId: "fixture.manual_events", kind: "rejected" }]);
    expect(await events.next()).toEqual({ done: true, value: undefined });
  });

  it("a consumer return() always resolves done, even when disposal throws or never settles", async () => {
    for (const close of [() => { throw new Error("close /secret"); }, () => new Promise(() => undefined)]) {
      const { world, alice, runner } = setup();
      const { iterator, counts } = source(() => event(2), close);
      const events = await open(alice.context, runner, manualStream(iterator));
      expect(await events.next()).toMatchObject({ done: false });
      await expect(events.return!()).resolves.toEqual({ done: true, value: undefined });
      await expect(events.return!()).resolves.toEqual({ done: true, value: undefined });
      expect(counts.returns).toBe(1);
      expect(world.disposalFailures).toHaveLength(1);
    }
  });

  it("an observer that throws changes nothing", async () => {
    const { world, alice } = setup();
    const runner = new OperationRunner({ ...world.runtime(), observer: { streamDisposalFailed: () => { throw new Error("observer /secret"); } } });
    const { iterator } = source(() => event(2), () => { throw new Error("close /secret"); });
    const events = await open(alice.context, runner, manualStream(iterator));
    expect(await events.next()).toMatchObject({ done: false });
    await expect(events.return!()).resolves.toEqual({ done: true, value: undefined });
  });

  it("a source that finished by itself is never disposed", async () => {
    const { world, alice, runner } = setup();
    let returns = 0;
    const finishing = manualStream({ next: async () => ({ done: true, value: undefined }), return: async () => { returns++; return { done: true, value: undefined }; } });
    const events = await open(alice.context, runner, finishing);
    expect(await collect(events)).toEqual([]);
    await expect(events.return!()).resolves.toEqual({ done: true, value: undefined });
    expect(returns).toBe(0);
    expect(world.disposalFailures).toEqual([]);
  });
});

describe("late reads and serialization", () => {
  it("a read rejected after abort or return() is never an unhandled rejection", async () => {
    for (const ending of ["abort", "return"] as const) {
      const { alice, runner } = setup();
      const late = deferred<IteratorResult<ProjectEvent>>();
      let returns = 0;
      const operation = manualStream({ next: () => late.promise, return: async () => { returns++; return { done: true, value: undefined }; } });
      const abort = new AbortController();
      const unhandled = await unhandledDuring(async () => {
        const events = await open(alice.context, runner, operation, abort.signal);
        const pending = events.next();
        await tick();
        if (ending === "abort") abort.abort(); else await events.return!();
        expect(await pending).toEqual({ done: true, value: undefined });
        late.reject(new Error("late read /secret"));
        await tick();
        expect(await events.next()).toEqual({ done: true, value: undefined });
      });
      expect(unhandled).toEqual([]);
      expect(returns).toBe(1);
    }
  });

  it("an event that fails the strict serializer ends the stream with one error item", async () => {
    for (const projected of [
      { seq: 1, projectId: projectA, toJSON: () => ({ secret: 1 }) },
      Object.assign(Object.create({ toJSON: () => ({ secret: 1 }) }) as object, { seq: 1, projectId: projectA }),
      { seq: 1, projectId: projectA, nested: new Uint8Array(2) },
      { seq: 1, projectId: projectA, extra: "unlisted" },
    ]) {
      const { alice, runner } = setup();
      let returns = 0;
      const operation = { ...manualStream({ next: async () => event(1), return: async () => { returns++; return { done: true, value: undefined }; } }),
        projectEvent: () => projected as { seq: number; projectId: typeof projectA } };
      const items = await collect(await open(alice.context, runner, operation));
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ error: { category: "internal", effect: null } });
      expect(JSON.stringify(items)).not.toContain("secret");
      expect(returns).toBe(1);
    }
  });

  it("an error item is well-formed whatever the projector throws", async () => {
    class RogueError extends OperationError { override toPublic(): never { throw new Error("toPublic /secret"); } }
    for (const thrown of [new RogueError("forbidden", "rogue"), new Proxy({}, { getPrototypeOf: () => { throw new Error("proto /secret"); } })]) {
      const { alice, runner } = setup();
      const operation = { ...manualStream({ next: async () => event(1) }), projectEvent: (): never => { throw thrown; } };
      const items = await collect(await open(alice.context, runner, operation));
      expect(items).toHaveLength(1);
      expect(Object.keys((items[0] as { error: object }).error).sort()).toEqual(["category", "effect", "reason", "retry", "status"]);
      expect(JSON.stringify(items)).not.toContain("secret");
    }
  });
});
