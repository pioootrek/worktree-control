import { AuthenticationService } from "../modules/authentication";
import { identityAdministration, IdentityError, IdentityService } from "../modules/identity";
import type { SqliteStateStore } from "../sqlite-store";

/** Protected OS-owner IPC only. No listener/connection, provider actor or public transport. */
export function createProtectedIdentityAdministration(store: SqliteStateStore, maintenance: () => boolean) {
  // Same singleton connection and shared application policy. Local credentials remain
  // restricted to an actual current owner session, even in account mode.
  const authentication = new AuthenticationService(store, undefined, undefined, undefined, undefined, "offline");
  const identity = new IdentityService(store, undefined, undefined, undefined, authentication, store);
  return (body: unknown) => store.admission.run(() => {
    if (maintenance()) throw new IdentityError("invalid_credential", "Protected identity administration is unavailable.");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new IdentityError("invalid_request", "Invalid identity command.");
    const record = body as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "command,input,token" || record.command !== "identity-admin"
      || typeof record.token !== "string" || record.token.length > 256) throw new IdentityError("invalid_request", "Invalid identity command.");
    const actor = identity.authenticateBearer(record.token);
    if (actor.principalKind !== "owner" || actor.authenticationMethod !== "owner_session") throw new IdentityError("owner_authentication_required", "Protected identity administration requires a current owner credential.");
    return identityAdministration(identity, actor, record.input);
  });
}
