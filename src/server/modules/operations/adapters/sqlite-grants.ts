import { isRole, projectId, type AccountId } from "@/shared/contracts/operations";
import { OperationError } from "../errors";
import type { GrantsSnapshot, StoredGrant } from "../grants";
import { absorb, isThenable } from "../synchronous";

/** One stored grant row, as stored. */
export interface StoredGrantRow { readonly role: unknown; readonly scopeKind: unknown; readonly projectId: unknown }

/**
 * Committed accounts and their grants, read synchronously on the controller's
 * owned connection. Structurally the SQLite `AccountGrantsQueries`
 * (`src/server/infrastructure/sqlite/account-grants-queries.ts`): one call
 * reads the account (`remote_principals`) and its stored grants (the step-52
 * table) in one statement, or answers `null` when no account has
 * the ID. This adapter opens nothing itself and validates everything it reads.
 */
export interface AccountGrantsReader {
  accountGrants(accountId: string): { readonly kind: unknown; readonly status: unknown; readonly grants: readonly StoredGrantRow[] } | null;
}

/**
 * The most grants one account may have in a snapshot; a reader answering more
 * is refused (`internal`), never truncated. Equal to the SQLite reader's own
 * bound, which refuses first (a test compares the two).
 */
export const MAX_ACCOUNT_GRANTS = 5 * 1000 + 1;
/**
 * The most accounts one snapshot reads. A decision reads one account; a
 * snapshot asked for more refuses (`internal`) instead of growing or dropping
 * an answer it already gave.
 */
export const MAX_SNAPSHOT_ACCOUNTS = 64;

/** Every principal kind and status the schema allows (`remote_principals`). */
const PRINCIPAL_KINDS: readonly unknown[] = Object.freeze(["owner", "human", "agent", "worker", "installation"]);
const PRINCIPAL_STATUSES: readonly unknown[] = Object.freeze(["active", "revoked"]);

interface Account { readonly kind: "human" | "agent" | null; readonly grants: readonly StoredGrant[] }
const NO_GRANTS: readonly StoredGrant[] = Object.freeze([]);
const UNKNOWN: Account = Object.freeze({ kind: null, grants: NO_GRANTS });

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const invalidAccount = () => new OperationError("internal", "invalid_stored_account");
const invalidGrant = () => new OperationError("internal", "invalid_stored_grant");

/** Data value of an own property, never an accessor and never anything inherited. */
function own(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** A contract project ID, or a refusal: a stored ID the contract cannot carry never becomes a grant. */
function storedProject(value: unknown): ReturnType<typeof projectId> {
  try { return projectId(value); } catch { throw invalidGrant(); }
}

/** One validated, frozen grant of `accountId`. Anything outside the schema's domain is `internal`. */
function grantOf(accountId: AccountId, row: unknown): StoredGrant {
  if (typeof row !== "object" || row === null) throw invalidGrant();
  const role = own(row, "role"), scopeKind = own(row, "scopeKind"), project = own(row, "projectId");
  if (!isRole(role)) throw invalidGrant();
  // The table pairs `admin` with the installation and every other role with a project; anything else is not a stored grant.
  if (scopeKind === "installation" && role === "admin" && project === null) return Object.freeze({ accountId, role, scope: Object.freeze({ kind: "installation" as const }) });
  if (scopeKind === "project" && role !== "admin") return Object.freeze({ accountId, role, scope: Object.freeze({ kind: "project" as const, projectId: storedProject(project) }) });
  throw invalidGrant();
}

/**
 * The account as decisions see it. The stored kind is never a request claim:
 * `owner` is reported as a plain `human` (today's owner principal carries no
 * extra authority in the target model; its authority is its grants), `human`
 * as `human`, `agent` as `agent`. A `worker` or `installation` principal, a
 * revoked account and an unknown ID are `null` and hold no grant, whatever
 * rows remain stored for them. A stored kind or status outside the schema's
 * domain is `internal`, never a permission.
 */
function accountOf(accountId: AccountId, stored: unknown): Account {
  if (stored === null) return UNKNOWN;
  if (typeof stored !== "object") throw invalidAccount();
  const kind = own(stored, "kind"), status = own(stored, "status"), rows = own(stored, "grants");
  if (!PRINCIPAL_KINDS.includes(kind) || !PRINCIPAL_STATUSES.includes(status) || !Array.isArray(rows)) throw invalidAccount();
  if (rows.length > MAX_ACCOUNT_GRANTS) throw new OperationError("internal", "grants_limit_exceeded");
  // Every row is validated, also for an account that holds none of them, so a corrupt row is never silently ignored.
  const grants = Object.freeze(rows.map(row => grantOf(accountId, row)));
  const visibleKind = status !== "active" ? null : kind === "owner" || kind === "human" ? "human" : kind === "agent" ? "agent" : null;
  return visibleKind === null ? UNKNOWN : Object.freeze({ kind: visibleKind, grants });
}

/**
 * One snapshot: each account is read at most once, on its first use, and
 * every later question about it answers from that read. `accountKind` and
 * `grantsFor` of one account therefore always agree, and repeated reads give
 * the same answer. Grants have no expiry and revocation is deletion, so every
 * stored row is an active grant; a deleted grant is never returned because it
 * is not stored. Recipient rules (`grantAllowed`) are left to
 * `effectivePermissions`, which re-validates every grant on every evaluation.
 */
class StoredGrantsSnapshot implements GrantsSnapshot {
  readonly #reader: AccountGrantsReader;
  readonly #accounts = new Map<string, Account>();

  constructor(reader: AccountGrantsReader) { this.#reader = reader; }

  accountKind(accountId: AccountId): "human" | "agent" | null { return this.#account(accountId).kind; }
  grantsFor(accountId: AccountId): readonly StoredGrant[] { return this.#account(accountId).grants; }

  #account(accountId: AccountId): Account {
    // An ID that is not text names no stored account.
    if (!isText(accountId)) return UNKNOWN;
    const known = this.#accounts.get(accountId);
    if (known) return known;
    if (this.#accounts.size >= MAX_SNAPSHOT_ACCOUNTS) throw new OperationError("internal", "grants_snapshot_exhausted");
    let stored: unknown;
    try { stored = this.#reader.accountGrants(accountId); } catch { throw new OperationError("internal", "grants_read_failed"); }
    if (isThenable(stored)) { absorb(stored); throw new OperationError("internal", "grants_not_synchronous"); }
    const account = accountOf(accountId, stored);
    this.#accounts.set(accountId, account);
    return account;
  }
}

/**
 * The `grants` of an `OperationRuntime` over committed SQLite state. Every
 * call is a new snapshot that reads the current committed state; a snapshot
 * never sees a change made after it read an account. Synchronous only.
 */
export function sqliteGrants(reader: AccountGrantsReader): () => GrantsSnapshot {
  if (typeof reader?.accountGrants !== "function") throw new TypeError("Invalid account grants reader.");
  return () => new StoredGrantsSnapshot(reader);
}
