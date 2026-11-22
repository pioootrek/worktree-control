import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { schemaTarget } from "./migration-registry";

/**
 * Step 53: the storage of the operations runner's idempotency records
 * (`IdempotencyStore` in `modules/operations/runner.ts`), applied by the
 * default target (the supported version) and by an explicit target of 53. It
 * may still change until the release candidate; a database migrated by an
 * unreleased build is disposable.
 *
 * One row is one record: the key (operation ID, principal namespace, caller's
 * idempotency key), the owning attempt, the fingerprint key generation
 * (`key_id`), the keyed input digest, the state, the resolved resources, the
 * retained result and confirmed transitions of a `completed` record, the bytes
 * the record is charged against the store's byte bound, and its times on the
 * runtime clock (integer milliseconds).
 *
 * What the table enforces: non-null key components within the runner's
 * grammars; the digest prefix and exactly 64 lower-case hex digits; a 32-digit
 * key generation; a known state; JSON text where JSON is stored; a result only
 * for `completed` (a retained JSON `null` is the text `null`, never SQL NULL);
 * transitions only for `completed` (a removed slot is a JSON `null` inside the
 * object); an expiry exactly for `completed` and `unknown`; integer times and
 * a bounded charge. Persisted sizes are not bounded here: the adapter bounds
 * them before it parses a value, so an oversized row refuses only its own key
 * (`internal`/`invalid_idempotency_record`) instead of the whole installation.
 *
 * The table is not covered by the security fence (an accepted deviation of
 * `docs/authorization-contract.md`): its writes publish no pending witness. The
 * quarantine and the upgrade invalidate it instead ({@link invalidateOperationIdempotency}).
 */
export const OPERATION_IDEMPOTENCY_VERSION = 53;
/** The retention horizon of a `completed` or `unknown` record after its last write, in runtime-clock milliseconds. */
export const OPERATION_IDEMPOTENCY_HORIZON_MS = 24 * 60 * 60 * 1000;
/** The byte charge of a live (`reserved` or `started`) attempt, and the most one record may hold. */
export const OPERATION_IDEMPOTENCY_RECORD_BYTES = 256 * 1024;

/** Text within `bytes`, without NUL, of the characters of `pattern` (a GLOB class body). */
const textCheck = (column: string, minimum: number, maximum: number, pattern: string) =>
  `typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN ${minimum} AND ${maximum} AND length(CAST(${column} AS BLOB))=length(${column}) AND instr(CAST(${column} AS BLOB),X'00')=0 AND ${column} NOT GLOB '*[^${pattern}]*'`;
const jsonCheck = (column: string) => `typeof(${column})='text' AND json_valid(${column})`;
const timeCheck = (column: string) => `typeof(${column})='integer' AND ${column}>=0`;

const table = `CREATE TABLE operation_idempotency (
  operation_id TEXT NOT NULL CHECK(${textCheck("operation_id", 1, 128, "a-z0-9_.")}),
  principal TEXT NOT NULL CHECK(${textCheck("principal", 1, 200, "A-Za-z0-9._:-")}),
  idempotency_key TEXT NOT NULL CHECK(${textCheck("idempotency_key", 1, 128, "A-Za-z0-9._:-")}),
  attempt TEXT NOT NULL CHECK(${textCheck("attempt", 1, 64, "A-Za-z0-9._:-")}),
  key_id TEXT NOT NULL CHECK(${textCheck("key_id", 32, 32, "0-9a-f")}),
  fingerprint TEXT NOT NULL CHECK(typeof(fingerprint)='text' AND length(CAST(fingerprint AS BLOB))=79 AND substr(fingerprint,1,15)='hmac-sha256:v1:' AND substr(fingerprint,16) NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('reserved','started','completed','unknown')),
  resources_json TEXT NOT NULL CHECK(${jsonCheck("resources_json")}),
  result_json TEXT CHECK(result_json IS NULL OR (${jsonCheck("result_json")})),
  transitions_json TEXT CHECK(transitions_json IS NULL OR (${jsonCheck("transitions_json")})),
  charged_bytes INTEGER NOT NULL CHECK(typeof(charged_bytes)='integer' AND charged_bytes BETWEEN 0 AND ${OPERATION_IDEMPOTENCY_RECORD_BYTES}),
  created_at INTEGER NOT NULL CHECK(${timeCheck("created_at")}),
  updated_at INTEGER NOT NULL CHECK(${timeCheck("updated_at")}),
  expires_at INTEGER CHECK(expires_at IS NULL OR (${timeCheck("expires_at")})),
  PRIMARY KEY(operation_id,principal,idempotency_key),
  CHECK((result_json IS NOT NULL)=(state='completed')),
  CHECK(transitions_json IS NULL OR state='completed'),
  CHECK((expires_at IS NULL)=(state IN ('reserved','started')))
)`;
/** The per-principal count and the expiry sweep. */
const indexes = [
  "CREATE INDEX operation_idempotency_principal ON operation_idempotency(principal,expires_at)",
  "CREATE INDEX operation_idempotency_expiry ON operation_idempotency(expires_at)",
];

/** Every statement of the step, in the order it runs. */
const statements = [table, ...indexes];
/** `sql` is the complete text the step executes, in order, and the checksum covers it. */
export const operationIdempotencyMigration = {
  version: OPERATION_IDEMPOTENCY_VERSION, name: "operation-idempotency-structure",
  sql: statements.map(statement => `${statement};`).join("\n"),
};
export const operationIdempotencyChecksum = createHash("sha256")
  .update(`${operationIdempotencyMigration.version}\0${operationIdempotencyMigration.name}\0${operationIdempotencyMigration.sql}`).digest("hex");

/** DDL only; it writes no row but its `schema_migrations` entry, so it is safe before the fence attaches. */
export function applyOperationIdempotencyMigration(database: Database.Database): void {
  schemaTarget(OPERATION_IDEMPOTENCY_VERSION);
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=53").get()) return;
  for (const statement of statements) database.exec(statement);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(53,?,?,?)")
    .run(new Date().toISOString(), operationIdempotencyMigration.name, operationIdempotencyChecksum);
}

/**
 * The recovery boundary of retained outcomes, inside the quarantine's
 * transaction (`quarantineAuthority`, at an effective target of 53 or more) and
 * the upgrade's (`upgrade apply` at a target of 53 or more): an expired record
 * is deleted (it already reads as absent and is never resurrected), and every
 * other record that is not `unknown` becomes `unknown` with its result and
 * transitions dropped and an expiry one horizon after `now`. An `unknown`
 * record keeps its expiry, so a repeated invalidation never extends it. A retry
 * of a surviving key therefore answers `outcome_unknown` (or
 * `idempotency_conflict` for different input) until the record expires, never
 * a replay of a pre-recovery result and never a fresh run. A key first used
 * after the restored snapshot was taken has no row here and runs fresh: the
 * operator reconciles such effects before retrying (see the restore guide).
 */
export function invalidateOperationIdempotency(database: Database.Database, now: number): void {
  schemaTarget(OPERATION_IDEMPOTENCY_VERSION);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid idempotency clock.");
  database.prepare("DELETE FROM operation_idempotency WHERE expires_at IS NOT NULL AND expires_at<=?").run(now);
  database.prepare(`UPDATE operation_idempotency SET state='unknown',result_json=NULL,transitions_json=NULL,
    charged_bytes=min(length(CAST(resources_json AS BLOB)),${OPERATION_IDEMPOTENCY_RECORD_BYTES}),updated_at=?,expires_at=? WHERE state<>'unknown'`)
    .run(now, now + OPERATION_IDEMPOTENCY_HORIZON_MS);
}
