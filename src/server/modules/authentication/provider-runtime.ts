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
import { canonicalInstant, evaluateSessionAuthority, validateFactorLimits, type ProviderSessionState } from "./account-protection";

export type AuthenticationProviderErrorCode =
  | "provider_unavailable" | "principal_unavailable" | "subject_conflict" | "not_linked"
  | "invalid_session" | "invalid_input" | "invalidation_failed" | "provider_disposed" | "provider_failed" | "disposal_unconfirmed"
  | "maintenance" | "provider_configuration_restart_required";

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
  hasSubjectHistory(principalId: string): boolean;
  /** The mapped principal when the mapping is active and the principal is a current active owner. */
  resolveActivePrincipal(subject: string): string | null;
  revoke(input: { subject: string; actor: string }): ProviderSubjectMapping;
}

/** Implemented by the SQLite owner; nothing here opens or closes the database. */
export interface AuthenticationProviderStorage {
  readonly storageRevision: number;
  borrow<T>(operation: () => Promise<T>, options?: { signal?: AbortSignal; admissionTimeoutMs?: number }): Promise<T>;
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
  /** Application policy over this connection. Without limits it reads evidence and refuses factor work. */
  protection(providerId: string, limits?: ProviderFactorLimits): ProviderAccountProtection;
}

export interface LoadAuthenticationProviderInput {
  /** Absolute path or `file:` URL of a local module. No discovery, package names or remote URLs. */
  entry: string;
  providerId: string;
  storage: AuthenticationProviderStorage;
  options: AuthenticationProviderOptions;
  /** Called after commit. A throw is reported as `invalidation_failed` with `committed: true`. */
  onInvalidation?: (event: ProviderInvalidation) => void;
  log?: (level: "error" | "warn" | "info" | "debug", message: string) => void;
}

/** Provider evidence plus the controller's current mapping; grants no authority by itself. */
export interface ProviderPrincipalResolution {
  session: VerifiedProviderSession;
  principalId: string;
}
/** Only a supported combination carries committed evidence, and only that issues an actor. */
type ActorResolution = ProviderPrincipalResolution & { evidence?: ProviderSessionEvidence };

interface ActorEvidence {
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
function guardedProtection(protection: ProviderAccountProtection, controller: <T>(operation: () => T) => T): ProviderAccountProtection {
  const methods = Object.fromEntries(PROTECTION_METHODS.map(name => [name, (...input: unknown[]) =>
    controller(() => (protection[name] as (...value: unknown[]) => unknown).call(protection, ...input))]));
  return Object.freeze({ ...methods, enabled: protection.enabled }) as unknown as ProviderAccountProtection;
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
  const connection = input.storage.createProviderConnection();
  const operations = new AsyncLocalStorage<{ invalidationFailed: boolean }>();
  const subjects = input.storage.subjects(input.providerId);
  const controller = <T>(operation: () => T) => input.storage.runControllerOperation(operation);
  const protection = guardedProtection(input.storage.protection(input.providerId, limits), controller);
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
    return new AuthenticationProviderRuntime(input, provider, ready, connection, subjects, operations, Object.freeze({ ...readiness, library: Object.freeze({ ...readiness.library }) }));
  } catch (error) {
    try { await instance?.dispose(); } catch { throw new AuthenticationProviderError("disposal_unconfirmed", "Authentication provider disposal was not confirmed.").retainResource(instance); }
    finally { connection.close(); }
    throw safeError(error);
  }
}

/** Controller operations over a loaded provider. Every provider call runs inside one exclusive borrow. */
export class AuthenticationProviderRuntime implements ProviderSessionAuthority {
  readonly #input: LoadAuthenticationProviderInput;
  readonly #instance: AuthenticationProviderInstance;
  readonly #connection: ProviderSqliteConnection;
  readonly #subjects: ProviderSubjectStore;
  readonly #operations: AsyncLocalStorage<{ invalidationFailed: boolean }>;
  readonly #inFlight = new Set<Promise<unknown>>();
  // Weak ownership: retaining an actor retains its evidence, never a request ledger.
  readonly #actors = new WeakMap<ProviderSessionActor, Readonly<ActorEvidence>>();
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
    operations: AsyncLocalStorage<{ invalidationFailed: boolean }>,
    readiness: AuthenticationProviderReadiness,
  ) {
    this.#input = input;
    this.#instance = instance;
    this.#connection = connection;
    this.#subjects = subjects;
    this.#operations = operations;
    this.readiness = readiness;
    this.implementationVersion = provider.implementationVersion;
  }

  get disposed(): boolean { return this.#disposal !== undefined; }

  handle(request: Request): Promise<Response> {
    return this.#run(() => this.#instance.handle(request));
  }

  /** Current provider session, committed evidence and active owner mapping, all read under one borrow. */
  async resolve(headers: Headers): Promise<ProviderPrincipalResolution | null> {
    const resolved = await this.#resolve(headers);
    return resolved && { session: resolved.session, principalId: resolved.principalId };
  }

  #resolve(headers: Headers): Promise<ActorResolution | null> {
    return this.#run(async () => {
      const session = await this.#instance.resolveSession(headers);
      if (!session || session.providerId !== this.#input.providerId) return null;
      return this.#input.storage.runControllerOperation(() => this.#resolution(session));
    });
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
    return { session: { ...session, expiresAt: authority.deadline, authentication: authority.authentication }, principalId: state.principalId, evidence: authority.evidence };
  }

  /** Resolve outside core admission. Raw `resolve` evidence and structural actor copies never authorize. */
  async authenticate(headers: Headers): Promise<ProviderSessionActor | null> {
    if (!this.#supportsSessionAuthority()) throw unavailable("session authority");
    const resolution = await this.#resolve(headers);
    if (!resolution || this.disposed || !this.#input.storage.available()) return null;
    return this.#issueActor(resolution);
  }

  #issueActor(resolution: ActorResolution): ProviderSessionActor | null {
    const { session, principalId, evidence } = resolution;
    if (session.providerId !== this.#input.providerId || !evidence || evidence.sessionId !== session.sessionId || evidence.subject !== session.subject
      || !session.sessionId || !session.subject || !principalId || !canonicalInstant(session.createdAt)
      || !canonicalInstant(session.expiresAt) || session.createdAt >= session.expiresAt) return null;
    const actor = Object.freeze({ principalId, principalKind: "owner", credentialId: null, authenticationMethod: "provider_session" }) as ProviderSessionActor;
    this.#actors.set(actor, Object.freeze({ sessionId: session.sessionId, subject: session.subject, principalId,
      createdAt: session.createdAt, expiresAt: session.expiresAt, evidence: Object.freeze({ ...evidence }), authentication: Object.freeze({ ...session.authentication }) }));
    return actor;
  }

  /** Every decision reads committed authority on the controller-owned guarded handle. No Kysely or borrow. */
  isCurrentProviderSession(actor: ProviderSessionActor, now: string): boolean {
    const original = this.#actors.get(actor);
    if (!original || this.disposed || !this.#supportsSessionAuthority() || !this.#input.storage.available()
      || actor.authenticationMethod !== "provider_session" || actor.principalKind !== "owner"
      || actor.credentialId !== null || actor.principalId !== original.principalId || !Object.isFrozen(actor)
      || !canonicalInstant(now) || original.expiresAt <= now) return false;
    const current = this.#input.storage.currentSession(this.#input.providerId, original.sessionId);
    const authority = current && evaluateSessionAuthority(current, now);
    if (!current || !authority || current.subject !== original.subject || current.principalId !== original.principalId
      || current.createdAt !== original.createdAt) return false;
    const evidence = authority.evidence, frozen = original.evidence;
    return evidence.method === frozen.method && evidence.authenticatedAt === frozen.authenticatedAt && evidence.originalDeadline === frozen.originalDeadline
      && evidence.generation === frozen.generation && evidence.policyRevision === frozen.policyRevision && evidence.credential === frozen.credential
      && evidence.credentialBinding === frozen.credentialBinding && evidence.attemptId === frozen.attemptId;
  }

  /** Fixed browser operations only. Called outside core admission; no caller callbacks. */
  browser(operation: "sign-in" | "session" | "sign-out" | "password", request: Request, actor?: ProviderSessionActor | null): Promise<{ response: Response; actor: ProviderSessionActor | null }> {
    const paths = { "sign-in": "/sign-in/email", session: "/get-session", "sign-out": "/sign-out", password: "/change-password" };
    if (request.url !== `${this.#input.options.baseURL}${paths[operation]}`
      || request.method !== (operation === "session" ? "GET" : "POST") || !this.#supportsSessionAuthority()) {
      return Promise.reject(new AuthenticationProviderError("invalid_input", "Invalid browser operation."));
    }
    return this.#run(async () => {
      if (operation === "password") {
        // This check runs inside the ACTUAL queued borrow, immediately before native work.
        const original = actor && this.#actors.get(actor);
        const incoming = await this.#instance.resolveSession(request.headers);
        const valid = actor && this.#input.storage.runControllerOperation(() => this.isCurrentProviderSession(actor, new Date().toISOString()));
        if (!valid || !original || incoming?.sessionId !== original.sessionId || incoming.subject !== original.subject) {
          throw new AuthenticationProviderError("invalid_session", "Invalid browser session.");
        }
      }
      const native = operation === "sign-out" ? await this.#instance.signOut(request) : await this.#instance.handle(request);
      // Consume a bounded native body inside the borrow. Never expose its tokens or error text.
      const reader = native.body?.getReader();
      let bytes = 0;
      try {
        if (reader) for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 16 * 1024) throw new AuthenticationProviderError("provider_failed", "Invalid provider response.");
        }
      } finally { await reader?.cancel(); }
      const response = new Response(null, { status: native.status, headers: native.headers });
      if (!native.ok || operation === "sign-out") return { response, actor: null };
      const headers = new Headers(request.headers);
      const cookies = native.headers.getSetCookie();
      if (operation !== "session" || cookies.some(line => line.startsWith("__Secure-wtc.session_token="))) {
        const token = cookies.find(line => line.startsWith("__Secure-wtc.session_token="));
        if (token) headers.set("cookie", token.split(";")[0]!);
        else if (operation !== "session") throw new AuthenticationProviderError("provider_failed", "Invalid provider response.");
      }
      const session = await this.#instance.resolveSession(headers);
      if (!session) return { response, actor: null };
      const resolution = this.#input.storage.runControllerOperation(() => this.#resolution(session));
      const issued = resolution && this.#issueActor(resolution);
      if (!issued || (operation === "password" && issued.principalId !== actor?.principalId)) {
        if (operation !== "session") await this.#instance.revokeSession(session.sessionId);
        return { response, actor: null };
      }
      return { response, actor: issued };
    });
  }

  /** Safe public projection, only during a current admitted decision. */
  browserSession(actor: ProviderSessionActor) {
    if (!this.isCurrentProviderSession(actor, new Date().toISOString())) throw new AuthenticationProviderError("invalid_session", "Invalid browser session.");
    const original = this.#actors.get(actor)!;
    return { authenticated: true as const, principal: { id: actor.principalId, kind: actor.principalKind },
      expiresAt: original.expiresAt, authentication: original.authentication };
  }

  /** Discard an unreleased login/replacement cookie without accepting caller session IDs. */
  discardBrowserSession(actor: ProviderSessionActor): Promise<void> {
    const evidence = this.#actors.get(actor);
    if (!evidence) return Promise.reject(new AuthenticationProviderError("invalid_session", "Invalid browser session."));
    return this.#run(() => this.#instance.revokeSession(evidence.sessionId));
  }

  #supportsSessionAuthority(): boolean {
    // This projection is verified only for the fixed migration-40 adapter and pinned library.
    return this.#input.providerId === "better-auth" && this.#input.storage.storageRevision === 2
      && this.implementationVersion === "0.0.0-proof.3"
      && this.readiness.library?.name === "better-auth" && this.readiness.library.version === "1.7.14";
  }

  /** Protected local bootstrap: creates a password account and its mapping atomically. */
  provisionLocal(input: LocalProvisionInput): Promise<{ subject: string }> {
    for (const value of [input.principalId, input.email, input.name, input.password, input.actor]) {
      if (typeof value !== "string" || !value || value.length > 1024) return Promise.reject(new AuthenticationProviderError("invalid_input", "Provisioning input is invalid."));
    }
    return this.#run(async () => {
      const state = this.#input.storage.runControllerOperation(() => ({
        active: this.#subjects.isActiveOwner(input.principalId), history: this.#subjects.hasSubjectHistory(input.principalId),
      }));
      if (!state.active) throw new AuthenticationProviderError("principal_unavailable", "Only an existing active owner principal can be linked.");
      if (state.history) {
        throw new AuthenticationProviderError("subject_conflict", "The principal already has a provider account.");
      }
      return this.#instance.provisionLocal(input);
    });
  }

  /** Protected local recovery: replaces the password and revokes the account's sessions atomically. */
  recoverLocal(input: LocalRecoveryInput): Promise<void> {
    for (const value of [input.principalId, input.newPassword, input.actor]) {
      if (typeof value !== "string" || !value || value.length > 1024) return Promise.reject(new AuthenticationProviderError("invalid_input", "Recovery input is invalid."));
    }
    return this.#run(async () => {
      const linked = this.#input.storage.runControllerOperation(() => this.#subjects.findByPrincipal(input.principalId));
      if (!linked) throw new AuthenticationProviderError("not_linked", "The principal has no provider account.");
      if (this.#input.storage.runControllerOperation(() => this.#subjects.resolveActivePrincipal(linked.subject)) !== input.principalId) {
        throw new AuthenticationProviderError("principal_unavailable", "The active owner principal is unavailable.");
      }
      await this.#instance.recoverLocal(input);
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
      const settled = await this.#input.storage.drain(options.timeoutMs ?? 10_000);
      try { await this.#instance.dispose(); } catch { throw new AuthenticationProviderError("disposal_unconfirmed", "Authentication provider disposal was not confirmed."); }
      finally { this.#connection.close(); }
      if (!settled) throw new AuthenticationProviderError("disposal_unconfirmed", "Authentication provider work did not settle before disposal.");
    })();
    return this.#disposal;
  }

  #notify(event: ProviderInvalidation): void {
    try { this.#input.onInvalidation?.(event); } catch {
      const operation = this.#operations.getStore();
      if (operation) operation.invalidationFailed = true;
    }
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#disposal) return Promise.reject(new AuthenticationProviderError("provider_disposed", "The authentication provider was disposed."));
    const state = { invalidationFailed: false };
    const pending = this.#operations.run(state, async () => {
      let result: T;
      try { result = await this.#input.storage.borrow(operation); } catch (error) {
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
