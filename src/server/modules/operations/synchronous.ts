import { OperationError } from "./errors";

/**
 * Decision W: a callback whose contract is synchronous is checked at run time.
 * Writing it as an async function satisfies a `void` return type, so the type
 * system cannot catch it; these helpers do.
 */

/** Whether a value is a promise or another thenable. Never throws: a value whose `then` cannot be read counts as one. */
export function isThenable(value: unknown): boolean {
  try {
    return (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";
  } catch { return true; }
}

/** Marks a promise or thenable returned where none is allowed as handled, so its rejection is never unhandled. Never throws. */
export function absorb(value: unknown): void {
  try { Promise.resolve(value).then(undefined, () => undefined); } catch { /* nothing to absorb */ }
}

/**
 * The value a synchronous callback returned. A thenable is a contract
 * violation, whether it would fulfil or reject: its rejection is marked as
 * handled and the call fails with `internal`/`reason`, so the caller never
 * counts an unfinished step as done.
 */
export function synchronous<T>(value: T, reason: string): T {
  if (isThenable(value)) {
    absorb(value);
    throw new OperationError("internal", reason);
  }
  return value;
}

/** A synchronous yes/no answer: only `true` is yes. A thenable is absorbed and counts as no. */
export function holds(value: unknown): boolean {
  if (value === true) return true;
  if (isThenable(value)) absorb(value);
  return false;
}
