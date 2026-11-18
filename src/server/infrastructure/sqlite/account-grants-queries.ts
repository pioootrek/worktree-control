import type Database from "better-sqlite3";
import { schemaTarget } from "./migration-registry";
import { ACCOUNT_GRANTS_VERSION } from "./account-grants-migration";

/**
 * The most grant rows one account's read returns; more is refused, never
 * truncated. Five project roles on each of the projects one listing of the
 * project directory may return (`PROJECT_LIST_LIMIT`), plus the installation
 * role: no installation whose projects can be listed reaches it.
 */
export const ACCOUNT_GRANTS_READ_LIMIT = 5 * 1000 + 1;

/** One stored grant row, as stored. */
export interface StoredGrantRow { readonly role: unknown; readonly scopeKind: unknown; readonly projectId: unknown }
/** A stored account (`remote_principals`) and its stored grants (step 52), read together. */
export interface StoredAccountGrants {
  readonly kind: unknown;
  readonly status: unknown;
  readonly grants: readonly StoredGrantRow[];
}

type Row = { kind: unknown; status: unknown; role: unknown; scope_kind: unknown; project_id: unknown };

/**
 * Read-only view of one account and its step-52 grants, exposed by the store
 * as a structural read port. The operations adapter remains unmounted. A guard
 * confines production imports to the store. It borrows the owner's connection, as the other query
 * modules do, and never owns the database lifecycle. Its construction checks
 * step 52 against the supported version.
 *
 * It returns storage facts only, unvalidated beyond their presence: the
 * principal's kind and status and every grant row of that principal, in
 * insertion order. Revocation of a grant is deletion, so every row it returns
 * is a stored, active grant; whether the account may use it (kind, status,
 * role, recipient) is decided by the reader of these facts.
 */
export class AccountGrantsQueries {
  constructor(private readonly database: Database.Database) {
    schemaTarget(ACCOUNT_GRANTS_VERSION);
  }

  /**
   * The account with this ID and its grants, or null when no principal has
   * this ID. One statement, so the account and its grants are one consistent
   * read. Throws above {@link ACCOUNT_GRANTS_READ_LIMIT} grants.
   */
  accountGrants(accountId: string): StoredAccountGrants | null {
    if (typeof accountId !== "string") throw new Error("Malformed account ID.");
    const rows = this.database.prepare(`SELECT p.kind AS kind,p.status AS status,g.role AS role,g.scope_kind AS scope_kind,g.project_id AS project_id
      FROM remote_principals p LEFT JOIN account_grants g ON g.account_id=p.id WHERE p.id=? ORDER BY g.rowid LIMIT ?`)
      .all(accountId, ACCOUNT_GRANTS_READ_LIMIT + 1) as Row[];
    if (rows.length === 0) return null;
    if (rows.length > ACCOUNT_GRANTS_READ_LIMIT) throw new Error("Account grants exceed their read limit.");
    const [first] = rows;
    // Without a grant, the LEFT JOIN gives one row whose grant columns are NULL (`role` is NOT NULL in the table).
    const grants = first.role === null ? [] : rows.map(row => ({ role: row.role, scopeKind: row.scope_kind, projectId: row.project_id }));
    return { kind: first.kind, status: first.status, grants };
  }
}
