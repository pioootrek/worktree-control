import type { AccountId, ProjectId } from "@/shared/contracts/operations";
import { modeAdmitsActor } from "./acceptance";
import type { Actor, CurrentAuthority } from "./authentication-context";
import { decideWith, type Decision } from "./decide";
import { effectivePermissions, noPermissions, type EffectivePermissions, type GrantsSnapshot } from "./grants";
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
 * An actor that holds nothing, for a stored full-authority principal in a
 * mode that does not admit its actor kind. It is decided with
 * `noPermissions`, so no resource is visible to it: any referenced resource
 * is masked before an ownership or relation predicate could compare its
 * account, and its empty account ID matches no stored principal or grant
 * (both require a non-empty ID).
 */
const HOLDS_NOTHING: Actor = Object.freeze({ kind: "human" as const, accountId: "" as AccountId });

const denied = (category: "forbidden", reason: string): Decision => Object.freeze({ allowed: false as const, category, reason });

/**
 * Application authorization interface (`29cf8fa5` delta 6): decides a
 * requirement for a principal stored with a resource, on its CURRENT grants,
 * without replacing or changing the caller's context. Used, for example, for
 * the submitter of a remote request when a worker is assigned work.
 *
 * The stored principal has no credential, coordination session or provider
 * evidence, so it never passes a session predicate, `intent_origin` or a
 * fresh-login requirement: a requirement with `freshLogin` is never allowed
 * for any stored principal kind in any mode. Every other denial (masking
 * first) answers before it; otherwise it is `forbidden`/`fresh_login_unavailable`.
 *
 * An account is evaluated as the kind the grants store records for it now;
 * an unknown or disabled account holds nothing and is never allowed: a
 * reference it would need is `not_found` (masking), and a requirement that
 * needs no grant (`authenticated`) is `forbidden`/`principal_unavailable`.
 *
 * `installation` and `operator` hold full authority only in a mode whose
 * acceptance admits that actor kind (`modeAdmitsActor`): the installation in
 * open and token mode, the operator in every mode. A stored `installation`
 * in better-auth mode (left over from an earlier mode) holds nothing and is
 * decided exactly as an unknown account. Returns the decision; never throws
 * for a denial. A malformed principal or requirement is
 * `forbidden`/`invalid_principal`.
 */
export function decideForPrincipal(input: PrincipalDecisionInput): Decision {
  const principal = copyPrincipal(input.principal);
  let requirement: OperationRequirement | null = null;
  try { requirement = frozenOperationRequirement(input.requirement); } catch { requirement = null; }
  if (!principal || !requirement) return denied("forbidden", "invalid_principal");
  let actor: Actor;
  let permissions: EffectivePermissions;
  let unavailable = false;
  if (principal.kind === "installation" || principal.kind === "operator") {
    // The mode is checked before any full-authority actor exists.
    if (modeAdmitsActor(input.mode, principal.kind)) {
      actor = principal.kind === "installation"
        ? Object.freeze({ kind: "installation" as const })
        : Object.freeze({ kind: "operator" as const, via: "unix" as const });
      permissions = effectivePermissions(actor, input.grants);
    } else {
      unavailable = true;
      actor = HOLDS_NOTHING;
      permissions = noPermissions();
    }
  } else {
    const stored = synchronous(input.grants.accountKind(principal.accountId), "grants_not_synchronous");
    // An unknown or disabled account has no actor kind. It is decided as an account holding no grants
    // (`effectivePermissions` yields nothing for it), so masking answers first, and fails closed even
    // where no grant is needed (`authenticated`, `agents: false`).
    unavailable = stored !== "human" && stored !== "agent";
    actor = stored === "agent"
      ? Object.freeze({ kind: "agent" as const, accountId: principal.accountId })
      : Object.freeze({ kind: "human" as const, accountId: principal.accountId });
    permissions = effectivePermissions(actor, input.grants);
  }
  const authority: CurrentAuthority = Object.freeze({ actor, mode: input.mode, listener: input.listener, evidence: null, coordinationSession: null });
  // Fresh login is decided here, after every other part, so the live exemption of full authority never applies to a stored principal.
  const { freshLogin, ...rest } = requirement;
  const decision = decideWith({
    authority, requirement: Object.freeze(rest), resources: input.resources, now: input.now, projects: input.projects, credential: null, permissions,
  });
  if (!decision.allowed) return decision;
  if (unavailable) return denied("forbidden", "principal_unavailable");
  if (freshLogin) return denied("forbidden", "fresh_login_unavailable");
  return decision;
}
