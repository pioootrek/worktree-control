/**
 * Server-only contract between the controller and an optional, separately
 * installed authentication provider package. MIT, like the rest of the core.
 *
 * A provider is trusted in-process code: this boundary versions and narrows the
 * integration, it is not a sandbox. The controller keeps ownership of SQLite,
 * migrations, backups and principals; the provider reaches the database only
 * through the borrowed connection in its host, inside a controller borrow.
 */
import type { BrowserWebAuthnBounds } from "@/shared/contracts/authentication";

export const AUTHENTICATION_PROVIDER_CONTRACT_VERSION = 3;

/** Kysely-compatible statement; valid only during the borrow that prepared it. */
export interface ProviderSqliteStatement {
  readonly reader: boolean;
  all(parameters: ReadonlyArray<unknown>): unknown[];
  run(parameters: ReadonlyArray<unknown>): { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown>;
}

/** Kysely-compatible connection. `close` invalidates this facade; SQLite stays open. */
export interface ProviderSqliteConnection {
  prepare(sql: string): ProviderSqliteStatement;
  close(): void;
}

export interface ProviderSubjectMapping {
  providerId: string;
  /** The provider's opaque, stable account ID. Never an email or display name. */
  subject: string;
  principalId: string;
  status: "active" | "revoked";
  linkedAt: string;
  revokedAt: string | null;
}

export type ProviderAuditEvent =
  | "authentication.provider.account_provisioned"
  | "authentication.provider.password_recovered"
  | "authentication.provider.subject_revoked";

/**
 * Controller-owned mapping and audit. Synchronous: inside an open provider
 * transaction each call joins it, so the mapping commits or rolls back with
 * the provider's own writes.
 */
export interface ProviderSubjectRegistry {
  /** Fails with `principal_unavailable` or `subject_conflict`; never matches by email or name. */
  link(input: { subject: string; principalId: string; actor: string }): ProviderSubjectMapping;
  find(subject: string): ProviderSubjectMapping | null;
  findByPrincipal(principalId: string): ProviderSubjectMapping | null;
  /** Records an event with IDs only: never passwords, cookies, tokens or email addresses. */
  record(event: ProviderAuditEvent, input: { subject: string; principalId: string; actor: string }): void;
}

/** Emitted only after the change committed. */
export type ProviderInvalidation =
  | { kind: "session"; providerId: string; sessionId: string; subject: string }
  | { kind: "subject"; providerId: string; subject: string };

/**
 * What the provider verified for a session. A strength label only: it carries no
 * roles or permissions, and it never raises what the principal may do.
 */
export type ProviderAuthenticationEvidence =
  | { method: "password"; factors: 1 }
  | { method: "password_totp"; factors: 2 }
  | { method: "passkey_uv"; factors: 2 };
export type ProviderAuthenticationMethod = ProviderAuthenticationEvidence["method"];

/** Immutable record of one session's original authentication. Refresh never rewrites it. */
export interface ProviderSessionEvidence {
  sessionId: string;
  subject: string;
  method: ProviderAuthenticationMethod;
  authenticatedAt: string;
  originalDeadline: string;
  generation: number;
  policyRevision: number;
  /** Row the method verified: a two-factor row ID or a WebAuthn credential ID. */
  credential: string | null;
  /** Digest of that credential as verified. Compared, never decoded. */
  credentialBinding: string | null;
  attemptId: string;
}

export type ProviderFactorPurpose = "totp_enrollment" | "totp_login" | "passkey_registration" | "passkey_confirmation" | "passkey_authentication";

/**
 * Integration limits supplied by the deployment. There are deliberately no
 * defaults: without them factor routes stay closed and selected protection
 * refuses. These bound the controller's own wrapper; the library's native
 * rate limits and failed-verification counters remain separate.
 */
export interface ProviderFactorLimits {
  totp: { attempts: number; windowMs: number };
  passkey: { attempts: number; windowMs: number };
  /** Lifetime of a committed charge before native evaluation must have started. */
  ticketMs: number;
  /** Enrollment window, measured from the session's original authentication. */
  stagingMs: number;
  /** Maximum rows per bounded admission table. Evidence follows sessions instead. */
  capacity: number;
  pruneBatch: number;
  /** Generated options before any account is known. All values are explicit inputs. */
  issuance: {
    perPeer: { attempts: number; windowMs: number };
    global: { attempts: number; windowMs: number };
    /** Peers tracked at once. A new peer is refused once every tracked window is live. */
    peers: number;
    /** Maximum native verification rows, whichever ceremony wrote them. */
    nativeChallenges: number;
    /** Context and native rows anonymous options may never use, kept for accepted ceremonies. */
    reservedContexts: number;
  };
  webauthn: BrowserWebAuthnBounds;
}

export interface ProviderFactorOptions { rpId: string; rpName: string; limits: ProviderFactorLimits }

/** A committed admission. Opaque to the provider except for fields it must compare. */
export interface ProviderFactorTicket {
  attemptId: string;
  capability: string;
  purpose: ProviderFactorPurpose;
  subject: string;
  credential: string | null;
  binding: string | null;
  generation: number;
  policyRevision: number;
  sessionId: string | null;
  handle: string | null;
}

export type ProviderFactorOutcome = "charged" | "succeeded" | "failed";

/**
 * Controller-owned selected-protection policy shared by every method. All calls
 * are synchronous and join the provider's open transaction, so a charge commits
 * before native evaluation and a settlement commits with native success.
 * Evaluation of current authority stays in the controller.
 */
export interface ProviderAccountProtection {
  /** False without validated limits. Factor operations then refuse. */
  readonly enabled: boolean;
  /** Current evidence that still authorizes, or null. Reads committed state only. */
  currentEvidence(sessionId: string, now: number): ProviderSessionEvidence | null;
  /** False once any method is selected, or when the account's state is inconsistent. */
  recordPasswordSession(input: { sessionId: string; subject: string; attemptId: string; now: number }): boolean;
  /** A native session replacement keeps the original authentication and deadline. */
  inheritSession(evidence: ProviderSessionEvidence, input: { sessionId: string; attemptId: string }): void;

  issueTotpEnrollment(input: { opaque: string; sessionId: string; subject: string; now: number }): boolean;
  issueTotpLogin(input: { opaque: string; subject: string; nativeId: string; nativeDeadline: number; authenticatedAt: string; originalDeadline: string; now: number }): boolean;
  issuePasskeyRegistration(input: { opaque: string; sessionId: string; subject: string; handle: string; nativeId: string; nativeDeadline: number; now: number }): boolean;
  /** Returns the credential the browser must confirm, or null. */
  issuePasskeyConfirmation(input: { opaque: string; source: string; sessionId: string; subject: string; nativeId: string; nativeDeadline: number; now: number }): string | null;
  issuePasskeyAuthentication(input: { opaque: string; nativeId: string; nativeDeadline: number; now: number }): boolean;

  contextSubject(opaque: string, purpose: ProviderFactorPurpose, now: number): { subject: string | null; sessionId: string | null } | null;
  /**
   * Run in its own short transaction, committed before any native evaluation. No refund exists.
   * Null refuses without naming why. Throws an error named `ProviderAdmissionRefusedError`
   * with `reason` "budget" or "capacity" only for genuine exhaustion of an otherwise valid attempt.
   */
  admit(input: { opaque: string; purpose: ProviderFactorPurpose; attemptId: string; credential: string | null; now: number }): ProviderFactorTicket | null;
  usable(ticket: ProviderFactorTicket, now: number): boolean;
  /** A native WebAuthn result may proceed: trusted or bound staged credential, exact user handle. */
  passkeyAcceptable(ticket: ProviderFactorTicket, credential: string, userHandle: string | null | undefined, now: number): boolean;

  /**
   * Throws an error named `ProviderStaleStepError` when `step` is not newer than the subject's last one.
   * Any settlement throws `ProviderSettlementRefusedError` when current state no longer allows it.
   */
  settleTotpEnrollment(ticket: ProviderFactorTicket, step: number, now: number): void;
  /** Same guarded step rule as enrollment, in the transaction that records login evidence. */
  settleTotpLogin(ticket: ProviderFactorTicket, sessionId: string, step: number, now: number): void;
  stagePasskey(ticket: ProviderFactorTicket, credential: string, now: number): void;
  promotePasskey(ticket: ProviderFactorTicket, now: number): void;
  settlePasskeyLogin(ticket: ProviderFactorTicket, sessionId: string, now: number): void;
  fail(attemptId: string): void;
  /** Reconciles an ambiguous commit. Never re-enters native code. */
  outcome(attemptId: string): ProviderFactorOutcome | null;
}

export interface AuthenticationProviderHost {
  readonly providerId: string;
  readonly storageRevision: number;
  readonly connection: ProviderSqliteConnection;
  readonly subjects: ProviderSubjectRegistry;
  readonly protection: ProviderAccountProtection;
  /** May throw; a failure here never means the committed change was rolled back. */
  invalidated(event: ProviderInvalidation): void;
  /** Runtime drops library text and emits a fixed event. */
  log(level: "error" | "warn" | "info" | "debug", message: string): void;
}

export interface AuthenticationProviderOptions {
  /** Canonical external origin plus base path, e.g. `https://controller.example/api/auth`. */
  baseURL: string;
  /** Cookie and token signing secret, at least 32 characters. */
  secret: string;
  /** Request header the controller sets from the socket address, never from the client. */
  clientIpHeader: string;
  /**
   * Delivers a single-use password reset token out of band. Without it the
   * provider refuses reset requests. The token must never be logged.
   */
  passwordResetDelivery?: (delivery: { subject: string; token: string }) => Promise<void>;
  /** Enables the bounded factor ceremonies. Absent means closed routes, not a default policy. */
  factors?: ProviderFactorOptions;
}

/** Nonsecret evidence of a provider session. Carries no roles, permissions or authority. */
export interface VerifiedProviderSession {
  providerId: string;
  sessionId: string;
  subject: string;
  createdAt: string;
  expiresAt: string;
  /** The provider's claim. Authority comes from committed evidence, which must agree with it. */
  authentication: ProviderAuthenticationEvidence;
}

export interface LocalProvisionInput { principalId: string; email: string; name: string; password: string; actor: string }
export interface LocalRecoveryInput { principalId: string; newPassword: string; actor: string }

export interface AuthenticationProviderReadiness {
  providerId: string;
  implementationVersion: string;
  library: { name: string; version: string };
  /** The library's own schema check passed against controller-owned storage. */
  schema: "verified";
}

export interface AuthenticationProviderInstance {
  /** Must await the library's actual schema verification before resolving. */
  initialize(): Promise<AuthenticationProviderReadiness>;
  handle(request: Request): Promise<Response>;
  /** Native sign-out plus explicit durable deletion verification; native success alone is insufficient. */
  signOut(request: Request): Promise<Response>;
  resolveSession(headers: Headers): Promise<VerifiedProviderSession | null>;
  provisionLocal(input: LocalProvisionInput): Promise<{ subject: string }>;
  recoverLocal(input: LocalRecoveryInput): Promise<void>;
  revokeSession(sessionId: string): Promise<void>;
  revokeSubjectSessions(subject: string): Promise<void>;
  /** Idempotent. Releases provider resources; never closes the controller database. */
  dispose(): Promise<void>;
}

/** Shape of the explicitly loaded module's `authenticationProvider` export. */
export interface AuthenticationProviderModule {
  contractVersion: typeof AUTHENTICATION_PROVIDER_CONTRACT_VERSION;
  providerId: string;
  implementationVersion: string;
  storageRevision: number;
  create(host: AuthenticationProviderHost, options: AuthenticationProviderOptions): AuthenticationProviderInstance | Promise<AuthenticationProviderInstance>;
}
