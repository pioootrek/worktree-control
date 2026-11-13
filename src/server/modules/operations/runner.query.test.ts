import { describe, expect, it } from "vitest";
import type { ProjectId } from "@/shared/contracts/operations";
import { OperationError } from "./errors";
import { OperationRegistry, type QueryOperation, type StreamOperation } from "./operation";
import { createWorld, P } from "./operations-fixture";
import { onProject } from "./requirements";
import { OperationRunner, type StreamItem } from "./runner";
import { collect, deferred, tick, unhandledDuring } from "./runner-fixture";

/**
 * Kind `query` and bounded one-event waits (`29cf8fa5` delta 1, review
 * `ce8aa214` F1): asynchronous work runs outside admission between an
 * admitted authorization and a fresh decision before release.
 */
const projectA = P("project-a");
const projectB = P("project-b");
const REG = { kind: "registration" as const, id: "reg-1" };

function world() {
  const fixture = createWorld();
  fixture.resolver.addProject(projectA).addProject(projectB).put(REG, projectA);
  const alice = fixture.human("alice");
  fixture.grants.grant({ accountId: alice.id, role: "reader", scope: { kind: "project", projectId: projectA } });
  return { world: fixture, alice };
}

interface Worktrees { projectId: ProjectId; paths: string[]; secretToken: string }
type WorktreeQuery = QueryOperation<{ registrationId: string }, Worktrees, { projectId: ProjectId; paths: string[] }, { projectId: ProjectId }>;

/** `project.worktrees`: discovery runs outside admission. */
function worktrees(fixture: ReturnType<typeof createWorld>, work: (signal: AbortSignal) => Promise<void> = async () => undefined) {
  const log = { plans: 0, works: 0, admittedDuringWork: [] as boolean[], signals: [] as AbortSignal[], projected: 0 };
  const operation: WorktreeQuery = {
    id: "fixture.project_worktrees", kind: "query",
    requirement: { require: onProject("project:read", "registration") },
    parse: raw => ({ registrationId: String((raw as { registrationId: string }).registrationId) }),
    resources: input => ({ registration: { kind: "registration", id: input.registrationId } }),
    plan(_input, scope) { log.plans++; return { projectId: scope.resources.registration.projectId }; },
    async work(plan, signal) {
      log.works++;
      log.signals.push(signal);
      log.admittedDuringWork.push(fixture.admission.admitted);
      await work(signal);
      return { projectId: plan.projectId, paths: ["/w/main"], secretToken: "discovery-secret" };
    },
    publicKeys: ["projectId", "paths"],
    project: result => { log.projected++; return { projectId: result.projectId, paths: result.paths }; },
  };
  return { operation, log };
}

const notFound = { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: null };

describe("query", () => {
  it("authorizes, works outside admission, decides again and releases", async () => {
    const { world: fixture, alice } = world();
    const { operation, log } = worktrees(fixture);
    const result = await new OperationRunner(fixture.runtime()).run(operation, alice.context, { registrationId: REG.id });
    expect(result).toEqual({ ok: true, value: { projectId: projectA, paths: ["/w/main"] }, replayed: false });
    expect(log).toMatchObject({ plans: 1, works: 1, admittedDuringWork: [false], projected: 1 });
    expect(fixture.admission.events.filter(event => event.kind === "run")).toHaveLength(2);
  });

  it("revocation during the asynchronous work releases nothing", async () => {
    for (const revoke of ["grants", "credential"] as const) {
      const { world: fixture, alice } = world();
      const { operation, log } = worktrees(fixture, async () => {
        if (revoke === "grants") fixture.grants.revokeAll(alice.id); else fixture.verifier.revoke("provider_session", alice.credentialId);
      });
      const result = await new OperationRunner(fixture.runtime()).run(operation, alice.context, { registrationId: REG.id });
      expect(result).toEqual({ ok: false, error: revoke === "grants" ? notFound
        : { category: "unauthenticated", status: 401, reason: "credential_no_longer_valid", retry: "reauthenticate", effect: null } });
      expect(log.projected).toBe(0);
      expect(JSON.stringify(result)).not.toContain("w/main");
    }
  });

  it("a resource moved during the work is resource_changed, even when still authorized", async () => {
    const { world: fixture, alice } = world();
    fixture.grants.grant({ accountId: alice.id, role: "reader", scope: { kind: "project", projectId: projectB } });
    const { operation, log } = worktrees(fixture, async () => { fixture.resolver.move(REG, projectB); });
    expect(await new OperationRunner(fixture.runtime()).run(operation, alice.context, { registrationId: REG.id }))
      .toEqual({ ok: false, error: { category: "conflict", status: 409, reason: "resource_changed", retry: "none", effect: null } });
    expect(log.projected).toBe(0);
  });

  it("a failure of the work is released only after the fresh decision", async () => {
    const { world: fixture, alice } = world();
    const { operation } = worktrees(fixture, async () => {
      fixture.grants.revokeAll(alice.id);
      throw new OperationError("unavailable", "discovery_failed");
    });
    expect(await new OperationRunner(fixture.runtime()).run(operation, alice.context, { registrationId: REG.id })).toEqual({ ok: false, error: notFound });
    const { world: other, alice: caller } = world();
    const failing = worktrees(other, async () => { throw new OperationError("unavailable", "discovery_failed"); });
    expect(await new OperationRunner(other.runtime()).run(failing.operation, caller.context, { registrationId: REG.id }))
      .toEqual({ ok: false, error: { category: "unavailable", status: 503, reason: "discovery_failed", retry: "none", effect: null } });
  });

  it("caller cancellation aborts the work, ignores its late result and releases nothing", async () => {
    const { world: fixture, alice } = world();
    const gate = deferred();
    const { operation, log } = worktrees(fixture, async () => { await gate.promise; throw new Error("late /secret"); });
    const controller = new AbortController();
    let result: unknown;
    const unhandled = await unhandledDuring(async () => {
      const pending = new OperationRunner(fixture.runtime()).run(operation, alice.context, { registrationId: REG.id }, { signal: controller.signal });
      await tick();
      controller.abort();
      result = await pending;
      gate.resolve();
    });
    expect(unhandled).toEqual([]);
    expect(result).toEqual({ ok: false, error: { category: "unavailable", status: 503, reason: "request_cancelled", retry: "retry", effect: null } });
    expect(log.signals[0].aborted).toBe(true);
    expect(log.projected).toBe(0);
  });

  it("is bounded: the work is aborted at its deadline", async () => {
    const { world: fixture, alice } = world();
    const { operation, log } = worktrees(fixture, signal => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted /secret")), { once: true });
    }));
    const timedOut = { ok: false, error: { category: "unavailable", status: 503, reason: "query_timed_out", retry: "retry", effect: null } };
    // The runtime's deadline bounds every query; an operation's own timeout can only shorten it.
    expect(await new OperationRunner(fixture.runtime({ queryDeadlineMs: 20 })).run(operation, alice.context, { registrationId: REG.id })).toEqual(timedOut);
    expect(await new OperationRunner(fixture.runtime()).run({ ...operation, timeoutMs: 20 }, alice.context, { registrationId: REG.id })).toEqual(timedOut);
    expect(await new OperationRunner(fixture.runtime({ queryDeadlineMs: 20 })).run({ ...operation, timeoutMs: 60_000 }, alice.context, { registrationId: REG.id }))
      .toEqual(timedOut);
    expect(log.works).toBe(3);
    expect(log.signals.every(signal => signal.aborted)).toBe(true);
    expect(log.projected).toBe(0);
  });

  it("masks a missing and an invisible resource identically and takes no idempotency key", async () => {
    const { world: fixture, alice } = world();
    fixture.resolver.put({ kind: "registration", id: "reg-b" }, projectB);
    const { operation, log } = worktrees(fixture);
    const runner = new OperationRunner(fixture.runtime());
    const missing = await runner.run(operation, alice.context, { registrationId: "reg-missing" });
    expect(missing).toEqual({ ok: false, error: notFound });
    expect(await runner.run(operation, alice.context, { registrationId: "reg-b" })).toEqual(missing);
    expect(log.works).toBe(0);
    expect(await runner.run(operation, alice.context, { registrationId: REG.id }, { idempotencyKey: "k-1" }))
      .toMatchObject({ ok: false, error: { category: "invalid_request", reason: "idempotency_not_supported" } });
  });

  it("registers only with plan and work and a valid timeout", () => {
    const { world: fixture } = world();
    const { operation } = worktrees(fixture);
    expect(new OperationRegistry().register(operation).kind).toBe("query");
    for (const broken of [{ ...operation, work: undefined }, { ...operation, plan: undefined }, { ...operation, timeoutMs: 0 }]) {
      expect(() => new OperationRegistry().register(broken as unknown as WorktreeQuery)).toThrow(TypeError);
    }
  });
});

interface Status { projectId: ProjectId; seq: number }
type WaitOperation = StreamOperation<{ projectId: string; timeoutMs?: number }, Status, Status>;

/** `project.wait`: a source that could yield many events. */
function wait(fixture: ReturnType<typeof createWorld>, options: { maxWaiters?: number; events?: number; beforeEvent?: () => Promise<void> } = {}) {
  const state = { disposed: 0, produced: 0 };
  const operation: WaitOperation = {
    id: "fixture.project_wait", kind: "stream",
    requirement: { require: onProject("project:read", "project") },
    parse: raw => ({ projectId: String((raw as { projectId: string }).projectId), timeoutMs: (raw as { timeoutMs?: number }).timeoutMs }),
    resources: input => ({ project: { kind: "project", id: input.projectId } }),
    open: () => (async function* generate() {
      try {
        for (let seq = 1; seq <= (options.events ?? 5); seq++) {
          if (options.beforeEvent) await options.beforeEvent(); else await Promise.resolve();
          state.produced++;
          yield { projectId: projectA, seq };
        }
        await new Promise(() => undefined);
      } finally { state.disposed++; }
    })(),
    publicKeys: ["projectId", "seq"],
    projectEvent: event => ({ projectId: event.projectId, seq: event.seq }),
    wait: { maxWaiters: options.maxWaiters ?? 4, timeoutMs: input => input.timeoutMs ?? 10_000 },
  };
  return { operation, state };
}

describe("waits: bounded one-event streams", () => {
  it("delivers at most one event and disposes the source", async () => {
    const { world: fixture, alice } = world();
    const { operation, state } = wait(fixture);
    const opened = await new OperationRunner(fixture.runtime()).stream(operation, alice.context, { projectId: projectA });
    if (!opened.ok) throw new Error("not opened");
    expect(await collect(opened.events as AsyncIterable<StreamItem<{ seq: number }>>)).toEqual([{ event: { projectId: projectA, seq: 1 } }]);
    await opened.events.return!();
    expect(state.produced).toBe(1);
    expect(state.disposed).toBe(1);
  });

  it("ends with done and no event at its timeout, and disposes the source", async () => {
    const { world: fixture, alice } = world();
    const { operation, state } = wait(fixture, { beforeEvent: () => new Promise(() => undefined) });
    const opened = await new OperationRunner(fixture.runtime()).stream(operation, alice.context, { projectId: projectA, timeoutMs: 20 });
    if (!opened.ok) throw new Error("not opened");
    expect(await collect(opened.events as AsyncIterable<StreamItem<{ seq: number }>>)).toEqual([]);
    await opened.events.return!();
    expect(state.produced).toBe(0);
  });

  it("limits waiters per operation and frees a slot whenever a wait ends", async () => {
    const { world: fixture, alice } = world();
    const { operation } = wait(fixture, { maxWaiters: 1, beforeEvent: () => new Promise(() => undefined) });
    const runner = new OperationRunner(fixture.runtime());
    const first = await runner.stream(operation, alice.context, { projectId: projectA });
    expect(first.ok).toBe(true);
    expect(await runner.stream(operation, alice.context, { projectId: projectA }))
      .toEqual({ ok: false, error: { category: "busy", status: 503, reason: "too_many_waiters", retry: "retry", effect: null } });
    if (first.ok) await first.events.return!();
    const third = await runner.stream(operation, alice.context, { projectId: projectA });
    expect(third.ok).toBe(true);
    if (third.ok) await third.events.return!();
    // A refused opening (here: not found) holds no slot either.
    expect(await runner.stream(operation, alice.context, { projectId: "project-missing" })).toMatchObject({ ok: false, error: { category: "not_found" } });
    const fourth = await runner.stream(operation, alice.context, { projectId: projectA });
    expect(fourth.ok).toBe(true);
    if (fourth.ok) await fourth.events.return!();
  });

  it("rejects a timeout outside 1 to 20 seconds", async () => {
    const { world: fixture, alice } = world();
    const { operation } = wait(fixture);
    for (const timeoutMs of [0, 20_001, 1.5]) {
      expect(await new OperationRunner(fixture.runtime()).stream(operation, alice.context, { projectId: projectA, timeoutMs }))
        .toEqual({ ok: false, error: { category: "invalid_request", status: 400, reason: "invalid_wait_timeout", retry: "none", effect: null } });
    }
  });

  it("revocation while waiting releases no event", async () => {
    const { world: fixture, alice } = world();
    const { operation, state } = wait(fixture, { beforeEvent: async () => { fixture.grants.revokeAll(alice.id); } });
    const opened = await new OperationRunner(fixture.runtime()).stream(operation, alice.context, { projectId: projectA });
    if (!opened.ok) throw new Error("not opened");
    expect(await collect(opened.events as AsyncIterable<StreamItem<{ seq: number }>>)).toEqual([{ error: notFound }]);
    expect(state.disposed).toBe(1);
  });

  it("registers only with valid wait bounds", () => {
    const { world: fixture } = world();
    const { operation } = wait(fixture);
    for (const bad of [{ maxWaiters: 0, timeoutMs: () => 1 }, { maxWaiters: 1 }, { maxWaiters: 1.5, timeoutMs: () => 1 }]) {
      expect(() => new OperationRegistry().register({ ...operation, wait: bad } as unknown as WaitOperation)).toThrow(TypeError);
    }
  });
});
