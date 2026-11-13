import type { CurrentAuthority } from "./authentication-context";
import type { ReleaseContext } from "./release";
import { frozenOperationRequirement, type OperationRequirement, type ResolvedResources, type ResourceRef } from "./requirements";
import type { ResourceResolver } from "./resolver";

/** What an admitted phase hands to operation code. Contains no credential material. */
export interface PhaseScope {
  authority: CurrentAuthority;
  resources: ResolvedResources;
  release: ReleaseContext;
  resolver: ResourceResolver;
  now: number;
  signal: AbortSignal | undefined;
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
export interface AdmittedCommitScope extends PhaseScope { commit(): void }

/**
 * Scope of an idle effect that declares its commit point. `commit()` always
 * re-enters admission and takes a fresh decision (authority, resources,
 * resolution unchanged, not aborted) before it marks the point; it rejects
 * with that denial otherwise. It is the only way to cross the point.
 */
export interface IdleCommitScope extends PhaseScope { commit(): Promise<void> }

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
  | { mode: "admitted"; commitPoint?: "entry"; run(input: Input, scope: PhaseScope): InternalResult }
  | { mode: "admitted"; commitPoint: "declared"; run(input: Input, scope: AdmittedCommitScope): InternalResult }
  /** SQL-free effect started right after its final check; completion re-enters reserved admission. */
  | { mode: "idle"; commitPoint?: "entry"; run(input: Input, scope: PhaseScope): Promise<InternalResult> }
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
   * copy and the fingerprint is its canonical text (decision V). The internal
   * result is retained for replay and must be structured-cloneable plain data.
   */
  retain?: true;
}

export type Operation<Input, InternalResult, PublicResult extends object> =
  | ReadOperation<Input, InternalResult, PublicResult>
  | MutationOperation<Input, InternalResult, PublicResult>;

/** Every event is a data release: authorized and projected individually. */
export interface StreamOperation<Input, InternalEvent, PublicEvent extends object> extends OperationBase<Input> {
  kind: "stream";
  publicKeys: readonly (keyof PublicEvent & string)[];
  open(input: Input, scope: PhaseScope): AsyncIterable<InternalEvent>;
  /** `null` withholds this event from this caller. */
  projectEvent(event: InternalEvent, release: ReleaseContext): PublicEvent | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyOperation = Operation<any, any, any> | StreamOperation<any, any, any>;

const OPERATION_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const PUBLIC_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Validates an operation definition and freezes it with a deeply frozen
 * requirement, allowlist and effect. Throws `TypeError` for anything malformed.
 */
function sealed<T extends AnyOperation>(operation: T): T {
  if (typeof operation !== "object" || operation === null) throw new TypeError("Invalid operation.");
  if (typeof operation.id !== "string" || !OPERATION_ID.test(operation.id)) throw new TypeError(`Invalid operation ID: ${String(operation.id)}`);
  if (operation.kind !== "read" && operation.kind !== "mutation" && operation.kind !== "stream") throw new TypeError("Unknown operation kind.");
  if (typeof operation.parse !== "function" || typeof operation.resources !== "function") throw new TypeError("An operation needs parse and resources.");
  const keys: unknown = operation.publicKeys;
  if (!Array.isArray(keys) || !keys.every(key => typeof key === "string" && PUBLIC_KEY.test(key))) throw new TypeError("Invalid public key allowlist.");
  const fields: Record<string, unknown> = { requirement: frozenOperationRequirement(operation.requirement), publicKeys: Object.freeze([...keys]) };
  if (operation.kind === "mutation") {
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
}
