import { describe, expect, it } from "vitest";
import { errorCategories, errorCategoryStatus } from "@/shared/contracts/operations";
import { ExclusiveConnectionError } from "@/server/infrastructure/sqlite/exclusive-connection";
import { classify, classifyBeforeCommit, OperationError, publicError } from "./errors";
import { releaseError } from "./release";

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

  it("lets the observed effect state win over a typed error", () => {
    const conflict = new OperationError("conflict", "port_in_use");
    expect(classify(conflict, "unknown").toPublic()).toEqual({ category: "outcome_unknown", status: 409, reason: "port_in_use", retry: "inspect_first", effect: "unknown" });
    expect(publicError(conflict, "unknown")).toEqual({ category: "outcome_unknown", status: 409, reason: "port_in_use", retry: "inspect_first", effect: "unknown" });
    expect(publicError(new OperationError("conflict", "x", { effect: "not_started" }), "unknown")).toMatchObject({ category: "outcome_unknown", effect: "unknown" });
    expect(publicError(new OperationError("internal", "x", { effect: "committed" }), "unknown")).toMatchObject({ category: "outcome_unknown", effect: "unknown" });
    expect(publicError(conflict, "committed")).toEqual({ category: "conflict", status: 409, reason: "port_in_use", retry: "none", effect: "committed" });
    expect(publicError(new OperationError("busy", "admission_refused", { effect: "not_started" }), "committed")).toMatchObject({ category: "unavailable", retry: "none", effect: "committed" });
    expect(publicError(new OperationError("rate_limited", "slow_down"), "cleanup_unconfirmed")).toMatchObject({ category: "rate_limited", retry: "inspect_first", effect: "cleanup_unconfirmed" });
    // A typed error's own effect counts only when the runner observed none.
    expect(publicError(new OperationError("internal", "x", { effect: "committed" }), "not_started")).toMatchObject({ effect: "committed", retry: "none" });
    expect(publicError(new OperationError("internal", "x", { effect: "committed" }), null)).toMatchObject({ effect: "committed" });
    expect(publicError(conflict, "not_started")).toMatchObject({ category: "conflict", effect: "not_started" });
  });

  it("never releases busy or a retry after an effect began, for typed and untyped failures", () => {
    const busy = new ExclusiveConnectionError("busy", "fixture");
    for (const effect of ["committed", "unknown", "cleanup_unconfirmed"] as const) {
      for (const error of [busy, new OperationError("busy", "admission_refused"), new OperationError("unavailable", "x", { retry: "retry" })]) {
        const released = publicError(error, effect);
        expect(released.category).not.toBe("busy");
        expect(released.retry).not.toBe("retry");
        expect(released.effect).toBe(effect);
      }
    }
    expect(publicError(busy, "not_started")).toMatchObject({ category: "busy", retry: "retry", effect: "not_started" });
    expect(publicError(busy, "unknown")).toMatchObject({ category: "outcome_unknown", reason: "effect_interrupted" });
  });
});

describe("normalization always runs (decision I)", () => {
  it("never releases a typed error carrying an unknown effect under its own category", () => {
    const typed = new OperationError("conflict", "port_in_use", { effect: "unknown" });
    const expected = { category: "outcome_unknown", status: 409, reason: "port_in_use", retry: "inspect_first", effect: "unknown" };
    expect(typed.toPublic()).toEqual(expected);
    expect(classify(typed, "unknown").toPublic()).toEqual(expected);
    expect(publicError(typed, "unknown")).toEqual(expected);
    expect(publicError(typed, null)).toEqual(expected);
    expect(publicError(typed, "not_started")).toEqual(expected);
    // A typed error mutated after construction is normalized from its fields, not trusted.
    const mutated = new OperationError("internal", "x", { effect: "unknown" });
    Object.defineProperty(mutated, "category", { value: "conflict" });
    expect(publicError(mutated, "unknown")).toMatchObject({ category: "outcome_unknown", effect: "unknown" });
  });

  it("returns a fresh error, never the thrown object", () => {
    const typed = new OperationError("forbidden", "x");
    expect(classify(typed, null)).not.toBe(typed);
  });
});

describe("total sanitization (decision S)", () => {
  class RogueError extends OperationError {
    override toPublic(): never { throw new Error("toPublic /secret"); }
    override withEffect(): never { throw new Error("withEffect /secret"); }
  }
  const hostile = new Proxy({}, { get: () => { throw new Error("get"); }, getPrototypeOf: () => { throw new Error("proto"); },
    getOwnPropertyDescriptor: () => { throw new Error("descriptor"); }, ownKeys: () => { throw new Error("keys"); }, has: () => { throw new Error("has"); } });
  const accessors = Object.defineProperties(new Error("x"), {
    name: { get: () => { throw new Error("name"); } }, code: { get: () => { throw new Error("code"); } },
  });
  const shape = (value: unknown) => Object.keys(value as object).sort();

  it("never calls a method of a thrown value and always returns a well-formed error", () => {
    expect(publicError(new RogueError("conflict", "rogue"), null)).toEqual({ category: "conflict", status: 409, reason: "rogue", retry: "none", effect: null });
    expect(publicError(new RogueError("conflict", "rogue", { effect: "not_started" }), "not_started")).toMatchObject({ category: "conflict", effect: "not_started" });
    for (const thrown of [hostile, accessors, Object.create(OperationError.prototype) as unknown, undefined, Symbol("s")]) {
      for (const effect of [null, "not_started", "unknown", "committed", "bogus"] as const) {
        const released = publicError(thrown, effect as never);
        expect(shape(released)).toEqual(["category", "effect", "reason", "retry", "status"]);
        expect(released.effect).toBe(effect === "bogus" ? null : effect);
      }
    }
  });

  it("releases errors totally, reading the effect only from a data property", () => {
    const getter = Object.defineProperty({ category: "conflict" }, "effect", { enumerable: true, get: () => { throw new Error("effect"); } });
    for (const value of [getter, hostile, null, 42, { effect: "unknown" }]) expect(shape(releaseError(value))).toEqual(["category", "effect", "reason", "retry", "status"]);
    expect(releaseError({ effect: "unknown" })).toEqual({ category: "outcome_unknown", status: 409, reason: "unexpected_failure", retry: "inspect_first", effect: "unknown" });
    // The outcome rules hold for released errors too.
    expect(releaseError({ category: "conflict", status: 409, reason: "x", retry: "inspect_first", effect: "unknown" })).toMatchObject({ category: "outcome_unknown" });
    expect(releaseError({ category: "busy", status: 503, reason: "x", retry: "retry", effect: "committed" })).toMatchObject({ category: "internal", effect: "committed" });
    expect(releaseError({ category: "outcome_unknown", status: 409, reason: "x", retry: "inspect_first", effect: null })).toMatchObject({ category: "internal", effect: null });
  });
});

describe("before the commit point (decision N)", () => {
  it("keeps a typed category with not_started and makes an untyped failure internal", () => {
    expect(classifyBeforeCommit(new OperationError("conflict", "port_in_use", { effect: "committed" })).toPublic()).toEqual({
      category: "conflict", status: 409, reason: "port_in_use", retry: "none", effect: "not_started" });
    expect(classifyBeforeCommit(new OperationError("busy", "worker_busy")).toPublic()).toMatchObject({ category: "busy", retry: "retry", effect: "not_started" });
    expect(classifyBeforeCommit(new OperationError("conflict", "x", { effect: "unknown" })).toPublic()).toMatchObject({ category: "internal", effect: "not_started" });
    expect(classifyBeforeCommit(new Error("boom")).toPublic()).toEqual({ category: "internal", status: 500, reason: "unexpected_failure", retry: "none", effect: "not_started" });
    expect(classifyBeforeCommit(hostileValue()).toPublic()).toMatchObject({ category: "internal", effect: "not_started" });
  });
});

function hostileValue(): unknown {
  return new Proxy({}, { getPrototypeOf: () => { throw new Error("proto"); } });
}
