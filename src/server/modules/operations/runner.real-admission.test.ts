import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectId } from "@/shared/contracts/operations";
import { SqliteStateStore } from "@/server/infrastructure/sqlite/sqlite-state-store";
import type { IdleCommitScope, MutationOperation, PhaseScope, QueryOperation } from "./operation";
import { createWorld, MemoryIdempotency, P } from "./operations-fixture";
import { onProject } from "./requirements";
import { OperationRunner, type RunResult } from "./runner";

/**
 * The runner on the real connection gate (`SqliteStateStore.admission` over a
 * temporary database), not on the admission double. Test-only: production
 * code still never imports this module.
 */
const roots: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}

describe("operation runner on the real admission gate", () => {
  it("releases a lease exactly once when re-admission after the acquire is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "operations-runner-")); roots.push(root);
    const store = new SqliteStateStore(join(root, "state.sqlite3"), undefined, { admissionTimeoutMs: 50 });
    cleanups.push(() => store.close());
    const storage = store.authenticationProviderStorage();
    const world = createWorld();
    const projectA = P("project-a");
    world.resolver.addProject(projectA).put({ kind: "registration", id: "reg-1" }, projectA);
    const alice = world.human("alice");
    world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectA } });
    const runner = new OperationRunner({ ...world.runtime(), admission: store.admission });

    const providerEntered = gate(), providerRelease = gate();
    let providerDone: Promise<unknown> = Promise.resolve();
    cleanups.push(async () => { providerRelease.open(); await providerDone.catch(() => undefined); });
    const log = { held: false, releases: 0, effects: 0 };
    const operation: MutationOperation<{ registrationId: string }, { projectId: ProjectId }, { projectId: ProjectId }> = {
      id: "fixture.real_gate_start",
      kind: "mutation",
      requirement: { require: onProject("runtime:control", "registration") },
      parse: raw => ({ registrationId: String((raw as { registrationId: string }).registrationId) }),
      resources: input => ({ registration: { kind: "registration", id: input.registrationId } }),
      async acquire() {
        // While the caller is suspended, a provider takes the connection and keeps it,
        // so the caller's re-admission after this acquire times out.
        providerDone = storage.borrow(async () => { providerEntered.open(); await providerRelease.opened; });
        await providerEntered.opened;
        log.held = true;
        return { release: () => { log.held = false; log.releases++; } };
      },
      effect: { mode: "idle", async run(_input: { registrationId: string }, scope: PhaseScope) { log.effects++; return { projectId: scope.resources.registration.projectId }; } },
      publicKeys: ["projectId"],
      project: result => result,
    };

    // The caller already holds admission, so the wait for the lock suspends it and must re-admit it.
    const result = await store.admission.run(() => runner.run(operation, alice.context, { registrationId: "reg-1" }));
    expect(result).toEqual({ ok: false, error: { category: "busy", status: 503, reason: "admission_refused", retry: "retry", effect: "not_started" } });
    expect(log).toEqual({ held: false, releases: 1, effects: 0 });
  });

  it("suspends an inherited admission during query work, so a provider borrow completes while the work waits", async () => {
    const root = mkdtempSync(join(tmpdir(), "operations-runner-")); roots.push(root);
    const store = new SqliteStateStore(join(root, "state.sqlite3"), undefined, { admissionTimeoutMs: 500 });
    cleanups.push(() => store.close());
    const storage = store.authenticationProviderStorage();
    const world = createWorld();
    const projectA = P("project-a");
    world.resolver.addProject(projectA).put({ kind: "registration", id: "reg-1" }, projectA);
    const alice = world.human("alice");
    world.grants.grant({ accountId: alice.id, role: "reader", scope: { kind: "project", projectId: projectA } });
    const runner = new OperationRunner({ ...world.runtime(), admission: store.admission, queryDeadlineMs: 2_000 });
    const log = { borrowed: false, phases: [] as string[] };
    type Input = { registrationId: string };
    const operation: QueryOperation<Input, { projectId: ProjectId; borrowed: boolean }, { projectId: ProjectId; borrowed: boolean }, { projectId: ProjectId }> = {
      id: "fixture.real_gate_query",
      kind: "query",
      requirement: { require: onProject("project:read", "registration") },
      parse: raw => ({ registrationId: String((raw as Input).registrationId) }),
      resources: input => ({ registration: { kind: "registration", id: input.registrationId } }),
      plan: (_input, scope) => { log.phases.push("plan"); return { projectId: scope.resources.registration.projectId }; },
      async work(plan) {
        // The pending work waits on a provider borrow, which needs the connection the caller was admitted on.
        await storage.borrow(async () => { log.borrowed = true; });
        log.phases.push("work");
        return { projectId: plan.projectId, borrowed: log.borrowed };
      },
      publicKeys: ["projectId", "borrowed"],
      project: result => { log.phases.push("project"); return result; },
    };

    // The caller already holds admission, which `run` joins; the work must not keep it.
    const result = await store.admission.run(() => runner.run(operation, alice.context, { registrationId: "reg-1" }));
    expect(result).toEqual({ ok: true, value: { projectId: projectA, borrowed: true }, replayed: false });
    expect(log).toEqual({ borrowed: true, phases: ["plan", "work", "project"] });

    // The fresh decision after re-admission still applies: revoked during the work, nothing is released.
    const revoking: typeof operation = { ...operation, async work(plan) {
      await storage.borrow(async () => { world.grants.revokeAll(alice.id); });
      return { projectId: plan.projectId, borrowed: true };
    } };
    expect(await store.admission.run(() => runner.run(revoking, alice.context, { registrationId: "reg-1" })))
      .toEqual({ ok: false, error: { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: null } });
  });

  it("takes a fresh admission for a declared commit inside the idle effect, and refuses it after revocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "operations-runner-")); roots.push(root);
    const store = new SqliteStateStore(join(root, "state.sqlite3"), undefined, { admissionTimeoutMs: 500 });
    cleanups.push(() => store.close());
    const world = createWorld();
    const projectA = P("project-a");
    world.resolver.addProject(projectA).put({ kind: "registration", id: "reg-1" }, projectA);
    const alice = world.human("alice");
    world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectA } });
    const idempotency = new MemoryIdempotency();
    const runner = new OperationRunner({ ...world.runtime({ idempotency }), admission: store.admission });
    const log = { effects: 0, states: [] as string[][] };
    const preflight: { revoke: boolean } = { revoke: false };
    const operation: MutationOperation<{ registrationId: string }, { projectId: ProjectId }, { projectId: ProjectId }> = {
      id: "fixture.real_gate_commit",
      kind: "mutation",
      requirement: { require: onProject("runtime:control", "registration") },
      parse: raw => ({ registrationId: String((raw as { registrationId: string }).registrationId) }),
      resources: input => ({ registration: { kind: "registration", id: input.registrationId } }),
      effect: { mode: "idle", commitPoint: "declared", async run(_input: { registrationId: string }, scope: IdleCommitScope) {
        await new Promise(resolve => setTimeout(resolve, 5));
        if (preflight.revoke) world.grants.revokeAll(alice.id);
        log.states.push(idempotency.states());
        await scope.commit();
        log.states.push(idempotency.states());
        log.effects++;
        return { projectId: scope.resources.registration.projectId };
      } },
      retain: true,
      publicKeys: ["projectId"],
      project: result => result,
    };
    expect(await runner.run(operation, alice.context, { registrationId: "reg-1" }, { idempotencyKey: "k-1" })).toEqual({ ok: true, value: { projectId: projectA }, replayed: false });
    expect(log).toEqual({ effects: 1, states: [["reserved"], ["started"]] });
    preflight.revoke = true;
    expect(await runner.run(operation, alice.context, { registrationId: "reg-1" }, { idempotencyKey: "k-2" })).toEqual({ ok: false, error: {
      category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: "not_started" } });
    expect(log.effects).toBe(1);
    expect(idempotency.states()).toEqual(["completed"]);
  });

  it("never lets a retry admitted right after the completion read completed when that write lands and throws (decision Z)", async () => {
    const root = mkdtempSync(join(tmpdir(), "operations-runner-")); roots.push(root);
    const store = new SqliteStateStore(join(root, "state.sqlite3"), undefined, { admissionTimeoutMs: 500 });
    cleanups.push(() => store.close());
    const world = createWorld();
    const projectA = P("project-a");
    world.resolver.addProject(projectA).put({ kind: "registration", id: "reg-1" }, projectA);
    const alice = world.human("alice");
    world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectA } });
    const idempotency = new MemoryIdempotency();
    idempotency.failAfterWrite.add("completed");
    const runner = new OperationRunner({ ...world.runtime({ idempotency }), admission: store.admission });
    const log = { effects: 0, read: [] as string[] };
    type Input = { registrationId: string };
    const operation: MutationOperation<Input, { projectId: ProjectId }, { projectId: ProjectId }> = {
      id: "fixture.real_gate_final_write",
      kind: "mutation",
      requirement: { require: onProject("runtime:control", "registration") },
      parse: raw => ({ registrationId: String((raw as Input).registrationId) }),
      resources: input => ({ registration: { kind: "registration", id: input.registrationId } }),
      effect: { mode: "admitted", run: (_input: Input, scope: PhaseScope) => { log.effects++; return { projectId: scope.resources.registration.projectId }; } },
      retain: true,
      publicKeys: ["projectId"],
      project: result => result,
    };
    const run = () => runner.run(operation, alice.context, { registrationId: "reg-1" }, { idempotencyKey: "k-1" });
    const get = idempotency.get.bind(idempotency), put = idempotency.put.bind(idempotency);
    idempotency.get = key => { const record = get(key); log.read.push(record?.state ?? "none"); return record; };
    const pending: { started: boolean; retry?: Promise<RunResult<{ projectId: ProjectId }>> } = { started: false };
    idempotency.put = (key, record) => {
      if (record.state === "completed" && !pending.started) {
        pending.started = true;
        // The identical retry is admitted, outside the original's admitted operation, as soon as the completion callback returns.
        queueMicrotask(() => { pending.retry = store.admission.outside(() => run()); });
      }
      put(key, record);
    };
    expect(await run()).toEqual({ ok: false, error: {
      category: "unavailable", status: 503, reason: "finalization_unconfirmed", retry: "inspect_first", effect: "cleanup_unconfirmed" } });
    expect(pending.retry).toBeDefined();
    expect(await pending.retry!).toEqual({ ok: false, error: {
      category: "outcome_unknown", status: 409, reason: "previous_attempt_outcome_unknown", retry: "inspect_first", effect: "unknown" } });
    expect(log.read).toEqual(["none", "unknown"]);
    expect(log.effects).toBe(1);
    expect(idempotency.states()).toEqual(["unknown"]);
  });
});
