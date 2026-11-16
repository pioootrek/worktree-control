import type Database from "better-sqlite3";
import { TestRunQueries } from "./test-run-queries";

/**
 * The statement groups that reset stored authority and running work: the one
 * implementation that both the quarantine of `auth fence resume`
 * (`quarantineAuthority`) and the authority acts of the explicit offline
 * upgrade (`authority-upgrade-acts.ts`) run. Each group is the quarantine's
 * own statements, unchanged in text and order. The caller owns the
 * transaction; foreign keys may be off (none of these statements deletes a
 * parent row, apart from the test-run trimming, which deletes its dependents
 * explicitly first).
 *
 * What only the quarantine does (the authentication provider's passwords,
 * tokens, sessions, verifications, passkeys and two-factor material, account
 * policies, factor contexts and receipts, the mode and the installation token)
 * stays in `quarantineAuthority`: the upgrade keeps all of it.
 */

/** The tables of the old authority with a revocation column, in the quarantine's order. */
export const OLD_GRANT_TABLES = Object.freeze([
  "knowledge_project_grants", "knowledge_role_bindings", "runtime_delegations",
  "runtime_human_memberships", "remote_principal_project_grants", "remote_worker_project_grants",
] as const);
export type OldGrantTable = typeof OLD_GRANT_TABLES[number];
/** The old grant tables whose revocation also advances `revision` and sets `updated_at`. */
export const REVISED_GRANT_TABLES: ReadonlyArray<OldGrantTable> = Object.freeze(["knowledge_role_bindings", "runtime_delegations", "runtime_human_memberships"]);
/** Every credential kind `principal_credentials` allows; all of them are revoked. */
export const CREDENTIAL_KINDS = Object.freeze(["agent_token", "owner_session", "worker_token"] as const);
/** Remote phases the reset cancels. */
export const CANCELLED_REQUEST_PHASES = Object.freeze(["pending", "assigned"] as const);
export const CANCELLED_ATTEMPT_PHASES = Object.freeze(["assigned", "preparing", "running"] as const);
/** Test-run phases the reset interrupts (with every run whose summary is not terminal). */
export const INTERRUPTED_RUN_PHASES = Object.freeze(["queued", "running"] as const);

/**
 * The statements write the time as a literal, exactly as the quarantine always
 * has; only the canonical form `toISOString` writes is accepted, so nothing
 * else can reach the SQL text.
 */
function instant(now: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now)) throw new Error("Authority reset needs a canonical instant.");
  return now;
}

/** Every credential, of every kind, revoked; a revocation time already stored is kept. */
export function revokeCredentials(database: Database.Database, now: string): void {
  const at = instant(now);
  database.exec(`
    UPDATE principal_credentials SET status='revoked', revoked_at=coalesce(revoked_at,'${at}');`);
}

/**
 * Every row of the six old grant tables revoked in place; a revocation time
 * already stored is kept. Role bindings, delegations and memberships also
 * advance their revision and take `now` as `updated_at`, revoked or not, as
 * the quarantine always did. `runtime_credential_scopes` has no revocation
 * column and is not touched: its credentials are revoked by
 * {@link revokeCredentials}.
 */
export function revokeOldGrants(database: Database.Database, now: string): void {
  const at = instant(now);
  database.exec(`
    UPDATE knowledge_project_grants SET revoked_at=coalesce(revoked_at,'${at}');
    UPDATE knowledge_role_bindings SET revoked_at=coalesce(revoked_at,'${at}'),revision=revision+1,updated_at='${at}';
    UPDATE runtime_delegations SET revoked_at=coalesce(revoked_at,'${at}'),revision=revision+1,updated_at='${at}';
    UPDATE runtime_human_memberships SET revoked_at=coalesce(revoked_at,'${at}'),revision=revision+1,updated_at='${at}';
    UPDATE remote_principal_project_grants SET revoked_at=coalesce(revoked_at,'${at}');
    UPDATE remote_worker_project_grants SET revoked_at=coalesce(revoked_at,'${at}');`);
}

/** Every active claim or reservation released (human and agent leases alike); a release time already stored is kept. */
export function releaseReservations(database: Database.Database, now: string): void {
  const at = instant(now);
  database.exec(`
    UPDATE reservations SET released_at=coalesce(released_at,'${at}');`);
}

/**
 * Remote work cancelled: pending and assigned requests become `cancelled`;
 * assigned, preparing and running attempts become `cancel_requested` (their
 * version advances). It invalidates the work logically; it does not prove that
 * a remote process stopped.
 */
export function cancelRemoteWork(database: Database.Database, now: string): void {
  const at = instant(now);
  database.exec(`
    UPDATE remote_verification_requests SET phase='cancelled',updated_at='${at}' WHERE phase IN ('pending','assigned');
    UPDATE remote_verification_attempts SET phase='cancel_requested',version=version+1,last_reported_at='${at}' WHERE phase IN ('assigned','preparing','running');`);
}

/**
 * Queued and running test runs (and runs whose summary is not terminal) marked
 * interrupted with terminal summaries, through the product's recovery path.
 * Its trimming of old history deletes the requester rows of the runs it trims.
 */
export function interruptTestRuns(database: Database.Database): void {
  new TestRunQueries(database).markInterruptedTestRuns();
}
