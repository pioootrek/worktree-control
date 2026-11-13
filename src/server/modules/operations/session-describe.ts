import {
  FRESH_LOGIN_WINDOW_MS, installationPermissions, projectPermissions,
  type ProjectId, type SessionDescription,
} from "@/shared/contracts/operations";
import { isFullAuthority } from "./authentication-context";
import { freshLoginState } from "./decide";
import { OperationError } from "./errors";
import type { ReadOperation } from "./operation";
import { pick } from "./release";
import { authenticated } from "./requirements";

/** Upper bound of projects listed in one description. */
export const MAX_DESCRIBED_PROJECTS = 500;

const publicKeys = Object.freeze(["actor", "mode", "listener", "fullAuthority", "installationPermissions", "projects", "projectsTruncated", "freshLogin"] as const);

/**
 * Describes the caller's current authority as a hint. Works with zero roles.
 * Lists installation permissions and every visible project (decision M: any
 * active project role there, `admin`, or full authority) with the project
 * permissions actually held, which may be only `worker:execute` or
 * `secrets:*`. Never a cached authorization decision: every operation decides
 * again on current state. The definition is frozen.
 */
const definition: ReadOperation<Record<string, never>, SessionDescription, SessionDescription> = {
  id: "session.describe",
  kind: "read",
  requirement: Object.freeze({ require: authenticated() }),
  parse(raw) {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 0) throw new OperationError("invalid_request", "unexpected_input");
    return {};
  },
  resources: () => ({}),
  read(_input, scope) {
    const { authority, release, resolver, now } = scope;
    const { actor } = authority;
    const visible = [...new Set(resolver.listProjects())].filter(id => release.visible(id)).sort();
    const projects = visible.slice(0, MAX_DESCRIBED_PROJECTS).map((projectId: ProjectId) => ({
      projectId, permissions: projectPermissions.filter(permission => release.can(permission, projectId)),
    }));
    const state = freshLoginState(authority, now);
    const at = authority.evidence?.authenticatedAt;
    return {
      actor: { kind: actor.kind, accountId: actor.kind === "human" || actor.kind === "agent" ? actor.accountId : null },
      mode: authority.mode,
      listener: authority.listener,
      fullAuthority: isFullAuthority(actor),
      installationPermissions: installationPermissions.filter(permission => release.canInstallation(permission)),
      projects,
      projectsTruncated: visible.length > MAX_DESCRIBED_PROJECTS,
      freshLogin: { state, validUntil: state === "satisfied" && typeof at === "number" ? new Date(at + FRESH_LOGIN_WINDOW_MS).toISOString() : null },
    };
  },
  publicKeys,
  project: result => pick(result, publicKeys),
};
export const sessionDescribe: ReadOperation<Record<string, never>, SessionDescription, SessionDescription> = Object.freeze(definition);
