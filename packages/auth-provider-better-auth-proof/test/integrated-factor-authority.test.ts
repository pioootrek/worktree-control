import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMigrations } from "better-auth/db/migration";
import { Kysely, SqliteDialect } from "kysely";
import { existsSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { DevVaultService } from "@/server/modules/dev-vault";
import { authenticationFactorMigration } from "@/server/infrastructure/sqlite/authentication-factor-migration";
import { libraryOptions } from "../src/library";
import { issuedCookie } from "../src/factor-ceremonies";
import type { ProofFaultInjection } from "../src/index";
import { Authenticator, Browser } from "./factor-fixture";
import { OWNER_EMAIL, OWNER_PASSWORD } from "./fixture";
import { advance, AuthenticationProviderError, BASE_URL, enrollPasskey, enrollTotp, factorOptions, fence, integrated, invalidCredential, IP_HEADER, LIMITS, loadAuthenticationProvider, loadProof, passkeyLogin, passkeyOptions, pendingLogin, protectionState, PROVIDER_ENTRY, refusedWithoutCookies, SECRET, select, sql, SqliteStateStore, stagePasskey, STEP, totpLogin, verify, type Integrated } from "./integrated-fixture";
import { PasskeyAuthenticator } from "./passkey-authenticator";
import { cleanupStrictRoots, closeStrictProof } from "./strict-fixture";

const SESSION = "__Secure-wtc.session_token";
const opened: Integrated[] = [];
const create = async (faults?: ProofFaultInjection, limits?: typeof LIMITS) => { const f = await integrated(faults, limits); opened.push(f); return f; };
const verifyAborted = async (f: Integrated, faults: ProofFaultInjection, stage: Parameters<NonNullable<ProofFaultInjection["factorPause"]>>[0], browser: Browser, code: string) => {
  const abort = new AbortController();
  faults.factorPause = async current => { if (current === stage) abort.abort(); };
  const result = await verify(browser, code, abort.signal);
  faults.factorPause = undefined;
  return result;
};

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-02T12:00:05Z")); });
afterEach(async () => {
  vi.useRealTimers();
  for (const f of opened.splice(0)) await closeStrictProof(f);
  cleanupStrictRoots();
});

describe("frozen storage", () => {
  it("is exactly what the pinned plugins compile from a genuine schema 39 with the real provider options", async () => {
    const database = new Database(":memory:");
    database.exec(readFileSync(new URL("../../../src/server/infrastructure/sqlite/fixtures/schema-v39.sql", import.meta.url), "utf8"));
    const kysely = new Kysely<never>({ dialect: new SqliteDialect({ database }) });
    try {
      const options = libraryOptions({ log() {} }, { baseURL: BASE_URL, secret: SECRET, clientIpHeader: IP_HEADER }, kysely);
      const compiled = (await (await getMigrations(options)).compileMigrations()).split(/;\s*(?:\n\n|$)/).map(sqlText => sqlText.trim()).filter(Boolean);
      const frozen = authenticationFactorMigration.sql.split(/;\n/).map(sqlText => sqlText.trim()).slice(0, compiled.length);
      expect(frozen).toEqual(compiled);
      expect(compiled).toHaveLength(7);
    } finally { await kysely.destroy(); }
  });
});

describe("password evidence", () => {
  it("creates evidence in the sign-in transaction and hands a real actor to Knowledge with an explicit grant", async () => {
    const f = await create(), browser = f.browser();
    expect((await browser.signIn()).status).toBe(200);
    const state = await protectionState(f);
    expect(state.evidence).toMatchObject([{ method: "password", generation: 1 }]);
    expect(state.policy).toEqual({ generation: 1, policy_revision: 1, totp_selected: 0, passkey_selected: 0 });
    const actor = (await f.authenticate(browser))!;
    await expect(f.read(actor)).rejects.toMatchObject({ code: "knowledge_forbidden" });
    await f.grant();
    await expect(f.read(actor)).resolves.toBeDefined();
    expect(await f.run(() => f.runtime.browserSession(actor))).toMatchObject({ authentication: { method: "password", factors: 1 } });
  });

  it("gives an existing session nothing: no evidence means no actor until a fresh real sign-in", async () => {
    const f = await create(), old = f.browser();
    expect((await old.signIn()).status).toBe(200);
    await sql(f, "DELETE FROM authentication_session_evidence");
    expect(await f.authenticate(old)).toBeNull();
    expect(await old.resolve()).toBeNull();
    const fresh = f.browser();
    expect((await fresh.signIn()).status).toBe(200);
    expect(await f.authenticate(fresh)).not.toBeNull();
    expect(await f.authenticate(old)).toBeNull();
  });

  it("refresh cannot extend original authority, and a replaced password session inherits it", async () => {
    const f = await create(), browser = f.browser();
    expect((await browser.signIn()).status).toBe(200);
    await f.grant();
    const { original_deadline: deadline, session_id: first } = (await protectionState(f)).evidence[0]!;
    advance(2 * 60 * 60_000);
    expect((await browser.post("/get-session", {}, { method: "GET" })).status).toBe(200);
    const [row] = await select<{ expiresAt: string }>(f, 'SELECT "expiresAt" FROM "authentication_ba_session" WHERE "id" = ?', [first]);
    expect(Date.parse(row!.expiresAt)).toBeGreaterThan(Date.parse(deadline));
    const actor = (await f.authenticate(browser))!;
    expect((await f.run(() => f.runtime.browserSession(actor))).expiresAt).toBe(deadline);
    // Let the next native middleware refresh be due during replacement itself.
    advance(2 * 60 * 60_000);
    expect((await browser.post("/change-password", { currentPassword: OWNER_PASSWORD, newPassword: "fixture-owner-password-2", revokeOtherSessions: true })).status).toBe(200);
    const replaced = (await protectionState(f)).evidence;
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ original_deadline: deadline, method: "password" });
    expect(replaced[0]!.session_id).not.toBe(first);
    const second = (await f.authenticate(browser))!;
    await expect(f.read(second)).resolves.toBeDefined();
    await invalidCredential(f.read(actor));
    advance(6 * 60 * 60_000 + 1);
    await invalidCredential(f.read(second));
    expect(await f.authenticate(browser)).toBeNull();
  });
});

describe("password replacement settlement", () => {
  const replacementPassword = "fixture-owner-password-2";
  const passwordSession = async (f: Integrated, method: "password" | "password_totp" | "passkey_uv") => {
    if (method === "password_totp") {
      const { authenticator } = await enrollTotp(f);
      advance(STEP);
      return totpLogin(f, authenticator);
    }
    const browser = f.browser();
    expect((await browser.signIn()).status).toBe(200);
    if (method === "password") return browser;
    const authenticator = await enrollPasskey(f, browser);
    const result = await passkeyLogin(f, authenticator, { counter: 1 });
    expect(result.result.status).toBe(200);
    return result.browser;
  };
  const evidenceRows = (f: Integrated) => select<Record<string, unknown>>(f, "SELECT * FROM authentication_session_evidence ORDER BY session_id");
  const passwordHash = async (f: Integrated) => (await select<{ password: string }>(f, 'SELECT password FROM authentication_ba_account WHERE "userId" = ? AND "providerId" = ?', [f.subject, "credential"]))[0]!.password;

  it("uses the final native response cookie, including deletion after a refresh", () => {
    const refreshed = `${SESSION}=fixture-refreshed; Path=/; Secure`, replacement = `${SESSION}=fixture-replaced; Path=/; Secure`;
    expect(issuedCookie([refreshed, "unrelated=fixture", replacement], SESSION) === "fixture-replaced").toBe(true);
    expect(issuedCookie([refreshed, `${SESSION}=; Max-Age=0; Path=/; Secure`], SESSION)).toBeUndefined();
  });

  describe.each(["password", "password_totp", "passkey_uv"] as const)("%s authority", method => {
    it.each(["cancel-native", "expire-native", "cancel-final", "expire-final"] as const)("rolls back password and session effects on %s", async failure => {
      const faults: ProofFaultInjection = {}, f = await create(faults), browser = await passwordSession(f, method);
      const deadline = (await protectionState(f)).evidence[0]!.original_deadline;
      // A real refresh extends native expiry, but cannot extend the evidence.
      advance(2 * 60 * 60_000);
      expect((await browser.post("/get-session", {}, { method: "GET" })).status).toBe(200);
      const [native] = await select<{ expiresAt: string }>(f, 'SELECT "expiresAt" FROM authentication_ba_session');
      expect(Date.parse(native!.expiresAt)).toBeGreaterThan(Date.parse(deadline));
      if (failure.startsWith("expire")) vi.setSystemTime(Date.parse(deadline) - 1);
      const before = await protectionState(f), evidence = await evidenceRows(f), hash = await passwordHash(f);
      const notifications = f.evidence.events.length, abort = new AbortController();
      let reached = false;
      const invalidate = async () => {
        await Promise.resolve();
        reached = true;
        if (failure.startsWith("expire")) vi.setSystemTime(Date.parse(deadline) + 1);
        else abort.abort();
      };
      if (failure.endsWith("native")) faults.beforePasswordWrite = invalidate;
      else faults.factorPause = async stage => { if (stage === "before-commit") await invalidate(); };
      const result = await browser.post("/change-password", { currentPassword: OWNER_PASSWORD, newPassword: replacementPassword, revokeOtherSessions: true }, { signal: abort.signal });
      faults.beforePasswordWrite = undefined; faults.factorPause = undefined;
      expect(reached).toBe(true);
      expect(result.status).toBe(failure.startsWith("expire") ? 401 : 409);
      expect(result.setCookie.length).toBe(0);
      expect(await protectionState(f)).toEqual(before);
      expect(await evidenceRows(f)).toEqual(evidence);
      // Compare sensitive hashes as a boolean so failure diagnostics cannot print them.
      expect(await passwordHash(f) === hash).toBe(true);
      expect(f.evidence.events.length).toBe(notifications);
      expect((await f.browser().signIn(replacementPassword)).status).toBe(401);
      expect((await f.browser().signIn()).status).toBe(method === "passkey_uv" ? 403 : 200);
    });
  });

  it.each(["password_totp", "passkey_uv"] as const)("successful replacement preserves every %s authority field", async method => {
    const f = await create(), browser = await passwordSession(f, method);
    await f.grant();
    const actor = (await f.authenticate(browser))!, original = (await evidenceRows(f))[0]!;
    // Native emits both an old-session refresh and its replacement cookie.
    advance(2 * 60 * 60_000);
    const result = await browser.post("/change-password", { currentPassword: OWNER_PASSWORD, newPassword: replacementPassword, revokeOtherSessions: true });
    expect(result.status).toBe(200);
    const replaced = await evidenceRows(f);
    expect(replaced).toHaveLength(1);
    const { session_id: oldSession, attempt_id: oldAttempt, ...originalAuthority } = original;
    const { session_id: newSession, attempt_id: newAttempt, ...newAuthority } = replaced[0]!;
    expect(newSession).not.toBe(oldSession); expect(newAttempt).not.toBe(oldAttempt);
    expect(newAuthority).toEqual(originalAuthority);
    await invalidCredential(f.read(actor));
    const replacement = (await f.authenticate(browser))!;
    await expect(f.read(replacement)).resolves.toBeDefined();
    expect((await f.run(() => f.runtime.browserSession(replacement))).authentication.method).toBe(method);
  });

  it.each(["mapping", "policy", "credential"] as const)("revalidates inherited %s inside the final transaction", async changed => {
    const faults: ProofFaultInjection = {}, f = await create(faults), browser = await passwordSession(f, "password_totp");
    const before = await protectionState(f), evidence = await evidenceRows(f), hash = await passwordHash(f), notifications = f.evidence.events.length;
    let reached = false;
    faults.factorPause = async (stage, connection) => {
      if (stage !== "before-commit") return;
      reached = true;
      const mutation = changed === "mapping" ? "UPDATE authentication_provider_subjects SET status = 'revoked', revoked_at = '2026-11-02T12:00:00.000Z' WHERE subject = ?"
        : changed === "policy" ? "UPDATE authentication_account_policies SET generation = generation + 1 WHERE subject = ?"
          : 'UPDATE authentication_ba_two_factor SET id = id || \'-replaced\' WHERE "userId" = ?';
      connection.prepare(mutation).run([f.subject]);
    };
    const result = await browser.post("/change-password", { currentPassword: OWNER_PASSWORD, newPassword: replacementPassword, revokeOtherSessions: true });
    faults.factorPause = undefined;
    expect(reached).toBe(true); expect(result.status).toBe(401); expect(result.setCookie.length).toBe(0);
    expect(await protectionState(f)).toEqual(before); expect(await evidenceRows(f)).toEqual(evidence);
    expect(await passwordHash(f) === hash).toBe(true); expect(f.evidence.events.length).toBe(notifications);
    expect(await f.authenticate(browser)).not.toBeNull();
  });
});

describe("TOTP selected protection", () => {
  it("selection atomically ends every old session, mints none and blocks the password path", async () => {
    const f = await create(), other = f.browser();
    expect((await other.signIn()).status).toBe(200);
    await f.grant();
    const retained = (await f.authenticate(other))!;
    const before = await protectionState(f);
    const { browser, authenticator } = await enrollTotp(f);
    const after = await protectionState(f);
    expect(browser.cookies.has(SESSION)).toBe(false);
    expect(after.policy).toEqual({ generation: before.policy!.generation + 1, policy_revision: before.policy!.policy_revision + 1, totp_selected: 1, passkey_selected: 0 });
    expect(after.sessions).toEqual([]);
    expect(after.evidence).toEqual([]);
    expect(after.step).not.toBeNull();
    await invalidCredential(f.read(retained));
    expect(await f.authenticate(other)).toBeNull();
    const pending = await pendingLogin(f);
    expect(pending.cookies.has(SESSION)).toBe(false);
    expect(await f.authenticate(pending)).toBeNull();
    expect((await protectionState(f)).sessions).toEqual([]);
    advance(STEP);
    const logged = await totpLogin(f, authenticator);
    const actor = (await f.authenticate(logged))!;
    expect((await f.run(() => f.runtime.browserSession(actor))).authentication).toEqual({ method: "password_totp", factors: 2 });
    await expect(f.read(actor)).resolves.toBeDefined();
  });

  it("refuses wrong, repeated and stale codes with a retained charge and no usable session", async () => {
    const f = await create();
    const { authenticator } = await enrollTotp(f);
    const enrolledStep = (await protectionState(f)).step!;
    advance(STEP);
    const code = authenticator.code();
    const wrong = await pendingLogin(f), before = await protectionState(f);
    refusedWithoutCookies(await verify(wrong, authenticator.wrong()));
    const failed = await protectionState(f);
    expect(failed).toMatchObject({ step: before.step, sessions: [], evidence: [], charged: before.charged + 1, failed: 1 });
    expect(failed.receipts.at(-1)).toMatchObject({ state: "failed", purpose: "totp_login" });
    expect((await verify(wrong, code)).status).toBe(200);
    expect((await protectionState(f)).step).toBe(enrolledStep + 1);
    const replay = await pendingLogin(f), charged = (await protectionState(f)).charged;
    refusedWithoutCookies(await verify(replay, code));
    expect(await protectionState(f)).toMatchObject({ step: enrolledStep + 1, charged: charged + 1 });
    expect(await f.authenticate(replay)).toBeNull();
    const receipts = (await protectionState(f)).receipts;
    expect(receipts.at(-1)).toMatchObject({ state: "failed", purpose: "totp_login" });
  });

  it("no flag, trust cookie or staged state skips a selected method", async () => {
    const f = await create(), { authenticator } = await enrollTotp(f);
    const forged = f.browser();
    forged.cookies.set("__Secure-wtc.trust_device", "forged.value");
    expect((await forged.signIn()).json).toEqual({ outcome: "challenge" });
    expect((await forged.post("/two-factor/verify-totp", { code: authenticator.code(), trustDevice: true })).status).toBe(400);
    await sql(f, 'UPDATE "authentication_ba_user" SET "twoFactorEnabled" = 0');
    const flagless = f.browser();
    refusedWithoutCookies(await flagless.signIn());
    expect((await protectionState(f)).sessions).toEqual([]);
  });

  it("an enabled flag or factor without a selected policy fails closed for that account", async () => {
    const f = await create();
    await sql(f, 'UPDATE "authentication_ba_user" SET "twoFactorEnabled" = 1');
    const browser = f.browser();
    refusedWithoutCookies(await browser.signIn());
    expect((await protectionState(f)).policy).toBeNull();
  });

  it("a session cannot clear the native flag through the remaining profile route", async () => {
    const f = await create(), { authenticator } = await enrollTotp(f);
    advance(STEP);
    const browser = await totpLogin(f, authenticator);
    expect((await browser.post("/update-user", { twoFactorEnabled: false })).status).toBeGreaterThanOrEqual(400);
    expect(await f.authenticate(browser)).not.toBeNull();
    expect((await f.browser().signIn()).json).toEqual({ outcome: "challenge" });
  });

  it("settles and prunes an attempt whose process vanished, so it cannot hold the bound forever", async () => {
    const f = await create({}, { ...LIMITS, capacity: 8, pruneBatch: 8 }), { authenticator } = await enrollTotp(f);
    await sql(f, "INSERT INTO authentication_factor_receipts SELECT 'stranded', provider_id, capability, purpose, subject, principal_id, credential, binding, generation, policy_revision, epoch, 1, 'charged', NULL FROM authentication_factor_receipts LIMIT 1");
    const { charged } = await protectionState(f);
    advance(STEP);
    await totpLogin(f, authenticator);
    expect(await select(f, "SELECT state FROM authentication_factor_receipts WHERE state = 'charged'")).toEqual([]);
    expect(await select(f, "SELECT 1 FROM authentication_factor_receipts WHERE attempt_id = 'stranded'")).toEqual([]);
    expect((await protectionState(f)).charged).toBeGreaterThanOrEqual(charged);
  });

  it("does not let a password recovery or a password change remove the protection", async () => {
    const f = await create(), { authenticator } = await enrollTotp(f);
    await f.runtime.recoverLocal({ principalId: f.owner.principalId, newPassword: "fixture-recovered-password-1", actor: "test" });
    const browser = f.browser();
    const result = await browser.signIn("fixture-recovered-password-1");
    expect(result.json).toEqual({ outcome: "challenge" });
    advance(STEP);
    expect((await verify(browser, authenticator.code())).status).toBe(200);
  });

  it("charges before native evaluation, and an exhausted wrapper budget never reaches native", async () => {
    const f = await create({}, { ...LIMITS, totp: { attempts: 3, windowMs: 3_600_000 } });
    const { authenticator } = await enrollTotp(f);
    const browser = await pendingLogin(f);
    refusedWithoutCookies(await verify(browser, authenticator.wrong()));
    refusedWithoutCookies(await verify(browser, authenticator.wrong()));
    const failed = (await protectionState(f)).failed;
    const denied = await verify(browser, authenticator.code());
    expect(denied.status).toBe(429);
    expect((await protectionState(f)).failed).toBe(failed);
  });

  it.each(["after-native", "observer-pending", "before-commit"] as const)("cancellation at %s leaves real native success with no durable effect but its charge", async stage => {
    const faults: ProofFaultInjection = {}, f = await create(faults);
    const { authenticator } = await enrollTotp(f);
    advance(STEP);
    const browser = await pendingLogin(f), before = await protectionState(f);
    const result = await verifyAborted(f, faults, stage, browser, authenticator.code());
    refusedWithoutCookies(result);
    const after = await protectionState(f);
    expect(after).toMatchObject({ step: before.step, sessions: [], evidence: [], charged: before.charged + 1 });
    expect(after.receipts.at(-1)?.state).toBe("failed");
    expect(await f.authenticate(browser)).toBeNull();
  });

  it.each(["after-native", "observer-pending", "before-commit"] as const)("cancelled enrollment at %s selects nothing and keeps the old session", async stage => {
    const faults: ProofFaultInjection = {}, f = await create(faults), browser = f.browser();
    expect((await browser.signIn()).status).toBe(200);
    const started = await browser.post("/two-factor/enable", { password: OWNER_PASSWORD });
    const authenticator = new Authenticator(started.json!.totpURI as string);
    const before = await protectionState(f);
    refusedWithoutCookies(await verifyAborted(f, faults, stage, browser, authenticator.code()));
    const after = await protectionState(f);
    expect(after).toMatchObject({ policy: before.policy, step: before.step, sessions: before.sessions, evidence: before.evidence, charged: before.charged + 1 });
    expect(await f.authenticate(browser)).not.toBeNull();
  });

  it.each([
    ["policy", "UPDATE authentication_account_policies SET generation = generation + 1, policy_revision = policy_revision + 1"],
    ["mapping", "UPDATE authentication_provider_subjects SET status = 'revoked', revoked_at = '2026-11-02T00:00:00.000Z'"],
    ["credential", 'UPDATE "authentication_ba_two_factor" SET "secret" = "secret" || \'x\''],
  ])("a %s change observed after native success refuses, with no session", async (_, statement) => {
    const faults: ProofFaultInjection = {}, f = await create(faults), { authenticator } = await enrollTotp(f);
    advance(STEP);
    const browser = await pendingLogin(f), before = await protectionState(f);
    faults.factorPause = async (stage, connection) => {
      if (stage !== "after-native") return;
      faults.factorPause = undefined;
      connection.prepare(statement).run([]);
    };
    refusedWithoutCookies(await verify(browser, authenticator.code()));
    expect(await protectionState(f)).toMatchObject({ step: before.step, sessions: [], evidence: [] });
  });

  it.each([
    ["before COMMIT", "before" as const, "completion withheld", false],
    ["after COMMIT", "after" as const, "completion_receipt", true],
  ])("a failure %s never releases success or a cookie", async (_, when, outcome, committed) => {
    const faults: ProofFaultInjection = {}, f = await create(faults), { authenticator } = await enrollTotp(f);
    advance(STEP);
    const browser = await pendingLogin(f), before = await protectionState(f);
    faults.sqlFault = { sql: /^commit$/i, when, remaining: 1, afterSql: /INSERT INTO authentication_session_evidence|"authentication_ba_session"/ };
    const result = await verify(browser, authenticator.code());
    faults.sqlFault = undefined;
    refusedWithoutCookies(result);
    const after = await protectionState(f);
    expect(after.charged).toBe(before.charged + 1);
    if (committed) {
      expect(result.json).toMatchObject({ outcome, committed: true });
      expect(after.evidence).toHaveLength(1);
    }
    expect(await f.authenticate(browser)).toBeNull();
  });
});

describe("passkey selected protection", () => {
  it("staging authorizes nothing, promotion mints no session and upgrades nothing, and password stops", async () => {
    const f = await create(), browser = f.browser();
    expect((await browser.signIn()).status).toBe(200);
    await f.grant();
    const actor = (await f.authenticate(browser))!;
    const authenticator = await stagePasskey(f, browser);
    const staged = await protectionState(f);
    expect(staged).toMatchObject({ staged: 1, trusted: 0, policy: { passkey_selected: 0 } });
    const early = await passkeyLogin(f, authenticator);
    refusedWithoutCookies(early.result);
    await expect(f.read(actor)).resolves.toBeDefined();
    const confirmation = await browser.post("/passkey/verify-confirmation", { response: authenticator.assert(await passkeyOptions(browser, "confirm"), { counter: 0 }) });
    expect(confirmation.json).toEqual({ outcome: "enrolled", authorizing: false });
    expect(browser.cookies.has(SESSION)).toBe(false);
    const after = await protectionState(f);
    expect(after).toMatchObject({ staged: 0, trusted: 1, sessions: [], evidence: [], policy: { generation: staged.policy!.generation + 1, passkey_selected: 1, totp_selected: 0 } });
    await invalidCredential(f.read(actor));
    refusedWithoutCookies(await f.browser().signIn());
    expect((await protectionState(f)).sessions).toEqual([]);
    const login = await passkeyLogin(f, authenticator, { counter: 1 });
    expect(login.result.status).toBe(200);
    const strong = (await f.authenticate(login.browser))!;
    expect((await f.run(() => f.runtime.browserSession(strong))).authentication).toEqual({ method: "passkey_uv", factors: 2 });
    await expect(f.read(strong)).resolves.toBeDefined();
    expect((await protectionState(f)).evidence).toMatchObject([{ method: "passkey_uv" }]);
  });

  it.each([
    ["UP only", { uv: false }], ["no UP", { up: false }], ["bad signature", { tamper: true }],
    ["wrong handle", { userHandle: "d3Jvbmc" }], ["wrong origin", { origin: "https://evil.test" }],
  ])("login refuses %s with a retained charge and no session", async (_, input) => {
    const f = await create(), browser = f.browser();
    expect((await browser.signIn()).status).toBe(200);
    const authenticator = await enrollPasskey(f, browser);
    const before = await protectionState(f);
    const { browser: login, result } = await passkeyLogin(f, authenticator, input);
    refusedWithoutCookies(result);
    const after = await protectionState(f);
    expect(after).toMatchObject({ sessions: [], evidence: [], charged: before.charged + 1 });
    expect(after.receipts.at(-1)?.state).toBe("failed");
    expect(await f.authenticate(login)).toBeNull();
  });

  it("staged confirmation refuses missing UV and an unknown credential charges nothing", async () => {
    const f = await create(), browser = f.browser();
    expect((await browser.signIn()).status).toBe(200);
    const authenticator = await stagePasskey(f, browser);
    const options = await passkeyOptions(browser, "confirm");
    refusedWithoutCookies(await browser.post("/passkey/verify-confirmation", { response: authenticator.assert(options, { uv: false }) }));
    expect(await protectionState(f)).toMatchObject({ trusted: 0, staged: 1, policy: { passkey_selected: 0 } });
    const unknown = f.browser(), challenge = await passkeyOptions(unknown, "authenticate"), charged = (await protectionState(f)).charged;
    refusedWithoutCookies(await unknown.post("/passkey/verify-authentication", { response: new PasskeyAuthenticator().assert(challenge) }));
    expect((await protectionState(f)).charged).toBe(charged);
  });

  it("cancellation before COMMIT and an uncertain COMMIT leave no usable passkey session", async () => {
    const faults: ProofFaultInjection = {}, f = await create(faults), first = f.browser();
    expect((await first.signIn()).status).toBe(200);
    const authenticator = await enrollPasskey(f, first);
    const abort = new AbortController(), browser = f.browser(), options = await passkeyOptions(browser, "authenticate");
    faults.factorPause = async stage => { if (stage === "before-commit") abort.abort(); };
    refusedWithoutCookies(await browser.post("/passkey/verify-authentication", { response: authenticator.assert(options) }, { signal: abort.signal }));
    faults.factorPause = undefined;
    expect(await protectionState(f)).toMatchObject({ sessions: [], evidence: [] });
    faults.sqlFault = { sql: /^commit$/i, when: "after", remaining: 1, afterSql: /INSERT INTO authentication_session_evidence|"authentication_ba_session"/ };
    const second = await passkeyLogin(f, authenticator);
    faults.sqlFault = undefined;
    refusedWithoutCookies(second.result);
    expect(second.result.json).toMatchObject({ committed: true });
    expect(await f.authenticate(second.browser)).toBeNull();
  });
});

describe("both optional methods", () => {
  it("accepts either alternative, needs neither in sequence, and leaves no password path", async () => {
    const f = await create();
    const { authenticator: totp } = await enrollTotp(f);
    advance(STEP);
    const strong = await totpLogin(f, totp);
    await f.grant();
    const earlier = (await f.authenticate(strong))!;
    await expect(f.read(earlier)).resolves.toBeDefined();
    const passkey = await enrollPasskey(f, strong);
    const policy = (await protectionState(f)).policy!;
    expect(policy).toMatchObject({ totp_selected: 1, passkey_selected: 1, generation: 3 });
    await invalidCredential(f.read(earlier));
    const viaPasskey = await passkeyLogin(f, passkey, { counter: 1 });
    expect(viaPasskey.result.status).toBe(200);
    const passkeyActor = (await f.authenticate(viaPasskey.browser))!;
    advance(STEP);
    const viaTotp = await totpLogin(f, totp);
    const totpActor = (await f.authenticate(viaTotp))!;
    await expect(f.read(passkeyActor)).resolves.toBeDefined();
    await expect(f.read(totpActor)).resolves.toBeDefined();
    const password = f.browser();
    expect((await password.signIn()).json).toEqual({ outcome: "challenge" });
    expect(await f.authenticate(password)).toBeNull();
    expect((await protectionState(f)).step).toBeGreaterThan(0);
  });

  it("keeps a subject's step across a generation change and a replaced secret row", async () => {
    const f = await create(), { authenticator } = await enrollTotp(f);
    advance(STEP);
    const code = authenticator.code();
    const strong = await pendingLogin(f);
    expect((await verify(strong, code)).status).toBe(200);
    const { step } = await protectionState(f);
    await enrollPasskey(f, strong);
    expect((await protectionState(f)).step).toBe(step);
    await sql(f, 'UPDATE "authentication_ba_two_factor" SET "id" = \'replacement\'');
    const replay = await pendingLogin(f), before = await protectionState(f);
    refusedWithoutCookies(await verify(replay, code));
    expect(await protectionState(f)).toMatchObject({ step, charged: before.charged + 1 });
  });
});

describe("authority never exceeds the existing actor", () => {
  it("strength grants no role, owner credential or vault action", async () => {
    const f = await create(), { authenticator } = await enrollTotp(f);
    advance(STEP);
    const actor = (await f.authenticate(await totpLogin(f, authenticator)))!;
    await expect(f.read(actor)).rejects.toMatchObject({ code: "knowledge_forbidden" });
    await f.run(() => {
      expect(() => f.identity.authorizeRuntime(actor, "any", "runtime:control")).toThrow(expect.objectContaining({ code: "runtime_forbidden" }));
      expect(() => f.identity.issueAgentToken({ principalId: "missing", label: "forbidden" }, actor)).toThrow(expect.objectContaining({ code: "owner_authentication_required" }));
    });
    const vault = new DevVaultService(f.store.devVault, { key: () => Buffer.alloc(32) }, f.identity, { verify: () => "valid" });
    const command = { operation: "list" as const, projectId: f.project.id, environment: "DEV" as const, operationId: "00000000-0000-4000-8000-000000000000" };
    await expect(f.run(() => vault.execute({ command }, actor))).rejects.toMatchObject({ code: "vault_denied" });
    expect(Object.keys(actor).sort()).toEqual(["authenticationMethod", "credentialId", "principalId", "principalKind"]);
    expect(actor.credentialId).toBeNull();
  });

  it("denies a copied actor and every current revocation, including during a queued wait", async () => {
    const f = await create(), { authenticator } = await enrollTotp(f);
    await f.grant();
    advance(STEP);
    const browser = await totpLogin(f, authenticator), actor = (await f.authenticate(browser))!;
    await expect(f.read(actor)).resolves.toBeDefined();
    await invalidCredential(f.read({ ...actor }));
    await invalidCredential(f.read(Object.freeze({ ...actor })));
    const sessionId = (await protectionState(f)).evidence[0]!.session_id;
    const held = await fence(f, connection => { connection.prepare('DELETE FROM "authentication_ba_session" WHERE "id" = ?').run([sessionId]); });
    const queued = f.read(actor);
    held.release();
    await held.pending;
    await invalidCredential(queued);
  });

  it.each([
    ["evidence", "DELETE FROM authentication_session_evidence"],
    ["mapping", "UPDATE authentication_provider_subjects SET status = 'revoked', revoked_at = '2026-11-02T00:00:00.000Z'"],
    ["principal", "UPDATE remote_principals SET status = 'revoked' WHERE kind = 'owner'"],
    ["policy", "UPDATE authentication_account_policies SET policy_revision = policy_revision + 1"],
    ["generation", "UPDATE authentication_account_policies SET generation = generation + 1"],
    ["credential", 'UPDATE "authentication_ba_two_factor" SET "secret" = "secret" || \'x\''],
    ["factor flag", 'UPDATE "authentication_ba_user" SET "twoFactorEnabled" = 0'],
    ["verified factor", 'UPDATE "authentication_ba_two_factor" SET "verified" = 0'],
  ])("denies an issued TOTP actor when its %s changes", async (_, statement) => {
    const f = await create(), { authenticator } = await enrollTotp(f);
    await f.grant();
    advance(STEP);
    const browser = await totpLogin(f, authenticator), actor = (await f.authenticate(browser))!;
    await expect(f.read(actor)).resolves.toBeDefined();
    await sql(f, statement);
    await invalidCredential(f.read(actor));
    expect(await f.authenticate(browser)).toBeNull();
  });

  it.each([
    ["public key", 'UPDATE "authentication_ba_passkey" SET "publicKey" = "publicKey" || \'x\''],
    ["native row", 'DELETE FROM "authentication_ba_passkey"'],
    ["trust row", "DELETE FROM authentication_passkey_trust"],
  ])("denies an issued passkey actor when its %s changes", async (_, statement) => {
    const f = await create(), first = f.browser();
    expect((await first.signIn()).status).toBe(200);
    await f.grant();
    const authenticator = await enrollPasskey(f, first);
    const { browser } = await passkeyLogin(f, authenticator, { counter: 1 });
    const actor = (await f.authenticate(browser))!;
    await expect(f.read(actor)).resolves.toBeDefined();
    await sql(f, statement);
    await invalidCredential(f.read(actor));
    expect(await f.authenticate(browser)).toBeNull();
    refusedWithoutCookies(await f.browser().signIn());
  });

  it("does not need a notification: committed state decides when the listener fails", async () => {
    const f = await create(), browser = f.browser();
    expect((await browser.signIn()).status).toBe(200);
    await f.grant();
    const actor = (await f.authenticate(browser))!;
    const started = await browser.post("/two-factor/enable", { password: OWNER_PASSWORD });
    const authenticator = new Authenticator(started.json!.totpURI as string);
    f.evidence.failInvalidation = true;
    await expect(verify(browser, authenticator.code())).rejects.toMatchObject({ code: "invalidation_failed", committed: true });
    f.evidence.failInvalidation = false;
    expect((await protectionState(f)).policy).toMatchObject({ totp_selected: 1 });
    await invalidCredential(f.read(actor));
  });

  it("keeps the original deadline authoritative for strong sessions", async () => {
    const f = await create(), { authenticator } = await enrollTotp(f);
    await f.grant();
    advance(STEP);
    const browser = await totpLogin(f, authenticator), actor = (await f.authenticate(browser))!;
    advance(2 * 60 * 60_000);
    expect((await browser.post("/get-session", {}, { method: "GET" })).status).toBe(200);
    await expect(f.read(actor)).resolves.toBeDefined();
    advance(6 * 60 * 60_000);
    await invalidCredential(f.read(actor));
    expect(await f.authenticate(browser)).toBeNull();
  });
});

describe("closed surface and configuration", () => {
  it.each([
    "/two-factor/disable", "/two-factor/verify-backup-code", "/two-factor/generate-backup-codes", "/two-factor/view-backup-codes", "/two-factor/get-totp-uri",
    "/two-factor/send-otp", "/two-factor/verify-otp", "/two-factor/reauthenticate-totp", "/passkey/delete-passkey", "/passkey/update-passkey", "/passkey/list-user-passkeys",
    "/sign-in/passkey", "/sign-up/email", "/delete-user", "/list-sessions", "/unknown",
  ])("does not expose %s", async path => {
    const f = await create(), browser = f.browser();
    expect((await browser.signIn()).status).toBe(200);
    expect((await browser.post(path, {})).status).toBe(404);
  });

  it("the mounted browser sign-in releases nothing for a selected account", async () => {
    const f = await create();
    await enrollTotp(f);
    const request = new Request(`${BASE_URL}/sign-in/email`, { method: "POST", headers: { origin: new URL(BASE_URL).origin, "content-type": "application/json", [IP_HEADER]: "203.0.113.77" },
      body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }) });
    await expect(f.runtime.browser("sign-in", request)).rejects.toMatchObject({ code: "provider_failed" });
    expect((await protectionState(f)).sessions).toEqual([]);
  });

  it("a recovery code stays unavailable and creates no restricted or unrestricted session", async () => {
    const f = await create();
    await enrollTotp(f);
    const browser = await pendingLogin(f);
    expect((await browser.post("/two-factor/verify-backup-code", { code: "any" })).status).toBe(404);
    expect((await protectionState(f)).sessions).toEqual([]);
  });

  it("refuses factor routes and selected accounts without validated limits, and refuses invalid limits at load", async () => {
    const f = await create();
    await enrollTotp(f);
    await f.runtime.dispose();
    const unconfigured = await loadProof(f.store);
    try {
      const closed = new Browser({ runtime: unconfigured.runtime });
      refusedWithoutCookies(await closed.signIn());
      expect((await closed.post("/two-factor/enable", { password: OWNER_PASSWORD })).status).toBe(404);
      expect((await closed.post("/passkey/generate-authenticate-options", {}, { method: "GET" })).status).toBe(404);
    } finally { await unconfigured.runtime.dispose(); }
    const invalid = factorOptions({ ...LIMITS, capacity: 0 });
    await expect(loadAuthenticationProvider({ entry: PROVIDER_ENTRY, providerId: "better-auth", storage: f.store.authenticationProviderStorage(),
      options: { baseURL: BASE_URL, secret: SECRET, clientIpHeader: IP_HEADER, factors: invalid } })).rejects.toBeInstanceOf(AuthenticationProviderError);
    opened.splice(opened.indexOf(f), 1);
    await f.store.closeAfterDrain();
  });
});

describe("close and reopen", () => {
  it("preserves legitimate evidence and refuses stale evidence and step replay through a real store reopen", async () => {
    const f = await create(), { authenticator } = await enrollTotp(f);
    advance(STEP);
    const code = authenticator.code();
    const browser = await pendingLogin(f);
    expect((await verify(browser, code)).status).toBe(200);
    const cookie = browser.cookieHeader(), before = await protectionState(f);
    await f.runtime.dispose();
    await f.store.closeAfterDrain();
    opened.splice(opened.indexOf(f), 1);
    expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
    const store = new SqliteStateStore(f.path);
    store.requireAdmission();
    const runtime = await loadAuthenticationProvider({ entry: PROVIDER_ENTRY, providerId: "better-auth", storage: store.authenticationProviderStorage(),
      options: { baseURL: BASE_URL, secret: SECRET, clientIpHeader: IP_HEADER, factors: factorOptions() } });
    try {
      const actor = await runtime.authenticate(new Headers({ cookie }));
      expect(actor).not.toBeNull();
      expect(await store.admission.run(() => runtime.browserSession(actor!).authentication)).toEqual({ method: "password_totp", factors: 2 });
      const reopened = { storage: store.authenticationProviderStorage() };
      expect(await protectionState(reopened)).toMatchObject({ policy: before.policy, step: before.step, evidence: before.evidence });
      const replay = new Browser({ runtime });
      expect((await replay.post("/sign-in/email", { email: OWNER_EMAIL, password: OWNER_PASSWORD })).json).toEqual({ outcome: "challenge" });
      refusedWithoutCookies(await replay.post("/two-factor/verify-totp", { code }));
      await sql(reopened, "UPDATE authentication_account_policies SET generation = generation + 1");
      expect(await runtime.authenticate(new Headers({ cookie }))).toBeNull();
    } finally {
      await runtime.dispose();
      await store.closeAfterDrain();
    }
    expect(store.admissionSnapshot()).toMatchObject({ state: "closed", providerExecutions: 0 });
    expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
  });
});
