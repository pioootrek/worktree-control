import { createHmac, randomUUID } from "node:crypto";
import { idleWithCompletion, type DatabaseAdmission } from "@/server/database-admission";
import type { EffectState, ListenerKind, ProjectId, PublicOperationError } from "@/shared/contracts/operations";
import { currentAuthorityWithCredential, mintedListener, type AuthenticationContext, type CredentialRef, type CurrentAuthority } from "./authentication-context";
import { decideWith } from "./decide";
import { admissionFailureOf, classify, classifyBeforeCommit, OperationError, publicError } from "./errors";
import { effectivePermissions, type EffectivePermissions, type GrantsSnapshot } from "./grants";
import {
  listenerAllowed, MAX_WAIT_TIMEOUT_MS,
  type AnyOperation, type EffectOutcome, type EffectScope, type IdleEffectScope, type Lease, type MutationOperation, type Operation, type PhaseScope, type QueryOperation,
  type ReadOperation, type Receipt, type StreamOperation, type TransitionResult,
} from "./operation";
import { decideForPrincipal } from "./principal";
import { canonicalJson, createReleaseContext, releaseError, releaseValue, serializeRelease, type ReleaseContext } from "./release";
import {
  allOf, authenticated, collectionPermissions, frozenOperationRequirement, isSlotName, sameProject, usesAnyProject,
  type OperationRequirement, type Requirement, type ResolvedResource, type ResolvedResources, type ResourceRef,
} from "./requirements";
import {
  copyRelation, copyResolution, copyResolvedResource, resolveAll, resolveAllowingMissing, sameRelation, sameResolution, type ResourceResolver,
} from "./resolver";
import { absorb, holds, isThenable, synchronous } from "./synchronous";

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
  /**
   * Keyed digest of the canonical input (`hmac-sha256:v1:<hex>`, decision V
   * and `29cf8fa5` delta 7). Never the input text.
   */
  fingerprint: string;
  /** Resources resolved when the attempt was admitted (and, once started, at its commit point). */
  resources: ResolvedResources;
  state: IdempotencyState;
  /**
   * Retained result of a `completed` attempt: the internal result, or for a
   * secret-bearing operation only its receipt. JSON-domain: it passes the
   * strict release serializer (`serializeRelease`), which the runner applies
   * before the first projection, so a first release and a replay project the
   * same value.
   */
  result?: unknown;
  /**
   * For an operation with expected transitions, the confirmed resulting
   * resolution of each declared slot (`null`: removed), recorded with a
   * `completed` attempt.
   */
  transitions?: Readonly<Record<string, ResolvedResource | null>>;
}

/**
 * Admitted idempotency reservations. Every call happens inside an admitted
 * phase and is synchronous, so a read and the following write of one phase
 * are atomic against other requests. A call that returns a promise or other
 * thenable is a failed call (decision W): its rejection is absorbed and the
 * runner proceeds as if the call had thrown. The adapter stores copies, never
 * references; the runner validates and copies every record it reads back
 * (a malformed record is `internal`/`invalid_idempotency_record`). The SQLite
 * adapter (`adapters/sqlite-idempotency.ts`, D1b) bounds retention and, at each
 * controller start, deletes `reserved` records (their effect never began) and
 * turns `started` records into `unknown`. A typed error a call throws keeps its
 * category and reason: a full store refuses a reservation as
 * `busy`/`idempotency_capacity` with effect `not_started`.
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
  /**
   * Key of the idempotency fingerprint digest, at least 32 bytes; copied at
   * construction. Its source and rotation belong to the store adapter (D6).
   * Without it an idempotency key is `unavailable`/`idempotency_unavailable`.
   */
  fingerprintKey?: Uint8Array;
  /** Upper bound of a query's asynchronous work. Default 30 s. */
  queryDeadlineMs?: number;
}

export interface RunOptions { signal?: AbortSignal; idempotencyKey?: string }
export type RunResult<T> = { ok: true; value: T; replayed: boolean } | { ok: false; error: PublicOperationError };
/**
 * A request-scoped release, with no defaults for eligibility, connection or deadline.
 * Callbacks are captured once, before admission, and called with this options object as receiver.
 */
export interface ReadReleaseOptions<P> extends RunOptions {
  /** Bootstrap's one current runtime/maintenance/configuration policy. Only synchronous true allows release. */
  eligible(): boolean;
  /** Only synchronous true means the caller can still receive a response. */
  connected(): boolean;
  /** Absolute deadline in the runtime clock's milliseconds; equality is expired. */
  deadline: number;
  /** Absent: direct write. Present: canonicalJson of the earlier run's public value, for this operation and input. */
  expectedCanonical?: string;
  /** Synchronous write of the fresh released value (or of the validated buffered payload). Never retried. */
  commit(value: P): void;
  /**
   * Buffered delivery of a refusal (MCP). Without it a refusal is only
   * returned. With it, a refusal of the operation itself is staged outside
   * admission and committed only inside a fresh admitted phase of the same
   * operation and input that reproduces the identical public error; then the
   * result is `committed`. When the fresh phase answers anything else, nothing
   * staged is committed and that fresh answer is returned as `refused`
   * (`conflict`/`release_payload_changed` when it would now succeed). The
   * release policy's own refusals (eligibility, deadline, cancellation) are
   * never staged. Not combined with `expectedCanonical`.
   */
  refusal?: RefusalRelease;
}
export interface RefusalRelease {
  /** Prepares the refusal outside admission, for example a protocol envelope. Must not write to the caller. */
  stage(error: PublicOperationError): Promise<void>;
  /** Synchronous write of the staged refusal, inside the admitted phase that reproduced it. Never retried. */
  commit(error: PublicOperationError): void;
}
/** Refusals that belong to the request's release policy, not to the operation: never staged as the operation's answer. */
const RELEASE_POLICY_REASONS: readonly string[] = Object.freeze(["release_not_eligible", "release_timed_out", "request_cancelled"]);
export type ReadReleaseResult =
  | { status: "committed" }
  | { status: "refused"; error: PublicOperationError }
  | { status: "commit_failed"; error: PublicOperationError };

/**
 * A mutation's request-scoped release (`OperationRunner.mutationRelease`).
 * Callbacks are captured once, before the first admission, and called with
 * this options object as receiver.
 */
export interface MutationReleaseOptions<P> extends RunOptions {
  /** As in `ReadReleaseOptions`: only synchronous true allows release. */
  eligible(): boolean;
  /** As in `ReadReleaseOptions`: only synchronous true means the caller can still receive a response. */
  connected(): boolean;
  /** Absolute deadline in the runtime clock's milliseconds; equality is expired. Checked again before every write. */
  deadline: number;
  /** Synchronous write of the released value (a first release or a replay), inside admission. Never retried. */
  commit(value: P): void;
  /** Synchronous write of a refusal, inside the admitted phase that established it. Never retried. */
  refuse(error: PublicOperationError): void;
  /**
   * Buffered success (MCP): prepares bytes from the released value outside
   * admission and must not write to the caller. Called once and awaited until
   * it settles or `signal` aborts (then `request_cancelled`, nothing written);
   * the deadline does not interrupt it, so a transport that stages passes a
   * signal and aborts it at its deadline. The write happens in `commit` inside
   * a final admitted phase that reproduces the value.
   */
  stage?(value: P): Promise<void>;
  /** Refused (`invalid_request`/`invalid_input`): a mutation's release always takes a fresh decision. */
  expectedCanonical?: never;
  /** Refused (`invalid_request`/`invalid_input`): a mutation's refusal is always written directly by `refuse`. */
  refusal?: never;
}
/**
 * `committed`: `commit` or `refuse` returned normally. `refused`: returned
 * without any write (the release policy, a refused admission whose callback
 * never ran, a failed `stage`, an invalid call without usable callbacks); the
 * adapter may write it. `commit_failed`: the one delivery attempt threw or
 * returned a thenable; the adapter ends the response and writes nothing more.
 */
export type MutationReleaseResult = ReadReleaseResult;

export type StreamItem<T> = { event: T } | { error: PublicOperationError };

/** Everything a phase reads before it resolves any reference (decision Y). */
interface Prepared {
  authority: CurrentAuthority;
  /** The credential the context was minted from, for `intent_origin`. */
  credential: CredentialRef | null;
  /** Computed before resolution; every later decision of this phase reuses it and reads no adapter. */
  permissions: EffectivePermissions;
  /** The snapshot the permissions came from, for `authorizePrincipal` in the same phase. */
  grants: GrantsSnapshot;
  /** Every current project, read only for a requirement with an `any_project` part. */
  projects: readonly ProjectId[] | undefined;
  now: number;
}

interface Phase extends Prepared {
  resources: ResolvedResources;
  release: ReleaseContext;
}

/** A mutation's work before its first admitted phase (`mutationPlan`). */
interface MutationPlan<I> {
  plan: EffectPlan;
  gate: Gate;
  store: IdempotencyStore | null;
  /** The fingerprint of a keyed request; empty otherwise. */
  print: string;
  secret: SecretHooks | null;
  input: I;
  refs: Readonly<Record<string, ResourceRef>>;
  transitions: readonly string[] | null;
}

/** The captured release of one `mutationRelease` call and its one answer. */
interface MutationDelivery<P> {
  /** The options object, receiver of every callback. */
  receiver: object;
  commit: (value: P) => void;
  refuse: (error: PublicOperationError) => void;
  stage: ((value: P) => Promise<void>) | undefined;
  /** The request's release policy (`releaseCheck`). */
  check: (now: number) => void;
  deadline: number;
  signal: AbortSignal | undefined;
  /** Refusals thrown by the policy, recognized by identity (their origin), never by reason. */
  policy: WeakSet<object>;
  /** Set before the one `commit` or `refuse` call; never cleared. */
  attempted: boolean;
  /** This call's answer once decided; nothing is written after it is set. */
  outcome: ReadReleaseResult | null;
}

/** The release policy of one admitted phase; `passed` once it allowed this phase. */
interface PhaseGuard { passed: boolean; check(now: number): void }

/** What every decision point of one operation checks besides its resources. */
interface Gate { requirement: OperationRequirement; excluded: readonly ListenerKind[] | undefined }

function gateOf(operation: { requirement: OperationRequirement; excludedListeners?: readonly ListenerKind[] }): Gate {
  return { requirement: operation.requirement, excluded: operation.excludedListeners };
}

/** A read's or query's parsed input and references: everything before its first admitted phase. */
interface Planned<I> { input: I; refs: Readonly<Record<string, ResourceRef>>; gate: Gate }

/** How far a query got, so a staged refusal can be reproduced by the same step. */
interface QueryProgress<I> {
  step: "input" | "plan" | "work" | "release" | "staged";
  planned?: Planned<I>;
  resources?: ResolvedResources;
}

/** What steps 1 and 2 of a query leave for its release. The work result never leaves the runner unprojected. */
interface QueryWorked<R> {
  gate: Gate;
  refs: Readonly<Record<string, ResourceRef>>;
  resources: ResolvedResources;
  outcome: { ok: true; value: R } | { ok: false; error: unknown };
}

/** A validated copy of a refusal delivery, or undefined. Invalid or combined with `expectedCanonical`: `invalid_input`. */
function refusalOf(value: unknown, expectedCanonical: string | undefined): RefusalRelease | undefined {
  if (value === undefined) return undefined;
  const { stage, commit } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (expectedCanonical !== undefined || typeof stage !== "function" || typeof commit !== "function") throw new OperationError("invalid_request", "invalid_input");
  return Object.freeze({
    stage: (error: PublicOperationError) => Reflect.apply(stage, value, [error]) as Promise<void>,
    commit: (error: PublicOperationError) => Reflect.apply(commit, value, [error]),
  });
}

/** The release policy of a request, checked at the start of an admitted phase (decision Y). */
function releaseCheck(options: object, eligible: () => boolean, connected: () => boolean, deadline: number, signal: AbortSignal | undefined) {
  return (now: number) => {
    // Throwing predicates, like thenables and non-booleans, give no answer (decision W).
    let allowed = false;
    try { allowed = holds(Reflect.apply(eligible, options, [])); } catch { /* no answer */ }
    if (!allowed) throw new OperationError("unavailable", "release_not_eligible");
    if (!Number.isFinite(now)) throw new OperationError("internal", "invalid_input");
    if (now >= deadline) throw new OperationError("unavailable", "release_timed_out", { retry: "retry" });
    let open = false;
    try { open = holds(Reflect.apply(connected, options, [])); } catch { /* no answer */ }
    if (!open || signal?.aborted) throw cancelled();
  };
}

/** Whether an admitted phase is still running synchronously; `authorizePrincipal` works only then. */
interface Liveness { open: boolean }

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const RECORD_STATES: readonly string[] = Object.freeze(["reserved", "started", "completed", "unknown"]);

function cancelled(): OperationError { return new OperationError("unavailable", "request_cancelled", { retry: "retry" }); }
const notRegistered = () => new OperationError("not_found", "operation_not_registered");
const phaseClosed = () => new OperationError("internal", "phase_closed");
const RECEIPT_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,199}$/;
const RECEIPT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FINGERPRINT_VERSION = "hmac-sha256:v1:";

/**
 * Validated copy of a secret-bearing operation's receipt (`29cf8fa5` delta 7):
 * a flat plain record of at most 32 keys whose values are `null`, booleans,
 * safe integers, identifier-like strings (IDs, names, revisions, ISO
 * timestamps; at most 200 characters, no spaces, quotes, slashes or `=`) or
 * arrays of at most 256 such strings or integers. A receipt cannot hold a
 * nested object, so an internal result cannot be retained by accident.
 * Throws `internal`/`invalid_receipt`.
 */
export function receiptValue(value: unknown): Receipt {
  const invalid = () => new OperationError("internal", "invalid_receipt");
  let plain: unknown;
  try { plain = serializeRelease(value); } catch { throw invalid(); }
  if (typeof plain !== "object" || plain === null || Array.isArray(plain)) throw invalid();
  const entries = Object.entries(plain as Record<string, unknown>);
  if (entries.length > 32) throw invalid();
  const scalar = (item: unknown) => (typeof item === "string" && RECEIPT_TEXT.test(item)) || Number.isSafeInteger(item);
  for (const [key, item] of entries) {
    if (!RECEIPT_KEY.test(key)) throw invalid();
    if (item === null || typeof item === "boolean" || scalar(item)) continue;
    if (Array.isArray(item) && item.length <= 256 && item.every(scalar)) continue;
    throw invalid();
  }
  return Object.freeze(plain as Receipt);
}

/** Validated copy of a reported transition result; `null` when malformed. */
function copyTransitionResult(value: unknown): TransitionResult | null {
  if (typeof value !== "object" || value === null) return null;
  const { kind, projectId, relation } = value as Record<string, unknown>;
  if (kind === "unchanged" || kind === "removed") return Object.freeze({ kind });
  // `null` is the explicit parentless state; an absent, empty or non-string project is malformed.
  if (kind !== "changed" || (projectId !== null && (typeof projectId !== "string" || projectId.length === 0))) return null;
  const copied = copyRelation(relation);
  return copied === undefined ? null : Object.freeze({ kind, projectId: projectId as ProjectId | null, relation: copied });
}

/** Validated copy of a record's confirmed transitions; throws when malformed. */
function copyTransitions(value: unknown): Readonly<Record<string, ResolvedResource | null>> {
  const malformed = () => new OperationError("internal", "invalid_idempotency_record");
  if (typeof value !== "object" || value === null) throw malformed();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw malformed();
  const copy = Object.create(null) as Record<string, ResolvedResource | null>;
  for (const key of Reflect.ownKeys(value)) {
    if (!isSlotName(key)) throw malformed();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const item: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
    const resource = item === null ? null : copyResolvedResource(item);
    if (item !== null && !resource) throw malformed();
    Object.defineProperty(copy, key, { value: resource, enumerable: true });
  }
  return Object.freeze(copy);
}

/** Own data value of a resources record. */
function slotOf(resources: ResolvedResources, name: string): ResolvedResource | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(resources, name);
  return descriptor && "value" in descriptor ? descriptor.value as ResolvedResource : undefined;
}

/** The commit-point resolution with each declared slot replaced by its confirmed result (a removed slot left out). */
function resultingResolution(commit: ResolvedResources, confirmed: Readonly<Record<string, ResolvedResource | null>>): ResolvedResources {
  const result = Object.create(null) as Record<string, ResolvedResource>;
  for (const name of Object.keys(commit)) {
    const replaced = Object.prototype.hasOwnProperty.call(confirmed, name);
    const resource = replaced ? confirmed[name] : slotOf(commit, name);
    if (resource) Object.defineProperty(result, name, { value: resource, enumerable: true });
  }
  return Object.freeze(result);
}

/**
 * The requirement decided on a resulting resolution: a predicate on a declared
 * slot (it is about the relation the effect changed) and a requirement on a
 * removed slot are left out; a `same_project` keeps its remaining slots.
 */
function withoutTransitions(requirement: Requirement, declared: ReadonlySet<string>, removed: ReadonlySet<string>): Requirement {
  switch (requirement.kind) {
    case "predicate": return declared.has(requirement.resource) ? authenticated() : requirement;
    case "project": return removed.has(requirement.resource) ? authenticated() : requirement;
    case "same_project": {
      const kept = requirement.resources.filter(name => !removed.has(name));
      return kept.length >= 2 ? sameProject(...kept) : authenticated();
    }
    case "all": return allOf(...requirement.of.map(part => withoutTransitions(part, declared, removed)));
    default: return requirement;
  }
}
/**
 * Whether the current resolution of a declared slot (`null`: missing) matches
 * a reported result, against its commit-point resolution: `removed` needs it
 * missing, `unchanged` the same version and project, `changed` a new version
 * with the reported project and relation.
 */
function matchesReport(result: TransitionResult, now: ResolvedResource | null, before: ResolvedResource): boolean {
  if (result.kind === "removed") return now === null;
  if (!now) return false;
  if (result.kind === "unchanged") return now.version === before.version && now.projectId === before.projectId;
  return now.version !== before.version && now.projectId === result.projectId && sameRelation(now.relation, result.relation);
}

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
  const transitions = state === "completed" && source.transitions !== undefined ? copyTransitions(source.transitions) : undefined;
  return {
    attempt, fingerprint, state: state as IdempotencyState, resources,
    ...(state === "completed" ? { result: source.result } : {}), ...(transitions ? { transitions } : {}),
  };
}

/** The declared transition slots of an operation, each one a slot of `refs`; `null` when none. */
function transitionSlots(value: unknown, refs: Readonly<Record<string, ResourceRef>>): readonly string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0 || !value.every(name => isSlotName(name) && Object.prototype.hasOwnProperty.call(refs, name))
    || new Set(value).size !== value.length) throw new OperationError("internal", "invalid_operation");
  return Object.freeze([...value] as string[]);
}

/** The secret-bearing hooks of an operation, read once; `null` when it is not secret-bearing. */
interface SecretHooks { receipt(result: unknown): unknown; project(receipt: Receipt, release: ReleaseContext): unknown }

function secretOf(operation: { secret?: unknown; retain?: unknown }): SecretHooks | null {
  const secret: unknown = operation.secret;
  if (secret === undefined) return null;
  const { receipt, projectReceipt } = (typeof secret === "object" && secret !== null ? secret : {}) as Record<string, unknown>;
  if (typeof receipt !== "function" || typeof projectReceipt !== "function" || operation.retain !== true) throw new OperationError("internal", "invalid_operation");
  return {
    receipt: result => (receipt as (r: unknown) => unknown).call(secret, result),
    project: (value, release) => (projectReceipt as (r: Receipt, c: ReleaseContext) => unknown).call(secret, value, release),
  };
}

/**
 * Executes operations as admitted phases. Each phase revalidates the
 * authentication context, re-resolves every resource and re-runs the full
 * decision; nothing from an earlier phase authorizes a later one. Only
 * contexts minted by this module are accepted.
 */
export class OperationRunner {
  readonly #fingerprintKey: Buffer | null;
  /** Open bounded one-event streams per operation ID (`StreamOperation.wait`). */
  readonly #waiters = new Map<string, number>();

  constructor(private readonly runtime: OperationRuntime) {
    const key: unknown = runtime.fingerprintKey;
    if (key !== undefined && (!(key instanceof Uint8Array) || key.byteLength < 32)) throw new TypeError("The fingerprint key needs at least 32 bytes.");
    this.#fingerprintKey = key ? Buffer.from(key as Uint8Array) : null;
  }

  private get deadline(): number { return this.runtime.completionDeadlineMs ?? 60_000; }

  /**
   * Keyed digest of an operation's canonical input. The canonical text itself
   * never leaves this call. `unavailable` when the runtime has no key.
   */
  private fingerprint(operationId: string, canonical: string): string {
    const key = this.#fingerprintKey;
    if (!key) throw new OperationError("unavailable", "idempotency_unavailable");
    return FINGERPRINT_VERSION + createHmac("sha256", key).update(operationId, "utf8").update("\u0000", "utf8").update(canonical, "utf8").digest("hex");
  }

  /** Every current project, validated and frozen. Must run inside an admitted phase. */
  private projects(): readonly ProjectId[] {
    const list: unknown = synchronous(this.runtime.resolver.listProjects(), "resolver_not_synchronous");
    if (!Array.isArray(list) || !list.every(item => typeof item === "string" && item.length > 0)) throw new OperationError("internal", "invalid_project_list");
    return Object.freeze([...list] as ProjectId[]);
  }

  /**
   * Must run inside an admitted phase. Decision Y: everything that can fail
   * independently of the referenced resources runs first: authority
   * revalidation (and the listener exclusion), the clock, the grants snapshot,
   * the effective permissions (every `GrantsSnapshot` call) and, for an
   * `any_project` requirement, the current project list.
   */
  private prepare(context: AuthenticationContext, gate: Gate, check?: (now: number) => void): Prepared {
    const { authority, credential } = currentAuthorityWithCredential(context);
    if (!listenerAllowed({ excludedListeners: gate.excluded }, authority.listener)) throw notRegistered();
    const now = synchronous(this.runtime.now(), "runtime_not_synchronous");
    check?.(now);
    const grants: GrantsSnapshot = synchronous(this.runtime.grants(), "runtime_not_synchronous");
    const permissions = effectivePermissions(authority.actor, grants);
    const projects = usesAnyProject(gate.requirement.require) ? this.projects() : undefined;
    return { authority, credential, permissions, grants, projects, now };
  }

  /** The pure decision on resources already resolved. Throws a typed denial. */
  private decided(prepared: Prepared, requirement: OperationRequirement, resources: ResolvedResources): Phase {
    const { authority, permissions, now, projects, credential } = prepared;
    const decision = decideWith({ authority, requirement, resources, permissions, now, projects, credential });
    if (!decision.allowed) throw new OperationError(decision.category, decision.reason);
    const release = createReleaseContext(authority, decision.permissions, resources, collectionPermissions(requirement.require));
    return { ...prepared, resources, permissions: decision.permissions, release };
  }

  /** Resolution after everything resource-independent, then only `decideWith` (decision Y). */
  private decideOn(prepared: Prepared, gate: Gate, refs: Readonly<Record<string, ResourceRef>>): Phase {
    const resources = resolveAll(this.runtime.resolver, refs);
    return this.decided(prepared, gate.requirement, resources);
  }

  /** Must run inside an admitted phase. Throws a typed denial. `check` is a release policy, applied as in `prepare`. */
  private admit(context: AuthenticationContext, gate: Gate, refs: Readonly<Record<string, ResourceRef>>, check?: (now: number) => void): Phase {
    return this.decideOn(this.prepare(context, gate, check), gate, refs);
  }

  /** A fresh decision that also requires an unchanged resolution and no abort. Must run inside an admitted phase. */
  private recheck(context: AuthenticationContext, gate: Gate, refs: Readonly<Record<string, ResourceRef>>,
    expected: ResolvedResources, signal: AbortSignal | undefined, check?: (now: number) => void): Phase {
    const phase = this.admit(context, gate, refs, check);
    if (!sameResolution(expected, phase.resources)) throw new OperationError("conflict", "resource_changed");
    if (signal?.aborted) throw cancelled();
    return phase;
  }

  private scope(phase: Phase, signal: AbortSignal | undefined, live: Liveness): PhaseScope {
    const { authority, resources, release, now, grants } = phase;
    const resolver = this.runtime.resolver;
    return {
      authority, resources, release, resolver, now, signal,
      authorizePrincipal: (principal, requirement, over) => {
        if (!live.open) throw phaseClosed();
        let needsProjects = false;
        try { needsProjects = usesAnyProject(frozenOperationRequirement(requirement).require); } catch { /* decideForPrincipal denies it */ }
        const projects = phase.projects ?? (needsProjects ? this.projects() : undefined);
        return decideForPrincipal({
          principal, requirement, resources: over ?? resources, grants, now, projects, mode: authority.mode, listener: authority.listener,
        });
      },
    };
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
   * Listener exclusion before any input is parsed. A context that is not
   * minted here passes this check and is refused as `unauthenticated` by the
   * first phase; an excluded listener is checked again there.
   */
  private registeredFor(operation: { excludedListeners?: readonly ListenerKind[] }, context: AuthenticationContext): boolean {
    const listener = mintedListener(context);
    return listener === null || listenerAllowed(operation, listener);
  }

  /** The retained result released through the projector, or a secret-bearing operation's receipt through its own. */
  private projectRetained<I, R, P extends object>(operation: MutationOperation<I, R, P>, retained: unknown, release: ReleaseContext): P {
    const secret = secretOf(operation);
    if (secret) return releaseValue<P>(synchronous(secret.project(receiptValue(retained), release), "projection_not_synchronous"), operation.publicKeys);
    return releaseValue<P>(synchronous(operation.project(retained as R, release), "projection_not_synchronous"), operation.publicKeys);
  }

  /**
   * Replay is a release of historical data: decided against the resources
   * resolved when the result was retained, and only while the current
   * resolution is unchanged. Runs after `admit` allowed the current
   * resolution; the historical decision reuses that phase's permissions and
   * calls no adapter (decision Y).
   */
  private replay<I, R, P extends object>(operation: MutationOperation<I, R, P>, phase: Phase, record: IdempotencyRecord): P {
    const historical = this.decided(phase, operation.requirement, record.resources);
    if (!sameResolution(record.resources, phase.resources)) throw new OperationError("conflict", "resource_changed");
    return this.projectRetained(operation, record.result, historical.release);
  }

  /**
   * Release and replay of an operation with expected transitions (`29cf8fa5`
   * delta 2). Resolves the current state (a declared slot may be missing),
   * then decides on the commit-point resolution (historical authority, the
   * full requirement) and on the resulting resolution (the requirement
   * without predicates on declared slots and without requirements on removed
   * slots), and requires the current resolution to equal the resulting one:
   * the confirmed result for declared slots, the commit point for every
   * other slot. The projector sees only the commit-point resolution.
   */
  private transitionRelease(prepared: Prepared, gate: Gate, refs: Readonly<Record<string, ResourceRef>>,
    commit: ResolvedResources, confirmed: Readonly<Record<string, ResolvedResource | null>>): ReleaseContext {
    const declared = new Set(Object.keys(confirmed));
    const current = resolveAllowingMissing(this.runtime.resolver, refs, declared);
    const historical = this.decided(prepared, gate.requirement, commit);
    const removed = new Set([...declared].filter(name => confirmed[name] === null));
    const resulting = resultingResolution(commit, confirmed);
    this.decided(prepared, { ...gate.requirement, require: withoutTransitions(gate.requirement.require, declared, removed) }, resulting);
    if (!sameResolution(resulting, current)) throw new OperationError("conflict", "resource_changed");
    return historical.release;
  }

  /**
   * `IdleEffectScope.recheck()` past the commit point of an operation with
   * expected transitions: the release rules applied between steps of its
   * effect. Resolves the current state (only a declared slot may be missing),
   * then decides on the commit-point resolution with the full requirement
   * (historical authority) and on the resulting resolution so far without
   * predicates on declared slots and without requirements on slots confirmed
   * removed. The resulting resolution takes, for each declared slot, its
   * current resolution when that matches the result reported so far, and its
   * commit-point resolution when nothing was reported. Finally the current
   * resolution must equal the resulting one, so every undeclared slot is
   * unchanged and every declared slot is unchanged or as reported; otherwise
   * `conflict`/`resource_changed`. Must run inside an admitted phase.
   */
  private transitionRecheck(context: AuthenticationContext, gate: Gate, refs: Readonly<Record<string, ResourceRef>>, slots: readonly string[],
    commit: ResolvedResources, reported: ReadonlyMap<string, TransitionResult>, signal: AbortSignal | undefined): void {
    const prepared = this.prepare(context, gate);
    const declared = new Set(slots);
    const current = resolveAllowingMissing(this.runtime.resolver, refs, declared);
    this.decided(prepared, gate.requirement, commit);
    const confirmed = Object.create(null) as Record<string, ResolvedResource | null>;
    let mismatch = false;
    for (const name of slots) {
      const result = reported.get(name), before = slotOf(commit, name), now = slotOf(current, name) ?? null;
      if (!result) continue;
      if (!before || !matchesReport(result, now, before)) { mismatch = true; continue; }
      Object.defineProperty(confirmed, name, { value: now, enumerable: true });
    }
    const removed = new Set(Object.keys(confirmed).filter(name => confirmed[name] === null));
    const resulting = resultingResolution(commit, confirmed);
    this.decided(prepared, { ...gate.requirement, require: withoutTransitions(gate.requirement.require, declared, removed) }, resulting);
    if (mismatch || !sameResolution(resulting, current)) throw new OperationError("conflict", "resource_changed");
    if (signal?.aborted) throw cancelled();
  }

  /**
   * Confirms the reported results of the declared slots with the resolver.
   * `null` when any slot is unreported, differs from its report, or the
   * resolver fails. Never throws. Must run inside an admitted phase.
   */
  private confirm(refs: Readonly<Record<string, ResourceRef>>, slots: readonly string[], commit: ResolvedResources,
    reported: ReadonlyMap<string, TransitionResult>): Readonly<Record<string, ResolvedResource | null>> | null {
    try {
      const subset: Record<string, ResourceRef> = {};
      for (const name of slots) {
        const descriptor = Object.getOwnPropertyDescriptor(refs, name);
        subset[name] = (descriptor && "value" in descriptor ? descriptor.value : undefined) as ResourceRef;
      }
      const current = resolveAllowingMissing(this.runtime.resolver, subset, new Set(slots));
      const confirmed = Object.create(null) as Record<string, ResolvedResource | null>;
      for (const name of slots) {
        const result = reported.get(name), now = slotOf(current, name) ?? null, before = slotOf(commit, name);
        if (!result || !before || !matchesReport(result, now, before)) return null;
        Object.defineProperty(confirmed, name, { value: now, enumerable: true });
      }
      return Object.freeze(confirmed);
    } catch {
      return null;
    }
  }

  async run<I, R, P extends object>(operation: Operation<I, R, P>, context: AuthenticationContext, raw: unknown, options: RunOptions = {}): Promise<RunResult<P>> {
    try {
      if (!this.registeredFor(operation, context)) return { ok: false, error: failure(notRegistered(), operation.kind === "mutation" ? "not_started" : null, undefined) };
      if (operation.kind === "read") return await this.read(operation, context, raw, options);
      if (operation.kind === "query") return await this.query(operation, context, raw, options);
      return await this.mutate(operation, context, raw, options);
    } catch (error) {
      // Unreachable by design: every path returns an envelope. Kept so `run` can never reject.
      return { ok: false, error: failure(error, null, undefined) };
    }
  }

  /**
   * Reads and commits in one synchronous core admission. An earlier `run`
   * result is never reused: expectedCanonical validates a buffered payload
   * against a fresh read. A commit failure confirms no successful release;
   * it cannot undo bytes the callback already wrote, or promise client receipt.
   */
  async readRelease<I, R, P extends object>(operation: Operation<I, R, P> | StreamOperation<I, R, P>, context: AuthenticationContext,
    raw: unknown, options: ReadReleaseOptions<P>): Promise<ReadReleaseResult> {
    const { signal } = options;
    let refusal: RefusalRelease | undefined, check: ((now: number) => void) | undefined, deadline = 0;
    let gate: Gate | undefined, planned: Planned<I> | undefined;
    try {
      if (operation.kind !== "read") throw new OperationError("internal", "invalid_operation");
      const read = operation as ReadOperation<I, R, P>;
      // Capture the call's policy and payload before waiting for admission.
      const { eligible, connected, expectedCanonical, commit, idempotencyKey } = options;
      deadline = options.deadline;
      if (typeof eligible !== "function" || typeof connected !== "function" || typeof commit !== "function"
        || !Number.isFinite(deadline) || (expectedCanonical !== undefined && typeof expectedCanonical !== "string")) {
        throw new OperationError("invalid_request", "invalid_input");
      }
      refusal = refusalOf(options.refusal, expectedCanonical);
      check = releaseCheck(options, eligible, connected, deadline, signal);
      gate = gateOf(read);
      if (!this.registeredFor(read, context)) throw notRegistered();
      this.idempotency(false, idempotencyKey);
      planned = this.planned(read, raw, gate);
      const ready = planned, policy = check;
      return await this.runtime.admission.run(() => {
        const value = this.readPhase(read, context, ready, signal, policy);
        // canonicalJson runs the strict serializer and sorts object keys;
        // serializeRelease alone returns data, not canonical comparison text.
        if (expectedCanonical !== undefined && canonicalJson(value) !== expectedCanonical) {
          throw new OperationError("conflict", "release_payload_changed");
        }
        return this.commitRelease(options, commit, value, deadline);
      }, { signal });
    } catch (error) {
      const refused = failure(error, null, signal);
      if (!refusal || !gate || !check) return { status: "refused", error: refused };
      const read = operation as ReadOperation<I, R, P>, policy = check, ready = planned, frozenGate = gate;
      // Reproduced in a fresh phase: the full read when its input parsed, otherwise the authority and policy checks before the same input refusal.
      return this.releaseRefusal(refusal, refused, signal, deadline, () => {
        if (!ready) { this.prepare(context, frozenGate, policy); throw error; }
        this.readPhase(read, context, ready, signal, policy);
      });
    }
  }

  private read<I, R, P extends object>(operation: ReadOperation<I, R, P>, context: AuthenticationContext, raw: unknown, options: RunOptions): Promise<RunResult<P>> {
    return this.readWith(operation, context, raw, options, value => value);
  }

  /** Shared read refusals and release checks. `finish` runs before the admitted callback returns, with no await. */
  private async readWith<I, R, P extends object, T>(operation: ReadOperation<I, R, P>, context: AuthenticationContext, raw: unknown,
    options: RunOptions, finish: (value: P) => T, check?: (now: number) => void): Promise<RunResult<T>> {
    const { signal } = options;
    try {
      if (!this.registeredFor(operation, context)) throw notRegistered();
      this.idempotency(false, options.idempotencyKey);
      const planned = this.planned(operation, raw, gateOf(operation));
      const value = await this.runtime.admission.run(() => finish(this.readPhase(operation, context, planned, signal, check)), { signal });
      return { ok: true, value, replayed: false };
    } catch (error) {
      return { ok: false, error: failure(error, null, signal) };
    }
  }

  /** Parse and references, before any admitted phase. Input refusals are `invalid_request`. */
  private planned<I>(operation: { parse(raw: unknown): I; resources(input: I): Readonly<Record<string, ResourceRef>> }, raw: unknown, gate: Gate): Planned<I> {
    const input = this.parse(operation.parse, raw);
    return { input, refs: this.references(operation, input), gate };
  }

  /** The admitted phase of a read: a fresh decision (`check` first), the read and its projection. Must run inside an admitted phase. */
  private readPhase<I, R, P extends object>(operation: ReadOperation<I, R, P>, context: AuthenticationContext, planned: Planned<I>,
    signal: AbortSignal | undefined, check?: (now: number) => void): P {
    const phase = this.decideOn(this.prepare(context, planned.gate, check), planned.gate, planned.refs);
    const live: Liveness = { open: true };
    let result: R;
    try { result = operation.read(planned.input, this.scope(phase, signal, live)); } finally { live.open = false; }
    if (isThenable(result)) { absorb(result); throw new OperationError("internal", "read_not_synchronous"); }
    return releaseValue<P>(synchronous(operation.project(result, phase.release), "projection_not_synchronous"), operation.publicKeys);
  }

  /**
   * Buffered delivery of an operation's refusal: `stage` outside admission,
   * then a fresh admitted phase that runs `reproduce` (which throws the
   * operation's current refusal) and commits the staged refusal only when the
   * fresh public error is identical. Never throws.
   */
  private async releaseRefusal(refusal: RefusalRelease, error: PublicOperationError, signal: AbortSignal | undefined, deadline: number,
    reproduce: () => void): Promise<ReadReleaseResult> {
    if (signal?.aborted || RELEASE_POLICY_REASONS.includes(error.reason)) return { status: "refused", error };
    try {
      const expected = canonicalJson(error);
      await this.runtime.admission.idle(async () => { await Reflect.apply(refusal.stage, refusal, [error]); });
      if (signal?.aborted) throw cancelled();
      return await this.runtime.admission.run((): ReadReleaseResult => {
        let fresh: PublicOperationError | null = null;
        try { reproduce(); } catch (thrown) { fresh = failure(thrown, null, signal); }
        if (fresh === null) throw new OperationError("conflict", "release_payload_changed");
        if (canonicalJson(fresh) !== expected) return { status: "refused", error: fresh };
        return this.commitRelease(refusal, refusal.commit, error, deadline);
      }, { signal });
    } catch (thrown) {
      return { status: "refused", error: failure(thrown, null, signal) };
    }
  }

  /**
   * A query (`29cf8fa5` delta 1): (1) authorization and `plan` in one admitted
   * phase; (2) `work` outside admission, aborted on caller cancellation and at
   * its deadline (`unavailable`, `query_timed_out`, `retry`), whose late
   * settlement is ignored; (3) a fresh decision with the resolution unchanged,
   * then release. A failure of the work is released only after that fresh
   * decision, so a caller who lost access learns nothing from it.
   */
  private async query<I, R, P extends object>(operation: QueryOperation<I, R, P>, context: AuthenticationContext, raw: unknown, options: RunOptions): Promise<RunResult<P>> {
    const { signal } = options;
    try {
      this.idempotency(false, options.idempotencyKey);
      const worked = await this.queryWork(operation, context, raw, signal);
      // 3. A fresh decision on an unchanged resolution before anything is released.
      const value = await this.runtime.admission.run(() => this.queryPhase(operation, context, worked, signal), { signal });
      return { ok: true, value, replayed: false };
    } catch (error) {
      return { ok: false, error: failure(error, null, signal) };
    }
  }

  /** Steps 1 and 2 of a query: the admitted authorization and plan, then the bounded work outside admission. */
  private async queryWork<I, R, P extends object>(operation: QueryOperation<I, R, P>, context: AuthenticationContext, raw: unknown,
    signal: AbortSignal | undefined, check?: (now: number) => void, progress?: QueryProgress<I>): Promise<QueryWorked<R>> {
    const { admission } = this.runtime;
    const work: unknown = operation.work, timeout: unknown = operation.timeoutMs;
    if (typeof work !== "function" || typeof operation.plan !== "function" || (timeout !== undefined && (!Number.isSafeInteger(timeout) || (timeout as number) < 1))) {
      throw new OperationError("internal", "invalid_operation");
    }
    const gate = gateOf(operation);
    const planned = this.planned(operation, raw, gate);
    if (progress) { progress.planned = planned; progress.step = "plan"; }
    const first = await admission.run(() => this.queryStart(operation, context, planned, signal, check), { signal });
    if (signal?.aborted) throw cancelled();
    if (progress) { progress.resources = first.phase.resources; progress.step = "work"; }

    // 2. The asynchronous work, outside admission, bounded and cancellable. A caller that
    //    already holds admission (`run` joins it) is suspended through `idle`, so other
    //    admissions, provider borrows included, proceed while the work waits.
    const outcome = await admission.idle(async (): Promise<{ ok: true; value: R } | { ok: false; error: unknown }> => {
      const controller = new AbortController();
      const limit = Math.min((timeout as number | undefined) ?? Number.POSITIVE_INFINITY, this.runtime.queryDeadlineMs ?? 30_000);
      let timedOut = false;
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limit);
      timer.unref?.();
      try {
        let pending: Promise<R>;
        try { pending = Promise.resolve((work as (plan: unknown, signal: AbortSignal) => Promise<R>).call(operation, first.plan, controller.signal)); }
        catch (error) { pending = Promise.reject(error); }
        try {
          const settled = await untilAbort(pending, controller.signal);
          if (!settled) throw timedOut && !signal?.aborted ? new OperationError("unavailable", "query_timed_out", { retry: "retry" }) : cancelled();
          return { ok: true, value: settled.value };
        } catch (error) {
          if (controller.signal.aborted) throw timedOut && !signal?.aborted ? new OperationError("unavailable", "query_timed_out", { retry: "retry" }) : cancelled();
          return { ok: false, error };
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    });
    if (progress) progress.step = "release";
    return { gate, refs: planned.refs, resources: first.phase.resources, outcome };
  }

  /** Step 1 of a query: a fresh decision (`check` first) and the synchronous plan. Must run inside an admitted phase. */
  private queryStart<I, R, P extends object>(operation: QueryOperation<I, R, P>, context: AuthenticationContext, planned: Planned<I>,
    signal: AbortSignal | undefined, check?: (now: number) => void): { phase: Phase; plan: unknown } {
    const phase = this.decideOn(this.prepare(context, planned.gate, check), planned.gate, planned.refs);
    const live: Liveness = { open: true };
    try { return { phase, plan: synchronous(operation.plan(planned.input, this.scope(phase, signal, live)), "plan_not_synchronous") }; } finally { live.open = false; }
  }

  /**
   * Step 3 of a query. Must run inside an admitted phase: a fresh decision
   * (with `check` first, decision Y), the resolution of step 1 unchanged and no
   * abort; only then a failure of the work, or the projection of its result.
   */
  private queryPhase<I, R, P extends object>(operation: QueryOperation<I, R, P>, context: AuthenticationContext, worked: QueryWorked<R>,
    signal: AbortSignal | undefined, check?: (now: number) => void): P {
    const phase = this.decideOn(this.prepare(context, worked.gate, check), worked.gate, worked.refs);
    if (!sameResolution(worked.resources, phase.resources)) throw new OperationError("conflict", "resource_changed");
    if (signal?.aborted) throw cancelled();
    if (!worked.outcome.ok) throw worked.outcome.error;
    return releaseValue<P>(synchronous(operation.project(worked.outcome.value, phase.release), "projection_not_synchronous"), operation.publicKeys);
  }

  /**
   * Releases a query inside the admitted phase of its step 3, as `readRelease`
   * does for a read: the same eligibility, connection, deadline and signal
   * checks (also before step 1), and `commit` called synchronously inside that
   * phase. With `stage`, step 3 runs twice: the first fresh decision projects
   * a value that `stage` may prepare outside admission (for example a buffered
   * protocol envelope); the second takes a fresh decision again on the same
   * resolution, re-projects the same work result, refuses a different
   * canonical value (`conflict`/`release_payload_changed`) and only then
   * commits. The work runs once; nothing it found is released without the
   * final decision. `stage` must not write to the caller.
   */
  async queryRelease<I, R, P extends object>(operation: AnyOperation, context: AuthenticationContext, raw: unknown,
    options: ReadReleaseOptions<P> & { stage?(value: P): Promise<void> }): Promise<ReadReleaseResult> {
    const { signal } = options;
    const progress: QueryProgress<I> = { step: "input" };
    let refusal: RefusalRelease | undefined, check: ((now: number) => void) | undefined, deadline = 0;
    let worked: QueryWorked<R> | undefined;
    const query = operation as QueryOperation<I, R, P>;
    try {
      if (operation.kind !== "query") throw new OperationError("internal", "invalid_operation");
      const { eligible, connected, commit, stage, idempotencyKey } = options;
      deadline = options.deadline;
      if (typeof eligible !== "function" || typeof connected !== "function" || typeof commit !== "function"
        || !Number.isFinite(deadline) || (stage !== undefined && typeof stage !== "function") || options.expectedCanonical !== undefined) {
        throw new OperationError("invalid_request", "invalid_input");
      }
      refusal = refusalOf(options.refusal, undefined);
      check = releaseCheck(options, eligible, connected, deadline, signal);
      if (!this.registeredFor(query, context)) throw notRegistered();
      this.idempotency(false, idempotencyKey);
      const policy = check;
      const done = await this.queryWork(query, context, raw, signal, policy, progress);
      worked = done;
      const { admission } = this.runtime;
      let expected: string | undefined;
      if (stage) {
        const staged = await admission.run(() => this.queryPhase(query, context, done, signal, policy), { signal });
        expected = canonicalJson(staged);
        // From here a refusal is never staged: `stage` already prepared this call's one envelope.
        progress.step = "staged";
        await admission.idle(async () => { await Reflect.apply(stage, options, [staged]); });
        if (signal?.aborted) throw cancelled();
      }
      return await admission.run((): ReadReleaseResult => {
        const value = this.queryPhase(query, context, done, signal, policy);
        if (expected !== undefined && canonicalJson(value) !== expected) throw new OperationError("conflict", "release_payload_changed");
        return this.commitRelease(options, commit, value, deadline);
      }, { signal });
    } catch (error) {
      const refused = failure(error, null, signal);
      if (!refusal || !check || progress.step === "staged") return { status: "refused", error: refused };
      const policy = check, { step, planned, resources } = progress, done = worked;
      // Reproduced by the step that refused, in a fresh admitted phase; the work never runs again.
      return this.releaseRefusal(refusal, refused, signal, deadline, () => {
        if (step === "release" && done) { this.queryPhase(query, context, done, signal, policy); return; }
        if (step === "plan" && planned) { this.queryStart(query, context, planned, signal, policy); return; }
        if (step === "work" && planned && resources) {
          // The work itself failed (a timeout or cancellation): the same decision on the same resolution, then the same failure.
          const phase = this.decideOn(this.prepare(context, planned.gate, policy), planned.gate, planned.refs);
          if (!sameResolution(resources, phase.resources)) throw new OperationError("conflict", "resource_changed");
          throw error;
        }
        // Input refusals: the authority and policy checks, then the same refusal.
        this.prepare(context, gateOf(query), policy);
        throw error;
      });
    }
  }

  /** The last deadline check and the synchronous commit, inside the caller's admitted phase. */
  private commitRelease<P>(options: object, commit: (value: P) => void, value: P, deadline: number): ReadReleaseResult {
    const now = this.runtime.now();
    if (isThenable(now)) absorb(now);
    if (!Number.isFinite(now) || now >= deadline) throw new OperationError("unavailable", "release_timed_out", { retry: "retry" });
    try {
      synchronous(Reflect.apply(commit, options, [value]), "release_commit_failed");
      return { status: "committed" };
    } catch {
      // The write may have partially happened. Never retry or expose its thrown value.
      return { status: "commit_failed", error: failure(new OperationError("internal", "release_commit_failed"), null, undefined) };
    }
  }

  private async mutate<I, R, P extends object>(operation: MutationOperation<I, R, P>, context: AuthenticationContext, raw: unknown, options: RunOptions): Promise<RunResult<P>> {
    // Read once, before planning: planning, its classification and every phase use this one plain snapshot.
    const { signal, idempotencyKey } = options;
    let planned: MutationPlan<I>;
    try { planned = this.mutationPlan(operation, raw, idempotencyKey, false); } catch (error) {
      return { ok: false, error: failure(error, "not_started", signal) };
    }
    // Without a delivery, `execute` always returns a result; `null` is only its hand-over to a delivery.
    return await this.execute(operation, context, planned, { signal, idempotencyKey }, null) as RunResult<P>;
  }

  /**
   * Everything of a mutation before its first admitted phase: the effect, the
   * key, decision V's canonical input and its fingerprint, the secret hooks,
   * the parsed input, its references and the transition slots. Throws a typed
   * refusal. `admittedOnly` (for `mutationRelease`) also refuses an `acquire`
   * and an idle effect as `internal`/`invalid_operation`.
   */
  private mutationPlan<I, R, P extends object>(operation: MutationOperation<I, R, P>, raw: unknown, idempotencyKey: string | undefined,
    admittedOnly: boolean): MutationPlan<I> {
    const plan = effectPlan(operation.effect);
    if (admittedOnly && (plan.mode !== "admitted" || operation.acquire !== undefined)) throw new OperationError("internal", "invalid_operation");
    const gate = gateOf(operation);
    const store = this.idempotency(operation.retain === true, idempotencyKey);
    // Decision V: an operation that declares retention accepts JSON-domain input only, with or
    // without a key; `parse` sees its canonical copy. The fingerprint is a keyed digest of the
    // canonical text (`29cf8fa5` delta 7), computed only for a request that carries a key.
    let source: unknown = raw, canonical = "";
    if (operation.retain === true) {
      try { source = serializeRelease(raw); canonical = canonicalJson(source); } catch { throw new OperationError("invalid_request", "invalid_input"); }
    }
    const print = store && idempotencyKey !== undefined ? this.fingerprint(operation.id, canonical) : "";
    canonical = "";
    const secret = secretOf(operation);
    const input = this.parse(operation.parse, source);
    const refs = this.references(operation, input);
    const transitions = transitionSlots(operation.transitions, refs);
    return { plan, gate, store, print, secret, input, refs, transitions };
  }

  /**
   * Phases 1 to 5 of a mutation. Without `delivery` (`run`) it returns the
   * result. With one (`mutationRelease`) every answer is decided in
   * `delivery.outcome`: committed or refused inside the admitted phase that
   * established it, or returned from the fallback paths; it then returns
   * `null`, or the result of a path that never reached an admitted callback.
   */
  private async execute<I, R, P extends object>(operation: MutationOperation<I, R, P>, context: AuthenticationContext, planned: MutationPlan<I>,
    options: RunOptions, delivery: MutationDelivery<P> | null): Promise<RunResult<P> | null> {
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
      /**
       * The refusing admitted callback of a delivery already attempted to give
       * the reservation back (confirmed or not), so `finally` never repeats it.
       */
      givenBack: boolean;
      /** Resources of the phase that admitted the effect (its commit point). */
      resources?: ResolvedResources;
      /** Results the handler reported for its declared transition slots. */
      reported: Map<string, TransitionResult>;
      /** Results confirmed by the resolver at completion; `null` when confirmation failed. */
      confirmed?: Readonly<Record<string, ResolvedResource | null>> | null;
    } = { effect: "not_started", final: "pending", givenBack: false, reported: new Map() };
    /** Refusals produced by `recheck()` of this attempt, recognized by identity when a handler rethrows one. */
    const refusals = new WeakSet<object>();
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
    const finalRecord = (status: "completed" | "unknown", resources: ResolvedResources, result?: unknown,
      transitions?: Readonly<Record<string, ResolvedResource | null>>): IdempotencyRecord => {
      const reservation = state.reservation!;
      return {
        attempt: reservation.attempt, fingerprint: reservation.fingerprint, resources, state: status,
        ...(status === "completed" ? { result } : {}), ...(status === "completed" && transitions ? { transitions } : {}),
      };
    };
    /**
     * Reservation before answer (delivery only): inside the admitted callback
     * that refuses a fresh, owned attempt before its commit point, after the
     * handler's own transaction unwound, the reservation is given back
     * synchronously before the refusal is delivered. Attempted once; a release
     * that throws or returns a thenable is unconfirmed (decision W) and the
     * refusal stands. That includes a release the store refuses because a
     * broken handler left its transaction open (`idempotency_in_transaction`):
     * the runner cannot tell that refusal from any other, so it never falls
     * back to the completion path; the record is left to the store's repair.
     */
    const giveBack = (): void => {
      const reservation = state.reservation;
      if (!reservation || state.effect !== "not_started" || state.final !== "pending" || state.givenBack) return;
      state.givenBack = true;
      try { synchronous(reservation.store.release({ ...reservation.key }, reservation.attempt), "idempotency_store_not_synchronous"); } catch {
        // Unconfirmed: the record may stay `reserved` until the next start's repair; no immediate retry is promised.
      }
    };
    /** A delivery's refusal before the effect: the reservation back first, then the refusal inside this phase. */
    const refuseBeforeEffect = (release: MutationDelivery<P>, guard: PhaseGuard, error: unknown): void => {
      giveBack();
      release.outcome = this.refuseIn(release, guard, error, "not_started");
    };
    try {
      const { plan, gate, store, print, secret, input, refs, transitions } = planned;

      type First = { kind: "replay"; value: P; record: IdempotencyRecord } | { kind: "fresh"; phase: Phase };
      /** Phase 1 after `prepare`: the reservation, or an answer from an existing record. Must run inside an admitted phase. */
      const admitFirst = (prepared: Prepared): First => {
        if (store && idempotencyKey !== undefined) {
          const key: IdempotencyKey = Object.freeze({ operationId: operation.id, principal: principalKey(prepared.authority), idempotencyKey });
          const lookup = () => readRecord(synchronous(store.get({ ...key }), "idempotency_store_not_synchronous"));
          const existing = (record: IdempotencyRecord, replay: () => P): never | P => {
            if (record.fingerprint !== print) throw new OperationError("conflict", "idempotency_conflict");
            if (record.state === "completed") return replay();
            if (record.state === "unknown") throw new OperationError("outcome_unknown", "previous_attempt_outcome_unknown", { effect: "unknown" });
            throw new OperationError("conflict", "request_in_progress");
          };
          let phase: Phase;
          if (transitions) {
            // The current resolution may legitimately differ from the commit point after the
            // operation's own transition, so the record is read before anything is resolved.
            const record = lookup();
            if (record) {
              // Decided on the record's own resolution (its commit point once started) before its
              // state is reported: a caller who lost access to what the attempt was authorized
              // against learns nothing about it, not even a conflict or an unknown outcome.
              this.decided(prepared, gate.requirement, record.resources);
              return { kind: "replay" as const, record, value: existing(record, () => {
                if (!record.transitions) throw new OperationError("internal", "invalid_idempotency_record");
                return this.projectRetained(operation, record.result, this.transitionRelease(prepared, gate, refs, record.resources, record.transitions));
              }) };
            }
            phase = this.decideOn(prepared, gate, refs);
          } else {
            phase = this.decideOn(prepared, gate, refs);
            const record = lookup();
            if (record) return { kind: "replay" as const, record, value: existing(record, () => this.replay(operation, phase, record)) };
          }
          const attempt = randomUUID();
          // Owned before the write: a write that lands and then throws is still given back in `finally`.
          state.reservation = { store, key, attempt, fingerprint: print };
          synchronous(store.put({ ...key }, { attempt, fingerprint: print, resources: phase.resources, state: "reserved" }), "idempotency_store_not_synchronous");
          return { kind: "fresh" as const, phase };
        }
        return { kind: "fresh" as const, phase: this.decideOn(prepared, gate, refs) };
      };

      // 1. Admission: authority, resources, requirement; the idempotency reservation or a replay.
      //    A delivery checks its release policy first and answers inside this phase.
      const first = await admission.run((): First | { kind: "delivered" } => {
        const guard = delivery ? this.guard(delivery) : undefined;
        try {
          const answer = admitFirst(this.prepare(context, gate, guard?.check));
          if (delivery && guard && answer.kind === "replay" && !delivery.stage) {
            delivery.outcome = this.deliver(delivery, delivery.commit, answer.value, "not_started");
            return { kind: "delivered" };
          }
          return answer;
        } catch (error) {
          if (!delivery || !guard) throw error;
          refuseBeforeEffect(delivery, guard, error);
          return { kind: "delivered" };
        }
      }, { signal });
      if (first.kind === "delivered") return null;
      if (first.kind === "replay") {
        if (!delivery) return { ok: true, value: first.value, replayed: true };
        // Buffered replay: the final phase repeats the current and the historical decision on the
        // validated record evidence captured here, and never reads the store again.
        const record = first.record;
        await this.staged(delivery, first.value, "not_started", guard => {
          const prepared = this.prepare(context, gate, guard.check);
          if (transitions) {
            this.decided(prepared, gate.requirement, record.resources);
            if (!record.transitions) throw new OperationError("internal", "invalid_idempotency_record");
            return this.projectRetained(operation, record.result, this.transitionRelease(prepared, gate, refs, record.resources, record.transitions));
          }
          return this.replay(operation, this.decideOn(prepared, gate, refs), record);
        });
        return null;
      }
      const initial = first.phase;

      // 2. Optional SQL-free wait (for example a project lock) outside admission.
      //    Ownership is recorded the moment the acquire resolves, inside the
      //    callback, so a failed re-admission still releases it exactly once.
      //    A delivery refused `acquire` before any admission.
      if (!delivery && operation.acquire) {
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
      /**
       * Past the commit point anything thrown is an unknown outcome, except a
       * `recheck()` refusal rethrown unchanged: the steps before it happened
       * and the refused one never began, so it keeps its category with effect
       * `committed`. Before the point, a refusal that never began.
       */
      const fail = (error: unknown): void => {
        crossing.closed = true;
        if (crossing.crossed) {
          if (typeof error === "object" && error !== null && refusals.has(error)) {
            state.outcome = { ok: false, error: classify(error, "committed") };
            state.effect = "committed";
            return;
          }
          state.outcome = { ok: false, error };
          state.effect = "unknown";
          return;
        }
        throw classifyBeforeCommit(crossing.refusal ?? error);
      };
      const closed = () => new OperationError("internal", "effect_scope_closed");
      /** `EffectScope.transition`: records a result for a declared slot, past the commit point and before settling. */
      const transition = (name: string, result: TransitionResult): void => {
        if (crossing.closed) throw closed();
        if (!crossing.crossed) throw new OperationError("internal", "transition_before_commit");
        if (!transitions || !transitions.includes(name)) throw new OperationError("internal", "undeclared_transition");
        const copy = copyTransitionResult(result);
        if (!copy) throw new OperationError("internal", "invalid_transition");
        state.reported.set(name, copy);
      };
      /**
       * `IdleEffectScope.recheck`: a fresh decision in its own admitted phase against the
       * commit-point resolution. Past the commit point, declared transition slots follow the
       * release rules (`transitionRecheck`), so the effect's own reported steps do not refuse it.
       */
      const recheck = (): Promise<void> => {
        if (crossing.closed) return Promise.reject(closed());
        const expected = state.resources ?? initial.resources;
        const pending = admission.run(() => {
          if (transitions && crossing.crossed) this.transitionRecheck(context, gate, refs, transitions, expected, state.reported, signal);
          else this.recheck(context, gate, refs, expected, signal);
          if (crossing.closed) throw closed();
        }, { signal }).catch((error: unknown) => {
          const refusal = classifyBeforeCommit(cancellationOr(error, "not_started", signal));
          refusals.add(refusal);
          throw refusal;
        });
        pending.catch(() => undefined);
        return pending;
      };
      try {
        await admission.run(async () => {
          const guard = delivery ? this.guard(delivery) : undefined;
          try {
            const phase = this.recheck(context, gate, refs, initial.resources, signal, guard?.check);
            state.resources = phase.resources;
            if (plan.commitPoint === "entry") cross(phase.resources);
            if (plan.mode === "admitted") {
              // Synchronous: `commit()` marks the point in this same admitted phase, after this phase's decision.
              const live: Liveness = { open: true };
              const base: EffectScope = { ...this.scope(phase, signal, live), transition };
              const scope = plan.commitPoint === "declared"
                ? Object.freeze({ ...base, commit: (): void => { if (crossing.closed) throw closed(); if (!crossing.crossed) cross(phase.resources); } })
                : Object.freeze(base);
              let value: unknown;
              try { value = plan.run(input, scope); } catch (error) { live.open = false; fail(error); return; }
              live.open = false;
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
                  const fresh = this.recheck(context, gate, refs, initial.resources, signal);
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
            // An idle effect runs outside admission: `authorizePrincipal` is closed from the start.
            const base: IdleEffectScope = { ...this.scope(phase, signal, { open: false }), transition, recheck };
            const scope = plan.commitPoint === "declared" ? Object.freeze({ ...base, commit }) : Object.freeze(base);
            await idleWithCompletion(admission, async () => {
              let value: R;
              try { value = (await plan.run(input, scope)) as R; } catch (error) { fail(error); return; }
              settle(value);
            }, { deadlineMs: this.deadline });
          } catch (error) {
            if (!delivery || !guard) throw error;
            // A delivery runs admitted effects only, so this is still the admitted phase that refused.
            if (state.effect === "not_started") { refuseBeforeEffect(delivery, guard, error); return; }
            // Past the commit point without a settled outcome: an unknown outcome, completed and released like any other.
            if (!state.outcome) { crossing.closed = true; state.effect = "unknown"; state.outcome = { ok: false, error }; }
          }
        }, { signal });
      } catch (error) {
        // A refused re-admission after a settled effect does not hide its outcome.
        if (!state.outcome) throw error;
      }
      if (delivery?.outcome) return null;
      const settled = state.outcome;
      if (!settled) throw new OperationError("internal", "effect_not_settled");
      const effectResources = state.resources ?? initial.resources;
      /** The value the first release projects: the effect's result, or its normalized copy once retained. */
      let released: { value: R } | null = settled.ok ? { value: settled.value } : null;

      // 4. Mandatory completion of an effect that began, under reserved
      //    admission and without an authority check: finalization, the
      //    confirmation of declared transitions, then the lease release, then
      //    the idempotency record (decision R). A failed finalization or lease
      //    release records `unknown`, never `completed`. Each step is
      //    confirmed only when its synchronous callback returned normally; a
      //    thenable is a failed step (decision W). An unconfirmed transition
      //    or a failed receipt records `unknown` as well. Never checks a
      //    delivery's release policy: it completes when the caller is gone.
      const reservation = state.reservation;
      if (operation.finalize || reservation || (transitions && settled.ok)) {
        try {
          await this.complete(() => {
            let failed = false;
            try { synchronous(operation.finalize?.(input, settled, { resources: effectResources }), "finalize_not_synchronous"); } catch { failed = true; }
            // Confirmed while the lifecycle lease is still held, so the result read is the effect's own.
            if (transitions && settled.ok) state.confirmed = this.confirm(refs, transitions, effectResources, state.reported);
            if (!releaseLease()) failed = true;
            if (reservation) {
              // Decision Z: from here this callback owns the final write; `finally` never writes for this attempt.
              state.final = "unconfirmed";
              const write = (record: IdempotencyRecord) =>
                synchronous(reservation.store.put({ ...reservation.key }, record), "idempotency_store_not_synchronous");
              let retained: { value: unknown } | null = null;
              if (settled.ok && !failed && (!transitions || state.confirmed)) {
                // A secret-bearing operation retains only its receipt; a receipt that fails retains nothing.
                // An ordinary result is normalized once (decision V's domain, `-0` is `0`): the store keeps
                // and the first release projects the same copy, so a replay is equivalent to it.
                try {
                  if (secret) retained = { value: receiptValue(synchronous(secret.receipt(settled.value), "receipt_not_synchronous")) };
                  else { const normalized = serializeRelease(settled.value) as R; released = { value: normalized }; retained = { value: normalized }; }
                } catch { failed = true; }
              }
              try {
                write(retained ? finalRecord("completed", effectResources, retained.value, state.confirmed ?? undefined) : finalRecord("unknown", effectResources));
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

      // 5. Release only after a fresh decision on current authority and resources. A delivery's
      //    `check` runs after revalidation; the same projection input serves its final phase.
      const releaseNow = (check?: (now: number) => void): P => {
        if (transitions) {
          const prepared = this.prepare(context, gate, check);
          if (settled.ok && state.confirmed && state.effect !== "cleanup_unconfirmed") {
            const release = this.transitionRelease(prepared, gate, refs, effectResources, state.confirmed);
            return releaseValue<P>(synchronous(operation.project(released!.value, release), "projection_not_synchronous"), operation.publicKeys);
          }
          // Nothing about the outcome reaches a caller who lost access to what the effect was authorized against.
          this.decided(prepared, gate.requirement, effectResources);
          if (state.effect === "cleanup_unconfirmed") throw new OperationError("unavailable", "finalization_unconfirmed", { effect: state.effect });
          if (!settled.ok) throw settled.error;
          throw new OperationError("conflict", "transition_unconfirmed", { effect: "committed" });
        }
        const phase = this.admit(context, gate, refs, check);
        if (!sameResolution(effectResources, phase.resources)) throw new OperationError("conflict", "resource_changed");
        if (state.effect === "cleanup_unconfirmed") throw new OperationError("unavailable", "finalization_unconfirmed", { effect: state.effect });
        if (!settled.ok) throw settled.error;
        return releaseValue<P>(synchronous(operation.project(released!.value, phase.release), "projection_not_synchronous"), operation.publicKeys);
      };
      if (!delivery) {
        const value = await admission.run(() => releaseNow(), { reserved: true });
        return { ok: true, value, replayed: false };
      }
      const staging = await admission.run((): { value: P } | null => {
        const guard = this.guard(delivery);
        let value: P;
        try { value = releaseNow(guard.check); } catch (error) {
          delivery.outcome = this.refuseIn(delivery, guard, error, state.effect);
          return null;
        }
        if (!delivery.stage) { delivery.outcome = this.deliver(delivery, delivery.commit, value, state.effect); return null; }
        return { value };
      }, { reserved: true });
      if (staging) await this.staged(delivery, staging.value, state.effect, guard => releaseNow(guard.check));
      return null;
    } catch (error) {
      return { ok: false, error: failure(error, state.effect, signal) };
    } finally {
      releaseLease();
      const reservation = state.reservation;
      // Only for attempts whose completion callback never ran: once it ran, it alone wrote (or failed to write) the final record.
      // A delivery's refusing callback that already gave the reservation back is never repeated here.
      if (reservation && state.final === "pending" && !state.givenBack) {
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

  /**
   * Releases a mutation inside admission (D2b-1). Success and every refusal
   * are written synchronously inside the admitted phase that established them:
   * `refuse(error)` in phase 1 (decision, reservation, an existing record,
   * capacity), in phase 3 (the final check, a changed resolution, a typed
   * refusal before the commit point) and in step 5 (an outcome after the
   * effect, a fresh denial); a refusal found before any admission (input,
   * key, store, the definition) in one admitted phase that first revalidates
   * the context and applies the release policy. A fresh owned attempt refused
   * before its commit point gets its reservation back in the refusing phase,
   * before the refusal is written. A request has at most one delivery attempt:
   * a `commit` or `refuse` that throws or returns a thenable is
   * `commit_failed`, terminal and never followed by another write. Only the
   * release policy's refusals, a refused admission whose callback never ran
   * and a failed `stage` are returned as `refused` without a write.
   *
   * Only an admitted effect without `acquire` is accepted; anything else is
   * `internal`/`invalid_operation` before any reservation. With `stage`, a
   * success (or replay) is projected, staged once outside admission and
   * written only inside a final reserved admission that repeats the release
   * decisions on the captured projection input, reads no record and compares
   * the canonical DTO.
   */
  async mutationRelease<P extends object>(operation: AnyOperation, context: AuthenticationContext, raw: unknown,
    options: MutationReleaseOptions<P>): Promise<MutationReleaseResult> {
    let delivery: MutationDelivery<P>;
    let idempotencyKey: string | undefined, commit: unknown, stage: unknown, unsupported: unknown;
    try {
      // Capture the call's policy and callbacks once, before the first admission.
      const signal = options.signal;
      const { eligible, connected, refuse, deadline } = options;
      ({ commit, stage, idempotencyKey } = options);
      unsupported = (options as { expectedCanonical?: unknown }).expectedCanonical !== undefined || (options as { refusal?: unknown }).refusal !== undefined;
      // Without a usable refusal callback or policy nothing can be written: returned locally.
      if (typeof eligible !== "function" || typeof connected !== "function" || typeof refuse !== "function" || !Number.isFinite(deadline)) {
        throw new OperationError("invalid_request", "invalid_input");
      }
      delivery = {
        receiver: options, commit: commit as (value: P) => void, refuse, stage: undefined, deadline, signal,
        check: releaseCheck(options, eligible, connected, deadline, signal), policy: new WeakSet(), attempted: false, outcome: null,
      };
    } catch (error) {
      return { status: "refused", error: failure(error, "not_started", undefined) };
    }
    let planned: MutationPlan<unknown>;
    const mutation = operation as MutationOperation<unknown, unknown, P>;
    try {
      if (typeof commit !== "function" || (stage !== undefined && typeof stage !== "function") || unsupported) throw new OperationError("invalid_request", "invalid_input");
      if (stage !== undefined) delivery.stage = stage as (value: P) => Promise<void>;
      if (operation.kind !== "mutation") throw new OperationError("internal", "invalid_operation");
      // The listener exclusion before the input is parsed, as in `run()`.
      if (!this.registeredFor(mutation, context)) throw notRegistered();
      planned = this.mutationPlan(mutation, raw, idempotencyKey, true);
    } catch (error) {
      return this.earlyRefusal(delivery, context, operation, error);
    }
    const result = await this.execute(mutation, context, planned, { signal: delivery.signal, idempotencyKey }, delivery);
    if (delivery.outcome) return delivery.outcome;
    // Only a path that never reached an admitted callback (a refused admission, the abort check between phases).
    if (result && !result.ok) return { status: "refused", error: result.error };
    return { status: "refused", error: failure(new OperationError("internal", "unexpected_failure"), "not_started", undefined) };
  }

  /**
   * A refusal found before any admission (decision 2): one admitted phase
   * revalidates the context and the listener and applies the release policy,
   * then writes the refusal, or the revalidation's own answer instead. Never
   * throws.
   */
  private async earlyRefusal<P>(delivery: MutationDelivery<P>, context: AuthenticationContext, operation: unknown, error: unknown): Promise<MutationReleaseResult> {
    let excluded: unknown;
    // An unreadable exclusion fails closed: the operation is registered nowhere.
    try { excluded = (operation as { excludedListeners?: unknown }).excludedListeners; } catch { excluded = null; }
    try {
      await this.runtime.admission.run(() => {
        const guard = this.guard(delivery);
        let answer: unknown = error;
        try {
          const { authority } = currentAuthorityWithCredential(context);
          if (!listenerAllowed({ excludedListeners: excluded as readonly ListenerKind[] | undefined }, authority.listener)) throw notRegistered();
          guard.check(synchronous(this.runtime.now(), "runtime_not_synchronous"));
        } catch (thrown) { answer = thrown; }
        delivery.outcome = this.refuseIn(delivery, guard, answer, "not_started");
      }, { signal: delivery.signal });
    } catch (thrown) {
      if (!delivery.outcome) delivery.outcome = { status: "refused", error: failure(thrown, "not_started", delivery.signal) };
    }
    return delivery.outcome ?? { status: "refused", error: failure(new OperationError("internal", "unexpected_failure"), "not_started", undefined) };
  }

  /** The release policy of one admitted phase of a delivery; a refusal it throws is recognized by identity. */
  private guard<P>(delivery: MutationDelivery<P>): PhaseGuard {
    const guard: PhaseGuard = {
      passed: false,
      check: (now: number) => {
        try { delivery.check(now); } catch (error) {
          if (typeof error === "object" && error !== null) delivery.policy.add(error);
          throw error;
        }
        guard.passed = true;
      },
    };
    return guard;
  }

  /**
   * The deadline check immediately before the write, then the one delivery
   * attempt. Must run inside an admitted phase. Never throws. The attempt flag
   * is set before the callback runs; a throw or thenable is `commit_failed`,
   * classified with this invocation's effect state.
   */
  private deliver<P, T>(delivery: MutationDelivery<P>, write: (value: T) => void, value: T, effect: EffectState): MutationReleaseResult {
    const failed = (): MutationReleaseResult => ({ status: "commit_failed", error: failure(new OperationError("internal", "release_commit_failed"), effect, undefined) });
    if (delivery.attempted) return failed();
    let now: unknown;
    try { now = this.runtime.now(); } catch { now = Number.NaN; }
    if (isThenable(now)) absorb(now);
    if (typeof now !== "number" || !Number.isFinite(now) || now >= delivery.deadline) {
      return { status: "refused", error: failure(new OperationError("unavailable", "release_timed_out", { retry: "retry" }), effect, undefined) };
    }
    delivery.attempted = true;
    try {
      synchronous(Reflect.apply(write, delivery.receiver, [value]), "release_commit_failed");
      return { status: "committed" };
    } catch {
      // The write may have partially happened. Never retried, never followed by another envelope.
      return failed();
    }
  }

  /**
   * Writes a refusal established in this admitted phase. A refusal of the
   * release policy is only returned. Otherwise the policy is applied first when
   * this phase has not passed it yet (a revalidation that threw before it),
   * then the deadline, then `refuse`. Never throws.
   */
  private refuseIn<P>(delivery: MutationDelivery<P>, guard: PhaseGuard, error: unknown, effect: EffectState): MutationReleaseResult {
    const returned = (thrown: unknown): MutationReleaseResult => ({ status: "refused", error: failure(thrown, effect, delivery.signal) });
    if (typeof error === "object" && error !== null && delivery.policy.has(error)) return returned(error);
    if (!guard.passed) {
      try { guard.check(synchronous(this.runtime.now(), "runtime_not_synchronous")); } catch (thrown) { return returned(thrown); }
    }
    return this.deliver(delivery, delivery.refuse, failure(error, effect, delivery.signal), effect);
  }

  /**
   * Buffered success (decision 5): the canonical DTO is captured, `stage` is
   * awaited once outside admission, and a final reserved admission repeats the
   * release decisions through `again` (no store lookup, no side effect),
   * compares the canonical DTO, checks the deadline and writes synchronously.
   * A final denial or a changed value is refused directly, once. A rejected
   * stage is `internal`/`release_stage_failed`, a cancellation during staging
   * `request_cancelled`, both classified with `effect` and returned. An abort
   * ends the wait even while `stage` is pending: no final phase follows, and a
   * late settlement of that `stage` admits and writes nothing. The deadline
   * does not interrupt a pending `stage`; the final phase checks it. Never throws.
   */
  private async staged<P>(delivery: MutationDelivery<P>, value: P, effect: EffectState, again: (guard: PhaseGuard) => P): Promise<void> {
    const { admission } = this.runtime;
    const stageFailed = (): MutationReleaseResult => ({ status: "refused", error: failure(new OperationError("internal", "release_stage_failed"), effect, undefined) });
    let expected: string;
    try { expected = canonicalJson(value); } catch { delivery.outcome = stageFailed(); return; }
    const stage = delivery.stage!;
    const signal = delivery.signal;
    let rejected = false, abandoned = false;
    try {
      await admission.idle(async () => {
        // Called once. With a signal, the wait ends at the abort even while `stage` is still pending:
        // its late settlement is absorbed (`untilAbort`) and reaches nothing below.
        let pending: Promise<unknown>;
        try { pending = Promise.resolve(Reflect.apply(stage, delivery.receiver, [value])); } catch (error) { pending = Promise.reject(error); }
        if (!signal) { await pending; return; }
        if (await untilAbort(pending, signal) === null) abandoned = true;
      });
    } catch { rejected = true; }
    if (abandoned || signal?.aborted) { delivery.outcome = { status: "refused", error: failure(cancelled(), effect, undefined) }; return; }
    if (rejected) { delivery.outcome = stageFailed(); return; }
    try {
      await admission.run(() => {
        const guard = this.guard(delivery);
        let fresh: P;
        try {
          fresh = again(guard);
          if (canonicalJson(fresh) !== expected) throw new OperationError("conflict", "release_payload_changed");
        } catch (error) {
          delivery.outcome = this.refuseIn(delivery, guard, error, effect);
          return;
        }
        delivery.outcome = this.deliver(delivery, delivery.commit, fresh, effect);
      }, { reserved: true });
    } catch (error) {
      if (!delivery.outcome) delivery.outcome = { status: "refused", error: failure(error, effect, delivery.signal) };
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
   * - A wait (`operation.wait`) is a stream of at most one released event:
   *   at most `maxWaiters` are open per operation ID (another is
   *   `busy`/`too_many_waiters` before admission); it ends with `done` and no
   *   event after `timeoutMs(input)`, and ends right after its one event;
   *   either way the source is disposed as when the consumer ends it.
   * - An operation excluded from the context's listener is
   *   `not_found`/`operation_not_registered` before its input is parsed.
   */
  async stream<I, E, P extends object>(operation: StreamOperation<I, E, P>, context: AuthenticationContext, raw: unknown, options: RunOptions = {}): Promise<{ ok: true; events: AsyncIterableIterator<StreamItem<P>> } | { ok: false; error: PublicOperationError }> {
    const { admission } = this.runtime;
    const { signal } = options;
    const operationId = typeof operation.id === "string" ? operation.id : "unknown";
    const created: { iterator: AsyncIterator<E> | null } = { iterator: null };
    let opened: { refs: Readonly<Record<string, ResourceRef>>; phase: Phase; iterator: AsyncIterator<E> };
    const gate = gateOf(operation);
    // A waiter slot, held from before admission until the stream ends; released exactly once.
    const waiter = { held: false, timeoutMs: 0 };
    const releaseWaiter = () => {
      if (!waiter.held) return;
      waiter.held = false;
      const count = (this.#waiters.get(operationId) ?? 1) - 1;
      if (count > 0) this.#waiters.set(operationId, count); else this.#waiters.delete(operationId);
    };
    try {
      if (!this.registeredFor(operation, context)) throw notRegistered();
      this.idempotency(false, options.idempotencyKey);
      const wait: unknown = operation.wait;
      const input = this.parse(operation.parse, raw);
      if (wait !== undefined) {
        const { maxWaiters, timeoutMs } = (typeof wait === "object" && wait !== null ? wait : {}) as Record<string, unknown>;
        if (!Number.isSafeInteger(maxWaiters) || (maxWaiters as number) < 1 || typeof timeoutMs !== "function") throw new OperationError("internal", "invalid_operation");
        const timeout: unknown = synchronous((timeoutMs as (input: I) => number).call(wait, input), "wait_not_synchronous");
        if (!Number.isSafeInteger(timeout) || (timeout as number) < 1 || (timeout as number) > MAX_WAIT_TIMEOUT_MS) throw new OperationError("invalid_request", "invalid_wait_timeout");
        const count = this.#waiters.get(operationId) ?? 0;
        if (count >= (maxWaiters as number)) throw new OperationError("busy", "too_many_waiters", { retry: "retry" });
        this.#waiters.set(operationId, count + 1);
        waiter.held = true;
        waiter.timeoutMs = timeout as number;
      }
      const refs = this.references(operation, input);
      opened = await admission.run(() => {
        const phase = this.admit(context, gate, refs);
        const live: Liveness = { open: true };
        let opening: AsyncIterable<E>;
        try { opening = operation.open(input, this.scope(phase, signal, live)); } finally { live.open = false; }
        const source = synchronous(opening, "invalid_stream");
        const iterator: unknown = source[Symbol.asyncIterator]();
        if (typeof iterator !== "object" || iterator === null) throw new OperationError("internal", "invalid_stream");
        // An iterator is never itself a thenable; one that is cannot be told apart from an unfinished step.
        if (isThenable(iterator)) { absorb(iterator); throw new OperationError("internal", "invalid_stream"); }
        created.iterator = iterator as AsyncIterator<E>;
        if (typeof (iterator as AsyncIterator<E>).next !== "function") throw new OperationError("internal", "invalid_stream");
        return { refs, phase, iterator: iterator as AsyncIterator<E> };
      }, { signal });
    } catch (error) {
      releaseWaiter();
      // A source created before the failure is still disposed, once.
      if (created.iterator) await this.disposer(operationId, created.iterator)();
      return { ok: false, error: failure(error, null, signal) };
    }
    const { iterator, refs } = opened;
    const dispose = this.disposer(operationId, iterator);
    if (signal?.aborted) {
      releaseWaiter();
      await dispose();
      return { ok: false, error: failure(cancelled(), null, signal) };
    }

    const stop = new AbortController();
    const done = (): IteratorResult<StreamItem<P>> => ({ done: true, value: undefined });
    let finished = false;
    let disposing: Promise<boolean> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const close = () => {
      finished = true;
      stop.abort();
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      releaseWaiter();
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
    if (waiter.held) {
      // The wait's deadline ends it like the consumer would: `done`, no event, the source disposed.
      timer = setTimeout(() => { if (!finished) void endByConsumer(); }, waiter.timeoutMs);
      timer.unref?.();
    }
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
            const phase = this.admit(context, gate, refs);
            if (!sameResolution(opened.phase.resources, phase.resources)) throw new OperationError("conflict", "resource_changed");
            const projected = synchronous(operation.projectEvent(value as E, phase.release), "projection_not_synchronous");
            return projected === null ? null : releaseValue<P>(projected, operation.publicKeys);
          }, { signal: stop.signal });
        } catch (error) {
          if (finished) return done();
          return endWith(error);
        }
        if (finished) return done();
        if (item !== null) {
          if (operation.wait !== undefined) {
            // A wait delivers at most one event: it ends here and its source is disposed.
            close();
            disposing = dispose();
          }
          return { done: false, value: { event: item } };
        }
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
