import type { DevOwnerProof, DevVaultCommand } from "@/shared/contracts/dev-vault";
import { z } from "zod";
import { clockSkew, VaultClientError, vaultErrorCode } from "./vault-model";

type Fetch = typeof fetch;

/**
 * The owner session goes only as a bearer to its own endpoints. The installation token is never sent
 * here: it is not vault owner authority.
 */
export async function postDevVault(ownerToken: string, command: DevVaultCommand, proof: DevOwnerProof, send: Fetch = fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await send("/api/dev-vault", {
      method: "POST", cache: "no-store", credentials: "omit", redirect: "error",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ command, proof }),
    });
  } catch { throw new VaultClientError("transport"); }
  let body: unknown;
  try { body = await response.json(); } catch { throw new VaultClientError(response.ok ? "invalid_response" : "vault_unavailable"); }
  if (!response.ok) throw new VaultClientError(vaultErrorCode((body as { code?: unknown } | null)?.code));
  const result = (body as { result?: unknown } | null)?.result;
  if (result === undefined) throw new VaultClientError("invalid_response");
  return result;
}

const identitySchema = z.object({
  principal: z.object({ id: z.string().min(1), kind: z.string() }),
  credential: z.object({ id: z.string().min(1), kind: z.string(), label: z.string().max(200), expiresAt: z.string().nullable() }).nullable(),
});
export interface OwnerIdentity { principalId: string; credentialId: string; label: string; expiresAt: string | null; skewMs: number }

/** Confirms that the pasted credential is a current owner session, not installation or agent access. */
export async function readOwnerIdentity(ownerToken: string, send: Fetch = fetch, clock: () => number = Date.now): Promise<OwnerIdentity> {
  const sentAt = clock();
  let response: Response;
  try {
    response = await send("/api/identity", { cache: "no-store", credentials: "omit", redirect: "error", headers: { Authorization: `Bearer ${ownerToken}` } });
  } catch { throw new VaultClientError("transport"); }
  if (response.status === 401 || response.status === 403) throw new VaultClientError("session_invalid");
  if (!response.ok) throw new VaultClientError("vault_unavailable");
  const parsed = identitySchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new VaultClientError("invalid_response");
  const { principal, credential } = parsed.data;
  if (principal.kind !== "owner" || credential?.kind !== "owner_session") throw new VaultClientError("not_owner_session");
  return { principalId: principal.id, credentialId: credential.id, label: credential.label, expiresAt: credential.expiresAt,
    skewMs: clockSkew(response.headers.get("Date"), sentAt, clock()) };
}

const agentCredentialsSchema = z.object({ credentials: z.array(z.object({
  id: z.string(), label: z.string().max(200), status: z.enum(["active", "revoked"]), expiresAt: z.string().nullable(),
})).max(512) });
export type AgentCredentialSummary = z.infer<typeof agentCredentialsSchema>["credentials"][number];

/** Read-only identity context for a requesting agent; failure only hides the owner-assigned label. */
export async function listAgentCredentials(ownerToken: string, principalId: string, send: Fetch = fetch): Promise<AgentCredentialSummary[] | null> {
  try {
    const response = await send("/api/identity/admin", {
      method: "POST", cache: "no-store", credentials: "omit", redirect: "error",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list-agent-tokens", principalId }),
    });
    if (!response.ok) return null;
    const parsed = agentCredentialsSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.credentials : null;
  } catch { return null; }
}
