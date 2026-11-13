/**
 * Shared operation doubles for the runner tests. Test-only; not exported from
 * the module's public API.
 */
import type { DatabaseAdmission } from "@/server/database-admission";
import type { ProjectId } from "@/shared/contracts/operations";
import type { Lease, MutationOperation, PhaseScope, StreamOperation } from "./operation";
import { createWorld, MemoryIdempotency, P } from "./operations-fixture";
import { onProject, type OperationRequirement } from "./requirements";
import { OperationRunner, type StreamItem } from "./runner";

export const projectA = P("project-a");
export const projectB = P("project-b");
export const REGISTRATION = { kind: "registration" as const, id: "reg-1" };
export const input = { registrationId: REGISTRATION.id };
export const key = (idempotencyKey: string) => ({ idempotencyKey });

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
export const tick = () => new Promise(resolve => setTimeout(resolve, 0));

export interface StartInput { registrationId: string }
export interface StartInternal { projectId: ProjectId; pid: number; processSecret: string }
export type StartOperation = MutationOperation<StartInput, StartInternal, { projectId: ProjectId; started: boolean }>;

/**
 * Fake effect operation: waits for a project lock, starts a "process" (the
 * effect), finalizes with an audit record and owned-process bookkeeping.
 */
export function fakeStart(world: ReturnType<typeof createWorld>, hooks: {
  lockWait?: Promise<void>;
  duringEffect?: () => void;
  effect?: () => Promise<void> | void;
  requirement?: OperationRequirement;
  finalizeThrows?: boolean;
  releaseThrows?: boolean;
} = {}) {
  const log = { attempts: 0, effects: [] as string[], audit: [] as string[], lockHeld: false, lockReleases: 0 };
  const operation: StartOperation = {
    id: "fixture.runtime_start",
    kind: "mutation",
    requirement: hooks.requirement ?? { require: onProject("runtime:control", "registration") },
    parse: raw => ({ registrationId: String((raw as StartInput).registrationId) }),
    resources: input => ({ registration: { kind: "registration", id: input.registrationId } }),
    async acquire(): Promise<Lease> {
      await hooks.lockWait;
      log.lockHeld = true;
      return { release: () => { log.lockHeld = false; log.lockReleases++; if (hooks.releaseThrows) throw new Error("unlock failed /secret"); } };
    },
    effect: {
      mode: "idle",
      async run(_input: StartInput, scope: PhaseScope) {
        if (world.admission.admitted) throw new Error("The SQL-free effect must run outside admission.");
        log.attempts++;
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

export function setup() {
  const world = createWorld();
  world.resolver.addProject(projectA).addProject(projectB).put(REGISTRATION, projectA);
  const alice = world.human("alice");
  world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectA } });
  const idempotency = new MemoryIdempotency();
  const runner = new OperationRunner(world.runtime({ idempotency }));
  return { world, alice, runner, idempotency };
}

/** Admission whose fresh admissions wait for `open`, refusing like the real gate when aborted while waiting. */
export function gatedAdmission(world: ReturnType<typeof createWorld>) {
  const gate = deferred();
  const inner = world.admission;
  const admission: DatabaseAdmission = {
    run: async (operation, options) => {
      if (!inner.admitted) {
        await new Promise<void>((resolve, reject) => {
          const refuse = () => reject(Object.assign(new Error("cancelled"), { name: "ExclusiveConnectionError", code: "cancelled" }));
          if (options?.signal?.aborted) { refuse(); return; }
          options?.signal?.addEventListener("abort", refuse, { once: true });
          void gate.promise.then(() => resolve());
        });
      }
      return inner.run(operation, options);
    },
    detached: (operation, options) => inner.detached(operation, options),
    idle: (operation, options) => inner.idle(operation, options),
    tryRun: operation => inner.tryRun(operation),
    outside: operation => inner.outside(operation),
  };
  return { admission, open: gate.resolve };
}

export interface ProjectEvent { projectId: ProjectId; seq: number; holderSession: string }
export type EventOperation = StreamOperation<{ projectId: string }, ProjectEvent, { seq: number; projectId: ProjectId }>;

/** A stream over five events; `state.opens` counts calls of `open()` itself, not of the generator body. */
export function fakeStream(world: ReturnType<typeof createWorld>, beforeEvent: (seq: number) => void) {
  const state = { opens: 0, opened: false, disposed: false, produced: 0 };
  const events: ProjectEvent[] = [
    { projectId: projectA, seq: 1, holderSession: "s-x" }, { projectId: projectB, seq: 2, holderSession: "s-y" },
    { projectId: projectA, seq: 3, holderSession: "s-x" }, { projectId: projectA, seq: 4, holderSession: "s-x" },
    { projectId: projectA, seq: 5, holderSession: "s-x" },
  ];
  async function* generate(): AsyncGenerator<ProjectEvent> {
    state.opened = true;
    try {
      for (const event of events) {
        await Promise.resolve();
        beforeEvent(event.seq);
        state.produced++;
        yield event;
      }
    } finally { state.disposed = true; }
  }
  const operation: EventOperation = {
    id: "fixture.status_events",
    kind: "stream",
    requirement: { require: onProject("project:read", "project") },
    parse: raw => ({ projectId: String((raw as { projectId: string }).projectId) }),
    resources: input => ({ project: { kind: "project", id: input.projectId } }),
    open() { state.opens++; return generate(); },
    publicKeys: ["seq", "projectId"],
    projectEvent: (event, release) => release.can("project:read", event.projectId) ? { seq: event.seq, projectId: event.projectId } : null,
  };
  return { operation, state, world };
}

/** A stream over a hand-written iterator, for failure and abort cases. */
export function manualStream(iterator: Partial<AsyncIterator<ProjectEvent>> & { next: AsyncIterator<ProjectEvent>["next"] }, extra: { construct?: () => never } = {}): EventOperation {
  return {
    id: "fixture.manual_events",
    kind: "stream",
    requirement: { require: onProject("project:read", "project") },
    parse: raw => ({ projectId: String((raw as { projectId: string }).projectId) }),
    resources: input => ({ project: { kind: "project", id: input.projectId } }),
    open: () => ({ [Symbol.asyncIterator]: () => { if (extra.construct) extra.construct(); return iterator as AsyncIterator<ProjectEvent>; } }),
    publicKeys: ["seq", "projectId"],
    projectEvent: event => ({ seq: event.seq, projectId: event.projectId }),
  };
}

export async function collect(iterable: AsyncIterable<StreamItem<{ seq: number }>>) {
  const items: unknown[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

/** Collects unhandled rejections while `body` runs and for a few turns after it. */
export async function unhandledDuring(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => { seen.push(reason); };
  process.on("unhandledRejection", listener);
  try {
    await body();
    for (let index = 0; index < 5; index++) await tick();
  } finally {
    process.off("unhandledRejection", listener);
  }
  return seen;
}
