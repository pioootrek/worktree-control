import { describe, expect, it } from "vitest";
import type { ProjectId } from "@/shared/contracts/operations";
import type { MutationOperation, ReadOperation, StreamOperation } from "./operation";
import { allOf, onProject, type ResourceRef } from "./requirements";
import { collect, projectA, projectB, setup, unhandledDuring } from "./runner-fixture";
import type { RunResult } from "./runner";

/**
 * Decision X through the runner: with two references, the answer never
 * depends on their order or on whether a resource the caller cannot see
 * exists. Alice may read project A only; project B exists and is invisible.
 */

interface Pair { first: unknown; second: unknown }
type Public = { projectId: ProjectId };

const MALFORMED = { kind: "tenant", id: "x" };
const MISSING = { kind: "registration", id: "reg-missing" };
const INVISIBLE = { kind: "registration", id: "reg-b" };
const VISIBLE = { kind: "registration", id: "reg-1" };
const THROWING = { kind: "registration", id: "reg-boom" };

const requirement = { require: allOf(onProject("project:read", "first"), onProject("project:read", "second")) };
const refsOf = (input: Pair) => ({ first: input.first, second: input.second }) as unknown as Readonly<Record<string, ResourceRef>>;

function world() {
  const context = setup();
  context.world.resolver.put({ kind: "registration", id: "reg-b" }, projectB);
  const resolve = context.world.resolver.resolve.bind(context.world.resolver);
  context.world.resolver.resolve = ref => {
    if (ref.id === "reg-boom") throw new Error("lookup failed /secret");
    return resolve(ref);
  };
  const counts = { effects: 0, reads: 0, opens: 0 };
  const mutation: MutationOperation<Pair, Public, Public> = {
    id: "fixture.pair_mutation", kind: "mutation", requirement, parse: raw => raw as Pair, resources: refsOf,
    effect: { mode: "admitted", run: () => { counts.effects++; return { projectId: projectA }; } },
    publicKeys: ["projectId"], project: result => result,
  };
  const read: ReadOperation<Pair, Public, Public> = {
    id: "fixture.pair_read", kind: "read", requirement, parse: raw => raw as Pair, resources: refsOf,
    read: () => { counts.reads++; return { projectId: projectA }; }, publicKeys: ["projectId"], project: result => result,
  };
  async function* events(): AsyncGenerator<{ seq: number }> { yield { seq: 1 }; yield { seq: 2 }; }
  const stream: StreamOperation<Pair, { seq: number }, { seq: number }> = {
    id: "fixture.pair_stream", kind: "stream", requirement, parse: raw => raw as Pair, resources: refsOf,
    open: () => { counts.opens++; return events(); }, publicKeys: ["seq"], projectEvent: event => ({ seq: event.seq }),
  };
  return { ...context, counts, mutation, read, stream };
}

const notFound = { category: "not_found", status: 404, reason: "resource_not_found", retry: "none" };
const malformed = { category: "invalid_request", status: 400, reason: "unknown_resource_kind", retry: "none" };
const faulted = { category: "internal", status: 500, reason: "unexpected_failure", retry: "none" };

/** The public error of every path for one pair: mutation (with and without a key), read and stream open. */
async function answers(input: Pair) {
  const { alice, runner, mutation, read, stream, counts, idempotency } = world();
  const keyedMutation: MutationOperation<Pair, Public, Public> = { ...mutation, retain: true };
  const failed = (result: RunResult<unknown> | { ok: false; error: unknown } | { ok: true }) => (result.ok ? "allowed" : result.error);
  const results = {
    mutation: failed(await runner.run(mutation, alice.context, input)),
    keyed: failed(await runner.run(keyedMutation, alice.context, input, { idempotencyKey: "k-1" })),
    read: failed(await runner.run(read, alice.context, input)),
    stream: failed(await runner.stream(stream, alice.context, input)),
  };
  expect(counts).toEqual({ effects: 0, reads: 0, opens: 0 });
  expect(idempotency.states()).toEqual([]);
  return results;
}

const expected = (error: object) => ({
  mutation: { ...error, effect: "not_started" }, keyed: { ...error, effect: "not_started" }, read: { ...error, effect: null }, stream: { ...error, effect: null },
});

describe("reference handling in three passes (decision X)", () => {
  it("answers invalid_request for a malformed reference whether the other one is missing, invisible or visible, in both orders", async () => {
    for (const other of [MISSING, INVISIBLE, VISIBLE]) {
      expect(await answers({ first: MALFORMED, second: other })).toEqual(expected(malformed));
      expect(await answers({ first: other, second: MALFORMED })).toEqual(expected(malformed));
    }
  });

  it("answers one identical not_found for a missing and an invisible reference, in both orders", async () => {
    const pairs: [unknown, unknown][] = [[MISSING, INVISIBLE], [MISSING, VISIBLE], [INVISIBLE, VISIBLE], [MISSING, MISSING], [INVISIBLE, INVISIBLE]];
    for (const [left, right] of pairs) {
      expect(await answers({ first: left, second: right })).toEqual(expected(notFound));
      expect(await answers({ first: right, second: left })).toEqual(expected(notFound));
    }
  });

  it("answers the lookup failure when the resolver throws for one reference, whatever the other one is and in both orders", async () => {
    for (const other of [MISSING, INVISIBLE, VISIBLE]) {
      expect(await answers({ first: THROWING, second: other })).toEqual(expected(faulted));
      expect(await answers({ first: other, second: THROWING })).toEqual(expected(faulted));
    }
    // A malformed reference still wins: syntax is checked before any lookup.
    expect(await answers({ first: THROWING, second: MALFORMED })).toEqual(expected(malformed));
  });

  it("calls the resolver for every reference before answering not_found", async () => {
    const { alice, runner, read, world: fixture } = world();
    const before = fixture.resolver.resolveCalls;
    expect(await runner.run(read, alice.context, { first: MISSING, second: INVISIBLE })).toMatchObject({ ok: false, error: notFound });
    expect(fixture.resolver.resolveCalls - before).toBe(2);
  });

  it("ends an open stream with the same not_found when one reference disappears and the other becomes invisible", async () => {
    for (const order of ["first", "second"] as const) {
      const { alice, runner, stream, world: fixture } = world();
      const visibleA = { kind: "registration" as const, id: "reg-a2" };
      fixture.resolver.put(visibleA, projectA);
      const input = order === "first" ? { first: VISIBLE, second: visibleA } : { first: visibleA, second: VISIBLE };
      const opened = await runner.stream(stream, alice.context, input);
      if (!opened.ok) throw new Error(JSON.stringify(opened.error));
      const first = await opened.events.next();
      expect(first).toEqual({ done: false, value: { event: { seq: 1 } } });
      fixture.resolver.delete(VISIBLE as ResourceRef).move(visibleA, projectB);
      let items: unknown[] = [];
      expect(await unhandledDuring(async () => { items = await collect(opened.events); })).toEqual([]);
      expect(items).toEqual([{ error: { ...notFound, effect: null } }]);
    }
  });
});
