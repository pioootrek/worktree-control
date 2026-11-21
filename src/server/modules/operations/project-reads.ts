import {
  accountId, projectId, registrationId,
  type ClaimHolder, type DiscoveredWorktree, type ProjectId, type ProjectListItem, type ProjectListResult, type ProjectStatusResult,
  type ProjectWorktreesResult, type RegistrationId, type RegistrationPhase, type RegistrationStatus, type RegistrationSummary, type RegistrationWorktrees,
} from "@/shared/contracts/operations";
import { OperationError } from "./errors";
import type { QueryOperation, ReadOperation } from "./operation";
import { pick, type ReleaseContext } from "./release";
import { collection, onProject } from "./requirements";
import { absorb, isThenable } from "./synchronous";

/**
 * The first project read family (D2a): `project.list`, `project.status` and
 * `project.worktrees` (dispositions, section 3.2; rows 1.1 to 1.4).
 *
 * A project is a Knowledge project row; its registrations
 * (`projects` rows whose parent it is) carry the runtime placement. A project
 * may have no registration or several. A registration without a parent is a
 * parentless resource: only full authority sees it, as its own `project.list`
 * item with `projectId: null`, and no project-addressed read reaches it.
 * Archived projects are read like active ones; their status is released.
 *
 * The definitions are built once by bootstrap over three ports: the store's
 * write-free catalog, the runtime's in-memory placement and a bounded,
 * coalescing worktree discovery. No port is called outside an admitted phase
 * except discovery, which runs as the query's work.
 */

/** Registrations listed per project; more set `registrationsTruncated`. */
export const MAX_PROJECT_REGISTRATIONS = 16;
/** Worktrees released by one `project.worktrees` call, across its registrations. */
export const MAX_PROJECT_WORKTREES = 64;
/** Default and maximum page size of `project.list`. */
export const PROJECT_LIST_DEFAULT_LIMIT = 50;
/** Bound of one `project.worktrees` discovery: below the 10 s transport deadline, so a slow Git answers `query_timed_out`. */
export const PROJECT_WORKTREES_TIMEOUT_MS = 8_000;
const MAX_CURSOR_LENGTH = 512;

/** Write-free storage facts (the store's `projectCatalogReader()`), validated here. */
export interface ProjectCatalogReader {
  projects(): ReadonlyArray<unknown>;
  project(id: string): unknown;
  /** Every registration, or only the children of `projectId`, with active claims evaluated at `now` (ISO). */
  registrations(now: string, projectId?: string): ReadonlyArray<unknown>;
}

/** In-memory runtime placement of a registration (the process manager). Synchronous. */
export interface RegistrationPlacementReader {
  statusSummary(registrationId: string): { phase: unknown; worktreePath: unknown; startedAt: unknown };
}

/** One discovered worktree, before the allowlist. */
export type WorktreeFact = Readonly<Record<string, unknown>>;
/**
 * What discovery found for one repository. `partial`: Git listed the trees but
 * could not read the status of at least one, released with `dirty: null`.
 * `truncated`: trees were left out by the per-repository bound or the call's budget.
 */
export type RepositoryDiscovery =
  | { state: "unavailable" }
  | { state: "complete" | "partial"; worktrees: readonly WorktreeFact[]; truncated: boolean };
/**
 * Bounded, coalesced worktree discovery of one project's repositories, in the
 * given order, with one budget of status reads across all of them. Answers one
 * entry per path; rejects with `busy` on capacity and on abort.
 */
export interface WorktreeDiscoveryPort {
  discover(repositoryPaths: readonly string[], budget: number, signal: AbortSignal): Promise<readonly RepositoryDiscovery[]>;
}

export interface ProjectReadPorts {
  catalog: ProjectCatalogReader;
  placement: RegistrationPlacementReader;
  discovery: WorktreeDiscoveryPort;
}

interface CatalogProject { id: ProjectId; name: string; status: "active" | "archived"; revision: number }
/** Holder identity only (dispositions 4.9): the claim's reason, owner and times are never read into the operation. */
interface CatalogClaim { kind: "human" | "agent"; accountId: string | null }
interface CatalogRegistration {
  id: RegistrationId;
  /** `undefined`: a stored parent the contract cannot name. */
  projectId: ProjectId | null | undefined;
  mappingVersion: number;
  name: string;
  repositoryPath: string;
  port: number;
  managedServer: boolean;
  executable: string;
  args: string[];
  selectedWorktreePath: string | null;
  claim: CatalogClaim | null;
}
interface Placed extends CatalogRegistration { phase: RegistrationPhase; worktreePath: string | null; startedAt: string | null }

const PHASES: readonly unknown[] = Object.freeze(["stopped", "starting", "running", "stopping", "failed"]);
const corrupt = (reason = "invalid_stored_project") => new OperationError("internal", reason);
const isText = (value: unknown): value is string => typeof value === "string";
const optionalText = (value: unknown): value is string | null => value === null || typeof value === "string";
const own = (source: unknown, key: string): unknown => {
  if (typeof source !== "object" || source === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};
const tryId = <T>(make: (value: unknown) => T, value: unknown): T | undefined => { try { return make(value); } catch { return undefined; } };

/** A synchronous port answer; a throw or thenable is `internal`/`reason`. */
function port<T>(call: () => T, reason: string): T {
  let value: T;
  try { value = call(); } catch { throw corrupt(reason); }
  if (isThenable(value)) { absorb(value); throw corrupt(reason); }
  return value;
}

function projectRow(row: unknown): CatalogProject | null {
  const id = own(row, "id"), name = own(row, "name"), status = own(row, "status"), revision = own(row, "revision");
  if (!isText(id) || !isText(name) || (status !== "active" && status !== "archived") || !Number.isSafeInteger(revision) || (revision as number) < 1) throw corrupt();
  // An ID outside the contract grammar cannot be named by any operation; it is left out, as the resolver's listing does.
  const typed = tryId(projectId, id);
  return typed === undefined ? null : { id: typed, name, status, revision: revision as number };
}

function claimRow(row: unknown): CatalogClaim | null {
  if (row === null) return null;
  const kind = own(row, "kind"), principal = own(row, "principalId");
  if ((kind !== "human" && kind !== "agent") || !optionalText(principal)) throw corrupt("invalid_stored_registration");
  return { kind, accountId: principal === null ? null : (tryId(accountId, principal) ?? null) };
}

function registrationRow(row: unknown): CatalogRegistration | null {
  const id = own(row, "id"), parent = own(row, "projectId"), version = own(row, "mappingVersion"), name = own(row, "name");
  const repositoryPath = own(row, "repositoryPath"), port = own(row, "port"), preset = own(row, "launchPreset"), executable = own(row, "executable");
  const argsJson = own(row, "argsJson"), selected = own(row, "selectedWorktreePath");
  if (!isText(id) || !optionalText(parent) || !Number.isSafeInteger(version) || (version as number) < 0 || !isText(name) || !isText(repositoryPath)
    || !Number.isSafeInteger(port) || !isText(preset) || !isText(executable) || !isText(argsJson) || !optionalText(selected)) {
    throw corrupt("invalid_stored_registration");
  }
  let args: unknown;
  try { args = JSON.parse(argsJson); } catch { throw corrupt("invalid_stored_registration"); }
  if (!Array.isArray(args) || !args.every(isText)) throw corrupt("invalid_stored_registration");
  const typed = tryId(registrationId, id);
  // A registration ID the contract cannot carry cannot be named; it is left out like a non-conforming project.
  if (typed === undefined) return null;
  return {
    id: typed, projectId: parent === null ? null : tryId(projectId, parent), mappingVersion: version as number, name, repositoryPath,
    port: port as number, managedServer: preset !== "none", executable, args: [...args], selectedWorktreePath: selected, claim: claimRow(own(row, "claim")),
  };
}

function placed(placement: RegistrationPlacementReader, registration: CatalogRegistration): Placed {
  const current = port(() => placement.statusSummary(registration.id), "placement_unavailable");
  const phase = own(current, "phase"), worktreePath = own(current, "worktreePath"), startedAt = own(current, "startedAt");
  if (!PHASES.includes(phase) || !optionalText(worktreePath) || !optionalText(startedAt)) throw corrupt("placement_unavailable");
  // The runtime's path names the running worktree only while a runtime is live. A stopped or failed runtime keeps its last path,
  // but the next default start resolves the selected worktree, so that is the one reported.
  const live = phase === "starting" || phase === "running" || phase === "stopping";
  return { ...registration, phase: phase as RegistrationPhase, worktreePath: live ? worktreePath ?? registration.selectedWorktreePath : registration.selectedWorktreePath, startedAt };
}

function registrations(catalog: ProjectCatalogReader, now: number, project?: ProjectId): CatalogRegistration[] {
  const rows = port(() => catalog.registrations(new Date(now).toISOString(), project), "registration_read_failed");
  if (!Array.isArray(rows)) throw corrupt("invalid_stored_registration");
  return rows.map(registrationRow).filter((row): row is CatalogRegistration => row !== null)
    // Only the children the read asked for: a reader answering more is corrupt.
    .map(row => { if (project !== undefined && row.projectId !== project) throw corrupt("invalid_stored_registration"); return row; })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * Claim relation. `own` needs the caller's coordination session as the holder;
 * stored claims carry no coordination session yet (D1c), so a claim is `other`
 * for every caller of this surface and never adopted (dispositions 3.1).
 */
function relation(registration: Placed): RegistrationSummary["claim"] {
  return registration.claim === null ? "none" : "other";
}

function summary(registration: Placed): RegistrationSummary {
  return {
    registrationId: registration.id, name: registration.name, port: registration.port, phase: registration.phase,
    worktreePath: registration.worktreePath, claim: relation(registration),
  };
}

function bounded<T>(items: readonly T[]): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, MAX_PROJECT_REGISTRATIONS), truncated: items.length > MAX_PROJECT_REGISTRATIONS };
}

function plainInput(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new OperationError("invalid_request", "invalid_input");
  const prototype: unknown = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) throw new OperationError("invalid_request", "invalid_input");
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new OperationError("invalid_request", "unexpected_input");
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor)) throw new OperationError("invalid_request", "invalid_input");
  }
  return raw as Record<string, unknown>;
}

function projectInput(raw: unknown, allowed: readonly string[]): { input: Record<string, unknown>; projectId: ProjectId } {
  const input = plainInput(raw, allowed);
  const id = tryId(projectId, input.projectId);
  if (id === undefined) throw new OperationError("invalid_request", "invalid_project_id");
  return { input, projectId: id };
}

// project.list ------------------------------------------------------------

interface ListInput { limit: number; cursor: string | null }
interface ListEntry { key: string; projectId: ProjectId | null; name: string; status: "active" | "archived" | null; registrations: CatalogRegistration[] }
interface ListInternal { input: ListInput; entries: ListEntry[] }

const listKeys = Object.freeze(["items", "nextCursor"] as const);

function listOperation(ports: ProjectReadPorts): ReadOperation<ListInput, ListInternal, ProjectListResult> {
  return {
    id: "project.list",
    kind: "read",
    // HTTP (API and unix), MCP and CLI only: H is the API on TCP and the unix socket, never the worker listener.
    excludedListeners: Object.freeze(["worker"] as const),
    requirement: Object.freeze({ require: collection("project:read") }),
    parse(raw) {
      const input = plainInput(raw, ["limit", "cursor"]);
      const limit = input.limit === undefined ? PROJECT_LIST_DEFAULT_LIMIT : input.limit;
      if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new OperationError("invalid_request", "invalid_limit");
      const cursor = input.cursor === undefined || input.cursor === null ? null : input.cursor;
      if (cursor !== null && (!isText(cursor) || cursor.length < 1 || cursor.length > MAX_CURSOR_LENGTH)) throw new OperationError("invalid_request", "invalid_cursor");
      return { limit: limit as number, cursor };
    },
    resources: () => ({}),
    read(input, scope) {
      const rows = port(() => ports.catalog.projects(), "project_list_read_failed");
      if (!Array.isArray(rows)) throw corrupt();
      const projects = rows.map(projectRow).filter((row): row is CatalogProject => row !== null);
      if (new Set(projects.map(project => project.id)).size !== projects.length) throw corrupt();
      const children = new Map<ProjectId, CatalogRegistration[]>(projects.map(project => [project.id, []]));
      const entries: ListEntry[] = [];
      for (const registration of registrations(ports.catalog, scope.now)) {
        // A parent the contract cannot name, or that is not a listed project, belongs to no item.
        if (registration.projectId === undefined) continue;
        if (registration.projectId === null) {
          entries.push({ key: `r:${registration.id}`, projectId: null, name: registration.name, status: null, registrations: [registration] });
          continue;
        }
        children.get(registration.projectId)?.push(registration);
      }
      for (const project of projects) {
        entries.push({ key: `p:${project.id}`, projectId: project.id, name: project.name, status: project.status, registrations: children.get(project.id)! });
      }
      return { input, entries };
    },
    publicKeys: listKeys,
    project({ input, entries }, release) {
      // Filtered per item by visibility and project:read before pagination; parentless items reach full authority only.
      const page = release.page(entries, { projectOf: entry => entry.projectId, keyOf: entry => entry.key, permission: "project:read", limit: input.limit, cursor: input.cursor });
      const items: ProjectListItem[] = page.items.map(entry => {
        const listed = bounded(entry.registrations);
        return { projectId: entry.projectId, name: entry.name, status: entry.status, registrations: listed.items.map(item => summary(placed(ports.placement, item))), registrationsTruncated: listed.truncated };
      });
      return pick({ items, nextCursor: page.nextCursor }, listKeys);
    },
  };
}

// project.status ----------------------------------------------------------

interface StatusInput { projectId: ProjectId; compact: boolean }
interface StatusInternal { input: StatusInput; project: CatalogProject; registrations: Placed[]; truncated: boolean }

const LAUNCH_KEYS = Object.freeze(["executable", "args"] as const);
const CLAIM_HOLDER_KEYS = Object.freeze(["kind", "accountId"] as const);
const statusKeys = Object.freeze(["projectId", "name", "status", "revision", "writable", "compact", "registrations", "registrationsTruncated"] as const);

function statusDetail(registration: Placed, projectId: ProjectId, release: ReleaseContext): RegistrationStatus {
  const detail: RegistrationStatus = {
    ...summary(registration), selectedWorktreePath: registration.selectedWorktreePath, startedAt: registration.startedAt, managedServer: registration.managedServer,
  };
  // Gated categories (section 4.9): the raw command only with config:read, holder identity only with claims:manage.
  if (release.can("config:read", projectId)) detail.launch = pick({ executable: registration.executable, args: [...registration.args] }, LAUNCH_KEYS);
  if (registration.claim && release.can("claims:manage", projectId)) {
    // The identity allowlist: who holds the claim, nothing about why or until when.
    detail.claimHolder = pick({ kind: registration.claim.kind, accountId: registration.claim.accountId as ClaimHolder["accountId"] }, CLAIM_HOLDER_KEYS);
  }
  return detail;
}

function statusOperation(ports: ProjectReadPorts): ReadOperation<StatusInput, StatusInternal, ProjectStatusResult> {
  return {
    id: "project.status",
    kind: "read",
    excludedListeners: Object.freeze(["worker"] as const),
    requirement: Object.freeze({ require: onProject("project:read", "project") }),
    parse(raw) {
      const { input, projectId } = projectInput(raw, ["projectId", "compact"]);
      if (input.compact !== undefined && typeof input.compact !== "boolean") throw new OperationError("invalid_request", "invalid_input");
      return { projectId, compact: input.compact === true };
    },
    resources: input => ({ project: { kind: "project", id: input.projectId } }),
    read(input, scope) {
      // Resolved and visible in this same admitted phase, so the row exists.
      const project = projectRow(port(() => ports.catalog.project(input.projectId), "project_read_failed"));
      if (!project || project.id !== input.projectId) throw corrupt();
      const listed = bounded(registrations(ports.catalog, scope.now, project.id));
      return { input, project, registrations: listed.items.map(registration => placed(ports.placement, registration)), truncated: listed.truncated };
    },
    publicKeys: statusKeys,
    project({ input, project, registrations: items, truncated }, release) {
      return pick({
        projectId: project.id, name: project.name, status: project.status, revision: project.revision,
        writable: release.can("knowledge:write", project.id), compact: input.compact,
        registrations: items.map(item => input.compact ? summary(item) : statusDetail(item, project.id, release)),
        registrationsTruncated: truncated,
      }, statusKeys);
    },
  };
}

// project.worktrees -------------------------------------------------------

interface WorktreesInput { projectId: ProjectId }
interface PlannedRegistration { id: RegistrationId; mappingVersion: number; repositoryPath: string }
interface WorktreesPlan { projectId: ProjectId; registrations: PlannedRegistration[]; truncated: boolean }
interface WorktreesResult { id: RegistrationId; discovery: RegistrationWorktrees["discovery"]; worktrees: DiscoveredWorktree[]; truncated: boolean }
interface WorktreesInternal { plan: WorktreesPlan; results: WorktreesResult[] }

const worktreesKeys = Object.freeze(["projectId", "registrations", "registrationsTruncated"] as const);
const WORKTREE_KEYS = Object.freeze(["path", "branch", "head", "shortHead", "detached", "locked", "prunable", "dirty"] as const);

/** Copies only the allowlisted fields; a malformed tree fails that registration's discovery, never the call. */
function worktreeFact(fact: WorktreeFact): DiscoveredWorktree {
  const path = own(fact, "path"), branch = own(fact, "branch"), head = own(fact, "head"), shortHead = own(fact, "shortHead");
  const detached = own(fact, "detached"), locked = own(fact, "locked"), prunable = own(fact, "prunable"), dirty = own(fact, "dirty");
  if (!isText(path) || !optionalText(branch) || !isText(head) || !isText(shortHead) || typeof detached !== "boolean" || typeof locked !== "boolean"
    || typeof prunable !== "boolean" || (typeof dirty !== "boolean" && dirty !== null)) throw new Error("Malformed worktree.");
  return pick({ path, branch, head, shortHead, detached, locked, prunable, dirty }, WORKTREE_KEYS);
}

function plannedRegistrations(catalog: ProjectCatalogReader, now: number, project: ProjectId): { registrations: PlannedRegistration[]; truncated: boolean } {
  const listed = bounded(registrations(catalog, now, project));
  return { registrations: listed.items.map(({ id, mappingVersion, repositoryPath }) => ({ id, mappingVersion, repositoryPath })), truncated: listed.truncated };
}

function worktreesOperation(ports: ProjectReadPorts): QueryOperation<WorktreesInput, WorktreesInternal, ProjectWorktreesResult, WorktreesPlan> {
  return {
    id: "project.worktrees",
    kind: "query",
    excludedListeners: Object.freeze(["worker"] as const),
    requirement: Object.freeze({ require: onProject("project:read", "project") }),
    timeoutMs: PROJECT_WORKTREES_TIMEOUT_MS,
    parse(raw) { return { projectId: projectInput(raw, ["projectId"]).projectId }; },
    resources: input => ({ project: { kind: "project", id: input.projectId } }),
    plan(input, scope) {
      return { projectId: input.projectId, ...plannedRegistrations(ports.catalog, scope.now, input.projectId) };
    },
    async work(plan, signal) {
      // Every call discovers (no refresh operation). One discovery for the whole project, so the
      // budget of MAX_PROJECT_WORKTREES status reads covers all its registrations, not each one.
      let found: unknown;
      try {
        found = await ports.discovery.discover(plan.registrations.map(registration => registration.repositoryPath), MAX_PROJECT_WORKTREES, signal);
      } catch (error) {
        // Cancellation and capacity keep their public answer; anything else says nothing about its cause.
        if (signal.aborted || error instanceof OperationError) throw error;
        throw new OperationError("unavailable", "discovery_failed", { retry: "retry" });
      }
      if (!Array.isArray(found) || found.length !== plan.registrations.length) throw corrupt("discovery_failed");
      let remaining = MAX_PROJECT_WORKTREES;
      const results = plan.registrations.map((registration, index): WorktreesResult => {
        const unavailable: WorktreesResult = { id: registration.id, discovery: "unavailable", worktrees: [], truncated: false };
        const entry: unknown = found[index], state = own(entry, "state"), facts = own(entry, "worktrees"), truncated = own(entry, "truncated");
        if (state !== "complete" && state !== "partial") return unavailable;
        if (!Array.isArray(facts) || typeof truncated !== "boolean") return unavailable;
        // A malformed tree fails that registration's discovery, never the call.
        let worktrees: DiscoveredWorktree[];
        try { worktrees = facts.map(worktreeFact); } catch { return unavailable; }
        // The port answers within its budget; the cut here keeps the bound whatever it answers.
        const kept = worktrees.slice(0, remaining);
        remaining -= kept.length;
        return { id: registration.id, discovery: state, worktrees: kept, truncated: truncated || kept.length < worktrees.length };
      });
      return { plan, results };
    },
    publicKeys: worktreesKeys,
    project({ plan, results }) {
      // The project resolution cannot see a registration moving or changing its repository during discovery.
      // Release only what was discovered for the registrations the project still has, unchanged.
      // Claims play no part in this comparison, so their evaluation time does not matter.
      const current = plannedRegistrations(ports.catalog, 0, plan.projectId);
      const same = current.truncated === plan.truncated && current.registrations.length === plan.registrations.length
        && current.registrations.every((registration, index) => {
          const planned = plan.registrations[index];
          return registration.id === planned.id && registration.mappingVersion === planned.mappingVersion && registration.repositoryPath === planned.repositoryPath;
        });
      if (!same) throw new OperationError("conflict", "resource_changed");
      const entries: RegistrationWorktrees[] = results.map(result => ({
        registrationId: result.id, discovery: result.discovery, worktrees: result.worktrees, worktreesTruncated: result.truncated,
      }));
      return pick({ projectId: plan.projectId, registrations: entries, registrationsTruncated: plan.truncated }, worktreesKeys);
    },
  };
}

/** The three frozen definitions over bootstrap's ports. */
export function createProjectReads(ports: ProjectReadPorts) {
  if (typeof ports?.catalog?.projects !== "function" || typeof ports.catalog.project !== "function" || typeof ports.catalog.registrations !== "function"
    || typeof ports.placement?.statusSummary !== "function" || typeof ports.discovery?.discover !== "function") {
    throw new TypeError("Invalid project read ports.");
  }
  return Object.freeze({
    list: Object.freeze(listOperation(ports)),
    status: Object.freeze(statusOperation(ports)),
    worktrees: Object.freeze(worktreesOperation(ports)),
  });
}
