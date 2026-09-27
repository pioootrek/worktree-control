import { AuthenticationService, resolveControllerAuthentication } from "../server/modules/authentication";
import { IdentityError, IdentityService, type AuthenticatedPrincipal } from "../server/modules/identity";
import type { SqliteStateStore } from "../server/sqlite-store";

/** Authenticates an offline CLI caller with a scoped credential or, in token mode, the installation token. */
export function authenticateOfflineActor(store: SqliteStateStore, token: string): { identity: IdentityService; actor: AuthenticatedPrincipal } {
  const authentication = new AuthenticationService(store);
  const identity = new IdentityService(store, undefined, undefined, undefined, authentication);
  const result = resolveControllerAuthentication({ authentication, identity }, { bearer: token, legacySecretValid: () => false });
  if (!result || result.kind === "legacy") throw new IdentityError("invalid_credential", "Nieprawidłowe lub nieaktywne poświadczenie.");
  return { identity, actor: result.actor };
}
