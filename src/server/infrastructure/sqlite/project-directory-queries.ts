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
 * each registration and remote identity belongs to. The store exposes the
 * registration and project reads as a structural port; the resolver adapter
 * remains unmounted. A guard confines production imports to the store.
 * It borrows the owner's connection, as the other query modules
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

/** The most registrations the catalog reads in one call; more is refused, never truncated. */
export const PROJECT_CATALOG_REGISTRATION_LIMIT = 5000;

/** A Knowledge project with its safe metadata, as stored. */
export interface CatalogProjectRow {
  readonly id: unknown;
  readonly name: unknown;
  readonly status: unknown;
  readonly revision: unknown;
}
/** A registration with the facts the project reads release, as stored. */
export interface CatalogRegistrationRow {
  readonly id: unknown;
  readonly projectId: unknown;
  readonly mappingVersion: unknown;
  readonly name: unknown;
  readonly repositoryPath: unknown;
  readonly port: unknown;
  readonly launchPreset: unknown;
  readonly executable: unknown;
  readonly argsJson: unknown;
  readonly selectedWorktreePath: unknown;
  /** The active claim's holder identity, or null. Never its reason, owner, times, lease token or credential. */
  readonly claim: {
    readonly kind: unknown;
    readonly principalId: unknown;
  } | null;
}

type CatalogRegistrationSql = {
  id: unknown; parent_project_id: unknown; mapping_version: unknown; name: unknown; repository_path: unknown; port: unknown;
  launch_preset: unknown; executable: unknown; args_json: unknown; selected_worktree_path: unknown;
  claim_id: unknown; claim_kind: unknown; claim_principal: unknown;
};

/*
 * A registration's active claim, read without writing. It mirrors the expiry
 * that `SqliteStateStore.expireReservations` applies before every claim read
 * (an agent claim past `expires_at`, a provider-bound human claim without a live
 * lease), so a claim that the next write would expire is never reported as
 * held. Nothing here releases it: a read never writes.
 */
const ACTIVE_CLAIM = `r.released_at IS NULL
  AND NOT (r.expires_at IS NOT NULL AND r.expires_at <= @now)
  AND NOT (r.provider_bound=1 AND NOT EXISTS (SELECT 1 FROM human_runtime_leases h WHERE h.reservation_id=r.id AND h.expires_at>@now))`;

/**
 * Read-only facts for the operations module's project reads (`project.list`,
 * `project.status`, `project.worktrees`): Knowledge projects with their safe
 * metadata, and registrations with their placement and active claim. It
 * borrows the owner's connection, never writes (expiry is applied in the
 * predicate, not stored), and returns storage facts that its reader validates.
 * Its construction checks step 51, whose parent and mapping version columns it reads.
 */
export class ProjectCatalogQueries {
  constructor(private readonly database: Database.Database) {
    schemaTarget(PROJECT_MAPPING_VERSION);
  }

  /** Every project, archived ones included, by ID. Throws above {@link PROJECT_LIST_LIMIT}. */
  projects(): CatalogProjectRow[] {
    const rows = this.database.prepare("SELECT id,name,status,revision FROM knowledge_projects ORDER BY id LIMIT ?")
      .all(PROJECT_LIST_LIMIT + 1) as CatalogProjectRow[];
    if (rows.length > PROJECT_LIST_LIMIT) throw new Error("Project listing exceeds its limit.");
    return rows;
  }

  /** The project with this ID, or null. */
  project(id: string): CatalogProjectRow | null {
    return (this.database.prepare("SELECT id,name,status,revision FROM knowledge_projects WHERE id=?").get(text(id)) as CatalogProjectRow | undefined) ?? null;
  }

  /**
   * Every registration, parentless ones included, by ID; or only the children
   * of `projectId`. One statement, so placement and claims are one read.
   * Throws above {@link PROJECT_CATALOG_REGISTRATION_LIMIT}.
   */
  registrations(now: string, projectId?: string): CatalogRegistrationRow[] {
    const where = projectId === undefined ? "" : "WHERE p.parent_project_id=@project";
    const rows = this.database.prepare(`SELECT p.id,p.parent_project_id,p.mapping_version,p.name,p.repository_path,p.port,p.launch_preset,
        p.executable,p.args_json,p.selected_worktree_path,
        c.id AS claim_id,c.kind AS claim_kind,c.principal_id AS claim_principal
      FROM projects p LEFT JOIN (SELECT r.id,r.project_id,r.kind,r.principal_id FROM reservations r WHERE ${ACTIVE_CLAIM}) c ON c.project_id=p.id
      ${where} ORDER BY p.id LIMIT @limit`)
      .all({ now: text(now), limit: PROJECT_CATALOG_REGISTRATION_LIMIT + 1, ...(projectId === undefined ? {} : { project: text(projectId) }) }) as CatalogRegistrationSql[];
    if (rows.length > PROJECT_CATALOG_REGISTRATION_LIMIT) throw new Error("Registration catalog exceeds its limit.");
    // At most one unreleased claim per project is an invariant of acquisition; a second row is corruption.
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("A registration has more than one active claim.");
    return rows.map(row => ({
      id: row.id, projectId: row.parent_project_id, mappingVersion: row.mapping_version, name: row.name, repositoryPath: row.repository_path,
      port: row.port, launchPreset: row.launch_preset, executable: row.executable, argsJson: row.args_json, selectedWorktreePath: row.selected_worktree_path,
      claim: row.claim_id === null ? null : { kind: row.claim_kind, principalId: row.claim_principal },
    }));
  }
}
