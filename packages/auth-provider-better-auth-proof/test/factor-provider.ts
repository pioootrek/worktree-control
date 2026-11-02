import { AsyncLocalStorage } from "node:async_hooks";
import { getCurrentAdapter, runWithTransaction } from "@better-auth/core/context";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins/two-factor";
import { Kysely, SqliteDialect } from "kysely";
import { isTotpCode, observeTotpStep, readNativeTotpSecret, TOTP_SETTINGS } from "../src/totp-step";
import { FixtureAdmission, FIXTURE_ADMISSION_POLICY, serverAttemptId, StaleTotpStep, type AdmissionPolicy, type Ticket, type SessionEvidence } from "./factor-admission";
import type {
  AuthenticationProviderHost,
  AuthenticationProviderInstance,
  AuthenticationProviderModule,
  AuthenticationProviderOptions,
  AuthenticationProviderReadiness,
  ProviderInvalidation,
  ProviderSqliteConnection,
  VerifiedProviderSession,
} from "../../../src/server/modules/authentication/provider-contract";

/**
 * A3-I12 compatibility experiment. Never production code: TOTP is a candidate
 * already present in the installed library, not an adopted factor. This module
 * is only reachable from `factor-fixture.ts`, runs on a temporary extended
 * schema, and its implementation version is deliberately outside the runtime's
 * session-authority allowlist, so it can never mint a controller actor.
 * Numeric limits are library observations or fixture bounds, not product policy.
 */
export const FACTOR_IMPLEMENTATION_VERSION = "0.0.0-proof.factor";
export const FACTOR_MODEL = "authentication_ba_two_factor";
export const EVIDENCE_TABLE = "factor_fixture_evidence";
export const FACTOR_SQL_TRACE_LIMIT = 1024;
export const COOKIE = {
  session: "__Secure-wtc.session_token",
  challenge: "__Secure-wtc.two_factor",
  trust: "__Secure-wtc.trust_device",
  remember: "__Secure-wtc.dont_remember",
} as const;

/**
 * - `native`: the real handler, untouched.
 * - `handler-transaction`: naive `runWithTransaction` around `auth.handler`.
 * - `server-api-transaction`: the same around the server API, which skips the router.
 * - `bounded`: closed fixture operations, transaction-scoped Kysely, experimental outcome policy.
 */
export type FactorMode = "native" | "handler-transaction" | "server-api-transaction" | "bounded" | "admitted";
/** Experimental policy only. Passing characterization does not accept it for production. */
export type CommitPolicy = "classified" | "commit-every-response" | "rollback-every-failure";

/** SQL text only. Parameters, which could carry credentials, are never recorded. */
export interface TracedStatement { sql: string; inTransaction: boolean }

/** Mutable from tests, like `ProofFaultInjection`. Holds no credentials. */
export interface FactorControl {
  /** I13 test-only controls. Never taken from a request field/header. */
  admission: {
    policy: AdmissionPolicy;
    internalAttemptId?: string;
    lastAttemptId?: string;
    entries: Array<{ attemptId: string; charged: boolean; inTransaction: boolean }>;
    /** `verification-start` runs after the start sample and before native evaluates the code. */
    pause?: (stage: "after-admission" | "native-entry" | "verification-start" | "after-native" | "observer-pending" | "before-commit", connection: ProviderSqliteConnection) => Promise<void>;
    /** Replaces only the observer's two time samples. Native always uses its own clock. */
    observationClock?: (sample: "start" | "finish") => number;
  };
  mode: FactorMode;
  policy: CommitPolicy;
  /** Simulates a wrapper regression that lets a trust request reach the native handler. */
  forwardTrustRegression: boolean;
  /** A real library hook veto: createSession yields null, which becomes an error Response. */
  vetoSessionCreate: boolean;
  trace: TracedStatement[];
  /** Whether a real transaction was still open when a library after-hook ran. */
  afterHookInTransaction: boolean[];
  /** Burns of a challenge after a rolled-back verification; a separate committed write. */
  burned: number;
  fault?: { sql: RegExp; when: "before" | "after"; remaining: number; afterSql?: RegExp; armed?: boolean };
  outcomes: Array<"response" | "exception">;
  failCookie: boolean;
  failEvidence: boolean;
  probeAdapters: boolean;
  adapterScopes: Array<{ direct: boolean; internal: boolean }>;
}

export const newFactorControl = (mode: FactorMode): FactorControl => ({
  admission: { policy: { ...FIXTURE_ADMISSION_POLICY }, entries: [] },
  mode, policy: "classified", forwardTrustRegression: false, vetoSessionCreate: false, trace: [], afterHookInTransaction: [], burned: 0, outcomes: [], failCookie: false, failEvidence: false, probeAdapters: false, adapterScopes: [],
});

type FactorOptions = AuthenticationProviderOptions & { factorControl: FactorControl };
type LibraryConnection = Pick<AuthenticationProviderOptions, "baseURL" | "secret" | "clientIpHeader">;

/** The same settings as the password proof plus the candidate plugin. */
export function factorLibraryOptions(options: LibraryConnection, database: Kysely<never>, hooks: NonNullable<BetterAuthOptions["databaseHooks"]> = {}, transaction = true) {
  const base = new URL(options.baseURL);
  return {
    appName: "Worktree Control",
    baseURL: base.origin,
    basePath: base.pathname,
    secret: options.secret,
    database: { db: database, type: "sqlite", transaction },
    user: { modelName: "authentication_ba_user" },
    session: { modelName: "authentication_ba_session", expiresIn: 8 * 60 * 60, updateAge: 60 * 60, freshAge: 10 * 60, cookieCache: { enabled: false } },
    account: { modelName: "authentication_ba_account", accountLinking: { enabled: false } },
    verification: { modelName: "authentication_ba_verification", storeIdentifier: "hashed" },
    emailAndPassword: { enabled: true, disableSignUp: true, autoSignIn: false, minPasswordLength: 12, maxPasswordLength: 256 },
    trustedOrigins: [base.origin],
    rateLimit: { enabled: true, storage: "memory", window: 60, max: 100, customRules: { "/sign-in/email": { window: 60, max: 5 } } },
    advanced: {
      useSecureCookies: true,
      cookiePrefix: "wtc",
      disableCSRFCheck: false,
      disableOriginCheck: false,
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "strict" },
      ipAddress: { ipAddressHeaders: [options.clientIpHeader] },
      database: { validateSchema: true },
    },
    telemetry: { enabled: false },
    onAPIError: { throw: true },
    logger: { disabled: true },
    databaseHooks: hooks,
    plugins: [twoFactor({ issuer: "Worktree Control", twoFactorTable: FACTOR_MODEL, skipVerificationOnEnable: false, allowPasswordless: false, totpOptions: TOTP_SETTINGS })],
  } satisfies BetterAuthOptions;
}

/** SQL-only tracing and per-fixture restored fault injection, never library patches. */
function tracedConnection(connection: ProviderSqliteConnection, control: FactorControl, state: { open: boolean }): ProviderSqliteConnection {
  const execute = <T>(sql: string, work: () => T): T => {
    const fault = control.fault;
    if (fault?.afterSql?.test(sql)) fault.armed = true;
    const matches = fault && (!fault.afterSql || fault.armed) && fault.remaining > 0 && fault.sql.test(sql);
    const fail = () => { fault!.remaining--; throw new Error("fixture SQL boundary"); };
    if (matches && fault.when === "before") fail();
    const result = work();
    const verb = sql.trim().toLowerCase();
    if (verb === "begin") state.open = true;
    if (control.trace.length >= FACTOR_SQL_TRACE_LIMIT) control.trace.shift();
    control.trace.push({ sql, inTransaction: state.open });
    if (verb === "commit" || verb === "rollback") state.open = false;
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

interface Route { fields: readonly string[]; kind: "sign-in" | "enable" | "totp" | "recovery" | "reauth-context" | "reauth-totp" }
/** The closed bounded surface. Everything else, including every other native route, is 404. */
const ROUTES = new Map<string, Route>([
  ["/sign-in/email", { fields: ["email", "password"], kind: "sign-in" }],
  ["/two-factor/enable", { fields: ["password"], kind: "enable" }],
  ["/two-factor/reauthentication-context", { fields: [], kind: "reauth-context" }],
  ["/two-factor/reauthenticate-totp", { fields: ["code", "context"], kind: "reauth-totp" }],
  ["/two-factor/verify-totp", { fields: ["code"], kind: "totp" }],
  ["/two-factor/verify-backup-code", { fields: ["code"], kind: "recovery" }],
]);
/** A failed guess is the one failure whose writes must survive. */
const ACCOUNTED_FAILURES = new Set(["INVALID_CODE", "INVALID_BACKUP_CODE", "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE"]);

const isDeletion = (line: string) => /max-age=0/i.test(line) || /^[^=]+=;/.test(line);
const cookieName = (line: string) => line.slice(0, line.indexOf("="));

function fixed(status: number, body: Record<string, unknown>, cookies: readonly string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const line of cookies) headers.append("set-cookie", line);
  return new Response(JSON.stringify(body), { status, headers });
}
const denied = (status: number, reason: string, cookies: readonly string[] = []) => fixed(status, { outcome: "denied", reason }, cookies);

/** Duplicates are refused rather than resolved: a second value is never a choice to make here. */
function parseCookies(header: string | null): Map<string, string> | null {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (cookies.has(name)) return null;
    cookies.set(name, part.slice(index + 1).trim());
  }
  return cookies;
}
/** Signed cookie values are `value.signature`; only the library verifies the signature. */
const signedValue = (raw: string) => decodeURIComponent(raw).split(".")[0]!;

class Rollback extends Error {
  constructor(readonly response: Response) { super("rollback"); }
}

class FactorProofProvider implements AuthenticationProviderInstance {
  readonly #operation = new AsyncLocalStorage<{ subject?: string; origin?: Pick<SessionEvidence, "authenticatedAt" | "originalDeadline">; ticket?: Ticket; request: Request; startedAt?: number }>();
  readonly #host: AuthenticationProviderHost;
  readonly #options: FactorOptions;
  readonly #control: FactorControl;
  readonly #transaction = { open: false };
  readonly #notifications = new AsyncLocalStorage<ProviderInvalidation[]>();
  #expectedAdapter: unknown;
  #connection: ProviderSqliteConnection | undefined;
  #database: Kysely<never> | undefined;
  #auth: ReturnType<FactorProofProvider["createLibrary"]> | undefined;
  readonly #active = new AsyncLocalStorage<ReturnType<FactorProofProvider["createLibrary"]>>();

  constructor(host: AuthenticationProviderHost, options: FactorOptions) {
    this.#host = host;
    this.#options = options;
    this.#control = options.factorControl;
  }

  /** Only awaits readiness. The temporary owner applies DDL; a provider never migrates. */
  async initialize(): Promise<AuthenticationProviderReadiness> {
    this.#connection = tracedConnection(this.#host.connection, this.#control, this.#transaction);
    this.#database = new Kysely<never>({ dialect: new SqliteDialect({ database: this.#connection }) });
    const auth = this.createLibrary(this.#database);
    this.#auth = auth;
    const context = await auth.$context;
    if (typeof context.checkSchema !== "function") throw new Error("Library schema verification is unavailable.");
    await context.checkSchema();
    return { providerId: "better-auth", implementationVersion: FACTOR_IMPLEMENTATION_VERSION, library: { name: "better-auth", version: "1.7.14" }, schema: "verified" };
  }

  private admission() { return new FixtureAdmission(this.#connection!, this.#control.admission.policy); }

  createLibrary(database: Kysely<never>, transaction = true) {
    const options = factorLibraryOptions(this.#options, database, {
      session: {
        create: { before: async session => {
          const operation = this.#operation.getStore();
          if (operation) {
            operation.subject = session.userId;
            operation.origin = { authenticatedAt: new Date(session.createdAt).toISOString(), originalDeadline: new Date(session.expiresAt).toISOString() };
          }
          return this.#control.vetoSessionCreate ? false : undefined;
        } },
        delete: { after: async (session: { id: string; userId: string }) => {
          this.#control.afterHookInTransaction.push(this.#transaction.open);
          const event: ProviderInvalidation = { kind: "session", providerId: "better-auth", sessionId: session.id, subject: session.userId };
          const buffered = this.#notifications.getStore();
          if (buffered) buffered.push(event); else this.#host.invalidated(event);
        } },
      },
    }, transaction);
    return betterAuth({ ...options, hooks: { before: createAuthMiddleware(async ctx => {
      const operation = this.#operation.getStore();
      if (this.#control.mode === "admitted" && operation?.ticket && ctx.path.startsWith("/two-factor/verify-")) {
        const policy = this.admission();
        const charged = policy.readReceipt(operation.ticket.attemptId)?.state === "charged";
        const entries = this.#control.admission.entries;
        if (entries.length >= 256) throw new Error("Fixture trace capacity.");
        entries.push({ attemptId: operation.ticket.attemptId, charged, inTransaction: this.#transaction.open });
        await this.#control.admission.pause?.("native-entry", this.#connection!);
        if (operation.request.signal.aborted || !policy.usable(operation.ticket, Date.now())) throw new Error("Expired operation.");
        operation.startedAt = this.#observationTime("start");
        await this.#control.admission.pause?.("verification-start", this.#connection!);
      }
      if (!this.#control.probeAdapters) return;
      this.#control.adapterScopes.push({
        direct: ctx.context.adapter === this.#expectedAdapter,
        internal: await getCurrentAdapter(ctx.context.adapter) === this.#expectedAdapter,
      });
      return ctx.json({ fixtureAdapterProbe: true });
    }) } });
  }

  async handle(request: Request): Promise<Response> {
    const auth = this.#ready();
    switch (this.#control.mode) {
      case "bounded": return this.#bounded(request);
      case "admitted": return this.#bounded(request);
      case "handler-transaction": {
        const { adapter } = await auth.$context;
        return runWithTransaction(adapter, async () => {
          this.#expectedAdapter = await getCurrentAdapter(adapter);
          return auth.handler(request);
        });
      }
      case "server-api-transaction": {
        const { adapter } = await auth.$context;
        const body = await request.json() as { code: string };
        return runWithTransaction(adapter, async () => {
          this.#expectedAdapter = await getCurrentAdapter(adapter);
          return auth.api.verifyTOTP({ headers: request.headers, body, asResponse: true });
        });
      }
      default:
        try {
          const result = await auth.handler(request);
          this.#control.outcomes.push("response");
          return result;
        } catch { this.#control.outcomes.push("exception"); return new Response(null, { status: 500 }); }
    }
  }

  async #bounded(request: Request): Promise<Response> {
    const base = new URL(this.#options.baseURL);
    const url = new URL(request.url);
    const path = url.pathname.startsWith(`${base.pathname}/`) ? url.pathname.slice(base.pathname.length) : "";
    const route = ROUTES.get(path);
    if ((route?.kind.startsWith("reauth-") && this.#control.mode !== "admitted") || !route || request.method !== "POST" || url.search) return denied(404, "not_found");
    if (this.#control.mode === "admitted" && request.headers.get("origin") !== base.origin) return denied(403, "origin_refused");
    let body: unknown;
    try { body = JSON.parse(await request.text()); } catch { return denied(400, "invalid_body"); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return denied(400, "invalid_body");
    const input = body as Record<string, unknown>;
    const keys = Object.keys(input).sort();
    if (keys.join() !== [...route.fields].sort().join() || keys.some(key => typeof input[key] !== "string")) return denied(400, "invalid_fields");
    if (this.#control.mode === "admitted" && (route.kind === "totp" || route.kind === "reauth-totp") && !isTotpCode(input.code as string)) return denied(400, "invalid_code_format");
    const cookies = parseCookies(request.headers.get("cookie"));
    if (!cookies) return denied(400, "ambiguous_cookies");
    const session = route.kind === "sign-in" ? undefined : cookies.get(COOKIE.session);
    const challenge = route.kind === "totp" || route.kind === "recovery" ? cookies.get(COOKIE.challenge) : undefined;
    if (session && challenge) return denied(400, "ambiguous_cookies");
    if (route.kind !== "sign-in" && !session && !challenge) return denied(401, "unauthenticated");

    if (route.kind.startsWith("reauth-") && (!session || cookies.has(COOKIE.challenge))) return denied(401, "context_unavailable");
    const headers = new Headers({ "content-type": "application/json" });
    for (const name of ["origin", this.#options.clientIpHeader]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    // Only the one credential for this operation reaches native code, so trust,
    // dont-remember and unrelated session cookies cannot select another branch.
    if (session) headers.set("cookie", `${COOKIE.session}=${session}`);
    if (challenge) headers.set("cookie", `${COOKIE.challenge}=${challenge}`);
    const forwarded = route.kind === "reauth-totp" ? { code: input.code, trustDevice: false } : route.kind === "enable" ? { ...input, method: "totp" }
      : route.kind === "sign-in" ? input
        : { ...input, trustDevice: this.#control.forwardTrustRegression };
    const sanitized = new Request(route.kind === "reauth-totp" ? `${this.#options.baseURL}/two-factor/verify-totp` : request.url, { method: "POST", headers, body: JSON.stringify(forwarded), signal: request.signal });
    return this.#control.mode === "admitted" ? this.#admittedAtomic(route, sanitized, session, challenge, input) : this.#atomic(route, sanitized, challenge);
  }

  /** I13 admission and I17 step consumption. Two transactions on the same owner borrow. */
  async #admittedAtomic(route: Route, request: Request, session: string | undefined, challenge: string | undefined, input: Record<string, unknown>): Promise<Response> {
    const policy = this.admission();
    const attemptId = this.#control.admission.internalAttemptId ?? serverAttemptId();
    this.#control.admission.lastAttemptId = attemptId;
    let ticket: Ticket | undefined;
    const factorRoute = route.kind === "totp" || route.kind === "recovery" || route.kind === "reauth-totp";
    if (request.signal.aborted) return denied(409, "cancelled_before_admission");
    try {
      // Never a client-selected replay key. Even an internal duplicate only reads status.
      const duplicate = policy.readReceipt(attemptId);
      if (duplicate) return fixed(409, { outcome: "receipt", state: duplicate.state, committed: duplicate.state === "succeeded" });
      if (route.kind === "reauth-context") {
        // Explicit session-only capability issuance. No native verification or new session.
        // Use the root native adapter before opening the issuance transaction.
        const current = await this.#ready().api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
        if (!current || !session) throw new Error("Session unavailable.");
        return await this.#database!.transaction().execute(async () => {
          const origin = policy.enrollmentOrigin(current.session.id, current.user.id, Date.now());
          if (!origin || policy.factor(current.user.id)?.verified !== 1) throw new Error("Reauthentication unavailable.");
          const opaque = serverAttemptId();
          policy.issue(opaque, current.user.id, "reauthentication", Math.min(Date.now() + this.#control.admission.policy.ticketMs, Date.parse(origin.originalDeadline)), null, Date.now(), origin, current.session.id);
          if (!policy.bindContext(opaque, "reauthentication", Date.now())) throw new Error("Context unavailable.");
          await this.#control.admission.pause?.("before-commit", this.#connection!);
          if (request.signal.aborted) throw new Rollback(denied(409, "cancelled"));
          return fixed(200, { outcome: "reauthentication_context", context: opaque });
        });
      }
      if (factorRoute) {
        if (!challenge && route.kind === "recovery") return denied(403, "recovery_cannot_upgrade_session");
        let currentSessionId: string | undefined;
        if (session) {
          const current = await this.#ready().api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
          if (!current) return denied(401, "context_unavailable");
          currentSessionId = current.session.id;
        }
        const context = policy.bindContext(route.kind === "reauth-totp" ? input.context as string : challenge ?? session!, route.kind === "reauth-totp" ? "reauthentication" : challenge ? "login" : "enrollment", Date.now());
        if (!context || (currentSessionId && context.originSessionId !== currentSessionId)) return denied(401, "context_unavailable");
        try {
          ticket = await this.#database!.transaction().execute(async () => policy.admit(context, attemptId, Date.now()) ?? undefined);
        } catch {
          // Includes an error AFTER real COMMIT. Reconcile, but never evaluate on this call.
          // Reads on an unresolved transaction can see its own uncommitted writes.
          if (this.#transaction.open) return fixed(503, { outcome: "outcome_unconfirmed" });
          const receipt = policy.readReceipt(attemptId);
          if (receipt) policy.finishFailure(attemptId);
          return fixed(503, { outcome: "admission_error", charged: receipt !== null, reconciled: true, committed: receipt !== null });
        }
        if (!ticket) return denied(429, "admission_denied");
        // The synchronous confirmation is outside both transactions.
        if (policy.readReceipt(attemptId)?.state !== "charged") return denied(503, "charge_unconfirmed");
        await this.#control.admission.pause?.("after-admission", this.#connection!);
        if (request.signal.aborted || !policy.usable(ticket, Date.now())) throw new Rollback(denied(409, "cancelled_or_expired"));
      }
      const notifications: ProviderInvalidation[] = [];
      const operation = { request, ticket, subject: undefined as string | undefined, origin: undefined as Pick<SessionEvidence, "authenticatedAt" | "originalDeadline"> | undefined, startedAt: undefined as number | undefined };
      let response: Response;
      try {
        response = await this.#notifications.run(notifications, () => this.#database!.transaction().execute(async trx => {
          const scoped = this.createLibrary(trx, false);
          await (await scoped.$context).checkSchema!();
          return this.#active.run(scoped, () => this.#operation.run(operation, async () => {
            const native = await scoped.handler(request);
            const finishedAt = this.#observationTime("finish");
            await this.#control.admission.pause?.("after-native", this.#connection!);
            if (request.signal.aborted) throw new Rollback(denied(409, "cancelled"));
            if (!native.ok) throw new Rollback(denied(native.status, "native_failure"));
            const decision = await this.#decide(route, native, challenge !== undefined);
            if ("rollback" in decision) throw new Rollback(decision.rollback);
            const body = await decision.commit.clone().json() as Record<string, unknown>;
            if (body.outcome === "challenge") {
              const issued = native.headers.getSetCookie().find(line => line.startsWith(`${COOKIE.challenge}=`) && !isDeletion(line));
              const opaque = issued?.slice(COOKIE.challenge.length + 1).split(";")[0];
              // This unsigned identifier is extracted ONLY from our native issued response,
              // never from a presented client cookie. The complete opaque cookie is bound.
              const pending = opaque && await (await scoped.$context).internalAdapter.findVerificationValue(signedValue(opaque));
              if (!opaque || !pending || !operation.subject || !operation.origin || pending.value !== operation.subject) throw new Error("Issued context unconfirmed.");
              policy.issue(opaque, operation.subject, "login", new Date(pending.expiresAt).getTime(), pending.id, Date.now(), operation.origin);
              const bound = policy.bindContext(opaque, "login", Date.now());
              if (!bound) throw new Error("Issued binding unconfirmed.");
              policy.operationReceipt(attemptId, bound, Date.now());
            } else if (route.kind === "enable") {
              const current = await scoped.api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
              if (!current || !session) throw new Error("Enrollment context unconfirmed.");
              const origin = policy.enrollmentOrigin(current.session.id, current.user.id, Date.now());
              if (!origin) throw new Error("Enrollment origin unavailable.");
              policy.issue(session, current.user.id, "enrollment", Math.min(new Date(current.session.expiresAt).getTime(), Date.parse(origin.originalDeadline)), null, Date.now(), origin, current.session.id);
              const bound = policy.bindContext(session, "enrollment", Date.now());
              if (!bound) throw new Error("Enrollment binding unconfirmed.");
              policy.operationReceipt(attemptId, bound, Date.now());
            } else {
              const current = await scoped.api.getSession({ headers: route.kind === "reauth-totp" ? request.headers : new Headers({ cookie: decision.commit.headers.getSetCookie().map(line => line.split(";")[0]).join("; ") }), query: { disableCookieCache: true } });
              if (!current || (ticket && current.user.id !== ticket.subject)) throw new Error("Session subject unconfirmed.");
              const evidence: SessionEvidence = {
                sessionId: current.session.id, subject: current.user.id,
                authenticatedAt: new Date(current.session.createdAt).toISOString(), originalDeadline: new Date(current.session.expiresAt).toISOString(),
                observation: route.kind === "reauth-totp" ? "reauthentication" : route.kind === "sign-in" ? "password" : route.kind === "recovery" ? "recovery_code" : challenge ? "password_totp" : "enrollment",
              };
              if (!ticket && policy.factor(current.user.id)?.verified === 1) throw new Error("Selected protection requires verification.");
              if (request.signal.aborted) throw new Rollback(denied(409, "cancelled"));
              if (ticket) await this.#settle(policy, route, ticket, evidence, input.code as string, operation.startedAt, finishedAt, request.signal);
              else policy.passwordEvidence(attemptId, evidence, policy.generation(current.user.id));
            }
            if (request.signal.aborted) throw new Rollback(denied(409, "cancelled"));
            await this.#control.admission.pause?.("before-commit", this.#connection!);
            if (request.signal.aborted) throw new Rollback(denied(409, "cancelled"));
            if (factorRoute) return fixed(200, { outcome: "observation", authorizingMfa: false }, decision.commit.headers.getSetCookie());
            return decision.commit;
          }));
        }));
      } catch (error) {
        // Kysely may have thrown after the driver committed. A durable success
        // receipt resolves that ambiguity; it never triggers verifier re-entry.
        // Leave unresolved rollback to the owning gate, without publishing or
        // modifying receipts that may still be part of the open transaction.
        if (this.#transaction.open) return fixed(503, { outcome: "outcome_unconfirmed" });
        const receipt = policy.readReceipt(attemptId);
        if (receipt?.state === "succeeded") {
          for (const event of notifications) this.#host.invalidated(event);
          return fixed(503, { outcome: "completion_receipt", committed: true, state: "succeeded" });
        }
        if (ticket) policy.finishFailure(attemptId);
        return error instanceof Rollback ? error.response : fixed(500, { outcome: "success_error", committed: false });
      }
      for (const event of notifications) this.#host.invalidated(event);
      return response;
    } catch (error) {
      // Invalidation errors already carry committed:true through the host/runtime.
      if (typeof error === "object" && error && "committed" in error && error.committed === true) throw error;
      if (this.#transaction.open) return fixed(503, { outcome: "outcome_unconfirmed" });
      try { if (ticket) policy.finishFailure(attemptId); } catch { return fixed(503, { outcome: "outcome_unconfirmed" }); }
      return error instanceof Rollback ? error.response : fixed(503, { outcome: "outcome_unconfirmed" });
    }
  }

  #observationTime(sample: "start" | "finish"): number {
    return this.#control.admission.observationClock?.(sample) ?? Date.now();
  }

  /**
   * Native success is already in hand. The observer and the guarded step update
   * can only refuse it: any refusal rolls the whole success transaction back.
   */
  async #settle(policy: FixtureAdmission, route: Route, ticket: Ticket, evidence: SessionEvidence, code: string, startedAt: number | undefined, finishedAt: number, signal: AbortSignal): Promise<void> {
    const refused = () => new Rollback(denied(409, "presentation_refused"));
    if (signal.aborted) throw new Rollback(denied(409, "cancelled"));
    if (route.kind === "recovery") return policy.settleSuccess(ticket, evidence, Date.now());
    const factor = policy.factor(ticket.subject);
    if (!factor || startedAt === undefined) throw refused();
    const { secretConfig } = await this.#ready().$context;
    const observation = await readNativeTotpSecret(secretConfig, factor.secret)
      .then(async secret => (await Promise.all([
        observeTotpStep({ secret, code, startedAt, finishedAt }),
        this.#control.admission.pause?.("observer-pending", this.#connection!),
      ]))[0])
      .catch(() => ({ ok: false as const }));
    if (signal.aborted) throw new Rollback(denied(409, "cancelled"));
    if (!observation.ok) throw refused();
    try { policy.settleSuccess(ticket, evidence, Date.now(), observation.step); } catch (error) {
      throw error instanceof StaleTotpStep ? refused() : error;
    }
  }

  /** The library has no such boundary: step-up and unconfirmed-factor rules are enforced here. */
  async #preflight(route: Route, session: string | undefined, challenge: string | undefined, headers: Headers): Promise<Response | null> {
    if (route.kind !== "totp" && route.kind !== "recovery") return null;
    const context = await this.#ready().$context;
    const factorFor = (userId: string) => context.adapter.findOne<{ verified: boolean | null }>({ model: "twoFactor", where: [{ field: "userId", value: userId }] });
    if (session) {
      if (route.kind === "recovery") return denied(403, "recovery_cannot_upgrade_session");
      const current = await this.#ready().api.getSession({ headers: new Headers({ cookie: headers.get("cookie") ?? "" }), query: { disableCookieCache: true } });
      const factor = current && await factorFor(current.user.id);
      return factor && factor.verified === false ? null : denied(403, "step_up_unsupported");
    }
    const pending = await context.internalAdapter.findVerificationValue(signedValue(challenge!));
    if (!pending) return null;
    const factor = await factorFor(pending.value);
    return factor && factor.verified !== true ? denied(400, "factor_unconfirmed") : null;
  }

  async #atomic(route: Route, request: Request, challenge: string | undefined): Promise<Response> {
    const notifications: ProviderInvalidation[] = [];
    let result: Response;
    try {
      // Kysely Transaction is itself a supported Kysely database. Every adapter
      // on this short-lived auth instance receives that SAME transaction object.
      // Disable only nested library transactions; the outer transaction is real.
      // No mutation of context.adapter/internalAdapter or global library state.
      result = await this.#notifications.run(notifications, () => this.#database!.transaction().execute(async trx => {
        const scoped = this.createLibrary(trx, false);
        await (await scoped.$context).checkSchema!();
        return this.#active.run(scoped, async () => {
          const cookies = parseCookies(request.headers.get("cookie"))!;
          const refused = await this.#preflight(route, cookies.get(COOKIE.session), cookies.get(COOKIE.challenge), request.headers);
          if (refused) throw new Rollback(refused);
          const native = await scoped.handler(request);
          this.#control.outcomes.push("response");
          const decision = await this.#decide(route, native, challenge !== undefined);
          if ("rollback" in decision) throw new Rollback(decision.rollback);
          return decision.commit;
        });
      }));
    } catch (error) {
      if (!(error instanceof Rollback)) this.#control.outcomes.push("exception");
      const response = error instanceof Rollback ? error.response : denied(500, "rolled_back");
      // Fixture containment only: invalidate this challenge after rollback.
      // This is NOT durable account-level failed-guess accounting on SQL errors.
      if (challenge && response.status >= 500) await this.#burn(challenge);
      return response;
    }
    // Library after-hooks ran while the outer transaction was open; deliver only now.
    for (const event of notifications) this.#host.invalidated(event);
    return result;
  }

  async #burn(challenge: string): Promise<void> {
    const { internalAdapter } = await this.#ready().$context;
    const identifier = signedValue(challenge);
    try {
      await internalAdapter.consumeVerificationValue(identifier);
      await internalAdapter.consumeVerificationValue(`2fa-attempts-${identifier}`);
      this.#control.burned++;
    } catch { this.#host.log("error", "A failed challenge could not be spent."); }
  }

  async #decide(route: Route, native: Response, usesChallenge: boolean): Promise<{ commit: Response } | { rollback: Response }> {
    if (this.#control.failCookie) return { rollback: denied(500, "cookie_refused") };
    const parsed = await native.clone().json().catch(() => null) as Record<string, unknown> | null;
    const lines = native.headers.getSetCookie();
    if (lines.some(line => line.startsWith(`${COOKIE.trust}=`) && !isDeletion(line))) return { rollback: denied(500, "trust_cookie_refused") };
    // Native cookies stay private except session/challenge lines and approved deletions.
    const cookies = lines.filter(line => [COOKIE.session, COOKIE.challenge].includes(cookieName(line) as typeof COOKIE.session) || isDeletion(line));
    const { policy } = this.#control;
    const code = typeof parsed?.code === "string" ? parsed.code : "native_failure";
    if (!native.ok) {
      const response = denied(native.status, code, cookies);
      if (policy === "commit-every-response") return { commit: response };
      const accounted = (route.kind === "totp" || route.kind === "recovery") && ACCOUNTED_FAILURES.has(code);
      return policy === "rollback-every-failure" || !accounted ? { rollback: denied(native.status, code) } : { commit: response };
    }
    if (route.kind === "reauth-totp") {
      if (lines.length || this.#control.failEvidence) return { rollback: denied(500, "reauthentication_refused") };
      return { commit: fixed(200, { outcome: "reauthentication", authorizingMfa: false }) };
    }
    if (route.kind === "enable") return { commit: fixed(200, { outcome: "enrollment", totpURI: parsed?.totpURI, backupCodes: parsed?.backupCodes }) };
    if (route.kind === "sign-in" && parsed?.twoFactorRedirect === true) return { commit: fixed(200, { outcome: "challenge" }, cookies) };
    // A session is only ever the cookie plus its persisted row. The JSON token is never read.
    const line = lines.find(value => value.startsWith(`${COOKIE.session}=`) && !isDeletion(value));
    const token = line && signedValue(line.slice(COOKIE.session.length + 1).split(";")[0]!);
    const [row] = (token ? this.#connection!.prepare('SELECT "id" FROM "authentication_ba_session" WHERE "token" = ?').all([token]) : []) as Array<{ id: string }>;
    if (!row) return { rollback: denied(500, "session_unconfirmed") };
    const method = route.kind === "recovery" ? "recovery_code" : route.kind === "sign-in" ? "password" : usesChallenge ? "password_totp" : "enrollment";
    // Would-be controller evidence: same connection, so it shares the transaction.
    if (this.#control.failEvidence) throw new Error("fixture evidence failure");
    this.#connection!.prepare(`INSERT INTO "${EVIDENCE_TABLE}" ("sessionId", "method", "restricted", "verifiedAt") VALUES (?, ?, ?, ?)`)
      .run([row.id, method, route.kind === "recovery" ? 1 : 0, new Date().toISOString()]);
    return { commit: fixed(200, { outcome: route.kind === "recovery" ? "recovery" : "session", method, restricted: route.kind === "recovery" }, cookies) };
  }

  async signOut(request: Request): Promise<Response> { return this.handle(request); }

  /** Claims only what the contract can state. Nothing here can express a second factor. */
  async resolveSession(headers: Headers): Promise<VerifiedProviderSession | null> {
    const result = await this.#ready().api.getSession({ headers, query: { disableCookieCache: true } });
    if (!result) return null;
    return {
      providerId: "better-auth", sessionId: result.session.id, subject: result.user.id,
      createdAt: new Date(result.session.createdAt).toISOString(), expiresAt: new Date(result.session.expiresAt).toISOString(),
      authentication: { method: "password", factors: 1 },
    };
  }

  async provisionLocal(): Promise<{ subject: string }> { throw new Error("The factor fixture does not provision accounts."); }
  async recoverLocal(): Promise<void> { throw new Error("The factor fixture does not recover accounts."); }
  async revokeSession(): Promise<void> { throw new Error("The factor fixture does not revoke sessions."); }
  async revokeSubjectSessions(): Promise<void> { throw new Error("The factor fixture does not revoke sessions."); }

  async dispose(): Promise<void> {
    const database = this.#database;
    this.#auth = undefined;
    this.#database = undefined;
    await database?.destroy();
  }

  #ready() {
    if (!this.#auth) throw new Error("Provider is not initialized.");
    return this.#active.getStore() ?? this.#auth;
  }
}

export const authenticationProvider: AuthenticationProviderModule = {
  contractVersion: 2,
  providerId: "better-auth",
  implementationVersion: FACTOR_IMPLEMENTATION_VERSION,
  storageRevision: 1,
  create(host, options) { return new FactorProofProvider(host, options as FactorOptions); },
};
