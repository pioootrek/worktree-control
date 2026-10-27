import type { AuthenticatedPrincipal } from "../identity";
import type { DevOwnerProof, DevVaultCommand } from "@/shared/contracts/dev-vault";

/** Only encrypted state crosses the persistence boundary. */
export interface DevVaultSnapshot { version: number; ciphertext: string }
export interface DevVaultStore {
  load(projectId: string): DevVaultSnapshot | null;
  /** Atomic compare-and-swap, including once consumption and its encrypted receipt. */
  commit(projectId: string, expectedVersion: number, ciphertext: string): boolean;
  projectExists(projectId: string): boolean;
}
export interface DevVaultKeyProvider { key(): Buffer }
export interface DevVaultOwnerVerifier {
  verify(command: DevVaultCommand, actor: AuthenticatedPrincipal, proof: DevOwnerProof | undefined, now: string): boolean;
}
export type DevVaultErrorCode = "vault_denied" | "vault_unavailable" | "vault_invalid_request" | "vault_conflict" | "vault_limit" | "vault_use_unavailable";
export class DevVaultError extends Error {
  constructor(readonly code: DevVaultErrorCode) { super(code); }
}
