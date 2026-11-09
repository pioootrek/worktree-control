import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { validateAuthenticationPolicy } from "./policy-validation";
import { INSTALLATION_PRINCIPAL_ID } from "./contracts";
import type {
  AuthenticationMode,
  AuthenticationPolicy,
  AuthenticationStatus,
  AuthenticationStore,
  InstallationTokenRecord,
} from "./contracts";
import type { AuthenticatedPrincipal, CredentialAuthenticatedPrincipal, InstallationAuthority } from "@/server/modules/identity";

export type AuthenticationErrorCode =
  | "auth_provider_unavailable"
  | "auth_mode_unavailable"
  | "installation_token_exists"
  | "installation_token_missing"
  | "invalid_request";

export class AuthenticationError extends Error {
  constructor(readonly code: AuthenticationErrorCode, message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export interface IssuedInstallationToken {
  status: AuthenticationStatus;
  token: string;
}

const TOKEN_PREFIX = "wsi";
const OPEN_CREDENTIAL_ID = "open";
const MODES = new Set<AuthenticationMode>(["legacy", "open", "token", "better-auth"]);
/** Modes whose enforcement exists in every transport. Selecting any other mode is refused. */
const ENFORCED_MODES: ReadonlySet<AuthenticationMode> = new Set(["legacy", "token", "open", "better-auth"]);

/** Bound once by the controller-owned provider lifetime, never by a transport request. */
export interface AccountModeAuthority {
  prepare(): Promise<void>;
  assertReady(): void;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export class AuthenticationService implements InstallationAuthority {
  private readonly bootMode: AuthenticationMode;
  private accountMode?: AccountModeAuthority;
  constructor(
    private readonly store: AuthenticationStore,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly id: () => string = randomUUID,
    private readonly secret: () => string = () => randomBytes(32).toString("hex"),
    private readonly enforcedModes: ReadonlySet<AuthenticationMode> = ENFORCED_MODES,
    private readonly context: "controller" | "offline" = "controller",
  ) {
    this.bootMode = this.readPolicy().mode;
  }

  status(): AuthenticationStatus {
    return this.publicStatus(this.readPolicy());
  }

  mode(): AuthenticationMode {
    return this.context === "controller" ? this.bootMode : this.readPolicy().mode;
  }

  bindAccountMode(authority: AccountModeAuthority): void {
    if (this.accountMode) throw new Error("Authentication provider lifetime is already bound.");
    this.accountMode = authority;
  }

  async prepareAccountMode(): Promise<void> {
    if (!this.accountMode) throw new AuthenticationError("auth_provider_unavailable", "Account authentication is unavailable.");
    await this.accountMode.prepare();
  }

  permitsCredential(actor: AuthenticatedPrincipal): boolean {
    this.readPolicy();
    return this.context === "offline" || this.mode() !== "better-auth"
      || (actor.principalKind === "agent" && actor.authenticationMethod === "agent_token")
      || (actor.principalKind === "worker" && actor.authenticationMethod === "worker_token");
  }

  /** Returns the installation actor only while token mode is active and the token is current. */
  authenticateInstallation(token: string): CredentialAuthenticatedPrincipal | null {
    const policy = this.readPolicy();
    if (this.mode() !== "token" || !policy.token || !this.verifyInstallationToken(token)) return null;
    return {
      principalId: INSTALLATION_PRINCIPAL_ID,
      principalKind: "installation",
      credentialId: policy.token.id,
      authenticationMethod: "installation_token",
    };
  }

  /** Open mode: every caller acts as the anonymous installation authority, recorded as `none`. */
  anonymousInstallation(): CredentialAuthenticatedPrincipal | null {
    this.readPolicy(); // Recheck external security fence even in immutable open boot mode.
    if (this.mode() !== "open") return null;
    return {
      principalId: INSTALLATION_PRINCIPAL_ID,
      principalKind: "installation",
      credentialId: OPEN_CREDENTIAL_ID,
      authenticationMethod: "none",
    };
  }

  isCurrentInstallationActor(actor: AuthenticatedPrincipal): boolean {
    const policy = this.readPolicy();
    if (actor.principalId !== INSTALLATION_PRINCIPAL_ID || actor.principalKind !== "installation") return false;
    if (actor.authenticationMethod === "none") return this.mode() === "open" && actor.credentialId === OPEN_CREDENTIAL_ID;
    return actor.authenticationMethod === "installation_token"
      && this.mode() === "token"
      && policy.token?.id === actor.credentialId;
  }

  generateToken(actor: string): IssuedInstallationToken {
    const policy = this.readPolicy();
    if (policy.token) {
      throw new AuthenticationError("installation_token_exists", "Token instalacji już istnieje. Użyj auth token rotate, aby go wymienić.");
    }
    return this.issue(policy, "authentication.token_generated", actor);
  }

  rotateToken(actor: string): IssuedInstallationToken {
    const policy = this.readPolicy();
    if (!policy.token) {
      throw new AuthenticationError("installation_token_missing", "Brak tokena instalacji. Użyj auth token generate.");
    }
    return this.issue(policy, "authentication.token_rotated", actor);
  }

  /** Selects next-start mode only. A running controller keeps its immutable boot mode. */
  setMode(value: string, actor: string): AuthenticationStatus {
    const mode = value as AuthenticationMode;
    if (!MODES.has(mode) || mode === "legacy") {
      throw new AuthenticationError("invalid_request", "Dostępne tryby: open, token, better-auth.");
    }
    const policy = this.readPolicy();
    this.requireSelectable(mode, policy);
    if (policy.mode === mode) return this.publicStatus(policy);
    const next = { ...policy, mode };
    this.store.saveAuthenticationPolicy(next, "authentication.mode_selected", actor);
    return this.publicStatus(next);
  }

  /** Fails closed before a controller exposes operations under a policy it cannot enforce. */
  assertStartupPolicy(): AuthenticationStatus {
    const policy = this.readPolicy();
    this.requireSelectable(this.mode(), policy);
    return this.publicStatus(policy);
  }

  verifyInstallationToken(token: string): boolean {
    const record = this.readPolicy().token;
    const match = /^wsi_([0-9a-f-]{36})_[0-9a-f]{64}$/.exec(token);
    const expected = record && /^[0-9a-f]{64}$/.test(record.verifierHash)
      ? Buffer.from(record.verifierHash, "hex")
      : Buffer.alloc(32);
    const matches = timingSafeEqual(expected, hashToken(token));
    return Boolean(record && match && match[1] === record.id && matches);
  }

  private readPolicy(): AuthenticationPolicy {
    return validateAuthenticationPolicy(this.store.getAuthenticationPolicy());
  }

  private publicStatus(policy: AuthenticationPolicy): AuthenticationStatus {
    const activeMode = this.context === "controller" ? this.bootMode : null;
    return {
      mode: activeMode ?? policy.mode,
      activeMode,
      configuredMode: policy.mode,
      restartRequired: activeMode !== null && activeMode !== policy.mode,
      token: policy.token ? { id: policy.token.id, prefix: policy.token.prefix, createdAt: policy.token.createdAt } : null,
      generation: policy.generation,
    };
  }

  private requireSelectable(mode: AuthenticationMode, policy: AuthenticationPolicy): void {
    if (mode === "better-auth") {
      if (!this.accountMode) throw new AuthenticationError("auth_provider_unavailable", "Account authentication is unavailable.");
      this.accountMode.assertReady();
    }
    if (!this.enforcedModes.has(mode)) {
      throw new AuthenticationError("auth_mode_unavailable", `Tryb ${mode} nie jest jeszcze egzekwowany przez ten kontroler.`);
    }
    if (mode === "token" && !policy.token) {
      throw new AuthenticationError("installation_token_missing", "Tryb token wymaga tokena instalacji. Użyj auth token generate.");
    }
  }

  private issue(policy: AuthenticationPolicy, event: string, actor: string): IssuedInstallationToken {
    const id = this.id();
    const secret = this.secret();
    if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("Generator tokenu nie zwrócił 256-bitowego sekretu.");
    const token = `${TOKEN_PREFIX}_${id}_${secret}`;
    const record: InstallationTokenRecord = {
      id,
      prefix: `${TOKEN_PREFIX}_${id}`,
      verifierHash: hashToken(token).toString("hex"),
      createdAt: this.clock(),
    };
    const next = { ...policy, token: record, generation: policy.generation + 1 };
    validateAuthenticationPolicy(next);
    this.store.saveAuthenticationPolicy(next, event, actor);
    return { status: this.publicStatus(next), token };
  }
}
