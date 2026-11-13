import { listenerKinds, type ListenerKind, type ProjectId } from "@/shared/contracts/operations";
import type { CurrentAuthority } from "./authentication-context";
import type { Decision } from "./decide";
import type { ReleaseContext } from "./release";
import {
  frozenOperationRequirement, isSlotName,
  type OperationRequirement, type ResolvedResources, type ResourceRef, type ResourceRelation, type StoredPrincipal,
} from "./requirements";
import type { ResourceResolver } from "./resolver";

/** What an admitted phase hands to operation code. Contains no credential material. */
export interface PhaseScope {
  authority: CurrentAuthority;
  resources: ResolvedResources;
  release: ReleaseContext;
  resolver: ResourceResolver;
  now: number;
  signal: AbortSignal | undefined;
  /**
   * Application authorization interface (`29cf8fa5` delta 6): decides
   * `requirement` for a principal stored with a resource (for example a
   * request's submitter) on its current grants, without replacing the
   * caller's context. `resources` defaults to this phase's resources. Usable
   * only while this admitted phase runs synchronously; afterwards (and in an
   * idle effect, which runs outside admission) it throws
   * `internal`/`phase_closed`.
   */
  authorizePrincipal(principal: StoredPrincipal, requirement: OperationRequirement, resources?: ResolvedResources): Decision;
}

/**
 * The resulting state of a declared transition slot, as the handler reports
 * it after its commit point. The runner confirms it with the resolver before
 * it releases anything (see `MutationOperation.transitions`).
 */
export type TransitionResult =
  | { kind: "unchanged" }
  | { kind: "removed" }
  | { kind: "changed"; projectId: ProjectId; relation: ResourceRelation | null };

/** Scope of every effect. */
export interface EffectScope extends PhaseScope {
  /**
   * Reports the resulting state of a slot listed in `transitions`. Allowed
   * only past the commit point and before the handler settles; a later call
   * replaces an earlier one for the same slot. Throws `internal` for an
   * undeclared slot, a malformed result, before the commit point or after
   * the handler settled.
   */
  transition(slot: string, result: TransitionResult): void;
}

/** Scope of an idle effect, which runs outside admission. */
export interface IdleEffectScope extends EffectScope {
  /**
   * A fresh decision between steps of a multi-step effect (for example after
   * the stop inside a restart, before the start): re-enters admission,
   * revalidates authority, reads current grants, re-resolves every resource
   * and requires the resolution of the commit point (before it: of the
   * admitted effect) unchanged and the request not aborted. Call it while
   * holding the lifecycle coordination (the lease from `acquire`), so the
   * answer stays true until the next step. Rejects with the denial. A refusal
   * rethrown unchanged by the handler past its commit point is reported with
   * its own category and reason and effect `committed`: the earlier steps
   * happened, the refused one did not begin.
   */
  recheck(): Promise<void>;
}

/** Facts available to finalization, which runs even after revocation and therefore gets no authority. */
export interface FinalizeScope { resources: ResolvedResources }

export type EffectOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * A held SQL-free resource such as a project lock. The runner owns it from the
 * moment `acquire` resolves and releases it exactly once, on every path.
 */
export interface Lease { release(): void }

interface OperationBase<Input> {
  /** Stable dotted ID, e.g. `session.describe`. */
  id: string;
  /**
   * Listeners this operation is never registered on, in any mode. A transport
   * asks `OperationRegistry.availableOn`; the runner refuses such a call as
   * `not_found`/`operation_not_registered` before it parses the input. Used
   * where the actor alone cannot tell surfaces apart: in open and token mode
   * the dashboard and MCP share the installation actor, so `claim.force_release`
   * and `runtime.force_stop` exclude `mcp` (owner decision `fb1567d5`).
   */
  excludedListeners?: readonly ListenerKind[];
  /** One schema for every transport. Throw anything for `invalid_request`. */
  parse(raw: unknown): Input;
  /** Named typed references; each resolves to exactly one project or not-found. */
  resources(input: Input): Readonly<Record<string, ResourceRef>>;
  requirement: OperationRequirement;
}

interface ProjectedOperation<Input, InternalResult, PublicResult extends object> extends OperationBase<Input> {
  /** Allowlisted top-level keys of the public result; anything else fails release. */
  publicKeys: readonly (keyof PublicResult & string)[];
  /** The single place deciding what an internal result releases to this caller. */
  project(result: InternalResult, release: ReleaseContext): PublicResult;
}

/** A synchronous read inside one admitted phase. */
export interface ReadOperation<Input, InternalResult, PublicResult extends object> extends ProjectedOperation<Input, InternalResult, PublicResult> {
  kind: "read";
  read(input: Input, scope: PhaseScope): InternalResult;
}

/**
 * Scope of an admitted effect that declares its commit point. `commit()` marks
 * the point synchronously, in the same admitted phase as the effect's final
 * check, so the decision it relies on is that phase's fresh decision.
 */
export interface AdmittedCommitScope extends EffectScope { commit(): void }

/**
 * Scope of an idle effect that declares its commit point. `commit()` always
 * re-enters admission and takes a fresh decision (authority, resources,
 * resolution unchanged, not aborted) before it marks the point; it rejects
 * with that denial otherwise. It is the only way to cross the point.
 */
export interface IdleCommitScope extends IdleEffectScope { commit(): Promise<void> }

/**
 * Exactly one bounded effect. `commitPoint` (decision N) is fixed by the
 * definition, never by what the handler happens to do:
 *
 * - `"entry"` (or absent): the handler is past its commit point when it is
 *   invoked; anything it throws is `outcome_unknown`.
 * - `"declared"`: the handler gets a `commit()` scope. Before it calls
 *   `commit()`, a typed error keeps its category with effect `not_started` and
 *   an untyped one is `internal`/`not_started`; the reservation is released.
 *   From the commit on, anything thrown is `outcome_unknown`. Settling
 *   successfully without having committed is `outcome_unknown`
 *   (`commit_point_not_declared`).
 */
export type OperationEffect<Input, InternalResult> =
  /** Synchronous store effect in the same admitted phase as its final check. */
  | { mode: "admitted"; commitPoint?: "entry"; run(input: Input, scope: EffectScope): InternalResult }
  | { mode: "admitted"; commitPoint: "declared"; run(input: Input, scope: AdmittedCommitScope): InternalResult }
  /** SQL-free effect started right after its final check; completion re-enters reserved admission. */
  | { mode: "idle"; commitPoint?: "entry"; run(input: Input, scope: IdleEffectScope): Promise<InternalResult> }
  | { mode: "idle"; commitPoint: "declared"; run(input: Input, scope: IdleCommitScope): Promise<InternalResult> };

/**
 * A mutation: resolve and check; optional SQL-free wait (`acquire`); recheck
 * and one bounded effect; mandatory finalization; release after a recheck.
 */
export interface MutationOperation<Input, InternalResult, PublicResult extends object> extends ProjectedOperation<Input, InternalResult, PublicResult> {
  kind: "mutation";
  acquire?(input: Input, signal: AbortSignal | undefined): Promise<Lease>;
  /**
   * Exactly one bounded effect; see `OperationEffect` for the commit point.
   * Without a declared commit point, anything it throws is reported as an
   * unknown outcome (`outcome_unknown`, keeping the thrown reason).
   */
  effect: OperationEffect<Input, InternalResult>;
  /** Audit, receipt and owned cleanup of an effect that began. Synchronous, reserved admission. */
  finalize?(input: Input, outcome: EffectOutcome<InternalResult>, scope: FinalizeScope): void;
  /**
   * Accept idempotency keys: an admitted reservation per operation, principal
   * and key (see `IdempotencyStore`). The raw input must then be JSON-domain
   * data accepted by the strict serializer; `parse` receives its canonical
   * copy (decision V). The fingerprint is a keyed digest of that canonical
   * text (`29cf8fa5` delta 7); the text itself is never stored. The internal
   * result (or, for a secret-bearing operation, only its receipt) is retained
   * for replay and must be structured-cloneable plain data.
   */
  retain?: true;
  /**
   * Expected transitions (`29cf8fa5` delta 2): slots whose resource this
   * effect changes or removes. For each, the handler reports the result
   * (`EffectScope.transition`) and the runner confirms it with the resolver
   * at completion. Release and replay then decide on the resolution recorded
   * at the commit point (historical authority), decide again on the resulting
   * resolution (predicates on declared slots, and requirements on removed
   * slots, left out), and require the current resolution to equal the
   * confirmed result for declared slots and the commit-point resolution for
   * every other slot. An unconfirmed result releases nothing.
   */
  transitions?: readonly string[];
  /**
   * Secret-bearing (`29cf8fa5` delta 7). Requires `retain`. The store keeps
   * only `receipt(result)`: a flat record of IDs, names, revisions and
   * timestamps (`receiptValue`), never the input or a secret output. The first
   * response is `project(result)`, which may deliver a secret once; a replay
   * returns `projectReceipt(receipt)`, checked against `publicKeys`.
   */
  secret?: {
    receipt(result: InternalResult): Receipt;
    projectReceipt(receipt: Receipt, release: ReleaseContext): PublicResult;
  };
}

/** What a secret-bearing operation retains: identifiers and revisions only. */
export type ReceiptValue = string | number | boolean | null | readonly (string | number)[];
export type Receipt = Readonly<Record<string, ReceiptValue>>;

/**
 * A query (`29cf8fa5` delta 1): authorization and `plan` in one admitted
 * phase; `work` (discovery, hashing, filesystem reads) outside admission,
 * cancellable and bounded; then a fresh decision with an unchanged resolution
 * before `project` releases anything. Nothing a query does may be an effect.
 */
export interface QueryOperation<Input, InternalResult, PublicResult extends object, Plan = unknown> extends ProjectedOperation<Input, InternalResult, PublicResult> {
  kind: "query";
  /** Synchronous, in the admitted phase that authorized the query: what the work needs from authorized state. */
  plan(input: Input, scope: PhaseScope): Plan;
  /** Asynchronous work outside admission. Must stop when `signal` aborts (cancellation or the deadline). */
  work(plan: Plan, signal: AbortSignal): Promise<InternalResult>;
  /** Bound of the work in milliseconds; at most the runtime's query deadline, which also applies when absent. */
  timeoutMs?: number;
}

export type Operation<Input, InternalResult, PublicResult extends object> =
  | ReadOperation<Input, InternalResult, PublicResult>
  | MutationOperation<Input, InternalResult, PublicResult>
  | QueryOperation<Input, InternalResult, PublicResult>;

/** Longest wait a bounded one-event stream may take (the matrix: default 10 s, maximum 20 s). */
export const MAX_WAIT_TIMEOUT_MS = 20_000;

/** Every event is a data release: authorized and projected individually. */
export interface StreamOperation<Input, InternalEvent, PublicEvent extends object> extends OperationBase<Input> {
  kind: "stream";
  publicKeys: readonly (keyof PublicEvent & string)[];
  open(input: Input, scope: PhaseScope): AsyncIterable<InternalEvent>;
  /** `null` withholds this event from this caller. */
  projectEvent(event: InternalEvent, release: ReleaseContext): PublicEvent | null;
  /**
   * A wait (`29cf8fa5` delta 1; there is no `wait` kind): a stream of at most
   * one released event. At most `maxWaiters` such streams of this operation are
   * open at once per runner; another is `busy`/`too_many_waiters`. The stream
   * ends with `done` and no event after `timeoutMs(input)` milliseconds (1 to
   * `MAX_WAIT_TIMEOUT_MS`), and ends after its one event; either way the source
   * is disposed.
   */
  wait?: { maxWaiters: number; timeoutMs(input: Input): number };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyOperation = Operation<any, any, any> | QueryOperation<any, any, any, any> | StreamOperation<any, any, any>;

const OPERATION_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const PUBLIC_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Validates an operation definition and freezes it with a deeply frozen
 * requirement, allowlist and effect. Throws `TypeError` for anything malformed.
 */
function sealed<T extends AnyOperation>(operation: T): T {
  if (typeof operation !== "object" || operation === null) throw new TypeError("Invalid operation.");
  if (typeof operation.id !== "string" || !OPERATION_ID.test(operation.id)) throw new TypeError(`Invalid operation ID: ${String(operation.id)}`);
  const kind: unknown = operation.kind;
  if (kind !== "read" && kind !== "mutation" && kind !== "stream" && kind !== "query") throw new TypeError("Unknown operation kind.");
  if (typeof operation.parse !== "function" || typeof operation.resources !== "function") throw new TypeError("An operation needs parse and resources.");
  const keys: unknown = operation.publicKeys;
  if (!Array.isArray(keys) || !keys.every(key => typeof key === "string" && PUBLIC_KEY.test(key))) throw new TypeError("Invalid public key allowlist.");
  const fields: Record<string, unknown> = { requirement: frozenOperationRequirement(operation.requirement), publicKeys: Object.freeze([...keys]) };
  const excluded = frozenListeners(operation.excludedListeners);
  if (excluded) fields.excludedListeners = excluded;
  if (operation.kind === "query") {
    if (typeof operation.plan !== "function" || typeof operation.work !== "function") throw new TypeError("A query needs plan and work.");
    const timeout: unknown = operation.timeoutMs;
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || (timeout as number) < 1)) throw new TypeError("Invalid query timeout.");
  }
  if (operation.kind === "stream" && operation.wait !== undefined) {
    const wait: unknown = operation.wait;
    const { maxWaiters, timeoutMs } = (typeof wait === "object" && wait !== null ? wait : {}) as Record<string, unknown>;
    if (!Number.isSafeInteger(maxWaiters) || (maxWaiters as number) < 1 || typeof timeoutMs !== "function") throw new TypeError("Invalid wait bounds.");
    fields.wait = Object.freeze({ ...(wait as object) });
  }
  if (operation.kind === "mutation") {
    const transitions: unknown = operation.transitions;
    if (transitions !== undefined) {
      if (!Array.isArray(transitions) || transitions.length === 0 || !transitions.every(isSlotName) || new Set(transitions).size !== transitions.length) {
        throw new TypeError("`transitions` lists distinct valid slot names.");
      }
      fields.transitions = Object.freeze([...transitions]);
    }
    const secret: unknown = operation.secret;
    if (secret !== undefined) {
      const { receipt, projectReceipt } = (typeof secret === "object" && secret !== null ? secret : {}) as Record<string, unknown>;
      if (typeof receipt !== "function" || typeof projectReceipt !== "function") throw new TypeError("A secret-bearing operation needs receipt and projectReceipt.");
      if (operation.retain !== true) throw new TypeError("A secret-bearing operation must declare `retain`.");
      fields.secret = Object.freeze({ ...(secret as object) });
    }
    const effect: unknown = operation.effect;
    if (typeof effect !== "object" || effect === null) throw new TypeError("A mutation needs an effect.");
    const { mode, commitPoint, run } = effect as Record<string, unknown>;
    if (mode !== "admitted" && mode !== "idle") throw new TypeError("Unknown effect mode.");
    if (commitPoint !== undefined && commitPoint !== "entry" && commitPoint !== "declared") throw new TypeError("Unknown commit point.");
    if (typeof run !== "function") throw new TypeError("An effect needs run.");
    if (operation.retain !== undefined && operation.retain !== true) throw new TypeError("`retain` is either absent or true.");
    fields.effect = Object.freeze({ ...(effect as object) });
  }
  return Object.freeze(Object.assign(Object.create(Object.getPrototypeOf(operation) as object | null) as T, operation, fields));
}

/** Validated, frozen copy of a listener exclusion list; `undefined` when absent. */
function frozenListeners(value: unknown): readonly ListenerKind[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(each => (listenerKinds as readonly unknown[]).includes(each)) || new Set(value).size !== value.length) {
    throw new TypeError("Invalid listener exclusion.");
  }
  return Object.freeze([...value] as ListenerKind[]);
}

/** Whether an operation definition may be called through `listener`. Reads only the frozen exclusion list. */
export function listenerAllowed(operation: { excludedListeners?: readonly ListenerKind[] }, listener: ListenerKind): boolean {
  const excluded: unknown = operation.excludedListeners;
  if (excluded === undefined) return true;
  // A malformed list fails closed: the operation is available nowhere.
  return Array.isArray(excluded) && !excluded.includes(listener);
}

/**
 * Closed set of operations. Rejects duplicate and malformed IDs, malformed
 * requirements (unknown permissions, invalid slot names), allowlists and
 * effects. Registers a frozen copy whose requirement, allowlist and effect are
 * deeply frozen; use the returned value.
 */
export class OperationRegistry {
  readonly #operations = new Map<string, AnyOperation>();

  register<T extends AnyOperation>(operation: T): T {
    const copy = sealed(operation);
    if (this.#operations.has(copy.id)) throw new TypeError(`Duplicate operation ID: ${copy.id}`);
    this.#operations.set(copy.id, copy);
    return copy;
  }

  get(id: string): AnyOperation | undefined { return this.#operations.get(id); }
  ids(): string[] { return [...this.#operations.keys()].sort(); }
  /** Whether a transport serving `listener` may register operation `id`. `false` for an unknown ID. */
  availableOn(id: string, listener: ListenerKind): boolean {
    const operation = this.#operations.get(id);
    return !!operation && listenerAllowed(operation, listener);
  }
  /** Every operation a transport serving `listener` may register, sorted. */
  idsOn(listener: ListenerKind): string[] { return this.ids().filter(id => this.availableOn(id, listener)); }
}
