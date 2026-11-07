import { fileURLToPath } from "node:url";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import { FileProviderConfiguration } from "@/server/authentication-provider-configuration";
import { loadAuthenticationProvider } from "@/server/modules/authentication";
import { join } from "node:path";
import { PasskeyAuthenticator } from "./passkey-authenticator";
import { Authenticator, Browser } from "./factor-fixture";
import { loadProof, readyIssuance, ISSUANCE } from "./fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { integrated, enrollTotp, enrollPasskey, passkeyLogin, passkeyOptions, pendingLogin, protectionState, select, sql, factorOptions, stagePasskey, fence, advance, STEP, verify, type Integrated } from "./integrated-fixture";
import { closeStrictProof, cleanupStrictRoots, gate } from "./strict-fixture";
import { OWNER_EMAIL, OWNER_PASSWORD, Client, readCommitted } from "./fixture";
import { onlineCliFixture, cliFixture } from "./cli-provider-fixture";
import type { ProofFaultInjection } from "../src/index";

const nextPassword = "fixture-protected-recovery-2";
const opened: Integrated[] = [];
const create = async (faults: ProofFaultInjection = {}) => { const f = await integrated(faults); opened.push(f); return f; };
const recover = (f: Integrated, factors?: "reset" | "preserve") => f.runtime.recoverLocal({ principalId: f.owner.principalId, newPassword: nextPassword, actor: "local-cli", ...(factors ? { factors } : {}) });
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-07T12:00:05Z")); });
afterEach(async () => { vi.useRealTimers(); for (const f of opened.splice(0)) await closeStrictProof(f); cleanupStrictRoots(); vi.restoreAllMocks(); });
const snapshot = async (f: Integrated) => {
  const tables = ["authentication_ba_user", "authentication_ba_account", "authentication_ba_session", "authentication_ba_two_factor", "authentication_ba_passkey", "authentication_account_policies", "authentication_passkey_trust", "authentication_passkey_staged", "authentication_factor_contexts", "authentication_factor_receipts", "authentication_totp_steps", "authentication_factor_budgets", "authentication_session_evidence", "authentication_session_issuance", "authentication_ba_verification", "controller_audit_events", "remote_principals", "authentication_provider_subjects"];
  const state: Record<string, unknown> = {};
  for (const t of tables) state[t] = await select(f, `SELECT * FROM "${t}" ORDER BY 1`);
  return state;
};

describe("protected real provider factor-loss recovery", () => {
  it.each(["none", "totp", "passkey", "both"])("resets %s, keeps identity/roles/history, denies old proofs, permits optional new enrollment", async kind => {
    const f = await create(); await f.grant();
    const browser = f.browser(); await browser.signIn();
    const actor = await f.authenticate(browser);
    let totp: Awaited<ReturnType<typeof enrollTotp>> | undefined;
    let passkey: Awaited<ReturnType<typeof enrollPasskey>> | undefined;
    if (kind === "passkey" || kind === "both") passkey = await enrollPasskey(f, browser);
    if (kind === "totp" || kind === "both") {
      const b = passkey ? (await passkeyLogin(f, passkey)).browser : f.browser();
      totp = await enrollTotp(f, b);
    }
    const pending = totp ? await pendingLogin(f) : undefined;
    const oldOptions = passkey ? await passkeyOptions(f.browser(), "authenticate") : undefined;
    const before = await protectionState(f);
    const stable = await select(f, "SELECT * FROM remote_principals ORDER BY id");
    const mappings = await select(f, "SELECT * FROM authentication_provider_subjects");
    const grants = await select(f, "SELECT * FROM knowledge_project_grants");
    expect(await recover(f, "reset")).toEqual({ totp: !!totp, passkeys: passkey ? 1 : 0 });
    const after = await protectionState(f);
    expect(after.policy).toMatchObject({ generation: before.policy!.generation + 1, policy_revision: before.policy!.policy_revision + 1, totp_selected: 0, passkey_selected: 0 });
    expect(after.sessions).toEqual([]); expect(after.evidence).toEqual([]); expect(after.trusted).toBe(0); expect(after.staged).toBe(0);
    expect(after.step).toBe(before.step); expect(after.charged).toBe(before.charged);
    expect(await select(f, "SELECT * FROM remote_principals ORDER BY id")).toEqual(stable);
    expect(await select(f, "SELECT * FROM authentication_provider_subjects")).toEqual(mappings);
    expect(await select(f, "SELECT * FROM knowledge_project_grants")).toEqual(grants);
    expect(await f.authenticate(browser)).toBeNull();
    await expect(f.read(actor!)).rejects.toMatchObject({ code: "invalid_credential" });
    expect((await f.browser().signIn()).status).toBe(401);
    if (pending) expect((await verify(pending, totp!.authenticator.code())).status).toBeGreaterThanOrEqual(400);
    if (passkey) {
      expect((await f.browser().post("/passkey/verify-authentication", { response: passkey.assert(oldOptions!) })).status).toBeGreaterThanOrEqual(400);
      expect((await passkeyLogin(f, passkey)).result.status).toBeGreaterThanOrEqual(400);
    }
    const fresh = f.browser(); expect((await fresh.signIn(nextPassword)).status).toBe(200);
    const current = await f.authenticate(fresh); expect(current?.principalId).toBe(f.owner.principalId); await expect(f.read(current!)).resolves.toBeDefined();
    const replacement = await enrollPasskey(f, fresh);
    expect((await passkeyLogin(f, replacement)).result.status).toBe(200);
    if (passkey) expect((await passkeyLogin(f, passkey)).result.status).toBeGreaterThanOrEqual(400);
  });

  it("reenrolls a new TOTP binding and refuses the old seed", async () => {
    const f = await create(), old = await enrollTotp(f);
    await recover(f, "reset"); advance(2 * STEP);
    const b = f.browser(); expect((await b.signIn(nextPassword)).status).toBe(200);
    const started = await b.post("/two-factor/enable", { password: nextPassword });
    expect(started.status).toBe(200);
    const fresh = new Authenticator(started.json!.totpURI as string);
    expect((await verify(b, old.authenticator.code())).status).toBeGreaterThanOrEqual(400);
    expect((await verify(b, fresh.code())).status).toBe(200);
    advance(2 * STEP);
    const pending = await pendingLogin(f, nextPassword);
    expect((await verify(pending, old.authenticator.code())).status).toBeGreaterThanOrEqual(400);
    expect((await verify(pending, fresh.code())).status).toBe(200);
  });

  it.each([undefined, "preserve"] as const)("preserves selected factors by default (%s)", async mode => {
    const f = await create(), { authenticator } = await enrollTotp(f);
    const before = await protectionState(f);
    await recover(f, mode);
    expect((await protectionState(f)).policy).toEqual(before.policy);
    const b = await pendingLogin(f, nextPassword); advance(2 * STEP);
    expect((await verify(b, authenticator.code())).status).toBe(200);
  });

  it.each(["sessions", "password", "commit"])("rolls back every old row when faulting at %s", async edge => {
    const faults: ProofFaultInjection = {}, f = await create(faults);
    const { authenticator } = await enrollTotp(f); await pendingLogin(f); advance(2 * STEP);
    const before = await snapshot(f);
    const patterns = { sessions: /delete from "authentication_ba_session"/i, password: /update "authentication_ba_account"/i, native: /DELETE FROM authentication_ba_passkey/i, audit: /INSERT INTO controller_audit_events/i, commit: /^commit$/i };
    faults.sqlFault = { sql: patterns[edge as keyof typeof patterns], when: "before", remaining: 1 };
    await expect(recover(f, "reset")).rejects.toBeDefined();
    expect(await snapshot(f)).toEqual(before);
    faults.sqlFault = undefined; faults.beforeRecoveryCommit = undefined;
    const pending = await pendingLogin(f); expect((await verify(pending, authenticator.code())).status).toBe(200);
  });

  it.each([
    ["generation", "UPDATE", "authentication_account_policies"],
    ["contexts", "UPDATE", "authentication_factor_contexts"],
    ["passkeys", "DELETE", "authentication_ba_passkey"],
    ["totp", "DELETE", "authentication_ba_two_factor"],
    ["flags", "UPDATE", "authentication_ba_user"],
    ["audit", "INSERT", "controller_audit_events"],
  ])("rolls back native/core state on a real %s SQL failure", async (_edge, verb, table) => {
    const f = await create(), b = f.browser(); await b.signIn();
    const key = await enrollPasskey(f, b); await enrollTotp(f, (await passkeyLogin(f, key)).browser); await pendingLogin(f);
    const before = await snapshot(f);
    await sql(f, `CREATE TEMP TRIGGER recovery_fault BEFORE ${verb} ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture recovery fault'); END`);
    try { await expect(recover(f, "reset")).rejects.toBeDefined(); expect(await snapshot(f)).toEqual(before); }
    finally { await sql(f, "DROP TRIGGER recovery_fault"); }
  });

  it("rechecks disabled mapping after the hashing await without changing any credential", async () => {
    const faults: ProofFaultInjection = {}, f = await create(faults);
    const before = await select(f, "SELECT * FROM authentication_ba_account");
    faults.beforeRecoveryHash = async () => { f.storage.runControllerOperation(() => f.store.savePrincipal({ id: f.owner.principalId, kind: "owner", status: "revoked" }, "fixture")); };
    await expect(recover(f, "reset")).rejects.toMatchObject({ code: "principal_unavailable" });
    expect(await select(f, "SELECT * FROM authentication_ba_account")).toEqual(before);
  });

  it.each(["agent", "worker", "missing", "unlinked", "disabled", "revoked-mapping", "ambiguous-owner"])("refuses %s without changing recovery state", async kind => {
    const f = await create(); let principalId = f.owner.principalId;
    if (kind === "agent" || kind === "worker" || kind === "unlinked") {
      principalId = "unrecoverable-principal";
      await f.run(() => f.store.savePrincipal({ id: principalId, kind: kind === "unlinked" ? "human" : kind, status: "active" }, "fixture"));
    }
    if (kind === "missing") principalId = "missing-principal";
    if (kind === "disabled") await f.run(() => f.store.savePrincipal({ id: principalId, kind: "owner", status: "revoked" }, "fixture"));
    if (kind === "revoked-mapping") await sql(f, "UPDATE authentication_provider_subjects SET status='revoked', revoked_at=?", [new Date().toISOString()]);
    if (kind === "ambiguous-owner") await f.run(() => f.store.savePrincipal({ id: "second-owner", kind: "owner", status: "active" }, "fixture"));
    const before = await snapshot(f);
    await expect(f.runtime.recoverLocal({ principalId, newPassword: nextPassword, factors: "reset", actor: "local-cli" })).rejects.toBeDefined();
    expect(await snapshot(f)).toEqual(before);
  });

  it("refuses old password-only capability before any account write", async () => {
    const f = await create(); const before = await snapshot(f); await f.runtime.dispose();
    const old = await loadProof(f.store, undefined, fileURLToPath(new URL("./loader-fixtures/password-only-recovery.ts", import.meta.url)));
    try {
      expect(old.runtime.supportsLocalFactorReset).toBe(false);
      await expect(old.runtime.recoverLocal({ principalId: f.owner.principalId, newPassword: nextPassword, factors: "reset", actor: "local-cli" })).rejects.toMatchObject({ code: "recovery_unavailable" });
      expect(await snapshot(f)).toEqual(before);
      await old.runtime.recoverLocal({ principalId: f.owner.principalId, newPassword: nextPassword, actor: "local-cli" });
    } finally { await old.runtime.dispose(); }
  });

  it("invalidates a staged credential and confirmation context", async () => {
    const f = await create(), browser = f.browser(); await browser.signIn();
    const key = await stagePasskey(f, browser), options = await passkeyOptions(browser, "confirm");
    await recover(f, "reset");
    expect((await browser.post("/passkey/verify-confirmation", { response: key.assert(options) })).status).toBeGreaterThanOrEqual(400);
    expect((await protectionState(f)).staged).toBe(0);
  });

  it("rechecks a principal disabled while recovery waits for its actual borrow", async () => {
    const f = await create(), before = await select(f, "SELECT * FROM authentication_ba_account");
    const held = await fence(f, db => { db.prepare("UPDATE remote_principals SET status='revoked' WHERE id=?").run([f.owner.principalId]); });
    const pending = recover(f, "reset").catch(error => error);
    held.release(); await held.pending;
    expect(await pending).toMatchObject({ code: "principal_unavailable" });
    expect(await select(f, "SELECT * FROM authentication_ba_account")).toEqual(before);
  });

  it("joins an in-flight ceremony, then removes every authority it committed", async () => {
    const faults: ProofFaultInjection = {}, f = await create(faults), b = f.browser(); await b.signIn();
    const key = await stagePasskey(f, b), options = await passkeyOptions(b, "confirm");
    const entered = gate(), release = gate();
    faults.factorPause = async stage => { if (stage === "before-commit") { entered.open(); await release.opened; } };
    const ceremony = b.post("/passkey/verify-confirmation", { response: key.assert(options) });
    try {
      await entered.opened;
      const pending = recover(f, "reset");
      release.open(); await ceremony; await pending;
      expect((await protectionState(f)).trusted).toBe(0);
      expect((await passkeyLogin(f, key)).result.status).toBeGreaterThanOrEqual(400);
    } finally { release.open(); faults.factorPause = undefined; }
  });

  it("reports committed invalidation failure truthfully", async () => {
    const f = await create(); const b = f.browser(); await b.signIn(); f.evidence.failInvalidation = true;
    await expect(recover(f, "reset")).rejects.toMatchObject({ code: "invalidation_failed", committed: true });
    f.evidence.failInvalidation = false;
    expect(await f.authenticate(b)).toBeNull(); expect((await f.browser().signIn()).status).toBe(401);
    expect((await f.browser().signIn(nextPassword)).status).toBe(200);
  });
});

describe("protected CLI ordinary-human recovery", () => {
  it.each(["online", "offline"])("resets real TOTP/passkeys over %s and persists the result on reopen", async transport => {
    const online = transport === "online" ? await onlineCliFixture({ factors: factorOptions() }) : undefined;
    const f = online ?? cliFixture();
    let closeProvider: (() => Promise<void>) | undefined;
    try {
      if (!online) await f.configure();
      const id = online?.principalId ?? await f.create();
      await f.run(["enroll", "--principal-id", id, ...f.input({ email: OWNER_EMAIL, name: "Owner", password: OWNER_PASSWORD })]);
      const open = async () => {
        const store = new SqliteStateStore(f.paths.databasePath), config = new FileProviderConfiguration(join(f.paths.dataDirectory, "authentication-provider.json")).read()!;
        await readyIssuance(store);
        const runtime = await loadAuthenticationProvider({ entry: config.entry, providerId: "better-auth", storage: store.authenticationProviderStorage(), ...ISSUANCE,
          options: { baseURL: config.baseURL, secret: config.secret, clientIpHeader: "x-worktree-control-client-ip", factors: factorOptions() } });
        closeProvider = async () => { await runtime.dispose(); await store.closeAfterDrain(); closeProvider = undefined; };
        return runtime;
      };
      const runtime = online ? online.runtime() : await open();
      const b = new Browser({ runtime }); await b.signIn();
      const key = new PasskeyAuthenticator();
      expect((await b.post("/passkey/verify-registration", { response: key.register(await passkeyOptions(b, "register"), { attestationNone: true }) })).status).toBe(200);
      expect((await b.post("/passkey/verify-confirmation", { response: key.assert(await passkeyOptions(b, "confirm"), { counter: 0 }) })).status).toBe(200);
      const login = new Browser({ runtime });
      expect((await login.post("/passkey/verify-authentication", { response: key.assert(await passkeyOptions(login, "authenticate")) })).status).toBe(200);
      const started = await login.post("/two-factor/enable", { password: OWNER_PASSWORD });
      const seed = new Authenticator(started.json!.totpURI as string);
      expect((await verify(login, seed.code())).status).toBe(200);
      if (!online) await closeProvider!();
      expect(await f.run(["recover", "--principal-id", id, ...f.input({ newPassword: nextPassword, factors: "reset" })])).toMatchObject({ recovered: true, removed: { totp: true, passkeys: 1 } });
      const current = online ? runtime : await open();
      expect((await new Browser({ runtime: current }).signIn()).status).toBe(401);
      const fresh = new Browser({ runtime: current }); expect((await fresh.signIn(nextPassword)).status).toBe(200);
      expect((await current.authenticate(new Headers({ cookie: fresh.cookieHeader() })))?.principalId).toBe(id);
      expect(readCommitted(f.paths.databasePath, db => db.prepare("SELECT count(*) n FROM authentication_ba_passkey").get())).toEqual({ n: 0 });
    } finally { await closeProvider?.(); if (online) await online.close(); else f.remove(); }
  });

  it("refuses maintenance entered during hashing before any recovery write", async () => {
    const faults: ProofFaultInjection = {}, f = await onlineCliFixture({ faults });
    try {
      await f.run(["enroll", "--principal-id", f.principalId, ...f.input({ email: OWNER_EMAIL, name: "Owner", password: OWNER_PASSWORD })]);
      const before = readCommitted(f.paths.databasePath, db => db.prepare("SELECT * FROM authentication_ba_account").all());
      faults.beforeRecoveryHash = async () => { f.maintenance(); };
      await expect(f.run(["recover", "--principal-id", f.principalId, ...f.input({ newPassword: nextPassword, factors: "reset" })])).rejects.toMatchObject({ code: "maintenance" });
      expect(readCommitted(f.paths.databasePath, db => db.prepare("SELECT * FROM authentication_ba_account").all())).toEqual(before);
    } finally { await f.close(); }
  });

  it.each(["online", "offline"])("recovers the existing active human over %s protected administration", async transport => {
    const online = transport === "online" ? await onlineCliFixture() : undefined;
    const f = online ?? cliFixture();
    try {
      if (transport === "offline") await f.configure();
      const principal = (await f.run(["human", "create"])).principal as { id: string };
      await f.run(["enroll", "--principal-id", principal.id, ...f.input({ email: OWNER_EMAIL, name: "Human", password: OWNER_PASSWORD })]);
      const before = readCommitted(f.paths.databasePath, db => db.prepare("SELECT * FROM remote_principals ORDER BY id").all());
      expect(await f.run(["recover", "--principal-id", principal.id, ...f.input({ newPassword: nextPassword, factors: "reset" })])).toEqual({ principalId: principal.id, recovered: true, factors: "reset", removed: { totp: false, passkeys: 0 } });
      expect(readCommitted(f.paths.databasePath, db => db.prepare("SELECT * FROM remote_principals ORDER BY id").all())).toEqual(before);
      if (online) {
        const c = new Client(online.runtime()); expect((await c.signIn(nextPassword)).status).toBe(200);
        expect((await online.runtime().authenticate(new Headers({ cookie: c.cookieHeader() })))?.principalId).toBe(principal.id);
      }
      await f.run(["human", "disable", "--principal-id", principal.id]);
      await expect(f.run(["recover", "--principal-id", principal.id, ...f.input({ newPassword: nextPassword, factors: "reset" })])).rejects.toMatchObject({ code: "principal_unavailable" });
    } finally { if (online) await online.close(); else f.remove(); }
  });
});
