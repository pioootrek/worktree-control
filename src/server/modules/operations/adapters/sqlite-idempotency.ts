import { createHash } from "node:crypto";
import { OperationError } from "../errors";
import { serializeRelease } from "../release";
import type { IdempotencyKey, IdempotencyRecord, IdempotencyStore } from "../runner";

/** The record bounds this adapter applies; equal to the SQLite side's (a test compares them). */
export const IDEMPOTENCY_RECORD_BYTES = 256 * 1024;

export interface StoredIdempotencyRow {
  readonly attempt: unknown; readonly keyId: unknown; readonly fingerprint: unknown; readonly state: unknown;
  readonly resourcesJson: unknown; readonly resultJson: unknown; readonly transitionsJson: unknown;
}
/**
 * The store's SQLite side, structurally `OperationIdempotencyQueries`
 * (`src/server/infrastructure/sqlite/operation-idempotency-queries.ts`) on the
 * controller's owned core connection. Synchronous; this adapter opens nothing.
 */
export interface IdempotencyStorePort {
  inTransaction(): boolean;
  read(key: IdempotencyKey, now: number): { kind: "none" } | { kind: "row"; row: StoredIdempotencyRow } | { kind: "malformed" };
  reserve(input: { key: IdempotencyKey; attempt: string; keyId: string; fingerprint: string; resourcesJson: string; now: number }): "reserved" | "capacity" | "exists";
  advance(input: {
    key: IdempotencyKey; attempt: string; state: "started" | "completed" | "unknown";
    resourcesJson: string; resultJson: string | null; transitionsJson: string | null; chargedBytes: number; now: number;
  }): boolean;
  release(key: IdempotencyKey, attempt: string): void;
}

const OPERATION_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const PRINCIPAL = /^(?:installation|operator|account:[A-Za-z0-9][A-Za-z0-9._:-]{0,159})$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const ATTEMPT = /^[A-Za-z0-9._:-]{1,64}$/;
const FINGERPRINT = /^hmac-sha256:v1:[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{32}$/;
const STATES: readonly unknown[] = Object.freeze(["reserved", "started", "completed", "unknown"]);

/** The fingerprint key's generation: the first 32 hex digits of SHA-256("wtc-operation-key-id\0" || key). Never the key. */
export function fingerprintKeyId(key: Uint8Array): string {
  return createHash("sha256").update("wtc-operation-key-id\u0000", "utf8").update(key).digest("hex").slice(0, 32);
}

const malformed = () => new OperationError("internal", "invalid_idempotency_record");
const unsupported = () => new OperationError("internal", "idempotency_value_unsupported");

/** A copy of a stored JSON text, decoded and checked against the release domain; throws `invalid_idempotency_record`. */
function decode(text: unknown): unknown {
  if (typeof text !== "string") throw malformed();
  try { return serializeRelease(JSON.parse(text)); } catch { throw malformed(); }
}
/** The JSON text of a retained value: only what passes the strict release serializer (`-0` is `0`). */
function encode(value: unknown): string {
  let plain: unknown;
  try { plain = serializeRelease(value); } catch { throw unsupported(); }
  return JSON.stringify(plain);
}
const bytes = (...texts: Array<string | null>) => texts.reduce((sum, text) => sum + (text === null ? 0 : Buffer.byteLength(text, "utf8")), 0);

/** A validated copy of a key; the runner builds it, so anything else is a programming error. */
function keyOf(key: IdempotencyKey): IdempotencyKey {
  const { operationId, principal, idempotencyKey } = (typeof key === "object" && key !== null ? key : {}) as Record<string, unknown>;
  if (typeof operationId !== "string" || !OPERATION_ID.test(operationId) || operationId.length > 128 || typeof principal !== "string" || !PRINCIPAL.test(principal)
    || typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw new OperationError("internal", "invalid_idempotency_key");
  return { operationId, principal, idempotencyKey };
}

export interface SqliteIdempotencyStoreOptions {
  port: IdempotencyStorePort;
  /** The generation of the fingerprint key the runner holds ({@link fingerprintKeyId}). */
  keyId: string;
  /** The runtime clock, integer milliseconds. */
  now(): number;
}

/**
 * The controller's `IdempotencyStore` (D1b) over step 53. Synchronous; every
 * call runs inside an admitted phase of the runner on the shared connection.
 *
 * - Values are JSON-domain: resources, a retained result and transitions pass
 *   `serializeRelease` on the way in (refused otherwise, before any change) and
 *   on the way out, so `get` always returns fresh plain objects. A record holds
 *   at most {@link IDEMPOTENCY_RECORD_BYTES} of JSON.
 * - `put` and `release` refuse before any change while the shared connection
 *   holds an open transaction: success is durable only at the enclosing
 *   transaction's commit, which a nested call cannot see.
 * - A reservation is insert-if-absent (or replace-if-expired). A full store
 *   refuses it as `busy`/`idempotency_capacity` (retry `retry`, nothing
 *   changed). Later writes are qualified by the owning attempt; a write that
 *   matches no record of the attempt throws, and a release of a missing or
 *   foreign attempt is a no-op.
 * - A stored value that cannot be decoded is `internal`/`invalid_idempotency_record`,
 *   never a miss; connection, ownership and fence failures pass unchanged.
 */
export class SqliteIdempotencyStore implements IdempotencyStore {
  readonly #port: IdempotencyStorePort;
  readonly #keyId: string;
  readonly #now: () => number;

  constructor(options: SqliteIdempotencyStoreOptions) {
    const { port, keyId, now } = options;
    if (typeof port?.read !== "function" || typeof port.reserve !== "function" || typeof port.advance !== "function"
      || typeof port.release !== "function" || typeof port.inTransaction !== "function") throw new TypeError("Invalid idempotency store port.");
    if (typeof keyId !== "string" || !KEY_ID.test(keyId)) throw new TypeError("Invalid fingerprint key ID.");
    if (typeof now !== "function") throw new TypeError("Invalid idempotency clock.");
    this.#port = port; this.#keyId = keyId; this.#now = now;
  }

  #clock(): number {
    const now: unknown = this.#now();
    if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) throw new OperationError("internal", "invalid_idempotency_clock");
    return now;
  }
  #outsideTransaction(): void {
    if (this.#port.inTransaction() !== false) throw new OperationError("internal", "idempotency_in_transaction");
  }

  get(key: IdempotencyKey): IdempotencyRecord | null {
    const read = this.#port.read(keyOf(key), this.#clock());
    if (read.kind === "none") return null;
    if (read.kind !== "row") throw malformed();
    const { attempt, keyId, fingerprint, state, resourcesJson, resultJson, transitionsJson } = read.row;
    if (typeof attempt !== "string" || !ATTEMPT.test(attempt) || typeof keyId !== "string" || !KEY_ID.test(keyId)
      || typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint) || !STATES.includes(state)) throw malformed();
    if ((resultJson !== null) !== (state === "completed") || (transitionsJson !== null && state !== "completed")) throw malformed();
    const record: IdempotencyRecord = { attempt, fingerprint, state: state as IdempotencyRecord["state"], resources: decode(resourcesJson) as IdempotencyRecord["resources"] };
    if (state === "completed") record.result = decode(resultJson);
    if (transitionsJson !== null) record.transitions = decode(transitionsJson) as IdempotencyRecord["transitions"];
    return record;
  }

  put(key: IdempotencyKey, record: IdempotencyRecord): void {
    this.#outsideTransaction();
    const copy = keyOf(key);
    const { attempt, fingerprint, state } = (typeof record === "object" && record !== null ? record : {}) as Record<string, unknown>;
    if (typeof attempt !== "string" || !ATTEMPT.test(attempt) || typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint) || !STATES.includes(state)) throw unsupported();
    const resourcesJson = encode(record.resources);
    const resultJson = state === "completed" ? encode(record.result) : null;
    const transitionsJson = state === "completed" && record.transitions !== undefined ? encode(record.transitions) : null;
    const size = bytes(resourcesJson, resultJson, transitionsJson);
    if (size > IDEMPOTENCY_RECORD_BYTES) throw new OperationError("internal", "idempotency_record_too_large");
    const now = this.#clock();
    if (state === "reserved") {
      const reserved = this.#port.reserve({ key: copy, attempt, keyId: this.#keyId, fingerprint, resourcesJson, now });
      if (reserved === "capacity") throw new OperationError("busy", "idempotency_capacity", { retry: "retry" });
      if (reserved !== "reserved") throw new OperationError("internal", "idempotency_record_exists");
      return;
    }
    // A live attempt keeps its reservation's headroom; a final write is charged its actual size, never more.
    const chargedBytes = state === "started" ? IDEMPOTENCY_RECORD_BYTES : size;
    const advanced = this.#port.advance({ key: copy, attempt, state: state as "started" | "completed" | "unknown", resourcesJson, resultJson, transitionsJson, chargedBytes, now });
    if (advanced !== true) throw new OperationError("internal", "idempotency_attempt_mismatch");
  }

  release(key: IdempotencyKey, attempt: string): void {
    this.#outsideTransaction();
    const copy = keyOf(key);
    if (typeof attempt !== "string" || !ATTEMPT.test(attempt)) return;
    this.#port.release(copy, attempt);
  }
}
