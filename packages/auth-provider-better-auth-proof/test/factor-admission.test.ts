import { existsSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { ADMISSION, capabilityId, FixtureAdmission } from "./factor-admission";
import { Authenticator, Browser, cleanupFactorRoots, closeFactor, factorFixture, factorState, fixtureSql, loadFactorProvider, type FactorFixture } from "./factor-fixture";
import { COOKIE, FACTOR_MODEL, FACTOR_SQL_TRACE_LIMIT } from "./factor-provider";
import { OWNER_EMAIL, OWNER_PASSWORD, SECRET } from "./fixture";

const fixtures: FactorFixture[] = [];
const create = async (additional: string[] = [], timeout = 30_000) => {
  const f = await factorFixture("admitted", { admission: "strict", borrowTimeoutMs: timeout }, additional);
  fixtures.push(f); return f;
};
const rows = async <T = Record<string, unknown>>(f: FactorFixture, sql: string, args: readonly unknown[] = []): Promise<T[]> => f.storage.borrow(async () => {
  const connection = f.storage.createProviderConnection();
  try { return connection.prepare(sql).all(args) as T[]; } finally { connection.close(); }
});
const policyCall = async <T>(f: FactorFixture, call: (policy: FixtureAdmission) => T): Promise<T> => f.storage.borrow(async () => {
  const connection = f.storage.createProviderConnection();
  try { return call(new FixtureAdmission(connection, f.control.admission.policy)); } finally { connection.close(); }
});
const receipt = (f: FactorFixture, id = f.control.admission.lastAttemptId!) => policyCall(f, p => p.readReceipt(id));
const charged = async (f: FactorFixture, subject = f.subject) => (await rows<{ n: number }>(f, `SELECT coalesce(sum(charged), 0) n FROM ${ADMISSION.budgets} WHERE subject = ?`, [subject]))[0]!.n;
const verify = (b: Browser, code: string, init: Parameters<Browser["post"]>[2] = {}) => b.post("/two-factor/verify-totp", { code }, init);
const setup = async (f: FactorFixture, email = OWNER_EMAIL, confirm = true) => {
  const browser = new Browser(f);
  expect((await browser.post("/sign-in/email", { email, password: OWNER_PASSWORD })).status).toBe(200);
  const result = await browser.post("/two-factor/enable", { password: OWNER_PASSWORD });
  expect(result.status).toBe(200);
  const authenticator = new Authenticator(result.json!.totpURI as string);
  const codes = result.json!.backupCodes as string[];
  // Enrollment consumes its step across ceremonies. Use the previous window step
  // so the current step stays available and inherited positive login/fault tests
  // still reach the behavior they exercise, without disabling replay protection.
  const enrollmentCode = [-1, 1].map(offset => authenticator.code(offset)).find(code => code !== authenticator.code());
  if (confirm) {
    expect(enrollmentCode !== undefined).toBe(true);
    expect((await verify(browser, enrollmentCode!)).status).toBe(200);
  }
  return { browser, authenticator, codes };
};
const pending = async (f: FactorFixture, email = OWNER_EMAIL, ip?: string) => {
  const b = new Browser(f);
  expect((await b.post("/sign-in/email", { email, password: OWNER_PASSWORD }, { ip })).status).toBe(200);
  expect(b.cookies.has(COOKIE.challenge)).toBe(true);
  expect(b.cookies.has(COOKIE.session)).toBe(false);
  return b;
};
const reload = async (f: FactorFixture) => { await f.runtime.dispose(); Object.assign(f, await loadFactorProvider(f, f.control)); };
const pause = (f: FactorFixture, stage: "after-admission" | "native-entry" | "after-native") => {
  let resume!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { resume = resolve; });
  const paused = new Promise<void>(resolve => { entered = resolve; });
  f.control.admission.pause = async at => { if (at === stage) { entered(); await held; } };
  return { paused, resume: () => { f.control.admission.pause = undefined; resume(); } };
};
const fault = (f: FactorFixture, table: string, when: "before" | "after" = "before") => {
  f.control.fault = { sql: /^commit$/i, afterSql: new RegExp(`insert into ["']?${table}`, "i"), when, remaining: 1 };
};

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-02T12:00:05Z")); });
afterEach(async () => {
  vi.useRealTimers();
  for (const f of fixtures.splice(0)) { f.control.fault = undefined; f.control.admission.pause = undefined; await closeFactor(f); }
  cleanupFactorRoots();
});

describe("A3-I13 durable admission, real library, one owner (I17 step candidate)", () => {
  it("1: observes native entry only after a committed charge, with a separate success transaction", async () => {
    const f = await create(); const { authenticator } = await setup(f); const b = await pending(f);
    f.control.trace.length = 0; f.control.admission.entries.length = 0;
    const result = await verify(b, authenticator.code());
    expect(result.status).toBe(200); expect(result.json?.authorizingMfa).toBe(false);
    expect(f.control.admission.entries).toEqual([{ attemptId: f.control.admission.lastAttemptId, charged: true, inTransaction: true }]);
    const sql = f.control.trace.map(x => x.sql);
    const admission = sql.findIndex(x => x.includes(`INSERT INTO ${ADMISSION.receipts}`));
    const commit = sql.findIndex((x, i) => i > admission && /^commit$/i.test(x));
    const success = sql.findIndex((x, i) => i > commit && /^begin$/i.test(x));
    const nativeWrite = sql.findIndex(x => /update "authentication_ba_two_factor"/i.test(x));
    expect(admission >= 0 && commit > admission && success > commit && nativeWrite > success).toBe(true);
    expect(await receipt(f)).toMatchObject({ state: "succeeded", subject: f.subject, sequence: 2 });
    expect(await charged(f)).toBe(2);
    expect((await rows(f, `SELECT method, observation, authorizingMfa FROM ${ADMISSION.evidence}`)).every(x => x.method === "password" && x.authorizingMfa === 0)).toBe(true);
    // The factor fixture implementation is deliberately ineligible for controller actors.
    expect((await b.resolve())?.session.authentication).toEqual({ method: "password", factors: 1 });
    await expect(f.runtime.authenticate(new Headers({ cookie: b.cookieHeader() }))).rejects.toMatchObject({ code: "provider_unavailable" });
    writeFileSync("/tmp/a3-i13-admitted-completion-trace.json", JSON.stringify({ entries: f.control.admission.entries, sql: f.control.trace, charged: 2 }, null, 2), { mode: 0o600 });
  });

  it("2: rollback loses the native increment but never the authoritative charge, even across fresh challenges and peers", async () => {
    const f = await create(); const { authenticator } = await setup(f);
    for (let n = 2; n <= f.control.admission.policy.attempts; n++) {
      const b = await pending(f);
      f.control.fault = { sql: /update "authentication_ba_two_factor" set "failedVerificationCount"/i, when: "after", remaining: 1 };
      expect((await verify(b, authenticator.wrong())).status).toBe(500);
      expect((await factorState(f)).failed).toBe(0);
      expect(await charged(f)).toBe(n);
      expect(await receipt(f)).toMatchObject({ state: "failed" });
      f.control.fault = undefined;
    }
    const b = await pending(f); const entries = f.control.admission.entries.length;
    expect((await verify(b, authenticator.code())).status).toBe(429);
    expect(f.control.admission.entries.length).toBe(entries);
    expect(await charged(f)).toBe(f.control.admission.policy.attempts);
    writeFileSync("/tmp/a3-i13-native-rollback-charge-trace.json", JSON.stringify({ sql: f.control.trace, nativeFailed: 0, charged: await charged(f) }, null, 2), { mode: 0o600 });
  });

  it.each(["before", "after"] as const)("3: admission %s-COMMIT fault denies evaluation and reconciles the charge", async when => {
    const f = await create(); const { authenticator } = await setup(f); const b = await pending(f);
    const entries = f.control.admission.entries.length; const old = await charged(f);
    fault(f, ADMISSION.receipts, when);
    const result = await verify(b, authenticator.code());
    expect(result.status).toBe(503); expect(result.json?.charged).toBe(when === "after");
    expect(result.json?.reconciled).toBe(true); expect(f.control.admission.entries.length).toBe(entries);
    expect(await charged(f)).toBe(old + (when === "after" ? 1 : 0));
    expect((await receipt(f))?.state ?? "absent").toBe(when === "after" ? "failed" : "absent");
  });

  it.each(["before", "after"] as const)("3: success %s-COMMIT fault checks the actual durable session/evidence/receipt", async when => {
    const f = await create(); const { authenticator } = await setup(f); const b = await pending(f);
    const old = (await factorState(f)).sessions.length; const evidence = (await rows(f, `SELECT sessionId FROM ${ADMISSION.evidence}`)).length;
    const notifications = f.evidence.events.length;
    fault(f, ADMISSION.evidence, when);
    const result = await verify(b, authenticator.code());
    expect(result.status).toBe(when === "after" ? 503 : 500); expect(result.setCookie.length).toBe(0);
    expect(result.json?.committed).toBe(when === "after");
    expect((await factorState(f)).sessions.length).toBe(old + (when === "after" ? 1 : 0));
    expect((await rows(f, `SELECT sessionId FROM ${ADMISSION.evidence}`)).length).toBe(evidence + (when === "after" ? 1 : 0));
    expect(await receipt(f)).toMatchObject({ state: when === "after" ? "succeeded" : "failed" });
    expect(f.evidence.events.length).toBe(notifications);
    expect(await charged(f)).toBe(2);
  });

  it.each(["before", "after"] as const)("3: enrollment rotation notifications are delivered only after known %s-COMMIT state", async when => {
    const f = await create(); const { browser, authenticator } = await setup(f, OWNER_EMAIL, false);
    const notifications = f.evidence.events.length; fault(f, ADMISSION.evidence, when);
    expect((await verify(browser, authenticator.code())).status).toBe(when === "after" ? 503 : 500);
    expect(f.evidence.events.length).toBe(notifications + (when === "after" ? 1 : 0));
    expect(await receipt(f)).toMatchObject({ state: when === "after" ? "succeeded" : "failed" });
  });

  it("3: notification failure reports committed:true without refunding or deleting a success receipt", async () => {
    const f = await create(); const { browser, authenticator } = await setup(f, OWNER_EMAIL, false);
    f.evidence.failInvalidation = true;
    await expect(verify(browser, authenticator.code())).rejects.toMatchObject({ code: "invalidation_failed", committed: true });
    f.evidence.failInvalidation = false;
    expect(await receipt(f)).toMatchObject({ state: "succeeded" }); expect(await charged(f)).toBe(1);
    expect((await factorState(f)).verified).toBe(1);
  });

  it("3: failed COMMIT and ROLLBACK never publish an uncommitted receipt or notification", async () => {
    const f = await create(); const { browser, authenticator } = await setup(f, OWNER_EMAIL, false);
    const before = await factorState(f); const notifications = f.evidence.events.length;
    f.control.fault = { sql: /^(commit|rollback)$/i, afterSql: /insert into factor_admission_evidence/i, when: "before", remaining: 2 };
    const outcome = await verify(browser, authenticator.code()).then(
      result => ({ committed: result.json?.committed === true }),
      (error: { committed?: boolean }) => ({ committed: error.committed === true }),
    );
    expect(outcome.committed).toBe(false);
    expect(f.control.fault.remaining).toBe(0);
    expect(f.evidence.events.length).toBe(notifications);
    // The owner rolls back the still-open transaction and refuses further provider work.
    expect(f.store.admissionSnapshot()).toMatchObject({ state: "provider_closed", providerExecutions: 0 });
    const state = await f.store.admission.run(() => {
      const core = (f.store as unknown as { database: Database.Database }).database;
      return {
        sessions: (core.prepare('SELECT id FROM authentication_ba_session ORDER BY id').all() as { id: string }[]).map(row => row.id),
        verified: (core.prepare(`SELECT verified FROM ${FACTOR_MODEL}`).get() as { verified: number }).verified,
        charged: (core.prepare(`SELECT sum(charged) n FROM ${ADMISSION.budgets}`).get() as { n: number }).n,
        receipt: (core.prepare(`SELECT state FROM ${ADMISSION.receipts} WHERE attemptId = ?`).get(f.control.admission.lastAttemptId!) as { state: string }).state,
      };
    });
    expect(state).toEqual({ sessions: before.sessions, verified: 0, charged: 1, receipt: "charged" });
  });

  it("3: failed admission reconciliation refuses evaluation without refund or a rollback claim", async () => {
    const f = await create(); const { authenticator } = await setup(f); const b = await pending(f);
    const entries = f.control.admission.entries.length;
    f.control.fault = { sql: /^SELECT \* FROM factor_admission_receipts/i, afterSql: /^commit$/i, when: "before", remaining: 1 };
    const result = await verify(b, authenticator.code());
    expect(result.status).toBe(503); expect(result.json?.outcome === "outcome_unconfirmed").toBe(true);
    expect(result.json?.committed === undefined).toBe(true); expect(result.setCookie.length).toBe(0);
    expect(f.control.admission.entries.length).toBe(entries); expect(await charged(f)).toBe(2);
    expect((await receipt(f))?.state).toBe("failed");
  });

  it("3: a receipt read failure after actual COMMIT never claims rollback or re-evaluates", async () => {
    const f = await create(); const { browser, authenticator } = await setup(f, OWNER_EMAIL, false);
    const notifications = f.evidence.events.length;
    f.control.admission.pause = async stage => {
      if (stage === "after-native") f.control.fault = { sql: /^(commit|SELECT \* FROM factor_admission_receipts)/i, afterSql: /^commit$/i, when: "after", remaining: 2 };
    };
    const result = await verify(browser, authenticator.code());
    expect(result.status).toBe(503); expect(result.json?.outcome === "outcome_unconfirmed").toBe(true);
    expect(result.json?.committed === undefined).toBe(true); expect(result.setCookie.length).toBe(0);
    expect(f.control.fault?.remaining).toBe(0); expect(f.evidence.events.length).toBe(notifications);
    const completed = await receipt(f); expect(completed?.state).toBe("succeeded");
    expect((await rows(f, `SELECT sessionId FROM ${ADMISSION.evidence} WHERE sessionId = ?`, [completed!.sessionId])).length).toBe(1);
    expect((await factorState(f)).verified).toBe(1); expect(await charged(f)).toBe(1);
    const entries = f.control.admission.entries.length;
    f.control.admission.internalAttemptId = completed!.attemptId;
    expect((await verify(browser, authenticator.code())).status).toBe(409);
    expect(f.control.admission.entries.length).toBe(entries);
  });

  it.each(["api-error", "sql", "session-veto", "cookie-veto", "evidence-veto"] as const)("4: %s preserves a charge and rolls back all success writes", async kind => {
    const f = await create(); const { authenticator } = await setup(f); const b = await pending(f);
    const before = (await factorState(f)).sessions.length;
    if (kind === "sql") f.control.fault = { sql: /insert into "authentication_ba_session"/i, when: "after", remaining: 1 };
    if (kind === "session-veto") f.control.vetoSessionCreate = true;
    if (kind === "cookie-veto") f.control.failCookie = true;
    if (kind === "evidence-veto") f.control.failEvidence = true;
    const result = await verify(b, kind === "api-error" ? authenticator.wrong() : authenticator.code());
    expect(result.status >= 400).toBe(true); expect(result.setCookie.length).toBe(0);
    expect(await charged(f)).toBe(2); expect(await receipt(f)).toMatchObject({ state: "failed" });
    expect((await factorState(f)).sessions.length).toBe(before);
  });

  it.each(["after-admission", "native-entry", "after-native"] as const)("4/10: cancellation at %s retains admission and blocks late effects", async stage => {
    const f = await create(); const { authenticator } = await setup(f); const b = await pending(f);
    const before = (await factorState(f)).sessions.length; const hold = pause(f, stage); const abort = new AbortController();
    const result = verify(b, authenticator.code(), { signal: abort.signal });
    await hold.paused; abort.abort(); hold.resume();
    expect((await result).status).toBeGreaterThanOrEqual(400);
    expect(await charged(f)).toBe(2); expect(await receipt(f)).toMatchObject({ state: "failed" });
    expect((await factorState(f)).sessions.length).toBe(before);
  });

  it("4: borrow expiry retains the charged row and owner until the late native continuation drains", async () => {
    const f = await create([], 1_500); const { authenticator } = await setup(f); const b = await pending(f);
    const before = (await factorState(f)).sessions.length; const hold = pause(f, "native-entry");
    const result = verify(b, authenticator.code()).then(() => "unexpected", (e: { code: string }) => e.code);
    await hold.paused;
    expect(await result).toBe("expired");
    expect(f.store.admissionSnapshot()).toMatchObject({ state: "provider_closed", providerExecutions: 1 });
    expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
    await expect(f.store.closeAfterDrain(10)).rejects.toThrow();
    expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
    hold.resume(); expect(await f.storage.drain(2_000)).toBe(true);
    // Read the existing owner's admitted core facade after provider admission closes.
    // This is the SAME handle; no read-only second connection/inspector is opened.
    const projection = await f.store.admission.run(() => {
      const core = (f.store as unknown as { database: Database.Database }).database;
      return {
        charged: (core.prepare(`SELECT sum(charged) n FROM ${ADMISSION.budgets}`).get() as { n: number }).n,
        state: (core.prepare(`SELECT state FROM ${ADMISSION.receipts} WHERE attemptId = ?`).get(f.control.admission.lastAttemptId!) as { state: string }).state,
        sessions: (core.prepare('SELECT count(*) n FROM authentication_ba_session').get() as { n: number }).n,
      };
    });
    expect(projection).toEqual({ charged: 2, state: "charged", sessions: before });
  });

  it("5: queued requests consume only available slots; new challenges/reload never reset the subject budget", async () => {
    const f = await create(); const { authenticator } = await setup(f);
    f.control.admission.policy.attempts = 2; const b = await pending(f);
    const results = await Promise.all([verify(b.clone(), authenticator.wrong()), verify(b.clone(), authenticator.wrong()), verify(b.clone(), authenticator.wrong())]);
    expect(results.map(x => x.status).sort()).toEqual([401, 429, 429]);
    expect(await charged(f)).toBe(2);
    await reload(f); const fresh = await pending(f);
    const entries = f.control.admission.entries.length;
    expect((await verify(fresh, authenticator.code())).status).toBe(429);
    expect(f.control.admission.entries.length).toBe(entries); expect(await charged(f)).toBe(2);
  });

  it.each(["generation", "epoch"] as const)("5/10: stale %s cannot settle, while later-window charges survive", async kind => {
    const f = await create(); const { authenticator } = await setup(f); const b = await pending(f);
    f.control.admission.pause = async (stage, connection) => {
      if (stage !== "after-native") return;
      if (kind === "epoch") vi.setSystemTime(Date.now() + f.control.admission.policy.windowMs);
      else connection.prepare(`UPDATE ${ADMISSION.subjects} SET generation = generation + 1 WHERE subject = ?`).run([f.subject]);
    };
    expect((await verify(b, authenticator.code())).status).toBe(500);
    f.control.admission.pause = undefined;
    expect(await receipt(f)).toMatchObject({ state: "failed" });
    expect(await charged(f)).toBe(2);
    vi.setSystemTime(Date.now() + f.control.admission.policy.windowMs);
    const fresh = await pending(f); expect((await verify(fresh, authenticator.wrong())).status).toBe(401);
    expect(await charged(f)).toBeGreaterThanOrEqual(1);
  });

  it("6: duplicate internal attempts, different credentials, and lost responses never evaluate or mint twice", async () => {
    const f = await create(); const { authenticator } = await setup(f); const b = await pending(f), retry = b.clone();
    fault(f, ADMISSION.evidence, "after");
    expect((await verify(b, authenticator.code())).status).toBe(503);
    const attemptId = f.control.admission.lastAttemptId!; const entries = f.control.admission.entries.length;
    const sessions = (await factorState(f)).sessions.length;
    f.control.admission.internalAttemptId = attemptId;
    for (const code of [authenticator.code(), authenticator.wrong()]) {
      const result = await verify(retry, code);
      expect(result.status).toBe(409); expect(result.json?.committed).toBe(true); expect(result.setCookie.length).toBe(0);
    }
    expect(f.control.admission.entries.length).toBe(entries); expect((await factorState(f)).sessions.length).toBe(sessions); expect(await charged(f)).toBe(2);
    f.control.admission.internalAttemptId = undefined;
    const fresh = await pending(f); expect((await verify(fresh, authenticator.wrong())).status).toBe(401);
    expect(await charged(f)).toBe(3);
  });

  it("5/6: earlier settlement and duplicate failed attempts cannot erase later admissions", async () => {
    const f = await create(); const { authenticator } = await setup(f);
    const wrong = await pending(f);
    expect((await verify(wrong, authenticator.wrong())).status).toBe(401);
    const failedId = f.control.admission.lastAttemptId!;
    const correct = await pending(f);
    expect((await verify(correct, authenticator.code())).status).toBe(200);
    const successId = f.control.admission.lastAttemptId!;
    const later = await pending(f);
    expect((await verify(later, authenticator.wrong())).status).toBe(401);
    expect(await charged(f)).toBe(4);
    const entries = f.control.admission.entries.length;
    for (const id of [failedId, successId]) {
      f.control.admission.internalAttemptId = id;
      expect((await verify(wrong, authenticator.code())).status).toBe(409);
    }
    f.control.admission.internalAttemptId = undefined;
    expect(f.control.admission.entries.length).toBe(entries);
    expect(await charged(f)).toBe(4);
    expect((await rows<{ sequence: number }>(f, `SELECT sequence FROM ${ADMISSION.receipts} WHERE sequence > 0 ORDER BY sequence`)).map(x => x.sequence)).toEqual([1, 2, 3, 4]);
    expect((await verify(await pending(f), authenticator.code())).status).toBe(429);
  });

  it("7: two actual subjects have separate budgets; TOTP and recovery share the subject's budget", async () => {
    const email = "second@fixture.invalid"; const f = await create([email]);
    const first = await setup(f), second = await setup(f, email);
    const b = await pending(f), other = await pending(f, email);
    expect((await verify(b, first.authenticator.wrong())).status).toBe(401);
    expect((await b.post("/two-factor/verify-backup-code", { code: "invalid-recovery" })).status).toBe(401);
    expect(await charged(f, f.subjects[0])).toBe(3); expect(await charged(f, f.subjects[1])).toBe(1);
    // The first subject's credential cannot complete the other subject's challenge.
    expect((await other.post("/two-factor/verify-backup-code", { code: first.codes[0] })).status).toBe(401);
    expect(await charged(f, f.subjects[1])).toBe(2);
    expect((await other.post("/two-factor/verify-backup-code", { code: second.codes[0] })).status).toBe(200);
    expect(await charged(f, f.subjects[1])).toBe(3);
    expect((await rows(f, `SELECT authorizingMfa FROM ${ADMISSION.evidence}`)).every(x => x.authorizingMfa === 0)).toBe(true);
  });

  it.each(["missing", "tampered-cookie", "wrong-purpose", "wrong-subject", "factor-missing", "unverified", "expired", "revoked", "credential-generation", "security-generation", "native-missing"] as const)("7: %s context is denied before native entry", async kind => {
    const f = await create(); const { authenticator } = await setup(f); const b = await pending(f);
    const opaque = b.cookies.get(COOKIE.challenge)!;
    if (kind === "missing") await fixtureSql(f, `DELETE FROM ${ADMISSION.contexts}`);
    if (kind === "tampered-cookie") b.cookies.set(COOKIE.challenge, `${opaque}tampered`);
    if (kind === "wrong-purpose") await fixtureSql(f, `UPDATE ${ADMISSION.contexts} SET purpose = 'enrollment' WHERE capability = ?`, [capabilityId(opaque)]);
    if (kind === "wrong-subject") await fixtureSql(f, `UPDATE ${ADMISSION.contexts} SET subject = 'unmapped' WHERE capability = ?`, [capabilityId(opaque)]);
    if (kind === "unverified") await fixtureSql(f, `UPDATE ${FACTOR_MODEL} SET verified = 0`);
    if (kind === "factor-missing") await fixtureSql(f, `DELETE FROM ${FACTOR_MODEL}`);
    if (kind === "expired") vi.setSystemTime(Date.now() + 601_000);
    if (kind === "revoked") await fixtureSql(f, "UPDATE authentication_provider_subjects SET status = 'revoked', revoked_at = ? WHERE subject = ?", [new Date().toISOString(), f.subject]);
    if (kind === "credential-generation") await fixtureSql(f, `UPDATE ${FACTOR_MODEL} SET id = id || '-replaced'`);
    if (kind === "security-generation") await fixtureSql(f, `UPDATE ${ADMISSION.subjects} SET generation = generation + 1`);
    if (kind === "native-missing") await fixtureSql(f, 'DELETE FROM authentication_ba_verification');
    const entries = f.control.admission.entries.length;
    expect((await verify(b, authenticator.code())).status).toBe(401);
    expect(f.control.admission.entries.length).toBe(entries); expect(await charged(f)).toBe(1);
  });

  it("8: the real module-global same-IP limiter survives new transaction auth instances and provider reload", async () => {
    const f = await create(); const { authenticator } = await setup(f); const b = await pending(f);
    f.control.admission.policy.attempts = 10;
    const ip = "198.51.100.213";
    for (let n = 0; n < 3; n++) expect((await verify(b, authenticator.wrong(), { ip })).status).toBe(401);
    await reload(f);
    expect((await verify(b, authenticator.wrong(), { ip })).status).toBe(429);
    // A distinct trusted fixture peer escapes only the IP bucket, not the account charge.
    expect((await verify(b, authenticator.wrong(), { ip: "198.51.100.214" })).status).toBe(401);
    expect(await charged(f)).toBe(6);
  });

  it("9: real password evidence/session/receipt are atomic and reload never manufactures MFA", async () => {
    const f = await create(); const b = new Browser(f);
    expect((await b.signIn()).status).toBe(200);
    const attemptId = f.control.admission.lastAttemptId!;
    const evidence = await rows(f, `SELECT sessionId, subject, method, observation, authenticatedAt, originalDeadline, authorizingMfa FROM ${ADMISSION.evidence}`);
    expect(evidence).toHaveLength(1); expect(evidence[0]).toMatchObject({ subject: f.subject, method: "password", observation: "password", authorizingMfa: 0 });
    expect(await receipt(f, attemptId)).toMatchObject({ sessionId: evidence[0]!.sessionId, state: "succeeded" });
    await reload(f);
    expect(await rows(f, `SELECT sessionId, subject, method, observation, authenticatedAt, originalDeadline, authorizingMfa FROM ${ADMISSION.evidence}`)).toEqual(evidence);
    expect((await b.resolve())?.session.authentication).toEqual({ method: "password", factors: 1 });
    await expect(f.runtime.authenticate(new Headers({ cookie: b.cookieHeader() }))).rejects.toMatchObject({ code: "provider_unavailable" });
    expect((await factorState(f)).schemaVersion).toBe(45);
    f.control.failEvidence = true; const old = (await factorState(f)).sessions.length;
    expect((await new Browser(f).signIn()).status).toBe(500);
    expect((await factorState(f)).sessions.length).toBe(old); expect(await receipt(f)).toBeNull();
  });

  it("9: factor settlement preserves the original password time/deadline and only a nonauthorizing observation", async () => {
    const f = await create(); const { authenticator } = await setup(f); const b = await pending(f);
    const start = Date.now(); vi.setSystemTime(start + 5_000);
    expect((await verify(b, authenticator.code())).status).toBe(200);
    const r = await receipt(f);
    const [evidence] = await rows(f, `SELECT authenticatedAt, originalDeadline, observation, method, authorizingMfa FROM ${ADMISSION.evidence} WHERE sessionId = ?`, [r!.sessionId]);
    expect(evidence).toMatchObject({ authenticatedAt: new Date(start).toISOString(), originalDeadline: new Date(start + 8 * 60 * 60 * 1000).toISOString(), method: "password", observation: "password_totp", authorizingMfa: 0 });
  });

  it.each([false, true])("9: delayed enrollment preserves password evidence despite native refresh (resolve first: %s)", async resolveFirst => {
    const f = await create(); const b = new Browser(f);
    expect((await b.signIn()).status).toBe(200);
    const [original] = await rows<{ authenticatedAt: string; originalDeadline: string }>(f, `SELECT authenticatedAt, originalDeadline FROM ${ADMISSION.evidence}`);
    vi.setSystemTime(Date.now() + 3_601_000);
    if (resolveFirst) expect((await b.resolve()) !== null).toBe(true);
    const enabled = await b.post("/two-factor/enable", { password: OWNER_PASSWORD });
    expect(enabled.status).toBe(200);
    const authenticator = new Authenticator(enabled.json!.totpURI as string);
    expect((await verify(b, authenticator.code())).status).toBe(200);
    const completed = await receipt(f);
    const [evidence] = await rows(f, `SELECT authenticatedAt, originalDeadline FROM ${ADMISSION.evidence} WHERE sessionId = ?`, [completed!.sessionId]);
    expect(evidence).toEqual(original);
    const [session] = await rows<{ expiresAt: number }>(f, 'SELECT "expiresAt" FROM authentication_ba_session WHERE id = ?', [completed!.sessionId]);
    expect(Number(session!.expiresAt)).toBeLessThanOrEqual(Date.parse(original!.originalDeadline));
  });

  it.each(["missing", "generation", "expired"] as const)("9: enrollment refuses %s password evidence even with a native live session", async kind => {
    const f = await create(); const b = new Browser(f);
    expect((await b.signIn()).status).toBe(200);
    if (kind === "missing") await fixtureSql(f, `DELETE FROM ${ADMISSION.evidence}`);
    if (kind === "generation") await fixtureSql(f, `UPDATE ${ADMISSION.subjects} SET generation = generation + 1`);
    if (kind === "expired") {
      vi.setSystemTime(Date.now() + 4 * 60 * 60 * 1000);
      expect((await b.resolve()) !== null).toBe(true); // Native refresh extends beyond the original deadline.
      vi.setSystemTime(Date.now() + 4 * 60 * 60 * 1000 + 1);
      expect((await b.resolve()) !== null).toBe(true);
    }
    const before = await factorState(f);
    const result = await b.post("/two-factor/enable", { password: OWNER_PASSWORD });
    expect(result.status >= 400).toBe(true); expect(result.json?.totpURI === undefined).toBe(true);
    expect(result.setCookie.length).toBe(0); expect(await factorState(f)).toEqual(before);
  });

  it("10: SQL diagnostics retain a bounded tail without parameters", async () => {
    const f = await create(); const { authenticator } = await setup(f); const b = await pending(f);
    const sentinel = "trace-parameter-must-not-appear";
    f.control.admission.pause = async (stage, connection) => {
      if (stage !== "after-admission") return;
      for (let index = 0; index <= FACTOR_SQL_TRACE_LIMIT; index++) connection.prepare("SELECT ?").all([sentinel]);
    };
    expect((await verify(b, authenticator.code())).status).toBe(200);
    expect(f.control.trace.length).toBe(FACTOR_SQL_TRACE_LIMIT);
    expect(JSON.stringify(f.control.trace).includes(sentinel)).toBe(false);
    expect(f.control.trace.at(-1)?.sql).toBe("commit");
  });

  it("10: ticket expiry and window rollover never refund; pruning never evicts live charges", async () => {
    const f = await create(); const { authenticator } = await setup(f); const b = await pending(f);
    const hold = pause(f, "after-admission"); const result = verify(b, authenticator.code());
    await hold.paused; vi.setSystemTime(Date.now() + f.control.admission.policy.ticketMs); hold.resume();
    expect((await result).status).toBe(409); expect(await charged(f)).toBe(2);
    const id = f.control.admission.lastAttemptId!;
    // Retained charged rows model a timed-out execution awaiting reconciliation.
    await fixtureSql(f, `UPDATE ${ADMISSION.receipts} SET state = 'charged' WHERE attemptId = ?`, [id]);
    vi.setSystemTime(Date.now() + 700_000);
    await policyCall(f, p => p.prune(Date.now()));
    expect(await receipt(f, id)).toMatchObject({ state: "charged" }); expect(await charged(f)).toBe(2);
    expect((await rows(f, `SELECT capability FROM ${ADMISSION.contexts} WHERE capability = ?`, [capabilityId(b.cookies.get(COOKIE.challenge)!)])).length).toBe(1);
    // A new epoch can charge, but the old live row is retained.
    const fresh = await pending(f); expect((await verify(fresh, authenticator.wrong())).status).toBe(401);
    expect(await charged(f)).toBe(3);
  });

  it("10: bounded receipt/context capacity refuses work instead of evicting denial state", async () => {
    const f = await create(); const { authenticator } = await setup(f); const b = await pending(f);
    const count = (await rows(f, `SELECT attemptId FROM ${ADMISSION.receipts}`)).length;
    f.control.admission.policy.capacity = count;
    const before = f.control.admission.entries.length;
    expect((await verify(b, authenticator.code())).status).toBe(429);
    expect(f.control.admission.entries.length).toBe(before); expect(await charged(f)).toBe(1);
    expect((await rows(f, `SELECT attemptId FROM ${ADMISSION.receipts}`)).length).toBe(count);
  });

  it("10: bounded prune batches remove only expired terminal records; pre-aborted requests never charge", async () => {
    const f = await create(); const { authenticator } = await setup(f); const b = await pending(f);
    const abort = new AbortController(); abort.abort(); const before = await charged(f);
    expect((await verify(b, authenticator.code(), { signal: abort.signal })).status).toBe(409);
    expect(await charged(f)).toBe(before);
    f.control.admission.policy.pruneBatch = 1;
    await fixtureSql(f, `UPDATE ${ADMISSION.receipts} SET deadline = 0 WHERE state = 'succeeded'`);
    const old = (await rows(f, `SELECT attemptId FROM ${ADMISSION.receipts}`)).length;
    await policyCall(f, p => p.prune(Date.now()));
    expect((await rows(f, `SELECT attemptId FROM ${ADMISSION.receipts}`)).length).toBe(old - 1);
  });

  it("10: credential sentinels cannot enter receipt, evidence, traces, errors or notification diagnostics", async () => {
    const f = await create(); const { authenticator, codes } = await setup(f); const b = await pending(f);
    const opaque = b.cookies.get(COOKIE.challenge)!;
    f.control.failEvidence = true;
    const sentinel = "I13-credential-sentinel-do-not-log";
    const result = await verify(b, sentinel);
    const serialized = JSON.stringify({ json: result.json, sql: f.control.trace, entries: f.control.admission.entries, events: f.evidence.events, logs: f.evidence.logs, receipts: await rows(f, `SELECT * FROM ${ADMISSION.receipts}`), evidence: await rows(f, `SELECT * FROM ${ADMISSION.evidence}`) });
    for (const value of [sentinel, opaque, OWNER_PASSWORD, SECRET, ...codes, authenticator.code()]) expect(serialized.includes(value)).toBe(false);
    expect(result.setCookie.length).toBe(0);
  });
});
