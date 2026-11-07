import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ProviderSessionActor, ProviderSessionAuthority } from "@/server/modules/identity";
import {
  AUTHENTICATION_PROVIDER_CONTRACT_VERSION,
  type AuthenticationProviderHost,
  type AuthenticationProviderInstance,
  type AuthenticationProviderModule,
  type AuthenticationProviderOptions,
  type AuthenticationProviderReadiness,
  type LocalProvisionInput,
  type LocalRecoveryInput,
  type LocalFactorResetSummary,
  type ProviderAccountProtection,
  type ProviderAuthenticationEvidence,
  type ProviderFactorLimits,
  type ProviderInvalidation,
  type ProviderSqliteConnection,
  type ProviderSubjectMapping,
  type ProviderSubjectRegistry,
  type ProviderSessionEvidence,
  type VerifiedProviderSession,
} from "./provider-contract";
import { canonicalInstant, evaluateSessionAuthority, validateFactorLimits, type ProviderReleaseCapture, type ProviderReleaseProtection, type ProviderSessionState } from "./account-protection";
import { browserFactorSchemas, type BrowserWebAuthnBounds } from "@/shared/contracts/authentication";
import { BROWSER_COOKIE, BROWSER_OPERATIONS, browserOperationRequires, type BrowserLifetime, type BrowserOperation, type BrowserOutcome, type BrowserRelease, type BrowserResultBody } from "./browser-operations";
import { IssuanceWindow } from "./factor-issuance";
import { UnreleasedSessions, type UnreleasedSession } from "./unreleased-sessions";
import { SessionIssuance, validateSessionRowPolicy, type SessionIssuanceState, type SessionIssuanceStore, type SessionRowPolicy } from "./session-issuance";

export type AuthenticationProviderErrorCode =
  | "recovery_unavailable" | "provider_unavailable" | "principal_unavailable" | "subject_conflict" | "not_linked"
  | "invalid_session" | "invalid_input" | "invalidation_failed" | "provider_disposed" | "provider_failed" | "disposal_unconfirmed"
  | "maintenance" | "provider_configuration_restart_required"
  | "authentication_failed" | "rate_limited" | "capacity" | "cancelled" | "outcome_unconfirmed" | "outcome_committed";

/** Safe to show: messages are fixed text, never library errors, input values or secrets. */
const retainedFailureResources = new WeakMap<AuthenticationProviderError, unknown>();
export class AuthenticationProviderError extends Error {
  constructor(
    readonly code: AuthenticationProviderErrorCode,
    message: string,
    /** True when persistence already committed, e.g. an after-commit notification failed. */
    readonly committed = false,
  ) {
    super(message);
    this.name = "AuthenticationProviderError";
  }
  /** Retain uncertain partial plugin resources with the owning error, without serialization. */
  retainResource(resource: unknown): this { retainedFailureResources.set(this, resource); return this; }
}

/** Synchronous controller-owned mapping operations; callers run them inside a borrow. */
export interface ProviderSubjectStore extends ProviderSubjectRegistry {
  isActiveOwner(principalId: string): boolean;
  activeAccountKind(principalId: string): "owner" | "human" | null;
  hasSubjectHistory(principalId: string): boolean;
  /** The mapped principal when the mapping is active and the principal is a current active owner or human. */
  resolveActivePrincipal(subject: string): string | null;
  revoke(input: { subject: string; actor: string }): ProviderSubjectMapping;
}

/** Implemented by the SQLite owner; nothing here opens or closes the database. */
export interface AuthenticationProviderStorage {
  readonly storageRevision: number;
  /** `reserved` is only for finishing accepted work, never for a new login or options request. */
  borrow<T>(operation: () => Promise<T>, options?: { signal?: AbortSignal; admissionTimeoutMs?: number; reserved?: boolean }): Promise<T>;
  runControllerOperation<T>(operation: () => T): T;
  /** False in a continuation whose borrow already ended, e.g. after its time limit. */
  operationActive(): boolean;
  /** Resolves false when provider executions, including timed-out ones, have not settled in time. */
  drain(timeoutMs: number): Promise<boolean>;
  createProviderConnection(): ProviderSqliteConnection;
  subjects(providerId: string): ProviderSubjectStore;
  /** Availability of the sole connection's provider lifetime, including timed-out borrows/drain. */
  available(): boolean;
  /** Nonsecret current-state projection. Requires core admission; never uses a provider borrow. */
  currentSession(providerId: string, sessionId: string): ProviderSessionState | null;
  /** Cleanup reconciliation when no borrow is possible. Waits for reserved core admission itself. */
  issuanceState(sessionId: string): Promise<SessionIssuanceState>;
  /** True once this owner finished its one ordinary-restart recovery. Nothing else clears it. */
  sessionRecoveryComplete(): boolean;
  sessionIssuance(): SessionIssuanceStore;
  /** Application policy over this connection. Without limits it reads evidence and refuses factor work. */
  protection(providerId: string, limits?: ProviderFactorLimits, issuance?: SessionIssuance): ProviderAccountProtection & ProviderReleaseProtection;
}

export interface LoadAuthenticationProviderInput {
  /** Absolute path or `file:` URL of a local module. No discovery, package names or remote URLs. */
  entry: string;
  providerId: string;
  storage: AuthenticationProviderStorage;
  options: AuthenticationProviderOptions;
  /**
   * Most sessions this runtime may own between minting and release or cleanup.
   * Required with `sessionRows` and `sessionReconcileBatch`, or absent with them:
   * there are no defaults, and a load without all three can administer but never mint.
   */
  unreleasedSessions?: number;
  /** Most native sessions this installation may hold, across every boot. See `SessionRowPolicy`. */
  sessionRows?: number;
  sessionReconcileBatch?: number;
  /** Called after commit. A throw is reported as `invalidation_failed` with `committed: true`. */
  onInvalidation?: (event: ProviderInvalidation) => void;
  assertAvailable?: (phase?: "commit") => void;
  log?: (level: "error" | "warn" | "info" | "debug", message: string) => void;
}

/** Provider evidence plus the controller's current mapping; grants no authority by itself. */
export interface ProviderPrincipalResolution {
  session: VerifiedProviderSession;
  principalId: string;
}
/** Only a supported combination carries committed evidence, and only that issues an actor. */
type ActorResolution = ProviderPrincipalResolution & { evidence?: ProviderSessionEvidence; principalKind?: "owner" | "human"; mappingLinkedAt?: string };

interface ActorEvidence {
  principalKind: "owner" | "human";
  mappingLinkedAt: string;
  sessionId: string;
  subject: string;
  principalId: string;
  createdAt: string;
  expiresAt: string;
  evidence: ProviderSessionEvidence;
  authentication: ProviderAuthenticationEvidence;
}

/** Bound at load; every call is controller work joined to the current borrow. */
const PROTECTION_METHODS = ["currentEvidence", "recordPasswordSession", "inheritSession", "issueTotpEnrollment", "issueTotpLogin", "issuePasskeyRegistration",
  "issuePasskeyConfirmation", "issuePasskeyAuthentication", "contextSubject", "admit", "usable", "passkeyAcceptable", "settleTotpEnrollment", "settleTotpLogin",
  "stagePasskey", "promotePasskey", "settlePasskeyLogin", "fail", "outcome"] as const satisfies ReadonlyArray<keyof ProviderAccountProtection>;
/**
 * Evidence writes name the exact session an operation minted, inside its own
 * transaction. That is the only source of a cleanup identity: never a request,
 * a native body or a lookup of the subject's latest session.
 */
const ISSUED_SESSION: { readonly [name: string]: ((input: readonly unknown[], result: unknown) => unknown) | undefined } = {
  recordPasswordSession: ([input], recorded) => (recorded ? (input as { sessionId: string }).sessionId : null),
  inheritSession: ([, input]) => (input as { sessionId: string }).sessionId,
  settleTotpLogin: ([, sessionId]) => sessionId,
  settlePasskeyLogin: ([, sessionId]) => sessionId,
};
function guardedProtection(protection: ProviderAccountProtection & ProviderReleaseProtection, controller: <T>(operation: () => T) => T, issued: (sessionId: string) => void): ProviderAccountProtection {
  const methods = Object.fromEntries(PROTECTION_METHODS.map(name => [name, (...input: unknown[]) => {
    const result = controller(() => (protection[name] as (...value: unknown[]) => unknown).call(protection, ...input));
    const session = ISSUED_SESSION[name]?.(input, result);
    if (typeof session === "string") issued(session);
    return result;
  }]));
  return Object.freeze({ ...methods, ...(protection.resetLocalFactors ? { resetLocalFactors: (subject: string) => controller(() => protection.resetLocalFactors!(subject)) } : {}), enabled: protection.enabled }) as unknown as ProviderAccountProtection;
}

const REQUIRED_METHODS = ["initialize", "handle", "signOut", "resolveSession", "provisionLocal", "recoverLocal", "revokeSession", "revokeSubjectSessions", "dispose"] as const;
const unavailable = (reason: string) => new AuthenticationProviderError("provider_unavailable", `Authentication provider is unavailable (${reason}).`);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
/**
 * Controller errors and connection-gate errors carry fixed text and pass through.
 * Library and SQLite errors are replaced: their messages may name stored values.
 */
function safeError(error: unknown): Error {
  if (error instanceof AuthenticationProviderError) return error;
  if (error instanceof Error && error.name === "ExclusiveConnectionError" && typeof (error as { code?: unknown }).code === "string") return error;
  return new AuthenticationProviderError("provider_failed", "The authentication provider operation failed.");
}

function resolveEntry(entry: string): string {
  let path: string;
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(entry) && !entry.startsWith("file:")) throw new Error("scheme");
    path = entry.startsWith("file:") ? fileURLToPath(entry) : entry;
    if (!isAbsolute(path)) throw new Error("relative");
    const canonical = realpathSync(path);
    if (!lstatSync(canonical).isFile()) throw new Error("not a file");
    return pathToFileURL(canonical).href;
  } catch { throw unavailable("entry"); }
}

function compatibleModule(value: unknown, input: LoadAuthenticationProviderInput): AuthenticationProviderModule {
  const provider = isRecord(value) ? value.authenticationProvider : undefined;
  if (!isRecord(provider)) throw unavailable("missing export");
  if (provider.contractVersion !== AUTHENTICATION_PROVIDER_CONTRACT_VERSION
    || provider.providerId !== input.providerId
    || typeof provider.implementationVersion !== "string" || !/^[0-9A-Za-z.+-]{1,64}$/.test(provider.implementationVersion)
    || provider.storageRevision !== input.storage.storageRevision
    || typeof provider.create !== "function") throw unavailable("incompatible");
  return provider as unknown as AuthenticationProviderModule;
}

/**
 * Loads one explicit local provider module, validates its contract and storage
 * revision, and awaits its schema-verified readiness inside a controller
 * borrow. Any failure disposes what was created and fails closed. Loading a
 * provider never makes an authentication mode selectable.
 */
export async function loadAuthenticationProvider(input: LoadAuthenticationProviderInput): Promise<AuthenticationProviderRuntime> {
  const url = resolveEntry(input.entry);
  let loaded: unknown;
  try { loaded = await import(/* webpackIgnore: true */ url); } catch { throw unavailable("import"); }
  const provider = compatibleModule(loaded, input);
  let limits: ProviderFactorLimits | undefined;
  try { limits = input.options.factors ? validateFactorLimits(input.options.factors.limits) : undefined; } catch { throw unavailable("factor limits"); }
  const policy = sessionPolicy(input);
  // A new owner recovers before any issuer exists. This load cannot do it, or skip it.
  if (policy && !input.storage.sessionRecoveryComplete()) throw unavailable("session recovery");
  const connection = input.storage.createProviderConnection();
  const operations = new AsyncLocalStorage<ProviderOperation>();
  const subjects = input.storage.subjects(input.providerId);
  const controller = <T>(operation: () => T) => input.storage.runControllerOperation(operation);
  const issuance = new SessionIssuance(input.storage.sessionIssuance(), policy);
  const owned = input.storage.protection(input.providerId, limits, issuance);
  const protection = guardedProtection(owned, controller, sessionId => { operations.getStore()?.issued?.(sessionId); });
  const host: AuthenticationProviderHost = Object.freeze({
    providerId: input.providerId,
    storageRevision: input.storage.storageRevision,
    connection,
    subjects: Object.freeze({
      link: (value: Parameters<ProviderSubjectRegistry["link"]>[0]) => controller(() => subjects.link(value)),
      find: (subject: string) => controller(() => subjects.find(subject)),
      findByPrincipal: (principalId: string) => controller(() => subjects.findByPrincipal(principalId)),
      record: (...value: Parameters<ProviderSubjectRegistry["record"]>) => controller(() => subjects.record(...value)),
    }),
    protection,
    invalidated(event: ProviderInvalidation) {
      // A continuation that outlived its borrow lost SQL access; it also loses notification.
      if (!input.storage.operationActive()) {
        input.log?.("error", "A late provider notification was ignored.");
        return;
      }
      try { input.onInvalidation?.(event); } catch {
        const operation = operations.getStore();
        if (operation) operation.invalidationFailed = true;
        throw new AuthenticationProviderError("invalidation_failed", "A committed change could not notify active sessions.", true);
      }
    },
    log(level: "error" | "warn" | "info" | "debug") { if (input.storage.operationActive()) input.log?.(level, "Authentication provider event."); },
  });
  let instance: AuthenticationProviderInstance | undefined;
  try {
    try { instance = await provider.create(host, input.options); } catch { throw unavailable("create"); }
    if (!isRecord(instance) || REQUIRED_METHODS.some(method => typeof (instance as unknown as Record<string, unknown>)[method] !== "function")) {
      const partial = instance as unknown as Record<string, unknown> | undefined;
      instance = undefined;
      if (isRecord(partial) && typeof partial.dispose === "function") {
        try { await (partial.dispose as () => unknown).call(partial); } catch { throw new AuthenticationProviderError("disposal_unconfirmed", "Authentication provider disposal was not confirmed.").retainResource(partial); }
      }
      throw unavailable("incompatible instance");
    }
    const ready = instance;
    let readiness: AuthenticationProviderReadiness;
    try { readiness = await input.storage.borrow(() => ready.initialize()); } catch { throw unavailable("initialization"); }
    if (!isRecord(readiness) || readiness.providerId !== input.providerId || readiness.schema !== "verified"
      || readiness.implementationVersion !== provider.implementationVersion) throw unavailable("readiness");
    return new AuthenticationProviderRuntime(input, provider, ready, connection, subjects, operations, Object.freeze({ ...readiness, library: Object.freeze({ ...readiness.library }) }), owned, limits, issuance);
  } catch (error) {
    try { await instance?.dispose(); } catch { throw new AuthenticationProviderError("disposal_unconfirmed", "Authentication provider disposal was not confirmed.").retainResource(instance); }
    finally { connection.close(); }
    throw safeError(error);
  }
}

/** All three bounds, validated, or none. A partial policy is a mistake and refuses the load. */
function sessionPolicy({ unreleasedSessions, sessionRows, sessionReconcileBatch }: LoadAuthenticationProviderInput): SessionRowPolicy | null {
  if (unreleasedSessions === undefined && sessionRows === undefined && sessionReconcileBatch === undefined) return null;
  if (!(Number.isSafeInteger(unreleasedSessions) && unreleasedSessions! > 0)) throw unavailable("unreleased session bound");
  try { return validateSessionRowPolicy({ sessionRows, sessionReconcileBatch }); } catch { throw unavailable("session row bound"); }
}

/** Per-call state joined by anything running in that call's borrow. */
interface ProviderOperation {
  invalidationFailed: boolean;
  /** Set only for an operation that can mint. Other calls own no new session. */
  issued?: ((sessionId: string) => void) | undefined;
}
/** A browser operation's claim on its session, kept across every failure path. */
interface Flight {
  /** The bound was checked in this operation's actual borrow. */
  admitted: boolean;
  session: UnreleasedSession | null;
}
/** Everything a result may release, kept where no caller can reach or forge it. */
interface ReleaseState {
  body: BrowserResultBody | null;
  headers: Headers;
  actor: ProviderSessionActor | null;
  capture: ProviderReleaseCapture | null;
  /** The session this result minted, if any. A result minted by nothing owns nothing. */
  session: UnreleasedSession | null;
  /** That session's evidence deadline, which its publication marker must match. */
  deadline: string | null;
  /** A durable effect exists whatever happens to this response. */
  committed: boolean;
  finished: boolean;
}
type CleanupBorrow = (work: () => Promise<void>) => Promise<void>;
const noop = () => undefined;
/** Native bodies without factors are small; a factor result has its explicit bound. */
const PASSWORD_RESPONSE_BYTES = 16 * 1024;
/** Stored contact data is never sent to an authenticator. */
const PASSKEY_LABEL = "Worktree Control account";
const OTPAUTH = /^otpauth:\/\/totp\/[A-Za-z0-9%._~-]{1,128}\?secret=[A-Z2-7]{16,128}=*&issuer=[A-Za-z0-9%._~-]{1,128}&digits=6&period=30$/;
const failed = (code: AuthenticationProviderErrorCode, committed = false) => new AuthenticationProviderError(code, "The authentication request could not be completed.", committed);
const invalidResponse = () => new AuthenticationProviderError("provider_failed", "Invalid provider response.");

function requestCookie(headers: Headers, name: string): string | undefined {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
const responseCookie = (lines: readonly string[], name: string) => {
  const line = lines.findLast(value => value.startsWith(`${name}=`))?.split(";")[0];
  return line?.slice(name.length + 1) || undefined;
};
const record = (value: unknown) => (isRecord(value) && !Array.isArray(value) ? value : {});

/** A refused provider Response as one fixed failure. Native status and text stay private. */
function providerRefusal(status: number, outcome: unknown): AuthenticationProviderError {
  if (outcome === "completion_receipt") return failed("outcome_committed", true);
  if (outcome === "outcome_unconfirmed") return failed("outcome_unconfirmed");
  // A charge may have committed, but nothing was evaluated. It is not a completed effect.
  if (outcome === "admission_error") return failed("provider_unavailable");
  if (status === 429) return failed("rate_limited");
  if (status === 503) return failed("capacity");
  return failed(status >= 500 ? "provider_failed" : "authentication_failed");
}

/** Controller operations over a loaded provider. Every provider call runs inside one exclusive borrow. */
export class AuthenticationProviderRuntime implements ProviderSessionAuthority {
  readonly #input: LoadAuthenticationProviderInput;
  readonly #instance: AuthenticationProviderInstance;
  readonly #connection: ProviderSqliteConnection;
  readonly #subjects: ProviderSubjectStore;
  readonly #operations: AsyncLocalStorage<ProviderOperation>;
  readonly #inFlight = new Set<Promise<unknown>>();
  // Weak ownership: retaining an actor retains its evidence, never a request ledger.
  readonly #actors = new WeakMap<ProviderSessionActor, Readonly<ActorEvidence>>();
  readonly #releases = new WeakMap<BrowserRelease, ReleaseState>();
  /** Dispose cannot be confirmed while one of these may still exist. Absent without an explicit bound. */
  readonly #unreleased: UnreleasedSessions | undefined;
  readonly #protection: ProviderAccountProtection & ProviderReleaseProtection;
  readonly #sessions: SessionIssuance;
  readonly #limits: ProviderFactorLimits | undefined;
  readonly #issuance: IssuanceWindow | undefined;
  readonly #schemas: ReturnType<typeof browserFactorSchemas> | undefined;
  #disposal: Promise<void> | undefined;
  readonly readiness: AuthenticationProviderReadiness;
  readonly implementationVersion: string;

  /** @internal Created by `loadAuthenticationProvider`. */
  constructor(
    input: LoadAuthenticationProviderInput,
    provider: AuthenticationProviderModule,
    instance: AuthenticationProviderInstance,
    connection: ProviderSqliteConnection,
    subjects: ProviderSubjectStore,
    operations: AsyncLocalStorage<ProviderOperation>,
    readiness: AuthenticationProviderReadiness,
    protection: ProviderAccountProtection & ProviderReleaseProtection,
    limits: ProviderFactorLimits | undefined,
    sessions: SessionIssuance,
  ) {
    this.#protection = protection;
    this.#sessions = sessions;
    this.#limits = limits;
    this.#issuance = limits && new IssuanceWindow(limits.issuance);
    this.#schemas = limits && browserFactorSchemas(limits.webauthn);
    this.#unreleased = sessions.bounded ? new UnreleasedSessions(input.unreleasedSessions!) : undefined;
    this.#input = input;
    this.#instance = instance;
    this.#connection = connection;
    this.#subjects = subjects;
    this.#operations = operations;
    this.readiness = readiness;
    this.implementationVersion = provider.implementationVersion;
  }

  get disposed(): boolean { return this.#disposal !== undefined; }
  /** Without validated limits every factor route stays closed. */
  get factorsEnabled(): boolean { return this.#limits !== undefined; }
  get webAuthnBounds(): BrowserWebAuthnBounds | undefined { return this.#limits?.webauthn; }
  /** Without explicit bounds nothing here may mint a session. */
  get issuanceBounded(): boolean { return this.#unreleased !== undefined; }

  /**
   * Native responses for private proof callers. No caller can receive a session
   * this way that the global bound did not admit: its return is a conservative
   * publication, so the marker commits first. A failed or uncertain result
   * carries no cookie, and its `pending` row stays counted until the next boot.
   */
  handle(request: Request): Promise<Response> {
    let minted: string | undefined;
    return this.#run(async () => {
      if (this.#mintingRequest(request) && !this.#input.storage.runControllerOperation(() => this.#sessions.roomBeforeMint(new Date().toISOString()))) return new Response(null, { status: 503 });
      const response = await this.#instance.handle(request);
      if (!minted || !response.ok) return response;
      const issued = minted;
      this.#input.storage.runControllerOperation(() => {
        const deadline = this.#protection.currentEvidence(issued, Date.now())?.originalDeadline;
        if (!deadline) throw failed("outcome_unconfirmed");
        this.#sessions.publish(issued, deadline);
      });
      return response;
    }, { issued: sessionId => { minted = sessionId; } });
  }

  /** The same closed set the browser surface marks `mints`, including its enrollment exception. */
  #mintingRequest(request: Request): boolean {
    const url = new URL(request.url), base = new URL(this.#input.options.baseURL).pathname.replace(/\/+$/, "");
    const operation = (Object.keys(BROWSER_OPERATIONS) as BrowserOperation[]).find(name => browserOperationRequires(name, "mints") && `${base}${BROWSER_OPERATIONS[name].path}` === url.pathname);
    return operation !== undefined && request.method === BROWSER_OPERATIONS[operation].method
      && !(operation === "totp-verify" && requestCookie(request.headers, BROWSER_COOKIE.session) !== undefined);
  }

  /** Current provider session, committed evidence and active owner mapping, all read under one borrow. */
  async resolve(headers: Headers): Promise<ProviderPrincipalResolution | null> {
    const resolved = await this.#resolve(headers);
    return resolved && { session: resolved.session, principalId: resolved.principalId };
  }

  #resolve(headers: Headers): Promise<ActorResolution | null> {
    return this.#run(() => this.#resolveInBorrow(headers));
  }

  async #resolveInBorrow(headers: Headers): Promise<ActorResolution | null> {
    const session = await this.#instance.resolveSession(headers);
    if (!session || session.providerId !== this.#input.providerId) return null;
    return this.#input.storage.runControllerOperation(() => this.#resolution(session));
  }

  /**
   * An unverified combination resolves password claims only and can never issue
   * an actor. A supported one takes its authority from committed evidence, and a
   * provider claim that disagrees with that evidence refuses.
   */
  #resolution(session: VerifiedProviderSession): ActorResolution | null {
    if (!this.#supportsSessionAuthority()) {
      if (session.authentication?.method !== "password") return null;
      const principalId = this.#subjects.resolveActivePrincipal(session.subject);
      return principalId ? { session: { ...session, authentication: { method: "password", factors: 1 } }, principalId } : null;
    }
    const state = this.#input.storage.currentSession(this.#input.providerId, session.sessionId);
    const authority = state && evaluateSessionAuthority(state, new Date().toISOString());
    if (!state || !authority || state.subject !== session.subject || state.createdAt !== session.createdAt
      || session.authentication?.method !== authority.authentication.method) return null;
    return { session: { ...session, expiresAt: authority.deadline, authentication: authority.authentication }, principalId: state.principalId, principalKind: state.principalKind, mappingLinkedAt: state.mappingLinkedAt, evidence: authority.evidence };
  }

  /** Resolve outside core admission. Raw `resolve` evidence and structural actor copies never authorize. */
  async authenticate(headers: Headers): Promise<ProviderSessionActor | null> {
    if (!this.#supportsSessionAuthority()) throw unavailable("session authority");
    const resolution = await this.#resolve(headers);
    if (!resolution || this.disposed || !this.#input.storage.available()) return null;
    return this.#issueActor(resolution);
  }

  /** `authenticate` tied to one HTTP request: cancellable while queued, tracked until really finished. */
  authenticateRequest(headers: Headers, options: { signal?: AbortSignal } = {}): BrowserLifetime<ProviderSessionActor | null> {
    if (!this.#supportsSessionAuthority()) return { result: Promise.reject(unavailable("session authority")), settled: Promise.resolve() };
    const lifetime = this.#lifetime(() => this.#resolveInBorrow(headers), options, false);
    const result = lifetime.result.then(resolution => (!resolution || this.disposed || !this.#input.storage.available() ? null : this.#issueActor(resolution)));
    result.catch(noop);
    return { result, settled: lifetime.settled };
  }

  #issueActor(resolution: ActorResolution): ProviderSessionActor | null {
    const { session, principalId, principalKind, mappingLinkedAt, evidence } = resolution;
    if ((principalKind !== "owner" && principalKind !== "human") || !mappingLinkedAt || !canonicalInstant(mappingLinkedAt) || session.providerId !== this.#input.providerId || !evidence || evidence.sessionId !== session.sessionId || evidence.subject !== session.subject
      || !session.sessionId || !session.subject || !principalId || !canonicalInstant(session.createdAt)
      || !canonicalInstant(session.expiresAt) || session.createdAt >= session.expiresAt) return null;
    const actor = Object.freeze({ principalId, principalKind, credentialId: null, authenticationMethod: "provider_session" }) as ProviderSessionActor;
    this.#actors.set(actor, Object.freeze({ sessionId: session.sessionId, subject: session.subject, principalId, principalKind, mappingLinkedAt,
      createdAt: session.createdAt, expiresAt: session.expiresAt, evidence: Object.freeze({ ...evidence }), authentication: Object.freeze({ ...session.authentication }) }));
    return actor;
  }

  /** Every decision reads committed authority on the controller-owned guarded handle. No Kysely or borrow. */
  isCurrentProviderSession(actor: ProviderSessionActor, now: string): boolean {
    const original = this.#actors.get(actor);
    if (!original || this.disposed || !this.#supportsSessionAuthority() || !this.#input.storage.available()
      || actor.authenticationMethod !== "provider_session" || actor.principalKind !== original.principalKind
      || actor.credentialId !== null || actor.principalId !== original.principalId || !Object.isFrozen(actor)
      || !canonicalInstant(now) || original.expiresAt <= now) return false;
    const current = this.#input.storage.currentSession(this.#input.providerId, original.sessionId);
    const authority = current && evaluateSessionAuthority(current, now);
    if (!current || !authority || current.subject !== original.subject || current.principalId !== original.principalId
      || current.principalKind !== original.principalKind || current.mappingLinkedAt !== original.mappingLinkedAt || current.createdAt !== original.createdAt) return false;
    const evidence = authority.evidence, frozen = original.evidence;
    return evidence.method === frozen.method && evidence.authenticatedAt === frozen.authenticatedAt && evidence.originalDeadline === frozen.originalDeadline
      && evidence.generation === frozen.generation && evidence.policyRevision === frozen.policyRevision && evidence.credential === frozen.credential
      && evidence.credentialBinding === frozen.credentialBinding && evidence.attemptId === frozen.attemptId;
  }

  /** Stable across requests and ordinary reboots only while the original committed session survives.
   * The original evidence and mapping linkage are hashed, never released to a client or log.
   */
  resolveRuntimeSession(actor: ProviderSessionActor, now: string): import("../identity").ProviderRuntimeSession | null {
    if (!this.isCurrentProviderSession(actor, now)) return null;
    const original = this.#actors.get(actor)!;
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const evidenceKey = digest(["wtc-human-evidence-v1", original.evidence, original.mappingLinkedAt, original.authentication]);
    return Object.freeze({ principalId: original.principalId,
      sessionKey: digest(["wtc-human-session-v1", this.#input.providerId, original.sessionId, original.subject,
        original.principalId, original.principalKind, original.createdAt, original.mappingLinkedAt, evidenceKey]),
      evidenceKey, generation: original.evidence.generation, deadline: original.expiresAt });
  }

  /** Capture only from an exact runtime-owned actor; no cookie/token is retained. */
  captureRuntimeSession(actor: ProviderSessionActor, now: string): import("../identity").RetainedProviderSession | null {
    const binding = this.resolveRuntimeSession(actor, now);
    return binding ? Object.freeze({ ...binding, nativeSessionId: this.#actors.get(actor)!.sessionId }) : null;
  }

  /** Queue authority comes from current native rows, never from a reconstructed actor. */
  validateRetainedRuntimeSession(reference: import("../identity").RetainedProviderSession, now: string): boolean {
    if (this.disposed || !this.#supportsSessionAuthority() || !this.#input.storage.available() || !canonicalInstant(now)
      || typeof reference?.nativeSessionId !== "string" || !reference.nativeSessionId || reference.nativeSessionId.length > 512) return false;
    const state = this.#input.storage.currentSession(this.#input.providerId, reference.nativeSessionId);
    const authority = state && evaluateSessionAuthority(state, now);
    if (!state || !authority) return false;
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const evidenceKey = digest(["wtc-human-evidence-v1", authority.evidence, state.mappingLinkedAt, authority.authentication]);
    const sessionKey = digest(["wtc-human-session-v1", this.#input.providerId, reference.nativeSessionId, state.subject,
      state.principalId, state.principalKind, state.createdAt, state.mappingLinkedAt, evidenceKey]);
    return state.principalId === reference.principalId && sessionKey === reference.sessionKey && evidenceKey === reference.evidenceKey
      && authority.evidence.generation === reference.generation && authority.deadline === reference.deadline;
  }

  /**
   * Fixed browser operations only, called outside core admission, with no caller
   * callbacks. The provider work runs in one actual queued borrow. Everything it
   * may release stays behind the returned opaque object until `finishBrowserRelease`.
   */
  browser(operation: BrowserOperation, request: Request, options: { actor?: ProviderSessionActor | null; signal?: AbortSignal } = {}): BrowserLifetime<BrowserRelease> {
    const refused = (error: AuthenticationProviderError): BrowserLifetime<BrowserRelease> => {
      const result = Promise.reject<BrowserRelease>(error);
      result.catch(noop);
      return { result, settled: Promise.resolve() };
    };
    const definition = BROWSER_OPERATIONS[operation];
    if (!definition || request.url !== `${this.#input.options.baseURL}${definition.path}` || request.method !== definition.method || !this.#supportsSessionAuthority()
      || (browserOperationRequires(operation, "factor") && !this.#limits) || (browserOperationRequires(operation, "mints") && !this.#unreleased)) {
      return refused(new AuthenticationProviderError("invalid_input", "Invalid browser operation."));
    }
    if (operation === "passkey-authenticate-options") {
      // Before any queue or allocation. A peer that cannot be identified gets nothing.
      const peer = request.headers.get(this.#input.options.clientIpHeader);
      if (options.signal?.aborted) return refused(failed("cancelled"));
      if (!peer || !this.#issuance!.admit(peer, Date.now())) return refused(failed("rate_limited"));
    }
    // Queued first, so deletion that recovered makes room for this very request.
    const retried = browserOperationRequires(operation, "mints") ? this.#retryCleanup() : Promise.resolve();
    const flight: Flight = { admitted: false, session: null };
    const lifetime = this.#lifetime(() => this.#browserFlight(operation, request, options.actor ?? null, flight), options, operation !== "session", sessionId => { this.#claim(flight, sessionId); });
    const delivered = lifetime.result.then(() => true, () => false);
    const settled = lifetime.settled.then(async () => {
      const session = flight.session, unreleased = this.#unreleased;
      // Nobody can release this session: its operation failed, or no caller got the result.
      if (session && unreleased?.has(session) && (session.phase === "issuing" || !await delivered)) await this.#clean(session).settled;
      await retried;
    });
    return { result: lifetime.result, settled };
  }

  /** Runs in the actual borrow, joined to its transaction, before any COMMIT can happen. */
  #claim(flight: Flight, sessionId: string): void {
    if (!flight.admitted || (flight.session && flight.session.sessionId !== sessionId)) throw invalidResponse();
    flight.session ??= this.#unreleased!.add(sessionId);
  }

  /**
   * A failed operation keeps its claim until its row is proved absent. A proved
   * rollback leaves nothing to clean, while an open transaction or unreadable
   * row stays owned. Its public outcome is not derived from this.
   */
  async #browserFlight(operation: BrowserOperation, request: Request, actor: ProviderSessionActor | null, flight: Flight): Promise<BrowserRelease> {
    try { return await this.#browserOperation(operation, request, actor, flight); } catch (error) {
      const session = flight.session, unreleased = this.#unreleased;
      if (session && unreleased?.has(session)) {
        try {
          if (!this.#input.storage.runControllerOperation(() => this.#protection.sessionPresent(session.sessionId))) unreleased.remove(session);
        } catch { /* Unreadable is not absent. */ }
      }
      throw error;
    }
  }

  /** This check runs inside the ACTUAL queued borrow, immediately before native work. */
  async #requireCurrentSession(actor: ProviderSessionActor | null, headers: Headers): Promise<void> {
    const original = actor && this.#actors.get(actor);
    const incoming = await this.#instance.resolveSession(headers);
    const valid = actor && this.#input.storage.runControllerOperation(() => this.isCurrentProviderSession(actor, new Date().toISOString()));
    if (!valid || !original || incoming?.sessionId !== original.sessionId || incoming.subject !== original.subject) {
      throw new AuthenticationProviderError("invalid_session", "Invalid browser session.");
    }
  }

  async #browserOperation(operation: BrowserOperation, request: Request, actor: ProviderSessionActor | null, flight: Flight): Promise<BrowserRelease> {
    const controller = <T>(work: () => T) => this.#input.storage.runControllerOperation(work);
    const enrolling = operation === "totp-verify" && requestCookie(request.headers, BROWSER_COOKIE.session) !== undefined;
    if (browserOperationRequires(operation, "actor") || enrolling) await this.#requireCurrentSession(actor, request.headers);
    // The borrow is exclusive, so this check and the mint it permits cannot interleave with another issuer.
    if (browserOperationRequires(operation, "mints") && !enrolling) {
      if (!controller(() => this.#sessions.roomBeforeMint(new Date().toISOString())) || this.#unreleased!.full) throw failed("capacity");
      flight.admitted = true;
    }
    if (operation === "passkey-authenticate-options" && !controller(() => this.#protection.issuanceRoom(Date.now()))) throw failed("capacity");
    const native = operation === "sign-out" ? await this.#instance.signOut(request) : await this.#instance.handle(request);
    // Consume a bounded native body inside the borrow. Never expose its tokens or error text.
    const text = await this.#boundedText(native);
    let parsed: Record<string, unknown> = {};
    try { parsed = record(JSON.parse(text)); } catch { /* Refusals and native routes may have no JSON. */ }
    if (!native.ok) throw providerRefusal(native.status, parsed.outcome);
    if (operation === "sign-out") return this.#release(operation, "signed-out", { authenticated: false }, native.headers);
    const lines = native.headers.getSetCookie();
    switch (operation) {
      case "sign-in":
        if (parsed.outcome !== "challenge") return this.#sessionResult(operation, request, native.headers, null, "password", flight);
        return this.#pendingResult(operation, "challenge", { authenticated: false, outcome: "challenge", method: "totp" }, native.headers,
          controller, responseCookie(lines, BROWSER_COOKIE.challenge), "totp_login");
      case "session": case "password":
        return this.#sessionResult(operation, request, native.headers, actor, null, flight);
      case "totp-enable": {
        if (parsed.outcome !== "enrollment" || parsed.authorizing !== false || typeof parsed.totpURI !== "string" || !OTPAUTH.test(parsed.totpURI)) throw invalidResponse();
        return this.#pendingResult(operation, "enrollment", { outcome: "enrollment", totpURI: parsed.totpURI, authorizing: false }, native.headers,
          controller, requestCookie(request.headers, BROWSER_COOKIE.session), "totp_enrollment");
      }
      case "totp-verify":
        if (enrolling) return this.#enrolledResult(operation, parsed, native.headers, controller, requestCookie(request.headers, BROWSER_COOKIE.session)!, "totp_enrollment");
        if (parsed.outcome !== "session" || parsed.method !== "password_totp") throw invalidResponse();
        return this.#sessionResult(operation, request, native.headers, null, "password_totp", flight);
      case "passkey-authentication":
        if (parsed.outcome !== "session" || parsed.method !== "passkey_uv") throw invalidResponse();
        return this.#sessionResult(operation, request, native.headers, null, "passkey_uv", flight);
      case "passkey-confirmation":
        return this.#enrolledResult(operation, parsed, native.headers, controller, requestCookie(request.headers, BROWSER_COOKIE.passkey) ?? "", "passkey_confirmation");
      case "passkey-registration": {
        if (parsed.outcome !== "staged" || parsed.authorizing !== false) throw invalidResponse();
        const source = requestCookie(request.headers, BROWSER_COOKIE.passkey);
        const capture = source ? controller(() => this.#protection.captureStaged(source, Date.now())) : null;
        if (!capture) throw invalidResponse();
        return this.#release(operation, "staged", { outcome: "staged", authorizing: false }, native.headers, { capture });
      }
      default: {
        const options = this.#projectOptions(operation, parsed);
        const purpose = operation === "passkey-register-options" ? "passkey_registration" : operation === "passkey-confirm-options" ? "passkey_confirmation" : "passkey_authentication";
        return this.#pendingResult(operation, "options", { outcome: "options", options }, native.headers, controller, responseCookie(lines, BROWSER_COOKIE.passkey), purpose);
      }
    }
  }

  async #boundedText(native: Response): Promise<string> {
    const limit = this.#limits?.webauthn.responseBytes ?? PASSWORD_RESPONSE_BYTES, chunks: Uint8Array[] = [];
    const reader = native.body?.getReader();
    let bytes = 0;
    try {
      if (reader) for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > limit) throw invalidResponse();
        chunks.push(chunk.value);
      }
    } finally { await reader?.cancel(); }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw invalidResponse(); }
  }

  /** Only the named fields of a generated option set ever leave. Each is validated, and RP comes from configuration. */
  #projectOptions(operation: BrowserOperation, parsed: Record<string, unknown>) {
    const schemas = this.#schemas!, rpId = this.#input.options.factors!.rpId, native = record(parsed.options);
    if (parsed.outcome !== "options") throw invalidResponse();
    const credential = (value: unknown) => { const item = record(value); return { id: item.id, type: item.type, transports: item.transports }; };
    const list = (value: unknown) => (Array.isArray(value) ? value.map(credential) : value);
    let options;
    if (operation === "passkey-register-options") {
      const rp = record(native.rp), user = record(native.user), selection = record(native.authenticatorSelection);
      options = schemas.creationOptions.safeParse({
        rp: { id: rp.id, name: rp.name }, user: { id: user.id, name: PASSKEY_LABEL, displayName: PASSKEY_LABEL }, challenge: native.challenge,
        pubKeyCredParams: Array.isArray(native.pubKeyCredParams) ? native.pubKeyCredParams.map(value => ({ type: record(value).type, alg: record(value).alg })) : native.pubKeyCredParams,
        timeout: native.timeout, excludeCredentials: list(native.excludeCredentials),
        authenticatorSelection: { residentKey: selection.residentKey, requireResidentKey: selection.requireResidentKey, userVerification: selection.userVerification },
        attestation: native.attestation, extensions: native.extensions,
      });
      if (!options.success || options.data.rp.id !== rpId) throw invalidResponse();
    } else {
      options = schemas.requestOptions.safeParse({ challenge: native.challenge, rpId: native.rpId, timeout: native.timeout,
        allowCredentials: list(native.allowCredentials), userVerification: native.userVerification });
      const listed = options.success ? options.data.allowCredentials?.length ?? 0 : 0;
      if (!options.success || options.data.rpId !== rpId || (operation === "passkey-confirm-options" ? listed !== 1 : listed !== 0)) throw invalidResponse();
    }
    return options.data;
  }

  #pendingResult(operation: BrowserOperation, outcome: BrowserOutcome, body: BrowserResultBody, headers: Headers, controller: <T>(work: () => T) => T,
    opaque: string | undefined, purpose: Parameters<ProviderReleaseProtection["capturePending"]>[1]): BrowserRelease {
    const capture = opaque ? controller(() => this.#protection.capturePending(opaque, purpose, Date.now())) : null;
    if (!capture) throw invalidResponse();
    return this.#release(operation, outcome, body, headers, { capture });
  }

  /** The selection committed, so a failure from here on must say so. It returns no actor and no login. */
  #enrolledResult(operation: BrowserOperation, parsed: Record<string, unknown>, headers: Headers, controller: <T>(work: () => T) => T,
    opaque: string, purpose: "totp_enrollment" | "passkey_confirmation"): BrowserRelease {
    if (parsed.outcome !== "enrolled" || parsed.authorizing !== false) throw invalidResponse();
    const capture = controller(() => this.#protection.captureEnrolled(opaque, purpose));
    if (!capture) throw failed("outcome_committed", true);
    return this.#release(operation, "enrolled", { outcome: "enrolled", authorizing: false }, headers, { capture, committed: true });
  }

  async #sessionResult(operation: BrowserOperation, request: Request, responseHeaders: Headers, actor: ProviderSessionActor | null, method: ProviderAuthenticationEvidence["method"] | null, flight: Flight): Promise<BrowserRelease> {
    const lookup = new Headers(request.headers), line = responseHeaders.getSetCookie().findLast(value => value.startsWith(`${BROWSER_COOKIE.session}=`));
    const token = line?.split(";")[0];
    if (token && token.length > BROWSER_COOKIE.session.length + 1) lookup.set("cookie", token);
    else if (operation !== "session") throw operation === "password" ? failed("outcome_committed", true) : invalidResponse();
    const refuse = operation === "password" ? failed("outcome_committed", true) : failed("authentication_failed");
    const session = await this.#instance.resolveSession(lookup);
    if (!session) {
      if (operation === "session") return this.#release(operation, "unauthenticated", { authenticated: false }, new Headers());
      throw refuse;
    }
    const resolution = this.#input.storage.runControllerOperation(() => this.#resolution(session));
    const issued = resolution && this.#issueActor(resolution), owned = flight.session;
    if (!issued || (operation === "password" && issued.principalId !== actor?.principalId) || (method && session.authentication.method !== method)
      || (operation !== "session" && owned?.sessionId !== session.sessionId)) {
      if (operation === "session") return this.#release(operation, "unauthenticated", { authenticated: false }, new Headers());
      // Only what this operation minted, never what its cookie happened to resolve to.
      if (owned) await this.#revoke(owned).catch(noop);
      throw refuse;
    }
    const outcome = operation === "session" ? "session" : operation === "password" ? "password" : "session";
    return this.#release(operation, outcome, operation === "password" ? { changed: true } : { authenticated: true }, responseHeaders,
      { actor: issued, committed: operation === "password", session: owned, deadline: resolution.evidence?.originalDeadline ?? null });
  }

  #release(operation: BrowserOperation, outcome: BrowserOutcome, body: BrowserResultBody, headers: Headers, state: Partial<Pick<ReleaseState, "actor" | "capture" | "committed" | "session" | "deadline">> = {}): BrowserRelease {
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > (this.#limits?.webauthn.responseBytes ?? PASSWORD_RESPONSE_BYTES)) throw invalidResponse();
    const release: BrowserRelease = Object.freeze({ operation, outcome });
    const owned: ReleaseState = { body, headers, actor: state.actor ?? null, capture: state.capture ?? null, session: state.session ?? null, deadline: state.deadline ?? null, committed: state.committed ?? false, finished: false };
    this.#releases.set(release, owned);
    if (owned.session) owned.session.phase = "held";
    return release;
  }

  /** Candidate response cookies, for validation as one set before anything is released. */
  browserReleaseHeaders(release: BrowserRelease): Headers {
    const state = this.#releases.get(release);
    if (!state) throw new AuthenticationProviderError("invalid_input", "Invalid browser operation.");
    return state.headers;
  }
  /** True when the effect is durable even if this response is never delivered. */
  browserReleaseCommitted(release: BrowserRelease): boolean { return this.#releases.get(release)?.committed === true; }

  /**
   * The final check, synchronous so it forms one admitted phase with response
   * emission. A release is finished once. Foreign objects and other runtimes'
   * releases fail; retained results are revalidated against current state.
   *
   * A new session's body comes back only after its `may_publish` marker committed,
   * so a crash can never leave a possibly delivered cookie looking unpublished.
   * Local release frees the unreleased slot, never the durable row. A failed
   * mark returns nothing and may still have committed: `#revoke` reads what is stored.
   */
  finishBrowserRelease(release: BrowserRelease): BrowserResultBody {
    const state = this.#releases.get(release);
    if (!state || state.finished || (state.session && state.session.phase !== "held")) throw new AuthenticationProviderError("invalid_session", "Invalid browser session.");
    const now = Date.now();
    let body = state.body!;
    try {
      if (this.disposed) throw new AuthenticationProviderError("invalid_session", "Invalid browser session.");
      if (state.actor) {
        const current = this.browserSession(state.actor);
        if (release.operation === "session") body = current;
      }
      if (state.capture && (!this.#input.storage.available() || !this.#protection.releaseCurrent(state.capture, now))) {
        throw new AuthenticationProviderError("invalid_session", "Invalid browser session.");
      }
    } catch (error) {
      if (state.committed) throw failed("outcome_committed", true);
      throw error;
    }
    if (state.session) {
      try { this.#sessions.publish(state.session.sessionId, state.deadline!); } catch {
        state.session.phase = "retained";
        throw state.committed ? failed("outcome_committed", true) : failed("outcome_unconfirmed");
      }
    }
    this.#retire(state);
    if (state.session) this.#unreleased!.remove(state.session);
    return body;
  }

  /** A finished result keeps no cookie or body, however long its caller holds the object. */
  #retire(state: ReleaseState): void {
    state.finished = true;
    state.body = null;
    state.headers = new Headers();
  }

  /** Safe public projection, only during a current admitted decision. */
  browserSession(actor: ProviderSessionActor) {
    if (!this.isCurrentProviderSession(actor, new Date().toISOString())) throw new AuthenticationProviderError("invalid_session", "Invalid browser session.");
    const original = this.#actors.get(actor)!;
    return { authenticated: true as const, principal: { id: actor.principalId, kind: actor.principalKind },
      expiresAt: original.expiresAt, authentication: original.authentication };
  }

  /**
   * Ends a minted session whose response will not be delivered. It takes no
   * caller session ID and cannot affect a committed password, selection or step.
   * `result` ends with the public borrow. `settled` ends when the cleanup
   * callback really ended, so hold accepted capacity on `settled`. A failure
   * stays owned, is retried, and keeps disposal unconfirmed until resolved.
   */
  discardBrowserRelease(release: BrowserRelease): BrowserLifetime<void> {
    const state = this.#releases.get(release);
    if (!state || state.finished) return { result: Promise.resolve(), settled: Promise.resolve() };
    this.#retire(state);
    return state.session ? this.#clean(state.session) : { result: Promise.resolve(), settled: Promise.resolve() };
  }

  /** One cleanup per session at a time, on reserved admission because it finishes accepted work. */
  #clean(session: UnreleasedSession, borrow: CleanupBorrow = work => this.#run(work, { reserved: true })): BrowserLifetime<void> {
    if (session.cleaning) return session.cleaning;
    session.phase = "retained";
    let execution: Promise<void> | undefined;
    const result = borrow(() => { execution = this.#revoke(session); return execution; }).then(noop, (error: unknown) => {
      if (error instanceof AuthenticationProviderError && error.code === "invalidation_failed") this.#input.log?.("warn", "An unreleased session's notification failed.");
    });
    const settled = result.then(() => execution?.then(noop, noop))
      // With provider admission closed, only a read can still say what happened to the row.
      .then(() => (this.#unreleased!.has(session) && !this.#input.storage.available() ? this.#reconcile(session) : undefined))
      .finally(() => { session.cleaning = null; });
    session.cleaning = { result, settled };
    return session.cleaning;
  }

  /**
   * Only stored state decides: a notification can fail after deletion, and deletion
   * can be refused. A `may_publish` row is never deleted here, whatever happened to
   * its response. It is retained by design, so its local claim simply ends.
   */
  async #revoke(session: UnreleasedSession): Promise<void> {
    const stored = () => this.#input.storage.runControllerOperation(() => this.#sessions.state(session.sessionId));
    if (stored() === "pending") await this.#instance.revokeSession(session.sessionId).catch(noop);
    if (this.#resolved(stored())) this.#unreleased!.remove(session);
    else this.#input.log?.("error", "An unreleased session could not be cleaned up.");
  }

  #resolved(state: SessionIssuanceState): boolean { return state === "absent" || state === "may_publish"; }

  async #reconcile(session: UnreleasedSession): Promise<void> {
    try {
      if (this.#resolved(await this.#input.storage.issuanceState(session.sessionId))) this.#unreleased!.remove(session);
    } catch { /* Unreadable is not absent, so it stays owned. */ }
  }

  /** At most one attempt per retained session. Their number is already bounded. */
  #retryCleanup(): Promise<void> {
    const retained = this.#unreleased!.all().filter(session => session.phase === "retained" && !session.cleaning);
    return Promise.all(retained.map(session => this.#clean(session).settled)).then(noop);
  }

  #supportsSessionAuthority(): boolean {
    // This projection is verified only for the fixed migration-41 adapter and pinned library.
    return this.#input.providerId === "better-auth" && this.#input.storage.storageRevision === 3
      && this.implementationVersion === "0.0.0-proof.5"
      && this.readiness.library?.name === "better-auth" && this.readiness.library.version === "1.7.14";
  }

  /** Protected local bootstrap: creates a password account and its mapping atomically. */
  provisionLocal(input: LocalProvisionInput): Promise<{ subject: string }> {
    for (const value of [input.principalId, input.email, input.name, input.password, input.actor]) {
      if (typeof value !== "string" || !value || value.length > 1024) return Promise.reject(new AuthenticationProviderError("invalid_input", "Provisioning input is invalid."));
    }
    return this.#run(async () => {
      const state = this.#input.storage.runControllerOperation(() => ({
        active: this.#subjects.activeAccountKind(input.principalId) !== null, history: this.#subjects.hasSubjectHistory(input.principalId),
      }));
      if (!state.active) throw new AuthenticationProviderError("principal_unavailable", "Only an existing active account principal can be linked.");
      if (state.history) {
        throw new AuthenticationProviderError("subject_conflict", "The principal already has a provider account.");
      }
      return this.#instance.provisionLocal(input);
    });
  }

  get supportsLocalFactorReset(): boolean { return this.readiness.localFactorReset === "v1" && typeof this.#instance.recoverLocalWithFactorReset === "function"; }

  /** Protected local recovery: replaces the password and revokes the account's sessions atomically. */
  recoverLocal(input: LocalRecoveryInput): Promise<void | LocalFactorResetSummary> {
    for (const value of [input.principalId, input.newPassword, input.actor]) {
      if (typeof value !== "string" || !value || value.length > 1024) return Promise.reject(new AuthenticationProviderError("invalid_input", "Recovery input is invalid."));
    }
    if (input.factors !== undefined && input.factors !== "preserve" && input.factors !== "reset") return Promise.reject(new AuthenticationProviderError("invalid_input", "Recovery input is invalid."));
    return this.#run(async () => {
      if (input.factors === "reset" && !this.supportsLocalFactorReset) {
        throw new AuthenticationProviderError("recovery_unavailable", "Explicit factor recovery is unavailable.");
      }
      const linked = this.#input.storage.runControllerOperation(() => this.#subjects.findByPrincipal(input.principalId));
      if (!linked) throw new AuthenticationProviderError("not_linked", "The principal has no provider account.");
      const assertCurrent = (phase?: "commit") => this.#input.storage.runControllerOperation(() => {
        this.#input.assertAvailable?.(phase);
        const kind = this.#subjects.activeAccountKind(input.principalId);
        if (!kind || (kind === "owner" && !this.#subjects.isActiveOwner(input.principalId)) || this.#subjects.resolveActivePrincipal(linked.subject) !== input.principalId
          || this.#subjects.findByPrincipal(input.principalId)?.linkedAt !== linked.linkedAt) {
          throw new AuthenticationProviderError("principal_unavailable", "The active account principal is unavailable.");
        }
      });
      assertCurrent();
      const request = { ...input, assertCurrent };
      if (input.factors === "reset") {
        const summary = await this.#instance.recoverLocalWithFactorReset!(request);
        if (!summary || typeof summary.totp !== "boolean" || !Number.isSafeInteger(summary.passkeys) || summary.passkeys < 0) {
          throw new AuthenticationProviderError("outcome_unconfirmed", "Recovery outcome was not confirmed.");
        }
        return { totp: summary.totp, passkeys: summary.passkeys };
      }
      await this.#instance.recoverLocal(request);
    });
  }

  revokeSession(sessionId: string): Promise<void> {
    return this.#run(() => this.#instance.revokeSession(sessionId));
  }

  revokePrincipalSessions(principalId: string): Promise<void> {
    return this.#run(async () => {
      const mapping = this.#input.storage.runControllerOperation(() => this.#subjects.findByPrincipal(principalId));
      if (!mapping) throw new AuthenticationProviderError("not_linked", "The principal has no provider account.");
      await this.#instance.revokeSubjectSessions(mapping.subject);
    });
  }

  /** Ends the mapping; retained cookies stop resolving even before their sessions are deleted. */
  revokeSubject(input: { principalId: string; actor: string }): Promise<void> {
    return this.#run(async () => {
      const mapping = this.#input.storage.runControllerOperation(() => {
        const current = this.#subjects.findByPrincipal(input.principalId);
        if (!current) throw new AuthenticationProviderError("not_linked", "The principal has no provider account.");
        return this.#subjects.revoke({ subject: current.subject, actor: input.actor });
      });
      this.#notify({ kind: "subject", providerId: this.#input.providerId, subject: mapping.subject });
      await this.#instance.revokeSubjectSessions(mapping.subject);
    });
  }

  /**
   * Closes admission, drains admitted operations and every underlying provider
   * execution (a timed-out public promise is not enough), disposes the provider
   * and invalidates its connection. Idempotent. Rejects with
   * `disposal_unconfirmed` when executions did not settle within `timeoutMs`;
   * the caller must then treat provider state as uncertain.
   */
  dispose(options: { timeoutMs?: number } = {}): Promise<void> {
    this.#disposal ??= (async () => {
      await Promise.allSettled([...this.#inFlight]);
      // A request that lost its response never reached discard. Nothing else will end its session.
      const owned = this.#unreleased?.all() ?? [];
      for (const session of owned) await this.#clean(session, work => this.#input.storage.borrow(work, { reserved: true })).result;
      const settled = await this.#input.storage.drain(options.timeoutMs ?? 10_000);
      // After the drain no callback can still change a row, so this read is the final answer.
      for (const session of this.#unreleased?.all() ?? []) await this.#reconcile(session);
      try { await this.#instance.dispose(); } catch { throw new AuthenticationProviderError("disposal_unconfirmed", "Authentication provider disposal was not confirmed."); }
      finally { this.#connection.close(); }
      if (!settled || this.#unreleased?.size) throw new AuthenticationProviderError("disposal_unconfirmed", "Authentication provider work did not settle before disposal.");
    })();
    return this.#disposal;
  }

  #notify(event: ProviderInvalidation): void {
    try { this.#input.onInvalidation?.(event); } catch {
      const operation = this.#operations.getStore();
      if (operation) operation.invalidationFailed = true;
    }
  }

  /**
   * One request-bound execution. The callback promise is tracked from actual
   * entry, because the gate can reject a borrow while its execution still runs.
   * After entry a gate failure cannot say whether the effect happened.
   */
  #lifetime<T>(operation: () => Promise<T>, options: { signal?: AbortSignal }, effectful: boolean, issued?: (sessionId: string) => void): BrowserLifetime<T> {
    let execution: Promise<T> | undefined;
    const pending = this.#run(() => {
      if (options.signal?.aborted) throw failed("cancelled");
      execution = operation();
      return execution;
    }, { signal: options.signal, issued });
    const result = pending.catch((error: unknown) => {
      if (effectful && execution && error instanceof Error && error.name === "ExclusiveConnectionError") throw failed("outcome_unconfirmed");
      throw error;
    });
    result.catch(noop);
    return { result, settled: pending.then(noop, noop).then(() => execution?.then(noop, noop)) };
  }

  #run<T>(operation: () => Promise<T>, options?: { signal?: AbortSignal | undefined; reserved?: boolean; issued?: ProviderOperation["issued"] }): Promise<T> {
    if (this.#disposal) return Promise.reject(new AuthenticationProviderError("provider_disposed", "The authentication provider was disposed."));
    const { issued, ...admission } = options ?? {};
    const state: ProviderOperation = { invalidationFailed: false, issued };
    const pending = this.#operations.run(state, async () => {
      let result: T;
      try { result = await this.#input.storage.borrow(operation, admission); } catch (error) {
        if (state.invalidationFailed && !(error instanceof AuthenticationProviderError && error.committed)) {
          throw new AuthenticationProviderError("invalidation_failed", "A committed change could not notify active sessions.", true);
        }
        throw safeError(error);
      }
      if (state.invalidationFailed) throw new AuthenticationProviderError("invalidation_failed", "A committed change could not notify active sessions.", true);
      return result;
    });
    this.#inFlight.add(pending);
    const forget = () => { this.#inFlight.delete(pending); };
    pending.then(forget, forget);
    return pending;
  }
}
