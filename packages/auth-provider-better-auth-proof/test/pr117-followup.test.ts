import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserOperation } from "@/server/modules/authentication";
import type { ProofFaultInjection } from "../src/index";
import { browserFixture, type BrowserFixture } from "./browser-authentication-fixture";
import { betweenResultAndRelease, enrollPasskey, enrollTotp, live, options, passkeyLogin, post, strength } from "./browser-factor-helpers";
import { Client, cleanupRoots, ORIGIN, OWNER_EMAIL, OWNER_PASSWORD } from "./fixture";
import { advance, factorOptions, select, STEP } from "./integrated-fixture";
import { cleanupStrictRoots, gate, sleep } from "./strict-fixture";

const NEW_PASSWORD = "fixture-pr117-replacement-password";
const opened: BrowserFixture[] = [];
async function create(faults: ProofFaultInjection = {}, admission = {}) {
  const f = await browserFixture(faults, { maxQueued: 1, reservedQueued: 16, ...admission }, 8, factorOptions());
  opened.push(f); return f;
}
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-02T12:00:05Z")); });
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const f of opened.splice(0)) await f.close();
  cleanupStrictRoots(); cleanupRoots();
});

/** Saturates ordinary admission only after a real successful provider transaction. */
function saturate(f: BrowserFixture, operation: BrowserOperation, revoke = false) {
  const ready = gate(), release = gate();
  let held: Promise<unknown> | undefined, queued: Promise<unknown> | undefined;
  betweenResultAndRelease(f, operation, async () => {
    const entered = gate();
    held = f.storage.borrow(async () => {
      if (revoke) f.storage.runControllerOperation(() => f.store.savePrincipal({ id: f.owner.principalId, kind: "owner", status: "revoked" }, "fixture"));
      entered.open(); await release.opened;
    });
    await entered.opened;
    queued = f.store.admission.detached(() => undefined).catch(error => error);
    await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBe(1));
    ready.open();
  });
  return { ready: ready.opened, release: async () => { release.open(); await held; await queued; } };
}

describe("PR117 accepted browser completion", () => {
  it("enrolls, confirms and logs in with browser-accurate option GET headers", async () => {
    const f = await create(), client = await f.client().authenticated();
    const authenticator = await enrollPasskey(client);
    expect((await passkeyLogin(client, authenticator)).status).toBe(200);
    await strength(client, "passkey_uv");
  });

  it("denies unproven and foreign option GETs and keeps POST Origin mandatory in both layers", async () => {
    const f = await create(), browser = f.client(), direct = new Client(f.runtime);
    const path = "/passkey/generate-authenticate-options";
    for (const site of [undefined, "cross-site", "same-site", "none", "same-origin, same-origin"]) {
      const headers: Record<string, string> = site ? { "sec-fetch-site": site } : {};
      expect((await browser.call(`/api/auth${path}`, { method: "GET", omitOrigin: true, headers })).status).toBe(403);
      expect((await direct.call(path, { method: "GET", origin: null, headers })).status).toBe(403);
    }
    for (const origin of ["null", "https://foreign.test"]) {
      expect((await browser.call(`/api/auth${path}`, { method: "GET", headers: { origin, "sec-fetch-site": "same-origin" } })).status).toBe(403);
      expect((await direct.call(path, { method: "GET", origin, headers: { "sec-fetch-site": "same-origin" } })).status).toBe(403);
    }
    expect((await direct.call(path, { method: "GET", origin: ORIGIN, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    const headers = { "sec-fetch-site": "same-origin" };
    expect((await direct.call(path, { method: "GET", origin: null, headers })).status).toBe(200);
    expect((await browser.call("/api/auth/two-factor/verify-totp", { omitOrigin: true, headers, body: { code: "123456" } })).status).toBe(403);
    expect((await direct.call("/two-factor/verify-totp", { origin: null, headers, body: { code: "123456" } })).status).toBe(403);
  });

  it.each(["sign-in", "totp-verify", "passkey-authentication", "password"] as const)("publishes %s with ordinary admission saturated", async operation => {
    const f = await create(), client = f.client();
    let perform: () => ReturnType<typeof client.login>, method = "password";
    if (operation === "totp-verify") {
      await client.authenticated(); const authenticator = await enrollTotp(client); advance(STEP * 2);
      expect((await client.login()).status).toBe(200);
      perform = () => post(client, "two-factor/verify-totp", { code: authenticator.code() }); method = "password_totp";
    } else if (operation === "passkey-authentication") {
      await client.authenticated(); const authenticator = await enrollPasskey(client);
      const response = authenticator.assert(await options(client, "authenticate"));
      perform = () => post(client, "passkey/verify-authentication", { response }); method = "passkey_uv";
    } else if (operation === "password") {
      await client.authenticated();
      perform = () => post(client, "change-password", { currentPassword: OWNER_PASSWORD, newPassword: NEW_PASSWORD });
    } else perform = () => client.login();
    const fence = saturate(f, operation);
    try {
      const pending = perform(); await fence.ready; await sleep(10); await fence.release();
      expect(await pending).toMatchObject({ status: 200 });
      await strength(client, method);
      expect(await select(f, "SELECT state FROM authentication_session_issuance")).toEqual([{ state: "may_publish" }]);
    } finally { await fence.release(); }
  });

  it("retries an admission timeout for accepted completion without replaying the effect", async () => {
    const f = await create({}, { admissionTimeoutMs: 25 }), client = f.client(), fence = saturate(f, "sign-in");
    try {
      const pending = client.login(); await fence.ready; await sleep(110); await fence.release();
      expect(await pending).toMatchObject({ status: 200 });
      await strength(client, "password");
      expect(await select(f, 'SELECT "id" FROM "authentication_ba_session"')).toHaveLength(1);
      expect(await select(f, "SELECT state FROM authentication_session_issuance")).toEqual([{ state: "may_publish" }]);
    } finally { await fence.release(); }
  });

  it("still denies authority revoked during final admission", async () => {
    const f = await create(), fence = saturate(f, "sign-in", true);
    try {
      const pending = f.client().login(); await fence.ready; await sleep(10); await fence.release();
      const result = await pending; expect(result.status).toBeGreaterThanOrEqual(400); expect(live(result)).toEqual([]);
      expect(await select(f, 'SELECT "id" FROM "authentication_ba_session"')).toEqual([]);
    } finally { await fence.release(); }
  });

  it("cancels a disconnected final admission and removes its pending session", async () => {
    const f = await create(), fence = saturate(f, "sign-in"), call = f.client().start("/api/auth/sign-in/email");
    const response = call.completed.catch(error => error);
    try {
      call.send(JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD })); await fence.ready;
      call.abort(); await response; await sleep(10); await fence.release();
      await vi.waitFor(async () => expect(await select(f, 'SELECT "id" FROM "authentication_ba_session"')).toEqual([]));
    } finally { await fence.release(); }
  });
});

describe("PR117 old password challenges", () => {
  it.each(["recovery", "change", "reset"] as const)("invalidates a preexisting TOTP challenge atomically with password %s", async operation => {
    const f = await create(), owner = await f.client().authenticated(), authenticator = await enrollTotp(owner);
    advance(STEP * 2);
    const current = f.client(); expect((await current.login()).status).toBe(200);
    expect((await post(current, "two-factor/verify-totp", { code: authenticator.code() })).status).toBe(200);
    const pending = f.client(); expect((await pending.login()).status).toBe(200);
    const before = await select(f, "SELECT generation, policy_revision, totp_selected FROM authentication_account_policies");
    if (operation === "recovery") await f.runtime.recoverLocal({ principalId: f.owner.principalId, newPassword: NEW_PASSWORD, actor: "fixture" });
    else if (operation === "change") {
      expect((await post(current, "change-password", { currentPassword: OWNER_PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(200);
      await strength(current, "password_totp");
    } else {
      const raw = new Client(f.runtime);
      expect((await raw.call("/request-password-reset", { body: { email: OWNER_EMAIL } })).status).toBe(200);
      expect((await raw.call("/reset-password", { body: { token: f.evidence.resets[0]!.token, newPassword: NEW_PASSWORD } })).status).toBe(200);
    }
    expect(await select(f, "SELECT generation, policy_revision, totp_selected FROM authentication_account_policies")).toEqual(before);
    advance(STEP * 2); // A valid unused code: refusal cannot be explained by replay or expiry.
    const rejected = await post(pending, "two-factor/verify-totp", { code: authenticator.code() });
    expect(rejected.status).toBeGreaterThanOrEqual(400); expect(live(rejected)).toEqual([]);
    const fresh = f.client(); expect((await fresh.login(NEW_PASSWORD)).status).toBe(200);
    expect((await post(fresh, "two-factor/verify-totp", { code: authenticator.code() })).status).toBe(200);
    await strength(fresh, "password_totp");
  });

  it.each(["recovery", "change", "reset"] as const)("preserves a pending TOTP challenge after rolled-back password %s", async operation => {
    const faults: ProofFaultInjection = {}, f = await create(faults), owner = await f.client().authenticated(), authenticator = await enrollTotp(owner);
    advance(STEP * 2);
    const current = f.client(); await current.login(); await post(current, "two-factor/verify-totp", { code: authenticator.code() });
    const pending = f.client(); expect((await pending.login()).status).toBe(200);
    const before = await select(f, 'SELECT "password" FROM "authentication_ba_account"');
    faults.beforePasswordWrite = async () => { throw Error("fixture password rollback"); };
    if (operation === "recovery") await expect(f.runtime.recoverLocal({ principalId: f.owner.principalId, newPassword: NEW_PASSWORD, actor: "fixture" })).rejects.toBeInstanceOf(Error);
    else if (operation === "change") expect((await post(current, "change-password", { currentPassword: OWNER_PASSWORD, newPassword: NEW_PASSWORD })).status).toBeGreaterThanOrEqual(400);
    else {
      const raw = new Client(f.runtime);
      await raw.call("/request-password-reset", { body: { email: OWNER_EMAIL } });
      expect((await raw.call("/reset-password", { body: { token: f.evidence.resets[0]!.token, newPassword: NEW_PASSWORD } })).status).toBeGreaterThanOrEqual(400);
    }
    faults.beforePasswordWrite = undefined;
    expect(await select(f, 'SELECT "password" FROM "authentication_ba_account"')).toEqual(before);
    advance(STEP * 2);
    expect((await post(pending, "two-factor/verify-totp", { code: authenticator.code() })).status).toBe(200);
    await strength(pending, "password_totp");
  });
  it("preserves an independent pending passkey login and selected protection through password recovery", async () => {
    const f = await create(), client = await f.client().authenticated(), authenticator = await enrollPasskey(client);
    const response = authenticator.assert(await options(client, "authenticate"));
    const before = await select(f, "SELECT generation, policy_revision, passkey_selected FROM authentication_account_policies");
    await f.runtime.recoverLocal({ principalId: f.owner.principalId, newPassword: NEW_PASSWORD, actor: "fixture" });
    expect((await post(client, "passkey/verify-authentication", { response })).status).toBe(200);
    await strength(client, "passkey_uv");
    expect(await select(f, "SELECT generation, policy_revision, passkey_selected FROM authentication_account_policies")).toEqual(before);
    expect(await select(f, "SELECT credential_id FROM authentication_passkey_trust")).toHaveLength(1);
  });

  it("serializes recovery after a charged TOTP verification and revokes its completed session", async () => {
    const faults: ProofFaultInjection = {}, f = await create(faults), owner = await f.client().authenticated(), authenticator = await enrollTotp(owner);
    const client = f.client(); await client.login(); advance(STEP * 2);
    const entered = gate(), release = gate();
    faults.factorPause = async stage => { if (stage === "after-admission") { entered.open(); await release.opened; } };
    let verification: Promise<unknown> | undefined, recovery: Promise<unknown> | undefined;
    try {
      verification = post(client, "two-factor/verify-totp", { code: authenticator.code() }); await entered.opened;
      recovery = f.runtime.recoverLocal({ principalId: f.owner.principalId, newPassword: NEW_PASSWORD, actor: "fixture" });
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedProviders).toBe(1));
      release.open(); await verification; await recovery; faults.factorPause = undefined;
      expect(await select(f, 'SELECT "id" FROM "authentication_ba_session"')).toEqual([]);
      expect((await client.session()).body).toEqual({ authenticated: false });
    } finally { release.open(); await verification; await recovery; }
  });

});
