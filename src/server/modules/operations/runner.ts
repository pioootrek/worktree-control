import { databaseAdmissionFailure, idleWithCompletion, type DatabaseAdmission } from "@/server/database-admission";
import type { EffectState, PublicOperationError } from "@/shared/contracts/operations";
import type { AuthenticationContext, CurrentAuthority } from "./authentication-context";
import { decide } from "./decide";
import { isOperationError, OperationError } from "./errors";
import type { GrantsSnapshot } from "./grants";
import type { EffectOutcome, Lease, MutationOperation, Operation, PhaseScope, ReadOperation, StreamOperation } from "./operation";
import { createReleaseContext, type ReleaseContext } from "./release";
import type { OperationRequirement, ResolvedResources, ResourceRef } from "./requirements";
import { resolveAll, sameResolution, type ResourceResolver } from "./resolver";

/** Retained successful results, keyed per operation, principal and idempotency key. */
export interface RetainedResults {
  get(key: RetentionKey): { fingerprint: string; result: unknown } | null;
  put(key: RetentionKey, fingerprint: string, result: unknown): void;
}
export interface RetentionKey { operationId: string; principal: string; idempotencyKey: string }

/** Everything the runner needs besides the operation; injected by bootstrap or tests. */
export interface OperationRuntime {
  admission: DatabaseAdmission;
  resolver: ResourceResolver;
  /** Current grants, read inside an admitted phase. */
  grants(): GrantsSnapshot;
  now(): number;
  retained?: RetainedResults;
  /** Bound for completing an effect that began and for finalization. Default 60 s. */
  completionDeadlineMs?: number;
}

export interface RunOptions { signal?: AbortSignal; idempotencyKey?: string }
export type RunResult<T> = { ok: true; value: T; replayed: boolean } | { ok: false; error: PublicOperationError };
export type StreamItem<T> = { event: T } | { error: PublicOperationError };

interface Phase { authority: CurrentAuthority; resources: ResolvedResources; release: ReleaseContext; now: number }

function cancelled(): OperationError { return new OperationError("unavailable", "request_cancelled", { retry: "retry" }); }

/** Converts anything thrown into a typed error consistent with the observed effect state. */
function classify(error: unknown, effect: EffectState | null): OperationError {
  const began = effect !== null && effect !== "not_started";
  if (isOperationError(error)) return error.withEffect(effect);
  const admission = databaseAdmissionFailure(error);
  if (admission && !began) {
    return admission.retryable ? new OperationError("busy", "admission_refused", { effect, cause: error })
      : new OperationError("unavailable", "database_unavailable", { effect, cause: error });
  }
  if (effect === "unknown") return new OperationError("outcome_unknown", "effect_interrupted", { effect, cause: error });
  if (admission) return new OperationError("unavailable", "database_unavailable", { effect, cause: error });
  return new OperationError("internal", "unexpected_failure", { effect, cause: error });
}

function principalKey(authority: CurrentAuthority): string {
  const actor = authority.actor;
  if (actor.kind === "human" || actor.kind === "agent") return `${actor.kind}:${actor.accountId}`;
  return actor.kind === "operator" ? `operator:${actor.via}` : "installation";
}

function fingerprint(input: unknown): string {
  return JSON.stringify(input, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : 1))) : value);
}

/** Released value is plain data with only allowlisted top-level keys. */
function released<T extends object>(value: T, keys: readonly string[]): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OperationError("internal", "invalid_projection");
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new OperationError("internal", "unlisted_public_field");
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Executes operations as admitted phases. Each phase revalidates the
 * authentication context, re-resolves every resource and re-runs the full
 * decision; nothing from an earlier phase authorizes a later one.
 */
export class OperationRunner {
  constructor(private readonly runtime: OperationRuntime) {}

  private get deadline(): number { return this.runtime.completionDeadlineMs ?? 60_000; }

  /** Must run inside an admitted phase. Throws a typed denial. */
  private admit(context: AuthenticationContext, requirement: OperationRequirement, refs: Readonly<Record<string, ResourceRef>>): Phase {
    const authority = context.revalidate();
    const resources = resolveAll(this.runtime.resolver, refs);
    const now = this.runtime.now();
    const decision = decide({ authority, requirement, resources, grants: this.runtime.grants(), now });
    if (!decision.allowed) throw new OperationError(decision.category, decision.reason);
    return { authority, resources, now, release: createReleaseContext(authority, decision.permissions, resources) };
  }

  private scope(phase: Phase, signal: AbortSignal | undefined): PhaseScope {
    return { authority: phase.authority, resources: phase.resources, release: phase.release, resolver: this.runtime.resolver, now: phase.now, signal };
  }

  private parse<I>(parse: (raw: unknown) => I, raw: unknown): I {
    try { return parse(raw); } catch (error) {
      if (isOperationError(error) && error.category === "invalid_request") throw error;
      throw new OperationError("invalid_request", "invalid_input", { cause: error });
    }
  }

  async run<I, R, P extends object>(operation: Operation<I, R, P>, context: AuthenticationContext, raw: unknown, options: RunOptions = {}): Promise<RunResult<P>> {
    if (operation.kind === "read") return this.read(operation, context, raw, options);
    return this.mutate(operation, context, raw, options);
  }

  private async read<I, R, P extends object>(operation: ReadOperation<I, R, P>, context: AuthenticationContext, raw: unknown, options: RunOptions): Promise<RunResult<P>> {
    try {
      const input = this.parse(operation.parse, raw);
      const refs = operation.resources(input);
      const value = await this.runtime.admission.run(() => {
        const phase = this.admit(context, operation.requirement, refs);
        return released(operation.project(operation.read(input, this.scope(phase, options.signal)), phase.release), operation.publicKeys);
      }, { signal: options.signal });
      return { ok: true, value, replayed: false };
    } catch (error) {
      return { ok: false, error: classify(error, null).toPublic() };
    }
  }

  private async mutate<I, R, P extends object>(operation: MutationOperation<I, R, P>, context: AuthenticationContext, raw: unknown, options: RunOptions): Promise<RunResult<P>> {
    const { admission } = this.runtime;
    const { signal, idempotencyKey } = options;
    // Mutable holder: closures below update it, and TypeScript must not narrow it.
    const state: { effect: EffectState; outcome?: EffectOutcome<R>; lease?: Lease } = { effect: "not_started" };
    const releaseLease = () => { const lease = state.lease; state.lease = undefined; lease?.release(); };
    try {
      const input = this.parse(operation.parse, raw);
      const refs = operation.resources(input);
      const retention = operation.retain && idempotencyKey !== undefined && this.runtime.retained ? this.runtime.retained : null;
      const print = fingerprint(input);

      // 1. Admission: authority, resources, requirement; replay of a retained result is a release.
      const first = await admission.run(() => {
        const phase = this.admit(context, operation.requirement, refs);
        if (retention && idempotencyKey !== undefined) {
          const retained = retention.get({ operationId: operation.id, principal: principalKey(phase.authority), idempotencyKey });
          if (retained) {
            if (retained.fingerprint !== print) throw new OperationError("conflict", "idempotency_conflict");
            return { kind: "replay" as const, value: released(operation.project(retained.result as R, phase.release), operation.publicKeys) };
          }
        }
        return { kind: "fresh" as const, phase };
      }, { signal });
      if (first.kind === "replay") return { ok: true, value: first.value, replayed: true };
      const initial = first.phase;

      // 2. Optional SQL-free wait (for example a project lock) outside admission.
      if (operation.acquire) {
        const acquire = operation.acquire.bind(operation);
        state.lease = await admission.idle(() => acquire(input, signal));
      }
      if (signal?.aborted) throw cancelled();

      // 3. Recheck, then exactly one bounded effect. From here the effect may have begun.
      let effectResources: ResolvedResources = initial.resources;
      const settle = (value: R) => { state.outcome = { ok: true, value }; state.effect = "committed"; return value; };
      const fail = (error: unknown): never => {
        state.outcome = { ok: false, error };
        state.effect = isOperationError(error) && error.effect !== null ? error.effect : "unknown";
        throw error;
      };
      try {
        await admission.run(async () => {
          const phase = this.admit(context, operation.requirement, refs);
          if (!sameResolution(initial.resources, phase.resources)) throw new OperationError("conflict", "resource_changed");
          if (signal?.aborted) throw cancelled();
          effectResources = phase.resources;
          const scope = this.scope(phase, signal);
          const run = operation.effect;
          state.effect = "unknown";
          if (run.mode === "admitted") {
            try { settle(run.run(input, scope)); } catch (error) { fail(error); }
          } else {
            await idleWithCompletion(admission, async () => {
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

      // 4. Mandatory finalization of an effect that began: no authority check, reserved admission.
      if (state.effect !== "not_started" && (operation.finalize || (retention && settled.ok))) {
        try {
          await this.complete(() => {
            operation.finalize?.(input, settled, { resources: effectResources });
            if (retention && settled.ok && idempotencyKey !== undefined) {
              retention.put({ operationId: operation.id, principal: principalKey(initial.authority), idempotencyKey }, print, settled.value);
            }
          });
        } catch {
          state.effect = "cleanup_unconfirmed";
        }
      }
      releaseLease();

      // 5. Release only after a fresh decision on current authority and resources.
      const value = await admission.run(() => {
        const phase = this.admit(context, operation.requirement, refs);
        if (!sameResolution(effectResources, phase.resources)) throw new OperationError("conflict", "resource_changed");
        if (state.effect === "cleanup_unconfirmed") throw new OperationError("unavailable", "finalization_unconfirmed", { effect: state.effect });
        if (!settled.ok) throw settled.error;
        return released(operation.project(settled.value, phase.release), operation.publicKeys);
      }, { reserved: true });
      return { ok: true, value, replayed: false };
    } catch (error) {
      return { ok: false, error: classify(error, state.effect).toPublic() };
    } finally {
      releaseLease();
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
   * admission, then authorized and projected in its own admitted phase. A
   * denial ends the stream with one error item and disposes the source.
   */
  async stream<I, E, P extends object>(operation: StreamOperation<I, E, P>, context: AuthenticationContext, raw: unknown, options: RunOptions = {}): Promise<{ ok: true; events: AsyncIterable<StreamItem<P>> } | { ok: false; error: PublicOperationError }> {
    const { admission } = this.runtime;
    const { signal } = options;
    const start = async () => {
      const input = this.parse(operation.parse, raw);
      const refs = operation.resources(input);
      const opened = await admission.run(() => {
        const phase = this.admit(context, operation.requirement, refs);
        return { phase, source: operation.open(input, this.scope(phase, signal)) };
      }, { signal });
      return { refs, ...opened };
    };
    let opened: { refs: Readonly<Record<string, ResourceRef>>; phase: Phase; source: AsyncIterable<E> };
    try { opened = await start(); } catch (error) {
      return { ok: false, error: classify(error, null).toPublic() };
    }
    const refs = opened.refs;
    const admit = (requirement: OperationRequirement) => this.admit(context, requirement, refs);
    async function* events(): AsyncGenerator<StreamItem<P>> {
      const iterator = opened.source[Symbol.asyncIterator]();
      try {
        while (!signal?.aborted) {
          const next = await admission.idle(() => iterator.next());
          if (next.done) return;
          let item: P | null;
          try {
            item = await admission.run(() => {
              const phase = admit(operation.requirement);
              if (!sameResolution(opened.phase.resources, phase.resources)) throw new OperationError("conflict", "resource_changed");
              const projected = operation.projectEvent(next.value, phase.release);
              return projected === null ? null : released(projected, operation.publicKeys);
            });
          } catch (error) {
            yield { error: classify(error, null).toPublic() };
            return;
          }
          if (item !== null) yield { event: item };
        }
      } finally {
        await iterator.return?.();
      }
    }
    return { ok: true, events: events() };
  }
}
