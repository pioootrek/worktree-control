import {
  errorCategoryStatus, type EffectState, type ErrorCategory, type PublicOperationError, type RetryDisposition,
} from "@/shared/contracts/operations";

const REASON = /^[a-z][a-z0-9_]{0,63}$/;

function defaultRetry(category: ErrorCategory, effect: EffectState | null): RetryDisposition {
  if (effect === "unknown" || effect === "cleanup_unconfirmed") return "inspect_first";
  if (effect === "committed") return "none";
  switch (category) {
    case "busy": case "rate_limited": return "retry";
    case "unauthenticated": case "login_stale": return "reauthenticate";
    case "outcome_unknown": return "inspect_first";
    default: return "none";
  }
}

/**
 * Typed failure of an operation. Construction enforces the outcome rules:
 * `busy` and a `retry` disposition only when execution never began, and
 * `outcome_unknown` only with an unknown effect. A violation is a programming
 * error and throws instead of producing a misleading error.
 */
export class OperationError extends Error {
  readonly category: ErrorCategory;
  readonly reason: string;
  readonly retry: RetryDisposition;
  readonly effect: EffectState | null;

  constructor(category: ErrorCategory, reason: string, options: { effect?: EffectState | null; retry?: RetryDisposition; cause?: unknown } = {}) {
    super(`${category}: ${reason}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OperationError";
    if (!(category in errorCategoryStatus)) throw new TypeError("Unknown error category.");
    if (!REASON.test(reason)) throw new TypeError("Error reasons are short machine-readable identifiers.");
    const effect = options.effect ?? null;
    const retry = options.retry ?? defaultRetry(category, effect);
    const began = effect !== null && effect !== "not_started";
    if (category === "busy" && began) throw new TypeError("busy is reserved for execution that never began.");
    if (retry === "retry" && began) throw new TypeError("A retryable error cannot follow an effect that began.");
    if (category === "outcome_unknown" && effect !== "unknown") throw new TypeError("outcome_unknown requires an unknown effect.");
    if ((effect === "unknown" || effect === "cleanup_unconfirmed") && retry !== "inspect_first") {
      throw new TypeError("An unknown or unconfirmed effect must be inspected before a retry.");
    }
    this.category = category;
    this.reason = reason;
    this.retry = retry;
    this.effect = effect;
  }

  get status(): number { return errorCategoryStatus[this.category]; }

  /** Same failure with the effect state the runner observed. Never weakens retry guidance. */
  withEffect(effect: EffectState | null): OperationError {
    if (effect === this.effect) return this;
    const began = effect !== null && effect !== "not_started";
    let category = this.category;
    if (category === "busy" && began) category = effect === "unknown" ? "outcome_unknown" : "unavailable";
    else if (category === "outcome_unknown" && effect !== "unknown") category = effect === null || effect === "not_started" ? "internal" : "unavailable";
    else if (category !== "outcome_unknown" && effect === "unknown" && (category === "internal" || category === "unavailable")) category = "outcome_unknown";
    return new OperationError(category, this.reason, { effect, retry: began ? undefined : this.retry, cause: this });
  }

  toPublic(): PublicOperationError {
    return { category: this.category, status: this.status, reason: this.reason, retry: this.retry, effect: this.effect };
  }
}

export function isOperationError(error: unknown): error is OperationError {
  return error instanceof OperationError;
}

/** Released form of any thrown value: unexpected faults become `internal` without details. */
export function publicError(error: unknown, effect: EffectState | null = null): PublicOperationError {
  if (isOperationError(error)) return error.toPublic();
  if (effect === "unknown") return new OperationError("outcome_unknown", "unexpected_failure", { effect }).toPublic();
  return new OperationError("internal", "unexpected_failure", { effect }).toPublic();
}
