/**
 * Shared operation doubles for the runner tests. Test-only; not exported from
 * the module's public API.
 */
import type { DatabaseAdmission, DatabaseAdmissionOptions } from "@/server/database-admission";
import type { EffectState, ProjectId, PublicOperationError } from "@/shared/contracts/operations";
import type { AdmittedCommitScope, Lease, MutationOperation, PhaseScope, StreamOperation } from "./operation";
import { createWorld, MemoryIdempotency, P } from "./operations-fixture";
import { onProject, type OperationRequirement } from "./requirements";
import { OperationRunner, type MutationReleaseOptions, type StreamItem } from "./runner";

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
export interface StartInternal { projectId: ProjectId | null; pid: number; processSecret: string }
export type StartOperation = MutationOperation<StartInput, StartInternal, { projectId: ProjectId | null; started: boolean }>;

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
  /** Finalize written as an async function (decision W): it rejects or fulfils after an await. */
  finalizeAsync?: "reject" | "fulfil";
  /**
   * Lease release written as an async function (decision W). `lockReleases`
   * counts the call at once; the lock is freed only after an await, and only
   * when it fulfils.
   */
  releaseAsync?: "reject" | "fulfil";
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
      if (hooks.releaseAsync) {
        const outcome = hooks.releaseAsync;
        return { release: (async () => {
          log.lockReleases++;
          await Promise.resolve();
          if (outcome === "reject") throw new Error("async unlock failed /secret");
          log.lockHeld = false;
        }) as unknown as () => void };
      }
      return { release: () => { log.lockHeld = false; log.lockReleases++; if (hooks.releaseThrows) throw new Error("unlock failed /secret"); } };
    },
    effect: {
      mode: "idle",
      async run(_input: StartInput, scope: PhaseScope) {
        if (world.admission.admitted) throw new Error("The SQL-free effect must run outside admission.");
        log.attempts++;
        await hooks.effect?.();
        log.effects.push(`start ${scope.resources.registration.projectId ?? "(no project)"}`);
        hooks.duringEffect?.();
        return { projectId: scope.resources.registration.projectId, pid: 4242, processSecret: "pid-secret-token" };
      },
    },
    finalize: hooks.finalizeAsync
      ? (async (_input: StartInput, outcome: { ok: boolean }) => {
        await Promise.resolve();
        if (hooks.finalizeAsync === "reject") throw new Error("async audit failed /secret");
        log.audit.push(outcome.ok ? "started async" : "failed async");
      }) as unknown as StartOperation["finalize"]
      : (_input, outcome) => {
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

export interface WriteInput { n: number }
export interface WriteResult { n: number; projectId: ProjectId | null }
export type WriteOperation = MutationOperation<WriteInput, WriteResult, { value: number }>;

/**
 * An admitted write with a declared commit point (the shape `mutationRelease`
 * accepts). `before` runs before `commit()`, `after` past it; both may throw.
 * `counts.runs` counts handler invocations, `counts.inside` those that ran
 * inside admission.
 */
export function admittedWrite(world: ReturnType<typeof createWorld>, hooks: {
  before?: () => void; after?: () => void; finalize?: () => void; project?: (result: WriteResult) => { value: number };
} = {}) {
  const counts = { runs: 0, inside: 0, finalizes: 0, projections: 0 };
  const operation: WriteOperation = {
    id: "fixture.admitted_write", kind: "mutation",
    requirement: { require: onProject("runtime:control", "registration") },
    parse: raw => {
      const n = (raw as { n?: unknown } | null)?.n;
      if (typeof n !== "number") throw new Error("n must be a number");
      return { n };
    },
    resources: () => ({ registration: { ...REGISTRATION } }),
    effect: { mode: "admitted", commitPoint: "declared", run: (value: WriteInput, scope: AdmittedCommitScope) => {
      counts.runs++;
      if (world.admission.admitted) counts.inside++;
      hooks.before?.();
      scope.commit();
      hooks.after?.();
      return { n: value.n, projectId: scope.resources.registration.projectId };
    } },
    finalize: () => { counts.finalizes++; hooks.finalize?.(); },
    retain: true, publicKeys: ["value"],
    project: result => { counts.projections++; return hooks.project ? hooks.project(result) : { value: result.n }; },
  };
  return { operation, counts };
}

/** One write to the caller as `mutationRelease` made it: which callback, whether inside admission, during which admission. */
export interface DeliveryWrite { kind: "commit" | "refuse"; value: unknown; admitted: boolean; admission: number }

/**
 * Release options that record every write. `admitted` is the fixture
 * admission's flag at the moment of the write; `admission` is the number of
 * admissions entered so far, so a test names the phase that wrote.
 */
export function recordingDelivery<P>(world: ReturnType<typeof createWorld>, extra: Partial<MutationReleaseOptions<P>> = {}) {
  const writes: DeliveryWrite[] = [];
  const record = (kind: DeliveryWrite["kind"], value: unknown) => {
    writes.push({ kind, value, admitted: world.admission.admitted, admission: world.admission.events.filter(event => event.kind === "run").length });
  };
  const options: MutationReleaseOptions<P> = {
    eligible: () => true, connected: () => true, deadline: Number.MAX_SAFE_INTEGER,
    commit(value: P) { record("commit", value); },
    refuse(error: PublicOperationError) { record("refuse", error); },
    ...extra,
  };
  return { options, writes };
}

/** The five public fields of an answer. */
export const answer = (category: string, status: number, reason: string, retry: string, effect: EffectState | null): PublicOperationError =>
  ({ category, status, reason, retry, effect }) as PublicOperationError;

/** The state of the record a C5 retry meets: as left, edited to another state, or met with a different input. */
export type RecordVariant = "unknown" | "reserved" | "started" | "fingerprint" | "completed";
export const RECORD_VARIANTS: readonly RecordVariant[] = Object.freeze(["unknown", "reserved", "started", "fingerprint", "completed"]);
/** The record's answer to a caller who can still see the project the attempt was authorized against, after the move. */
export const RECORD_ANSWERS: Readonly<Record<RecordVariant, PublicOperationError>> = Object.freeze({
  unknown: answer("outcome_unknown", 409, "previous_attempt_outcome_unknown", "inspect_first", "unknown"),
  reserved: answer("conflict", 409, "request_in_progress", "none", "not_started"),
  started: answer("conflict", 409, "request_in_progress", "none", "not_started"),
  fingerprint: answer("conflict", 409, "idempotency_conflict", "none", "not_started"),
  completed: answer("conflict", 409, "resource_changed", "none", "not_started"),
});
/** The historical denial: project A, which the record names, is no longer visible. */
export const HISTORICAL_DENIAL = answer("not_found", 404, "resource_not_found", "none", "not_started");

/**
 * Amendment C5's arrangement, after one keyed attempt of `admittedWrite` on
 * project A left a `completed` record: puts the record in `variant`'s state,
 * moves the registration to project B, gives the caller B and, unless
 * `keepA`, takes A away. Clears the admission events and the store calls.
 * Returns the retry's input, a copy of the record and a reader of the record
 * as it is now.
 */
export function moveAfterRecord(state: ReturnType<typeof setup>, variant: RecordVariant, keepA: boolean) {
  const { world, alice, idempotency } = state;
  const [[storeKey, record]] = [...idempotency.entries];
  if (variant === "unknown" || variant === "reserved" || variant === "started") { record.state = variant; delete record.result; }
  world.resolver.move(REGISTRATION, projectB);
  world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectB } });
  if (!keepA) {
    world.grants.grants = world.grants.grants.filter(grant => grant.accountId !== alice.id || grant.scope.kind !== "project" || grant.scope.projectId !== projectA);
  }
  world.admission.events = [];
  idempotency.calls.length = 0;
  return { raw: { n: variant === "fingerprint" ? 2 : 1 }, stored: structuredClone(record), current: () => structuredClone(idempotency.entries.get(storeKey)) };
}

/**
 * An admission that can delay a fresh `run` before it reaches `inner`, to
 * arrange how two concurrent calls interleave. `hold` sees the call's options
 * and returns a promise to wait for, or nothing. The wait happens before
 * admission is requested, so it holds nothing of the gate.
 */
export function heldAdmission(inner: DatabaseAdmission, hold: (options: DatabaseAdmissionOptions | undefined) => Promise<unknown> | undefined): DatabaseAdmission {
  return {
    run: async (operation, options) => {
      const wait = hold(options);
      if (wait) await wait;
      return inner.run(operation, options);
    },
    detached: (operation, options) => inner.detached(operation, options),
    idle: (operation, options) => inner.idle(operation, options),
    tryRun: operation => inner.tryRun(operation),
    outside: operation => inner.outside(operation),
  };
}

/**
 * Two concurrent calls with one key, A and B, told apart by their signals
 * (never aborted). "in progress": B's phase 1 runs while A waits between its
 * phase 1 and its phase 3, so B meets A's reservation. "replay": B's phase 1
 * waits until A has returned, so B meets A's completed record. Pass `hold` to
 * `heldAdmission`, and call `settled.a` and `settled.b` when each call returns.
 */
export function interleaving(order: "in progress" | "replay") {
  const a = new AbortController(), b = new AbortController();
  const between = deferred(), aDone = deferred(), bDone = deferred();
  const counts = { a: 0, b: 0 };
  const hold = (options: DatabaseAdmissionOptions | undefined): Promise<unknown> | undefined => {
    if (options?.signal === a.signal && ++counts.a === 2 && order === "in progress") { between.resolve(); return bDone.promise; }
    if (options?.signal === b.signal && ++counts.b === 1) return order === "in progress" ? between.promise : aDone.promise;
    return undefined;
  };
  return { signals: { a: a.signal, b: b.signal }, hold, settled: { a: () => aDone.resolve(), b: () => bDone.resolve() } };
}
