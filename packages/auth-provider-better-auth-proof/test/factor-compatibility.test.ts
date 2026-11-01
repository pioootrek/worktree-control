import { writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Authenticator, Browser, cleanupFactorRoots, closeFactor, factorFixture, factorState, fixtureSql, loadFactorProvider, withFault, type FactorFixture } from "./factor-fixture";
import { COOKIE, FACTOR_MODEL } from "./factor-provider";
import { OWNER_PASSWORD } from "./fixture";

const fixtures: FactorFixture[] = [];
const create = async (mode: "native" | "bounded" = "native") => {
  const f = await factorFixture(mode); fixtures.push(f); return f;
};
const setup = async (f: FactorFixture, confirm = true) => {
  const browser = new Browser(f);
  expect((await browser.signIn()).status).toBe(200);
  const result = await browser.post("/two-factor/enable", { password: OWNER_PASSWORD });
  expect(result.status).toBe(200);
  const authenticator = new Authenticator(result.json!.totpURI as string);
  const codes = result.json!.backupCodes as string[];
  if (confirm) expect((await browser.post("/two-factor/verify-totp", { code: authenticator.code() })).status).toBe(200);
  return { browser, authenticator, codes };
};
const pending = async (f: FactorFixture) => {
  const browser = new Browser(f);
  const result = await browser.signIn();
  expect(result.status).toBe(200);
  expect(browser.cookies.has(COOKIE.challenge)).toBe(true);
  expect(browser.cookies.has(COOKIE.session)).toBe(false);
  return browser;
};
const state = factorState;
const writeTrace = (name: string, f: FactorFixture, summary: Record<string, unknown>) => {
  writeFileSync(`/tmp/a3-i12-factor-${name}-trace.json`, JSON.stringify({ ...summary, sql: f.control.trace }, null, 2), { mode: 0o600 });
};
const verify = (browser: Browser, code: string) => browser.post("/two-factor/verify-totp", { code });

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-01T12:00:05Z")); });
afterEach(async () => {
  vi.useRealTimers();
  for (const f of fixtures.splice(0)) await closeFactor(f);
  cleanupFactorRoots();
});

describe("A3-I12 native characterization (passing here does not accept MFA)", () => {
  it("generates temporary namespaced DDL, awaits real schema readiness and leaves production versions unchanged", async () => {
    const f = await create();
    expect(f.runtime.readiness.schema).toBe("verified");
    expect(f.ddl.created).toContain(FACTOR_MODEL);
    expect(f.ddl.added).toContainEqual({ table: "authentication_ba_user", fields: ["twoFactorEnabled"] });
    expect(f.ddl.outstanding).toEqual({ created: 0, added: 0, indexes: 0, problems: 0 });
    expect(f.ddl.statements.join("\n")).toContain('"verified"');
    expect(f.storage.storageRevision).toBe(1);
    expect((await state(f)).schemaVersion).toBe(39);
    writeFileSync("/tmp/a3-i12-factor-generated-ddl.sql", `${f.ddl.statements.join(";\n")} ;\n`, { mode: 0o600 });
  });

  it("keeps enrollment unverified then rotates the cookie, while the native body contains the deleted token", async () => {
    const f = await create();
    const { browser, authenticator } = await setup(f, false);
    const original = browser.clone();
    expect(await state(f)).toMatchObject({ enabled: 0, verified: 0 });
    const result = await verify(browser, authenticator.code());
    expect(result.status).toBe(200);
    expect(await state(f)).toMatchObject({ enabled: 1, verified: 1 });
    expect(await original.resolve()).toBeNull();
    expect(await browser.resolve()).not.toBeNull();
    const bodyToken = result.json!.token as string;
    const originalToken = decodeURIComponent(original.cookies.get(COOKIE.session)!).split(".")[0];
    expect(bodyToken === originalToken).toBe(true); // Boolean avoids printing credential material.
    expect(browser.cookies.get(COOKIE.session) === original.cookies.get(COOKIE.session)).toBe(false);
  });

  it("creates pending only, persists one session on completion and rejects replay of that challenge", async () => {
    const f = await create(); const { authenticator } = await setup(f);
    const browser = await pending(f), replay = browser.clone();
    const before = await state(f);
    expect(await browser.resolve()).toBeNull();
    expect((await verify(browser, authenticator.code())).status).toBe(200);
    expect(await browser.resolve()).not.toBeNull();
    expect((await state(f)).sessions.length).toBe(before.sessions.length + 1);
    expect((await verify(replay, authenticator.code())).status).toBe(401);
  });

  it("rejects malformed and expired challenges with no new session", async () => {
    const f = await create(); const { authenticator } = await setup(f);
    const browser = await pending(f); const before = await state(f);
    const malformed = browser.clone(); malformed.cookies.set(COOKIE.challenge, "malformed");
    expect((await verify(malformed, authenticator.code())).status).toBe(401);
    vi.setSystemTime(Date.now() + 601_000);
    expect((await verify(browser, authenticator.code())).status).toBe(401);
    expect((await state(f)).sessions).toEqual(before.sessions);
  });

  it("durably counts five wrong guesses, then consumes the exhausted challenge", async () => {
    const f = await create(); const { authenticator } = await setup(f);
    const browser = await pending(f);
    for (let i = 1; i <= 5; i++) {
      expect((await verify(browser, authenticator.wrong())).status).toBe(401);
      expect(await state(f)).toMatchObject({ failed: i, attempts: [i] });
    }
    expect((await verify(browser, authenticator.code())).status).toBe(400);
    expect(browser.cookies.has(COOKIE.challenge)).toBe(false);
    expect((await state(f)).verifications).toBe(0);
  });

  it("locks across independent password challenges at ten failures and clears an expired lock", async () => {
    const f = await create(); const { authenticator } = await setup(f);
    for (let i = 0; i < 10; i++) expect((await verify(await pending(f), authenticator.wrong())).status).toBe(401);
    const browser = await pending(f);
    expect(await state(f)).toMatchObject({ failed: 10 });
    expect((await state(f)).locked).not.toBeNull();
    expect((await verify(browser, authenticator.code())).status).toBe(429);
    vi.setSystemTime(Date.now() + 901_000);
    const fresh = await pending(f);
    expect((await verify(fresh, authenticator.code())).status).toBe(200);
    expect(await state(f)).toMatchObject({ failed: 0, locked: null });
  });

  it("admits only one of two queued completions of the same challenge", async () => {
    const f = await create(); const { authenticator } = await setup(f);
    const browser = await pending(f), other = browser.clone(); const before = await state(f);
    const results = await Promise.all([verify(browser, authenticator.code()), verify(other, authenticator.code())]);
    expect(results.map(r => r.status).sort()).toEqual([200, 401]);
    expect((await state(f)).sessions.length).toBe(before.sessions.length + 1);
  });

  it("CHARACTERIZES UNSAFE reuse of one TOTP for enrollment and two independent login challenges", async () => {
    const f = await create(); const { authenticator } = await setup(f);
    const code = authenticator.code();
    const a = await pending(f), b = await pending(f);
    expect((await verify(a, code)).status).toBe(200);
    expect((await verify(b, code)).status).toBe(200);
    expect((await state(f)).evidence).toEqual([]); // Native sessions have no method/time record.
  });

  it("consumes a recovery code once across concurrent independent challenges", async () => {
    const f = await create(); const { codes } = await setup(f);
    const a = await pending(f), b = await pending(f); const before = await state(f);
    const results = await Promise.all([a.post("/two-factor/verify-backup-code", { code: codes[0] }), b.post("/two-factor/verify-backup-code", { code: codes[0] })]);
    expect(results.map(r => r.status).sort()).toEqual([200, 401]);
    expect((await state(f)).sessions.length).toBe(before.sessions.length + 1);
    expect((await state(f)).codes === before.codes).toBe(false);
    expect((await (await pending(f)).post("/two-factor/verify-backup-code", { code: codes[0] })).status).toBe(401);
  });

  it("allows password-only sessions to regenerate recovery codes, invalidating the old set", async () => {
    const f = await create(); const passwordOnly = new Browser(f);
    expect((await passwordOnly.signIn()).status).toBe(200);
    const { codes } = await setup(f);
    const regenerated = await passwordOnly.post("/two-factor/generate-backup-codes", { password: OWNER_PASSWORD });
    expect(regenerated.status).toBe(200);
    expect((await (await pending(f)).post("/two-factor/verify-backup-code", { code: codes[0] })).status).toBe(401);
    const fresh = regenerated.json!.backupCodes as string[];
    expect((await (await pending(f)).post("/two-factor/verify-backup-code", { code: fresh[0] })).status).toBe(200);
  });

  it("CHARACTERIZES UNSAFE recovery from an unverified factor without setting verified=true", async () => {
    const f = await create(); const { codes, browser } = await setup(f, false);
    // Ordinary existing-session branch already accepts an unverified factor.
    expect((await browser.post("/two-factor/verify-backup-code", { code: codes[0] })).status).toBe(200);
    // Force only the flag, exactly the unsupported flag-based policy under test.
    await fixtureSql(f, 'UPDATE "authentication_ba_user" SET "twoFactorEnabled" = 1');
    const challenge = await pending(f);
    expect((await challenge.post("/two-factor/verify-backup-code", { code: codes[1] })).status).toBe(200);
    expect(await state(f)).toMatchObject({ verified: 0 });
  });

  it("demonstrates native trusted-device bypass after a real TOTP login", async () => {
    const f = await create(); const { authenticator } = await setup(f);
    const browser = await pending(f);
    expect((await browser.post("/two-factor/verify-totp", { code: authenticator.code(), trustDevice: true })).status).toBe(200);
    expect(browser.cookies.has(COOKIE.trust)).toBe(true);
    browser.cookies.delete(COOKIE.session);
    const result = await browser.signIn();
    expect(result.status).toBe(200);
    expect(result.json!.twoFactorRedirect).not.toBe(true);
    expect(browser.cookies.has(COOKIE.session)).toBe(true);
    expect(await browser.resolve()).not.toBeNull();
  });

  it("does not attach session-specific method/time or upgrade an old password session when enrollment changes", async () => {
    const f = await create(); const initial = new Browser(f);
    expect((await initial.signIn()).status).toBe(200);
    const { browser, authenticator } = await setup(f);
    expect((await initial.resolve())?.session.authentication).toEqual({ method: "password", factors: 1 });
    const current = await browser.resolve();
    expect(current?.session.authentication).toEqual({ method: "password", factors: 1 });
    const oldCookie = initial.cookieHeader();
    expect((await verify(initial, authenticator.code())).status).toBe(200); // Native existing-session path.
    expect(initial.cookieHeader() === oldCookie).toBe(true);
    expect((await state(f)).evidence).toEqual([]);
    const columns = (await state(f)).sessionColumns;
    expect(columns).not.toContain("authenticationMethod");
    expect(columns).not.toContain("factorVerifiedAt");
    await expect(f.runtime.authenticate(new Headers({ cookie: browser.cookieHeader() }))).rejects.toMatchObject({ code: "provider_unavailable" });
  });
});

describe("A3-I12 bounded transaction experiment (fixture policy, no product acceptance)", () => {
  it("enrolls and completes using supported transaction-scoped Kysely with all direct/internal writes in one transaction", async () => {
    const f = await create("bounded"); const { authenticator } = await setup(f);
    const browser = await pending(f);
    f.control.trace.length = 0;
    expect((await verify(browser, authenticator.code())).status).toBe(200);
    const writes = f.control.trace.filter(x => /^(insert|update|delete)/i.test(x.sql));
    expect(writes.length).toBeGreaterThan(3);
    expect(writes.every(x => x.inTransaction)).toBe(true);
    writeTrace("bounded-completion", f, { status: 200, writes: writes.length, allWritesInTransaction: true });
    expect(writes.some(x => x.sql.includes(FACTOR_MODEL))).toBe(true);
    expect(writes.some(x => x.sql.includes('"authentication_ba_session"'))).toBe(true);
    expect(writes.some(x => x.sql.includes('"authentication_ba_verification"'))).toBe(true);
    expect((await state(f)).evidence).toContainEqual({ method: "password_totp", restricted: 0 });
  });
});

describe("supported transaction API counterexamples", () => {
  it.each([
    ["handler-transaction", false, false],
    ["server-api-transaction", false, true],
  ] as const)("%s does not bind both adapter paths (probe stops before an unjoined query can deadlock)", async (mode, direct, internal) => {
    const f = await create(); f.control.mode = mode; f.control.probeAdapters = true;
    const result = await new Browser(f).post("/two-factor/verify-totp", { code: "unused" });
    expect(result.status).toBe(200);
    expect(f.control.adapterScopes).toEqual([{ direct, internal }]);
    expect(f.control.trace.some(x => x.sql === "begin")).toBe(true);
    expect(f.control.trace.some(x => x.sql === "commit")).toBe(true);
  });
});

describe("SQL failure boundaries", () => {
  it("native enrollment can persist flags and rotation before a later direct factor write fails", async () => {
    const f = await create(); const { browser, authenticator } = await setup(f, false);
    const before = await state(f); f.evidence.events.length = 0;
    const result = await withFault(f, 'BEFORE UPDATE OF "verified" ON "authentication_ba_two_factor"', () => verify(browser, authenticator.code()));
    expect(result.status).toBe(500); expect(result.setCookie.length).toBe(0);
    expect(await state(f)).toMatchObject({ enabled: 1, verified: 0 });
    expect((await state(f)).sessions).not.toEqual(before.sessions);
    expect(await browser.resolve()).toBeNull();
    expect(f.evidence.events.length).toBe(1);
    expect(f.control.outcomes.at(-1)).toBe("exception");
    writeTrace("native-enrollment-failure", f, { status: result.status, cookies: result.setCookie.length,
      enabled: 1, verified: 0, oldSessionDeleted: true, replacementPersisted: true, notifications: f.evidence.events.length });
  });

  it.each([
    ["user flag", /^update "authentication_ba_user"/i],
    ["session creation", /^insert into "authentication_ba_session"/i],
    ["session rotation deletion", /^delete from "authentication_ba_session"/i],
    ["factor verified", /^update "authentication_ba_two_factor"/i],
    ["evidence insertion", /^INSERT INTO "factor_fixture_evidence"/i],
    ["commit", /^commit$/i],
  ] as const)("bounded enrollment rolls back %s failure and releases no cookie or notification", async (_name, sql) => {
    const f = await create("bounded"); const { browser, authenticator } = await setup(f, false);
    const before = await state(f); f.evidence.events.length = 0; f.control.trace.length = 0;
    f.control.fault = { sql, when: sql.source === "^commit$" ? "before" : "after", remaining: 1 };
    const result = await verify(browser, authenticator.code());
    expect(result.status).toBe(500); expect(result.setCookie.length).toBe(0);
    expect(await state(f)).toEqual(before);
    expect(f.evidence.events).toEqual([]);
    expect(f.control.trace.some(x => x.sql === "rollback")).toBe(true);
    expect(f.control.fault.remaining).toBe(0);
    expect(await browser.resolve()).not.toBeNull();
  });

  it("rolls back initial factor creation rather than returning setup credentials after a write fault", async () => {
    const f = await create("bounded"), browser = new Browser(f); await browser.signIn();
    const before = await state(f);
    f.control.fault = { sql: /^insert into "authentication_ba_two_factor"/i, when: "after", remaining: 1 };
    const result = await browser.post("/two-factor/enable", { password: OWNER_PASSWORD });
    expect(result.status).toBe(500); expect(result.json?.totpURI === undefined).toBe(true);
    expect(await state(f)).toEqual(before);
  });

  it.each([
    ["code consumption", /^update "authentication_ba_two_factor" set "backupCodes"/i],
    ["challenge consumption", /^delete from "authentication_ba_verification"/i],
    ["new session", /^insert into "authentication_ba_session"/i],
  ] as const)("bounded recovery rolls back %s failure and spends the failed challenge separately", async (_name, sql) => {
    const f = await create("bounded"); const { codes } = await setup(f);
    const browser = await pending(f); const before = await state(f);
    f.control.fault = { sql, when: "after", remaining: 1,
      ...(sql.source.includes("delete") ? { afterSql: /^update "authentication_ba_two_factor" set "backupCodes"/i } : {}) };
    const result = await browser.post("/two-factor/verify-backup-code", { code: codes[0] });
    expect(result.status).toBe(500); expect(result.setCookie.length).toBe(0);
    const after = await state(f);
    expect(after.codes).toBe(before.codes); expect(after.sessions).toEqual(before.sessions);
    expect(after.evidence).toEqual(before.evidence);
    expect(after.verifications).toBe(0); expect(f.control.burned).toBe(1);
    expect(f.control.fault.remaining).toBe(0);
    writeTrace(`recovery-${_name.replaceAll(" ", "-")}`, f, { status: result.status, cookies: 0,
      codeRestored: after.codes === before.codes, sessionsRestored: true, evidenceRestored: true, challengeBurnedAfterRollback: true });
  });

  it.each(["failCookie", "failEvidence"] as const)("rolls back would-be %s failure before releasing a cookie", async fault => {
    const f = await create("bounded"); const { authenticator } = await setup(f);
    const browser = await pending(f); const before = await state(f); f.control[fault] = true;
    const result = await verify(browser, authenticator.code());
    expect(result.status).toBe(500); expect(result.setCookie.length).toBe(0);
    const after = await state(f);
    expect(after.sessions).toEqual(before.sessions); expect(after.evidence).toEqual(before.evidence);
    expect(f.control.burned).toBe(1); expect(after.verifications).toBe(0);
  });

  it("keeps failed guesses durable with the experimental classifier, while blanket rollback erases them", async () => {
    const f = await create("bounded"); const { authenticator } = await setup(f);
    const browser = await pending(f);
    expect((await verify(browser, authenticator.wrong())).status).toBe(401);
    expect(await state(f)).toMatchObject({ failed: 1, attempts: [1] });
    f.control.policy = "rollback-every-failure";
    expect((await verify(browser, authenticator.wrong())).status).toBe(401);
    expect(await state(f)).toMatchObject({ failed: 1, attempts: [1] });
  });

  it.each(["native", "bounded"] as const)("%s: a returned error Response after session veto differs from a thrown SQL exception", async mode => {
    const f = await create(mode); const { codes } = await setup(f);
    const browser = await pending(f); const before = await state(f);
    f.control.vetoSessionCreate = true;
    const result = await browser.post("/two-factor/verify-backup-code", { code: codes[0] });
    expect(result.status).toBe(500); expect(result.setCookie.length).toBe(0);
    expect(f.control.outcomes.at(-1)).toBe("response");
    const after = await state(f);
    expect(after.codes === before.codes).toBe(mode === "bounded");
    expect(after.sessions).toEqual(before.sessions);
    expect(after.verifications).toBe(0); // Native consumed; bounded rolled back then explicitly burned.
  });

  it("commit-every-response loses a recovery code after the same session-veto error", async () => {
    const f = await create("bounded"); const { codes } = await setup(f);
    const browser = await pending(f); const before = await state(f);
    f.control.policy = "commit-every-response"; f.control.vetoSessionCreate = true;
    expect((await browser.post("/two-factor/verify-backup-code", { code: codes[0] })).status).toBe(500);
    expect((await state(f)).codes === before.codes).toBe(false);
  });

  it("buffers native hooks until commit and reports notification failure as committed", async () => {
    const f = await create("bounded"); const { browser, authenticator } = await setup(f, false);
    const before = await state(f); f.evidence.events.length = 0; f.control.afterHookInTransaction.length = 0;
    f.evidence.failInvalidation = true;
    await expect(verify(browser, authenticator.code())).rejects.toMatchObject({ code: "invalidation_failed", committed: true });
    expect(await state(f)).toMatchObject({ enabled: 1, verified: 1 });
    expect((await state(f)).sessions).not.toEqual(before.sessions);
    expect(f.control.afterHookInTransaction).toEqual([true]);
    expect(f.evidence.events).toEqual([]);
  });
});

describe("bounded exclusions and restricted recovery", () => {
  it("rejects trust fields, strips a native trust cookie and refuses any minted nondeletion trust cookie", async () => {
    const f = await create(); const { authenticator } = await setup(f);
    const native = await pending(f);
    expect((await native.post("/two-factor/verify-totp", { code: authenticator.code(), trustDevice: true })).status).toBe(200);
    native.cookies.delete(COOKIE.session); f.control.mode = "bounded";
    expect((await native.signIn()).json?.outcome === "challenge").toBe(true);
    expect(native.cookies.has(COOKIE.session)).toBe(false);
    expect((await native.post("/two-factor/verify-totp", { code: authenticator.code(), trustDevice: true })).status).toBe(400);
    const before = await state(f); f.control.forwardTrustRegression = true;
    const result = await verify(native, authenticator.code());
    expect(result.status).toBe(500); expect(result.setCookie.length).toBe(0);
    expect((await state(f)).sessions).toEqual(before.sessions);
  });

  it.each(["/two-factor/disable", "/two-factor/send-otp", "/two-factor/verify-otp", "/two-factor/get-totp-uri", "/two-factor/generate-backup-codes", "/two-factor/view-backup-codes", "/totp/generate", "/sign-up/email", "/unknown"])("does not expose native catch-all %s", async path => {
    const f = await create("bounded");
    const result = await new Browser(f).post(path, {});
    expect(result.status).toBe(404); expect(result.setCookie.length).toBe(0);
  });

  it("classifies recovery as restricted and admits only one concurrent same-code submission", async () => {
    const f = await create("bounded"); const { codes } = await setup(f);
    const a = await pending(f), b = await pending(f);
    const results = await Promise.all([a.post("/two-factor/verify-backup-code", { code: codes[0] }), b.post("/two-factor/verify-backup-code", { code: codes[0] })]);
    expect(results.map(r => r.status).sort()).toEqual([200, 401]);
    expect(isDeepStrictEqual(results.find(r => r.status === 200)!.json, { outcome: "recovery", method: "recovery_code", restricted: true })).toBe(true);
    expect((await state(f)).evidence).toContainEqual({ method: "recovery_code", restricted: 1 });
    await expect(f.runtime.authenticate(new Headers({ cookie: a.cookieHeader() }))).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("refuses recovery before factor verification and refuses upgrading an existing password session", async () => {
    const f = await create("bounded"); const { codes, browser } = await setup(f, false);
    expect((await browser.post("/two-factor/verify-backup-code", { code: codes[0] })).status).toBe(403);
    await fixtureSql(f, 'UPDATE "authentication_ba_user" SET "twoFactorEnabled" = 1');
    expect((await (await pending(f)).post("/two-factor/verify-backup-code", { code: codes[0] })).status).toBe(400);
  });
});

// Deliberately ordinary failing acceptance tests. No skip, todo, fails/xfail,
// inverted expectation, environment opt-out or custom replay implementation.
// The default managed proof preset must remain RED while these requirements fail.
describe.each(["native", "bounded"] as const)("UNMET PRODUCT ACCEPTANCE: %s", mode => {
  it("rejects an enrollment TOTP reused in a subsequent password challenge", async () => {
    const f = await create(mode); const { authenticator } = await setup(f);
    const browser = await pending(f); const before = await state(f);
    const result = await verify(browser, authenticator.code());
    expect(result.status).toBe(401);
    expect((await state(f)).sessions).toEqual(before.sessions);
  });

  it("rejects one accepted TOTP reused in an independent password challenge", async () => {
    const f = await create(mode); const { authenticator } = await setup(f);
    vi.setSystemTime(Date.now() + 30_000); // A new step, different from enrollment.
    const first = await pending(f), second = await pending(f), code = authenticator.code();
    expect((await verify(first, code)).status).toBe(200);
    const before = await state(f);
    expect((await verify(second, code)).status).toBe(401);
    expect((await state(f)).sessions).toEqual(before.sessions);
  });
});

describe("additional bounded characterization", () => {
  it("rejects malformed, replayed and expired challenges, including two queued completions", async () => {
    const f = await create("bounded"); const { authenticator } = await setup(f);
    const browser = await pending(f), replay = browser.clone(), malformed = browser.clone();
    malformed.cookies.set(COOKIE.challenge, "malformed");
    expect((await verify(malformed, authenticator.code())).status).toBe(401);
    const results = await Promise.all([verify(browser, authenticator.code()), verify(replay, authenticator.code())]);
    expect(results.map(r => r.status).sort()).toEqual([200, 401]);
    const expired = await pending(f); const before = await state(f);
    vi.setSystemTime(Date.now() + 601_000);
    expect((await verify(expired, authenticator.code())).status).toBe(401);
    expect((await state(f)).sessions).toEqual(before.sessions);
  });

  it("keeps the normal bounded challenge budget, exhaustion and cross-challenge lockout durable", async () => {
    const f = await create("bounded"); const { authenticator } = await setup(f);
    const browser = await pending(f);
    for (let i = 1; i <= 5; i++) {
      expect((await verify(browser, authenticator.wrong())).status).toBe(401);
      expect(await state(f)).toMatchObject({ failed: i, attempts: [i] });
    }
    expect((await verify(browser, authenticator.code())).status).toBe(400);
    expect(browser.cookies.has(COOKIE.challenge)).toBe(false);
    for (let i = 0; i < 5; i++) expect((await verify(await pending(f), authenticator.wrong())).status).toBe(401);
    expect(await state(f)).toMatchObject({ failed: 10 });
    expect((await verify(await pending(f), authenticator.code())).status).toBe(429);
  });

  it("retains only stand-in evidence across provider disposal/reload, without reopening the extended schema or issuing actors", async () => {
    const f = await create("bounded"); const { authenticator } = await setup(f);
    const browser = await pending(f); expect((await verify(browser, authenticator.code())).status).toBe(200);
    const before = await state(f);
    await f.runtime.dispose(); Object.assign(f, await loadFactorProvider(f, f.control));
    expect(await state(f)).toEqual(before);
    const afterReload = new Browser(f);
    expect(await afterReload.resolve(browser.cookieHeader())).not.toBeNull();
    await expect(f.runtime.authenticate(new Headers({ cookie: browser.cookieHeader() }))).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("CHARACTERIZES UNSAFE loss of the account failure count after a post-increment SQL fault", async () => {
    const f = await create("bounded"); const { authenticator } = await setup(f);
    const browser = await pending(f);
    f.control.fault = { sql: /^update "authentication_ba_two_factor" set "failedVerificationCount" = "failedVerificationCount"/i, when: "after", remaining: 1 };
    const result = await verify(browser, authenticator.wrong());
    expect(result.status).toBe(500); expect(f.control.fault.remaining).toBe(0);
    expect(await state(f)).toMatchObject({ failed: 0, verifications: 0 });
    expect(f.control.burned).toBe(1);
    writeTrace("failed-guess-rollback", f, { status: 500, wrongCodeEvaluated: true, accountCounter: 0, challengeBurned: true });
  });
});

it("UNMET PRODUCT ACCEPTANCE: a failed guess retains durable account budget after rollback", async () => {
  const f = await create("bounded"); const { authenticator } = await setup(f);
  const browser = await pending(f);
  f.control.fault = { sql: /^update "authentication_ba_two_factor" set "failedVerificationCount" = "failedVerificationCount"/i, when: "after", remaining: 1 };
  expect((await verify(browser, authenticator.wrong())).status).toBe(500);
  expect(f.control.fault.remaining).toBe(0);
  expect((await state(f)).failed).toBe(1);
});


it("CHARACTERIZES native authenticated TOTP verification without challenge/account failure accounting", async () => {
  const f = await create(); const { browser, authenticator } = await setup(f);
  const before = await state(f), cookie = browser.cookieHeader();
  for (let i = 0; i < 11; i++) expect((await verify(browser, authenticator.wrong())).status).toBe(401);
  expect(await state(f)).toMatchObject({ failed: before.failed, locked: null, attempts: [] });
  expect((await verify(browser, authenticator.code())).status).toBe(200);
  expect(browser.cookieHeader() === cookie).toBe(true);
});
