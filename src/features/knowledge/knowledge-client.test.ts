import { afterEach, describe, expect, it, vi } from "vitest";

import { ACCOUNT_SESSION, createAccountKnowledgeSession, knowledgeIdentity, knowledgeRequest } from "./knowledge-client";

import { knowledgeSchemas, type KnowledgeOperation } from "@/shared/contracts/knowledge";

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

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(settle => { resolve = settle; });
  return { promise, resolve };
}

describe("Knowledge account session loss scope", () => {
  // Exercise the common transport for every supported read and mutation, including
  // operations not currently exposed in account GUI. Authentication precedes input validation.
  it.each(Object.keys(knowledgeSchemas) as KnowledgeOperation[])("reports %s HTTP 401 to its owning session", async operation => {
    const lost = vi.fn();
    const scope = createAccountKnowledgeSession(lost);
    const dispose = scope.activate();
    const fetch = stubFetch(jsonResponse(401, { code: "invalid_credential", error: "Expired" }));
    await expect(knowledgeRequest(scope.credential, operation, {} as never)).rejects.toMatchObject({ status: 401 });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetch.mock.calls[0] as [string, RequestInit])[1].body as string).operation).toBe(operation);
    expect((fetch.mock.calls[0] as [string, RequestInit])[1].headers).toEqual({ "Content-Type": "application/json" });
    dispose();
  });

  it("reports concurrent discovery/read failures only once", async () => {
    const lost = vi.fn();
    const scope = createAccountKnowledgeSession(lost);
    scope.activate();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(401, { code: "invalid_credential", error: "Expired" }))));
    await Promise.allSettled([knowledgeIdentity(scope.credential), knowledgeRequest(scope.credential, "projects", {})]);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it.each(["identity", "request"])("reports %s HTTP 401 even with a non-JSON body", async path => {
    const lost = vi.fn();
    const scope = createAccountKnowledgeSession(lost);
    scope.activate();
    stubFetch(new Response("Expired", { status: 401 }));
    await Promise.allSettled([path === "identity" ? knowledgeIdentity(scope.credential) : knowledgeRequest(scope.credential, "task_state", { projectId: "project", taskId: "task" })]);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("reports anonymous identity but retains the session after an independent 403 and recovery", async () => {
    const lost = vi.fn();
    const scope = createAccountKnowledgeSession(lost);
    scope.activate();
    stubFetch(jsonResponse(403, { code: "forbidden", error: "Denied" }));
    await expect(knowledgeRequest(scope.credential, "history", { projectId: "project", recordKind: "memory", recordId: "memory" })).rejects.toMatchObject({ status: 403 });
    expect(lost).not.toHaveBeenCalled();
    stubFetch(jsonResponse(200, { items: [] }));
    await expect(knowledgeRequest(scope.credential, "history", { projectId: "project", recordKind: "memory", recordId: "memory" })).resolves.toEqual({ items: [] });
    stubFetch(jsonResponse(200, { authenticated: false }));
    await expect(knowledgeIdentity(scope.credential)).rejects.toMatchObject({ status: 401 });
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("ignores a cancelled independent request even when fetch delivers its held 401", async () => {
    const lost = vi.fn();
    const scope = createAccountKnowledgeSession(lost);
    scope.activate();
    const held = deferredResponse();
    vi.stubGlobal("fetch", vi.fn(() => held.promise));
    const abort = new AbortController();
    const result = knowledgeRequest(scope.credential, "task_context", { projectId: "project", taskId: "task" }, abort.signal).catch(error => error);
    abort.abort();
    held.resolve(jsonResponse(401, { code: "invalid_credential", error: "Expired" }));
    expect(await result).toMatchObject({ status: 401 });
    expect(lost).not.toHaveBeenCalled();
  });

  it("cannot retarget a held export response to a newer session's callback", async () => {
    const oldLost = vi.fn(); const newLost = vi.fn();
    const oldScope = createAccountKnowledgeSession(oldLost);
    const dispose = oldScope.activate();
    const held = deferredResponse();
    vi.stubGlobal("fetch", vi.fn(() => held.promise));
    const oldExport = knowledgeRequest(oldScope.credential, "export_context", { projectId: "project", taskId: "task", format: "markdown" }).catch(error => error);
    dispose();
    const newScope = createAccountKnowledgeSession(newLost);
    newScope.activate();
    stubFetch(jsonResponse(200, { items: [] }));
    await knowledgeRequest(newScope.credential, "projects", {});
    held.resolve(jsonResponse(401, { code: "invalid_credential", error: "Old session expired" }));
    expect(await oldExport).toMatchObject({ status: 401 });
    expect(oldLost).not.toHaveBeenCalled(); expect(newLost).not.toHaveBeenCalled();
    stubFetch(jsonResponse(401, { code: "invalid_credential", error: "New session expired" }));
    await expect(knowledgeRequest(newScope.credential, "projects", {})).rejects.toMatchObject({ status: 401 });
    expect(newLost).toHaveBeenCalledTimes(1);
  });

  it.each(["token-value", "", ACCOUNT_SESSION])("keeps unscoped credential %s outside another account's notification", async credential => {
    const lost = vi.fn();
    const scope = createAccountKnowledgeSession(lost);
    scope.activate();
    stubFetch(jsonResponse(401, { code: "invalid_credential", error: "Denied" }));
    await expect(knowledgeRequest(credential, "projects", {})).rejects.toMatchObject({ status: 401 });
    expect(lost).not.toHaveBeenCalled();
  });
});
