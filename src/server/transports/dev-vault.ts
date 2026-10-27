import { DEV_VAULT_DISCLAIMER } from "@/shared/contracts/dev-vault";
import { DevVaultError, type DevVaultService } from "@/server/modules/dev-vault";
import type { AuthenticatedPrincipal } from "@/server/modules/identity";

export function devVaultFailure(error: unknown) {
  const code = error instanceof DevVaultError ? error.code : "vault_unavailable";
  const status = code === "vault_denied" ? 403 : code === "vault_conflict" ? 409
    : code === "vault_invalid_request" ? 400 : code === "vault_limit" ? 429 : 503;
  return { status, body: { code, disclaimer: DEV_VAULT_DISCLAIMER } };
}
export function executeDevVault(service: DevVaultService | undefined, input: unknown, actor: AuthenticatedPrincipal | null) {
  if (!service) throw new DevVaultError("vault_unavailable");
  if (!actor) throw new DevVaultError("vault_denied");
  return service.execute(input, actor);
}
