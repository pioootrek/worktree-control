import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserOperation } from "@/server/modules/authentication";
import type { ProofFaultInjection } from "../src/index";
import { browserFixture, type BrowserFixture } from "./browser-authentication-fixture";
import { betweenResultAndRelease, enrollPasskey, enrollTotp, live, options, post, strength } from "./browser-factor-helpers";
import { Client, cleanupRoots, OWNER_EMAIL, OWNER_PASSWORD } from "./fixture";
import { advance, factorOptions, select, STEP } from "./integrated-fixture";
import { cleanupStrictRoots, gate, sleep } from "./strict-fixture";

const NEW_PASSWORD = "fixture-pr117-replacement-password";
const opened: BrowserFixture[] = [];
async function create(faults: ProofFaultInjection = {}) {
  const f = await browserFixture(faults, { maxQueued: 1, reservedQueued: 16 }, 8, factorOptions());
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
    queued = f.store.admission.detached(() => undefined);
    await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBe(1));
    ready.open();
  });
  return { ready: ready.opened, release: async () => { release.open(); await held; await queued; } };
}

describe("PR117 accepted browser completion", () => {
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
});
