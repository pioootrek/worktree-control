import type { DevVaultCommand } from "./dev-vault";

/** Domain separation for owner proofs. Changing it invalidates every external signer. */
export const DEV_VAULT_OWNER_SIGNING_CONTEXT = "worktree-control-dev-vault-owner-v1";

/**
 * Canonical JSON shared by the controller, CLI and browser signer: object keys sorted by code unit,
 * undefined members omitted, arrays in order. Signatures cover the UTF-8 bytes of this text.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Exact text an external owner key signs; encode it as UTF-8 before signing or verifying. */
export function devOwnerSigningText(command: DevVaultCommand, actor: { principalId: string; credentialId: string }, issuedAt: string): string {
  return canonicalJson({ context: DEV_VAULT_OWNER_SIGNING_CONTEXT, principalId: actor.principalId,
    credentialId: actor.credentialId, issuedAt, command });
}
