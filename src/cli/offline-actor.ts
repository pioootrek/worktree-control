import { AuthenticationService, resolveControllerAuthentication } from "../server/modules/authentication";
import { IdentityError, IdentityService, type AuthenticatedPrincipal } from "../server/modules/identity";
import type { SqliteStateStore } from "../server/sqlite-store";

/**
 * Authenticates an offline CLI caller under the persisted mode: anonymous installation authority in
 * open mode, otherwise a scoped credential or, in token mode, the installation token. A caller
 * without a credential in a protected mode receives `missingCredential` instead of a generic error.
 */
export function authenticateOfflineActor(store: SqliteStateStore, token: string | undefined, missingCredential?: string): { identity: IdentityService; actor: AuthenticatedPrincipal } {
  const authentication = new AuthenticationService(store);
  const identity = new IdentityService(store, undefined, undefined, undefined, authentication);
  const result = resolveControllerAuthentication({ authentication, identity }, { bearer: token ?? null, legacySecretValid: () => false });
  if (!result || result.kind === "legacy") {
    if (!token && missingCredential) throw new Error(missingCredential);
    throw new IdentityError("invalid_credential", "Nieprawidłowe lub nieaktywne poświadczenie.");
  }
  return { identity, actor: result.actor };
}
