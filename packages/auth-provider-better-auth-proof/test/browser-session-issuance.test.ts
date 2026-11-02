import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationSessionIssuanceQueries } from "@/server/infrastructure/sqlite/authentication-session-issuance-queries";
import { loadAuthenticationProvider, SessionIssuance } from "@/server/modules/authentication";
import type { ProofFaultInjection } from "../src/index";
import { browserFixture, TRANSPORT_LIMITS, type BrowserFixture } from "./browser-authentication-fixture";
import { live, post, refused, S, signIn, strength, unauthenticated } from "./browser-factor-helpers";
import { BASE_URL, Client, cleanupRoots, count, IP_HEADER, ISSUANCE, loadProof, ORIGIN, OWNER_EMAIL, OWNER_PASSWORD, PROVIDER_ENTRY, SECRET, SESSION_POLICY, storeFixture } from "./fixture";
import { advance, factorOptions, select, sql } from "./integrated-fixture";
import { cleanupStrictRoots, gate, sleep, strictProof } from "./strict-fixture";

const NEW_PASSWORD = "fixture-new-password-2";
const HOUR = 3_600_000;
const opened: BrowserFixture[] = [];
interface Setup { faults?: ProofFaultInjection; unreleased?: number; rows?: number; batch?: number }
const create = async ({ faults = {}, unreleased = 4, rows = SESSION_POLICY.sessionRows, batch = 1 }: Setup = {}) => {
  const f = await browserFixture(faults, {}, 8, factorOptions(), TRANSPORT_LIMITS, unreleased, { sessionRows: rows, sessionReconcileBatch: batch });
  opened.push(f);
  return f;
};
const take = (f: BrowserFixture) => { opened.splice(opened.indexOf(f), 1); };
const markers = (f: BrowserFixture) => select<{ session_id: string; state: string; original_deadline: string }>(f, "SELECT session_id, state, original_deadline FROM authentication_session_issuance ORDER BY session_id");
const sessions = (f: BrowserFixture) => select<{ id: string }>(f, 'SELECT "id" AS id FROM "authentication_ba_session" ORDER BY "id"').then(rows => rows.map(row => row.id));
const insertUnmarked = (f: BrowserFixture, id: string, subject: string, expires = "2099-01-01T00:00:00.000Z") => sql(f,
  'INSERT INTO "authentication_ba_session"("id","expiresAt","token","createdAt","updatedAt","userId") VALUES(?,?,?,?,?,?)', [id, expires, `token-${id}`, "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z", subject]);
const directLogin = (f: BrowserFixture) => f.runtime.browser("sign-in", new Request(`${ORIGIN}/api/auth/sign-in/email`, { method: "POST",
  headers: new Headers({ origin: ORIGIN, "content-type": "application/json", [IP_HEADER]: "198.18.3.3" }), body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }) })).result;
/** Runs the real statement, then loses its acknowledgment: what a caller sees after a real COMMIT. */
const loseMarkAcknowledgment = () => {
  const original = AuthenticationSessionIssuanceQueries.prototype.markMayPublish;
  return vi.spyOn(AuthenticationSessionIssuanceQueries.prototype, "markMayPublish").mockImplementation(function (this: AuthenticationSessionIssuanceQueries, id, deadline) {
    original.call(this, id, deadline);
    throw new Error("fixture lost acknowledgment");
  });
};

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-02T12:00:05Z")); });
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const f of opened.splice(0)) await f.close();
  cleanupStrictRoots();
  cleanupRoots();
});

describe("durable publication", () => {
  it("commits may_publish before the cookie leaves, and a delivered session keeps its durable row", async () => {
    const f = await create({ rows: 2 }), order: string[] = [], mark = AuthenticationSessionIssuanceQueries.prototype.markMayPublish, handle = f.adapter.handle.bind(f.adapter);
    vi.spyOn(AuthenticationSessionIssuanceQueries.prototype, "markMayPublish").mockImplementation(function (this: AuthenticationSessionIssuanceQueries, id, deadline) {
      const moved = mark.call(this, id, deadline);
      order.push(this.state(id));
      return moved;
    });
    vi.spyOn(f.adapter, "handle").mockImplementation((request, response) => {
      const writeHead = response.writeHead.bind(response);
      response.writeHead = ((...input: Parameters<typeof writeHead>) => { order.push("write"); return writeHead(...input); }) as typeof response.writeHead;
      return handle(request, response);
    });
    const client = await f.client().authenticated();
    expect(order).toEqual(["may_publish", "write"]);
    const [row] = await markers(f);
    expect(row).toMatchObject({ state: "may_publish" });
    expect(await select(f, "SELECT original_deadline FROM authentication_session_evidence")).toEqual([{ original_deadline: row!.original_deadline }]);
    // Delivery freed U. It did not free B.
    await f.client().authenticated();
    refused(await signIn(f.client()), 503, "database_busy");
    await strength(client, "password");
  });

  it("writes nothing and marks nothing while the client is gone before the final phase", async () => {
    const f = await create(), release = await directLogin(f);
    expect(await markers(f)).toEqual([expect.objectContaining({ state: "pending" })]);
    await f.runtime.discardBrowserRelease(release).settled;
    expect(await markers(f)).toEqual([]);
    expect(count(f.path, "authentication_ba_session")).toBe(0);
  });

  it("emits nothing when the mark throws after its COMMIT, and keeps what may have been published", async () => {
    const f = await create({ unreleased: 1 }), lost = loseMarkAcknowledgment(), client = f.client();
    const result = await signIn(client);
    expect(result).toMatchObject({ status: 503, body: { code: "completion_unconfirmed" } });
    expect(live(result)).toEqual([]); expect(client.jar.has(S)).toBe(false);
    await vi.waitFor(async () => expect(await markers(f)).toEqual([expect.objectContaining({ state: "may_publish" })]));
    lost.mockRestore();
    // The local claim ended by classification, so U is free. The row stays counted.
    expect((await signIn(f.client())).status).toBe(200);
    expect(count(f.path, "authentication_ba_session")).toBe(2);
  });

  it("removes a session whose mark failed before committing", async () => {
    const f = await create(), kept = await f.client().authenticated(), rows = await sessions(f);
    const failed = vi.spyOn(AuthenticationSessionIssuanceQueries.prototype, "markMayPublish").mockImplementation(() => { throw new Error("fixture mark failure"); });
    const result = await signIn(f.client());
    expect(result).toMatchObject({ status: 503, body: { code: "completion_unconfirmed" } });
    expect(live(result)).toEqual([]);
    await vi.waitFor(async () => expect(await sessions(f)).toEqual(rows));
    failed.mockRestore();
    await strength(kept, "password");
  });

  it("treats a refused mark as a refusal, and never as licence to delete", async () => {
    const f = await create(), release = await directLogin(f);
    await sql(f, "UPDATE authentication_session_issuance SET state = 'may_publish'");
    await f.run(() => { expect(() => f.runtime.finishBrowserRelease(release)).toThrow(); });
    // Already may_publish: the failed CAS is not licence to delete it.
    await f.runtime.discardBrowserRelease(release).settled;
    expect(await markers(f)).toEqual([expect.objectContaining({ state: "may_publish" })]);
    expect(f.runtime.browserReleaseHeaders(release).getSetCookie()).toEqual([]);
    await vi.waitFor(() => expect(f.store.admissionSnapshot().providerExecutions).toBe(0));
  });

  it("keeps an unreadable marker uncertain: the session stays, and disposal stays unconfirmed", async () => {
    const f = await create(), lost = loseMarkAcknowledgment();
    const unreadable = vi.spyOn(AuthenticationSessionIssuanceQueries.prototype, "state").mockImplementation(() => { throw new Error("fixture marker fault"); });
    refused(await signIn(f.client()), 503, "completion_unconfirmed");
    await sleep(10);
    expect(count(f.path, "authentication_ba_session")).toBe(1);
    await f.http.close();
    take(f);
    await expect(f.runtime.dispose()).rejects.toMatchObject({ code: "disposal_unconfirmed" });
    unreadable.mockRestore(); lost.mockRestore();
    await f.store.closeAfterDrain();
    expect(count(f.path, "authentication_ba_session")).toBe(1);
  });

  it("retains a marked session when the response write throws, and reports no local cleanup", async () => {
    const f = await create(), handle = f.adapter.handle.bind(f.adapter);
    vi.spyOn(f.adapter, "handle").mockImplementation((request, response) => {
      const writeHead = response.writeHead.bind(response);
      response.writeHead = ((...input: Parameters<typeof writeHead>) => {
        response.writeHead = writeHead;
        if (input[0] === 200) throw new Error("fixture write failure");
        return writeHead(...input);
      }) as typeof response.writeHead;
      return handle(request, response);
    });
    const result = await signIn(f.client());
    expect(result.status).toBe(500);
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(await markers(f)).toEqual([expect.objectContaining({ state: "may_publish" })]);
    expect(count(f.path, "authentication_ba_session")).toBe(1);
    await f.http.close();
    take(f);
    await expect(f.runtime.dispose()).resolves.toBeUndefined();
    await f.store.closeAfterDrain();
    expect(count(f.path, "authentication_ba_session")).toBe(1);
  });

  it("confirms disposal with valid may_publish rows held, and removes pending ones", async () => {
    const f = await create();
    await f.client().authenticated();
    await directLogin(f);
    await f.http.close();
    take(f);
    await expect(f.runtime.dispose()).resolves.toBeUndefined();
    await f.store.closeAfterDrain();
    expect(count(f.path, "authentication_session_issuance")).toBe(1);
    expect(count(f.path, "authentication_ba_session")).toBe(1);
  });

  it("lets a current sign-out end a marked session, which frees its row", async () => {
    const f = await create({ rows: 1 }), client = await f.client().authenticated();
    refused(await signIn(f.client()), 503, "database_busy");
    expect((await post(client, "sign-out", {})).status).toBe(200);
    await unauthenticated(client);
    expect(await markers(f)).toEqual([]);
    expect((await signIn(f.client())).status).toBe(200);
  });
});

describe("the global row bound", () => {
  it("refuses login and password replacement before any verifier or password write", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults, rows: 1 }), client = await f.client().authenticated();
    const write = vi.fn(async () => undefined);
    faults.beforePasswordWrite = write;
    const before = await select(f, 'SELECT "password" FROM "authentication_ba_account"');
    refused(await post(client, "change-password", { currentPassword: OWNER_PASSWORD, newPassword: NEW_PASSWORD }), 503, "database_busy");
    expect(write).not.toHaveBeenCalled();
    expect(await select(f, 'SELECT "password" FROM "authentication_ba_account"')).toEqual(before);
    await strength(client, "password");
  });

  it("counts unmarked rows, however old, and preserves an oversized inherited table", async () => {
    const f = await create({ rows: 2 });
    await insertUnmarked(f, "legacy-a", f.subject, "2026-01-01T00:00:00.000Z");
    await insertUnmarked(f, "legacy-b", f.subject);
    await insertUnmarked(f, "legacy-c", f.subject);
    const before = await sessions(f);
    refused(await signIn(f.client()), 503, "database_busy");
    expect(await sessions(f)).toEqual(before);
    expect(await markers(f)).toEqual([]);
  });

  it("refuses at the post-insert check too, rolling the whole native success back", async () => {
    const f = await create({ rows: 1 }), client = await f.client().authenticated(), rows = await sessions(f);
    const open = vi.spyOn(SessionIssuance.prototype, "roomBeforeMint").mockReturnValue(true);
    const result = await signIn(f.client());
    expect(result.status).toBeGreaterThanOrEqual(500); expect(live(result)).toEqual([]);
    open.mockRestore();
    expect(await sessions(f)).toEqual(rows);
    expect(await markers(f)).toHaveLength(1);
    await strength(client, "password");
  });

  it("rolls a marker failure back with its native success", async () => {
    const f = await create(), kept = await f.client().authenticated(), rows = await sessions(f);
    const failed = vi.spyOn(AuthenticationSessionIssuanceQueries.prototype, "insertPending").mockImplementation(() => { throw new Error("fixture marker fault"); });
    const result = await signIn(f.client());
    expect(result.status).toBeGreaterThanOrEqual(500); expect(live(result)).toEqual([]);
    failed.mockRestore();
    expect(await sessions(f)).toEqual(rows);
    expect(count(f.path, "authentication_session_evidence")).toBe(1);
    await strength(kept, "password");
  });

  it("lets queued issuers see current rows when their own borrow starts", async () => {
    const f = await create({ rows: 2 }), entered = gate(), letGo = gate();
    await f.client().authenticated();
    const hold = f.run(async () => { entered.open(); await letGo.opened; });
    await entered.opened;
    const calls = [signIn(f.client()), signIn(f.client()), signIn(f.client())];
    await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedProviders).toBe(3));
    letGo.open(); await hold;
    expect((await Promise.all(calls)).map(result => result.status).sort()).toEqual([200, 503, 503]);
    expect(count(f.path, "authentication_ba_session")).toBe(2);
  });
});

describe("expiry", () => {
  it("prunes at the exact original deadline only, at most one batch per issuer, and never earlier", async () => {
    const f = await create({ rows: 2, batch: 1 });
    await f.client().authenticated(); await f.client().authenticated();
    const [first] = await markers(f), deadline = Date.parse(first!.original_deadline);
    vi.setSystemTime(deadline - 1);
    refused(await signIn(f.client()), 503, "database_busy");
    expect(count(f.path, "authentication_ba_session")).toBe(2);
    vi.setSystemTime(deadline);
    expect((await signIn(f.client())).status).toBe(200);
    expect(count(f.path, "authentication_ba_session")).toBeLessThanOrEqual(2);
    const rows = await markers(f);
    expect(rows.filter(row => row.original_deadline === first!.original_deadline).length).toBeLessThanOrEqual(1);
  });

  it("never prunes an expired unmarked row or a pending one in a live owner", async () => {
    const f = await create({ rows: 8 });
    await insertUnmarked(f, "legacy", f.subject, "2026-01-01T00:00:00.000Z");
    await directLogin(f);
    advance(9 * HOUR);
    expect((await signIn(f.client())).status).toBe(200);
    expect(await sessions(f)).toContain("legacy");
    expect((await markers(f)).filter(row => row.state === "pending")).toHaveLength(1);
  });

  it("keeps a replacement's inherited deadline in its marker", async () => {
    const f = await create(), client = await f.client().authenticated(), [first] = await markers(f);
    advance(HOUR);
    expect((await post(client, "change-password", { currentPassword: OWNER_PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(200);
    const [next] = await markers(f);
    expect(next).toMatchObject({ state: "may_publish", original_deadline: first!.original_deadline });
    expect(next!.session_id).not.toBe(first!.session_id);
  });
});

describe("owner boot", () => {
  it("loads no issuer before this owner recovered, and recovers once however often it is asked", async () => {
    const f = await create();
    const held = await directLogin(f);
    await f.store.recoverIssuedSessions(SESSION_POLICY);
    expect(await markers(f)).toEqual([expect.objectContaining({ state: "pending" })]);
    await f.run(() => { f.runtime.finishBrowserRelease(held); });
    expect(await markers(f)).toEqual([expect.objectContaining({ state: "may_publish" })]);
    const store = storeFixture();
    try {
      await expect(loadAuthenticationProvider({ entry: PROVIDER_ENTRY, providerId: "better-auth", storage: store.store.authenticationProviderStorage(), ...ISSUANCE,
        options: { baseURL: BASE_URL, secret: SECRET, clientIpHeader: IP_HEADER } })).rejects.toMatchObject({ code: "provider_unavailable" });
    } finally { store.store.close(); }
  });

  it("requires all three bounds together, with no defaults", async () => {
    const store = storeFixture();
    await store.store.recoverIssuedSessions(SESSION_POLICY);
    const load = (bounds: object) => loadAuthenticationProvider({ entry: PROVIDER_ENTRY, providerId: "better-auth", storage: store.store.authenticationProviderStorage(), ...bounds,
      options: { baseURL: BASE_URL, secret: SECRET, clientIpHeader: IP_HEADER } });
    try {
      for (const bounds of [{ unreleasedSessions: 1 }, { sessionRows: 1, sessionReconcileBatch: 1 }, { unreleasedSessions: 1, sessionRows: 1 }, { unreleasedSessions: 1, sessionReconcileBatch: 1 },
        { unreleasedSessions: 1, sessionRows: 0, sessionReconcileBatch: 1 }, { unreleasedSessions: 1, sessionRows: 1, sessionReconcileBatch: 1.5 },
        { unreleasedSessions: 1, sessionRows: Number.MAX_SAFE_INTEGER, sessionReconcileBatch: 1 }]) await expect(load(bounds)).rejects.toMatchObject({ code: "provider_unavailable" });
    } finally { await store.store.closeAfterDrain(); }
  });

  it("initializes a maintenance-only load, which can administer but never mint", async () => {
    const f = await strictProof();
    try {
      const { subject } = await f.runtime.provisionLocal({ principalId: f.owner.principalId, email: OWNER_EMAIL, name: "Owner", password: OWNER_PASSWORD, actor: "test" });
      expect(subject).toBeTruthy();
      await f.runtime.dispose();
      const runtime = await loadAuthenticationProvider({ entry: PROVIDER_ENTRY, providerId: "better-auth", storage: f.store.authenticationProviderStorage(),
        options: { baseURL: BASE_URL, secret: SECRET, clientIpHeader: IP_HEADER } });
      expect(runtime.issuanceBounded).toBe(false);
      expect((await new Client(runtime).signIn()).status).toBe(503);
      await expect(runtime.browser("sign-in", new Request(`${ORIGIN}/api/auth/sign-in/email`, { method: "POST", headers: { origin: ORIGIN, [IP_HEADER]: "198.18.3.4" }, body: "{}" })).result)
        .rejects.toMatchObject({ code: "invalid_input" });
      await runtime.recoverLocal({ principalId: f.owner.principalId, newPassword: NEW_PASSWORD, actor: "test" });
      expect(count(f.path, "authentication_ba_session")).toBe(0);
      await runtime.dispose();
    } finally { await f.store.closeAfterDrain(); }
  });
});

describe("the private raw path", () => {
  it("gives raw minting the same ownership, conservative publication and bound", async () => {
    const f = await create({ rows: 1 }), raw = new Client(f.runtime, "198.18.7.1");
    const response = await raw.signIn();
    expect(response.status).toBe(200);
    expect(await markers(f)).toEqual([expect.objectContaining({ state: "may_publish" })]);
    const second = await new Client(f.runtime, "198.18.7.2").signIn();
    expect(second.status).toBe(503);
    expect(second.headers.getSetCookie()).toEqual([]);
    expect(count(f.path, "authentication_ba_session")).toBe(1);
    expect(await f.runtime.resolve(new Headers({ cookie: raw.cookieHeader() }))).not.toBeNull();
  });

  it("returns no cookie for an uncertain raw result, and its pending row stays counted for the next boot", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults, rows: 1 }), raw = new Client(f.runtime, "198.18.7.3");
    faults.sqlFault = { sql: /^commit$/i, when: "after", remaining: 1, afterSql: /^insert into "authentication_ba_session"/i };
    const response = await raw.signIn();
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await markers(f)).toEqual([expect.objectContaining({ state: "pending" })]);
    expect((await new Client(f.runtime, "198.18.7.4").signIn()).status).toBe(503);
  });

  it("withholds a raw response whose mark failed, and adds nothing to the unreleased bound", async () => {
    const f = await create({ unreleased: 1 });
    const failed = vi.spyOn(AuthenticationSessionIssuanceQueries.prototype, "markMayPublish").mockImplementation(() => { throw new Error("fixture mark failure"); });
    const raw = new Client(f.runtime, "198.18.7.5");
    await expect(raw.signIn()).rejects.toBeInstanceOf(Error);
    expect(raw.cookies.size).toBe(0);
    failed.mockRestore();
    expect((await new Client(f.runtime, "198.18.7.6").signIn()).status).toBe(200);
  });
});

describe("an already recovered owner", () => {
  it("keeps later loaders working, without another sweep", async () => {
    const f = storeFixture();
    const first = await loadProof(f.store);
    await first.runtime.dispose();
    const second = await loadProof(f.store);
    expect(second.runtime.issuanceBounded).toBe(true);
    await second.runtime.dispose();
    await f.store.closeAfterDrain();
  });
});
