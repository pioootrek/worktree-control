/**
 * Unified authorization contract (Knowledge task 040062b4, contract v1).
 * Unmounted: no production route, tool or command imports this module yet.
 * See docs/authorization-contract.md.
 */
export {
  acceptanceTable, credentialClasses, credentialClassOf, pathActorKind, resolveAcceptance, unregisteredRouteClasses,
  type AcceptanceRejection, type AcceptanceResult, type AcceptanceRow, type AcceptedPath, type BearerClass, type CredentialClass,
  type PresentedCredentials,
} from "./acceptance";
export {
  createListenerBoundary, isFullAuthority, mintOfflineContext,
  type Actor, type AuthenticationContext, type CoordinationSessionRef, type CredentialIdentity, type CredentialVerifier,
  type CurrentAuthority, type ListenerBoundary, type ProviderEvidence, type VerifiedCredential,
} from "./authentication-context";
export { decide, freshLoginState, projectVisible, type Decision, type DecisionInput, type Denial } from "./decide";
export { isOperationError, OperationError, publicError } from "./errors";
export { effectivePermissions, grantAllowed, type EffectivePermissions, type GrantScope, type GrantsSnapshot, type StoredGrant } from "./grants";
export {
  OperationRegistry,
  type AnyOperation, type EffectOutcome, type FinalizeScope, type Lease, type MutationOperation, type Operation,
  type OperationEffect, type PhaseScope, type ReadOperation, type StreamOperation,
} from "./operation";
export { createReleaseContext, MAX_PAGE_SIZE, pick, type Page, type ReleaseContext } from "./release";
export {
  allOf, authenticated, claimHolder, collection, installation, onProject, requiredSlots, resourceKinds, runOriginatingSession, workerAssignment,
  type OperationRequirement, type PredicateName, type Requirement, type ResolvedResource, type ResolvedResources, type ResourceKind,
  type ResourceRef, type ResourceRelation,
} from "./requirements";
export { resolveAll, sameResolution, type ResourceResolver } from "./resolver";
export { OperationRunner, type OperationRuntime, type RetainedResults, type RetentionKey, type RunOptions, type RunResult, type StreamItem } from "./runner";
export { MAX_DESCRIBED_PROJECTS, sessionDescribe } from "./session-describe";
