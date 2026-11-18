import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import { AuthenticationProviderRuntime } from "./provider-runtime";
import { AUTHENTICATION_PROVIDER_CONTRACT_VERSION, type AuthenticationProviderInstance, type AuthenticationProviderModule, type VerifiedProviderSession } from "./provider-contract";
import type { ProviderSessionState } from "./account-protection";
import { SessionIssuance } from "./session-issuance";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Real single-connection borrowing, with controlled provider claims and committed state. */
function fixture(supported = true) {
  const root = mkdtempSync(join(tmpdir(), "provider-runtime-"));
  const store = new SqliteStateStore(join(root, "state.sqlite3"));
  const storage = store.authenticationProviderStorage();
  const createdAt = new Date(Date.now() - 1_000).toISOString();
  const deadline = new Date(Date.now() + 60_000).toISOString();
  const session: VerifiedProviderSession = { providerId: "better-auth", sessionId: "fixture-session", subject: "fixture-subject", createdAt,
    expiresAt: new Date(Date.now() + 120_000).toISOString(), authentication: { method: "password", factors: 1 } };
  const state: ProviderSessionState = { principalKind: "human", principalId: "fixture-person", mappingLinkedAt: createdAt,
    subject: session.subject, createdAt, expiresAt: session.expiresAt, currentBinding: null,
    evidence: { sessionId: session.sessionId, subject: session.subject, method: "password", authenticatedAt: createdAt, originalDeadline: deadline,
      generation: 1, policyRevision: 1, credential: null, credentialBinding: null, attemptId: "fixture-attempt" },
    account: { generation: 1, policyRevision: 1, totpSelected: false, passkeySelected: false, consistent: true } };
  vi.spyOn(storage, "currentSession").mockReturnValue(state);
  const subjects = storage.subjects("better-auth");
  vi.spyOn(subjects, "resolveActivePrincipal").mockReturnValue(state.principalId);
  const resolveSession = vi.fn<AuthenticationProviderInstance["resolveSession"]>().mockResolvedValue(session);
  const instance: AuthenticationProviderInstance = {
    initialize: vi.fn(), handle: vi.fn(), signOut: vi.fn(), resolveSession, provisionLocal: vi.fn(), recoverLocal: vi.fn(),
    revokeSession: vi.fn(), revokeSubjectSessions: vi.fn(), dispose: vi.fn(async () => {}),
  };
  const provider: AuthenticationProviderModule = { providerId: "better-auth", contractVersion: AUTHENTICATION_PROVIDER_CONTRACT_VERSION,
    storageRevision: 3, implementationVersion: "0.0.0-proof.5", create: () => instance };
  const runtime = new AuthenticationProviderRuntime({ entry: "unused", providerId: "better-auth", storage,
    options: { baseURL: "https://fixture.invalid/api/auth", secret: "fixture-only-signing-secret-unused", clientIpHeader: "x-fixture-ip" } }, provider, instance, storage.createProviderConnection(), subjects,
    new AsyncLocalStorage(), { providerId: provider.providerId, implementationVersion: provider.implementationVersion, schema: "verified",
      library: { name: "better-auth", version: supported ? "1.7.14" : "unsupported" } }, storage.protection("better-auth"), undefined,
    new SessionIssuance(storage.sessionIssuance(), null));
  cleanups.push(async () => { try { await runtime.dispose(); } finally { store.close(); rmSync(root, { recursive: true, force: true }); } });
  return { runtime, storage, resolveSession, session, state, deadline };
}

describe("provider runtime session eligibility", () => {
  it("is synchronous, current and not cached", () => {
    const { runtime, storage } = fixture();
    expect(runtime.isSessionAuthorityEligible()).toBe(true);
    const available = vi.spyOn(storage, "available").mockReturnValue(false);
    expect(runtime.isSessionAuthorityEligible()).toBe(false);
    available.mockReturnValue(true);
    expect(runtime.isSessionAuthorityEligible()).toBe(true);
  });

  it("refuses as soon as disposal starts", async () => {
    const { runtime } = fixture();
    const disposal = runtime.dispose();
    expect(runtime.isSessionAuthorityEligible()).toBe(false);
    await disposal;
    expect(runtime.isSessionAuthorityEligible()).toBe(false);
  });

  it("refuses unsupported session authority without consulting storage", () => {
    const { runtime, storage } = fixture(false);
    const available = vi.spyOn(storage, "available");
    expect(runtime.isSessionAuthorityEligible()).toBe(false);
    expect(available).not.toHaveBeenCalled();
  });

  it("absorbs a storage check that throws", () => {
    const { runtime, storage } = fixture();
    vi.spyOn(storage, "available").mockImplementation(() => { throw new Error("fixture storage failure"); });
    expect(runtime.isSessionAuthorityEligible()).toBe(false);
  });

  it.each([1, "true", null, undefined, {}, Promise.resolve(true)])("refuses a non-boolean storage answer (%s)", answer => {
    const { runtime, storage } = fixture();
    vi.spyOn(storage, "available").mockReturnValue(answer as boolean);
    expect(runtime.isSessionAuthorityEligible()).toBe(false);
  });

  it("handles a rejected thenable without returning a promise", async () => {
    const { runtime, storage } = fixture();
    vi.spyOn(storage, "available").mockReturnValue(Promise.reject(new Error("fixture failure")) as unknown as boolean);
    expect(runtime.isSessionAuthorityEligible()).toBe(false);
    await Promise.resolve();
  });
});

describe("request-scoped provider session resolution", () => {
  it("returns resolve's public value and forwards the same headers under one borrow", async () => {
    const { runtime, storage, resolveSession, session, state, deadline } = fixture();
    const headers = new Headers();
    const expected = await runtime.resolve(headers);
    const borrow = vi.spyOn(storage, "borrow");
    const request = runtime.resolveRequest(headers);
    await expect(request.result).resolves.toEqual(expected);
    await request.settled;
    expect(expected).toEqual({ session: { ...session, expiresAt: deadline }, principalId: state.principalId });
    expect(resolveSession).toHaveBeenLastCalledWith(headers);
    expect(borrow).toHaveBeenCalledOnce();
    const actor = await runtime.authenticateRequest(headers).result;
    expect(actor).toMatchObject({ principalId: state.principalId, principalKind: "human", authenticationMethod: "provider_session" });
    expect(runtime.isCurrentProviderSession(actor!, new Date().toISOString())).toBe(true);
  });

  it.each(["resolveRequest", "authenticateRequest"] as const)("%s returns null when the provider finds no session", async method => {
    const { runtime, resolveSession } = fixture();
    resolveSession.mockResolvedValue(null);
    const request = runtime[method](new Headers());
    await expect(request.result).resolves.toBeNull();
    await request.settled;
    await expect(runtime.resolve(new Headers())).resolves.toBeNull();
  });

  it.each(["resolveRequest", "authenticateRequest"] as const)("%s cancels queued work without entering the provider", async method => {
    const { runtime, storage, resolveSession } = fixture();
    const entered = gate(), resume = gate();
    const held = storage.borrow(async () => { entered.open(); await resume.opened; });
    await entered.opened;
    try {
      const abort = new AbortController();
      const request = runtime[method](new Headers(), { signal: abort.signal });
      abort.abort();
      await expect(request.result).rejects.toMatchObject({ name: "ExclusiveConnectionError", code: "cancelled" });
      await request.settled;
      expect(resolveSession).not.toHaveBeenCalled();
    } finally { resume.open(); await held; }
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it.each(["resolveRequest", "authenticateRequest"] as const)("%s retains started work after abort until the provider returns", async method => {
    const { runtime, resolveSession, session } = fixture();
    const entered = gate(), resume = gate();
    resolveSession.mockImplementationOnce(async () => { entered.open(); await resume.opened; return session; });
    const abort = new AbortController();
    const request = runtime[method](new Headers(), { signal: abort.signal });
    let resultFinished = false, settled = false;
    void request.result.finally(() => { resultFinished = true; });
    void request.settled.then(() => { settled = true; });
    try {
      await entered.opened;
      abort.abort();
      await Promise.resolve();
      expect(resultFinished).toBe(false);
      expect(settled).toBe(false);
    } finally { resume.open(); }
    expect(await request.result).not.toBeNull();
    await request.settled;
    expect(settled).toBe(true);
  });

  it.each(["resolveRequest", "authenticateRequest"] as const)("%s keeps settled pending after a borrow rejects before its execution ends", async method => {
    const { runtime, storage, resolveSession, session } = fixture();
    const entered = gate(), resume = gate();
    resolveSession.mockImplementationOnce(async () => { entered.open(); await resume.opened; return session; });
    const abort = new AbortController();
    const borrow = storage.borrow.bind(storage);
    // Model the gate's early public failure while the real single borrow still owns execution.
    vi.spyOn(storage, "borrow").mockImplementationOnce((operation, options) => Promise.race([
      borrow(operation, options),
      new Promise<never>((_, reject) => { abort.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("Fixture borrow cancelled."), { name: "ExclusiveConnectionError", code: "cancelled" }));
      }, { once: true }); }),
    ]));
    const request = runtime[method](new Headers(), { signal: abort.signal });
    let settled = false;
    void request.settled.then(() => { settled = true; });
    try {
      await entered.opened;
      abort.abort();
      await expect(request.result).rejects.toMatchObject({ code: "cancelled" });
      expect(settled).toBe(false);
    } finally { resume.open(); }
    await request.settled;
    expect(settled).toBe(true);
  });

  it.each(["resolveRequest", "authenticateRequest"] as const)("%s discards a result completed after disposal starts", async method => {
    const { runtime, resolveSession, session } = fixture();
    const entered = gate(), resume = gate();
    resolveSession.mockImplementationOnce(async () => { entered.open(); await resume.opened; return session; });
    const request = runtime[method](new Headers());
    let disposal: Promise<void> | undefined;
    try { await entered.opened; disposal = runtime.dispose(); } finally { resume.open(); }
    await expect(request.result).resolves.toBeNull();
    await request.settled;
    await disposal;
  });

  it.each(["resolveRequest", "authenticateRequest"] as const)("%s discards a result when storage becomes unavailable", async method => {
    const { runtime, storage, resolveSession, session } = fixture();
    const entered = gate(), resume = gate();
    resolveSession.mockImplementationOnce(async () => { entered.open(); await resume.opened; return session; });
    const request = runtime[method](new Headers());
    try { await entered.opened; vi.spyOn(storage, "available").mockReturnValue(false); } finally { resume.open(); }
    await expect(request.result).resolves.toBeNull();
    await request.settled;
  });

  it("rejects unsupported authority immediately while legacy resolve retains its password-only fallback", async () => {
    const { runtime, storage, resolveSession, state } = fixture(false);
    const borrow = vi.spyOn(storage, "borrow");
    for (const method of ["resolveRequest", "authenticateRequest"] as const) {
      const request = runtime[method](new Headers());
      let settled = false;
      void request.settled.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(true);
      await expect(request.result).rejects.toMatchObject({ code: "provider_unavailable" });
    }
    expect(borrow).not.toHaveBeenCalled();
    expect(resolveSession).not.toHaveBeenCalled();
    await expect(runtime.resolve(new Headers())).resolves.toMatchObject({ principalId: state.principalId, session: { authentication: { method: "password", factors: 1 } } });
  });
});
