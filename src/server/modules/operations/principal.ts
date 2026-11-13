import type { ProjectId } from "@/shared/contracts/operations";
import type { Actor, CurrentAuthority } from "./authentication-context";
import { decideWith, type Decision } from "./decide";
import { effectivePermissions, type GrantsSnapshot } from "./grants";
import { frozenOperationRequirement, type OperationRequirement, type ResolvedResources, type StoredPrincipal } from "./requirements";
import { copyPrincipal } from "./resolver";
import { synchronous } from "./synchronous";

export interface PrincipalDecisionInput {
  /** The stored principal to evaluate, for example the submitter of a remote request. */
  principal: StoredPrincipal;
  requirement: OperationRequirement;
  /** Resources resolved in the same admitted phase. */
  resources: ResolvedResources;
  /** The grants snapshot of the same admitted phase. */
  grants: GrantsSnapshot;
  now: number;
  /** Every current project, when the requirement has an `any_project` part. */
  projects?: readonly ProjectId[];
  /** Mode and listener of the phase; a stored principal has no listener of its own. */
  mode: CurrentAuthority["mode"];
  listener: CurrentAuthority["listener"];
}

/**
 * Application authorization interface (`29cf8fa5` delta 6): decides a
 * requirement for a principal stored with a resource, on its CURRENT grants,
 * without replacing or changing the caller's context. Used, for example, for
 * the submitter of a remote request when a worker is assigned work.
 *
 * The stored principal has no credential, coordination session or provider
 * evidence, so it never passes a session predicate, `intent_origin` or a
 * fresh-login requirement. An account is evaluated as the kind the grants
 * store records for it now; an unknown or disabled account holds nothing.
 * `installation` and `operator` hold full authority. Returns the decision;
 * never throws for a denial. A malformed principal or requirement is
 * `forbidden`/`invalid_principal`.
 */
export function decideForPrincipal(input: PrincipalDecisionInput): Decision {
  const principal = copyPrincipal(input.principal);
  let requirement: OperationRequirement | null = null;
  try { requirement = frozenOperationRequirement(input.requirement); } catch { requirement = null; }
  if (!principal || !requirement) return Object.freeze({ allowed: false as const, category: "forbidden" as const, reason: "invalid_principal" });
  let actor: Actor;
  if (principal.kind === "installation") actor = Object.freeze({ kind: "installation" as const });
  else if (principal.kind === "operator") actor = Object.freeze({ kind: "operator" as const, via: "unix" as const });
  else {
    const stored = synchronous(input.grants.accountKind(principal.accountId), "grants_not_synchronous");
    // An unknown or disabled account is evaluated with no grants at all: `effectivePermissions` yields nothing for it.
    actor = stored === "agent"
      ? Object.freeze({ kind: "agent" as const, accountId: principal.accountId })
      : Object.freeze({ kind: "human" as const, accountId: principal.accountId });
  }
  const authority: CurrentAuthority = Object.freeze({ actor, mode: input.mode, listener: input.listener, evidence: null, coordinationSession: null });
  return decideWith({
    authority, requirement, resources: input.resources, now: input.now, projects: input.projects, credential: null,
    permissions: effectivePermissions(actor, input.grants),
  });
}
