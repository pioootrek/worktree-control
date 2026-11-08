import { afterEach, describe, expect, it, vi } from "vitest";

import { ACCOUNT_SESSION, knowledgeIdentity, knowledgeRequest } from "./knowledge-client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const stub = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal("fetch", stub);
  return stub;
}

afterEach(() => vi.unstubAllGlobals());

describe("knowledge client account session transport", () => {
  it("sends no Authorization header in account mode: the cookie is the sole credential", async () => {
    const stub = stubFetch(jsonResponse(200, { items: [], nextOffset: null }));
    await knowledgeRequest(ACCOUNT_SESSION, "projects", { offset: 0 });
    const [path, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/knowledge");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("keeps the bearer transport for token callers", async () => {
    const stub = stubFetch(jsonResponse(200, { items: [], nextOffset: null }));
    await knowledgeRequest("token-value", "projects", { offset: 0 });
    const [, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer token-value" });
    expect(init.credentials).toBeUndefined();
  });

  it("derives identity from the account session without a credential", async () => {
    stubFetch(jsonResponse(200, {
      authenticated: true,
      principal: { id: "account-1", kind: "human" },
      expiresAt: "2026-01-01T00:00:00.000Z",
      authentication: { method: "password", factors: 1 },
    }));
    await expect(knowledgeIdentity(ACCOUNT_SESSION)).resolves.toEqual({ principal: { id: "account-1", kind: "human" }, credential: null });
  });

  it("rejects an anonymous session as an access error", async () => {
    stubFetch(jsonResponse(200, { authenticated: false }));
    const cause = await knowledgeIdentity(ACCOUNT_SESSION).catch(error => error);
    expect(cause.status).toBe(401);
  });
});
