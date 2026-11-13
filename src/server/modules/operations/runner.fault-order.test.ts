import { describe, expect, it } from "vitest";
import type { ProjectId } from "@/shared/contracts/operations";
import type { GrantsSnapshot } from "./grants";
import type { MutationOperation, PhaseScope, ReadOperation, StreamOperation } from "./operation";
import { onProject, type ResourceRef } from "./requirements";
import { OperationRunner, type RunResult } from "./runner";
import { collect, projectA, projectB, REGISTRATION, setup } from "./runner-fixture";
import { sessionDescribe } from "./session-describe";

/**
 * Decision Y: everything that can fail independently of the referenced
 * resources (authority revalidation, clock, grants snapshot and every call on
 * it) runs before any reference is resolved. A fault there gives the same
 * answer for a missing and for an existing invisible resource, and the
 * resolver is never called. Alice is an operator of project A only.
 */

type Fault = "grants_throw" | "grants_promise" | "grants_for_throw" | "account_kind_throw" | "now_throw" | "authority";
const FAULTS: readonly Fault[] = ["grants_throw", "grants_promise", "grants_for_throw", "account_kind_throw", "now_throw", "authority"];
type Target = "missing" | "invisible";

const MISSING = { kind: "registration" as const, id: "reg-missing" };
const INVISIBLE = { kind: "registration" as const, id: "reg-b" };
type Input = { registrationId: string };
type Public = { projectId: ProjectId };

const requirement = { require: onProject("runtime:control", "registration") };
const refsOf = (input: Input): Readonly<Record<string, ResourceRef>> => ({ registration: { kind: "registration", id: input.registrationId } });
const parse = (raw: unknown): Input => ({ registrationId: String((raw as Input).registrationId) });

function world() {
  const context = setup();
  const { world: fixture, alice, idempotency } = context;
  fixture.resolver.put(INVISIBLE, projectB);
  const armed: { fault: Fault | null } = { fault: null };
  const fail = (what: string) => { throw new Error(`${what} failed /secret`); };
  const snapshot: GrantsSnapshot = {
    accountKind: id => (armed.fault === "account_kind_throw" ? fail("accountKind") : fixture.grants.accountKind(id)),
    grantsFor: id => (armed.fault === "grants_for_throw" ? fail("grantsFor") : fixture.grants.grantsFor(id)),
  };
  const runner = new OperationRunner({
    ...fixture.runtime({ idempotency }),
    now: () => (armed.fault === "now_throw" ? fail("clock") : fixture.clock.now),
    grants: () => {
      if (armed.fault === "grants_throw") fail("grants");
      if (armed.fault === "grants_promise") return Promise.resolve(snapshot) as unknown as GrantsSnapshot;
      return snapshot;
    },
  });
  /** Injects the fault; returns the resolver call count at that moment. */
  const arm = (fault: Fault): number => {
    armed.fault = fault;
    if (fault === "authority") fixture.verifier.revoke("provider_session", alice.credentialId);
    return fixture.resolver.resolveCalls;
  };
  const counts = { effects: 0, reads: 0, opens: 0 };
  const mutation: MutationOperation<Input, Public, Public> = {
    id: "fixture.fault_mutation", kind: "mutation", requirement, parse, resources: refsOf, retain: true,
    effect: { mode: "admitted", run: (_input: Input, scope: PhaseScope) => { counts.effects++; return { projectId: scope.resources.registration.projectId }; } },
    publicKeys: ["projectId"], project: result => result,
  };
  const read: ReadOperation<Input, Public, Public> = {
    id: "fixture.fault_read", kind: "read", requirement, parse, resources: refsOf,
    read: (_input, scope) => { counts.reads++; return { projectId: scope.resources.registration.projectId }; },
    publicKeys: ["projectId"], project: result => result,
  };
  async function* events(): AsyncGenerator<{ seq: number }> { yield { seq: 1 }; yield { seq: 2 }; }
  const stream: StreamOperation<Input, { seq: number }, { seq: number }> = {
    id: "fixture.fault_stream", kind: "stream", requirement, parse, resources: refsOf,
    open: () => { counts.opens++; return events(); }, publicKeys: ["seq"], projectEvent: event => ({ seq: event.seq }),
  };
  return { ...context, runner, arm, counts, mutation, read, stream };
}

const outcome = (result: RunResult<unknown> | { ok: false; error: unknown } | { ok: true }) => (result.ok ? "allowed" : result.error);

type Path = "mutation" | "keyed" | "read" | "stream_open" | "replay" | "stream_event";
const PATHS: readonly Path[] = ["mutation", "keyed", "read", "stream_open", "replay", "stream_event"];

/** The public answer of one path with the fault armed, and how often the resolver ran after the fault was armed. */
async function answer(fault: Fault, target: Target, path: Path) {
  const w = world();
  const ref = target === "missing" ? MISSING : INVISIBLE;
  const input = { registrationId: ref.id };
  if (path === "replay") {
    // A completed record for reg-1, then reg-1 becomes missing (deleted) or invisible (moved to project B).
    expect(await w.runner.run(w.mutation, w.alice.context, { registrationId: REGISTRATION.id }, { idempotencyKey: "k-1" })).toMatchObject({ ok: true, replayed: false });
    if (target === "missing") w.world.resolver.delete(REGISTRATION); else w.world.resolver.move(REGISTRATION, projectB);
    const before = w.arm(fault);
    const result = outcome(await w.runner.run(w.mutation, w.alice.context, { registrationId: REGISTRATION.id }, { idempotencyKey: "k-1" }));
    expect(w.counts.effects).toBe(1);
    return { result, resolved: w.world.resolver.resolveCalls - before };
  }
  if (path === "stream_event") {
    const opened = await w.runner.stream(w.stream, w.alice.context, { registrationId: REGISTRATION.id });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    expect(await opened.events.next()).toEqual({ done: false, value: { event: { seq: 1 } } });
    if (target === "missing") w.world.resolver.delete(REGISTRATION); else w.world.resolver.move(REGISTRATION, projectB);
    const before = w.arm(fault);
    const result = await collect(opened.events);
    return { result, resolved: w.world.resolver.resolveCalls - before };
  }
  const before = w.arm(fault);
  let result: unknown;
  if (path === "mutation") result = outcome(await w.runner.run(w.mutation, w.alice.context, input));
  else if (path === "keyed") result = outcome(await w.runner.run(w.mutation, w.alice.context, input, { idempotencyKey: "k-1" }));
  else if (path === "read") result = outcome(await w.runner.run(w.read, w.alice.context, input));
  else result = outcome(await w.runner.stream(w.stream, w.alice.context, input));
  expect(w.counts).toEqual({ effects: 0, reads: 0, opens: 0 });
  expect(w.idempotency.states()).toEqual([]);
  return { result, resolved: w.world.resolver.resolveCalls - before };
}

const expectedCategory = (fault: Fault) => (fault === "authority" ? "unauthenticated" : "internal");

describe("faults that do not depend on the referenced resources come first (decision Y)", () => {
  it("answers identically for a missing and an invisible resource on every path, for every such fault", async () => {
    for (const fault of FAULTS) {
      for (const path of PATHS) {
        const missing = await answer(fault, "missing", path);
        const invisible = await answer(fault, "invisible", path);
        expect({ fault, path, result: missing.result }).toEqual({ fault, path, result: invisible.result });
        const error = path === "stream_event" ? (missing.result as { error: unknown }[])[0]?.error : missing.result;
        expect({ fault, path, category: (error as { category?: unknown }).category }).toEqual({ fault, path, category: expectedCategory(fault) });
        expect(JSON.stringify(missing.result)).not.toContain("secret");
      }
    }
  });

  it("never calls the resolver when an earlier step fails", async () => {
    for (const fault of FAULTS) {
      for (const path of PATHS) {
        for (const target of ["missing", "invisible"] as const) {
          expect({ fault, path, target, resolved: (await answer(fault, target, path)).resolved }).toEqual({ fault, path, target, resolved: 0 });
        }
      }
    }
  });

  it("still answers not_found identically for a missing and an invisible resource without a fault", async () => {
    for (const ref of [MISSING, INVISIBLE]) {
      const w = world();
      expect(await w.runner.run(w.read, w.alice.context, { registrationId: ref.id })).toEqual({ ok: false, error: {
        category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: null } });
    }
  });

  it("session.describe answers the same fault whatever projects exist, without listing them", async () => {
    for (const fault of FAULTS) {
      const results: unknown[] = [];
      // Project B exists in one world and not in the other; Alice cannot see it in either.
      for (const exists of [true, false]) {
        const w = world();
        if (!exists) w.world.resolver.removeProject(projectB);
        let listed = 0;
        const list = w.world.resolver.listProjects.bind(w.world.resolver);
        w.world.resolver.listProjects = () => { listed++; return list(); };
        w.arm(fault);
        results.push(outcome(await w.runner.run(sessionDescribe, w.alice.context, {})));
        expect({ fault, listed }).toEqual({ fault, listed: 0 });
      }
      expect(results[0]).toEqual(results[1]);
      expect({ fault, category: (results[0] as { category?: unknown }).category }).toEqual({ fault, category: expectedCategory(fault) });
    }
  });
});
