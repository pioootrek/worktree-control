/**
 * Server-only contract between the controller and an optional, separately
 * installed authentication provider package. MIT, like the rest of the core.
 *
 * A provider is trusted in-process code: this boundary versions and narrows the
 * integration, it is not a sandbox. The controller keeps ownership of SQLite,
 * migrations, backups and principals; the provider reaches the database only
 * through the borrowed connection in its host, inside a controller borrow.
 */
export const AUTHENTICATION_PROVIDER_CONTRACT_VERSION = 2;

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

export interface AuthenticationProviderHost {
  readonly providerId: string;
  readonly storageRevision: number;
  readonly connection: ProviderSqliteConnection;
  readonly subjects: ProviderSubjectRegistry;
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
}

/** Nonsecret evidence of a provider session. Carries no roles, permissions or authority. */
export interface VerifiedProviderSession {
  providerId: string;
  sessionId: string;
  subject: string;
  createdAt: string;
  expiresAt: string;
  /** Only what the provider verified. Password-only sign-in is a single factor, not MFA. */
  authentication: { method: "password"; factors: 1 };
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
