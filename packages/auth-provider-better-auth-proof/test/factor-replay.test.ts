import { randomBytes } from "node:crypto";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSqliteConnection } from "../../../src/server/modules/authentication/provider-contract";
import { ADMISSION, FixtureAdmission, replayHmac } from "./factor-admission";
import { Authenticator, Browser, cleanupFactorRoots, closeFactor, factorFixture, factorState, fixtureSql, loadFactorProvider, type FactorFixture } from "./factor-fixture";
import { COOKIE, FACTOR_MODEL } from "./factor-provider";
import { OWNER_PASSWORD, SECRET } from "./fixture";

const fixtures: FactorFixture[] = [];
const create = async () => { const f = await factorFixture("admitted"); fixtures.push(f); return f; };
const rows = <T = Record<string, unknown>>(f: FactorFixture, sql: string, args: readonly unknown[] = []): Promise<T[]> => f.storage.borrow(async () => {
  const db = f.storage.createProviderConnection();
  try { return db.prepare(sql).all(args) as T[]; } finally { db.close(); }
});
const replayRows = (f: FactorFixture) => rows<{ marker: string; attemptId: string }>(f, `SELECT * FROM ${ADMISSION.replay} ORDER BY marker`);
const receipt = async (f: FactorFixture, id = f.control.admission.lastAttemptId!) => (await rows<{ state: string; sessionId: string | null; credential: string }>(f, `SELECT state, sessionId, credential FROM ${ADMISSION.receipts} WHERE attemptId = ?`, [id]))[0];
const charges = async (f: FactorFixture) => (await rows<{ n: number }>(f, `SELECT coalesce(sum(charged),0) n FROM ${ADMISSION.budgets}`))[0]!.n;
const verify = (b: Browser, code: string, init: Parameters<Browser["post"]>[2] = {}) => b.post("/two-factor/verify-totp", { code }, init);
const reauthContext = async (b: Browser) => {
  const result = await b.post("/two-factor/reauthentication-context");
  expect(result.status).toBe(200); expect(result.setCookie.length).toBe(0);
  expect(typeof result.json?.context === "string").toBe(true);
  return result.json!.context as string;
};
const reauth = (b: Browser, context: string, code: string, init: Parameters<Browser["post"]>[2] = {}) => b.post("/two-factor/reauthenticate-totp", { context, code }, init);
const setup = async (f: FactorFixture, confirm = true) => {
  const browser = new Browser(f); expect((await browser.signIn()).status).toBe(200);
  const enabled = await browser.post("/two-factor/enable", { password: OWNER_PASSWORD });
  expect(enabled.status).toBe(200);
  const app = new Authenticator(enabled.json!.totpURI as string);
  // Leave the current presentation unused for focused login/reauthentication.
  const enrollment = [-1, 1].map(n => app.code(n)).find(code => code !== app.code());
  expect(enrollment !== undefined).toBe(true);
  if (confirm) expect((await verify(browser, enrollment!)).status).toBe(200);
  return { browser, app, enrollment: enrollment!, recovery: enabled.json!.backupCodes as string[] };
};
const pending = async (f: FactorFixture) => {
  const browser = new Browser(f); expect((await browser.signIn()).status).toBe(200);
  expect(browser.cookies.has(COOKIE.challenge)).toBe(true); expect(browser.cookies.has(COOKIE.session)).toBe(false);
  return browser;
};
const reload = async (f: FactorFixture) => { await f.runtime.dispose(); Object.assign(f, await loadFactorProvider(f, f.control)); };
const commitFault = (f: FactorFixture, table: string, when: "before" | "after") => {
  f.control.fault = { sql: /^commit$/i, afterSql: new RegExp(`INSERT INTO ${table}`, "i"), when, remaining: 1 };
};
const policy = <T>(f: FactorFixture, call: (p: FixtureAdmission) => T | Promise<T>): Promise<T> => f.storage.borrow(async () => {
  const db = f.storage.createProviderConnection();
  try { return await call(new FixtureAdmission(db, f.control.admission.policy, { key: f.replayKey!, encryptionSecret: SECRET })); } finally { db.close(); }
});
const reencrypt = async (connection: ProviderSqliteConnection) => {
  const row = connection.prepare(`SELECT secret FROM ${FACTOR_MODEL}`).all([])[0] as { secret: string };
  const plaintext = await symmetricDecrypt({ key: SECRET, data: row.secret });
  const ciphertext = await symmetricEncrypt({ key: SECRET, data: plaintext });
  connection.prepare(`UPDATE ${FACTOR_MODEL} SET secret = ?`).run([ciphertext]);
};

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-02T12:00:05Z")); });
afterEach(async () => {
  vi.useRealTimers();
  for (const f of fixtures.splice(0)) { f.control.fault = undefined; f.control.admission.pause = undefined; await closeFactor(f); }
  cleanupFactorRoots();
});

describe("A3-I16 conservative TOTP presentation consumption, actual native verifier", () => {
  it("denies enrollment -> login, including a fresh challenge after the old native challenge is lost", async () => {
    const f = await create(); const enrolled = await setup(f, false); const presentation = enrolled.app.code();
    expect((await verify(enrolled.browser, presentation)).status).toBe(200);
    const before = await factorState(f); await pending(f);
    await fixtureSql(f, "DELETE FROM authentication_ba_verification");
    const fresh = await pending(f); const entries = f.control.admission.entries.length;
    const denied = await verify(fresh, presentation);
    expect(denied.status).toBe(409); expect(denied.setCookie.length).toBe(0);
    expect(f.control.admission.entries.length).toBe(entries); expect((await factorState(f)).sessions).toEqual(before.sessions);
    expect(await replayRows(f)).toHaveLength(1); expect(await charges(f)).toBe(2);
    expect((await receipt(f))?.state).toBe("failed");
  });

  it("denies login -> login across independent challenges, and queued concurrent challenges have exactly one effect", async () => {
    const f = await create(); const { app } = await setup(f);
    f.control.admission.policy.attempts = 8;
    const a = await pending(f), b = await pending(f); const before = await factorState(f);
    const results = await Promise.all([verify(a, app.code()), verify(b, app.code())]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(results.filter(r => r.setCookie.some(c => c.startsWith(`${COOKIE.session}=`))).length).toBe(1);
    expect((await factorState(f)).sessions.length).toBe(before.sessions.length + 1);
    expect(await replayRows(f)).toHaveLength(2);
    expect((await verify(await pending(f), app.code())).status).toBe(409);
    expect(await charges(f)).toBe(4);
  });

  it.each(["login-reauth", "reauth-login", "reauth-reauth"] as const)("denies %s without a new cookie, new login or elevated method", async direction => {
    const f = await create(); const { app, browser } = await setup(f);
    const code = app.code(); const before = await factorState(f);
    if (direction === "login-reauth") expect((await verify(await pending(f), code)).status).toBe(200);
    else {
      const result = await reauth(browser, await reauthContext(browser), code);
      expect(result.status).toBe(200); expect(result.json?.authorizingMfa).toBe(false); expect(result.setCookie.length).toBe(0);
      expect((await factorState(f)).sessions).toEqual(before.sessions);
    }
    const entries = f.control.admission.entries.length;
    const result = direction === "reauth-login" ? await verify(await pending(f), code) : await reauth(browser, await reauthContext(browser), code);
    expect(result.status).toBe(409); expect(result.setCookie.length).toBe(0);
    expect(f.control.admission.entries.length).toBe(entries);
    expect(await replayRows(f)).toHaveLength(2);
    expect((await browser.resolve())?.session.authentication).toEqual({ method: "password", factors: 1 });
    await expect(f.runtime.authenticate(new Headers({ cookie: browser.cookieHeader() }))).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("reauthentication is explicitly one-use even after wrong input, with immutable original session evidence", async () => {
    const f = await create(); const { browser, app } = await setup(f);
    const old = await rows(f, `SELECT * FROM ${ADMISSION.evidence}`);
    const context = await reauthContext(browser);
    expect((await reauth(browser, context, app.wrong())).status).toBe(401);
    expect((await reauth(browser, context, app.code())).status).toBe(401);
    const result = await reauth(browser, await reauthContext(browser), app.code());
    expect(result.status).toBe(200); expect(result.setCookie.length).toBe(0);
    expect(await rows(f, `SELECT * FROM ${ADMISSION.evidence}`)).toEqual(old);
    expect(await charges(f)).toBe(3); expect(await replayRows(f)).toHaveLength(2);
    // The enrollment endpoint cannot be used as a second, less constrained reauth path.
    expect((await verify(browser, app.code(1))).status).toBe(401);
  });

  it("replaces unused reauthentication contexts without exhausting another subject's login capacity", async () => {
    const email = "second-owner@fixture.invalid";
    const f = await factorFixture("admitted", { admission: "strict" }, [email]); fixtures.push(f);
    const { browser, app } = await setup(f);
    const first = await reauthContext(browser); let newest = first;
    for (let i = 0; i < f.control.admission.policy.capacity + 1; i++) newest = await reauthContext(browser);
    expect(await rows(f, `SELECT capability FROM ${ADMISSION.contexts} WHERE purpose='reauthentication' AND used=0`)).toHaveLength(1);
    expect((await reauth(browser, first, app.code())).status).toBe(401);
    const other = new Browser(f);
    expect((await other.post("/sign-in/email", { email, password: OWNER_PASSWORD })).status).toBe(200);
    const enabled = await other.post("/two-factor/enable", { password: OWNER_PASSWORD });
    expect(enabled.status).toBe(200);
    const secondApp = new Authenticator(enabled.json!.totpURI as string);
    expect((await verify(other, secondApp.code())).status).toBe(200);
    const login = new Browser(f);
    expect((await login.post("/sign-in/email", { email, password: OWNER_PASSWORD })).status).toBe(200);
    expect(login.cookies.has(COOKIE.challenge)).toBe(true);
    expect((await reauth(browser, newest, app.code())).status).toBe(200);
  });

  it.each([null, [], 1, "x"])("rejects non-object reauthentication issuance body %# before allocating state", async body => {
    const f = await create(); const { browser } = await setup(f);
    const before = await rows(f, `SELECT count(*) n FROM ${ADMISSION.contexts}`);
    expect((await browser.post("/two-factor/reauthentication-context", body)).status).toBe(400);
    expect(await rows(f, `SELECT count(*) n FROM ${ADMISSION.contexts}`)).toEqual(before);
  });

  it("successfully reauthenticates after native refresh while preserving all original evidence", async () => {
    const f = await create(); const { browser, app } = await setup(f);
    const before = await rows(f, `SELECT * FROM ${ADMISSION.evidence}`);
    vi.setSystemTime(Date.now() + 60 * 60_000 + 1);
    const context = await reauthContext(browser);
    const result = await reauth(browser, context, app.code());
    expect(result.status).toBe(200); expect(result.setCookie.length).toBe(0);
    expect(await rows(f, `SELECT * FROM ${ADMISSION.evidence}`)).toEqual(before);
    expect((await receipt(f))?.state).toBe("succeeded");
  });

  it.each(["2020-01-01T00:00:00.000Z", "invalid-date"])("rejects expired or invalid ISO session rows independently of original evidence (%#)", async expiresAt => {
    const f = await create(); await setup(f);
    const evidence = (await rows<{ sessionId: string }>(f, `SELECT sessionId FROM ${ADMISSION.evidence}`))[0]!;
    expect(await policy(f, p => p.enrollmentOrigin(evidence.sessionId, f.subject, Date.now()))).not.toBeNull();
    await fixtureSql(f, 'UPDATE authentication_ba_session SET "expiresAt"=? WHERE id=?', [expiresAt, evidence.sessionId]);
    expect(await policy(f, p => p.enrollmentOrigin(evidence.sessionId, f.subject, Date.now()))).toBeNull();
  });

  it.each(["2020-01-01T00:00:00.000Z", "invalid-date"])("rejects expired or invalid ISO challenge rows before native verification (%#)", async expiresAt => {
    const f = await create(); await setup(f); const browser = await pending(f);
    const challenge = browser.cookies.get(COOKIE.challenge)!;
    expect(await policy(f, p => p.bindContext(challenge, "login", Date.now()))).not.toBeNull();
    await fixtureSql(f, 'UPDATE authentication_ba_verification SET "expiresAt"=?', [expiresAt]);
    expect(await policy(f, p => p.bindContext(challenge, "login", Date.now()))).toBeNull();
  });

  it.each(["", "12345", "1234567", " 123456", "123456\n", "１２３４５６", "١٢٣٤٥٦", "12e345", "12\u0000345"])("refuses non-exact ASCII input case %# before native evaluation", async code => {
    const f = await create(); const { browser } = await setup(f);
    const context = await reauthContext(browser); const entries = f.control.admission.entries.length, charged = await charges(f);
    const result = await reauth(browser, context, code);
    expect(result.status).toBe(400); expect(result.setCookie.length).toBe(0);
    expect(f.control.admission.entries.length).toBe(entries); expect(await charges(f)).toBe(charged); expect(await replayRows(f)).toHaveLength(1);
  });

  it("preserves leading zeros and uses unambiguous, versioned keyed identities", async () => {
    const f = await create(); const { app } = await setup(f);
    const start = Date.now(); let instant = start;
    while (!app.codeAt(instant).startsWith("0")) instant += 30_000;
    vi.setSystemTime(instant); const code = app.code(); expect(/^0[0-9]{5}$/.test(code)).toBe(true);
    const b = await pending(f); const result = await verify(b, code); expect(result.status).toBe(200);
    const r = (await receipt(f))!;
    const expected = replayHmac(f.replayKey!, "presentation", "better-auth", f.subject, r.credential, code);
    expect((await replayRows(f)).some(row => row.marker === expected)).toBe(true);
    expect(expected === replayHmac(f.replayKey!, "presentation", "better-auth", f.subject, r.credential, String(Number(code)))).toBe(false);
    expect(replayHmac(f.replayKey!, "presentation", "a:b", "c") === replayHmac(f.replayKey!, "presentation", "a", "b:c")).toBe(false);
    expect((await verify(await pending(f), code)).status).toBe(409);
  });

  it.each([-1, 1])("the native %s step window presentation stays consumed across the next boundary", async offset => {
    const f = await create(); const { browser, app } = await setup(f, false);
    vi.setSystemTime(new Date("2026-11-02T12:00:29.999Z"));
    const code = app.code(offset); expect((await verify(browser, code)).status).toBe(200);
    vi.setSystemTime(Date.now() + 1);
    const b = await pending(f); expect((await verify(b, code)).status).toBe(409);
    expect(await replayRows(f)).toHaveLength(1);
  });

  it.each([-2, 2])("native validity still refuses a fresh out-of-window %s step presentation", async offset => {
    const f = await create(); const { browser, app } = await setup(f, false);
    let code = app.code(offset);
    // In the rare decimal collision with the window, use another independent time.
    while ([-1, 0, 1].some(n => app.code(n) === code)) { vi.setSystemTime(Date.now() + 30_000); code = app.code(offset); }
    expect((await verify(browser, code)).status).toBe(401); expect(await replayRows(f)).toHaveLength(0);
    expect(await charges(f)).toBe(1);
  });

  it("clock forward, reversal, pruning and same-key provider reload never free a consumed presentation", async () => {
    const f = await create(); const { browser, app } = await setup(f, false); const start = Date.now(), code = app.code();
    expect((await verify(browser, code)).status).toBe(200); const retained = await replayRows(f);
    vi.setSystemTime(start + 86_400_000); await policy(f, p => p.prune(Date.now())); await reload(f);
    expect(await replayRows(f)).toEqual(retained);
    expect((await verify(await pending(f), code)).status).toBe(409);
    vi.setSystemTime(start);
    expect((await verify(await pending(f), code)).status).toBe(409);
    expect(await replayRows(f)).toEqual(retained);
    // A different still-valid native code succeeds after the reload.
    expect((await verify(await pending(f), app.code(1))).status).toBe(200);
  });

  it("a fixed independently established later decimal collision is valid natively but conservatively refused", async () => {
    // Independently established RFC 4226 client vector: ASCII key
    // 12345678901234567890, counters 59788416 and 59788440 (24 periods)
    // both yield 393421. The wrapper never enumerates HOTPs or infers a counter.
    const key = "12345678901234567890";
    const ciphertext = await symmetricEncrypt({ key: SECRET, data: key });
    const app = new Authenticator("otpauth://totp/collision?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=6&period=30");
    vi.setSystemTime(new Date("2026-11-02T20:48:05Z"));
    // Owner-only test-vector installation, not a candidate import endpoint.
    const g = await create(); const prepared = await setup(g, false);
    await fixtureSql(g, `UPDATE ${FACTOR_MODEL} SET secret = ?`, [ciphertext]);
    await fixtureSql(g, `UPDATE ${ADMISSION.contexts} SET credential = ?`, [replayHmac(g.replayKey!, "incarnation", "better-auth", g.subject, key)]);
    expect(app.code() === "393421").toBe(true); expect((await verify(prepared.browser, app.code())).status).toBe(200);
    vi.setSystemTime(new Date("2026-11-02T21:00:05Z"));
    expect(app.code() === "393421").toBe(true);
    const retained = await replayRows(g);
    expect((await verify(await pending(g), app.code())).status).toBe(409); expect(await replayRows(g)).toEqual(retained);
    // An unconsumed sibling using the same actual native verifier accepts the
    // later counter independently, establishing a collision, not counter replay.
    const h = await create(); const later = await setup(h, false);
    await fixtureSql(h, `UPDATE ${FACTOR_MODEL} SET secret = ?`, [ciphertext]);
    await fixtureSql(h, `UPDATE ${ADMISSION.contexts} SET credential = ?`, [replayHmac(h.replayKey!, "incarnation", "better-auth", h.subject, key)]);
    expect((await verify(later.browser, app.code())).status).toBe(200);
  });

  it("wrong-code native rollback retains the durable charge without a success marker", async () => {
    const f = await create(); const { app } = await setup(f); const b = await pending(f); const old = await replayRows(f);
    f.control.fault = { sql: /update "authentication_ba_two_factor" set "failedVerificationCount"/i, when: "after", remaining: 1 };
    expect((await verify(b, app.wrong())).status).toBe(500); expect((await factorState(f)).failed).toBe(0);
    expect(await charges(f)).toBe(2); expect((await receipt(f))?.state).toBe("failed"); expect(await replayRows(f)).toEqual(old);
  });

  it("native single-use recovery consumes no TOTP marker and shares the charged subject budget", async () => {
    const f = await create(); const { recovery, app } = await setup(f); const before = await replayRows(f);
    const b = await pending(f); expect((await b.post("/two-factor/verify-backup-code", { code: recovery[0] })).status).toBe(200);
    expect(await replayRows(f)).toEqual(before);
    expect((await (await pending(f)).post("/two-factor/verify-backup-code", { code: recovery[0] })).status).toBe(401);
    expect(await replayRows(f)).toEqual(before); expect(await charges(f)).toBe(3);
    expect((await verify(await pending(f), app.code())).status).toBe(200);
  });

  it.each(["verified-toggle", "generation", "reencryption", "factor-row-id"] as const)("%s cannot clear consumption or create a fresh replay namespace", async change => {
    const g = await create(); const a = await setup(g, false); const code = a.app.code();
    expect((await verify(a.browser, code)).status).toBe(200); const retained = await replayRows(g);
    const stale = await pending(g);
    if (change === "verified-toggle") { await fixtureSql(g, `UPDATE ${FACTOR_MODEL} SET verified = 0`); await fixtureSql(g, `UPDATE ${FACTOR_MODEL} SET verified = 1`); }
    if (change === "generation") await fixtureSql(g, `UPDATE ${ADMISSION.subjects} SET generation = generation + 1`);
    if (change === "factor-row-id") await fixtureSql(g, `UPDATE ${FACTOR_MODEL} SET id = id || '-same-secret'`);
    if (change === "reencryption") await g.storage.borrow(async () => { const db = g.storage.createProviderConnection(); try { await reencrypt(db); } finally { db.close(); } });
    if (change === "generation" || change === "factor-row-id") expect((await verify(stale, code)).status).toBe(401);
    expect((await verify(await pending(g), code)).status).toBe(409); expect(await replayRows(g)).toEqual(retained);
  });

  it("a genuinely native-generated replacement has a distinct incarnation and refuses prior contexts", async () => {
    const f = await create(); const a = await setup(f);
    const staleContext = await reauthContext(a.browser), staleLogin = await pending(f);
    const retained = await replayRows(f), oldCredential = await policy(f, p => p.credential(f.subject));
    // Simulated owner reset makes the same native factor eligible for the
    // supported enable operation. Flags alone never clear the existing ledger.
    await fixtureSql(f, `UPDATE ${FACTOR_MODEL} SET verified=0`);
    await fixtureSql(f, 'UPDATE authentication_ba_user SET "twoFactorEnabled"=0');
    const replacement = await a.browser.post("/two-factor/enable", { password: OWNER_PASSWORD });
    expect(replacement.status).toBe(200);
    const app = new Authenticator(replacement.json!.totpURI as string);
    const [current] = await rows<{ credential: string }>(f, `SELECT credential FROM ${ADMISSION.contexts} WHERE purpose='enrollment' AND used=0`);
    expect(current!.credential === oldCredential).toBe(false);
    expect((await reauth(a.browser, staleContext, a.app.code())).status).toBe(401);
    expect((await verify(staleLogin, a.app.code())).status).toBe(401);
    expect(await replayRows(f)).toEqual(retained);
    expect((await verify(a.browser, app.code())).status).toBe(200);
    expect(await replayRows(f)).toHaveLength(retained.length + 1);
  });

  it("full ledger capacity refuses new valid codes without deletion across pruning, reload or clock changes", async () => {
    const f = await create(); const { app } = await setup(f); const retained = await replayRows(f);
    f.control.admission.policy.replayCapacity = 1;
    const result = await verify(await pending(f), app.code()); expect(result.status).toBe(409); expect(result.setCookie.length).toBe(0);
    vi.setSystemTime(Date.now() + 86_400_000); await policy(f, p => p.prune(Date.now())); await reload(f);
    expect((await verify(await pending(f), app.code())).status).toBe(409);
    expect(await replayRows(f)).toEqual(retained);
  });

  it("an enabled-flag contradiction cannot turn selected protection into a password-only login", async () => {
    const f = await create(); await setup(f); const before = await factorState(f), retained = await replayRows(f);
    await fixtureSql(f, 'UPDATE authentication_ba_user SET "twoFactorEnabled"=0');
    const result = await new Browser(f).signIn();
    expect(result.status).toBe(500); expect(result.setCookie.length).toBe(0);
    expect((await factorState(f)).sessions).toEqual(before.sessions); expect(await replayRows(f)).toEqual(retained);
  });

  it("expired reauthentication context refuses without charging or reusing enrollment authority", async () => {
    const f = await create(); const { browser, app } = await setup(f); const context = await reauthContext(browser);
    vi.setSystemTime(Date.now() + f.control.admission.policy.ticketMs);
    const entries = f.control.admission.entries.length;
    expect((await reauth(browser, context, app.code())).status).toBe(401);
    expect(f.control.admission.entries.length).toBe(entries); expect(await charges(f)).toBe(1);
    expect((await reauth(browser, await reauthContext(browser), app.code())).status).toBe(200);
  });

  it.each(["absent", "rotated"] as const)("%s private HMAC key refuses reload without modifying durable state", async change => {
    const f = await create(); const { app } = await setup(f); const retained = await replayRows(f), original = f.replayKey;
    await f.runtime.dispose(); f.replayKey = change === "absent" ? undefined : randomBytes(32);
    await expect(loadFactorProvider(f, f.control)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(await replayRows(f)).toEqual(retained);
    f.replayKey = original; Object.assign(f, await loadFactorProvider(f, f.control));
    expect((await verify(await pending(f), app.code())).status).toBe(200);
    expect(await replayRows(f)).toHaveLength(2);
  });

  const mutations = ["mapping", "principal", "session", "generation", "factor", "verified", "enabled", "origin", "context"] as const;
  const mutate = (kind: typeof mutations[number], db: Parameters<NonNullable<FactorFixture["control"]["admission"]["pause"]>>[1]) => {
    if (kind === "mapping") {
      db.prepare("INSERT INTO remote_principals (id,kind,status) VALUES ('different-active-owner','owner','active')").run([]);
      db.prepare("UPDATE authentication_provider_subjects SET principal_id='different-active-owner'").run([]);
    }
    if (kind === "principal") db.prepare("UPDATE remote_principals SET status='revoked'").run([]);
    if (kind === "session") db.prepare('DELETE FROM authentication_ba_session').run([]);
    if (kind === "generation") db.prepare(`UPDATE ${ADMISSION.subjects} SET generation=generation+1`).run([]);
    if (kind === "factor") db.prepare(`UPDATE ${FACTOR_MODEL} SET id=id || '-changed'`).run([]);
    if (kind === "verified") db.prepare(`UPDATE ${FACTOR_MODEL} SET verified=0`).run([]);
    if (kind === "enabled") db.prepare('UPDATE authentication_ba_user SET "twoFactorEnabled"=0').run([]);
    if (kind === "origin") db.prepare(`UPDATE ${ADMISSION.evidence} SET originalDeadline=?`).run([new Date(Date.now() - 1).toISOString()]);
    if (kind === "context") db.prepare(`UPDATE ${ADMISSION.contexts} SET credential='changed' WHERE purpose='reauthentication'`).run([]);
  };
  it.each(mutations)("current %s changes before reauthentication entry refuse without evaluation", async kind => {
    const f = await create(); const { browser, app } = await setup(f); const context = await reauthContext(browser), retained = await replayRows(f), entries = f.control.admission.entries.length;
    await f.storage.borrow(async () => { const db = f.storage.createProviderConnection(); try { mutate(kind, db); } finally { db.close(); } });
    expect((await reauth(browser, context, app.code())).status).toBeGreaterThanOrEqual(400);
    expect(f.control.admission.entries.length).toBe(entries); expect(await replayRows(f)).toEqual(retained); expect(await charges(f)).toBe(1);
  });
  it.each(mutations.flatMap(kind => (["after-admission", "native-entry", "after-native"] as const).map(stage => ({ kind, stage }))))("current $kind change at $stage refuses settlement and retains charge", async ({ kind, stage }) => {
    const f = await create(); const { browser, app } = await setup(f); const context = await reauthContext(browser), retained = await replayRows(f);
    f.control.admission.pause = async (at, db) => { if (at === stage) mutate(kind, db); };
    const result = await reauth(browser, context, app.code()); expect(result.status).toBeGreaterThanOrEqual(400); expect(result.setCookie.length).toBe(0);
    f.control.admission.pause = undefined;
    expect(await replayRows(f)).toEqual(retained); expect(await charges(f)).toBe(2); expect((await receipt(f))?.state).toBe("failed");
  });

  it("ciphertext re-encryption during native work keeps both the incarnation and consumption history", async () => {
    const f = await create(); const { app } = await setup(f); const retained = await replayRows(f);
    f.control.admission.pause = async (stage, db) => { if (stage === "after-native") await reencrypt(db); };
    expect((await verify(await pending(f), app.code())).status).toBe(200); f.control.admission.pause = undefined;
    expect(await replayRows(f)).toHaveLength(retained.length + 1);
    expect((await verify(await pending(f), app.code())).status).toBe(409);
  });

  it("reauthentication capability cannot select another session and cannot extend original expiry after native refresh", async () => {
    const f = await create(); const { browser, app } = await setup(f);
    const context = await reauthContext(browser); const other = await pending(f);
    expect((await verify(other, app.code())).status).toBe(200);
    expect((await reauth(other, context, app.code(1))).status).toBe(401);
    const before = await rows<{ originalDeadline: string }>(f, `SELECT originalDeadline FROM ${ADMISSION.evidence}`);
    vi.setSystemTime(Date.now() + 4 * 60 * 60_000); expect((await browser.resolve()) !== null).toBe(true);
    vi.setSystemTime(Date.now() + 4 * 60 * 60_000 + 1); expect((await browser.resolve()) !== null).toBe(true);
    expect((await browser.post("/two-factor/reauthentication-context")).status).toBeGreaterThanOrEqual(400);
    expect(await rows(f, `SELECT originalDeadline FROM ${ADMISSION.evidence}`)).toEqual(before);
  });

  it.each(["before", "after"] as const)("admission %s-COMMIT fault never enters native verification or changes markers", async when => {
    const f = await create(); const { app } = await setup(f); const b = await pending(f), before = await replayRows(f), entries = f.control.admission.entries.length;
    commitFault(f, ADMISSION.receipts, when); const result = await verify(b, app.code());
    expect(result.status).toBe(503); expect(result.setCookie.length).toBe(0); expect(result.json?.charged).toBe(when === "after");
    expect(await charges(f)).toBe(when === "after" ? 2 : 1); expect(await replayRows(f)).toEqual(before); expect(f.control.admission.entries.length).toBe(entries);
  });

  it.each(["enrollment", "login", "reauthentication"] as const)("%s marker, native success, evidence and receipt settle together on both sides of COMMIT", async ceremony => {
    for (const when of ["before", "after"] as const) {
      const f = await create(); const { browser, app } = await setup(f, ceremony !== "enrollment");
      const b = ceremony === "login" ? await pending(f) : browser;
      const context = ceremony === "reauthentication" ? await reauthContext(b) : undefined;
      const before = await factorState(f), retained = await replayRows(f), notices = f.evidence.events.length;
      commitFault(f, ADMISSION.replay, when);
      const result = context ? await reauth(b, context, app.code()) : await verify(b, app.code());
      expect(result.status).toBe(when === "after" ? 503 : 500); expect(result.setCookie.length).toBe(0); expect(result.json?.committed).toBe(when === "after");
      expect(await replayRows(f)).toHaveLength(retained.length + (when === "after" ? 1 : 0)); expect((await receipt(f))?.state).toBe(when === "after" ? "succeeded" : "failed");
      expect((await factorState(f)).sessions.length).toBe(before.sessions.length + (ceremony === "login" && when === "after" ? 1 : 0));
      expect(f.evidence.events.length).toBe(notices + (ceremony === "enrollment" && when === "after" ? 1 : 0));
      expect(await charges(f)).toBe(ceremony === "enrollment" ? 1 : 2);
      f.control.fault = undefined;
      if (when === "after") expect((await verify(await pending(f), app.code())).status).toBe(409);
      else {
        const retry = ceremony === "reauthentication" ? await reauth(b, await reauthContext(b), app.code()) : await verify(b, app.code());
        expect(retry.status).toBe(200); expect(await replayRows(f)).toHaveLength(retained.length + 1);
      }
    }
  });

  it.each(["before", "after"] as const)("SQL marker insertion fault %s write rolls success back while retaining charge", async when => {
    const f = await create(); const { app } = await setup(f); const b = await pending(f), before = await factorState(f), retained = await replayRows(f);
    f.control.fault = { sql: new RegExp(`INSERT INTO ${ADMISSION.replay}`, "i"), when, remaining: 1 };
    const result = await verify(b, app.code()); expect(result.status).toBe(500); expect(result.setCookie.length).toBe(0);
    expect(await replayRows(f)).toEqual(retained); expect((await factorState(f)).sessions).toEqual(before.sessions); expect(await charges(f)).toBe(2);
    f.control.fault = undefined; expect((await verify(b, app.code())).status).toBe(200);
  });

  it("failed COMMIT plus failed ROLLBACK cannot expose the uncommitted marker, receipt, cookie or notification", async () => {
    const f = await create(); const { browser, app } = await setup(f, false);
    f.control.fault = { sql: /^(commit|rollback)$/i, afterSql: new RegExp(`INSERT INTO ${ADMISSION.replay}`, "i"), when: "before", remaining: 2 };
    const result = await verify(browser, app.code()).then(r => r.json?.committed === true, (e: { committed?: boolean }) => e.committed === true);
    expect(result).toBe(false); expect(f.evidence.events.length).toBe(0);
    expect(f.store.admissionSnapshot()).toMatchObject({ state: "provider_closed", providerExecutions: 0 });
    const state = await f.store.admission.run(() => {
      const db = (f.store as unknown as { database: Database.Database }).database;
      return { markers: (db.prepare(`SELECT count(*) n FROM ${ADMISSION.replay}`).get() as { n: number }).n,
        charged: (db.prepare(`SELECT sum(charged) n FROM ${ADMISSION.budgets}`).get() as { n: number }).n,
        receipt: (db.prepare(`SELECT state FROM ${ADMISSION.receipts} WHERE attemptId=?`).get(f.control.admission.lastAttemptId!) as { state: string }).state,
        verified: (db.prepare(`SELECT verified FROM ${FACTOR_MODEL}`).get() as { verified: number }).verified };
    });
    expect(state).toEqual({ markers: 0, charged: 1, receipt: "charged", verified: 0 });
  });

  it("unreadable receipt after actual COMMIT leaves durable consumption and never auto-retries or releases a cookie", async () => {
    const f = await create(); const { browser, app } = await setup(f, false);
    f.control.admission.pause = async stage => {
      if (stage === "after-native") f.control.fault = { sql: /^(commit|SELECT \* FROM factor_admission_receipts)/i, afterSql: /^commit$/i, when: "after", remaining: 2 };
    };
    const result = await verify(browser, app.code()); expect(result.status).toBe(503); expect(result.json?.committed === undefined).toBe(true); expect(result.setCookie.length).toBe(0);
    f.control.admission.pause = undefined; expect(f.evidence.events.length).toBe(0); expect(await replayRows(f)).toHaveLength(1); expect((await receipt(f))?.state).toBe("succeeded");
    const entries = f.control.admission.entries.length; await reload(f);
    expect((await verify(await pending(f), app.code())).status).toBe(409); expect(f.control.admission.entries.length).toBe(entries);
  });

  it.each(["after-admission", "native-entry", "after-native"] as const)("cancellation at %s retains charge and rolls marker/success back", async stage => {
    const f = await create(); const { app } = await setup(f); const b = await pending(f), retained = await replayRows(f), before = await factorState(f); const abort = new AbortController();
    f.control.admission.pause = async at => { if (at === stage) abort.abort(); };
    const result = await verify(b, app.code(), { signal: abort.signal }); expect(result.status).toBeGreaterThanOrEqual(400); expect(result.setCookie.length).toBe(0);
    expect(await replayRows(f)).toEqual(retained); expect((await factorState(f)).sessions).toEqual(before.sessions); expect(await charges(f)).toBe(2);
    f.control.admission.pause = undefined; expect((await verify(b, app.code())).status).toBe(200);
  });

  it("lost response is reconciled as observation only; a new attempt cannot spend the same presentation", async () => {
    const f = await create(); const { app } = await setup(f); const b = await pending(f), lost = b.clone();
    commitFault(f, ADMISSION.replay, "after"); expect((await verify(b, app.code())).status).toBe(503);
    const id = f.control.admission.lastAttemptId!, entries = f.control.admission.entries.length;
    f.control.admission.internalAttemptId = id; const receiptResult = await verify(lost, app.wrong());
    expect(receiptResult.status).toBe(409); expect(receiptResult.json?.committed).toBe(true); expect(receiptResult.setCookie.length).toBe(0);
    f.control.admission.internalAttemptId = undefined; await reload(f);
    expect((await verify(await pending(f), app.code())).status).toBe(409); expect(f.control.admission.entries.length).toBe(entries);
  });

  it("parameter sentinels, exact codes, private key and decrypted factor never enter diagnostics or persisted markers", async () => {
    const f = await create(); const { app } = await setup(f); const code = app.code(), b = await pending(f);
    expect((await verify(b, code)).status).toBe(200);
    const secretRow = (await rows<{ secret: string }>(f, `SELECT secret FROM ${FACTOR_MODEL}`))[0]!;
    const plaintext = await symmetricDecrypt({ key: SECRET, data: secretRow.secret });
    const report = JSON.stringify({ trace: f.control.trace, entries: f.control.admission.entries, logs: f.evidence.logs, events: f.evidence.events,
      markers: await replayRows(f), receipts: await rows(f, `SELECT * FROM ${ADMISSION.receipts}`), evidence: await rows(f, `SELECT * FROM ${ADMISSION.evidence}`) });
    for (const value of [code, plaintext, Buffer.from(f.replayKey!).toString("hex"), OWNER_PASSWORD, SECRET]) expect(report.includes(value)).toBe(false);
    expect(f.control.trace.some(row => row.sql.includes(`INSERT INTO ${ADMISSION.replay}`) && row.inTransaction)).toBe(true);
    expect((await replayRows(f)).every(row => /^[a-f0-9]{64}$/.test(row.marker))).toBe(true);
  });
});
