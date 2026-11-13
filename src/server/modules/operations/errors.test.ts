import { describe, expect, it } from "vitest";
import { errorCategories, errorCategoryStatus } from "@/shared/contracts/operations";
import { OperationError, publicError } from "./errors";

describe("operation errors", () => {
  it("maps every category to its status", () => {
    expect(errorCategoryStatus).toEqual({
      unauthenticated: 401, forbidden: 403, login_stale: 403, not_found: 404, invalid_request: 400, conflict: 409, claim_held: 409,
      rate_limited: 429, busy: 503, unavailable: 503, internal: 500, payload_too_large: 413, gone: 410, outcome_unknown: 409,
    });
    expect(Object.keys(errorCategoryStatus).sort()).toEqual([...errorCategories].sort());
  });

  it("carries reason, retry disposition and effect state", () => {
    expect(new OperationError("busy", "admission_refused", { effect: "not_started" }).toPublic()).toEqual({
      category: "busy", status: 503, reason: "admission_refused", retry: "retry", effect: "not_started" });
    expect(new OperationError("login_stale", "fresh_login_required").toPublic()).toMatchObject({ retry: "reauthenticate", effect: null });
    expect(new OperationError("outcome_unknown", "x", { effect: "unknown" }).retry).toBe("inspect_first");
    expect(new OperationError("conflict", "x", { effect: "committed" }).retry).toBe("none");
  });

  it("refuses inconsistent outcomes", () => {
    for (const effect of ["committed", "unknown", "cleanup_unconfirmed"] as const) {
      expect(() => new OperationError("busy", "x", { effect })).toThrow(TypeError);
      expect(() => new OperationError("unavailable", "x", { effect, retry: "retry" })).toThrow(TypeError);
    }
    expect(() => new OperationError("outcome_unknown", "x", { effect: "committed" })).toThrow(TypeError);
    expect(() => new OperationError("outcome_unknown", "x")).toThrow(TypeError);
    expect(() => new OperationError("internal", "x", { effect: "unknown", retry: "none" })).toThrow(TypeError);
    expect(() => new OperationError("internal", "Localized message")).toThrow(TypeError);
  });

  it("never turns busy into a retryable error once the effect began", () => {
    const busy = new OperationError("busy", "admission_refused", { effect: "not_started" });
    expect(busy.withEffect("unknown").toPublic()).toMatchObject({ category: "outcome_unknown", retry: "inspect_first", effect: "unknown" });
    expect(busy.withEffect("committed").toPublic()).toMatchObject({ category: "unavailable", retry: "none", effect: "committed" });
    expect(busy.withEffect("cleanup_unconfirmed").toPublic()).toMatchObject({ category: "unavailable", retry: "inspect_first" });
    expect(new OperationError("internal", "x").withEffect("unknown").category).toBe("outcome_unknown");
    expect(new OperationError("forbidden", "x").withEffect("committed").toPublic()).toMatchObject({ category: "forbidden", retry: "none" });
  });

  it("releases unexpected faults without details", () => {
    expect(publicError(new Error("SQLITE_CORRUPT at /secret/path"))).toEqual({ category: "internal", status: 500, reason: "unexpected_failure", retry: "none", effect: null });
    expect(publicError("boom", "unknown")).toMatchObject({ category: "outcome_unknown", effect: "unknown" });
  });
});
