import { runWithTransaction, queueAfterTransactionHook } from "@better-auth/core/context";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { Kysely, SqliteDialect } from "kysely";
import type {
  AuthenticationProviderHost,
  AuthenticationProviderInstance,
  AuthenticationProviderModule,
  AuthenticationProviderOptions,
  AuthenticationProviderReadiness,
  LocalProvisionInput,
  LocalRecoveryInput,
  VerifiedProviderSession,
} from "../../../src/server/modules/authentication/provider-contract";

/** Exact pinned library this proof was verified against. */
export const BETTER_AUTH_VERSION = "1.7.14";
const PROVIDER_ID = "better-auth";
const IMPLEMENTATION_VERSION = "0.0.0-proof.2";

/** Model names frozen in controller migration 38. */
const MODELS = {
  user: "authentication_ba_user",
  session: "authentication_ba_session",
  account: "authentication_ba_account",
  verification: "authentication_ba_verification",
} as const;

/**
 * Proof-only fault points inside real library transactions. Never set outside
 * tests; the controller contract does not know about them.
 */
export interface ProofFaultInjection {
  afterProvisionedUser?: () => Promise<void>;
  afterDispose?: () => Promise<void>;
  beforeSessionDelete?: () => Promise<void>;
  beforeRecoveryCommit?: () => Promise<void>;
  /** Runs in the library's account update hook, inside its password transaction. */
  beforePasswordWrite?: () => Promise<void>;
  /** Makes the library expect a user column that controller storage lacks. */
  expectUnmigratedColumn?: boolean;
}
type ProofOptions = AuthenticationProviderOptions & { faultInjection?: ProofFaultInjection };

/**
 * Proposed proof settings, not approved product defaults: 8-hour sessions,
 * 15-minute reset tokens, 12–256 character passwords and per-IP limits.
 */
function libraryOptions(host: AuthenticationProviderHost, options: ProofOptions, database: Kysely<never>) {
  const base = new URL(options.baseURL);
  if (base.protocol !== "https:" && base.hostname !== "localhost") throw new Error("Provider base URL must use HTTPS.");
  if (options.secret.length < 32) throw new Error("Provider secret is too short.");
  return {
    appName: "Worktree Control",
    baseURL: base.origin,
    basePath: base.pathname.replace(/\/+$/, "") || "/api/auth",
    secret: options.secret,
    database: { db: database, type: "sqlite", transaction: true },
    user: {
      modelName: MODELS.user,
      ...(options.faultInjection?.expectUnmigratedColumn ? { additionalFields: { proofUnmigrated: { type: "string" as const, required: false } } } : {}),
    },
    session: {
      modelName: MODELS.session,
      expiresIn: 8 * 60 * 60,
      updateAge: 60 * 60,
      freshAge: 10 * 60,
      cookieCache: { enabled: false },
    },
    account: { modelName: MODELS.account, accountLinking: { enabled: false } },
    verification: { modelName: MODELS.verification, storeIdentifier: "hashed" },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 15 * 60,
      ...(options.passwordResetDelivery ? {
        sendResetPassword: async ({ user, token }: { user: { id: string }; token: string }) => {
          await options.passwordResetDelivery!({ subject: user.id, token });
        },
      } : {}),
    },
    trustedOrigins: [base.origin],
    rateLimit: {
      enabled: true,
      storage: "memory",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 3 },
        "/reset-password": { window: 60, max: 5 },
        "/change-password": { window: 60, max: 5 },
      },
    },
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
    // Better Call otherwise console.error's arbitrary exceptions after its default handler.
    // Rethrow through our handle boundary so only fixed events leave this package.
    onAPIError: { throw: true },
    logger: { level: "warn", log: (level: "error" | "warn" | "info" | "debug", message: string) => host.log(level, message) },
    hooks: {
      before: createAuthMiddleware(async context => {
        // Password changes always end every other session.
        if (context.path === "/change-password" && (context.body as { revokeOtherSessions?: unknown } | undefined)?.revokeOtherSessions !== true) {
          throw new APIError("BAD_REQUEST", { message: "Password changes must revoke other sessions." });
        }
      }),
    },
    databaseHooks: {
      account: {
        update: {
          before: async () => { await options.faultInjection?.beforePasswordWrite?.(); },
        },
      },
      session: {
        delete: {
          before: async () => { await options.faultInjection?.beforeSessionDelete?.(); },
          // Better Auth queues `after` hooks until the surrounding transaction commits.
          after: async (session: { id: string; userId: string }) => {
            host.invalidated({ kind: "session", providerId: PROVIDER_ID, sessionId: session.id, subject: session.userId });
          },
        },
      },
    },
  } satisfies BetterAuthOptions;
}

const iso = (value: Date | string) => new Date(value).toISOString();

class BetterAuthProofProvider implements AuthenticationProviderInstance {
  readonly #host: AuthenticationProviderHost;
  readonly #options: ProofOptions;
  #database: Kysely<never> | undefined;
  #auth: ReturnType<typeof betterAuth<ReturnType<typeof libraryOptions>>> | undefined;
  #disposal: Promise<void> | undefined;

  constructor(host: AuthenticationProviderHost, options: ProofOptions) {
    this.#host = host;
    this.#options = options;
  }

  /** Builds the library inside the initialization borrow and awaits its own schema check. */
  async initialize(): Promise<AuthenticationProviderReadiness> {
    this.#database = new Kysely<never>({ dialect: new SqliteDialect({ database: this.#host.connection }) });
    this.#auth = betterAuth(libraryOptions(this.#host, this.#options, this.#database));
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

  async handle(request: Request): Promise<Response> {
    const base = new URL(this.#options.baseURL);
    // The library trusts the configured base URL; refuse any other Host here.
    if (new URL(request.url).origin !== base.origin) return new Response(null, { status: 421 });
    try { return await this.#ready().handler(request); }
    catch { this.#host.log("error", "Authentication provider request failed."); return new Response(null, { status: 500 }); }
  }

  async signOut(request: Request): Promise<Response> {
    // Keep the real handler's CSRF and limiter. Its deletion failure can be swallowed.
    const session = await this.resolveSession(request.headers);
    const response = await this.handle(request);
    if (!response.ok) return response;
    if (session) await this.revokeSession(session.sessionId);
    if (await this.resolveSession(request.headers)) throw new Error("Session deletion was not confirmed.");
    return response;
  }

  async resolveSession(headers: Headers): Promise<VerifiedProviderSession | null> {
    const result = await this.#ready().api.getSession({ headers, query: { disableCookieCache: true } });
    if (!result) return null;
    // Email and password is the only enabled sign-in method.
    return {
      providerId: PROVIDER_ID,
      sessionId: result.session.id,
      subject: result.user.id,
      createdAt: iso(result.session.createdAt),
      expiresAt: iso(result.session.expiresAt),
      authentication: { method: "password", factors: 1 },
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
      // Kysely's destroy calls the borrowed facade's close, never SQLite's.
      await database?.destroy();
      await this.#options.faultInjection?.afterDispose?.();
    })();
    return this.#disposal;
  }

  #ready() {
    if (!this.#auth || this.#disposal) throw new Error("Provider is not initialized.");
    return this.#auth;
  }

  #assertPassword(config: { minPasswordLength: number; maxPasswordLength: number }, password: string): void {
    if (password.length < config.minPasswordLength || password.length > config.maxPasswordLength) throw new Error("Password length is outside the allowed range.");
  }
}

export const authenticationProvider: AuthenticationProviderModule = {
  contractVersion: 2,
  providerId: PROVIDER_ID,
  implementationVersion: IMPLEMENTATION_VERSION,
  storageRevision: 1,
  create(host, options) {
    return new BetterAuthProofProvider(host, options);
  },
};
