import { DEV_VAULT_DISCLAIMER } from "@/shared/contracts/dev-vault";
import { DevVaultError, type DevVaultOperations } from "@/server/modules/dev-vault";
import type { AuthenticatedPrincipal } from "@/server/modules/identity";

export function devVaultFailure(error: unknown) {
  const code = error instanceof DevVaultError ? error.code : "vault_unavailable";
  const status = code === "vault_denied" ? 403 : (code === "vault_conflict" || code === "vault_proof_expired") ? 409
    : code === "vault_invalid_request" ? 400 : code === "vault_limit" ? 429 : 503;
  return { status, body: { code, disclaimer: DEV_VAULT_DISCLAIMER } };
}
export function executeDevVault(service: DevVaultOperations | undefined, input: unknown, actor: AuthenticatedPrincipal | null) {
  if (!service) throw new DevVaultError("vault_unavailable");
  if (!actor) throw new DevVaultError("vault_denied");
  return service.execute(input, actor);
}
