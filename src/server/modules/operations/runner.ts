import { randomUUID } from "node:crypto";
import { idleWithCompletion, type DatabaseAdmission } from "@/server/database-admission";
import type { EffectState, PublicOperationError } from "@/shared/contracts/operations";
import { currentAuthority, type AuthenticationContext, type CurrentAuthority } from "./authentication-context";
import { decideWith } from "./decide";
import { admissionFailureOf, classifyBeforeCommit, OperationError, publicError } from "./errors";
import { effectivePermissions, type EffectivePermissions, type GrantsSnapshot } from "./grants";
import type { EffectOutcome, Lease, MutationOperation, Operation, PhaseScope, ReadOperation, StreamOperation } from "./operation";
import { canonicalJson, createReleaseContext, releaseError, releaseValue, serializeRelease, type ReleaseContext } from "./release";
import { collectionPermissions, type OperationRequirement, type ResolvedResources, type ResourceRef } from "./requirements";
import { copyResolution, resolveAll, sameResolution, type ResourceResolver } from "./resolver";
import { absorb, isThenable, synchronous } from "./synchronous";

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
 * - `reserved`: admitted, effect not begun (possibly waiting for a lock, or a
 *   handler before its declared commit point);
 * - `started`: the handler crossed its commit point; the effect may have begun;
 * - `completed`: the effect committed and finalization succeeded; `result` holds the internal result;
 * - `unknown`: the effect's outcome is unknown or its cleanup is unconfirmed.
 */
export type IdempotencyState = "reserved" | "started" | "completed" | "unknown";

export interface IdempotencyRecord {
  /** Opaque ID of the attempt that owns a `reserved` or `started` record. */
  attempt: string;
  fingerprint: string;
  /** Resources resolved when the attempt was admitted (and, once started, at its commit point). */
  resources: ResolvedResources;
  state: IdempotencyState;
  /** Internal result of a `completed` attempt. Must be structured-cloneable plain data. */
  result?: unknown;
}

/**
 * Admitted idempotency reservations. Every call happens inside an admitted
 * phase and is synchronous, so a read and the following write of one phase
 * are atomic against other requests. A call that returns a promise or other
 * thenable is a failed call (decision W): its rejection is absorbed and the
 * runner proceeds as if the call had thrown. The adapter stores copies, never
 * references; the runner validates and copies every record it reads back
 * (a malformed record is `internal`/`invalid_idempotency_record`). Adapter obligations (not implemented in this slice): bound
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
/** Receives failures the caller is not told about in detail. Calls are guarded; a throwing observer changes nothing. */
export interface OperationObserver {
  /**
   * Disposal (`return()`) of a stream source rejected, threw or did not settle
   * within `disposeTimeoutMs`. Reported for every disposal, whoever ended the
   * stream. Carries no thrown value.
   */
  streamDisposalFailed(event: Readonly<{ operationId: string; kind: "rejected" | "timed_out" }>): void;
}

/** Everything the runner needs besides the operation; injected by bootstrap or tests. */
export interface OperationRuntime {
  admission: DatabaseAdmission;
  resolver: ResourceResolver;
  /** Current active grants, read inside an admitted phase. */
  grants(): GrantsSnapshot;
  now(): number;
  idempotency?: IdempotencyStore;
  observer: OperationObserver;
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
  /** Computed before resolution; every later decision of this phase reuses it and reads no adapter. */
  permissions: EffectivePermissions;
  release: ReleaseContext;
  now: number;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const RECORD_STATES: readonly string[] = Object.freeze(["reserved", "started", "completed", "unknown"]);

function cancelled(): OperationError { return new OperationError("unavailable", "request_cancelled", { retry: "retry" }); }
const began = (effect: EffectState | null) => effect !== null && effect !== "not_started";

/** An admission refused because the caller aborted is a cancellation, not contention. Never throws. */
function cancellationOr(error: unknown, effect: EffectState | null, signal: AbortSignal | undefined): unknown {
  try { return signal?.aborted && !began(effect) && admissionFailureOf(error) ? cancelled() : error; } catch { return error; }
}

/**
 * The released form of anything thrown. Total (decision S): no method of the
 * thrown value is called and no accessor is read outside a guard, and the
 * result is always a well-formed public error.
 */
function failure(error: unknown, effect: EffectState | null, signal: AbortSignal | undefined): PublicOperationError {
  try { return releaseError(publicError(cancellationOr(error, effect, signal), effect)); } catch {
    return releaseError({ effect });
  }
}

function principalKey(authority: CurrentAuthority): string {
  const actor = authority.actor;
  if (actor.kind === "human" || actor.kind === "agent") return `account:${actor.accountId}`;
  return actor.kind;
}

function isLease(value: unknown): value is Lease {
  return typeof value === "object" && value !== null && typeof (value as { release?: unknown }).release === "function";
}

/** Settles with the promise, or with `null` once the signal aborts. A late rejection is always handled. */
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<{ value: T } | null> {
  if (signal.aborted) { promise.catch(() => undefined); return Promise.resolve(null); }
  return new Promise((resolve, reject) => {
    const onAbort = () => { promise.catch(() => undefined); resolve(null); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", onAbort); resolve({ value }); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

type CommitPoint = "entry" | "declared";
interface EffectPlan { mode: "admitted" | "idle"; commitPoint: CommitPoint; run: (input: unknown, scope: PhaseScope) => unknown }

/** Reads an operation's effect once and validates it. Fixed by the definition, never by the handler's behaviour. */
function effectPlan(effect: unknown): EffectPlan {
  if (typeof effect !== "object" || effect === null) throw new OperationError("internal", "invalid_operation");
  const { mode, commitPoint, run } = effect as Record<string, unknown>;
  if ((mode !== "admitted" && mode !== "idle") || (commitPoint !== undefined && commitPoint !== "entry" && commitPoint !== "declared")
    || typeof run !== "function") throw new OperationError("internal", "invalid_operation");
  return { mode, commitPoint: commitPoint ?? "entry", run: (input, scope) => (run as (i: unknown, s: PhaseScope) => unknown).call(effect, input, scope) };
}

/** Validated copy of a record read back from the store; `null` for none. Throws `internal` when malformed. */
function readRecord(value: unknown): IdempotencyRecord | null {
  if (value === null || value === undefined) return null;
  const malformed = () => new OperationError("internal", "invalid_idempotency_record");
  if (typeof value !== "object") throw malformed();
  const source = value as Record<string, unknown>;
  const { attempt, fingerprint, state } = source;
  const resources = copyResolution(source.resources);
  if (typeof attempt !== "string" || typeof fingerprint !== "string" || typeof state !== "string" || !RECORD_STATES.includes(state) || !resources) {
    throw malformed();
  }
  return { attempt, fingerprint, state: state as IdempotencyState, resources, ...(state === "completed" ? { result: source.result } : {}) };
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

  /**
   * Must run inside an admitted phase. Throws a typed denial.
   *
   * Decision Y: everything that can fail independently of the referenced
   * resources runs first: authority revalidation, the clock, the grants
   * snapshot and the effective permissions (every `GrantsSnapshot` call).
   * Only then are the references resolved, so a fault before resolution gives
   * the same answer whatever exists. After resolution only the pure
   * `decideWith` runs before the answer; a denial is one of its answers.
   */
  private admit(context: AuthenticationContext, requirement: OperationRequirement, refs: Readonly<Record<string, ResourceRef>>): Phase {
    const authority = currentAuthority(context);
    const now = synchronous(this.runtime.now(), "runtime_not_synchronous");
    const grants: GrantsSnapshot = synchronous(this.runtime.grants(), "runtime_not_synchronous");
    const permissions = effectivePermissions(authority.actor, grants);
    const resources = resolveAll(this.runtime.resolver, refs);
    const decision = decideWith({ authority, requirement, resources, permissions, now });
    if (!decision.allowed) throw new OperationError(decision.category, decision.reason);
    const release = createReleaseContext(authority, decision.permissions, resources, collectionPermissions(requirement.require));
    return { authority, resources, permissions: decision.permissions, now, release };
  }

  /** A fresh decision that also requires an unchanged resolution and no abort. Must run inside an admitted phase. */
  private recheck(context: AuthenticationContext, requirement: OperationRequirement, refs: Readonly<Record<string, ResourceRef>>,
    expected: ResolvedResources, signal: AbortSignal | undefined): Phase {
    const phase = this.admit(context, requirement, refs);
    if (!sameResolution(expected, phase.resources)) throw new OperationError("conflict", "resource_changed");
    if (signal?.aborted) throw cancelled();
    return phase;
  }

  private scope(phase: Phase, signal: AbortSignal | undefined): PhaseScope {
    return { authority: phase.authority, resources: phase.resources, release: phase.release, resolver: this.runtime.resolver, now: phase.now, signal };
  }

  /** A thrown value is `invalid_request`; a thenable is a broken definition, `internal`/`parse_not_synchronous`. */
  private parse<I>(parse: (raw: unknown) => I, raw: unknown): I {
    let input: I;
    try { input = parse(raw); } catch (error) {
      const typed = classifyBeforeCommit(error);
      throw new OperationError("invalid_request", typed.category === "invalid_request" ? typed.reason : "invalid_input");
    }
    return synchronous(input, "parse_not_synchronous");
  }

  /** The operation's references, from a synchronous `resources(input)`. */
  private references<I>(operation: { resources(input: I): Readonly<Record<string, ResourceRef>> }, input: I): Readonly<Record<string, ResourceRef>> {
    return synchronous(operation.resources(input), "resources_not_synchronous");
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
   * resolution is unchanged. Runs after `admit` allowed the current
   * resolution; the historical decision reuses that phase's permissions and
   * calls no adapter (decision Y).
   */
  private replay<I, R, P extends object>(operation: MutationOperation<I, R, P>, phase: Phase, record: IdempotencyRecord): P {
    const historical = record.resources;
    const decision = decideWith({ authority: phase.authority, requirement: operation.requirement, resources: historical, permissions: phase.permissions, now: phase.now });
    if (!decision.allowed) throw new OperationError(decision.category, decision.reason);
    if (!sameResolution(historical, phase.resources)) throw new OperationError("conflict", "resource_changed");
    const release = createReleaseContext(phase.authority, decision.permissions, historical, collectionPermissions(operation.requirement.require));
    return releaseValue<P>(synchronous(operation.project(record.result as R, release), "projection_not_synchronous"), operation.publicKeys);
  }

  async run<I, R, P extends object>(operation: Operation<I, R, P>, context: AuthenticationContext, raw: unknown, options: RunOptions = {}): Promise<RunResult<P>> {
    try {
      if (operation.kind === "read") return await this.read(operation, context, raw, options);
      return await this.mutate(operation, context, raw, options);
    } catch (error) {
      // Unreachable by design: both paths return an envelope. Kept so `run` can never reject.
      return { ok: false, error: failure(error, null, undefined) };
    }
  }

  private async read<I, R, P extends object>(operation: ReadOperation<I, R, P>, context: AuthenticationContext, raw: unknown, options: RunOptions): Promise<RunResult<P>> {
    const { signal } = options;
    try {
      this.idempotency(false, options.idempotencyKey);
      const input = this.parse(operation.parse, raw);
      const refs = this.references(operation, input);
      const value = await this.runtime.admission.run(() => {
        const phase = this.admit(context, operation.requirement, refs);
        const result = operation.read(input, this.scope(phase, signal));
        if (isThenable(result)) { absorb(result); throw new OperationError("internal", "read_not_synchronous"); }
        return releaseValue<P>(synchronous(operation.project(result, phase.release), "projection_not_synchronous"), operation.publicKeys);
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
      /**
       * This attempt's final record (decision Z). `pending` until the
       * completion callback writes it; `written` once a final state
       * (`completed` or `unknown`) was confirmed; `unconfirmed` when that
       * callback's write and its repair both failed, which leaves the record
       * to the store adapter. Only `pending` lets `finally` write.
       */
      final: "pending" | "written" | "unconfirmed";
      /** Resources of the phase that admitted the effect (its commit point). */
      resources?: ResolvedResources;
    } = { effect: "not_started", final: "pending" };
    /**
     * Releases a held lease exactly once. `false` when the release threw or
     * returned a thenable (decision W): its rejection is absorbed and the
     * release counts as unconfirmed, never as done.
     */
    const releaseLease = (): boolean => {
      const lease = state.lease;
      state.lease = undefined;
      if (!lease) return true;
      try { synchronous(lease.release(), "lease_release_not_synchronous"); return true; } catch {
        if (state.effect === "committed") state.effect = "cleanup_unconfirmed";
        return false;
      }
    };
    const finalRecord = (status: "completed" | "unknown", resources: ResolvedResources, result?: unknown): IdempotencyRecord => {
      const reservation = state.reservation!;
      return { attempt: reservation.attempt, fingerprint: reservation.fingerprint, resources, state: status, ...(status === "completed" ? { result } : {}) };
    };
    try {
      const plan = effectPlan(operation.effect);
      const store = this.idempotency(operation.retain === true, idempotencyKey);
      // Decision V: an operation that declares retention accepts JSON-domain input only, with or
      // without a key; `parse` sees its canonical copy and the fingerprint is its canonical text.
      let source: unknown = raw, print = "";
      if (operation.retain === true) {
        try { source = serializeRelease(raw); print = canonicalJson(source); } catch { throw new OperationError("invalid_request", "invalid_input"); }
      }
      const input = this.parse(operation.parse, source);
      const refs = this.references(operation, input);

      // 1. Admission: authority, resources, requirement; the idempotency reservation or a replay.
      const first = await admission.run(() => {
        const phase = this.admit(context, operation.requirement, refs);
        if (store && idempotencyKey !== undefined) {
          const key: IdempotencyKey = Object.freeze({ operationId: operation.id, principal: principalKey(phase.authority), idempotencyKey });
          const record = readRecord(synchronous(store.get({ ...key }), "idempotency_store_not_synchronous"));
          if (record) {
            if (record.fingerprint !== print) throw new OperationError("conflict", "idempotency_conflict");
            if (record.state === "completed") return { kind: "replay" as const, value: this.replay(operation, phase, record) };
            if (record.state === "unknown") throw new OperationError("outcome_unknown", "previous_attempt_outcome_unknown", { effect: "unknown" });
            throw new OperationError("conflict", "request_in_progress");
          }
          const attempt = randomUUID();
          // Owned before the write: a write that lands and then throws is still given back in `finally`.
          state.reservation = { store, key, attempt, fingerprint: print };
          synchronous(store.put({ ...key }, { attempt, fingerprint: print, resources: phase.resources, state: "reserved" }), "idempotency_store_not_synchronous");
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

      // 3. Recheck, then exactly one bounded effect with its commit point (decision N).
      state.resources = initial.resources;
      const crossing: { crossed: boolean; closed: boolean; refusal: OperationError | null; pending: Promise<void> | null } =
        { crossed: false, closed: false, refusal: null, pending: null };
      /**
       * The only place the commit point is crossed. Callers run it inside an
       * admitted phase, directly after that phase's fresh decision: the
       * record becomes `started` and the effect state `unknown`.
       */
      const cross = (resources: ResolvedResources) => {
        const reservation = state.reservation;
        if (reservation) {
          synchronous(reservation.store.put({ ...reservation.key }, { attempt: reservation.attempt, fingerprint: reservation.fingerprint, resources, state: "started" }),
            "idempotency_store_not_synchronous");
        }
        state.resources = resources;
        state.effect = "unknown";
        crossing.crossed = true;
      };
      const settle = (value: R) => {
        crossing.closed = true;
        if (!crossing.crossed) {
          // A declared handler that settles without its commit point: the runner cannot know what it did.
          state.effect = "unknown";
          state.outcome = { ok: false, error: new OperationError("internal", "commit_point_not_declared", { effect: "unknown" }) };
          return;
        }
        state.outcome = { ok: true, value };
        state.effect = "committed";
      };
      /** Past the commit point anything thrown is an unknown outcome; before it, a refusal that never began. */
      const fail = (error: unknown): void => {
        crossing.closed = true;
        if (crossing.crossed) { state.outcome = { ok: false, error }; state.effect = "unknown"; return; }
        throw classifyBeforeCommit(crossing.refusal ?? error);
      };
      const closed = () => new OperationError("internal", "effect_scope_closed");
      try {
        await admission.run(async () => {
          const phase = this.recheck(context, operation.requirement, refs, initial.resources, signal);
          state.resources = phase.resources;
          const base = this.scope(phase, signal);
          if (plan.commitPoint === "entry") cross(phase.resources);
          if (plan.mode === "admitted") {
            // Synchronous: `commit()` marks the point in this same admitted phase, after this phase's decision.
            const scope = plan.commitPoint === "declared"
              ? Object.freeze({ ...base, commit: (): void => { if (crossing.closed) throw closed(); if (!crossing.crossed) cross(phase.resources); } })
              : base;
            let value: unknown;
            try { value = plan.run(input, scope); } catch (error) { fail(error); return; }
            if (isThenable(value)) {
              // Its continuation may still act: the outcome is unknown whatever the commit point.
              absorb(value);
              crossing.closed = true;
              state.effect = "unknown";
              state.outcome = { ok: false, error: new OperationError("internal", "admitted_effect_not_synchronous", { effect: "unknown" }) };
              return;
            }
            settle(value as R);
            return;
          }
          // Idle: `commit()` always re-enters admission and decides again before crossing.
          const commit = (): Promise<void> => {
            if (crossing.closed) return Promise.reject(closed());
            if (crossing.crossed) return Promise.resolve();
            if (!crossing.pending) {
              const pending = admission.run(() => {
                const fresh = this.recheck(context, operation.requirement, refs, initial.resources, signal);
                if (crossing.closed) throw closed();
                cross(fresh.resources);
              }, { signal }).catch((error: unknown) => {
                crossing.refusal = classifyBeforeCommit(cancellationOr(error, "not_started", signal));
                throw crossing.refusal;
              });
              pending.catch(() => undefined);
              crossing.pending = pending;
            }
            return crossing.pending;
          };
          const scope = plan.commitPoint === "declared" ? Object.freeze({ ...base, commit }) : base;
          await idleWithCompletion(admission, async () => {
            let value: R;
            try { value = (await plan.run(input, scope)) as R; } catch (error) { fail(error); return; }
            settle(value);
          }, { deadlineMs: this.deadline });
        }, { signal });
      } catch (error) {
        // A refused re-admission after a settled effect does not hide its outcome.
        if (!state.outcome) throw error;
      }
      const settled = state.outcome;
      if (!settled) throw new OperationError("internal", "effect_not_settled");
      const effectResources = state.resources ?? initial.resources;

      // 4. Mandatory completion of an effect that began, under reserved
      //    admission and without an authority check: finalization, then the
      //    lease release, then the idempotency record (decision R). A failed
      //    finalization or lease release records `unknown`, never `completed`.
      //    Each step is confirmed only when its synchronous callback returned
      //    normally; a thenable is a failed step (decision W).
      const reservation = state.reservation;
      if (operation.finalize || reservation) {
        try {
          await this.complete(() => {
            let failed = false;
            try { synchronous(operation.finalize?.(input, settled, { resources: effectResources }), "finalize_not_synchronous"); } catch { failed = true; }
            if (!releaseLease()) failed = true;
            if (reservation) {
              // Decision Z: from here this callback owns the final write; `finally` never writes for this attempt.
              state.final = "unconfirmed";
              const write = (record: IdempotencyRecord) =>
                synchronous(reservation.store.put({ ...reservation.key }, record), "idempotency_store_not_synchronous");
              try {
                write(settled.ok && !failed ? finalRecord("completed", effectResources, settled.value) : finalRecord("unknown", effectResources));
              } catch {
                // The write may have landed (a `completed` one included). Repaired at once, in this same admitted
                // callback, so no other admission can read a `completed` record in between. If this write fails too,
                // the record is left to the store adapter's obligations.
                failed = true;
                write(finalRecord("unknown", effectResources));
              }
              state.final = "written";
            }
            if (failed) throw new OperationError("unavailable", "finalization_unconfirmed", { effect: "cleanup_unconfirmed" });
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
        return releaseValue<P>(synchronous(operation.project(settled.value, phase.release), "projection_not_synchronous"), operation.publicKeys);
      }, { reserved: true });
      return { ok: true, value, replayed: false };
    } catch (error) {
      return { ok: false, error: failure(error, state.effect, signal) };
    } finally {
      releaseLease();
      const reservation = state.reservation;
      // Only for attempts whose completion callback never ran: once it ran, it alone wrote (or failed to write) the final record.
      if (reservation && state.final === "pending") {
        try {
          if (state.effect === "not_started") {
            // An attempt that never crossed its commit point gives its reservation back, so a retry runs fresh.
            await this.complete(() => { synchronous(reservation.store.release({ ...reservation.key }, reservation.attempt), "idempotency_store_not_synchronous"); });
          } else {
            // The effect may have begun but its final state was never written: never leave a replayable record.
            const resources = state.resources;
            if (resources) {
              await this.complete(() => { synchronous(reservation.store.put({ ...reservation.key }, finalRecord("unknown", resources)), "idempotency_store_not_synchronous"); });
            }
          }
        } catch {
          // The record stays as it was (`reserved` or `started`); later requests see `request_in_progress` until the adapter clears it.
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
        if (ran || !admissionFailureOf(error)?.retryable || Date.now() + delay > deadline) throw error;
      }
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); timer.unref?.(); });
    }
  }

  /** Disposes a stream source at most once, bounded; failures go to the observer. Never rejects. */
  private disposer(operationId: string, iterator: AsyncIterator<unknown>): () => Promise<boolean> {
    const disposeTimeoutMs = this.runtime.disposeTimeoutMs ?? 1_000;
    const report = (kind: "rejected" | "timed_out") => {
      try {
        const returned: unknown = this.runtime.observer.streamDisposalFailed(Object.freeze({ operationId, kind }));
        if (isThenable(returned)) absorb(returned);
      } catch { /* an observer cannot change the stream */ }
    };
    let disposal: Promise<boolean> | null = null;
    return () => {
      disposal ??= new Promise<boolean>(resolve => {
        let settled = false;
        const finish = (ok: boolean, kind?: "rejected" | "timed_out") => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (kind) report(kind);
          resolve(ok);
        };
        const timer = setTimeout(() => finish(false, "timed_out"), disposeTimeoutMs);
        timer.unref?.();
        let pending: Promise<unknown>;
        try {
          const close = iterator.return;
          pending = typeof close === "function" ? Promise.resolve(close.call(iterator)) : Promise.resolve();
        } catch (error) { pending = Promise.reject(error); }
        pending.then(() => finish(true), () => finish(false, "rejected"));
      });
      return disposal;
    };
  }

  /**
   * Opens a stream after an admitted decision. Each event is awaited outside
   * admission, then authorized and projected in its own admitted phase.
   *
   * Protocol (decision T):
   * - A failure of construction, of `next()`, a malformed iterator result
   *   (not an object, a throwing `done` or `value`, a non-boolean `done`) and a
   *   projection or serialization failure are source failures: the source is
   *   disposed once and the stream ends with one sanitized error item.
   * - A denial ends the stream with one error item and disposes the source.
   * - Abort of `signal` or the consumer's `return()` settles a pending read at
   *   once, ends the stream with `done`, and disposes the source exactly once;
   *   `return()` always resolves `{ done: true }`. No event is projected or
   *   yielded after abort, `return()` or a denial.
   * - A source that finishes by itself (`done: true`) is not disposed.
   * - Disposal is awaited at most `disposeTimeoutMs`. Every disposal failure
   *   or timeout is reported to `observer.streamDisposalFailed`. It never
   *   replaces or follows a denial, and adds nothing after the consumer ended
   *   the stream; otherwise the stream already ends with its one error item.
   * - `throw()` is not provided; transports handle abandonment (see the docs).
   */
  async stream<I, E, P extends object>(operation: StreamOperation<I, E, P>, context: AuthenticationContext, raw: unknown, options: RunOptions = {}): Promise<{ ok: true; events: AsyncIterableIterator<StreamItem<P>> } | { ok: false; error: PublicOperationError }> {
    const { admission } = this.runtime;
    const { signal } = options;
    const operationId = typeof operation.id === "string" ? operation.id : "unknown";
    const created: { iterator: AsyncIterator<E> | null } = { iterator: null };
    let opened: { refs: Readonly<Record<string, ResourceRef>>; phase: Phase; iterator: AsyncIterator<E> };
    try {
      this.idempotency(false, options.idempotencyKey);
      const input = this.parse(operation.parse, raw);
      const refs = this.references(operation, input);
      opened = await admission.run(() => {
        const phase = this.admit(context, operation.requirement, refs);
        const source = synchronous(operation.open(input, this.scope(phase, signal)), "invalid_stream");
        const iterator: unknown = source[Symbol.asyncIterator]();
        if (typeof iterator !== "object" || iterator === null) throw new OperationError("internal", "invalid_stream");
        // An iterator is never itself a thenable; one that is cannot be told apart from an unfinished step.
        if (isThenable(iterator)) { absorb(iterator); throw new OperationError("internal", "invalid_stream"); }
        created.iterator = iterator as AsyncIterator<E>;
        if (typeof (iterator as AsyncIterator<E>).next !== "function") throw new OperationError("internal", "invalid_stream");
        return { refs, phase, iterator: iterator as AsyncIterator<E> };
      }, { signal });
    } catch (error) {
      // A source created before the failure is still disposed, once.
      if (created.iterator) await this.disposer(operationId, created.iterator)();
      return { ok: false, error: failure(error, null, signal) };
    }
    const { iterator, refs } = opened;
    const dispose = this.disposer(operationId, iterator);
    if (signal?.aborted) {
      await dispose();
      return { ok: false, error: failure(cancelled(), null, signal) };
    }

    const stop = new AbortController();
    const done = (): IteratorResult<StreamItem<P>> => ({ done: true, value: undefined });
    let finished = false;
    let disposing: Promise<boolean> | null = null;
    const close = () => {
      finished = true;
      stop.abort();
      signal?.removeEventListener("abort", onAbort);
    };
    /** Ended by the consumer (`return()`) or by abort of the request signal: `done`, and disposal failures only reach the observer. */
    const endByConsumer = async (): Promise<IteratorResult<StreamItem<P>>> => {
      close();
      disposing = dispose();
      await disposing;
      return done();
    };
    /** Ended by a denial or a source failure: one sanitized error item, after disposal. */
    const endWith = async (error: unknown): Promise<IteratorResult<StreamItem<P>>> => {
      const item: StreamItem<P> = { error: failure(error, null, undefined) };
      close();
      disposing = dispose();
      await disposing;
      return { done: false, value: item };
    };
    const onAbort = () => { if (!finished) void endByConsumer(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const invalidStream = () => new OperationError("internal", "invalid_stream");

    const step = async (): Promise<IteratorResult<StreamItem<P>>> => {
      for (;;) {
        if (finished) return done();
        if (signal?.aborted) return endByConsumer();
        let result: unknown;
        try {
          const read = await untilAbort(admission.idle(() => Promise.resolve().then(() => iterator.next())), stop.signal);
          // Ended meanwhile by the consumer or by abort: disposal is already under way there.
          if (!read || finished) return done();
          result = read.value;
        } catch (error) {
          if (finished) return done();
          return endWith(error);
        }
        let isDone: unknown, value: unknown;
        try {
          if (typeof result !== "object" || result === null) throw invalidStream();
          isDone = (result as { done?: unknown }).done;
          value = (result as { value?: unknown }).value;
          if (isDone !== undefined && typeof isDone !== "boolean") throw invalidStream();
        } catch (error) {
          return endWith(error);
        }
        if (isDone === true) {
          // The source finished by itself: nothing to dispose.
          close();
          return done();
        }
        let item: P | null;
        try {
          item = await admission.run(() => {
            if (finished) return null;
            const phase = this.admit(context, operation.requirement, refs);
            if (!sameResolution(opened.phase.resources, phase.resources)) throw new OperationError("conflict", "resource_changed");
            const projected = synchronous(operation.projectEvent(value as E, phase.release), "projection_not_synchronous");
            return projected === null ? null : releaseValue<P>(projected, operation.publicKeys);
          }, { signal: stop.signal });
        } catch (error) {
          if (finished) return done();
          return endWith(error);
        }
        if (finished) return done();
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
        if (!finished) return endByConsumer();
        if (disposing) await disposing;
        return done();
      },
      [Symbol.asyncIterator]() { return this; },
    };
    return { ok: true, events };
  }
}
