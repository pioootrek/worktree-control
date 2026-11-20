import {
  FRESH_LOGIN_WINDOW_MS, installationPermissions, listenerKinds, projectPermissions,
  type SessionDescription,
} from "@/shared/contracts/operations";
import { isFullAuthority } from "./authentication-context";
import { freshLoginState, isProjectId } from "./decide";
import { OperationError } from "./errors";
import type { ReadOperation } from "./operation";
import { pick } from "./release";
import { authenticated } from "./requirements";
import { synchronous } from "./synchronous";

/** Upper bound of projects listed in one description. */
export const MAX_DESCRIBED_PROJECTS = 500;
/** Serialized UTF-8 DTO budget: 248 KiB leaves 8 KiB below the transport ceiling. */
export const MAX_DESCRIBED_BYTES = 248 * 1024;
// Use the widest declared listener's exact JSON size for every description, so
// choosing another transport cannot change the project prefix at a boundary.
const listenerBytes = Math.max(...listenerKinds.map(listener => Buffer.byteLength(JSON.stringify(listener), "utf8")));

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
    // Only real project IDs: a stray `null` ("no project") or malformed entry is never listed, not even to full authority, for which `visible(null)` holds.
    const listed: readonly unknown[] = synchronous(resolver.listProjects(), "resolver_not_synchronous");
    const visible = [...new Set(listed)].filter(isProjectId).filter(id => release.visible(id)).sort();
    const state = freshLoginState(authority, now);
    const at = authority.evidence?.authenticatedAt;
    const result: SessionDescription = {
      actor: { kind: actor.kind, accountId: actor.kind === "human" || actor.kind === "agent" ? actor.accountId : null },
      mode: authority.mode,
      listener: authority.listener,
      fullAuthority: isFullAuthority(actor),
      installationPermissions: installationPermissions.filter(permission => release.canInstallation(permission)),
      projects: [],
      projectsTruncated: false,
      freshLogin: { state, validUntil: state === "satisfied" && typeof at === "number" ? new Date(at + FRESH_LOGIN_WINDOW_MS).toISOString() : null },
    };
    // Count the complete fixed DTO with [] and false. Appending a serialized
    // entry replaces no other bytes, adding just its UTF-8 bytes and a comma
    // after the first entry. A truncated result uses true, one byte shorter.
    let bytes = Buffer.byteLength(JSON.stringify(result), "utf8")
      + listenerBytes - Buffer.byteLength(JSON.stringify(result.listener), "utf8");
    if (bytes - Number(visible.length > 0) > MAX_DESCRIBED_BYTES) throw new OperationError("payload_too_large", "response_too_large");
    for (const projectId of visible.slice(0, MAX_DESCRIBED_PROJECTS)) {
      const project = { projectId, permissions: projectPermissions.filter(permission => release.can(permission, projectId)) };
      const nextBytes = bytes + Buffer.byteLength(JSON.stringify(project), "utf8") + Number(result.projects.length > 0);
      const truncated = result.projects.length + 1 < visible.length;
      if (nextBytes - Number(truncated) > MAX_DESCRIBED_BYTES) break;
      result.projects.push(project);
      bytes = nextBytes;
    }
    result.projectsTruncated = result.projects.length < visible.length;
    return result;
  },
  publicKeys,
  project: result => pick(result, publicKeys),
};
export const sessionDescribe: ReadOperation<Record<string, never>, SessionDescription, SessionDescription> = Object.freeze(definition);
