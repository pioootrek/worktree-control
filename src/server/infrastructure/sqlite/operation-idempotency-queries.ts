import type Database from "better-sqlite3";
import { schemaTarget } from "./migration-registry";
import { OPERATION_IDEMPOTENCY_HORIZON_MS, OPERATION_IDEMPOTENCY_RECORD_BYTES, OPERATION_IDEMPOTENCY_VERSION } from "./operation-idempotency-migration";

/**
 * The bounds of the idempotency store. No early eviction: a full store refuses
 * a new reservation before any change, and updates and owner releases always
 * proceed. Each live attempt (`reserved`, `started`) is charged
 * {@link OPERATION_IDEMPOTENCY_RECORD_BYTES} against `bytes` from its
 * reservation until its final write, which replaces the charge with the
 * record's actual size (never more), so a completion is never refused for
 * capacity.
 */
export const OPERATION_IDEMPOTENCY_LIMITS = Object.freeze({
  perPrincipal: 1000,
  total: 10_000,
  /** One principal namespace holds at most a quarter of the byte budget, so it cannot refuse every other namespace. */
  perPrincipalBytes: 16 * 1024 * 1024,
  bytes: 64 * 1024 * 1024,
  recordBytes: OPERATION_IDEMPOTENCY_RECORD_BYTES,
  horizonMs: OPERATION_IDEMPOTENCY_HORIZON_MS,
  sweep: 100,
});

export interface OperationIdempotencyKey { operationId: string; principal: string; idempotencyKey: string }
/** A stored row as text, read only after its persisted bytes were bounded. */
export interface StoredOperationIdempotency {
  attempt: string; keyId: string; fingerprint: string; state: string;
  resourcesJson: string; resultJson: string | null; transitionsJson: string | null;
}
export type OperationIdempotencyRead = { kind: "none" } | { kind: "row"; row: StoredOperationIdempotency } | { kind: "malformed" };
export type OperationIdempotencyReservation = "reserved" | "capacity" | "exists";
export interface OperationIdempotencyAdvance {
  key: OperationIdempotencyKey; attempt: string; state: "started" | "completed" | "unknown";
  resourcesJson: string; resultJson: string | null; transitionsJson: string | null; chargedBytes: number; now: number;
}
export interface OperationIdempotencyRepair { deletedExpired: number; convertedForeign: number; deletedReserved: number; convertedStarted: number }

const KEY = "operation_id=? AND principal=? AND idempotency_key=?";
const keyValues = (key: OperationIdempotencyKey) => [key.operationId, key.principal, key.idempotencyKey] as const;
/** SQLite result codes that mean the stored data cannot be decoded, not that the connection failed. */
const DECODING = /^SQLITE_(CORRUPT|MISMATCH|TOOBIG|RANGE)/;
const unexpired = "(expires_at IS NULL OR expires_at>?)";

/**
 * The SQLite side of the operations idempotency store (step 53). Every method
 * is synchronous and runs on the store's owned core connection, inside an
 * admitted phase; this class opens no connection of its own. Writes are
 * qualified by key and owning attempt and run in their own transaction, which
 * checks the changed row count before it commits. The caller
 * (`modules/operations/adapters/sqlite-idempotency.ts`) validates values and
 * refuses calls inside an open transaction.
 */
export class OperationIdempotencyQueries {
  constructor(private readonly database: Database.Database) {
    schemaTarget(OPERATION_IDEMPOTENCY_VERSION);
  }

  /** One read of the table through the owned connection: the fence and admission checks of an ordinary statement, nothing else. */
  probe(): void { this.database.prepare("SELECT 1 FROM operation_idempotency LIMIT 1").get(); }

  /** Whether the shared connection holds an open transaction now. */
  inTransaction(): boolean { return this.database.inTransaction; }

  /**
   * The record of `key` unless it is absent or expired (`expires_at <= now`).
   * Its sizes are read first; a record above the per-record bound, a value of
   * another storage class or a data decoding error is `malformed`, never absent.
   */
  read(key: OperationIdempotencyKey, now: number): OperationIdempotencyRead {
    try {
      const meta = this.database.prepare(`SELECT expires_at,state IN ('reserved','started') AS live,typeof(resources_json) AS r,typeof(result_json) AS s,typeof(transitions_json) AS t,
          length(CAST(resources_json AS BLOB))+ifnull(length(CAST(result_json AS BLOB)),0)+ifnull(length(CAST(transitions_json AS BLOB)),0) AS bytes
        FROM operation_idempotency WHERE ${KEY}`).get(...keyValues(key)) as { expires_at: unknown; live: unknown; r: string; s: string; t: string; bytes: unknown } | undefined;
      if (!meta) return { kind: "none" };
      // A record written past its CHECK (a tampered file): a terminal one never lacks an expiry, a live one never has one.
      if ((meta.expires_at === null) !== (meta.live === 1)) return { kind: "malformed" };
      if (meta.expires_at !== null && (typeof meta.expires_at !== "number" || !Number.isSafeInteger(meta.expires_at))) return { kind: "malformed" };
      if (meta.expires_at !== null && meta.expires_at <= now) return { kind: "none" };
      if (meta.r !== "text" || !["text", "null"].includes(meta.s) || !["text", "null"].includes(meta.t)
        || typeof meta.bytes !== "number" || meta.bytes > OPERATION_IDEMPOTENCY_LIMITS.recordBytes) return { kind: "malformed" };
      const row = this.database.prepare(`SELECT attempt,key_id,fingerprint,state,resources_json,result_json,transitions_json FROM operation_idempotency WHERE ${KEY}`)
        .get(...keyValues(key)) as Record<string, unknown> | undefined;
      if (!row) return { kind: "none" };
      const text = (value: unknown) => typeof value === "string";
      if (!text(row.attempt) || !text(row.key_id) || !text(row.fingerprint) || !text(row.state) || !text(row.resources_json)
        || (row.result_json !== null && !text(row.result_json)) || (row.transitions_json !== null && !text(row.transitions_json))) return { kind: "malformed" };
      return { kind: "row", row: {
        attempt: row.attempt as string, keyId: row.key_id as string, fingerprint: row.fingerprint as string, state: row.state as string,
        resourcesJson: row.resources_json as string, resultJson: row.result_json as string | null, transitionsJson: row.transitions_json as string | null,
      } };
    } catch (error) {
      if (DECODING.test(String((error as { code?: unknown })?.code ?? ""))) return { kind: "malformed" };
      throw error;
    }
  }

  /**
   * A new `reserved` record: inserted when the key has no record, or replacing
   * an expired one. Refused (`capacity`, nothing changed) when the principal,
   * the store's count or its byte bound (with this attempt's headroom) is
   * full; expired records do not count. On success at most
   * {@link OPERATION_IDEMPOTENCY_LIMITS} `sweep` expired records are deleted in
   * the same transaction. `exists`: an unexpired record holds the key.
   */
  reserve(input: { key: OperationIdempotencyKey; attempt: string; keyId: string; fingerprint: string; resourcesJson: string; now: number }): OperationIdempotencyReservation {
    const { key, now } = input;
    return this.database.transaction((): OperationIdempotencyReservation => {
      const existing = this.database.prepare(`SELECT expires_at FROM operation_idempotency WHERE ${KEY}`).get(...keyValues(key)) as { expires_at: number | null } | undefined;
      if (existing && (existing.expires_at === null || existing.expires_at > now)) return "exists";
      const own = this.database.prepare(`SELECT count(*) AS n,ifnull(sum(charged_bytes),0) AS bytes FROM operation_idempotency WHERE principal=? AND ${unexpired}`).get(key.principal, now) as { n: number; bytes: number };
      const principal = own.n;
      const total = this.database.prepare(`SELECT count(*) AS n,ifnull(sum(charged_bytes),0) AS bytes FROM operation_idempotency WHERE ${unexpired}`).get(now) as { n: number; bytes: number };
      if (principal >= OPERATION_IDEMPOTENCY_LIMITS.perPrincipal || total.n >= OPERATION_IDEMPOTENCY_LIMITS.total
        || own.bytes + OPERATION_IDEMPOTENCY_LIMITS.recordBytes > OPERATION_IDEMPOTENCY_LIMITS.perPrincipalBytes
        || total.bytes + OPERATION_IDEMPOTENCY_LIMITS.recordBytes > OPERATION_IDEMPOTENCY_LIMITS.bytes) return "capacity";
      // The requested key's own expired record counts against the same sweep budget.
      let budget = OPERATION_IDEMPOTENCY_LIMITS.sweep;
      if (existing) budget -= this.database.prepare(`DELETE FROM operation_idempotency WHERE ${KEY} AND expires_at IS NOT NULL AND expires_at<=?`).run(...keyValues(key), now).changes;
      if (budget > 0) this.database.prepare(`DELETE FROM operation_idempotency WHERE rowid IN (SELECT rowid FROM operation_idempotency
        WHERE expires_at IS NOT NULL AND expires_at<=? ORDER BY expires_at LIMIT ?)`).run(now, budget);
      this.database.prepare(`INSERT INTO operation_idempotency(operation_id,principal,idempotency_key,attempt,key_id,fingerprint,state,resources_json,
          result_json,transitions_json,charged_bytes,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,'reserved',?,NULL,NULL,?,?,?,NULL)`)
        .run(...keyValues(key), input.attempt, input.keyId, input.fingerprint, input.resourcesJson, OPERATION_IDEMPOTENCY_LIMITS.recordBytes, now, now);
      return "reserved";
    }).immediate();
  }

  /**
   * A later write of the owning attempt: `started` from `reserved`, `completed`
   * from `started`, `unknown` from any state of the same attempt. False, with
   * nothing changed, when no such record exists. Never refused for capacity.
   */
  advance(input: OperationIdempotencyAdvance): boolean {
    const from = input.state === "started" ? "AND state='reserved'" : input.state === "completed" ? "AND state='started'" : "";
    const expires = input.state === "started" ? null : input.now + OPERATION_IDEMPOTENCY_LIMITS.horizonMs;
    return this.database.transaction((): boolean => {
      const changes = this.database.prepare(`UPDATE operation_idempotency SET state=?,resources_json=?,result_json=?,transitions_json=?,charged_bytes=?,updated_at=?,expires_at=?
        WHERE ${KEY} AND attempt=? ${from}`)
        .run(input.state, input.resourcesJson, input.resultJson, input.transitionsJson, input.chargedBytes, input.now, expires, ...keyValues(input.key), input.attempt).changes;
      if (changes > 1) throw new Error("Idempotency key is not unique.");
      return changes === 1;
    }).immediate();
  }

  /** Deletes the record only while it is a live attempt of `attempt`; otherwise nothing changes. */
  release(key: OperationIdempotencyKey, attempt: string): void {
    this.database.transaction(() => {
      const changes = this.database.prepare(`DELETE FROM operation_idempotency WHERE ${KEY} AND attempt=? AND state IN ('reserved','started')`).run(...keyValues(key), attempt).changes;
      if (changes > 1) throw new Error("Idempotency key is not unique.");
    }).immediate();
  }

  /**
   * Restart repair, once per controller database-owner lifetime, in one
   * transaction and conditional on state. In order: expired records are
   * deleted (never resurrected); unexpired records of another key generation
   * become `unknown` without their result and transitions, keeping a finite
   * expiry or getting one horizon after `now` (kept on later starts); then
   * `reserved` records of this generation are deleted (their effect never
   * began) and `started` ones become `unknown` with one horizon. An existing
   * `unknown` record's expiry is never extended. An empty table is not written.
   */
  repair(input: { now: number; keyId: string }): OperationIdempotencyRepair {
    const { now, keyId } = input;
    if (!this.database.prepare("SELECT 1 FROM operation_idempotency LIMIT 1").get()) return { deletedExpired: 0, convertedForeign: 0, deletedReserved: 0, convertedStarted: 0 };
    const horizon = now + OPERATION_IDEMPOTENCY_LIMITS.horizonMs;
    const charge = `min(length(CAST(resources_json AS BLOB)),${OPERATION_IDEMPOTENCY_LIMITS.recordBytes})`;
    return this.database.transaction((): OperationIdempotencyRepair => {
      // A terminal record without an expiry exists only past the table's CHECK: it gets one horizon, never permanence.
      this.database.prepare("UPDATE operation_idempotency SET expires_at=? WHERE expires_at IS NULL AND state NOT IN ('reserved','started')").run(horizon);
      const deletedExpired = this.database.prepare("DELETE FROM operation_idempotency WHERE expires_at IS NOT NULL AND expires_at<=?").run(now).changes;
      const convertedForeign = this.database.prepare(`UPDATE operation_idempotency SET state='unknown',result_json=NULL,transitions_json=NULL,charged_bytes=${charge},
        updated_at=?,expires_at=ifnull(expires_at,?) WHERE key_id<>? AND state<>'unknown'`).run(now, horizon, keyId).changes;
      const deletedReserved = this.database.prepare("DELETE FROM operation_idempotency WHERE key_id=? AND state='reserved'").run(keyId).changes;
      const convertedStarted = this.database.prepare(`UPDATE operation_idempotency SET state='unknown',result_json=NULL,transitions_json=NULL,charged_bytes=${charge},
        updated_at=?,expires_at=? WHERE key_id=? AND state='started'`).run(now, horizon, keyId).changes;
      return { deletedExpired, convertedForeign, deletedReserved, convertedStarted };
    }).immediate();
  }
}
