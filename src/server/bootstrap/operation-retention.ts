import type { SqliteStateStore } from "../sqlite-store";
import type { LogWriter } from "../log-writer";
import { loadOperationKey, SecurityFenceError } from "../infrastructure/sqlite";
import { admissionFailureOf, fingerprintKeyId, SqliteIdempotencyStore, type IdempotencyStore } from "../modules/operations";

/** What the controller's operations runtime retains with: the store and the key the runner copies. */
export interface OperationRetention { readonly idempotency: IdempotencyStore; readonly fingerprintKey: Uint8Array }

/** SQLite result codes that mean the file or connection failed, not one table: the store-wide refusal. */
const STORE_WIDE = /^SQLITE_(CORRUPT|NOTADB|IOERR|CANTOPEN|READONLY|FULL)/;
/** Owners already initialized: once per controller database-owner lifetime. */
const initialized = new WeakSet<object>();

/**
 * Whether a repair failure must refuse the whole store as it does today: a
 * failed security fence, a refused or closed admission (ownership lost), or a
 * file-level SQLite failure. Anything else is local to the idempotency records.
 */
function storeWide(error: unknown): boolean {
  if (error instanceof SecurityFenceError || admissionFailureOf(error) !== null) return true;
  try { return STORE_WIDE.test(String((error as { code?: unknown })?.code ?? "")); } catch { return true; }
}

/**
 * The controller's idempotency retention for one database-owner lifetime (D1b,
 * decision 6). Called once per opened controller store (a database reopened in
 * a controller handoff is a new owner lifetime), after ordinary admission
 * accepted the store and before any listener starts or the operations runtime
 * is built. It loads or creates the fingerprint key beside the database, then
 * runs the restart repair in one admitted phase (see
 * `OperationIdempotencyQueries.repair`).
 *
 * Failure classes:
 * - a key failure or a failure local to the records: `null`. Only keyed
 *   requests are refused (`unavailable`/`idempotency_unavailable`); one bounded
 *   diagnostic names the class, never the key, a path or a thrown message;
 * - a failed fence, a refused admission or a file-level failure: thrown, so
 *   the controller refuses to start as it does for any such store failure.
 *
 * Offline CLI and unix-socket clients never call this: they compose no store
 * and create no key.
 */
export async function initializeOperationRetention(options: {
  store: SqliteStateStore; now(): number; logs: Pick<LogWriter, "controller">; excludedRoots?: readonly string[];
}): Promise<OperationRetention | null> {
  const { store, now, logs } = options;
  if (initialized.has(store)) throw new Error("Operation retention is initialized once per database owner.");
  initialized.add(store);
  const unavailable = (reason: "key_unavailable" | "repair_failed") => {
    try { logs.controller("operations.retention_unavailable", { reason }); } catch { /* Diagnostics never change the outcome. */ }
    return null;
  };
  const port = store.operationIdempotency();
  let key: Buffer;
  try { key = loadOperationKey(store.canonicalDatabasePath, options.excludedRoots ?? []); } catch {
    // A key failure is local only while the store itself is still sound: one ordinary admitted
    // statement first, so a failed fence, a lost owner or a file-level failure still refuses the store.
    try { await store.admission.run(() => port.probe()); } catch (error) { if (storeWide(error)) throw error; }
    return unavailable("key_unavailable");
  }
  const keyId = fingerprintKeyId(key);
  try {
    const counts = await store.admission.run(() => port.repair({ now: now(), keyId }));
    if (counts.deletedExpired || counts.convertedForeign || counts.deletedReserved || counts.convertedStarted) {
      try { logs.controller("operations.retention_repaired", { ...counts }); } catch { /* As above. */ }
    }
  } catch (error) {
    key.fill(0);
    if (storeWide(error)) throw error;
    return unavailable("repair_failed");
  }
  const idempotency = new SqliteIdempotencyStore({ port, keyId, now });
  const fingerprintKey = new Uint8Array(key);
  key.fill(0);
  return Object.freeze({ idempotency, fingerprintKey });
}
