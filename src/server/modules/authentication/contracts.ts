/** Installation-wide authentication policy selected by the local administrator. */
export type AuthenticationMode = "legacy" | "open" | "token" | "better-auth";

/** Server-only verifier of the installation token. Never return this shape from a transport. */
export interface InstallationTokenRecord {
  id: string;
  prefix: string;
  verifierHash: string;
  createdAt: string;
}

export interface AuthenticationPolicy {
  mode: AuthenticationMode;
  token: InstallationTokenRecord | null;
  /** Increments on every token rotation so derived sessions can detect invalidation. */
  generation: number;
}

export interface AuthenticationStatus {
  mode: AuthenticationMode;
  token: Pick<InstallationTokenRecord, "id" | "prefix" | "createdAt"> | null;
  generation: number;
}

export interface AuthenticationStore {
  getAuthenticationPolicy(): AuthenticationPolicy;
  saveAuthenticationPolicy(policy: AuthenticationPolicy, event: string, actor: string): void;
}

/** Fixed principal ID of the installation authority, created by migration 25. */
export const INSTALLATION_PRINCIPAL_ID = "installation";
