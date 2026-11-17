import type Database from "better-sqlite3";
import { schemaTarget } from "./migration-registry";
import { PROJECT_MAPPING_VERSION } from "./mapping-structure-migration";

/*
 * The IDs of three namespaces, branded so that none is accepted where another
 * is meant. They are declared here, not imported from
 * `src/shared/contracts/operations.ts`: while the operations module is
 * unmounted (decision U), `src/server/modules/operations/unmounted.test.ts`
 * refuses every import of that contract from any other file. The names match
 * the contract's; the adapter that mounts both replaces these declarations with
 * the contract's types. Until then a contract `ProjectId` and this one are
 * distinct types, which only narrows what is accepted.
 */
declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };
/** A project: a `knowledge_projects` row. */
export type ProjectId = Brand<string, "ProjectId">;
/** A registration of a repository on this machine: a `projects` row. */
export type RegistrationId = Brand<string, "RegistrationId">;
/** A project as remote workers know it: a `remote_project_identities` row. */
export type RemoteIdentityId = Brand<string, "RemoteIdentityId">;

/** A registration's or remote identity's mapping, as stored. */
export interface StoredMapping<Id> {
  readonly id: Id;
  /** The parent project, or null when the row is parentless. */
  readonly projectId: ProjectId | null;
  /** The clock value of the row's creation; 0 when not stamped yet. */
  readonly incarnation: number;
  /** The clock value of the row's creation or last mapping change; 0 when not stamped yet. */
  readonly mappingVersion: number;
}
export type RegistrationMapping = StoredMapping<RegistrationId>;
export type RemoteIdentityMapping = StoredMapping<RemoteIdentityId>;
export interface StoredProject { readonly id: ProjectId; readonly status: "active" | "archived" }

/** The most rows one project's listing returns; more is refused, never truncated. */
export const PROJECT_DIRECTORY_LIMIT = 1000;
/** The most projects the listing of every project returns; more is refused, never truncated. */
export const PROJECT_LIST_LIMIT = 1000;

type MappingRow = { id: unknown; parent_project_id: unknown; incarnation: unknown; mapping_version: unknown };
function stamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Malformed project mapping stamp.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Malformed project mapping ID.");
  return value;
}
function mapping<Id extends string>(row: MappingRow): StoredMapping<Id> {
  return {
    id: text(row.id) as Id,
    // A stored foreign key to knowledge_projects(id): a project ID by where it is stored.
    projectId: row.parent_project_id === null ? null : text(row.parent_project_id) as ProjectId,
    incarnation: stamp(row.incarnation),
    mappingVersion: stamp(row.mapping_version),
  };
}

/**
 * The project directory of step 51: a typed, read-only view of which project
 * each registration and remote identity belongs to. Not mounted anywhere: no
 * production file imports it until the resolver adapter does (a guard test
 * keeps it so). It borrows the owner's connection, as the other query modules
 * do, and never owns the database lifecycle. Its construction checks step 51
 * against the supported version.
 *
 * It returns storage facts only. Unstamped rows (incarnation and mapping
 * version 0, from before step 51 and not yet stamped by an act or a
 * quarantine) are returned as they are, never hidden. Each lookup reads its own
 * table: a registration ID is never looked up as a project or a remote identity,
 * and no lookup falls back from one table to another.
 *
 * `mappingVersion` is a bounded change stamp from the installation-wide mapping
 * clock. It is NOT by itself the `version` of a `ResolvedResource`: a later
 * adapter composes that version and must also account for relation changes
 * (claims, runs and the other relations a resolver reports). The stamps are
 * unique and increasing only within one linear history of the database. A
 * restore of an older database rewinds the clock, which may then issue values
 * it issued before; the recovery boundary is the quarantine (`auth fence
 * resume`), which re-stamps every row. So anything that retains a version
 * across requests must be emptied or invalidated by the quarantine. That is an
 * obligation on the later pull request that adds such a store; this module
 * cannot enforce it.
 */
export class ProjectDirectoryQueries {
  constructor(private readonly database: Database.Database) {
    schemaTarget(PROJECT_MAPPING_VERSION);
  }

  /** The registration with this ID, or null when no such row exists. */
  registration(id: RegistrationId): RegistrationMapping | null {
    const row = this.database.prepare("SELECT id,parent_project_id,incarnation,mapping_version FROM projects WHERE id=?").get(text(id)) as MappingRow | undefined;
    return row ? mapping<RegistrationId>(row) : null;
  }

  /** The remote identity with this ID, or null when no such row exists. */
  remoteIdentity(id: RemoteIdentityId): RemoteIdentityMapping | null {
    const row = this.database.prepare("SELECT id,parent_project_id,incarnation,mapping_version FROM remote_project_identities WHERE id=?").get(text(id)) as MappingRow | undefined;
    return row ? mapping<RemoteIdentityId>(row) : null;
  }

  /** The project with this ID, or null when no such row exists. */
  project(id: ProjectId): StoredProject | null {
    const row = this.database.prepare("SELECT id,status FROM knowledge_projects WHERE id=?").get(text(id)) as { id: unknown; status: unknown } | undefined;
    if (!row) return null;
    if (row.status !== "active" && row.status !== "archived") throw new Error("Malformed project status.");
    return { id: text(row.id) as ProjectId, status: row.status };
  }

  /**
   * Every project, archived ones included, by ID. Throws above
   * {@link PROJECT_LIST_LIMIT} projects.
   */
  projects(): StoredProject[] {
    const rows = this.database.prepare("SELECT id,status FROM knowledge_projects ORDER BY id LIMIT ?").all(PROJECT_LIST_LIMIT + 1) as Array<{ id: unknown; status: unknown }>;
    if (rows.length > PROJECT_LIST_LIMIT) throw new Error("Project listing exceeds its limit.");
    return rows.map(row => {
      if (row.status !== "active" && row.status !== "archived") throw new Error("Malformed project status.");
      return { id: text(row.id) as ProjectId, status: row.status };
    });
  }

  /** The registrations whose parent is this project, by ID. */
  projectRegistrations(id: ProjectId): RegistrationMapping[] {
    return this.children<RegistrationId>("projects", id);
  }

  /** The remote identities whose parent is this project, by ID. */
  projectRemoteIdentities(id: ProjectId): RemoteIdentityMapping[] {
    return this.children<RemoteIdentityId>("remote_project_identities", id);
  }

  private children<Id extends string>(table: "projects" | "remote_project_identities", id: ProjectId): Array<StoredMapping<Id>> {
    const rows = this.database.prepare(`SELECT id,parent_project_id,incarnation,mapping_version FROM ${table} WHERE parent_project_id=? ORDER BY id LIMIT ?`)
      .all(text(id), PROJECT_DIRECTORY_LIMIT + 1) as MappingRow[];
    if (rows.length > PROJECT_DIRECTORY_LIMIT) throw new Error("Project directory listing exceeds its limit.");
    return rows.map(row => mapping<Id>(row));
  }
}
