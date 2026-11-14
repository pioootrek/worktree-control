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
const isCategory = (value: unknown): value is ErrorCategory => typeof value === "string" && Object.prototype.hasOwnProperty.call(errorCategoryStatus, value);
const isEffect = (value: unknown): value is EffectState => typeof value === "string" && (effectStates as readonly string[]).includes(value);
const isRetry = (value: unknown): value is RetryDisposition => typeof value === "string" && (retryDispositions as readonly string[]).includes(value);

/**
 * Category of a typed error once the effect state is fixed. `outcome_unknown`
 * for an unknown effect whatever was given; never `busy` (or
 * `outcome_unknown`) for an effect that is known to have begun.
 */
function categoryFor(category: ErrorCategory, effect: EffectState | null): ErrorCategory {
  if (effect === "unknown") return "outcome_unknown";
  if (began(effect) && (category === "busy" || category === "outcome_unknown")) return "unavailable";
  if (!began(effect) && category === "outcome_unknown") return "internal";
  return category;
}

/**
 * Typed failure of an operation. Construction enforces the outcome rules:
 * `busy` and a `retry` disposition only when execution never began, and
 * `outcome_unknown` only with an unknown effect. A violation is a programming
 * error and throws instead of producing a misleading error. An unknown effect
 * is always `outcome_unknown`: any other category given with it is replaced
 * (the reason is kept).
 */
export class OperationError extends Error {
  readonly category: ErrorCategory;
  readonly reason: string;
  readonly retry: RetryDisposition;
  readonly effect: EffectState | null;

  constructor(category: ErrorCategory, reason: string, options: { effect?: EffectState | null; retry?: RetryDisposition; cause?: unknown } = {}) {
    super(`${category}: ${reason}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OperationError";
    if (!isCategory(category)) throw new TypeError("Unknown error category.");
    if (typeof reason !== "string" || !REASON.test(reason)) throw new TypeError("Error reasons are short machine-readable identifiers.");
    const effect = options.effect ?? null;
    if (effect !== null && !isEffect(effect)) throw new TypeError("Unknown effect state.");
    if (category === "outcome_unknown" && effect !== "unknown") throw new TypeError("outcome_unknown requires an unknown effect.");
    const normalized = effect === "unknown" ? "outcome_unknown" : category;
    const retry = options.retry ?? defaultRetry(normalized, effect);
    if (!isRetry(retry)) throw new TypeError("Unknown retry disposition.");
    if (category === "busy" && began(effect)) throw new TypeError("busy is reserved for execution that never began.");
    if (retry === "retry" && began(effect)) throw new TypeError("A retryable error cannot follow an effect that began.");
    if ((effect === "unknown" || effect === "cleanup_unconfirmed") && retry !== "inspect_first") {
      throw new TypeError("An unknown or unconfirmed effect must be inspected before a retry.");
    }
    this.category = normalized;
    this.reason = reason;
    this.retry = retry;
    this.effect = effect;
  }

  get status(): number { return errorCategoryStatus[this.category]; }

  /** Same failure under the effect state the runner observed; see `classify`. */
  withEffect(effect: EffectState | null): OperationError { return classify(this, effect); }

  /** A fresh plain object of validated primitives, normalized as `classify` would. */
  toPublic(): PublicOperationError { return publicFields(classify(this, this.effect)); }
}

export function isOperationError(error: unknown): error is OperationError {
  return error instanceof OperationError;
}

/** Fields of an error this module constructed, read from its own data properties. */
function publicFields(error: OperationError): PublicOperationError {
  const category = own(error, "category") as ErrorCategory, effect = own(error, "effect") as EffectState | null;
  return { category, status: errorCategoryStatus[category], reason: own(error, "reason") as string, retry: own(error, "retry") as RetryDisposition, effect };
}

/** Data value of an own property; never runs an accessor. */
function own(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

const safeEffect = (value: unknown): EffectState | null => (isEffect(value) ? value : null);

/** A well-formed error that cannot fail: used when everything else did. */
function fallback(effect: EffectState | null): OperationError {
  return effect === "unknown" ? new OperationError("outcome_unknown", "unexpected_failure", { effect })
    : new OperationError("internal", "unexpected_failure", { effect });
}

/**
 * Converts anything thrown into a fresh typed error consistent with the effect
 * state the runner observed. The observed state always wins. A typed error's
 * own effect is used only when the runner observed none (`null` or
 * `not_started`); the original reason is kept and the category is always
 * normalized for the effect. The thrown value is never returned and never has
 * a method called on it: its fields are read as own data properties inside a
 * guard. Unexpected faults lose their details.
 */
export function classify(error: unknown, observed: EffectState | null): OperationError {
  const seen = safeEffect(observed);
  try {
    if (isOperationError(error)) {
      const category = own(error, "category"), reason = own(error, "reason"), retry = own(error, "retry"), ownEffect = own(error, "effect");
      if (!isCategory(category) || typeof reason !== "string" || !REASON.test(reason)) return fallback(seen);
      const effect = seen === null || seen === "not_started" ? safeEffect(ownEffect) ?? seen : seen;
      const normalized = categoryFor(category, effect);
      // A retry disposition survives only while nothing began; otherwise it follows the effect.
      const kept = began(effect) || !isRetry(retry) || (retry === "retry" && normalized !== category) ? undefined : retry;
      return new OperationError(normalized, reason, { effect, retry: kept, cause: error });
    }
    const admission = admissionFailureOf(error);
    if (seen === "unknown") return new OperationError("outcome_unknown", "effect_interrupted", { effect: seen, cause: error });
    if (admission && !began(seen)) {
      return admission.retryable ? new OperationError("busy", "admission_refused", { effect: seen, cause: error })
        : new OperationError("unavailable", "database_unavailable", { effect: seen, cause: error });
    }
    if (admission) return new OperationError("unavailable", "database_unavailable", { effect: seen, cause: error });
    return new OperationError("internal", "unexpected_failure", { effect: seen, cause: error });
  } catch {
    // Never let classification itself fail open or crash the envelope.
    return fallback(seen);
  }
}

/** `databaseAdmissionFailure` that never throws, whatever the thrown value does. */
export function admissionFailureOf(error: unknown): ReturnType<typeof databaseAdmissionFailure> {
  try { return databaseAdmissionFailure(error); } catch { return null; }
}

/**
 * Decision N: a failure before the handler's commit point. A typed error keeps
 * its own category and reason with effect `not_started`; an untyped error is
 * `internal`/`unexpected_failure` with `not_started`; an admission refusal
 * stays `busy` or `unavailable`.
 */
export function classifyBeforeCommit(error: unknown): OperationError {
  try {
    if (isOperationError(error)) {
      const category = own(error, "category"), reason = own(error, "reason"), retry = own(error, "retry");
      if (!isCategory(category) || typeof reason !== "string" || !REASON.test(reason)) return fallback("not_started");
      const normalized = categoryFor(category, "not_started");
      const kept = isRetry(retry) && retry !== "inspect_first" && !(retry === "retry" && normalized !== category) ? retry : undefined;
      return new OperationError(normalized, reason, { effect: "not_started", retry: kept, cause: error });
    }
    return classify(error, "not_started");
  } catch {
    return fallback("not_started");
  }
}

/**
 * Released form of any thrown value under the observed effect state. Total:
 * whatever `error` is or does, the result is a well-formed public error.
 */
export function publicError(error: unknown, effect: EffectState | null = null): PublicOperationError {
  try { return publicFields(classify(error, effect)); } catch {
    return publicFields(fallback(safeEffect(effect)));
  }
}
