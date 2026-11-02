import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { runWithTransaction, queueAfterTransactionHook } from "@better-auth/core/context";
import { betterAuth } from "better-auth";
import { Kysely, SqliteDialect } from "kysely";
import type {
  AuthenticationProviderHost,
  AuthenticationProviderInstance,
  AuthenticationProviderModule,
  AuthenticationProviderReadiness,
  LocalProvisionInput,
  LocalRecoveryInput,
  ProviderInvalidation,
  ProviderSqliteConnection,
  VerifiedProviderSession,
} from "../../../src/server/modules/authentication/provider-contract";
import { COOKIE, denied, FACTOR_ROUTES, FactorCeremonies, fixed, issuedCookie, parseCookies, Rollback, signedValue, type CeremonyOperation, type ScopedLibrary } from "./factor-ceremonies";
import { libraryOptions, type LibraryCallbacks, type ProofFaultInjection, type ProofOptions } from "./library";

export type { ProofFaultInjection } from "./library";

/** Exact pinned library this proof was verified against. */
export const BETTER_AUTH_VERSION = "1.7.14";
const PROVIDER_ID = "better-auth";
const IMPLEMENTATION_VERSION = "0.0.0-proof.3";

/** Native password routes that create no session. Every other path is refused below. */
const NATIVE_ROUTES = new Map([
  ["/get-session", "GET"], ["/sign-out", "POST"], ["/request-password-reset", "POST"], ["/reset-password", "POST"], ["/revoke-sessions", "POST"], ["/update-user", "POST"],
]);

/** Tracks the real transaction state, including a failed COMMIT. SQL fault seam for tests only. */
function trackedConnection(connection: ProviderSqliteConnection, state: { open: boolean; ended?: "commit" | "rollback" }, faults: ProofFaultInjection | undefined): ProviderSqliteConnection {
  const execute = <T>(sql: string, work: () => T): T => {
    const fault = faults?.sqlFault;
    if (fault?.afterSql?.test(sql)) fault.armed = true;
    const matches = fault && (!fault.afterSql || fault.armed) && fault.remaining > 0 && fault.sql.test(sql);
    const fail = () => { fault!.remaining--; throw new Error("Fixture SQL boundary."); };
    if (matches && fault.when === "before") fail();
    const result = work();
    const verb = sql.trim().toLowerCase();
    if (verb === "begin") { state.open = true; state.ended = undefined; }
    if (verb === "commit" || verb === "rollback") { state.open = false; state.ended = verb; }
    if (matches && fault.when === "after") fail();
    return result;
  };
  return {
    prepare(sql) {
      const statement = connection.prepare(sql);
      return {
        reader: statement.reader,
        all: parameters => execute(sql, () => statement.all(parameters)),
        run: parameters => execute(sql, () => statement.run(parameters)),
        iterate: parameters => execute(sql, () => statement.iterate(parameters)),
      };
    },
    close() { connection.close(); },
  };
}

const iso = (value: Date | string) => new Date(value).toISOString();

class BetterAuthProofProvider implements AuthenticationProviderInstance {
  readonly #host: AuthenticationProviderHost;
  readonly #options: ProofOptions;
  readonly #operation = new AsyncLocalStorage<CeremonyOperation>();
  readonly #notifications = new AsyncLocalStorage<ProviderInvalidation[]>();
  readonly #active = new AsyncLocalStorage<ReturnType<BetterAuthProofProvider["createLibrary"]>>();
  readonly #transaction: { open: boolean; ended?: "commit" | "rollback" } = { open: false };
  readonly #ceremonies: FactorCeremonies;
  #connection: ProviderSqliteConnection | undefined;
  #database: Kysely<never> | undefined;
  #auth: ReturnType<BetterAuthProofProvider["createLibrary"]> | undefined;
  #disposal: Promise<void> | undefined;

  constructor(host: AuthenticationProviderHost, options: ProofOptions) {
    this.#host = host;
    this.#options = options;
    this.#ceremonies = new FactorCeremonies({
      protection: host.protection,
      baseURL: options.baseURL,
      clientIpHeader: options.clientIpHeader,
      connection: () => this.#connection!,
      faults: () => this.#options.faultInjection,
      transactionOpen: () => this.#transaction.open,
      root: () => this.#ready() as unknown as ScopedLibrary,
      commit: work => this.#database!.transaction().execute(async () => work()),
      atomic: input => this.#atomic(input),
      withOperation: (operation, work) => this.#operation.run(operation, work),
    });
  }

  createLibrary(database: Kysely<never>, transaction = true) {
    const callbacks: LibraryCallbacks = {
      sessionCreating: session => {
        const operation = this.#operation.getStore();
        if (operation) {
          operation.subject = session.userId;
          operation.origin = { authenticatedAt: iso(session.createdAt), originalDeadline: iso(session.expiresAt) };
        }
        return this.#options.faultInjection?.vetoSession ? false : undefined;
      },
      sessionDeleted: async session => {
        const event: ProviderInvalidation = { kind: "session", providerId: PROVIDER_ID, sessionId: session.id, subject: session.userId };
        const buffered = this.#notifications.getStore();
        if (buffered) buffered.push(event); else this.#host.invalidated(event);
      },
      beforeNative: async path => { const operation = this.#operation.getStore(); if (operation) await this.#ceremonies.beforeNative(operation, path); },
      registered: input => { this.#ceremonies.registered(this.#operation.getStore(), input); },
      authenticated: input => { this.#ceremonies.authenticated(this.#operation.getStore(), input); },
    };
    return betterAuth(libraryOptions(this.#host, this.#options, database, callbacks, transaction));
  }

  /** Builds the library inside the initialization borrow and awaits its own schema check. */
  async initialize(): Promise<AuthenticationProviderReadiness> {
    this.#connection = trackedConnection(this.#host.connection, this.#transaction, this.#options.faultInjection);
    this.#database = new Kysely<never>({ dialect: new SqliteDialect({ database: this.#connection }) });
    this.#auth = this.createLibrary(this.#database);
    const context = await this.#auth.$context;
    // Construction only starts this check and logs failures; readiness must await it.
    if (typeof context.checkSchema !== "function") throw new Error("Library schema verification is unavailable.");
    await context.checkSchema();
    // In 1.7.14 deleteManyWithHooks snapshots only the default first 100 rows,
    // though it deletes all matches. Wrap the shared bulk operation so native
    // password/reset/revoke handlers and local administration notify the whole
    // subject. Queue first, but deliver only after the enclosing commit; a
    // failing per-session listener must not suppress the complete notification.
    const deleteUserSessions = context.internalAdapter.deleteUserSessions.bind(context.internalAdapter);
    context.internalAdapter.deleteUserSessions = async subject => runWithTransaction(context.adapter, async () => {
      await queueAfterTransactionHook(async () => { this.#host.invalidated({ kind: "subject", providerId: PROVIDER_ID, subject }); });
      await deleteUserSessions(subject);
    });
    return { providerId: PROVIDER_ID, implementationVersion: IMPLEMENTATION_VERSION, library: { name: "better-auth", version: BETTER_AUTH_VERSION }, schema: "verified" };
  }

  /**
   * A scoped instance whose every adapter receives the same Kysely transaction,
   * with nested library transactions off. Its notifications wait in a buffer
   * until the outer COMMIT is known. Nothing shared is mutated.
   */
  async #scoped(database: Kysely<never>) {
    const scoped = this.createLibrary(database, false);
    const context = await scoped.$context;
    await context.checkSchema!();
    const deleteUserSessions = context.internalAdapter.deleteUserSessions.bind(context.internalAdapter);
    context.internalAdapter.deleteUserSessions = async subject => {
      this.#notifications.getStore()?.push({ kind: "subject", providerId: PROVIDER_ID, subject });
      await deleteUserSessions(subject);
    };
    return scoped;
  }

  /**
   * One native operation and its controller evidence commit together, or neither
   * does. An uncertain commit never releases a cookie, and known commit alone
   * releases notifications. Current authority never depends on those: it reads
   * committed state at every decision.
   */
  async #atomic(input: { attemptId: string; ticket?: unknown; work: (scoped: ScopedLibrary) => Promise<Response> }): Promise<Response> {
    const notifications: ProviderInvalidation[] = [];
    const publish = () => { for (const event of notifications) this.#host.invalidated(event); };
    let response: Response, finished = false;
    try {
      response = await this.#notifications.run(notifications, () => this.#database!.transaction().execute(async trx => {
        const scoped = await this.#scoped(trx as unknown as Kysely<never>);
        const result = await this.#active.run(scoped, () => input.work(scoped as unknown as ScopedLibrary));
        finished = true;
        return result;
      }));
    } catch (error) {
      if (this.#transaction.open) return fixed(503, { outcome: "outcome_unconfirmed" });
      let outcome;
      try {
        outcome = this.#host.protection.outcome(input.attemptId);
        if (outcome !== "succeeded" && input.ticket) this.#host.protection.fail(input.attemptId);
      } catch { return fixed(503, { outcome: "outcome_unconfirmed" }); }
      if (outcome === "succeeded") {
        publish();
        return fixed(503, { outcome: "completion_receipt", committed: true });
      }
      if (error instanceof Rollback) return error.response;
      this.#host.log("error", "Authentication provider transaction failed.");
      // Work finished, so only COMMIT failed. Without a receipt its effect cannot be proved either way.
      if (finished && this.#transaction.ended !== "rollback") return fixed(503, { outcome: "outcome_unconfirmed" });
      return fixed(500, { outcome: "rolled_back", committed: false });
    }
    publish();
    return response;
  }

  async handle(request: Request): Promise<Response> {
    const base = new URL(this.#options.baseURL);
    const url = new URL(request.url);
    // The library trusts the configured base URL; refuse any other Host here.
    if (url.origin !== base.origin) return new Response(null, { status: 421 });
    try {
      const path = url.pathname.startsWith(`${base.pathname}/`) ? url.pathname.slice(base.pathname.length) : "";
      const factor = FACTOR_ROUTES.get(path);
      if (factor) return factor.method === request.method && !url.search ? await this.#ceremonies.handle(factor, request) : denied(404, "not_found");
      if (path === "/sign-in/email" && request.method === "POST") return await this.#signIn(request);
      if (path === "/change-password" && request.method === "POST") return await this.#changePassword(request);
      if (NATIVE_ROUTES.get(path) !== request.method) return denied(404, "not_found");
      return await this.#ready().handler(request);
    } catch (error) {
      if (typeof error === "object" && error && "committed" in error && error.committed === true) throw error;
      this.#host.log("error", "Authentication provider request failed.");
      return new Response(null, { status: 500 });
    }
  }

  /** The same request without cookies, so no trust cookie can select a native branch. */
  async #cookieless(request: Request, cookie?: string): Promise<Request> {
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    if (cookie) headers.set("cookie", cookie);
    return new Request(request.url, { method: "POST", headers, body: await request.text(), signal: request.signal });
  }

  /** Native evidence for what it verified, in the transaction that creates the session. */
  async #signIn(request: Request): Promise<Response> {
    const forwarded = await this.#cookieless(request), attemptId = randomUUID();
    const operation: CeremonyOperation = { signal: request.signal };
    return this.#atomic({ attemptId, work: scoped => this.#operation.run(operation, async () => {
      const native = await scoped.handler(forwarded);
      await this.#options.faultInjection?.factorPause?.("after-native", this.#connection!);
      if (request.signal.aborted) throw new Rollback(denied(409, "cancelled"));
      if (!native.ok) throw new Rollback(native);
      const lines = native.headers.getSetCookie();
      const result = await native.clone().json().catch(() => null) as { twoFactorRedirect?: unknown } | null;
      if (result?.twoFactorRedirect === true) {
        const opaque = issuedCookie(lines, COOKIE.challenge);
        const pending = opaque && await (await scoped.$context).internalAdapter.findVerificationValue(signedValue(opaque));
        const { subject, origin } = operation;
        if (!opaque || !pending || !subject || !origin || pending.value !== subject) throw new Rollback(denied(500, "challenge_unconfirmed"));
        if (!this.#host.protection.issueTotpLogin({ opaque, subject, nativeId: pending.id, nativeDeadline: new Date(pending.expiresAt).getTime(), ...origin, now: Date.now() })) throw new Rollback(denied(403, "protection_required"));
        await this.#options.faultInjection?.factorPause?.("before-commit", this.#connection!);
        if (request.signal.aborted) throw new Rollback(denied(409, "cancelled"));
        return fixed(200, { outcome: "challenge" }, lines.filter(line => line.startsWith(`${COOKIE.challenge}=`)));
      }
      const issued = issuedCookie(lines, COOKIE.session);
      const current = issued && await scoped.api.getSession({ headers: new Headers({ cookie: `${COOKIE.session}=${issued}` }), query: { disableCookieCache: true, disableRefresh: true } });
      if (!current) throw new Rollback(denied(500, "session_unconfirmed"));
      // A selected method is an alternative to this password, never something it can skip.
      if (!this.#host.protection.recordPasswordSession({ sessionId: current.session.id, subject: current.user.id, attemptId, now: Date.now() })) throw new Rollback(denied(403, "protection_required"));
      await this.#options.faultInjection?.factorPause?.("before-commit", this.#connection!);
      if (request.signal.aborted) throw new Rollback(denied(409, "cancelled"));
      return native;
    }) });
  }

  /** Native replaces the session; the replacement inherits the original authentication and deadline. */
  async #changePassword(request: Request): Promise<Response> {
    const cookies = parseCookies(request.headers.get("cookie"));
    const session = cookies?.get(COOKIE.session);
    const cookie = session ? `${COOKIE.session}=${session}` : undefined;
    const forwarded = await this.#cookieless(request, cookie), attemptId = randomUUID();
    return this.#atomic({ attemptId, work: async scoped => {
      const before = cookie ? await scoped.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true, disableRefresh: true } }) : null;
      const evidence = before && this.#host.protection.currentEvidence(before.session.id, Date.now());
      if (request.signal.aborted) throw new Rollback(denied(409, "cancelled"));
      if (before && !evidence) throw new Rollback(denied(401, "session_refused"));
      const native = await scoped.handler(forwarded);
      if (request.signal.aborted) throw new Rollback(denied(409, "cancelled"));
      if (!native.ok || !evidence) throw new Rollback(native);
      const issued = issuedCookie(native.headers.getSetCookie(), COOKIE.session);
      const current = issued && await scoped.api.getSession({ headers: new Headers({ cookie: `${COOKIE.session}=${issued}` }), query: { disableCookieCache: true, disableRefresh: true } });
      if (!current || current.user.id !== evidence.subject) throw new Rollback(denied(500, "session_unconfirmed"));
      this.#host.protection.inheritSession(evidence, { sessionId: current.session.id, attemptId });
      await this.#options.faultInjection?.factorPause?.("before-commit", this.#connection!);
      if (request.signal.aborted) throw new Rollback(denied(409, "cancelled"));
      // Native may have deleted the original session already. Validate the
      // replacement against its inherited deadline and current account state
      // inside this transaction, before password/revocation effects commit.
      if (!this.#host.protection.currentEvidence(current.session.id, Date.now())) throw new Rollback(denied(401, "session_refused"));
      // The strict browser boundary accepts one cookie per name. Discard the
      // native middleware's refresh of the now-deleted session, keeping only
      // its final replacement; do not relax validation of arbitrary cookies.
      const lines = native.headers.getSetCookie(), headers = new Headers(native.headers);
      const lastSession = lines.findLastIndex(line => line.startsWith(`${COOKIE.session}=`));
      headers.delete("set-cookie");
      for (const [index, line] of lines.entries()) {
        if (!line.startsWith(`${COOKIE.session}=`) || index === lastSession) headers.append("set-cookie", line);
      }
      return new Response(native.body, { status: native.status, statusText: native.statusText, headers });
    } });
  }

  async #nativeSession(headers: Headers) {
    return this.#ready().api.getSession({ headers, query: { disableCookieCache: true } });
  }

  async signOut(request: Request): Promise<Response> {
    // Keep the real handler's CSRF and limiter. Its deletion failure can be swallowed.
    const session = await this.#nativeSession(request.headers);
    const response = await this.handle(request);
    if (!response.ok) return response;
    if (session) await this.revokeSession(session.session.id);
    if (await this.#nativeSession(request.headers)) throw new Error("Session deletion was not confirmed.");
    return response;
  }

  /** A native session authorizes only through current controller evidence. */
  async resolveSession(headers: Headers): Promise<VerifiedProviderSession | null> {
    const result = await this.#nativeSession(headers);
    const evidence = result && this.#host.protection.currentEvidence(result.session.id, Date.now());
    if (!result || !evidence) return null;
    const authentication = evidence.method === "password" ? { method: "password", factors: 1 } as const : { method: evidence.method, factors: 2 } as const;
    return {
      providerId: PROVIDER_ID,
      sessionId: result.session.id,
      subject: result.user.id,
      createdAt: iso(result.session.createdAt),
      expiresAt: iso(result.session.expiresAt),
      authentication,
    };
  }

  async provisionLocal(input: LocalProvisionInput): Promise<{ subject: string }> {
    const context = await this.#ready().$context;
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("Invalid email.");
    this.#assertPassword(context.password.config, input.password);
    // Hash before the transaction to keep the connection borrow short.
    const hash = await context.password.hash(input.password);
    return runWithTransaction(context.adapter, async () => {
      const user = await context.internalAdapter.createUser({ email, name: input.name, emailVerified: false }, { method: "admin" });
      await this.#options.faultInjection?.afterProvisionedUser?.();
      await context.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });
      this.#host.subjects.link({ subject: user.id, principalId: input.principalId, actor: input.actor });
      this.#host.subjects.record("authentication.provider.account_provisioned", { subject: user.id, principalId: input.principalId, actor: input.actor });
      return { subject: user.id };
    });
  }

  async recoverLocal(input: LocalRecoveryInput): Promise<void> {
    const context = await this.#ready().$context;
    const mapping = this.#host.subjects.findByPrincipal(input.principalId);
    if (!mapping) throw new Error("Principal has no provider account.");
    this.#assertPassword(context.password.config, input.newPassword);
    const hash = await context.password.hash(input.newPassword);
    const subject = mapping.subject;
    await runWithTransaction(context.adapter, async () => {
      await context.internalAdapter.deleteUserSessions(subject);
      if (await context.internalAdapter.findCredentialAccount(subject)) await context.internalAdapter.updatePassword(subject, hash);
      else await context.internalAdapter.linkAccount({ userId: subject, providerId: "credential", accountId: subject, password: hash });
      this.#host.subjects.record("authentication.provider.password_recovered", { subject, principalId: input.principalId, actor: input.actor });
      await this.#options.faultInjection?.beforeRecoveryCommit?.();
    });
  }

  async revokeSession(sessionId: string): Promise<void> {
    const context = await this.#ready().$context;
    const session = await context.adapter.findOne<{ token: string }>({ model: "session", where: [{ field: "id", value: sessionId }] });
    if (session) await context.internalAdapter.deleteSession(session.token);
  }

  async revokeSubjectSessions(subject: string): Promise<void> {
    const context = await this.#ready().$context;
    await context.internalAdapter.deleteUserSessions(subject);
  }

  dispose(): Promise<void> {
    this.#disposal ??= (async () => {
      const database = this.#database;
      this.#auth = undefined;
      this.#database = undefined;
      this.#connection = undefined;
      // Kysely's destroy calls the borrowed facade's close, never SQLite's.
      await database?.destroy();
      await this.#options.faultInjection?.afterDispose?.();
    })();
    return this.#disposal;
  }

  #ready() {
    if (!this.#auth || this.#disposal) throw new Error("Provider is not initialized.");
    return this.#active.getStore() ?? this.#auth;
  }

  #assertPassword(config: { minPasswordLength: number; maxPasswordLength: number }, password: string): void {
    if (password.length < config.minPasswordLength || password.length > config.maxPasswordLength) throw new Error("Password length is outside the allowed range.");
  }
}

export const authenticationProvider: AuthenticationProviderModule = {
  contractVersion: 3,
  providerId: PROVIDER_ID,
  implementationVersion: IMPLEMENTATION_VERSION,
  storageRevision: 2,
  create(host, options) {
    return new BetterAuthProofProvider(host, options);
  },
};
