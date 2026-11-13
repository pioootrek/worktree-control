import { describe, expect, it } from "vitest";
import type { ProjectId } from "@/shared/contracts/operations";
import type { AuthenticationContext } from "./authentication-context";
import { OperationError } from "./errors";
import type { Lease, MutationOperation, StreamOperation } from "./operation";
import { admissionRefusal, createWorld, MemoryRetained, P } from "./operations-fixture";
import { allOf, onProject, type OperationRequirement } from "./requirements";
import { OperationRunner, type StreamItem } from "./runner";

const projectA = P("project-a");
const projectB = P("project-b");
const REGISTRATION = { kind: "registration" as const, id: "reg-1" };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

interface StartInput { registrationId: string }
interface StartInternal { projectId: ProjectId; pid: number; processSecret: string }

/**
 * Fake effect operation: waits for a project lock, starts a "process" (the
 * effect), finalizes with an audit record and owned-process bookkeeping.
 */
function fakeStart(world: ReturnType<typeof createWorld>, hooks: {
  lockWait?: Promise<void>;
  duringEffect?: () => void;
  effect?: () => Promise<void> | void;
  requirement?: OperationRequirement;
  finalizeThrows?: boolean;
} = {}) {
  const log = { effects: [] as string[], audit: [] as string[], lockHeld: false, lockReleases: 0 };
  const operation: MutationOperation<StartInput, StartInternal, { projectId: ProjectId; started: boolean }> = {
    id: "fixture.runtime_start",
    kind: "mutation",
    requirement: hooks.requirement ?? { require: onProject("runtime:control", "registration") },
    parse: raw => ({ registrationId: String((raw as StartInput).registrationId) }),
    resources: input => ({ registration: { kind: "registration", id: input.registrationId } }),
    async acquire(): Promise<Lease> {
      await hooks.lockWait;
      log.lockHeld = true;
      return { release: () => { log.lockHeld = false; log.lockReleases++; } };
    },
    effect: {
      mode: "idle",
      async run(_input, scope) {
        if (world.admission.admitted) throw new Error("The SQL-free effect must run outside admission.");
        await hooks.effect?.();
        log.effects.push(`start ${scope.resources.registration.projectId}`);
        hooks.duringEffect?.();
        return { projectId: scope.resources.registration.projectId, pid: 4242, processSecret: "pid-secret-token" };
      },
    },
    finalize(_input, outcome) {
      if (hooks.finalizeThrows) throw new Error("audit store unavailable");
      log.audit.push(outcome.ok ? `started ${outcome.value.pid}` : "failed");
    },
    retain: true,
    publicKeys: ["projectId", "started"],
    project: result => ({ projectId: result.projectId, started: true }),
  };
  return { operation, log };
}

function setup() {
  const world = createWorld();
  world.resolver.addProject(projectA).addProject(projectB).put(REGISTRATION, projectA);
  const alice = world.human("alice");
  world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectA } });
  const retained = new MemoryRetained();
  const runner = new OperationRunner(world.runtime({ retained }));
  return { world, alice, runner, retained };
}

const input = { registrationId: REGISTRATION.id };

describe("operation runner: effects", () => {
  it("runs check, wait, effect, finalization and release in order", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    const result = await runner.run(operation, alice.context, input);
    expect(result).toEqual({ ok: true, value: { projectId: projectA, started: true }, replayed: false });
    expect(log).toEqual({ effects: ["start project-a"], audit: ["started 4242"], lockHeld: false, lockReleases: 1 });
    expect(JSON.stringify(result)).not.toContain("pid-secret");
  });

  it("revocation during the lock wait prevents the effect", async () => {
    for (const revoke of ["grants", "credential"] as const) {
      const { world, alice, runner } = setup();
      const lock = deferred();
      const { operation, log } = fakeStart(world, { lockWait: lock.promise });
      const pending = runner.run(operation, alice.context, input);
      await new Promise(resolve => setTimeout(resolve, 0));
      if (revoke === "grants") world.grants.revokeAll(alice.id); else world.verifier.revoke("provider_session", alice.credentialId);
      lock.resolve();
      const result = await pending;
      expect(result).toEqual({ ok: false, error: revoke === "grants"
        ? { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: "not_started" }
        : { category: "unauthenticated", status: 401, reason: "credential_no_longer_valid", retry: "reauthenticate", effect: "not_started" } });
      expect(log.effects).toEqual([]);
      expect(log.audit).toEqual([]);
      expect(log.lockHeld).toBe(false);
    }
  });

  it("revocation just before the effect prevents it, even without a wait", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    // Event 1 is the initial admission; event 2 the recheck admitting the effect.
    world.admission.onAdmit = event => { if (event.n === 2) world.grants.revokeAll(alice.id); };
    const result = await runner.run(operation, alice.context, input);
    expect(result).toMatchObject({ ok: false, error: { category: "not_found", effect: "not_started" } });
    expect(log.effects).toEqual([]);
  });

  it("revocation after the effect completes finalization but withholds the result", async () => {
    for (const revoke of ["grants", "credential", "visible-but-denied"] as const) {
      const { world, alice, runner } = setup();
      const { operation, log } = fakeStart(world, {
        duringEffect: () => {
          if (revoke === "grants") world.grants.revokeAll(alice.id);
          else if (revoke === "credential") world.verifier.revoke("provider_session", alice.credentialId);
          else {
            world.grants.revokeAll(alice.id);
            world.grants.grant({ accountId: alice.id, role: "reader", scope: { kind: "project", projectId: projectA } });
          }
        },
      });
      const result = await runner.run(operation, alice.context, input);
      expect(log.effects).toEqual(["start project-a"]);
      expect(log.audit).toEqual(["started 4242"]);
      expect(log.lockHeld).toBe(false);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toMatchObject({ effect: "committed", retry: "none" });
      expect(result.error.category).toBe(revoke === "grants" ? "not_found" : revoke === "credential" ? "unauthenticated" : "forbidden");
      expect(JSON.stringify(result)).not.toMatch(/pid|4242|project-a/);
    }
  });

  it("re-decides before replaying a retained result", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    const first = await runner.run(operation, alice.context, input, { idempotencyKey: "k-1" });
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(await runner.run(operation, alice.context, input, { idempotencyKey: "k-1" })).toEqual({ ok: true, value: { projectId: projectA, started: true }, replayed: true });
    expect(await runner.run(operation, alice.context, { registrationId: "reg-2" }, { idempotencyKey: "k-1" })).toMatchObject({ ok: false, error: { category: "not_found" } });
    world.resolver.put({ kind: "registration", id: "reg-2" }, projectA);
    expect(await runner.run(operation, alice.context, { registrationId: "reg-2" }, { idempotencyKey: "k-1" })).toMatchObject({ ok: false, error: { category: "conflict", reason: "idempotency_conflict", effect: "not_started" } });
    world.grants.revokeAll(alice.id);
    const replay = await runner.run(operation, alice.context, input, { idempotencyKey: "k-1" });
    expect(replay).toMatchObject({ ok: false, error: { category: "not_found", effect: "not_started" } });
    expect(JSON.stringify(replay)).not.toContain("project-a");
    expect(log.effects).toEqual(["start project-a"]);
  });

  it("does not replay another principal's retained result", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    await runner.run(operation, alice.context, input, { idempotencyKey: "shared" });
    const bob = world.human("bob");
    world.grants.grant({ accountId: bob.id, role: "operator", scope: { kind: "project", projectId: projectA } });
    expect(await runner.run(operation, bob.context, input, { idempotencyKey: "shared" })).toMatchObject({ ok: true, replayed: false });
    expect(log.effects).toHaveLength(2);
  });

  it("re-resolves a registration moved during the wait", async () => {
    for (const destinationRights of [false, true]) {
      const { world, alice, runner } = setup();
      if (destinationRights) world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectB } });
      const lock = deferred();
      const { operation, log } = fakeStart(world, { lockWait: lock.promise });
      const pending = runner.run(operation, alice.context, input);
      await new Promise(resolve => setTimeout(resolve, 0));
      world.resolver.move(REGISTRATION, projectB);
      lock.resolve();
      expect(await pending).toMatchObject({ ok: false, error: destinationRights
        ? { category: "conflict", reason: "resource_changed", effect: "not_started" }
        : { category: "not_found", effect: "not_started" } });
      expect(log.effects).toEqual([]);
    }
  });

  it("withholds the result when the registration moves after the effect", async () => {
    const { world, alice, runner } = setup();
    world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectB } });
    const { operation, log } = fakeStart(world, { duringEffect: () => world.resolver.move(REGISTRATION, projectB) });
    expect(await runner.run(operation, alice.context, input)).toMatchObject({ ok: false, error: { category: "conflict", reason: "resource_changed", effect: "committed" } });
    expect(log.audit).toEqual(["started 4242"]);
  });

  it("checks human-only and conjunction requirements before any effect", async () => {
    const { world, runner } = setup();
    const bot = world.agent("bot");
    world.grants.grant({ accountId: bot.id, role: "operator", scope: { kind: "project", projectId: projectA } });
    const humanOnly = fakeStart(world, { requirement: { require: onProject("runtime:control", "registration"), agents: false } });
    expect(await runner.run(humanOnly.operation, bot.context, input)).toMatchObject({ ok: false, error: { category: "forbidden", reason: "human_only" } });
    const both = fakeStart(world, { requirement: { require: allOf(onProject("runtime:control", "registration"), onProject("config:write", "registration")) } });
    expect(await runner.run(both.operation, bot.context, input)).toMatchObject({ ok: false, error: { category: "forbidden", reason: "permission_denied" } });
    expect([...humanOnly.log.effects, ...both.log.effects]).toEqual([]);
  });
});

describe("operation runner: outcome-safe errors", () => {
  it("reports busy only when execution never began", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    world.admission.onAdmit = event => { if (event.n === 1) throw admissionRefusal("busy"); };
    expect(await runner.run(operation, alice.context, input)).toEqual({ ok: false, error: {
      category: "busy", status: 503, reason: "admission_refused", retry: "retry", effect: "not_started" } });
    world.admission.events = [];
    world.admission.onAdmit = event => { if (event.n === 2) throw admissionRefusal("busy"); };
    expect(await runner.run(operation, alice.context, input)).toMatchObject({ ok: false, error: { category: "busy", effect: "not_started" } });
    expect(log.effects).toEqual([]);
  });

  it("never reports busy after the effect began", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world, {
      duringEffect: () => { world.admission.onAdmit = () => { throw admissionRefusal("busy"); }; },
    });
    const result = await runner.run(operation, alice.context, input);
    expect(log.effects).toEqual(["start project-a"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).not.toBe("busy");
    expect(result.error.retry).not.toBe("retry");
    expect(result.error).toMatchObject({ category: "unavailable", effect: "cleanup_unconfirmed", retry: "inspect_first" });
  });

  it("finalizes and reports outcome_unknown when an effect fails untyped", async () => {
    for (const shape of ["async", "sync"] as const) {
      const { world, alice, runner } = setup();
      const { operation, log } = fakeStart(world);
      const failing: typeof operation = { ...operation, effect: { mode: "idle", run: shape === "async"
        ? async () => { throw new Error("spawn failed after fork"); }
        : () => { throw new Error("thrown before a promise existed"); } } };
      expect(await runner.run(failing, alice.context, input)).toEqual({ ok: false, error: {
        category: "outcome_unknown", status: 409, reason: "effect_interrupted", retry: "inspect_first", effect: "unknown" } });
      expect(log.audit).toEqual(["failed"]);
      expect(log.lockHeld).toBe(false);
    }
  });

  it("keeps a typed effect failure that declares nothing started, without finalization", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    const refused: typeof operation = { ...operation, effect: { mode: "idle", run: async () => { throw new OperationError("conflict", "port_in_use", { effect: "not_started" }); } } };
    expect(await runner.run(refused, alice.context, input)).toMatchObject({ ok: false, error: { category: "conflict", reason: "port_in_use", effect: "not_started" } });
    expect(log.audit).toEqual([]);
  });

  it("reports unconfirmed cleanup when finalization fails", async () => {
    const { world, alice, runner } = setup();
    const { operation } = fakeStart(world, { finalizeThrows: true });
    expect(await runner.run(operation, alice.context, input)).toMatchObject({ ok: false, error: {
      category: "unavailable", reason: "finalization_unconfirmed", effect: "cleanup_unconfirmed", retry: "inspect_first" } });
  });

  it("refuses to release unlisted fields or the authentication context", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    const extra = { ...operation, project: (result: StartInternal) => ({ projectId: result.projectId, started: true, pid: result.pid }) };
    expect(await runner.run(extra, alice.context, input)).toMatchObject({ ok: false, error: { category: "internal", reason: "unlisted_public_field", effect: "committed" } });
    const leak = { ...operation, publicKeys: ["projectId", "started"] as const,
      project: () => ({ projectId: alice.context as unknown as ProjectId, started: true }) };
    const result = await runner.run(leak, alice.context, input);
    expect(result).toMatchObject({ ok: false, error: { category: "internal", effect: "committed" } });
    expect(log.audit).toEqual(["started 4242", "started 4242"]);
  });

  it("runs an admitted synchronous effect atomically with its final check", async () => {
    const { world, alice, runner } = setup();
    const writes: string[] = [];
    const { operation } = fakeStart(world);
    const write: typeof operation = { ...operation, acquire: undefined, effect: { mode: "admitted", run: (_input, scope) => {
      if (!world.admission.admitted) throw new Error("must be admitted");
      writes.push("row");
      return { projectId: scope.resources.registration.projectId, pid: 1, processSecret: "x" };
    } } };
    expect(await runner.run(write, alice.context, input)).toMatchObject({ ok: true });
    world.admission.events = [];
    world.admission.onAdmit = event => { if (event.n === 2) world.grants.revokeAll(alice.id); };
    expect(await runner.run(write, alice.context, input)).toMatchObject({ ok: false, error: { effect: "not_started" } });
    expect(writes).toEqual(["row"]);
  });

  it("maps unparseable input to invalid_request before any admission", async () => {
    const { world, alice, runner } = setup();
    const { operation } = fakeStart(world);
    const strict = { ...operation, parse: () => { throw new Error("bad"); } };
    expect(await runner.run(strict, alice.context, {})).toMatchObject({ ok: false, error: { category: "invalid_request", reason: "invalid_input", effect: "not_started" } });
    expect(world.admission.events).toEqual([]);
  });
});

interface ProjectEvent { projectId: ProjectId; seq: number; holderSession: string }

function fakeStream(world: ReturnType<typeof createWorld>, beforeEvent: (seq: number) => void) {
  const state = { disposed: false, produced: 0 };
  const events: ProjectEvent[] = [
    { projectId: projectA, seq: 1, holderSession: "s-x" }, { projectId: projectB, seq: 2, holderSession: "s-y" },
    { projectId: projectA, seq: 3, holderSession: "s-x" }, { projectId: projectA, seq: 4, holderSession: "s-x" },
    { projectId: projectA, seq: 5, holderSession: "s-x" },
  ];
  const operation: StreamOperation<{ projectId: string }, ProjectEvent, { seq: number; projectId: ProjectId }> = {
    id: "fixture.status_events",
    kind: "stream",
    requirement: { require: onProject("project:read", "project") },
    parse: raw => ({ projectId: String((raw as { projectId: string }).projectId) }),
    resources: input => ({ project: { kind: "project", id: input.projectId } }),
    async *open() {
      try {
        for (const event of events) {
          await Promise.resolve();
          beforeEvent(event.seq);
          state.produced++;
          yield event;
        }
      } finally { state.disposed = true; }
    },
    publicKeys: ["seq", "projectId"],
    projectEvent: (event, release) => release.can("project:read", event.projectId) ? { seq: event.seq, projectId: event.projectId } : null,
  };
  return { operation, state, world };
}

async function collect(iterable: AsyncIterable<StreamItem<{ seq: number }>>) {
  const items: unknown[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe("operation runner: streams", () => {
  async function open(context: AuthenticationContext, runner: OperationRunner, operation: ReturnType<typeof fakeStream>["operation"]) {
    const opened = await runner.stream(operation, context, { projectId: projectA });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    return opened.events;
  }

  it("authorizes and projects every event, filtering per item", async () => {
    const { world, alice, runner } = setup();
    const { operation, state } = fakeStream(world, () => undefined);
    expect(await collect(await open(alice.context, runner, operation))).toEqual([1, 3, 4, 5].map(seq => ({ event: { seq, projectId: projectA } })));
    expect(state.disposed).toBe(true);
  });

  it("ends with one error and disposes the source after revocation", async () => {
    for (const revoke of ["grants", "credential"] as const) {
      const { world, alice, runner } = setup();
      const { operation, state } = fakeStream(world, seq => {
        if (seq !== 4) return;
        if (revoke === "grants") world.grants.revokeAll(alice.id); else world.verifier.revoke("provider_session", alice.credentialId);
      });
      const items = await collect(await open(alice.context, runner, operation));
      expect(items.slice(0, 2)).toEqual([{ event: { seq: 1, projectId: projectA } }, { event: { seq: 3, projectId: projectA } }]);
      expect(items[2]).toMatchObject({ error: { category: revoke === "grants" ? "not_found" : "unauthenticated" } });
      expect(items).toHaveLength(3);
      expect(state.disposed).toBe(true);
      expect(state.produced).toBe(4);
      expect(JSON.stringify(items)).not.toMatch(/s-x|s-y|"seq":4/);
    }
  });

  it("refuses to open without authority and never opens the source", async () => {
    const { world, runner } = setup();
    const stranger = world.human("stranger");
    let opened = false;
    const { operation } = fakeStream(world, () => { opened = true; });
    expect(await runner.stream(operation, stranger.context, { projectId: projectA })).toMatchObject({ ok: false, error: { category: "not_found" } });
    expect(opened).toBe(false);
  });

  it("disposes the source when the consumer stops early", async () => {
    const { world, alice, runner } = setup();
    const { operation, state } = fakeStream(world, () => undefined);
    for await (const item of await open(alice.context, runner, operation)) { expect(item).toMatchObject({ event: { seq: 1 } }); break; }
    expect(state.disposed).toBe(true);
  });
});
