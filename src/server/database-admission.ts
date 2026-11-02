/**
 * Core admission to the controller database, shared by every module that uses
 * the synchronous store. The SQLite owner implements it on its single
 * connection gate; nothing here opens a connection or keeps its own lock.
 *
 * Rules for callers:
 * - Put each bounded phase of synchronous store calls inside `run`.
 * - Inside an admitted operation, await SQL-free work that may be long or that
 *   may itself need admission (process readiness, networking, project
 *   serialization, another queue) through `idle`, then recheck authority.
 * - Timers, events and background producers start with `detached`; they never
 *   rely on admission inherited from whatever scheduled them.
 * - Retry only an admission that was refused before its operation ran.
 */
export interface DatabaseAdmissionOptions {
  /** Aborting before admission guarantees the operation never runs. */
  signal?: AbortSignal;
  /** Bounds only the wait for admission, never the admitted operation. */
  admissionTimeoutMs?: number;
  /** Completion of already accepted work; uses reserved queue capacity. */
  reserved?: boolean;
}

export interface DatabaseAdmission {
  /** Joins the caller's admitted operation, or waits for a fresh admission. */
  run<T>(operation: () => T | Promise<T>, options?: DatabaseAdmissionOptions): Promise<T>;
  /** Always a fresh admission, independent of any inherited operation. */
  detached<T>(operation: () => T | Promise<T>, options?: DatabaseAdmissionOptions): Promise<T>;
  /** Releases the caller's admission while awaiting SQL-free work, then re-admits it. */
  idle<T>(operation: () => Promise<T>, options?: DatabaseAdmissionOptions): Promise<T>;
  /** Runs a synchronous operation now if admission needs no wait; never queues. */
  tryRun<T>(operation: () => T): { ran: true; value: T } | { ran: false };
  /** Starts a background flow detached from the caller's admitted operation. */
  outside<T>(operation: () => T): T;
}

function direct<T>(operation: () => T | Promise<T>): Promise<T> {
  try { return Promise.resolve(operation()); } catch (error) { return Promise.reject(error); }
}

/** For stores and fakes without a connection gate: runs everything immediately. */
export const directAdmission: DatabaseAdmission = Object.freeze({
  run: direct,
  detached: direct,
  idle: <T>(operation: () => Promise<T>) => direct(operation),
  tryRun: <T>(operation: () => T) => ({ ran: true as const, value: operation() }),
  outside: <T>(operation: () => T) => operation(),
});

/**
 * Waits for an admission refused before its operation ran (contention only),
 * retrying until `deadlineMs`. Operations that ran are never retried here.
 */
export async function admitWithRetry<T>(
  admission: DatabaseAdmission,
  operation: () => T,
  options: { deadlineMs?: number; reserved?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const deadline = Date.now() + (options.deadlineMs ?? 60_000);
  for (let delay = 25; ; delay = Math.min(delay * 2, 1_000)) {
    let ran = false;
    try {
      return await admission.detached(() => { ran = true; return operation(); }, { reserved: options.reserved, signal: options.signal });
    } catch (error) {
      if (ran || options.signal?.aborted || !databaseAdmissionFailure(error)?.retryable || Date.now() + delay > deadline) throw error;
    }
    await new Promise<void>(resolve => {
      const signal = options.signal;
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, delay); timer.unref?.();
      if (signal?.aborted) done(); else signal?.addEventListener("abort", done, { once: true });
    });
  }
}

/**
 * Runs a synchronous operation now when admission is free (keeping callbacks
 * synchronous in the common case), otherwise under a fresh admission later.
 */
export function admitNowOrLater<T>(admission: DatabaseAdmission, operation: () => T, settle: (value: T) => void, fail: (error: unknown) => void): void {
  let attempt: { ran: true; value: T } | { ran: false };
  try { attempt = admission.tryRun(operation); } catch (error) { fail(error); return; }
  if (attempt.ran) settle(attempt.value);
  else admission.detached(operation).then(settle, fail);
}

export function admissionOf(store: object): DatabaseAdmission {
  const candidate = (store as { admission?: DatabaseAdmission }).admission;
  return candidate ?? directAdmission;
}

export type DatabaseAdmissionFailureCode = "database_busy" | "database_unavailable" | "database_admission_error";

/**
 * Safe transport classification of connection-gate errors. Contention and
 * shutdown are distinct from authorization denial; arbitrary SQLite errors are
 * never classified here and never retryable.
 */
export function databaseAdmissionFailure(error: unknown): { status: 500 | 503; code: DatabaseAdmissionFailureCode; retryable: boolean } | null {
  if (!(error instanceof Error) || error.name !== "ExclusiveConnectionError") return null;
  const code = (error as { code?: unknown }).code;
  switch (code) {
    case "busy": case "queue_full": case "admission_timeout":
      return { status: 503, code: "database_busy", retryable: true };
    case "cancelled": case "closed": case "draining": case "poisoned": case "provider_closed":
      return { status: 503, code: "database_unavailable", retryable: false };
    default:
      // reentrant, unadmitted, released, unborrowed, in_transaction, expired: programming or provider faults.
      return { status: 500, code: "database_admission_error", retryable: false };
  }
}
