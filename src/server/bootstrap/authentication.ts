export { createControllerAuthentication, CONTROLLER_AUTHENTICATION_POLICY, type ControllerAuthenticationOptions } from "./authentication-provider-lifetime";
import type { DatabaseAdmission } from "@/server/database-admission";
import { AuthenticationProviderError, ProviderKnowledgeApplication, ProviderRuntimeReadApplication, type ProviderRuntimeReadPort, type AuthenticationProviderRuntime, type AuthenticationService } from "@/server/modules/authentication";
import { IdentityService, type IdentityStore, type RuntimeAccessStore, type RuntimeMembershipStore } from "@/server/modules/identity";
import { KnowledgeService, type KnowledgeStore } from "@/server/modules/knowledge";
import { AuthenticationHttp, type AuthenticationTransportLimits } from "@/server/transports/authentication-http";

/**
 * Explicit composition for the isolated optional-provider proof. Production main
 * has no caller or flag for this seam. It accepts the existing boot snapshot;
 * pending mode selection must never cause AuthenticationService reconstruction.
 * The caller owns loading, listeners and shutdown, and must pass the returned
 * provider resource to createControllerShutdown before closing its store.
 */
export function composeIsolatedBrowserAuthentication(input: {
  store: IdentityStore & KnowledgeStore & RuntimeAccessStore & { runtimeMemberships?(): RuntimeMembershipStore };
  runtimeReads?: ProviderRuntimeReadPort;
  admission: DatabaseAdmission;
  authentication: AuthenticationService;
  runtime: AuthenticationProviderRuntime;
  origin: string;
  maintenance?(): boolean;
  trustedFixturePeer?: string;
  maxInFlight?: number;
  /** Explicit inputs for this isolated composition. None is an approved product default. */
  limits: AuthenticationTransportLimits;
}) {
  // Browser login needs the loader's explicit unreleased-session bound.
  if (input.runtime.disposed || !input.runtime.issuanceBounded) throw new AuthenticationProviderError("provider_unavailable", "Authentication provider is unavailable.");
  const identity = new IdentityService(input.store, undefined, undefined, undefined, input.authentication, input.store, input.runtime, input.store.runtimeMemberships?.());
  const knowledge = new KnowledgeService(input.store, identity);
  const providerKnowledge = new ProviderKnowledgeApplication(input.admission, identity, knowledge);
  const browserAuthentication = new AuthenticationHttp({ ...input, knowledge: providerKnowledge,
    runtimeReads: input.runtimeReads && new ProviderRuntimeReadApplication(input.admission, identity, input.runtimeReads),
    status: () => ({ mode: input.authentication.mode(), loginAvailable: !input.runtime.disposed }) });
  return { identity, providerKnowledge, browserAuthentication, authenticationProvider: input.runtime };
}
