import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSqliteConnection } from "../../../src/server/modules/authentication/provider-contract";
import { TOTP_SETTINGS } from "../src/totp-step";
import { ADMISSION, factorBinding, FixtureAdmission } from "./factor-admission";
import { Authenticator, Browser, cleanupFactorRoots, closeFactor, factorFixture, factorState, fixtureSql, loadFactorProvider, type FactorFixture } from "./factor-fixture";
import { COOKIE, FACTOR_MODEL } from "./factor-provider";
import { OWNER_EMAIL, OWNER_PASSWORD, SECRET } from "./fixture";

const fixtures: FactorFixture[] = [];
const create = async () => { const f = await factorFixture("admitted"); fixtures.push(f); return f; };
const rows = <T = Record<string, unknown>>(f: FactorFixture, sql: string, args: readonly unknown[] = []): Promise<T[]> => f.storage.borrow(async () => {
  const db = f.storage.createProviderConnection();
  try { return db.prepare(sql).all(args) as T[]; } finally { db.close(); }
});
const stepRows = (f: FactorFixture) => rows<{ subject: string; last_step: number }>(f, `SELECT subject, last_step FROM ${ADMISSION.steps} ORDER BY subject`);
const lastStep = async (f: FactorFixture, subject = f.subject) => (await rows<{ last_step: number }>(f, `SELECT last_step FROM ${ADMISSION.steps} WHERE subject = ?`, [subject]))[0]?.last_step ?? null;
const stepAt = (milliseconds = Date.now()) => Math.floor(milliseconds / 30_000);
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
const setup = async (f: FactorFixture, confirm = true, email = OWNER_EMAIL) => {
  const browser = new Browser(f); expect((await browser.post("/sign-in/email", { email, password: OWNER_PASSWORD })).status).toBe(200);
  const enabled = await browser.post("/two-factor/enable", { password: OWNER_PASSWORD });
  expect(enabled.status).toBe(200);
  const app = new Authenticator(enabled.json!.totpURI as string);
  // Enroll on the previous window step, leaving the current step unconsumed.
  const enrollment = [-1, 1].map(n => app.code(n)).find(code => code !== app.code());
  expect(enrollment !== undefined).toBe(true);
  if (confirm) expect((await verify(browser, enrollment!)).status).toBe(200);
  return { browser, app, enrollment: enrollment!, recovery: enabled.json!.backupCodes as string[] };
};
const pending = async (f: FactorFixture, email = OWNER_EMAIL) => {
  const browser = new Browser(f); expect((await browser.post("/sign-in/email", { email, password: OWNER_PASSWORD })).status).toBe(200);
  expect(browser.cookies.has(COOKIE.challenge)).toBe(true); expect(browser.cookies.has(COOKIE.session)).toBe(false);
  return browser;
};
const reload = async (f: FactorFixture) => { await f.runtime.dispose(); Object.assign(f, await loadFactorProvider(f, f.control)); };
const commitFault = (f: FactorFixture, table: string, when: "before" | "after") => {
  f.control.fault = { sql: /^commit$/i, afterSql: new RegExp(`INSERT INTO ${table}`, "i"), when, remaining: 1 };
};
const policy = <T>(f: FactorFixture, call: (p: FixtureAdmission) => T | Promise<T>): Promise<T> => f.storage.borrow(async () => {
  const db = f.storage.createProviderConnection();
  try { return await call(new FixtureAdmission(db, f.control.admission.policy)); } finally { db.close(); }
});
const reencrypt = async (connection: ProviderSqliteConnection) => {
  const row = connection.prepare(`SELECT secret FROM ${FACTOR_MODEL}`).all([])[0] as { secret: string };
  const plaintext = await symmetricDecrypt({ key: SECRET, data: row.secret });
  const ciphertext = await symmetricEncrypt({ key: SECRET, data: plaintext });
  connection.prepare(`UPDATE ${FACTOR_MODEL} SET secret = ?`).run([ciphertext]);
};
/** Public RFC 4226 key, owner-only test-vector installation, not a candidate import endpoint. */
const installRfcKey = async (f: FactorFixture) => {
  const ciphertext = await symmetricEncrypt({ key: SECRET, data: "12345678901234567890" });
  await fixtureSql(f, `UPDATE ${FACTOR_MODEL} SET secret = ?`, [ciphertext]);
  await fixtureSql(f, `UPDATE ${ADMISSION.contexts} SET credential = ?`, [factorBinding(ciphertext)]);
  return new Authenticator("otpauth://totp/collision?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=6&period=30");
};

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-02T12:00:05Z")); });
afterEach(async () => {
  vi.useRealTimers();
  for (const f of fixtures.splice(0)) { f.control.fault = undefined; f.control.admission.pause = undefined; f.control.admission.observationClock = undefined; await closeFactor(f); }
  cleanupFactorRoots();
});

describe("A3-I17 TOTP step consumption, actual native verifier", () => {
  it("denies enrollment -> login, including a fresh challenge after the old native challenge is lost", async () => {
    const f = await create(); const enrolled = await setup(f, false); const presentation = enrolled.app.code(), step = stepAt();
    expect((await verify(enrolled.browser, presentation)).status).toBe(200);
    const before = await factorState(f); await pending(f);
    await fixtureSql(f, "DELETE FROM authentication_ba_verification");
    const fresh = await pending(f); const entries = f.control.admission.entries.length;
    const denied = await verify(fresh, presentation);
    expect(denied.status).toBe(409); expect(denied.setCookie.length).toBe(0);
    // Native decides first and may succeed; the step refusal then rolls that success back.
    expect(f.control.admission.entries.length).toBe(entries + 1); expect((await factorState(f)).sessions).toEqual(before.sessions);
    expect(await lastStep(f)).toBe(step); expect(await charges(f)).toBe(2);
    expect((await receipt(f))?.state).toBe("failed");
    vi.setSystemTime(Date.now() + 30_000);
    expect((await verify(fresh, enrolled.app.code())).status).toBe(200); expect(await lastStep(f)).toBe(step + 1);
  });

  it("native issues the exact settings shared with the step observer", async () => {
    const f = await create(); const browser = new Browser(f); expect((await browser.signIn()).status).toBe(200);
    const enabled = await browser.post("/two-factor/enable", { password: OWNER_PASSWORD });
    const uri = new URL(enabled.json!.totpURI as string);
    expect([uri.searchParams.get("period"), uri.searchParams.get("digits")]).toEqual([String(TOTP_SETTINGS.period), String(TOTP_SETTINGS.digits)]);
  });

  it("denies enrollment -> reauthentication without any session change", async () => {
    const f = await create(); const { browser, app } = await setup(f, false); const code = app.code();
    expect((await verify(browser, code)).status).toBe(200);
    const before = await factorState(f);
    const denied = await reauth(browser, await reauthContext(browser), code);
    expect(denied.status).toBe(409); expect(denied.setCookie.length).toBe(0);
    expect((await factorState(f)).sessions).toEqual(before.sessions);
  });

  it("denies login -> login across independent challenges, and queued concurrent challenges have exactly one effect", async () => {
    const f = await create(); const { app } = await setup(f); const step = stepAt();
    f.control.admission.policy.attempts = 8;
    const a = await pending(f), b = await pending(f); const before = await factorState(f);
    const results = await Promise.all([verify(a, app.code()), verify(b, app.code())]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(results.filter(r => r.setCookie.some(c => c.startsWith(`${COOKIE.session}=`))).length).toBe(1);
    expect((await factorState(f)).sessions.length).toBe(before.sessions.length + 1);
    expect(await stepRows(f)).toEqual([{ subject: f.subject, last_step: step }]);
    expect((await verify(await pending(f), app.code())).status).toBe(409);
    expect(await charges(f)).toBe(4); expect(await lastStep(f)).toBe(step);
    vi.setSystemTime(Date.now() + 30_000);
    expect((await verify(await pending(f), app.code())).status).toBe(200); expect(await lastStep(f)).toBe(step + 1);
  });

  it.each(["login-reauth", "reauth-login", "reauth-reauth"] as const)("denies %s without a new cookie, new login or elevated method, and a newer step works", async direction => {
    const f = await create(); const { app, browser } = await setup(f);
    const code = app.code(), step = stepAt(); const before = await factorState(f);
    if (direction === "login-reauth") expect((await verify(await pending(f), code)).status).toBe(200);
    else {
      const result = await reauth(browser, await reauthContext(browser), code);
      expect(result.status).toBe(200); expect(result.json?.authorizingMfa).toBe(false); expect(result.setCookie.length).toBe(0);
      expect((await factorState(f)).sessions).toEqual(before.sessions);
    }
    const sessions = (await factorState(f)).sessions;
    const result = direction === "reauth-login" ? await verify(await pending(f), code) : await reauth(browser, await reauthContext(browser), code);
    expect(result.status).toBe(409); expect(result.setCookie.length).toBe(0);
    expect((await factorState(f)).sessions).toEqual(sessions);
    expect(await lastStep(f)).toBe(step);
    vi.setSystemTime(Date.now() + 30_000);
    const newer = await reauth(browser, await reauthContext(browser), app.code());
    expect(newer.status).toBe(200); expect(newer.json?.authorizingMfa).toBe(false); expect(newer.setCookie.length).toBe(0);
    expect(await lastStep(f)).toBe(step + 1); expect((await factorState(f)).sessions).toEqual(sessions);
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
    expect(await charges(f)).toBe(3); expect(await lastStep(f)).toBe(stepAt());
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
    const context = await reauthContext(browser); const entries = f.control.admission.entries.length, charged = await charges(f), step = await lastStep(f);
    const result = await reauth(browser, context, code);
    expect(result.status).toBe(400); expect(result.setCookie.length).toBe(0);
    expect(f.control.admission.entries.length).toBe(entries); expect(await charges(f)).toBe(charged); expect(await lastStep(f)).toBe(step);
  });

  it("preserves leading zeros: the code is a fixed digit string and only an integer step is stored", async () => {
    const f = await create(); const { app } = await setup(f);
    let instant = Date.now();
    while (!app.codeAt(instant).startsWith("0")) instant += 30_000;
    vi.setSystemTime(instant); const code = app.code(); expect(/^0[0-9]{5}$/.test(code)).toBe(true);
    expect((await verify(await pending(f), code)).status).toBe(200);
    expect(await lastStep(f)).toBe(stepAt());
    expect((await verify(await pending(f), String(Number(code)))).status).toBe(400);
    expect((await verify(await pending(f), code)).status).toBe(409);
  });

  it.each([-1, 1])("the native %s step window code at the 29.999 boundary is consumed before and after the boundary", async offset => {
    const f = await create(); const { browser, app } = await setup(f, false);
    vi.setSystemTime(new Date("2026-11-02T12:00:29.999Z"));
    const code = app.code(offset), step = stepAt() + offset; expect((await verify(browser, code)).status).toBe(200);
    expect(await lastStep(f)).toBe(step);
    expect((await verify(await pending(f), code)).status).toBe(409);
    vi.setSystemTime(Date.now() + 1);
    // Step +1 is now current, so native still accepts and the counter refuses.
    // Step -1 left the native window, so native itself refuses first.
    expect((await verify(await pending(f), code)).status).toBe(offset === 1 ? 409 : 401);
    expect(await lastStep(f)).toBe(step);
  });

  it.each([-2, 2])("native validity still refuses a fresh out-of-window %s step presentation", async offset => {
    const f = await create(); const { browser, app } = await setup(f, false);
    let code = app.code(offset);
    // In the rare decimal collision with the window, use another independent time.
    while ([-1, 0, 1].some(n => app.code(n) === code)) { vi.setSystemTime(Date.now() + 30_000); code = app.code(offset); }
    expect((await verify(browser, code)).status).toBe(401); expect(await stepRows(f)).toEqual([]);
    expect(await charges(f)).toBe(1);
  });

  it("clock forward, reversal, pruning and provider reload never free a consumed step or move it backwards", async () => {
    const f = await create(); const { browser, app } = await setup(f, false); const start = Date.now(), step = stepAt(), code = app.code();
    expect((await verify(browser, code)).status).toBe(200); const retained = await stepRows(f);
    vi.setSystemTime(start + 86_400_000); await policy(f, p => p.prune(Date.now())); await reload(f);
    expect(await stepRows(f)).toEqual(retained);
    expect((await verify(await pending(f), code)).status).toBe(401);
    vi.setSystemTime(start);
    expect((await verify(await pending(f), code)).status).toBe(409);
    expect(await stepRows(f)).toEqual(retained);
    // A still-valid newer native code succeeds after the reload...
    expect((await verify(await pending(f), app.code(1))).status).toBe(200); expect(await lastStep(f)).toBe(step + 1);
    // ...and then the older in-window step stays refused: the counter cannot move back.
    expect((await verify(await pending(f), code)).status).toBe(409); expect(await lastStep(f)).toBe(step + 1);
  });

  it("a success while the clock ran ahead keeps the counter ahead; recovery remains the alternative path", async () => {
    const f = await create(); const { app, recovery } = await setup(f); const start = Date.now();
    vi.setSystemTime(start + 86_400_000);
    expect((await verify(await pending(f), app.code())).status).toBe(200); const ahead = stepAt();
    vi.setSystemTime(start);
    expect((await verify(await pending(f), app.code())).status).toBe(409); expect(await lastStep(f)).toBe(ahead);
    expect((await (await pending(f)).post("/two-factor/verify-backup-code", { code: recovery[0] })).status).toBe(200);
  });

  it("accepts a later equal decimal at a newer counter and still refuses the original reuse", async () => {
    // Independently established RFC 4226 client vector: ASCII key
    // 12345678901234567890, counters 59788416 and 59788440 (24 periods) both
    // yield 393421. This replaces the I16 assertion that refused the later code.
    vi.setSystemTime(new Date("2026-11-02T20:48:05Z"));
    const f = await create(); const prepared = await setup(f, false); const app = await installRfcKey(f);
    expect(app.code() === "393421").toBe(true); expect(stepAt()).toBe(59_788_416);
    expect((await verify(prepared.browser, app.code())).status).toBe(200); expect(await lastStep(f)).toBe(59_788_416);
    expect((await verify(await pending(f), "393421")).status).toBe(409);
    vi.setSystemTime(new Date("2026-11-02T21:00:05Z"));
    expect(app.code() === "393421").toBe(true); expect(stepAt()).toBe(59_788_440);
    expect((await verify(await pending(f), "393421")).status).toBe(200); expect(await lastStep(f)).toBe(59_788_440);
    expect((await verify(await pending(f), "393421")).status).toBe(409);
    vi.setSystemTime(new Date("2026-11-02T20:48:05Z"));
    expect((await verify(await pending(f), "393421")).status).toBe(409); expect(await lastStep(f)).toBe(59_788_440);
  });

  it("a real two-match window consumes the highest step once, so the same digits cannot be spent again", async () => {
    // Found by scanning the public RFC key: 768734 at counters 61331809 and 61331811.
    vi.setSystemTime(new Date("2028-04-21T18:25:05Z"));
    const f = await create(); const prepared = await setup(f, false); const app = await installRfcKey(f);
    const middle = stepAt(); expect(middle).toBe(61_331_810);
    expect([app.code(-1), app.code(1)]).toEqual(["768734", "768734"]); expect(app.code() === "768734").toBe(false);
    expect((await verify(prepared.browser, "768734")).status).toBe(200);
    expect(await stepRows(f)).toEqual([{ subject: f.subject, last_step: middle + 1 }]);
    expect((await verify(await pending(f), "768734")).status).toBe(409);
    // Two periods later native still accepts these digits at the higher counter.
    // Consuming the lower match would have reopened them here.
    vi.setSystemTime(Date.now() + 60_000);
    expect(app.code(-1) === "768734").toBe(true);
    expect((await verify(await pending(f), "768734")).status).toBe(409); expect(await lastStep(f)).toBe(middle + 1);
    expect((await verify(await pending(f), app.code())).status).toBe(200); expect(await lastStep(f)).toBe(middle + 2);
  });

  it("a second ceremony needs a newer code, which can take longer than one period after a future-window code", async () => {
    const f = await create(); const { app } = await setup(f); const step = stepAt();
    expect((await verify(await pending(f), app.code(1))).status).toBe(200); expect(await lastStep(f)).toBe(step + 1);
    expect((await verify(await pending(f), app.code())).status).toBe(409);
    vi.setSystemTime(Date.now() + 30_000);
    expect((await verify(await pending(f), app.code())).status).toBe(409);
    vi.setSystemTime(Date.now() + 30_000);
    expect((await verify(await pending(f), app.code())).status).toBe(200); expect(await lastStep(f)).toBe(step + 2);
  });

  it("wrong-code native rollback retains the durable charge and adds no step", async () => {
    const f = await create(); const { app } = await setup(f); const b = await pending(f); const old = await stepRows(f);
    f.control.fault = { sql: /update "authentication_ba_two_factor" set "failedVerificationCount"/i, when: "after", remaining: 1 };
    expect((await verify(b, app.wrong())).status).toBe(500); expect((await factorState(f)).failed).toBe(0);
    expect(await charges(f)).toBe(2); expect((await receipt(f))?.state).toBe("failed"); expect(await stepRows(f)).toEqual(old);
  });

  it("native single-use recovery consumes no TOTP step and shares the charged subject budget", async () => {
    const f = await create(); const { recovery, app } = await setup(f); const before = await stepRows(f);
    const b = await pending(f); expect((await b.post("/two-factor/verify-backup-code", { code: recovery[0] })).status).toBe(200);
    expect(await stepRows(f)).toEqual(before);
    expect((await (await pending(f)).post("/two-factor/verify-backup-code", { code: recovery[0] })).status).toBe(401);
    expect(await stepRows(f)).toEqual(before); expect(await charges(f)).toBe(3);
    expect((await verify(await pending(f), app.code())).status).toBe(200);
  });

  it.each(["verified-toggle", "generation", "reencryption", "factor-row-id"] as const)("%s cannot clear consumption", async change => {
    const g = await create(); const a = await setup(g, false); const code = a.app.code();
    expect((await verify(a.browser, code)).status).toBe(200); const retained = await stepRows(g);
    const stale = await pending(g);
    if (change === "verified-toggle") { await fixtureSql(g, `UPDATE ${FACTOR_MODEL} SET verified = 0`); await fixtureSql(g, `UPDATE ${FACTOR_MODEL} SET verified = 1`); }
    if (change === "generation") await fixtureSql(g, `UPDATE ${ADMISSION.subjects} SET generation = generation + 1`);
    if (change === "factor-row-id") await fixtureSql(g, `UPDATE ${FACTOR_MODEL} SET id = id || '-same-secret'`);
    if (change === "reencryption") await g.storage.borrow(async () => { const db = g.storage.createProviderConnection(); try { await reencrypt(db); } finally { db.close(); } });
    if (change !== "verified-toggle") expect((await verify(stale, code)).status).toBe(401);
    expect((await verify(await pending(g), code)).status).toBe(409); expect(await stepRows(g)).toEqual(retained);
  });

  it("a genuine native factor replacement preserves the counter, refuses prior contexts, and a newer step enrolls", async () => {
    const f = await create(); const a = await setup(f); const step = stepAt();
    expect((await verify(await pending(f), a.app.code())).status).toBe(200); expect(await lastStep(f)).toBe(step);
    const staleContext = await reauthContext(a.browser), staleLogin = await pending(f);
    const oldBinding = await policy(f, p => p.credential(f.subject));
    // Simulated owner reset makes the same native factor eligible for the
    // supported enable operation. Neither flag changes the stored counter.
    await fixtureSql(f, `UPDATE ${FACTOR_MODEL} SET verified=0`);
    await fixtureSql(f, 'UPDATE authentication_ba_user SET "twoFactorEnabled"=0');
    const replacement = await a.browser.post("/two-factor/enable", { password: OWNER_PASSWORD });
    expect(replacement.status).toBe(200);
    const app = new Authenticator(replacement.json!.totpURI as string);
    const [current] = await rows<{ credential: string }>(f, `SELECT credential FROM ${ADMISSION.contexts} WHERE purpose='enrollment' AND used=0`);
    expect(current!.credential === oldBinding).toBe(false);
    expect((await reauth(a.browser, staleContext, a.app.code())).status).toBe(401);
    expect((await verify(staleLogin, a.app.code())).status).toBe(401);
    expect(await lastStep(f)).toBe(step);
    // A new secret's current code is at a step this subject already consumed.
    expect((await verify(a.browser, app.code())).status).toBe(409); expect(await lastStep(f)).toBe(step);
    expect((await verify(a.browser, app.code(1))).status).toBe(200); expect(await lastStep(f)).toBe(step + 1);
  });

  it("many successes keep one row per subject with no history, through pruning and reload", async () => {
    const f = await create(); const { app } = await setup(f);
    for (let n = 0; n < 6; n++) {
      vi.setSystemTime(Date.now() + 30_000);
      expect((await verify(await pending(f), app.code())).status).toBe(200);
      await policy(f, p => p.prune(Date.now()));
      if (n === 2) await reload(f);
      expect(await stepRows(f)).toEqual([{ subject: f.subject, last_step: stepAt() }]);
    }
    const tables = await rows<{ name: string }>(f, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'factor%' ORDER BY name");
    expect(tables.map(row => row.name)).toEqual(["factor_admission_budgets", "factor_admission_contexts", "factor_admission_evidence", "factor_admission_receipts", "factor_admission_subjects", "factor_fixture_evidence", "factor_totp_steps"]);
    expect((await rows<{ name: string }>(f, `PRAGMA table_info(${ADMISSION.steps})`)).map(row => row.name)).toEqual(["subject", "last_step"]);
  });

  it("two subjects have independent counters at the same step", async () => {
    const email = "second-owner@fixture.invalid";
    const f = await factorFixture("admitted", { admission: "strict" }, [email]); fixtures.push(f);
    const first = await setup(f), second = await setup(f, true, email); const step = stepAt();
    expect((await verify(await pending(f), first.app.code(1))).status).toBe(200);
    expect((await verify(await pending(f, email), second.app.code())).status).toBe(200);
    expect(await lastStep(f, f.subjects[0])).toBe(step + 1); expect(await lastStep(f, f.subjects[1])).toBe(step);
    expect(await stepRows(f)).toHaveLength(2);
  });

  it("accepts a code reachable only because a period boundary passed during the native call", async () => {
    const f = await create(); const { app } = await setup(f);
    const start = Date.parse("2026-11-02T12:00:29.900Z"); vi.setSystemTime(start);
    const step = stepAt(), code = app.codeAt((step + 2) * 30_000);
    expect((await verify(await pending(f), code)).status).toBe(401);
    const b = await pending(f);
    f.control.admission.pause = async stage => { if (stage === "verification-start") vi.setSystemTime(start + 200); };
    expect((await verify(b, code)).status).toBe(200); f.control.admission.pause = undefined;
    expect(await lastStep(f)).toBe(step + 2);
  });

  it.each([{ name: "inside one period", back: 1_000 }, { name: "across a period", back: 30_000 }])("a real clock reversal $name during the native call rolls back", async ({ back }) => {
    const f = await create(); const { app } = await setup(f); const b = await pending(f);
    const code = app.code(), time = Date.now(), before = await factorState(f), retained = await stepRows(f);
    f.control.admission.pause = async stage => { if (stage === "verification-start") vi.setSystemTime(time - back); };
    const result = await verify(b, code); f.control.admission.pause = undefined;
    expect(result.status).toBe(409); expect(result.setCookie.length).toBe(0);
    expect(await stepRows(f)).toEqual(retained); expect((await factorState(f)).sessions).toEqual(before.sessions);
    expect((await receipt(f))?.state).toBe("failed"); expect(await charges(f)).toBe(2);
    vi.setSystemTime(time); expect((await verify(b, code)).status).toBe(200);
  });

  const invalidObservations: Array<[string, (sample: "start" | "finish", now: number) => number]> = [
    ["broad forward span", (sample, now) => sample === "finish" ? now + 90_000 : now],
    ["nonfinite finish", (sample, now) => sample === "finish" ? Number.NaN : now],
    ["infinite start", (sample, now) => sample === "start" ? Number.POSITIVE_INFINITY : now],
    ["overflowing finish", (sample, now) => sample === "finish" ? 2 ** 53 : now],
    ["fractional start", (sample, now) => sample === "start" ? now + 0.5 : now],
    ["negative start", (sample, now) => sample === "start" ? -1 : now],
    ["reversal inside one period", (sample, now) => sample === "finish" ? now - 1 : now],
    ["empty observation away from the native clock", (_sample, now) => now + 600_000],
  ];
  it.each(invalidObservations)("%s refuses a genuine native success and rolls it back with no step change", async (_name, clock) => {
    const f = await create(); const { app } = await setup(f); const b = await pending(f);
    const code = app.code(), before = await factorState(f), retained = await stepRows(f), entries = f.control.admission.entries.length;
    f.control.admission.observationClock = sample => clock(sample, Date.now());
    const result = await verify(b, code); f.control.admission.observationClock = undefined;
    expect(result.status).toBe(409); expect(result.setCookie.length).toBe(0);
    expect(f.control.admission.entries.length).toBe(entries + 1);
    expect(await stepRows(f)).toEqual(retained); expect((await factorState(f)).sessions).toEqual(before.sessions);
    expect((await receipt(f))?.state).toBe("failed"); expect(await charges(f)).toBe(2);
    expect((await verify(b, code)).status).toBe(200); expect(await lastStep(f)).toBe(stepAt());
  });

  it("the observer cannot supply a success native refused, even with the code inside its bracket", async () => {
    const f = await create(); const { app } = await setup(f); const b = await pending(f);
    const code = app.code(2), retained = await stepRows(f);
    expect([-1, 0, 1].some(n => app.code(n) === code)).toBe(false);
    f.control.admission.observationClock = sample => Date.now() + (sample === "finish" ? 30_000 : 0);
    const result = await verify(b, code); f.control.admission.observationClock = undefined;
    expect(result.status).toBe(401); expect(result.setCookie.length).toBe(0); expect(await stepRows(f)).toEqual(retained);
  });

  it("the guarded write changes one row only for a strictly newer step and never moves backwards", async () => {
    const f = await create();
    await policy(f, p => {
      p.consumeStep(f.subject, 5);
      for (const step of [5, 4, 0, -1, 1.5, Number.NaN]) expect(() => p.consumeStep(f.subject, step)).toThrow("Presentation refused.");
      p.consumeStep(f.subject, 6);
    });
    expect(await stepRows(f)).toEqual([{ subject: f.subject, last_step: 6 }]);
  });

  it.each([0, 1])("an already committed competing step at +%i makes the zero-row update roll native success back", async ahead => {
    const f = await create(); const { app } = await setup(f); const b = await pending(f);
    const before = await factorState(f), step = stepAt();
    f.control.admission.pause = async (stage, db) => { if (stage === "after-admission") db.prepare(`UPDATE ${ADMISSION.steps} SET last_step = ?`).run([step + ahead]); };
    const result = await verify(b, app.code()); f.control.admission.pause = undefined;
    expect(result.status).toBe(409); expect(result.setCookie.length).toBe(0);
    expect(await lastStep(f)).toBe(step + ahead); expect((await factorState(f)).sessions).toEqual(before.sessions);
    expect((await receipt(f))?.state).toBe("failed"); expect(await charges(f)).toBe(2);
  });

  it("an enabled-flag contradiction cannot turn selected protection into a password-only login", async () => {
    const f = await create(); await setup(f); const before = await factorState(f), retained = await stepRows(f);
    await fixtureSql(f, 'UPDATE authentication_ba_user SET "twoFactorEnabled"=0');
    const result = await new Browser(f).signIn();
    expect(result.status).toBe(500); expect(result.setCookie.length).toBe(0);
    expect((await factorState(f)).sessions).toEqual(before.sessions); expect(await stepRows(f)).toEqual(retained);
  });

  it("expired reauthentication context refuses without charging or reusing enrollment authority", async () => {
    const f = await create(); const { browser, app } = await setup(f); const context = await reauthContext(browser);
    vi.setSystemTime(Date.now() + f.control.admission.policy.ticketMs);
    const entries = f.control.admission.entries.length;
    expect((await reauth(browser, context, app.code())).status).toBe(401);
    expect(f.control.admission.entries.length).toBe(entries); expect(await charges(f)).toBe(1);
    expect((await reauth(browser, await reauthContext(browser), app.code())).status).toBe(200);
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
    const f = await create(); const { browser, app } = await setup(f); const context = await reauthContext(browser), retained = await stepRows(f), entries = f.control.admission.entries.length;
    await f.storage.borrow(async () => { const db = f.storage.createProviderConnection(); try { mutate(kind, db); } finally { db.close(); } });
    expect((await reauth(browser, context, app.code())).status).toBeGreaterThanOrEqual(400);
    expect(f.control.admission.entries.length).toBe(entries); expect(await stepRows(f)).toEqual(retained); expect(await charges(f)).toBe(1);
  });
  it.each(mutations.flatMap(kind => (["after-admission", "native-entry", "after-native"] as const).map(stage => ({ kind, stage }))))("current $kind change at $stage refuses settlement and retains charge", async ({ kind, stage }) => {
    const f = await create(); const { browser, app } = await setup(f); const context = await reauthContext(browser), retained = await stepRows(f);
    f.control.admission.pause = async (at, db) => { if (at === stage) mutate(kind, db); };
    const result = await reauth(browser, context, app.code()); expect(result.status).toBeGreaterThanOrEqual(400); expect(result.setCookie.length).toBe(0);
    f.control.admission.pause = undefined;
    expect(await stepRows(f)).toEqual(retained); expect(await charges(f)).toBe(2); expect((await receipt(f))?.state).toBe("failed");
  });

  it.each(["after-admission", "native-entry", "after-native"] as const)("re-encryption during an attempt at %s fails closed; a later new context cannot replay the consumed step", async stage => {
    const f = await create(); const { app } = await setup(f); const before = await factorState(f), retained = await stepRows(f), code = app.code();
    f.control.admission.pause = async (at, db) => { if (at === stage) await reencrypt(db); };
    const result = await verify(await pending(f), code); f.control.admission.pause = undefined;
    expect(result.status).toBeGreaterThanOrEqual(400); expect(result.setCookie.length).toBe(0);
    expect(await stepRows(f)).toEqual(retained); expect((await factorState(f)).sessions).toEqual(before.sessions);
    expect((await verify(await pending(f), code)).status).toBe(200); const consumed = await stepRows(f);
    await f.storage.borrow(async () => { const db = f.storage.createProviderConnection(); try { await reencrypt(db); } finally { db.close(); } });
    expect((await verify(await pending(f), code)).status).toBe(409); expect(await stepRows(f)).toEqual(consumed);
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

  it.each(["before", "after"] as const)("admission %s-COMMIT fault never enters native verification or changes the step", async when => {
    const f = await create(); const { app } = await setup(f); const b = await pending(f), before = await stepRows(f), entries = f.control.admission.entries.length;
    commitFault(f, ADMISSION.receipts, when); const result = await verify(b, app.code());
    expect(result.status).toBe(503); expect(result.setCookie.length).toBe(0); expect(result.json?.charged).toBe(when === "after");
    expect(await charges(f)).toBe(when === "after" ? 2 : 1); expect(await stepRows(f)).toEqual(before); expect(f.control.admission.entries.length).toBe(entries);
  });

  it.each(["enrollment", "login", "reauthentication"] as const)("%s step, native success, evidence and receipt settle together on both sides of COMMIT", async ceremony => {
    for (const when of ["before", "after"] as const) {
      const f = await create(); const { browser, app } = await setup(f, ceremony !== "enrollment");
      const b = ceremony === "login" ? await pending(f) : browser;
      const context = ceremony === "reauthentication" ? await reauthContext(b) : undefined;
      const before = await factorState(f), retained = await lastStep(f), notices = f.evidence.events.length, step = stepAt();
      commitFault(f, ADMISSION.steps, when);
      const result = context ? await reauth(b, context, app.code()) : await verify(b, app.code());
      expect(result.status).toBe(when === "after" ? 503 : 500); expect(result.setCookie.length).toBe(0); expect(result.json?.committed).toBe(when === "after");
      expect(await lastStep(f)).toBe(when === "after" ? step : retained); expect((await receipt(f))?.state).toBe(when === "after" ? "succeeded" : "failed");
      expect((await factorState(f)).sessions.length).toBe(before.sessions.length + (ceremony === "login" && when === "after" ? 1 : 0));
      expect(f.evidence.events.length).toBe(notices + (ceremony === "enrollment" && when === "after" ? 1 : 0));
      expect(await charges(f)).toBe(ceremony === "enrollment" ? 1 : 2);
      f.control.fault = undefined;
      if (when === "after") expect((await verify(await pending(f), app.code())).status).toBe(409);
      else {
        const retry = ceremony === "reauthentication" ? await reauth(b, await reauthContext(b), app.code()) : await verify(b, app.code());
        expect(retry.status).toBe(200);
      }
      expect(await lastStep(f)).toBe(step);
    }
  });

  it.each(["before", "after"] as const)("SQL step write fault %s the statement rolls success back while retaining charge", async when => {
    const f = await create(); const { app } = await setup(f); const b = await pending(f), before = await factorState(f), retained = await stepRows(f);
    f.control.fault = { sql: new RegExp(`INSERT INTO ${ADMISSION.steps}`, "i"), when, remaining: 1 };
    const result = await verify(b, app.code()); expect(result.status).toBe(500); expect(result.setCookie.length).toBe(0);
    expect(await stepRows(f)).toEqual(retained); expect((await factorState(f)).sessions).toEqual(before.sessions); expect(await charges(f)).toBe(2);
    f.control.fault = undefined; expect((await verify(b, app.code())).status).toBe(200);
  });

  it("failed COMMIT plus failed ROLLBACK cannot expose the uncommitted step, receipt, cookie or notification", async () => {
    const f = await create(); const { browser, app } = await setup(f, false);
    f.control.fault = { sql: /^(commit|rollback)$/i, afterSql: new RegExp(`INSERT INTO ${ADMISSION.steps}`, "i"), when: "before", remaining: 2 };
    const result = await verify(browser, app.code()).then(r => r.json?.committed === true, (e: { committed?: boolean }) => e.committed === true);
    expect(result).toBe(false); expect(f.evidence.events.length).toBe(0);
    expect(f.store.admissionSnapshot()).toMatchObject({ state: "provider_closed", providerExecutions: 0 });
    const state = await f.store.admission.run(() => {
      const db = (f.store as unknown as { database: Database.Database }).database;
      return { steps: (db.prepare(`SELECT count(*) n FROM ${ADMISSION.steps}`).get() as { n: number }).n,
        charged: (db.prepare(`SELECT sum(charged) n FROM ${ADMISSION.budgets}`).get() as { n: number }).n,
        receipt: (db.prepare(`SELECT state FROM ${ADMISSION.receipts} WHERE attemptId=?`).get(f.control.admission.lastAttemptId!) as { state: string }).state,
        verified: (db.prepare(`SELECT verified FROM ${FACTOR_MODEL}`).get() as { verified: number }).verified };
    });
    expect(state).toEqual({ steps: 0, charged: 1, receipt: "charged", verified: 0 });
  });

  it("unreadable receipt after actual COMMIT leaves the durable step and never auto-retries or releases a cookie", async () => {
    const f = await create(); const { browser, app } = await setup(f, false); const step = stepAt();
    f.control.admission.pause = async stage => {
      if (stage === "after-native") f.control.fault = { sql: /^(commit|SELECT \* FROM factor_admission_receipts)/i, afterSql: /^commit$/i, when: "after", remaining: 2 };
    };
    const result = await verify(browser, app.code()); expect(result.status).toBe(503); expect(result.json?.committed === undefined).toBe(true); expect(result.setCookie.length).toBe(0);
    f.control.admission.pause = undefined; expect(f.evidence.events.length).toBe(0); expect(await lastStep(f)).toBe(step); expect((await receipt(f))?.state).toBe("succeeded");
    await reload(f);
    expect((await verify(await pending(f), app.code())).status).toBe(409); expect(await lastStep(f)).toBe(step);
  });

  it.each(["after-admission", "native-entry", "verification-start", "after-native"] as const)("cancellation at %s retains charge and rolls step and success back", async stage => {
    const f = await create(); const { app } = await setup(f); const b = await pending(f), retained = await stepRows(f), before = await factorState(f); const abort = new AbortController();
    f.control.admission.pause = async at => { if (at === stage) abort.abort(); };
    const result = await verify(b, app.code(), { signal: abort.signal }); expect(result.status).toBeGreaterThanOrEqual(400); expect(result.setCookie.length).toBe(0);
    expect(await stepRows(f)).toEqual(retained); expect((await factorState(f)).sessions).toEqual(before.sessions); expect(await charges(f)).toBe(2);
    f.control.admission.pause = undefined; expect((await verify(b, app.code())).status).toBe(200);
  });

  it.each(["enrollment", "login", "reauthentication"] as const)("cancellation while the real observer is pending rolls back %s", async ceremony => {
    const f = await create(); const { browser, app } = await setup(f, ceremony !== "enrollment");
    const b = ceremony === "login" ? await pending(f) : browser;
    const context = ceremony === "reauthentication" ? await reauthContext(b) : undefined;
    const before = await factorState(f), steps = await stepRows(f), evidence = await rows(f, `SELECT * FROM ${ADMISSION.evidence}`), charged = await charges(f);
    const notices = f.evidence.events.length, abort = new AbortController();
    let entered!: () => void, release!: () => void;
    const pendingObserver = new Promise<void>(resolve => { entered = resolve; });
    const resumed = new Promise<void>(resolve => { release = resolve; });
    f.control.admission.pause = async stage => { if (stage === "observer-pending") { entered(); await resumed; } };
    const resultPromise = context ? reauth(b, context, app.code(), { signal: abort.signal }) : verify(b, app.code(), { signal: abort.signal });
    try {
      await Promise.race([pendingObserver, resultPromise.then(() => { throw new Error("Real observer was not reached."); })]);
      abort.abort();
    } finally { release(); }
    const result = await resultPromise; f.control.admission.pause = undefined;
    expect(result.status).toBe(409); expect(result.setCookie.length).toBe(0);
    expect(await factorState(f)).toEqual(before); expect(await stepRows(f)).toEqual(steps);
    expect(await rows(f, `SELECT * FROM ${ADMISSION.evidence}`)).toEqual(evidence);
    expect(f.evidence.events.length).toBe(notices); expect(await charges(f)).toBe(charged + 1);
    expect((await receipt(f))?.state).toBe("failed");
    if (context) {
      expect((await reauth(b, context, app.code())).status).toBe(401);
      expect((await reauth(b, await reauthContext(b), app.code())).status).toBe(200);
    } else expect((await verify(b, app.code())).status).toBe(200);
  });

  it.each(["enrollment", "login", "reauthentication", "recovery"] as const)("cancellation after settlement before COMMIT rolls back %s", async ceremony => {
    const f = await create(); const { browser, app, recovery } = await setup(f, ceremony !== "enrollment");
    const b = ceremony === "login" || ceremony === "recovery" ? await pending(f) : browser;
    const context = ceremony === "reauthentication" ? await reauthContext(b) : undefined;
    const before = await factorState(f), steps = await stepRows(f), evidence = await rows(f, `SELECT * FROM ${ADMISSION.evidence}`), charged = await charges(f);
    const notices = f.evidence.events.length, abort = new AbortController();
    f.control.admission.pause = async stage => { if (stage === "before-commit") abort.abort(); };
    const result = ceremony === "recovery" ? await b.post("/two-factor/verify-backup-code", { code: recovery[0] }, { signal: abort.signal })
      : context ? await reauth(b, context, app.code(), { signal: abort.signal }) : await verify(b, app.code(), { signal: abort.signal });
    f.control.admission.pause = undefined;
    expect(result.status).toBe(409); expect(result.setCookie.length).toBe(0);
    expect(await factorState(f)).toEqual(before); expect(await stepRows(f)).toEqual(steps);
    expect(await rows(f, `SELECT * FROM ${ADMISSION.evidence}`)).toEqual(evidence);
    expect(f.evidence.events.length).toBe(notices); expect(await charges(f)).toBe(charged + 1);
    expect((await receipt(f))?.state).toBe("failed");
  });

  it("cancelled context replacement preserves the prior unused capability", async () => {
    const f = await create(); const { browser, app } = await setup(f); const context = await reauthContext(browser);
    const before = await rows(f, `SELECT * FROM ${ADMISSION.contexts}`), abort = new AbortController();
    f.control.admission.pause = async stage => { if (stage === "before-commit") abort.abort(); };
    const result = await browser.post("/two-factor/reauthentication-context", {}, { signal: abort.signal });
    f.control.admission.pause = undefined;
    expect(result.status).toBeGreaterThanOrEqual(400); expect(result.setCookie.length).toBe(0);
    expect(await rows(f, `SELECT * FROM ${ADMISSION.contexts}`)).toEqual(before);
    expect((await reauth(browser, context, app.code())).status).toBe(200);
  });

  it("unobserved native clock excursion can coexist with a newer colliding policy witness", async () => {
    const oldTime = 59_788_416 * 30_000 + 5_000, laterTime = 59_788_440 * 30_000 + 5_000;
    vi.setSystemTime(oldTime);
    const f = await create(); const prepared = await setup(f, false); await installRfcKey(f);
    expect((await verify(prepared.browser, "393421")).status).toBe(200);
    const browser = await pending(f);
    // Native still samples the old clock. The observer sees the two later
    // endpoints; a hidden excursion between those endpoints cannot be excluded.
    f.control.admission.observationClock = () => laterTime;
    expect((await verify(browser, "393421")).status).toBe(200);
    f.control.admission.observationClock = undefined;
    expect(Date.now()).toBe(oldTime); expect(await lastStep(f)).toBe(59_788_440);
  });

  it("lost response is reconciled as observation only; a new attempt cannot spend the same step", async () => {
    const f = await create(); const { app } = await setup(f); const b = await pending(f), lost = b.clone(), step = stepAt();
    commitFault(f, ADMISSION.steps, "after"); expect((await verify(b, app.code())).status).toBe(503);
    const id = f.control.admission.lastAttemptId!, entries = f.control.admission.entries.length;
    f.control.admission.internalAttemptId = id; const receiptResult = await verify(lost, app.wrong());
    expect(receiptResult.status).toBe(409); expect(receiptResult.json?.committed).toBe(true); expect(receiptResult.setCookie.length).toBe(0);
    expect(f.control.admission.entries.length).toBe(entries);
    f.control.admission.internalAttemptId = undefined; await reload(f);
    expect((await verify(await pending(f), app.code())).status).toBe(409); expect(await lastStep(f)).toBe(step);
  });

  it("parameter sentinels, exact codes and decrypted factor never enter diagnostics or persisted state", async () => {
    const f = await create(); const { app } = await setup(f); const code = app.code(), b = await pending(f);
    expect((await verify(b, code)).status).toBe(200);
    const secretRow = (await rows<{ secret: string }>(f, `SELECT secret FROM ${FACTOR_MODEL}`))[0]!;
    const plaintext = await symmetricDecrypt({ key: SECRET, data: secretRow.secret });
    const report = JSON.stringify({ trace: f.control.trace, entries: f.control.admission.entries, logs: f.evidence.logs, events: f.evidence.events,
      steps: await stepRows(f), contexts: await rows(f, `SELECT * FROM ${ADMISSION.contexts}`), receipts: await rows(f, `SELECT * FROM ${ADMISSION.receipts}`), evidence: await rows(f, `SELECT * FROM ${ADMISSION.evidence}`) });
    for (const value of [code, plaintext, OWNER_PASSWORD, SECRET]) expect(report.includes(value)).toBe(false);
    expect(f.control.trace.some(row => row.sql.includes(`INSERT INTO ${ADMISSION.steps}`) && row.inTransaction)).toBe(true);
    expect((await stepRows(f)).every(row => Number.isSafeInteger(row.last_step))).toBe(true);
  });
});
