import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountApiError, authStatus, getSession, isSessionLoss, signIn } from "./account-client";
import { isRuntimeSessionLoss, RuntimeApiError, runtimeMutate, runtimeRead } from "./runtime-client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(response: Response | (() => Response)): ReturnType<typeof vi.fn> {
  const stub = vi.fn(typeof response === "function" ? () => Promise.resolve(response()) : () => Promise.resolve(response));
  vi.stubGlobal("fetch", stub);
  return stub;
}

afterEach(() => vi.unstubAllGlobals());

describe("account client", () => {
  it("sends no credential header and asks for the same-origin cookie", async () => {
    const stub = stubFetch(jsonResponse(200, { mode: "better-auth", loginAvailable: true }));
    await expect(authStatus()).resolves.toEqual({ mode: "better-auth", loginAvailable: true });
    const [path, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/auth/status");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toBeUndefined();
  });

  it("maps a failure body to status and code", async () => {
    stubFetch(jsonResponse(401, { code: "invalid_credential", error: "denied" }));
    const cause = await getSession().catch(error => error);
    expect(cause).toBeInstanceOf(AccountApiError);
    expect(cause.status).toBe(401);
    expect(cause.code).toBe("invalid_credential");
    expect(isSessionLoss(cause)).toBe(true);
  });

  it("falls back to a generic code for a non-JSON failure", async () => {
    stubFetch(new Response("nope", { status: 503 }));
    const cause = await getSession().catch(error => error);
    expect(cause).toBeInstanceOf(AccountApiError);
    expect(cause.code).toBe("authentication_failed");
  });

  it("posts the sign-in body without storing anything", async () => {
    const stub = stubFetch(jsonResponse(200, { authenticated: false, outcome: "challenge", method: "totp" }));
    await expect(signIn("user@example.com", "secret")).resolves.toEqual({ authenticated: false, outcome: "challenge", method: "totp" });
    const [path, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/auth/sign-in/email");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ email: "user@example.com", password: "secret" });
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("treats only a 401 as session loss, never a 403 denial", () => {
    expect(isSessionLoss(new AccountApiError(403, "origin_forbidden"))).toBe(false);
    expect(isSessionLoss(new Error("network"))).toBe(false);
  });
});

describe("runtime client", () => {
  it("posts the read operation to the cookie route", async () => {
    const stub = stubFetch(jsonResponse(200, { operation: "list-projects", projects: [] }));
    await expect(runtimeRead({ operation: "list-projects" })).resolves.toEqual({ operation: "list-projects", projects: [] });
    const [path, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/runtime/read");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ operation: "list-projects" });
  });

  it("maps denial codes without reinterpreting them", async () => {
    stubFetch(jsonResponse(403, { code: "project_access_denied", error: "denied" }));
    const cause = await runtimeMutate({ operation: "stop", projectId: "p", reservationId: "r", idempotencyKey: "k" }).catch(error => error);
    expect(cause).toBeInstanceOf(RuntimeApiError);
    expect(cause.status).toBe(403);
    expect(cause.code).toBe("project_access_denied");
    expect(isRuntimeSessionLoss(cause)).toBe(false);
  });

  it("treats a 401 as session loss", async () => {
    stubFetch(jsonResponse(401, { code: "invalid_credential", error: "denied" }));
    const cause = await runtimeRead({ operation: "list-projects" }).catch(error => error);
    expect(isRuntimeSessionLoss(cause)).toBe(true);
  });
});
