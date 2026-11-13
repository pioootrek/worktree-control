import type { CurrentAuthority } from "./authentication-context";
import type { ReleaseContext } from "./release";
import type { OperationRequirement, ResolvedResources, ResourceRef } from "./requirements";
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

export type OperationEffect<Input, InternalResult> =
  /** Synchronous store effect in the same admitted phase as its final check. */
  | { mode: "admitted"; run(input: Input, scope: PhaseScope): InternalResult }
  /** SQL-free effect started right after its final check; completion re-enters reserved admission. */
  | { mode: "idle"; run(input: Input, scope: PhaseScope): Promise<InternalResult> };

/**
 * A mutation: resolve and check; optional SQL-free wait (`acquire`); recheck
 * and one bounded effect; mandatory finalization; release after a recheck.
 */
export interface MutationOperation<Input, InternalResult, PublicResult extends object> extends ProjectedOperation<Input, InternalResult, PublicResult> {
  kind: "mutation";
  acquire?(input: Input, signal: AbortSignal | undefined): Promise<Lease>;
  /**
   * Exactly one bounded effect. Anything it throws is reported as an unknown
   * outcome (`outcome_unknown`, keeping the thrown reason): once invoked, the
   * runner cannot know how far it got. Refusals that must report `not_started`
   * belong in the requirement or in `acquire`, before the effect.
   */
  effect: OperationEffect<Input, InternalResult>;
  /** Audit, receipt and owned cleanup of an effect that began. Synchronous, reserved admission. */
  finalize?(input: Input, outcome: EffectOutcome<InternalResult>, scope: FinalizeScope): void;
  /**
   * Accept idempotency keys: an admitted reservation per operation, principal
   * and key (see `IdempotencyStore`). The internal result is retained for
   * replay and must be structured-cloneable plain data.
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

/** Closed set of operations. Rejects duplicate and malformed IDs. */
export class OperationRegistry {
  readonly #operations = new Map<string, AnyOperation>();

  register<T extends AnyOperation>(operation: T): T {
    if (!OPERATION_ID.test(operation.id)) throw new TypeError(`Invalid operation ID: ${operation.id}`);
    if (this.#operations.has(operation.id)) throw new TypeError(`Duplicate operation ID: ${operation.id}`);
    Object.freeze(operation);
    this.#operations.set(operation.id, operation);
    return operation;
  }

  get(id: string): AnyOperation | undefined { return this.#operations.get(id); }
  ids(): string[] { return [...this.#operations.keys()].sort(); }
}
