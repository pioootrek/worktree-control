import { databaseAdmissionFailure } from "@/server/database-admission";
import {
  effectStates, errorCategoryStatus, retryDispositions,
  type EffectState, type ErrorCategory, type PublicOperationError, type RetryDisposition,
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

const began = (effect: EffectState | null) => effect !== null && effect !== "not_started";

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
    if (!Object.prototype.hasOwnProperty.call(errorCategoryStatus, category)) throw new TypeError("Unknown error category.");
    if (typeof reason !== "string" || !REASON.test(reason)) throw new TypeError("Error reasons are short machine-readable identifiers.");
    const effect = options.effect ?? null;
    if (effect !== null && !(effectStates as readonly string[]).includes(effect)) throw new TypeError("Unknown effect state.");
    const retry = options.retry ?? defaultRetry(category, effect);
    if (!(retryDispositions as readonly string[]).includes(retry)) throw new TypeError("Unknown retry disposition.");
    if (category === "busy" && began(effect)) throw new TypeError("busy is reserved for execution that never began.");
    if (retry === "retry" && began(effect)) throw new TypeError("A retryable error cannot follow an effect that began.");
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

  /** Same failure under the effect state the runner observed; see `classify`. */
  withEffect(effect: EffectState | null): OperationError { return classify(this, effect); }

  /** A fresh plain object of validated primitives. */
  toPublic(): PublicOperationError {
    return { category: this.category, status: this.status, reason: this.reason, retry: this.retry, effect: this.effect };
  }
}

export function isOperationError(error: unknown): error is OperationError {
  return error instanceof OperationError;
}

/**
 * Category of a typed error once the effect state is fixed. `outcome_unknown`
 * for an unknown effect whatever was thrown; never `busy` (or
 * `outcome_unknown`) for an effect that is known to have begun.
 */
function categoryFor(category: ErrorCategory, effect: EffectState | null): ErrorCategory {
  if (effect === "unknown") return "outcome_unknown";
  if (began(effect) && (category === "busy" || category === "outcome_unknown")) return "unavailable";
  if (!began(effect) && category === "outcome_unknown") return "internal";
  return category;
}

/**
 * Converts anything thrown into a typed error consistent with the effect state
 * the runner observed. The observed state always wins. A typed error's own
 * effect is used only when the runner observed none (`null` or `not_started`);
 * the original reason is kept. Unexpected faults lose their details.
 */
export function classify(error: unknown, observed: EffectState | null): OperationError {
  try {
    if (isOperationError(error)) {
      const effect = observed === null || observed === "not_started" ? error.effect ?? observed : observed;
      if (effect === error.effect) return error;
      const category = categoryFor(error.category, effect);
      // A retry disposition survives only while nothing began; otherwise it follows the effect.
      const retry = began(effect) ? undefined : error.retry === "retry" && category !== error.category ? undefined : error.retry;
      return new OperationError(category, error.reason, { effect, retry, cause: error });
    }
    const admission = databaseAdmissionFailure(error);
    if (observed === "unknown") return new OperationError("outcome_unknown", "effect_interrupted", { effect: observed, cause: error });
    if (admission && !began(observed)) {
      return admission.retryable ? new OperationError("busy", "admission_refused", { effect: observed, cause: error })
        : new OperationError("unavailable", "database_unavailable", { effect: observed, cause: error });
    }
    if (admission) return new OperationError("unavailable", "database_unavailable", { effect: observed, cause: error });
    return new OperationError("internal", "unexpected_failure", { effect: observed, cause: error });
  } catch {
    // Never let classification itself fail open or crash the envelope.
    return observed === "unknown" ? new OperationError("outcome_unknown", "unexpected_failure", { effect: "unknown" })
      : new OperationError("internal", "unexpected_failure", { effect: observed });
  }
}

/** Released form of any thrown value under the observed effect state. */
export function publicError(error: unknown, effect: EffectState | null = null): PublicOperationError {
  return classify(error, effect).toPublic();
}
