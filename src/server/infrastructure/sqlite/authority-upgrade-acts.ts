import type Database from "better-sqlite3";
import { z } from "zod";
import { schemaTarget } from "./migration-registry";
import { ACCOUNT_GRANTS_VERSION } from "./account-grants-migration";
import {
  CANCELLED_ATTEMPT_PHASES, CANCELLED_REQUEST_PHASES, cancelRemoteWork, CREDENTIAL_KINDS, interruptTestRuns, INTERRUPTED_RUN_PHASES, OLD_GRANT_TABLES,
  releaseReservations, REVISED_GRANT_TABLES, revokeCredentials, revokeOldGrants, type OldGrantTable,
} from "./authority-reset";
import { recoveryTrimmedRuns } from "./test-run-queries";
import {
  compareText, escapeDisplay, FindingList, UPGRADE_FINDINGS_LIMIT, UpgradeError,
  type UpgradeAct, type UpgradeActContext, type UpgradeActDomain, type UpgradeActKind, type UpgradeProposalContext,
} from "./upgrade-contract";

/**
 * The authority acts of the explicit offline upgrade (integration branch,
 * provisional, from target 52 on, not registered anywhere outside the
 * upgrade): the one-way reset of the old authorization model and the first
 * grant of the new one. The rules are in `docs/architecture.md` ("Authority
 * acts").
 *
 * The acts run after every mapping act, in this order:
 * 1. `revoke_old_grants`: the six old tables with a revocation column are
 *    revoked in place, exactly as the quarantine revokes them;
 *    `runtime_credential_scopes` (no revocation column) stays as inert rows.
 * 2. `revoke_credentials`: every agent token, worker token and owner-session
 *    credential (every kind `principal_credentials` allows) is revoked and
 *    cannot be revived.
 * 3. `release_running_work`: every active claim is released, pending and
 *    assigned remote requests and their live attempts are cancelled, and
 *    queued and running test runs are interrupted, exactly as the quarantine
 *    does. Attribution and history stay. This invalidates the work logically;
 *    it does not prove that a remote process stopped.
 * 4. `grant_admin`: one `admin` grant on the installation for the owner, only
 *    when exactly one principal of kind `owner` exists and it is active;
 *    otherwise there is no such act and no account holds `admin` afterwards.
 *
 * Kept: the installation token and the authentication mode
 * (`controller_settings`), accounts, passwords, factors and every table of
 * the authentication provider, and history. No Vault ciphertext is read.
 *
 * The domain has no operator decisions. The reset acts have fixed payloads
 * and the admin act names the account, so the plan hash binds what happens
 * without listing every row; the row effects are bound by the review's counts
 * under the same hash and the plan's base preflight, and the whole-plan
 * validation recomputes the review (before the backup and inside the
 * transaction) and refuses any difference.
 */

function gate(): void {
  try { schemaTarget(ACCOUNT_GRANTS_VERSION); } catch { throw new UpgradeError("upgrade_unsupported", "none"); }
}
/** The ID rule of `account_grants.account_id` (see account-grants-migration.ts). */
function grantId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000") && Buffer.byteLength(value, "utf8") <= 640 && [...value].length <= 160;
}
/**
 * The most principals of kind `owner` the review lists; more is refused, never
 * truncated. It is the security fence's own bound on owners (more than 64 make
 * its owner identity refuse), so through the protocol the fence refuses first.
 */
export const AUTHORITY_OWNER_LIMIT = 64;
const PRINCIPAL_KINDS = ["owner", "human", "agent", "worker", "installation"] as const;
const PRINCIPAL_STATUSES = ["active", "revoked"] as const;
const REQUEST_PHASES = ["pending", "assigned", "completed", "cancelled"] as const;
const ATTEMPT_PHASES = ["assigned", "preparing", "running", "succeeded", "failed", "cancel_requested", "cancelled", "uncertain"] as const;

// ---------------------------------------------------------------------------
// Decisions: none

const decisionsSchema = z.object({}).strict();
export type AuthorityDecisions = Record<string, never>;
/** The domain takes no decision: any key is refused as `upgrade_decisions_invalid`. */
export function normaliseAuthorityDecisions(input: Record<string, unknown>): AuthorityDecisions {
  gate();
  const refused = new FindingList();
  for (const key of Object.keys(input ?? {})) refused.add("decisions", key, "the authority acts take no decision");
  refused.raise("upgrade_decisions_invalid");
  if (!decisionsSchema.safeParse(input ?? {}).success) throw new UpgradeError("upgrade_decisions_invalid", "upgrade inspect");
  return {};
}

// ---------------------------------------------------------------------------
// Acts

export const REVOKE_OLD_GRANTS = "revoke_old_grants", REVOKE_CREDENTIALS = "revoke_credentials", RELEASE_RUNNING_WORK = "release_running_work", GRANT_ADMIN = "grant_admin";
const tuple = <T extends readonly string[]>(values: T) => z.tuple(values.map(value => z.literal(value)) as unknown as [z.ZodLiteral<T[number]>, ...z.ZodLiteral<T[number]>[]]);
const revokeGrantsPayload = z.object({ tables: tuple(OLD_GRANT_TABLES) }).strict();
const revokeCredentialsPayload = z.object({ kinds: tuple(CREDENTIAL_KINDS) }).strict();
const releasePayload = z.object({
  reservations: z.literal("release_active"), remoteRequests: tuple(CANCELLED_REQUEST_PHASES), remoteAttempts: tuple(CANCELLED_ATTEMPT_PHASES), testRuns: tuple(INTERRUPTED_RUN_PHASES),
}).strict();
const grantAdminPayload = z.object({ accountId: z.string().refine(grantId) }).strict();
export type GrantAdminPayload = z.infer<typeof grantAdminPayload>;
/** The fixed payloads of the reset acts. */
export const RESET_PAYLOADS = Object.freeze({
  [REVOKE_OLD_GRANTS]: Object.freeze({ tables: [...OLD_GRANT_TABLES] }),
  [REVOKE_CREDENTIALS]: Object.freeze({ kinds: [...CREDENTIAL_KINDS] }),
  [RELEASE_RUNNING_WORK]: Object.freeze({ reservations: "release_active", remoteRequests: [...CANCELLED_REQUEST_PHASES], remoteAttempts: [...CANCELLED_ATTEMPT_PHASES], testRuns: [...INTERRUPTED_RUN_PHASES] }),
});

/** A precondition or postcondition of an act that does not hold: the transaction aborts. The message carries no value. */
function actFailed(kind: string): never { throw new Error(`Upgrade act ${kind} found the database other than its plan requires.`); }
const present = (database: Database.Database, sql: string, ...parameters: unknown[]) => Boolean(database.prepare(sql).get(...parameters));

/** The owners as the admin rule sees them: every principal of kind `owner`, by ID. */
function owners(database: Database.Database): Array<{ id: unknown; status: unknown }> {
  return database.prepare(`SELECT id,status FROM remote_principals WHERE kind='owner' ORDER BY id LIMIT ${AUTHORITY_OWNER_LIMIT + 1}`).all() as Array<{ id: unknown; status: unknown }>;
}

function executeRevokeOldGrants(database: Database.Database, context: UpgradeActContext): void {
  gate();
  revokeOldGrants(database, context.at);
  for (const table of OLD_GRANT_TABLES) if (present(database, `SELECT 1 FROM ${table} WHERE revoked_at IS NULL LIMIT 1`)) actFailed(REVOKE_OLD_GRANTS);
}
function executeRevokeCredentials(database: Database.Database, context: UpgradeActContext): void {
  gate();
  revokeCredentials(database, context.at);
  if (present(database, "SELECT 1 FROM principal_credentials WHERE status IS NOT 'revoked' OR revoked_at IS NULL LIMIT 1")) actFailed(REVOKE_CREDENTIALS);
}
function executeReleaseRunningWork(database: Database.Database, context: UpgradeActContext): void {
  gate();
  releaseReservations(database, context.at);
  cancelRemoteWork(database, context.at);
  interruptTestRuns(database);
  if (present(database, "SELECT 1 FROM reservations WHERE released_at IS NULL LIMIT 1")
    || present(database, "SELECT 1 FROM remote_verification_requests WHERE phase IN ('pending','assigned') LIMIT 1")
    || present(database, "SELECT 1 FROM remote_verification_attempts WHERE phase IN ('assigned','preparing','running') LIMIT 1")
    || present(database, "SELECT 1 FROM test_runs WHERE phase IN ('queued','running') LIMIT 1")) actFailed(RELEASE_RUNNING_WORK);
}
/**
 * `grant_admin`: re-checks the rule at execution (exactly one owner, active,
 * the account the plan names, and no grant stored yet), then writes the one
 * installation grant with the run's time.
 */
function executeGrantAdmin(database: Database.Database, payload: GrantAdminPayload, context: UpgradeActContext): void {
  gate();
  const rows = owners(database);
  if (rows.length !== 1 || rows[0].id !== payload.accountId || rows[0].status !== "active") actFailed(GRANT_ADMIN);
  if (present(database, "SELECT 1 FROM account_grants LIMIT 1")) actFailed(GRANT_ADMIN);
  if (database.prepare("INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES(?,'admin','installation',NULL,?)").run(payload.accountId, context.at).changes !== 1) actFailed(GRANT_ADMIN);
}

const kinds: ReadonlyArray<UpgradeActKind> = Object.freeze([
  { kind: REVOKE_OLD_GRANTS, payload: revokeGrantsPayload, execute: (database, _payload, context) => executeRevokeOldGrants(database, context) },
  { kind: REVOKE_CREDENTIALS, payload: revokeCredentialsPayload, execute: (database, _payload, context) => executeRevokeCredentials(database, context) },
  { kind: RELEASE_RUNNING_WORK, payload: releasePayload, execute: (database, _payload, context) => executeReleaseRunningWork(database, context) },
  { kind: GRANT_ADMIN, payload: grantAdminPayload, execute: (database, payload, context) => executeGrantAdmin(database, payload as GrantAdminPayload, context) },
] as UpgradeActKind[]);

// ---------------------------------------------------------------------------
// Review

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const byPhase = <T extends readonly string[]>(phases: T) => z.object(Object.fromEntries(phases.map(phase => [phase, count]))).strict() as unknown as z.ZodType<Record<T[number], number>>;
const credentialStatus = z.object({ active: count, revoked: count, missing: count }).strict();
const reviewSchema = z.object({
  /** Each old grant table, in the act's order: rows, rows already revoked (kept as they are), rows this plan revokes, and whether revision and `updated_at` advance on every row. */
  grantTables: z.array(z.object({ table: z.enum(OLD_GRANT_TABLES), rows: count, alreadyRevoked: count, revokes: count, revisionAdvances: z.boolean() }).strict()),
  /** `runtime_credential_scopes`: every row stays as an inert row; the distinct credentials it names, by stored status before and after the plan. */
  credentialScopes: z.object({ rows: count, inert: count, credentials: z.object({ before: credentialStatus, after: credentialStatus }).strict() }).strict(),
  /** Credentials by kind: active ones are revoked by this plan; revoked ones keep their time (one without a time gets the run's). */
  credentials: z.array(z.object({ kind: z.enum(CREDENTIAL_KINDS), active: count, revoked: count, revokedWithoutTime: count, revokes: count }).strict()),
  reservations: z.object({ active: count, released: count, releases: count }).strict(),
  remoteRequests: z.object({ phases: byPhase(REQUEST_PHASES), cancels: count }).strict(),
  remoteAttempts: z.object({ phases: byPhase(ATTEMPT_PHASES), cancels: count }).strict(),
  /** Runs interrupted (queued, running, and others whose summary is not terminal) and the history trimming that follows. */
  testRuns: z.object({ queued: count, running: count, unfinishedSummaries: count, interrupts: count, trimmed: count }).strict(),
  owners: z.array(z.object({ id: z.string(), status: z.enum(PRINCIPAL_STATUSES) }).strict()),
  admin: z.union([
    z.object({ decision: z.literal("grant"), accountId: z.string().refine(grantId) }).strict(),
    z.object({ decision: z.literal("none"), reason: z.enum(["no_owner", "owner_not_active", "several_owners"]) }).strict(),
  ]),
}).strict();
export type AuthorityReview = z.infer<typeof reviewSchema>;
export type AdminDecision = AuthorityReview["admin"];

// ---------------------------------------------------------------------------
// Stored values

type StorageRule = "text" | "text_or_null" | "integer";
interface StoredColumns { readonly table: string; readonly key: string; readonly columns: ReadonlyArray<readonly [column: string, rule: StorageRule]> }
const grantColumns = (table: OldGrantTable): StoredColumns => ({
  table, key: table === "remote_worker_project_grants" ? "worker_id" : "principal_id",
  columns: [[table === "remote_worker_project_grants" ? "worker_id" : "principal_id", "text"], ["project_id", "text"], ["revoked_at", "text_or_null"],
    ...(REVISED_GRANT_TABLES.includes(table) ? [["revision", "integer"] as const] : [])],
});
/**
 * Every column the authority pass reads, with the storage class it must hold
 * (SQLite's `typeof()`); the tables are not STRICT. Any other class is
 * refused as `upgrade_authority_malformed` before a value is used.
 */
export const AUTHORITY_STORED_COLUMNS: ReadonlyArray<StoredColumns> = Object.freeze([
  { table: "remote_principals", key: "id", columns: [["id", "text"], ["kind", "text"], ["status", "text"]] },
  { table: "principal_credentials", key: "id", columns: [["id", "text"], ["kind", "text"], ["status", "text"], ["revoked_at", "text_or_null"]] },
  ...OLD_GRANT_TABLES.map(grantColumns),
  { table: "runtime_credential_scopes", key: "credential_id", columns: [["credential_id", "text"], ["project_id", "text"]] },
  { table: "reservations", key: "id", columns: [["id", "text"], ["released_at", "text_or_null"]] },
  { table: "remote_verification_requests", key: "id", columns: [["id", "text"], ["phase", "text"]] },
  { table: "remote_verification_attempts", key: "id", columns: [["id", "text"], ["phase", "text"], ["version", "integer"]] },
  { table: "test_runs", key: "id", columns: [["id", "text"], ["project_id", "text"], ["phase", "text"], ["queued_at", "text"]] },
  { table: "test_run_summaries", key: "run_id", columns: [["run_id", "text"], ["terminal", "integer"]] },
] as StoredColumns[]);
const RULE_TEXT: Readonly<Record<StorageRule, string>> = { text: "text", text_or_null: "text or null", integer: "integer" };
const holds = (type: unknown, rule: StorageRule) => rule === "text" ? type === "text" : rule === "integer" ? type === "integer" : type === "text" || type === "null";
const holdsSql = (column: string, rule: StorageRule) => rule === "text_or_null" ? `typeof("${column}") IN ('text','null')` : `typeof("${column}")='${rule}'`;
const keyText = (key: string) => `CASE typeof("${key}") WHEN 'text' THEN "${key}" WHEN 'integer' THEN CAST("${key}" AS TEXT) ELSE '<' || typeof("${key}") || '>' END`;

/** Adds a finding for every row whose value is of another storage class (the first 100 per table read, all counted). */
function storageClasses(database: Database.Database, findings: FindingList): void {
  for (const entry of AUTHORITY_STORED_COLUMNS) {
    const where = `NOT (${entry.columns.map(([column, rule]) => holdsSql(column, rule)).join(" AND ")})`;
    const rows = database.prepare(`SELECT ${keyText(entry.key)},${entry.columns.map(([column]) => `typeof("${column}")`).join(",")} FROM "${entry.table}" WHERE ${where} LIMIT ${UPGRADE_FINDINGS_LIMIT}`).raw().all() as unknown[][];
    for (const row of rows) {
      findings.add(entry.table, String(row[0]), entry.columns.flatMap(([column, rule], index) => holds(row[index + 1], rule) ? [] : [`${column} is ${String(row[index + 1])}, expected ${RULE_TEXT[rule]}`]).join("; "));
    }
    if (rows.length === UPGRADE_FINDINGS_LIMIT) findings.more((database.prepare(`SELECT count(*) FROM "${entry.table}" WHERE ${where}`).pluck().get() as number) - rows.length);
  }
}
/** Adds a finding for each row a query selects (bounded), naming it by its first column. */
function rowsOf(database: Database.Database, table: string, sql: string, problem: string, findings: FindingList): void {
  const rows = database.prepare(`${sql} LIMIT ${UPGRADE_FINDINGS_LIMIT + 1}`).pluck().all() as unknown[];
  for (const id of rows.slice(0, UPGRADE_FINDINGS_LIMIT)) findings.add(table, escapeDisplay(id) ?? `<${typeof id}>`, problem);
  if (rows.length > UPGRADE_FINDINGS_LIMIT) findings.more((database.prepare(`SELECT count(*) FROM (${sql})`).pluck().get() as number) - UPGRADE_FINDINGS_LIMIT);
}

// ---------------------------------------------------------------------------
// The proposal pass

const number = (database: Database.Database, sql: string) => Number(database.prepare(sql).pluck().get() ?? 0);
const INTERRUPTED = `phase IN ('queued','running') OR id IN (SELECT run_id FROM test_run_summaries WHERE terminal=0)`;

/**
 * The single proposal pass: the four acts (or three, without `grant_admin`)
 * and the review. It reads only tables that exist at schema 49, plus
 * `account_grants` from 52 on (absent at the source, read as empty), and
 * gives the same result at the source and inside the schema transaction
 * before the first act. It writes nothing and reads no secret, token hash,
 * stored JSON content or Vault ciphertext into the plan. A stop is an
 * `UpgradeError` with the offending rows, bounded.
 */
export function proposeAuthority(database: Database.Database, context: UpgradeProposalContext, decisions: AuthorityDecisions,
  _prior: readonly UpgradeAct[] | null, _fresh: boolean): { acts: UpgradeAct[]; review: AuthorityReview } {
  gate();
  void decisions; void _prior; void _fresh;
  // 0. Storage classes of every value read below, before any is used.
  const storage = new FindingList();
  storageClasses(database, storage);
  storage.raise("upgrade_authority_malformed");

  // 1. Values the acts depend on: known principal kinds and statuses, known
  //    credential kinds and statuses, revisions and versions that can advance,
  //    and stored JSON the test-run recovery parses for every run it interrupts.
  const malformed = new FindingList();
  rowsOf(database, "remote_principals", `SELECT id FROM remote_principals WHERE kind NOT IN (${PRINCIPAL_KINDS.map(kind => `'${kind}'`).join(",")}) OR status NOT IN ('active','revoked') ORDER BY id`,
    "a principal of unknown kind or status", malformed);
  rowsOf(database, "principal_credentials", `SELECT id FROM principal_credentials WHERE kind NOT IN (${CREDENTIAL_KINDS.map(kind => `'${kind}'`).join(",")}) OR status NOT IN ('active','revoked') ORDER BY id`,
    "a credential of unknown kind or status", malformed);
  for (const table of REVISED_GRANT_TABLES) {
    rowsOf(database, table, `SELECT principal_id FROM ${table} WHERE revision NOT BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER - 1} ORDER BY principal_id,project_id`, "a revision that cannot advance", malformed);
  }
  rowsOf(database, "remote_verification_attempts", `SELECT id FROM remote_verification_attempts WHERE phase IN ('assigned','preparing','running') AND version NOT BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER - 1} ORDER BY id`,
    "a version that cannot advance", malformed);
  const json = (column: string, nullable = false) => `${nullable ? `${column} IS NOT NULL AND ` : ""}(typeof(${column})<>'text' OR NOT json_valid(${column}))`;
  rowsOf(database, "test_runs", `SELECT id FROM test_runs WHERE (${INTERRUPTED}) AND (${json("args_json")} OR ${json("logs_json")} OR ${json("environment_variable_names_json")}
    OR ${json("source_json", true)} OR ${json("telemetry_json", true)}) ORDER BY id`, "a run to be interrupted holds stored JSON the recovery cannot read", malformed);
  malformed.raise("upgrade_authority_malformed");

  // 2. Grants of the new model while the upgrade is needed: a quarantine deletes every one.
  if (context.schemaVersion >= ACCOUNT_GRANTS_VERSION) {
    const unexpected = new FindingList();
    rowsOf(database, "account_grants", "SELECT account_id FROM account_grants ORDER BY rowid", "a grant is stored although the upgrade is needed", unexpected);
    unexpected.raise("upgrade_authority_unexpected");
  }

  // 3. Bounds: the owners the review lists.
  const ownerRows = owners(database);
  if (ownerRows.length > AUTHORITY_OWNER_LIMIT) {
    const bounds = new FindingList();
    bounds.add("remote_principals", "owner", `more than ${AUTHORITY_OWNER_LIMIT} principals of kind owner`);
    bounds.raise("upgrade_plan_bounds");
  }

  // 4. The review.
  const grantTables = OLD_GRANT_TABLES.map(table => {
    const [rows, revoked] = database.prepare(`SELECT count(*),count(revoked_at) FROM ${table}`).raw().get() as [number, number];
    return { table, rows, alreadyRevoked: revoked, revokes: rows - revoked, revisionAdvances: REVISED_GRANT_TABLES.includes(table) };
  });
  const [scopeRows, active, revoked, missing] = database.prepare(`SELECT (SELECT count(*) FROM runtime_credential_scopes),
      count(CASE WHEN c.status='active' THEN 1 END),count(CASE WHEN c.status='revoked' THEN 1 END),count(CASE WHEN c.id IS NULL THEN 1 END)
    FROM (SELECT DISTINCT credential_id FROM runtime_credential_scopes) s LEFT JOIN principal_credentials c ON c.id=s.credential_id`).raw().get() as number[];
  const credentialScopes = { rows: scopeRows, inert: scopeRows, credentials: { before: { active, revoked, missing }, after: { active: 0, revoked: active + revoked, missing } } };
  const credentials = CREDENTIAL_KINDS.map(kind => {
    const [activeOf, revokedOf, withoutTime] = database.prepare(`SELECT count(CASE WHEN status='active' THEN 1 END),count(CASE WHEN status='revoked' THEN 1 END),
      count(CASE WHEN status='revoked' AND revoked_at IS NULL THEN 1 END) FROM principal_credentials WHERE kind=?`).raw().get(kind) as number[];
    return { kind, active: activeOf, revoked: revokedOf, revokedWithoutTime: withoutTime, revokes: activeOf };
  });
  const [activeReservations, releasedReservations] = database.prepare("SELECT count(CASE WHEN released_at IS NULL THEN 1 END),count(released_at) FROM reservations").raw().get() as number[];
  const phases = <T extends readonly string[]>(table: string, all: T) => {
    const found = new Map((database.prepare(`SELECT phase,count(*) FROM ${table} GROUP BY phase`).raw().all() as Array<[string, number]>));
    return Object.fromEntries(all.map(phase => [phase, found.get(phase) ?? 0])) as Record<T[number], number>;
  };
  const requestPhases = phases("remote_verification_requests", REQUEST_PHASES), attemptPhases = phases("remote_verification_attempts", ATTEMPT_PHASES);
  const queued = number(database, "SELECT count(*) FROM test_runs WHERE phase='queued'"), running = number(database, "SELECT count(*) FROM test_runs WHERE phase='running'");
  const interrupts = number(database, `SELECT count(*) FROM test_runs WHERE ${INTERRUPTED}`);
  // Kinds, statuses and storage classes were checked above: every owner has a text ID and a known status.
  const ownerList = ownerRows.map(row => ({ id: row.id as string, status: row.status as "active" | "revoked" })).sort((a, b) => compareText(a.id, b.id));
  if (ownerList.length === 1 && ownerList[0].status === "active" && !grantId(ownerList[0].id)) {
    // The owner's ID cannot be stored as a grant's account: a stop, never a silently skipped grant.
    const refused = new FindingList();
    refused.add("remote_principals", ownerList[0].id, "the owner's ID is not a bounded grant account ID");
    refused.raise("upgrade_authority_malformed");
  }
  const admin: AdminDecision = ownerList.length === 0 ? { decision: "none", reason: "no_owner" }
    : ownerList.length > 1 ? { decision: "none", reason: "several_owners" }
      : ownerList[0].status !== "active" ? { decision: "none", reason: "owner_not_active" }
        : { decision: "grant", accountId: ownerList[0].id };
  const review: AuthorityReview = {
    grantTables, credentialScopes, credentials,
    reservations: { active: activeReservations, released: releasedReservations, releases: activeReservations },
    remoteRequests: { phases: requestPhases, cancels: CANCELLED_REQUEST_PHASES.reduce((sum, phase) => sum + requestPhases[phase], 0) },
    remoteAttempts: { phases: attemptPhases, cancels: CANCELLED_ATTEMPT_PHASES.reduce((sum, phase) => sum + attemptPhases[phase], 0) },
    testRuns: { queued, running, unfinishedSummaries: interrupts - queued - running, interrupts, trimmed: recoveryTrimmedRuns(database) },
    owners: ownerList,
    admin,
  };

  // 5. The acts, in their fixed order.
  const acts: UpgradeAct[] = [
    { kind: REVOKE_OLD_GRANTS, payload: { tables: [...OLD_GRANT_TABLES] } },
    { kind: REVOKE_CREDENTIALS, payload: { kinds: [...CREDENTIAL_KINDS] } },
    { kind: RELEASE_RUNNING_WORK, payload: { reservations: "release_active", remoteRequests: [...CANCELLED_REQUEST_PHASES], remoteAttempts: [...CANCELLED_ATTEMPT_PHASES], testRuns: [...INTERRUPTED_RUN_PHASES] } },
  ];
  if (admin.decision === "grant") acts.push({ kind: GRANT_ADMIN, payload: { accountId: admin.accountId } });
  return { acts, review };
}

// ---------------------------------------------------------------------------
// The operator's lines

const ident = (value: string) => escapeDisplay(value) ?? "";
const REASONS: Readonly<Record<Extract<AdminDecision, { decision: "none" }>["reason"], string>> = {
  no_owner: "no principal of kind owner exists", owner_not_active: "the only owner principal is not active", several_owners: "more than one principal of kind owner exists",
};
const LABELS: Readonly<Record<string, string>> = { agent_token: "agent tokens", owner_session: "owner-session credentials", worker_token: "worker tokens" };
/** What the upgrade keeps, stated in every plan. */
export const AUTHORITY_KEPT = "Kept unchanged: the installation token, the authentication mode, accounts, passwords, factors and history.";

/** The operator's lines for the authority acts and their review. */
export function describeAuthority(acts: readonly UpgradeAct[], review: AuthorityReview): string[] {
  const lines = [
    "This upgrade is one-way: it revokes every right and credential of the old authorization model, and nothing revoked here can be revived.",
  ];
  if (acts.some(act => act.kind === REVOKE_OLD_GRANTS)) {
    for (const table of review.grantTables) {
      lines.push(`Revoke ${table.table}: ${table.rows} row(s), ${table.alreadyRevoked} already revoked (kept as they are), ${table.revokes} revoked by this plan${table.revisionAdvances ? "; every row's revision advances" : ""}.`);
    }
    const scopes = review.credentialScopes;
    lines.push(`Credential scopes: ${scopes.rows} row(s) stay as inert rows; they name ${scopes.credentials.before.active + scopes.credentials.before.revoked + scopes.credentials.before.missing} credential(s) (before: ${scopes.credentials.before.active} active, ${scopes.credentials.before.revoked} revoked; after: ${scopes.credentials.after.active} active, ${scopes.credentials.after.revoked} revoked).`);
  }
  if (acts.some(act => act.kind === REVOKE_CREDENTIALS)) {
    for (const entry of review.credentials) {
      lines.push(`Revoke every one of the ${LABELS[entry.kind]}: ${entry.active} active, revoked by this plan; ${entry.revoked} already revoked${entry.revokedWithoutTime ? ` (${entry.revokedWithoutTime} without a revocation time, which this plan sets)` : ""}.`);
    }
    lines.push("Every listed token stops working: agents, workers and owner sessions must be issued new credentials.");
  }
  if (acts.some(act => act.kind === RELEASE_RUNNING_WORK)) {
    const requests = review.remoteRequests, attempts = review.remoteAttempts, runs = review.testRuns;
    lines.push(`Running work is interrupted: ${review.reservations.releases} active claim(s) or reservation(s) released (${review.reservations.released} already released); ${requests.cancels} remote request(s) cancelled (pending ${requests.phases.pending}, assigned ${requests.phases.assigned}); ${attempts.cancels} remote attempt(s) set to cancel_requested (assigned ${attempts.phases.assigned}, preparing ${attempts.phases.preparing}, running ${attempts.phases.running}).`);
    lines.push(`Test runs: ${runs.interrupts} interrupted (${runs.queued} queued, ${runs.running} running, ${runs.unfinishedSummaries} with an unfinished summary); history trimming then deletes ${runs.trimmed} old run(s).`);
    lines.push("Attribution and history stay. Interrupting work here does not prove that a remote process stopped.");
  }
  lines.push(`Owner principals: ${review.owners.length === 0 ? "none" : review.owners.map(owner => `${ident(owner.id)} (${owner.status})`).join(", ")}.`);
  if (review.admin.decision === "grant") lines.push(`Grant admin on the installation to owner account ${ident(review.admin.accountId)}.`);
  else lines.push(`No account will hold admin after the upgrade: ${REASONS[review.admin.reason]}. The first admin is created later by the local operator.`);
  lines.push("Rights must be granted again: no old grant, role binding, delegation, membership or worker binding is carried over or rebuilt.");
  lines.push(AUTHORITY_KEPT);
  return lines;
}

/** The authority domain of the upgrade: from target 52 on, after the mapping domain, with no decision keys. */
export const AUTHORITY_ACT_DOMAIN: UpgradeActDomain<AuthorityDecisions, AuthorityReview> = Object.freeze({
  name: "authority",
  minimumTarget: ACCOUNT_GRANTS_VERSION,
  decisionKeys: Object.freeze([] as string[]),
  decisions: decisionsSchema as unknown as z.ZodType<AuthorityDecisions>,
  review: reviewSchema as unknown as z.ZodType<AuthorityReview>,
  kinds,
  normalise: normaliseAuthorityDecisions,
  propose: proposeAuthority,
  describe: describeAuthority,
});
