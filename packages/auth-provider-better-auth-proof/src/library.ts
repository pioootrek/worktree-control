import { passkey } from "@better-auth/passkey";
import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins/two-factor";
import type { Kysely } from "kysely";
import type {
  AuthenticationProviderHost,
  AuthenticationProviderOptions,
  ProviderSqliteConnection,
} from "../../../src/server/modules/authentication/provider-contract";
import { TOTP_SETTINGS } from "./totp-step";

/** Model names frozen in controller migrations 38 and 40. */
export const MODELS = {
  user: "authentication_ba_user",
  session: "authentication_ba_session",
  account: "authentication_ba_account",
  verification: "authentication_ba_verification",
  twoFactor: "authentication_ba_two_factor",
  passkey: "authentication_ba_passkey",
} as const;

export type FactorStage = "after-admission" | "native-entry" | "verification-start" | "after-native" | "observer-pending" | "before-commit";

/**
 * Proof-only fault points inside real library transactions. Never set outside
 * tests; the controller contract does not know about them.
 */
export interface ProofFaultInjection {
  afterProvisionedUser?: () => Promise<void>;
  afterDispose?: () => Promise<void>;
  beforeSessionDelete?: () => Promise<void>;
  /** Runs after the row is gone, like a stalled listener. */
  afterSessionDelete?: () => Promise<void>;
  beforeRecoveryCommit?: () => Promise<void>;
  /** Runs in the library's account update hook, inside its password transaction. */
  beforePasswordWrite?: () => Promise<void>;
  /** Makes the library expect a user column that controller storage lacks. */
  expectUnmigratedColumn?: boolean;
  /** Pauses a real ceremony. Receives the borrowed connection, like the failing writer would. */
  factorPause?: (stage: FactorStage, connection: ProviderSqliteConnection) => Promise<void>;
  /** Replaces only the observer's two time samples. Native always uses its own clock. */
  observationClock?: (sample: "start" | "finish") => number;
  /** Fails one matching SQL statement. A statement after the fault may arm it. */
  sqlFault?: { sql: RegExp; when: "before" | "after"; remaining: number; afterSql?: RegExp; armed?: boolean };
  /** A real library hook veto: session creation yields an error Response. */
  vetoSession?: boolean;
}
export type ProofOptions = AuthenticationProviderOptions & { faultInjection?: ProofFaultInjection };

type SessionEvent = { id: string; userId: string };
/** Supported library callbacks only. No verifier replacement or library patches. */
export interface LibraryCallbacks {
  sessionCreating(session: { userId: string; createdAt: Date; expiresAt: Date }): boolean | void;
  sessionDeleted(session: SessionEvent): Promise<void>;
  beforeNative(path: string): Promise<void>;
  registered(input: { verified: boolean; subject: string }): void;
  authenticated(input: { verified: boolean; userVerified: boolean; credential: string; userHandle: string | null | undefined }): void;
}
export const TOTP_ISSUER = "Worktree Control";
export const refusal = () => new APIError("FORBIDDEN", { message: "Verification refused." });

/** Without callbacks every WebAuthn completion refuses. Migration tests compile from this. */
const CLOSED: LibraryCallbacks = {
  sessionCreating: () => undefined,
  sessionDeleted: async () => undefined,
  beforeNative: async () => undefined,
  registered() { throw refusal(); },
  authenticated() { throw refusal(); },
};

/**
 * Proposed proof settings, not approved product defaults: 8-hour sessions,
 * 15-minute reset tokens, 12–256 character passwords and per-IP limits.
 * Plugins are always present so schema verification covers selected protection,
 * but their routes stay unreachable: `handle` is a closed allowlist.
 */
export function libraryOptions(host: Pick<AuthenticationProviderHost, "log">, options: ProofOptions, database: Kysely<never>, callbacks: LibraryCallbacks = CLOSED, transaction = true) {
  const base = new URL(options.baseURL);
  if (base.protocol !== "https:" && base.hostname !== "localhost") throw new Error("Provider base URL must use HTTPS.");
  if (options.secret.length < 32) throw new Error("Provider secret is too short.");
  return {
    appName: "Worktree Control",
    baseURL: base.origin,
    basePath: base.pathname.replace(/\/+$/, "") || "/api/auth",
    secret: options.secret,
    database: { db: database, type: "sqlite", transaction },
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
        await callbacks.beforeNative(context.path);
      }),
    },
    databaseHooks: {
      account: {
        update: {
          before: async () => { await options.faultInjection?.beforePasswordWrite?.(); },
        },
      },
      session: {
        create: {
          before: async (session: { userId: string; createdAt: Date; expiresAt: Date }) => (callbacks.sessionCreating(session) === false ? false : undefined),
        },
        delete: {
          before: async () => { await options.faultInjection?.beforeSessionDelete?.(); },
          // Better Auth queues `after` hooks until the surrounding transaction commits.
          after: async (session: SessionEvent) => { await callbacks.sessionDeleted(session); await options.faultInjection?.afterSessionDelete?.(); },
        },
      },
    },
    plugins: [
      twoFactor({ issuer: TOTP_ISSUER, twoFactorTable: MODELS.twoFactor, skipVerificationOnEnable: false, allowPasswordless: false, totpOptions: TOTP_SETTINGS }),
      passkey({
        rpID: options.factors?.rpId ?? base.hostname,
        rpName: options.factors?.rpName ?? "Worktree Control",
        origin: base.origin,
        advanced: { webAuthnChallengeCookie: "passkey_challenge" },
        schema: { passkey: { modelName: MODELS.passkey } },
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        registration: { requireSession: true, afterVerification: async ({ verification, user }) => { callbacks.registered({ verified: verification.verified, subject: user.id }); } },
        authentication: { afterVerification: async ({ verification, clientData }) => {
          callbacks.authenticated({ verified: verification.verified, userVerified: verification.verified && verification.authenticationInfo.userVerified === true,
            credential: clientData.id, userHandle: clientData.response.userHandle });
        } },
      }),
    ],
  } satisfies BetterAuthOptions;
}
