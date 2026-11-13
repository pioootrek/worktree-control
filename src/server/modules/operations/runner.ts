import { randomUUID } from "node:crypto";
import { databaseAdmissionFailure, idleWithCompletion, type DatabaseAdmission } from "@/server/database-admission";
import type { EffectState, PublicOperationError } from "@/shared/contracts/operations";
import { currentAuthority, type AuthenticationContext, type CurrentAuthority } from "./authentication-context";
import { decide } from "./decide";
import { classify, OperationError } from "./errors";
import type { EffectivePermissions, GrantsSnapshot } from "./grants";
import type { EffectOutcome, Lease, MutationOperation, Operation, PhaseScope, ReadOperation, StreamOperation } from "./operation";
import { createReleaseContext, releaseError, releaseValue, type ReleaseContext } from "./release";
import { collectionPermissions, type OperationRequirement, type ResolvedResources, type ResourceRef } from "./requirements";
import { resolveAll, sameResolution, type ResourceResolver } from "./resolver";

/**
 * Identifies one idempotent request. `principal` is never caller-supplied:
 *
 * - a human or agent: `account:<accountId>`. Accounts never share a key space,
 *   so one account can never replay another's result;
 * - every installation caller: `installation`; every operator (unix or
 *   offline): `operator`. These actors are shared by all their callers and
 *   hold full authority over the same data, so their keys share one space per
 *   actor kind: the same key from two such callers is deduplicated (or is a
 *   fingerprint conflict) rather than executed twice.
 */
export interface IdempotencyKey { operationId: string; principal: string; idempotencyKey: string }

/**
 * - `reserved`: admitted, effect not begun (possibly waiting for a lock);
 * - `started`: the effect may have begun;
 * - `completed`: the effect committed and finalization succeeded; `result` holds the internal result;
 * - `unknown`: the effect's outcome is unknown or its cleanup is unconfirmed.
 */
export type IdempotencyState = "reserved" | "started" | "completed" | "unknown";

export interface IdempotencyRecord {
  /** Opaque ID of the attempt that owns a `reserved` or `started` record. */
  attempt: string;
  fingerprint: string;
  /** Resources resolved when the attempt was admitted (and, once started, when its effect was admitted). */
  resources: ResolvedResources;
  state: IdempotencyState;
  /** Internal result of a `completed` attempt. Must be structured-cloneable plain data. */
  result?: unknown;
}

/**
 * Admitted idempotency reservations. Every call happens inside an admitted
 * phase and is synchronous, so a read and the following write of one phase
 * are atomic against other requests. The adapter stores copies, never
 * references. Adapter obligations (not implemented in this slice): bound
 * retention; after a controller restart, delete `reserved` records (their
 * effect never began) and turn `started` records into `unknown`.
 */
export interface IdempotencyStore {
  get(key: IdempotencyKey): IdempotencyRecord | null;
  put(key: IdempotencyKey, record: IdempotencyRecord): void;
  /** Removes the record only if it still belongs to `attempt`. */
  release(key: IdempotencyKey, attempt: string): void;
}

/** Everything the runner needs besides the operation; injected by bootstrap or tests. */
export interface OperationRuntime {
  admission: DatabaseAdmission;
  resolver: ResourceResolver;
  /** Current active grants, read inside an admitted phase. */
  grants(): GrantsSnapshot;
  now(): number;
  idempotency?: IdempotencyStore;
  /** Bound for completing an effect that began and for finalization. Default 60 s. */
  completionDeadlineMs?: number;
  /** Bound for waiting on a stream source's disposal. Default 1 s; the source is never awaited longer. */
  disposeTimeoutMs?: number;
}

export interface RunOptions { signal?: AbortSignal; idempotencyKey?: string }
export type RunResult<T> = { ok: true; value: T; replayed: boolean } | { ok: false; error: PublicOperationError };
export type StreamItem<T> = { event: T } | { error: PublicOperationError };

interface Phase {
  authority: CurrentAuthority;
  resources: ResolvedResources;
  grants: GrantsSnapshot;
  permissions: EffectivePermissions;
  release: ReleaseContext;
  now: number;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

function cancelled(): OperationError { return new OperationError("unavailable", "request_cancelled", { retry: "retry" }); }
const began = (effect: EffectState | null) => effect !== null && effect !== "not_started";

/** An admission refused because the caller aborted is a cancellation, not contention. */
function failure(error: unknown, effect: EffectState | null, signal: AbortSignal | undefined): PublicOperationError {
  const cause = signal?.aborted && !began(effect) && databaseAdmissionFailure(error) ? cancelled() : error;
  return releaseError(classify(cause, effect).toPublic());
}

function principalKey(authority: CurrentAuthority): string {
  const actor = authority.actor;
  if (actor.kind === "human" || actor.kind === "agent") return `account:${actor.accountId}`;
  return actor.kind;
}

function fingerprint(input: unknown): string {
  return JSON.stringify(input, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : 1))) : value) ?? "undefined";
}

function isLease(value: unknown): value is Lease {
  return typeof value === "object" && value !== null && typeof (value as { release?: unknown }).release === "function";
}

function isThenable(value: unknown): boolean {
  return (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/** Settles with the promise, or with `null` once the signal aborts. */
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<{ value: T } | null> {
  if (signal.aborted) { promise.catch(() => undefined); return Promise.resolve(null); }
  return new Promise((resolve, reject) => {
    const onAbort = () => { promise.catch(() => undefined); resolve(null); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", onAbort); resolve({ value }); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

/**
 * Executes operations as admitted phases. Each phase revalidates the
 * authentication context, re-resolves every resource and re-runs the full
 * decision; nothing from an earlier phase authorizes a later one. Only
 * contexts minted by this module are accepted.
 */
export class OperationRunner {
  constructor(private readonly runtime: OperationRuntime) {}

  private get deadline(): number { return this.runtime.completionDeadlineMs ?? 60_000; }

  /** Must run inside an admitted phase. Throws a typed denial. */
  private admit(context: AuthenticationContext, requirement: OperationRequirement, refs: Readonly<Record<string, ResourceRef>>): Phase {
    const authority = currentAuthority(context);
    const resources = resolveAll(this.runtime.resolver, refs);
    const now = this.runtime.now();
    const grants = this.runtime.grants();
    const decision = decide({ authority, requirement, resources, grants, now });
    if (!decision.allowed) throw new OperationError(decision.category, decision.reason);
    const release = createReleaseContext(authority, decision.permissions, resources, collectionPermissions(requirement.require));
    return { authority, resources, grants, permissions: decision.permissions, now, release };
  }

  private scope(phase: Phase, signal: AbortSignal | undefined): PhaseScope {
    return { authority: phase.authority, resources: phase.resources, release: phase.release, resolver: this.runtime.resolver, now: phase.now, signal };
  }

  private parse<I>(parse: (raw: unknown) => I, raw: unknown): I {
    try { return parse(raw); } catch (error) {
      if (error instanceof OperationError && error.category === "invalid_request") throw error;
      throw new OperationError("invalid_request", "invalid_input", { cause: error });
    }
  }

  /** Idempotency keys are accepted only by mutations that declare `retain`. */
  private idempotency(retain: boolean, key: string | undefined): IdempotencyStore | null {
    if (key === undefined) return null;
    if (!retain) throw new OperationError("invalid_request", "idempotency_not_supported");
    if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) throw new OperationError("invalid_request", "invalid_idempotency_key");
    const store = this.runtime.idempotency;
    if (!store) throw new OperationError("unavailable", "idempotency_unavailable");
    return store;
  }

  /**
   * Replay is a release of historical data: decided against the resources
   * resolved when the result was retained, and only while the current
   * resolution is unchanged.
   */
  private replay<I, R, P extends object>(operation: MutationOperation<I, R, P>, phase: Phase, record: IdempotencyRecord): P {
    const historical = record.resources;
    const decision = decide({ authority: phase.authority, requirement: operation.requirement, resources: historical, grants: phase.grants, now: phase.now });
    if (!decision.allowed) throw new OperationError(decision.category, decision.reason);
    if (!sameResolution(historical, phase.resources)) throw new OperationError("conflict", "resource_changed");
    const release = createReleaseContext(phase.authority, decision.permissions, historical, collectionPermissions(operation.requirement.require));
    return releaseValue<P>(operation.project(record.result as R, release), operation.publicKeys);
  }

  async run<I, R, P extends object>(operation: Operation<I, R, P>, context: AuthenticationContext, raw: unknown, options: RunOptions = {}): Promise<RunResult<P>> {
    if (operation.kind === "read") return this.read(operation, context, raw, options);
    return this.mutate(operation, context, raw, options);
  }

  private async read<I, R, P extends object>(operation: ReadOperation<I, R, P>, context: AuthenticationContext, raw: unknown, options: RunOptions): Promise<RunResult<P>> {
    const { signal } = options;
    try {
      this.idempotency(false, options.idempotencyKey);
      const input = this.parse(operation.parse, raw);
      const refs = operation.resources(input);
      const value = await this.runtime.admission.run(() => {
        const phase = this.admit(context, operation.requirement, refs);
        return releaseValue<P>(operation.project(operation.read(input, this.scope(phase, signal)), phase.release), operation.publicKeys);
      }, { signal });
      return { ok: true, value, replayed: false };
    } catch (error) {
      return { ok: false, error: failure(error, null, signal) };
    }
  }

  private async mutate<I, R, P extends object>(operation: MutationOperation<I, R, P>, context: AuthenticationContext, raw: unknown, options: RunOptions): Promise<RunResult<P>> {
    const { admission } = this.runtime;
    const { signal, idempotencyKey } = options;
    // Mutable holder: closures below update it, and TypeScript must not narrow it.
    const state: {
      effect: EffectState;
      outcome?: EffectOutcome<R>;
      lease?: Lease;
      reservation?: { store: IdempotencyStore; key: IdempotencyKey; attempt: string; fingerprint: string };
    } = { effect: "not_started" };
    const releaseLease = () => {
      const lease = state.lease;
      state.lease = undefined;
      if (!lease) return;
      try { lease.release(); } catch {
        if (state.effect === "committed") state.effect = "cleanup_unconfirmed";
      }
    };
    try {
      const store = this.idempotency(operation.retain === true, idempotencyKey);
      const input = this.parse(operation.parse, raw);
      const refs = operation.resources(input);
      const print = store ? fingerprint(input) : "";

      // 1. Admission: authority, resources, requirement; the idempotency reservation or a replay.
      const first = await admission.run(() => {
        const phase = this.admit(context, operation.requirement, refs);
        if (store && idempotencyKey !== undefined) {
          const key: IdempotencyKey = { operationId: operation.id, principal: principalKey(phase.authority), idempotencyKey };
          const record = store.get(key);
          if (record) {
            if (record.fingerprint !== print) throw new OperationError("conflict", "idempotency_conflict");
            if (record.state === "completed") return { kind: "replay" as const, value: this.replay(operation, phase, record) };
            if (record.state === "unknown") throw new OperationError("outcome_unknown", "previous_attempt_outcome_unknown", { effect: "unknown" });
            throw new OperationError("conflict", "request_in_progress");
          }
          const attempt = randomUUID();
          store.put(key, { attempt, fingerprint: print, resources: phase.resources, state: "reserved" });
          state.reservation = { store, key, attempt, fingerprint: print };
        }
        return { kind: "fresh" as const, phase };
      }, { signal });
      if (first.kind === "replay") return { ok: true, value: first.value, replayed: true };
      const initial = first.phase;

      // 2. Optional SQL-free wait (for example a project lock) outside admission.
      //    Ownership is recorded the moment the acquire resolves, inside the
      //    callback, so a failed re-admission still releases it exactly once.
      if (operation.acquire) {
        const acquire = operation.acquire.bind(operation);
        await admission.idle(async () => {
          const lease = await acquire(input, signal);
          if (!isLease(lease)) throw new OperationError("internal", "invalid_lease");
          state.lease = lease;
        });
      }
      if (signal?.aborted) throw cancelled();

      // 3. Recheck, then exactly one bounded effect. From here the effect may have begun.
      let effectResources: ResolvedResources = initial.resources;
      const settle = (value: R) => { state.outcome = { ok: true, value }; state.effect = "committed"; return value; };
      // Whatever an effect throws, the runner observed it start and cannot know how far it got.
      const fail = (error: unknown): never => { state.outcome = { ok: false, error }; state.effect = "unknown"; throw error; };
      try {
        await admission.run(async () => {
          const phase = this.admit(context, operation.requirement, refs);
          if (!sameResolution(initial.resources, phase.resources)) throw new OperationError("conflict", "resource_changed");
          if (signal?.aborted) throw cancelled();
          effectResources = phase.resources;
          const reservation = state.reservation;
          if (reservation) {
            reservation.store.put(reservation.key, { attempt: reservation.attempt, fingerprint: reservation.fingerprint, resources: phase.resources, state: "started" });
          }
          const scope = this.scope(phase, signal);
          const run = operation.effect;
          if (run.mode === "admitted") {
            state.effect = "unknown";
            try {
              const value = run.run(input, scope);
              if (isThenable(value)) throw new TypeError("An admitted effect must be synchronous.");
              settle(value);
            } catch (error) { fail(error); }
          } else {
            await idleWithCompletion(admission, async () => {
              state.effect = "unknown";
              try { return settle(await run.run(input, scope)); } catch (error) { return fail(error); }
            }, { deadlineMs: this.deadline });
          }
        }, { signal });
      } catch (error) {
        // A refused re-admission after a settled effect does not hide its outcome.
        if (!state.outcome) throw error;
      }
      const settled = state.outcome;
      if (!settled) throw new OperationError("internal", "effect_not_settled");

      // 4. Mandatory completion of an effect that began: finalization and the
      //    idempotency record, under reserved admission, without an authority check.
      const reservation = state.reservation;
      if (state.effect !== "not_started" && (operation.finalize || reservation)) {
        try {
          await this.complete(() => {
            let finalizeError: { error: unknown } | null = null;
            try { operation.finalize?.(input, settled, { resources: effectResources }); } catch (error) { finalizeError = { error }; }
            if (reservation) {
              const base = { attempt: reservation.attempt, fingerprint: reservation.fingerprint, resources: effectResources };
              reservation.store.put(reservation.key, settled.ok && !finalizeError
                ? { ...base, state: "completed", result: settled.value } : { ...base, state: "unknown" });
            }
            if (finalizeError) throw finalizeError.error;
          });
        } catch {
          if (state.effect === "committed") state.effect = "cleanup_unconfirmed";
        }
      }
      releaseLease();

      // 5. Release only after a fresh decision on current authority and resources.
      const value = await admission.run(() => {
        const phase = this.admit(context, operation.requirement, refs);
        if (!sameResolution(effectResources, phase.resources)) throw new OperationError("conflict", "resource_changed");
        if (state.effect === "cleanup_unconfirmed") throw new OperationError("unavailable", "finalization_unconfirmed", { effect: state.effect });
        if (!settled.ok) throw settled.error;
        return releaseValue<P>(operation.project(settled.value, phase.release), operation.publicKeys);
      }, { reserved: true });
      return { ok: true, value, replayed: false };
    } catch (error) {
      return { ok: false, error: failure(error, state.effect, signal) };
    } finally {
      releaseLease();
      // An attempt that never began its effect gives its reservation back, so a retry runs fresh.
      const reservation = state.reservation;
      if (reservation && state.effect === "not_started") {
        try { await this.complete(() => reservation.store.release(reservation.key, reservation.attempt)); } catch {
          // The reservation stays; later requests see `request_in_progress` until the adapter clears it.
        }
      }
    }
  }

  /** Reserved admission, retried only while refused before the operation ran. */
  private async complete(operation: () => void): Promise<void> {
    const deadline = Date.now() + this.deadline;
    for (let delay = 10; ; delay = Math.min(delay * 2, 500)) {
      let ran = false;
      try {
        await this.runtime.admission.run(() => { ran = true; operation(); }, { reserved: true });
        return;
      } catch (error) {
        if (ran || !databaseAdmissionFailure(error)?.retryable || Date.now() + delay > deadline) throw error;
      }
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); timer.unref?.(); });
    }
  }

  /**
   * Opens a stream after an admitted decision. Each event is awaited outside
   * admission, then authorized and projected in its own admitted phase.
   *
   * - Construction, `next()` and projection failures end the stream with one
   *   sanitized error item; a denial ends it with one error item.
   * - Abort of `signal` (or `return()` by the consumer) settles a pending read
   *   at once, ends the stream and disposes the source exactly once; no event
   *   is projected or yielded after abort or after a denial.
   * - Disposal (`return()` of the source) is awaited at most
   *   `disposeTimeoutMs`; its failure never replaces or follows a denial.
   */
  async stream<I, E, P extends object>(operation: StreamOperation<I, E, P>, context: AuthenticationContext, raw: unknown, options: RunOptions = {}): Promise<{ ok: true; events: AsyncIterableIterator<StreamItem<P>> } | { ok: false; error: PublicOperationError }> {
    const { admission } = this.runtime;
    const { signal } = options;
    const disposeTimeoutMs = this.runtime.disposeTimeoutMs ?? 1_000;
    let opened: { refs: Readonly<Record<string, ResourceRef>>; phase: Phase; iterator: AsyncIterator<E> };
    try {
      this.idempotency(false, options.idempotencyKey);
      const input = this.parse(operation.parse, raw);
      const refs = operation.resources(input);
      opened = await admission.run(() => {
        const phase = this.admit(context, operation.requirement, refs);
        const source = operation.open(input, this.scope(phase, signal));
        const iterator = source[Symbol.asyncIterator]();
        if (typeof iterator !== "object" || iterator === null || typeof iterator.next !== "function") throw new OperationError("internal", "invalid_stream");
        return { refs, phase, iterator };
      }, { signal });
    } catch (error) {
      return { ok: false, error: failure(error, null, signal) };
    }
    if (signal?.aborted) {
      void Promise.resolve().then(() => opened.iterator.return?.()).catch(() => undefined);
      return { ok: false, error: failure(cancelled(), null, signal) };
    }

    const { iterator, refs } = opened;
    const stop = new AbortController();
    const done = (): IteratorResult<StreamItem<P>> => ({ done: true, value: undefined });
    let finished = false;
    let disposal: Promise<void> | null = null;
    const dispose = (): Promise<void> => {
      if (disposal) return disposal;
      let pending: Promise<unknown>;
      try { pending = Promise.resolve(iterator.return?.()); } catch { pending = Promise.resolve(); }
      disposal = new Promise<void>(resolve => {
        const timer = setTimeout(resolve, disposeTimeoutMs);
        timer.unref?.();
        pending.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
      });
      return disposal;
    };
    const end = async (): Promise<IteratorResult<StreamItem<P>>> => {
      finished = true;
      stop.abort();
      signal?.removeEventListener("abort", onAbort);
      await dispose();
      return done();
    };
    const fault = async (error: unknown): Promise<IteratorResult<StreamItem<P>>> => {
      const item: StreamItem<P> = { error: failure(error, null, undefined) };
      await end();
      return { done: false, value: item };
    };
    const onAbort = () => { if (!finished) void end(); };
    signal?.addEventListener("abort", onAbort, { once: true });

    const step = async (): Promise<IteratorResult<StreamItem<P>>> => {
      for (;;) {
        if (finished) return done();
        if (stop.signal.aborted || signal?.aborted) return end();
        let next: IteratorResult<E>;
        try {
          const read = await untilAbort(admission.idle(() => Promise.resolve().then(() => iterator.next())), stop.signal);
          if (!read || finished) return end();
          next = read.value;
        } catch (error) {
          if (finished || stop.signal.aborted) return end();
          return fault(error);
        }
        if (typeof next !== "object" || next === null) return fault(new OperationError("internal", "invalid_stream"));
        if (next.done) {
          // The source finished by itself: nothing to dispose.
          finished = true;
          disposal ??= Promise.resolve();
          stop.abort();
          signal?.removeEventListener("abort", onAbort);
          return done();
        }
        let item: P | null;
        try {
          item = await admission.run(() => {
            if (finished || stop.signal.aborted) return null;
            const phase = this.admit(context, operation.requirement, refs);
            if (!sameResolution(opened.phase.resources, phase.resources)) throw new OperationError("conflict", "resource_changed");
            const projected = operation.projectEvent(next.value, phase.release);
            return projected === null ? null : releaseValue<P>(projected, operation.publicKeys);
          }, { signal: stop.signal });
        } catch (error) {
          if (finished || stop.signal.aborted) return end();
          return fault(error);
        }
        if (finished || stop.signal.aborted) return end();
        if (item !== null) return { done: false, value: { event: item } };
      }
    };

    let queue: Promise<unknown> = Promise.resolve();
    const events: AsyncIterableIterator<StreamItem<P>> = {
      next: () => {
        const result = queue.then(step, step);
        queue = result.catch(() => undefined);
        return result;
      },
      return: async () => {
        if (!finished) return end();
        await disposal;
        return done();
      },
      [Symbol.asyncIterator]() { return this; },
    };
    return { ok: true, events };
  }
}
