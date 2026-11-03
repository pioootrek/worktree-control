import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeIsolatedBrowserAuthentication } from "@/server/bootstrap/authentication";
import { AuthenticationProtectionQueries } from "@/server/infrastructure/sqlite/authentication-protection-queries";
import { AuthenticationSessionIssuanceQueries } from "@/server/infrastructure/sqlite/authentication-session-issuance-queries";
import { loadAuthenticationProvider } from "@/server/modules/authentication";
import type { ProofFaultInjection } from "../src/index";
import { browserFixture, TRANSPORT_LIMITS, type BrowserClient, type BrowserFixture, type HttpResult } from "./browser-authentication-fixture";
import { betweenResultAndRelease, enableTotp, enrollPasskey, enrollTotp, live, options, passkeyLogin, post, refused, S, signIn, stage, strength, totpLogin, unauthenticated } from "./browser-factor-helpers";
import { BASE_URL, cleanupRoots, count, IP_HEADER, ORIGIN, OWNER_EMAIL, OWNER_PASSWORD, PROVIDER_ENTRY, readyIssuance, SECRET, SESSION_POLICY, storeFixture } from "./fixture";
import { advance, factorOptions, protectionState, STEP } from "./integrated-fixture";
import { PasskeyAuthenticator } from "./passkey-authenticator";
import { cleanupStrictRoots, gate, sleep } from "./strict-fixture";

const NEW_PASSWORD = "fixture-new-password-2";
const LOGIN = "/api/auth/sign-in/email";
const opened: BrowserFixture[] = [];
interface Setup { faults?: ProofFaultInjection; connection?: object; maxInFlight?: number; unreleased?: number }
const create = async ({ faults = {}, connection = {}, maxInFlight = 8, unreleased }: Setup = {}) => {
  const f = await browserFixture(faults, connection, maxInFlight, factorOptions(), TRANSPORT_LIMITS, unreleased);
  opened.push(f);
  return f;
};
const sessions = async (f: BrowserFixture) => (await protectionState(f)).sessions;
const rows = (f: BrowserFixture) => count(f.path, "authentication_ba_session");
const settledSessions = (f: BrowserFixture, expected: readonly string[]) => vi.waitFor(async () => expect(await sessions(f)).toEqual(expected));
const failDeletion = (faults: ProofFaultInjection) => { faults.beforeSessionDelete = async () => { throw new Error("fixture cleanup failure"); }; };
/** Takes the fixture out of `afterEach`, for a test that asserts its disposal outcome. */
const closeListeners = async (f: BrowserFixture) => { opened.splice(opened.indexOf(f), 1); await f.http.close(); };
/** A real login whose client vanishes after the provider result, before final release. */
const losingResponses = (f: BrowserFixture) => {
  const handle = vi.spyOn(f.adapter, "handle");
  let current: ReturnType<BrowserClient["start"]> | undefined;
  // Wait for the server's own close, not a duration: a response still open would really be published.
  betweenResultAndRelease(f, "sign-in", async () => {
    const response = handle.mock.calls.at(-1)?.[1], closed = response && new Promise(resolve => { response.once("close", resolve); });
    const lost = current;
    current = undefined;
    lost?.abort();
    if (lost) await closed;
  });
  return async () => {
    const before = handle.mock.results.length, call = f.client().start(LOGIN);
    call.completed.catch(() => undefined);
    current = call;
    call.send(JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }));
    await vi.waitFor(() => expect(handle.mock.results.length).toBe(before + 1));
    await handle.mock.results[before]!.value;
  };
};
const directLogin = (f: BrowserFixture) => f.runtime.browser("sign-in", new Request(`${ORIGIN}/api/auth/sign-in/email`, { method: "POST",
  headers: new Headers({ origin: ORIGIN, "content-type": "application/json", [IP_HEADER]: "198.18.3.3" }), body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }) })).result;
/** Armed by the session write, so it never hits a separate charge COMMIT. */
const lostAcknowledgment = (faults: ProofFaultInjection) => { faults.sqlFault = { sql: /^commit$/i, when: "after", remaining: 1, afterSql: /^insert into "authentication_ba_session"/i }; };
const knownCommitted = (result: HttpResult) => {
  expect(result).toMatchObject({ status: 503, body: { code: "completion_unconfirmed", committed: true } });
  expect(live(result)).toEqual([]);
};
const unknownOutcome = (result: HttpResult) => {
  expect(result).toMatchObject({ status: 503, body: { code: "completion_unconfirmed" } });
  expect(result.body).not.toHaveProperty("committed");
  expect(live(result)).toEqual([]);
};
const slotHeld = async (client: BrowserClient) => (await client.call(LOGIN, { raw: "{}" })).status === 503;

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-02T12:00:05Z")); });
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const f of opened.splice(0)) await f.close();
  cleanupStrictRoots();
  cleanupRoots();
});

describe("bounded ownership of unreleased sessions", () => {
  it("stays within its bound across renewed rate windows, refuses before minting and recovers the retained rows", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults, unreleased: 3 }), kept = await f.client().authenticated(), lose = losingResponses(f);
    const unrelated = await sessions(f);
    failDeletion(faults);
    for (let index = 0; index < 7; index++) { advance(61_000); await lose(); }
    expect(rows(f)).toBe(1 + 3);
    advance(61_000);
    const before = await sessions(f), client = f.client();
    refused(await signIn(client), 503, "database_busy");
    expect(client.jar.size).toBe(0);
    expect(await sessions(f)).toEqual(before);
    delete faults.beforeSessionDelete;
    advance(61_000);
    const after = await signIn(client);
    expect(after).toMatchObject({ status: 200, body: { authenticated: true } });
    expect(await sessions(f)).toHaveLength(2);
    expect(await sessions(f)).toEqual(expect.arrayContaining(unrelated));
    await strength(kept, "password"); await strength(client, "password");
  });

  it("refuses already queued issuers inside their actual borrow, before any native work", async () => {
    const f = await create({ unreleased: 1 }), entered = gate(), letGo = gate(), finish = gate();
    betweenResultAndRelease(f, "sign-in", () => finish.opened);
    const hold = f.run(async () => { entered.open(); await letGo.opened; });
    await entered.opened;
    const calls = [f.client(), f.client(), f.client()].map(client => signIn(client));
    await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedProviders).toBe(3));
    letGo.open(); await hold;
    await vi.waitFor(() => expect(f.store.admissionSnapshot()).toMatchObject({ queuedProviders: 0, providerExecutions: 0 }));
    expect(rows(f)).toBe(1);
    finish.open();
    const results = await Promise.all(calls);
    expect(results.map(result => result.status).sort()).toEqual([200, 503, 503]);
    expect(rows(f)).toBe(1);
  });

  it("does not retain a row that was deleted despite a failing notification", async () => {
    const f = await create({ unreleased: 1 }), lose = losingResponses(f);
    f.evidence.failInvalidation = true;
    await lose(); await lose();
    f.evidence.failInvalidation = false;
    expect(rows(f)).toBe(0);
    await closeListeners(f);
    await expect(f.runtime.dispose()).resolves.toBeUndefined();
    await f.store.closeAfterDrain();
  });

  it("retries retained cleanup at disposal, and confirms it only once the rows are gone", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), lose = losingResponses(f);
    failDeletion(faults);
    await lose(); await lose();
    expect(rows(f)).toBe(2);
    delete faults.beforeSessionDelete;
    await closeListeners(f);
    await expect(f.runtime.dispose()).resolves.toBeUndefined();
    await f.store.closeAfterDrain();
    expect(rows(f)).toBe(0);
  });

  it("reports unconfirmed disposal while a failed HTTP discard keeps its row", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), lose = losingResponses(f);
    failDeletion(faults);
    await lose();
    await closeListeners(f);
    await expect(f.runtime.dispose()).rejects.toMatchObject({ code: "disposal_unconfirmed" });
    delete faults.beforeSessionDelete;
    await f.store.closeAfterDrain();
    expect(rows(f)).toBe(1);
  });

  it("keeps no cookie for a discarded release, even when its cleanup failed", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), release = await directLogin(f);
    expect(f.runtime.browserReleaseHeaders(release).getSetCookie().length).toBeGreaterThan(0);
    failDeletion(faults);
    await f.runtime.discardBrowserRelease(release).settled;
    expect(f.runtime.browserReleaseHeaders(release).getSetCookie()).toEqual([]);
    expect(rows(f)).toBe(1);
    delete faults.beforeSessionDelete;
  });

  it("refuses a release whose session is already being cleaned up", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), release = await directLogin(f);
    await f.runtime.discardBrowserRelease(release).settled;
    await f.run(() => { expect(() => f.runtime.finishBrowserRelease(release)).toThrow(); });
    expect(rows(f)).toBe(0);
  });

  it("requires a valid explicit bound, and no session work runs without one", async () => {
    const store = storeFixture();
    await readyIssuance(store.store);
    const load = (unreleasedSessions: number | undefined) => loadAuthenticationProvider({ entry: PROVIDER_ENTRY, providerId: "better-auth",
      storage: store.store.authenticationProviderStorage(), unreleasedSessions, ...(unreleasedSessions === undefined ? {} : SESSION_POLICY), options: { baseURL: BASE_URL, secret: SECRET, clientIpHeader: IP_HEADER } });
    try {
      for (const bound of [0, -1, 1.5]) await expect(load(bound)).rejects.toMatchObject({ code: "provider_unavailable" });
      const runtime = await load(undefined);
      await expect(runtime.browser("sign-in", new Request(`${ORIGIN}/api/auth/sign-in/email`, { method: "POST", headers: { origin: ORIGIN, [IP_HEADER]: "198.18.3.4" }, body: "{}" })).result)
        .rejects.toMatchObject({ code: "invalid_input" });
      expect(() => composeIsolatedBrowserAuthentication({ runtime, origin: ORIGIN, limits: TRANSPORT_LIMITS } as never)).toThrow();
      await runtime.dispose();
    } finally { await store.store.closeAfterDrain(); }
  });
});

describe("a known COMMIT whose acknowledgment was lost", () => {
  it("removes only the new TOTP session and keeps its receipt, step and replay refusal", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), authenticator = await enrollTotp(await f.client().authenticated());
    const unrelated = f.client();
    await totpLogin(unrelated, authenticator);
    const kept = await sessions(f), client = f.client();
    advance(STEP * 2);
    expect((await signIn(client)).status).toBe(200);
    const before = await protectionState(f), code = authenticator.code();
    lostAcknowledgment(faults);
    const result = await post(client, "two-factor/verify-totp", { code });
    faults.sqlFault = undefined;
    knownCommitted(result);
    await settledSessions(f, kept);
    const after = await protectionState(f);
    expect(after.step).toBeGreaterThan(before.step!);
    expect(after.receipts.at(-1)).toMatchObject({ purpose: "totp_login", state: "succeeded" });
    expect(after.evidence.map(row => row.session_id)).toEqual(kept);
    refused(await post(client, "two-factor/verify-totp", { code }));
    await strength(unrelated, "password_totp");
  });

  it("removes only the new passkey session and keeps its counter and receipt", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), authenticator = await enrollPasskey(await f.client().authenticated());
    const unrelated = f.client();
    expect((await passkeyLogin(unrelated, authenticator, { counter: 1 })).status).toBe(200);
    const kept = await sessions(f), client = f.client(), pending = await options(client, "authenticate"), assertion = authenticator.assert(pending, { counter: 2 });
    lostAcknowledgment(faults);
    const result = await post(client, "passkey/verify-authentication", { response: assertion });
    faults.sqlFault = undefined;
    knownCommitted(result);
    await settledSessions(f, kept);
    const after = await protectionState(f);
    expect(after.receipts.at(-1)).toMatchObject({ purpose: "passkey_authentication", state: "succeeded" });
    expect(after.credentials).toEqual([{ counter: 2 }]);
    refused(await post(client, "passkey/verify-authentication", { response: assertion }));
    await strength(unrelated, "passkey_uv");
  });

  it("removes a plain password session, and never touches the session its request carried", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), client = await f.client().authenticated(), kept = await sessions(f);
    lostAcknowledgment(faults);
    const result = await signIn(client);
    faults.sqlFault = undefined;
    knownCommitted(result);
    await settledSessions(f, kept);
    await strength(client, "password");
  });

  it("keeps a replaced password and its revocations, and removes the unreleased replacement session", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), client = await f.client().authenticated(), other = await f.client().authenticated();
    lostAcknowledgment(faults);
    const result = await client.call("/api/auth/change-password", { body: { currentPassword: OWNER_PASSWORD, newPassword: NEW_PASSWORD } });
    faults.sqlFault = undefined;
    knownCommitted(result);
    await settledSessions(f, []);
    expect((await protectionState(f)).evidence).toEqual([]);
    await unauthenticated(client); await unauthenticated(other);
    advance(61_000);
    refused(await f.client().login());
    expect((await f.client().login(NEW_PASSWORD)).status).toBe(200);
  });

  it("keeps a failed notification's classification, and still removes the unreleased replacement", async () => {
    const f = await create(), client = await f.client().authenticated();
    f.evidence.failInvalidation = true;
    const result = await client.call("/api/auth/change-password", { body: { currentPassword: OWNER_PASSWORD, newPassword: NEW_PASSWORD } });
    expect(result).toMatchObject({ status: 500, body: { code: "committed_notification_failed", committed: true } });
    expect(live(result)).toEqual([]);
    await settledSessions(f, []);
    f.evidence.failInvalidation = false;
    expect((await f.client().login(NEW_PASSWORD)).status).toBe(200);
  });

  it("retains the session when its deletion fails, and removes it once deletion works", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults, unreleased: 1 }), client = await f.client().authenticated(), kept = await sessions(f);
    lostAcknowledgment(faults); failDeletion(faults);
    knownCommitted(await signIn(f.client()));
    faults.sqlFault = undefined;
    await vi.waitFor(() => expect(rows(f)).toBe(2));
    advance(61_000);
    refused(await signIn(f.client()), 503, "database_busy");
    expect(rows(f)).toBe(2);
    delete faults.beforeSessionDelete;
    advance(61_000);
    const fresh = f.client();
    expect((await signIn(fresh)).status).toBe(200);
    expect(await sessions(f)).toEqual(expect.arrayContaining(kept));
    expect(rows(f)).toBe(2);
    await strength(client, "password"); await strength(fresh, "password");
  });

  it("keeps a nonauthorizing staged result's original session", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), client = await f.client().authenticated(), kept = await sessions(f);
    const authenticator = new PasskeyAuthenticator(), pending = await options(client, "register");
    faults.sqlFault = { sql: /^commit$/i, when: "after", remaining: 1, afterSql: /^insert into "authentication_ba_passkey"/i };
    const result = await post(client, "passkey/verify-registration", { response: authenticator.register(pending, { attestationNone: true }) });
    faults.sqlFault = undefined;
    knownCommitted(result);
    await sleep(20);
    expect(await sessions(f)).toEqual(kept);
    await strength(client, "password");
  });

  it("keeps an enrollment's selection and adds no cleanup of its own", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults, unreleased: 1 }), client = await f.client().authenticated(), authenticator = await enableTotp(client);
    lostAcknowledgment(faults);
    const result = await post(client, "two-factor/verify-totp", { code: authenticator.code() });
    faults.sqlFault = undefined;
    knownCommitted(result);
    expect((await protectionState(f)).policy).toMatchObject({ totp_selected: 1 });
    expect(await sessions(f)).toEqual([]);
    await closeListeners(f);
    await expect(f.runtime.dispose()).resolves.toBeUndefined();
    await f.store.closeAfterDrain();
  });
});

describe("outcomes that prove no COMMIT", () => {
  const commitFault = (faults: ProofFaultInjection, statement: RegExp, remaining: number) => { faults.sqlFault = { sql: statement, when: "before", remaining, afterSql: /^insert into "authentication_ba_session"/i }; };
  it("a rolled back COMMIT leaves nothing to clean, without using the bound", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults, unreleased: 1 }), client = await f.client().authenticated(), kept = await sessions(f);
    commitFault(faults, /^commit$/i, 1);
    const result = await signIn(client);
    faults.sqlFault = undefined;
    expect(result.status).toBeGreaterThanOrEqual(500);
    expect(result.body).not.toHaveProperty("committed"); expect(live(result)).toEqual([]);
    expect(await sessions(f)).toEqual(kept);
    advance(61_000);
    expect((await signIn(f.client())).status).toBe(200);
  });

  it("failed COMMIT and ROLLBACK stay unknown, and the owner's forced rollback then proves no session exists", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), client = await f.client().authenticated(), kept = await sessions(f);
    commitFault(faults, /^(commit|rollback)$/i, 2);
    const result = await signIn(client);
    faults.sqlFault = undefined;
    unknownOutcome(result);
    expect(f.store.admissionSnapshot().state).toBe("provider_closed");
    await closeListeners(f);
    await expect(f.runtime.dispose()).resolves.toBeUndefined();
    await f.store.closeAfterDrain();
    expect(count(f.path, "authentication_ba_session")).toBe(kept.length);
  });
});

describe("reconciliation failures", () => {
  it("an unreadable receipt stays unknown, and the login's own session is still removed", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), authenticator = await enrollTotp(await f.client().authenticated()), client = f.client();
    advance(STEP * 2);
    expect((await signIn(client)).status).toBe(200);
    const original = AuthenticationProtectionQueries.prototype.receipt;
    lostAcknowledgment(faults);
    vi.spyOn(AuthenticationProtectionQueries.prototype, "receipt").mockImplementation(function (this: AuthenticationProtectionQueries, attemptId) {
      if (faults.sqlFault?.remaining === 0) throw new Error("fixture receipt fault");
      return original.call(this, attemptId);
    });
    const result = await post(client, "two-factor/verify-totp", { code: authenticator.code() });
    faults.sqlFault = undefined;
    unknownOutcome(result);
    await settledSessions(f, []);
  });

  it("an unreadable session row keeps cleanup owned until it can be read", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults, unreleased: 1 }), client = await f.client().authenticated(), kept = await sessions(f);
    const original = AuthenticationSessionIssuanceQueries.prototype.state;
    lostAcknowledgment(faults);
    const read = vi.spyOn(AuthenticationSessionIssuanceQueries.prototype, "state").mockImplementation(function (this: AuthenticationSessionIssuanceQueries, sessionId) {
      if (faults.sqlFault?.remaining === 0) throw new Error("fixture session fault");
      return original.call(this, sessionId);
    });
    knownCommitted(await signIn(f.client()));
    // Unreadable is not pending. Nothing deletes a session whose durable state it cannot classify.
    await sleep(10);
    expect(await sessions(f)).toHaveLength(kept.length + 1);
    advance(61_000);
    refused(await signIn(f.client()), 503, "database_busy");
    read.mockRestore();
    faults.sqlFault = undefined;
    advance(61_000);
    expect((await signIn(f.client())).status).toBe(200);
    expect(await sessions(f)).toHaveLength(kept.length + 1);
    await strength(client, "password");
  });
});

describe("cleanup that outlives its public timeout", () => {
  const cookieFailure = (f: BrowserFixture) => {
    const original = f.runtime.browserReleaseHeaders.bind(f.runtime);
    vi.spyOn(f.runtime, "browserReleaseHeaders").mockImplementation(release => {
      const headers = new Headers(original(release));
      headers.append("set-cookie", "__Secure-wtc.trust_device=forged; Path=/; HttpOnly; Secure; SameSite=Strict");
      return headers;
    });
  };
  const held = (faults: ProofFaultInjection, stage: "beforeSessionDelete" | "afterSessionDelete") => {
    const entered = gate(), release = gate();
    faults[stage] = async () => { entered.open(); await release.opened; };
    return { entered, release };
  };

  it("holds the accepted slot and the owner until the callback really ends, and reports the kept row", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults, connection: { borrowTimeoutMs: 1000 }, maxInFlight: 1 }), probe = f.client();
    cookieFailure(f);
    const { entered, release } = held(faults, "beforeSessionDelete");
    const pending = f.client().login();
    await entered.opened;
    expect(await pending).toMatchObject({ status: 502, body: { code: "provider_failed" } });
    expect(f.store.admissionSnapshot()).toMatchObject({ state: "provider_closed", providerExecutions: 1 });
    expect(await slotHeld(probe)).toBe(true);
    release.open();
    await vi.waitFor(() => expect(f.store.admissionSnapshot().providerExecutions).toBe(0));
    await vi.waitFor(async () => expect(await slotHeld(probe)).toBe(false));
    expect(rows(f)).toBe(1);
    await closeListeners(f);
    await expect(f.runtime.dispose()).rejects.toMatchObject({ code: "disposal_unconfirmed" });
    delete faults.beforeSessionDelete;
    await f.store.closeAfterDrain();
  });

  it("lets no other issuer past the bound while that callback runs", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults, connection: { borrowTimeoutMs: 1000 }, maxInFlight: 3, unreleased: 1 });
    cookieFailure(f);
    const { entered, release } = held(faults, "beforeSessionDelete");
    const pending = f.client().login();
    await entered.opened;
    const queued = f.client().login();
    expect((await pending).status).toBe(502);
    expect((await queued).status).toBe(503);
    expect(rows(f)).toBe(1);
    release.open();
    await vi.waitFor(() => expect(f.store.admissionSnapshot().providerExecutions).toBe(0));
    await closeListeners(f);
    await expect(f.runtime.dispose()).rejects.toMatchObject({ code: "disposal_unconfirmed" });
    delete faults.beforeSessionDelete;
    await f.store.closeAfterDrain();
  });

  it("reconciles a row that was deleted before the timeout, so disposal is not falsely unconfirmed", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults, connection: { borrowTimeoutMs: 1000 }, maxInFlight: 1 }), probe = f.client();
    cookieFailure(f);
    const { entered, release } = held(faults, "afterSessionDelete");
    const pending = f.client().login();
    await entered.opened;
    expect((await pending).status).toBe(502);
    expect(rows(f)).toBe(0);
    expect(await slotHeld(probe)).toBe(true);
    release.open();
    await vi.waitFor(() => expect(f.store.admissionSnapshot().providerExecutions).toBe(0));
    await vi.waitFor(async () => expect(await slotHeld(probe)).toBe(false));
    delete faults.afterSessionDelete;
    await closeListeners(f);
    await expect(f.runtime.dispose()).resolves.toBeUndefined();
    await f.store.closeAfterDrain();
  });
});

describe("existing credential refusals", () => {
  it("still answers 401 for a bad signature, with no session to clean", async () => {
    const f = await create({ unreleased: 1 }), client = await f.client().authenticated(), authenticator = await stage(client);
    const kept = await sessions(f);
    refused(await post(client, "passkey/verify-confirmation", { response: authenticator.assert(await options(client, "confirm"), { tamper: true, counter: 0 }) }));
    expect(await sessions(f)).toEqual(kept);
    expect(client.jar.has(S)).toBe(true);
  });
});
