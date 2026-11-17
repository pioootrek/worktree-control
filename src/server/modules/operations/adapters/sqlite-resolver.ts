import { projectId, registrationId, type ProjectId } from "@/shared/contracts/operations";
import { OperationError } from "../errors";
import type { ResolvedResource, ResourceRef } from "../requirements";
import type { ResourceResolver } from "../resolver";
import { absorb, isThenable } from "../synchronous";

/**
 * The project directory of step 51, read synchronously on the controller's
 * owned connection. Structurally the SQLite `ProjectDirectoryQueries`
 * (`src/server/infrastructure/sqlite/project-directory-queries.ts`): each
 * lookup reads only its own table (`projects` for a registration,
 * `knowledge_projects` for a project) and answers `null` when no row has the
 * ID. This adapter opens nothing itself and validates everything it reads.
 */
export interface ProjectDirectoryReader {
  registration(id: string): { readonly id: unknown; readonly projectId: unknown; readonly incarnation: unknown; readonly mappingVersion: unknown } | null;
  project(id: string): { readonly id: unknown; readonly status: unknown } | null;
  projects(): ReadonlyArray<{ readonly id: unknown; readonly status: unknown }>;
}

/**
 * The version of every `project` resolution. A project resolves to itself:
 * its mapping never changes and it carries no relation, so one constant
 * changes whenever the mapping changes (never). The rule "never reused for the
 * same reference, including after delete and recreate" holds because no
 * production path deletes or recreates a `knowledge_projects` row (a test
 * pins that): an ID, once a project, stays that project. A restore of an older
 * database is the recovery boundary for every version, as for registrations;
 * see the module comment of `ProjectDirectoryQueries`.
 */
export const PROJECT_VERSION = 1;
/**
 * The most projects `listProjects` returns; a reader answering more is
 * refused (`internal`), never truncated. Equal to the SQLite reader's own
 * bound, which refuses first (a test compares the two).
 */
export const MAX_LISTED_PROJECTS = 1000;

const PROJECT_STATUSES: readonly unknown[] = Object.freeze(["active", "archived"]);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isStamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Data value of an own property, never an accessor and never anything inherited. */
function own(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** A synchronous reader answer; a throw or a thenable (absorbed) is `internal`/`reason`. */
function read<T>(lookup: () => T, reason: string): T {
  let answer: T;
  try { answer = lookup(); } catch { throw new OperationError("internal", reason); }
  if (isThenable(answer)) { absorb(answer); throw new OperationError("internal", "resolver_not_synchronous"); }
  return answer;
}

/** Whether a stored registration ID is one the contract can carry; `projects.id` has no grammar constraint in the schema. */
function isRegistrationId(value: string): boolean {
  try { registrationId(value); return true; } catch { return false; }
}

/** A contract project ID read from storage; one the contract cannot carry is `internal`/`reason`. */
function storedProjectId(value: unknown, reason: string): ProjectId {
  try { return projectId(value); } catch { throw new OperationError("internal", reason); }
}

/**
 * `ResourceResolver` over the SQLite project directory, for the kinds
 * `project` and `registration` only. Every other kind throws
 * `internal`/`resource_kind_unsupported`: it fails closed and never answers
 * `not_found`, so an operation that names such a kind cannot be mistaken for
 * one on a missing resource (those kinds arrive with slice 4).
 *
 * - `registration`: the `projects` row. Its project is its parent
 *   (`parent_project_id`); `null` is a parentless registration, a resolved
 *   fact. Its version is the row's `mapping_version`: the mapping clock issues
 *   it on creation and on every parent change, always above every value it
 *   issued before, so a reparent (back to an earlier parent too) and a delete
 *   and recreate under the same ID each give a version never seen for that ID.
 *   It carries no relation, so nothing else can change it. A row not stamped
 *   yet (incarnation or mapping version 0) is `internal`, never version 0.
 * - `project`: the `knowledge_projects` row resolves to itself with
 *   {@link PROJECT_VERSION}. Archived projects resolve as well: archiving
 *   changes neither the project's identity nor its mapping, and the
 *   operations on an archived project (reading it, restoring it) must be able
 *   to name it. Whether an operation accepts an archived project is that
 *   operation's state rule, not a resolution.
 *
 * The versions are unique within one linear history of the database. A
 * restore rewinds the mapping clock; the quarantine (`auth fence resume`) is
 * the recovery boundary, and a store that retains versions across requests
 * must be emptied or invalidated by it.
 */
export class SqliteResourceResolver implements ResourceResolver {
  readonly #reader: ProjectDirectoryReader;

  constructor(reader: ProjectDirectoryReader) {
    if (typeof reader?.registration !== "function" || typeof reader.project !== "function" || typeof reader.projects !== "function") {
      throw new TypeError("Invalid project directory reader.");
    }
    this.#reader = reader;
  }

  resolve(ref: ResourceRef): ResolvedResource | null {
    if (typeof ref !== "object" || ref === null) throw new OperationError("internal", "invalid_resource_reference");
    const kind = own(ref, "kind"), id = own(ref, "id");
    if (!isText(id)) throw new OperationError("internal", "invalid_resource_reference");
    switch (kind) {
      case "registration": return this.#registration(id);
      case "project": return this.#project(id);
      default: throw new OperationError("internal", "resource_kind_unsupported");
    }
  }

  listProjects(): readonly ProjectId[] {
    const rows: unknown = read(() => this.#reader.projects(), "project_list_read_failed");
    if (!Array.isArray(rows)) throw new OperationError("internal", "invalid_stored_project");
    if (rows.length > MAX_LISTED_PROJECTS) throw new OperationError("internal", "project_list_limit_exceeded");
    const ids = rows.map(row => this.#projectRow(row).id);
    if (new Set(ids).size !== ids.length) throw new OperationError("internal", "invalid_stored_project");
    return Object.freeze(ids);
  }

  #registration(id: string): ResolvedResource | null {
    const row: unknown = read(() => this.#reader.registration(id), "registration_read_failed");
    if (row === null) return null;
    const invalid = () => new OperationError("internal", "invalid_stored_registration");
    if (typeof row !== "object") throw invalid();
    const storedId = own(row, "id"), parent = own(row, "projectId"), incarnation = own(row, "incarnation"), version = own(row, "mappingVersion");
    if (storedId !== id || !isRegistrationId(id) || !isStamp(incarnation) || !isStamp(version) || !(parent === null || isText(parent))) throw invalid();
    if (incarnation === 0 || version === 0) throw new OperationError("internal", "registration_unstamped");
    if (version < incarnation) throw invalid();
    const project = parent === null ? null : storedProjectId(parent, "invalid_stored_registration");
    return Object.freeze({ ref: Object.freeze({ kind: "registration" as const, id }), projectId: project, version, relation: null });
  }

  #project(id: string): ResolvedResource | null {
    const row: unknown = read(() => this.#reader.project(id), "project_read_failed");
    if (row === null) return null;
    const project = this.#projectRow(row);
    if (project.id !== id) throw new OperationError("internal", "invalid_stored_project");
    return Object.freeze({ ref: Object.freeze({ kind: "project" as const, id }), projectId: project.id, version: PROJECT_VERSION, relation: null });
  }

  #projectRow(row: unknown): { id: ProjectId } {
    if (typeof row !== "object" || row === null) throw new OperationError("internal", "invalid_stored_project");
    if (!PROJECT_STATUSES.includes(own(row, "status"))) throw new OperationError("internal", "invalid_stored_project");
    return { id: storedProjectId(own(row, "id"), "invalid_stored_project") };
  }
}
