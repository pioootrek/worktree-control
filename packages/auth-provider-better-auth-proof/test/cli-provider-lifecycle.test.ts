import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControllerShutdown } from "@/server/bootstrap/controller-shutdown";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import { Client, OWNER_EMAIL, OWNER_PASSWORD, count } from "./fixture";
import { onlineCliFixture } from "./cli-provider-fixture";
import { gate } from "./strict-fixture";
import type { ProofFaultInjection } from "../src/index";
import type { OwnedSqliteDatabase } from "@/server/infrastructure/sqlite";

afterEach(() => vi.restoreAllMocks());
const enrollment = { email: OWNER_EMAIL, name: "Owner", password: OWNER_PASSWORD };
function shutdownFor(f: Awaited<ReturnType<typeof onlineCliFixture>>, closeDatabase = () => f.store.closeAfterDrain()) {
  return createControllerShutdown({ service: { closeAdmission: f.maintenance, shutdown: closeDatabase }, stopping() {},
    userSchedules: undefined, backups: { close() {} }, remoteVerification: null, mcp: null,
    controller: { close() {} }, adminSocket: f.admin, authenticationProvider: f.administration,
    removeServiceAccess() {}, controllerLock: f.lock });
}
function assertOwned(f: Awaited<ReturnType<typeof onlineCliFixture>>) {
  expect(existsSync(f.paths.controllerLockPath)).toBe(true); expect(existsSync(`${f.paths.databasePath}.owner.lock`)).toBe(true);
  expect(() => new SqliteStateStore(f.paths.databasePath)).toThrow();
}

describe("actual CLI/admin lifetime and ownership", () => {
  it.each([false, true])("joins accepted real recovery before shutdown and retains owners when disposal fails=%s", async fail => {
    const faults: ProofFaultInjection = {}, f = await onlineCliFixture({ faults });
    const entered = gate(), resume = gate();
    let closing: Promise<void> | undefined;
    try {
      await f.run(["enroll", "--principal-id", f.principalId, ...f.input(enrollment)]);
      const c = new Client(f.runtime(), "198.19.2.1"); await c.signIn();
      faults.beforeRecoveryCommit = async () => { entered.open(); await resume.opened; };
      if (fail) faults.afterDispose = async () => { throw new Error("sentinel-disposal"); };
      const closeDatabase = vi.fn(() => f.store.closeAfterDrain()), dispose = vi.spyOn(f.administration, "dispose");
      const shutdown = shutdownFor(f, closeDatabase);
      const effect = f.run(["recover", "--principal-id", f.principalId, ...f.input({ newPassword: "fixture-shutdown-new-password" })]);
      await entered.opened; closing = shutdown(); const outcome = closing.catch(error => error);
      expect(shutdown()).toBe(closing);
      await vi.waitFor(() => expect(f.admin.server.listening).toBe(false));
      expect(dispose).not.toHaveBeenCalled(); expect(closeDatabase).not.toHaveBeenCalled(); assertOwned(f);
      resume.open(); expect(await effect).toMatchObject({ recovered: true });
      expect(count(f.paths.databasePath, "authentication_ba_session")).toBe(0);
      if (fail) {
        expect(await outcome).toBeInstanceOf(AggregateError); expect(closeDatabase).not.toHaveBeenCalled(); assertOwned(f);
        await expect(shutdown()).rejects.toThrow("did not complete cleanly");
        await expect(f.administration.execute({ command: "auth-provider", action: "status" })).rejects.toMatchObject({ code: "maintenance" });
      } else {
        expect(await outcome).toBeUndefined(); expect(closeDatabase).toHaveBeenCalledOnce();
        expect(existsSync(f.paths.controllerLockPath)).toBe(false); expect(existsSync(`${f.paths.databasePath}.owner.lock`)).toBe(false);
      }
    } finally {
      resume.open(); await closing?.catch(() => {}); await f.admin.close();
      // Injected dispose fault happens AFTER actual Kysely destroy; finite fixture owns cleanup.
      await f.store.closeAfterDrain(); f.lock.release(); f.remove();
    }
  });

  it("drains accepted initialization after the real client disconnects, then refuses its queued effect in maintenance", async () => {
    const entered = gate(), resume = gate(), f = await onlineCliFixture({ beforeLoad: async () => { entered.open(); await resume.opened; } });
    let closing: Promise<void> | undefined;
    try {
      const req = httpRequest({ socketPath: f.paths.adminSocketPath, path: "/auth", method: "POST", headers: { "content-type": "application/json" } });
      req.on("error", () => {});
      req.end(JSON.stringify({ command: "auth-provider", action: "enroll", principalId: f.principalId, input: enrollment }));
      await entered.opened; req.destroy();
      const closeDatabase = vi.fn(() => f.store.closeAfterDrain());
      closing = shutdownFor(f, closeDatabase)();
      await vi.waitFor(() => expect(f.admin.server.listening).toBe(false));
      expect(closeDatabase).not.toHaveBeenCalled(); assertOwned(f);
      resume.open(); await closing;
      expect(f.loads()).toBe(1); expect(count(f.paths.databasePath, "authentication_ba_user")).toBe(0);
      expect(existsSync(f.paths.controllerLockPath)).toBe(false); expect(existsSync(`${f.paths.databasePath}.owner.lock`)).toBe(false);
    } finally { resume.open(); await closing?.catch(() => {}); await f.admin.close(); await f.store.closeAfterDrain(); f.lock.release(); f.remove(); }
  });

  it("rechecks maintenance inside the actual queued recovery borrow", async () => {
    const faults: ProofFaultInjection = {}, f = await onlineCliFixture({ faults });
    const called = gate(), startBorrow = gate(), holding = gate(), releaseBorrow = gate();
    try {
      await f.run(["enroll", "--principal-id", f.principalId, ...f.input(enrollment)]);
      const original = f.runtime().recoverLocal.bind(f.runtime());
      vi.spyOn(f.runtime(), "recoverLocal").mockImplementation(async input => { called.open(); await startBorrow.opened; return original(input); });
      const write = vi.fn(); faults.beforeRecoveryCommit = async () => { write(); };
      const recovery = f.run(["recover", "--principal-id", f.principalId, ...f.input({ newPassword: "fixture-queued-new-password" })]).catch(error => error);
      await called.opened;
      const blocker = f.store.authenticationProviderStorage().borrow(async () => { holding.open(); await releaseBorrow.opened; });
      await holding.opened; startBorrow.open();
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedProviders).toBe(1));
      f.maintenance(); releaseBorrow.open(); await blocker;
      expect(await recovery).toMatchObject({ code: "maintenance" }); expect(write).not.toHaveBeenCalled();
      expect(count(f.paths.databasePath, "authentication_ba_account")).toBe(1);
    } finally { startBorrow.open(); releaseBorrow.open(); await f.close(); }
  });

  it("caches a failed partial load, never resets it on configure, and retains both owners on cleanup uncertainty", async () => {
    const f = await onlineCliFixture();
    try {
      const entry = fileURLToPath(new URL("./loader-fixtures/partial-dispose-throws.mjs", import.meta.url));
      await f.configure("https://controller.test", "preserve", entry);
      await expect(f.run(["enroll", "--principal-id", f.principalId, ...f.input(enrollment)])).rejects.toMatchObject({ code: "disposal_unconfirmed", cleanupConfirmed: false });
      expect((await f.run(["status"])).maintenance).toBe("disposal_unconfirmed");
      const current = JSON.parse(readFileSync(join(f.paths.dataDirectory, "authentication-provider.json"), "utf8"));
      await f.run(["configure", ...f.input({ module: current.entry, origin: "https://controller.test", signingSecret: { kind: "preserve" } })]);
      await expect(f.run(["enroll", "--principal-id", f.principalId, ...f.input(enrollment)])).rejects.toMatchObject({ code: "disposal_unconfirmed" });
      expect(f.loads()).toBe(1);
      await expect(shutdownFor(f)()).rejects.toThrow("did not complete cleanly"); assertOwned(f);
      await expect(f.administration.dispose()).rejects.toMatchObject({ cleanupConfirmed: false });
    } finally { await f.admin.close(); await f.store.closeAfterDrain(); f.lock.release(); f.remove(); }
  });

  it("retains owners after actual execution expiry/drain failure and never reloads the terminal provider", async () => {
    const entered = gate(), resume = gate(), faults: ProofFaultInjection = {};
    const f = await onlineCliFixture({ faults, storeOptions: { borrowTimeoutMs: 1000 }, drainTimeoutMs: 10 });
    try {
      await f.run(["enroll", "--principal-id", f.principalId, ...f.input(enrollment)]);
      faults.beforeRecoveryCommit = async () => { entered.open(); await resume.opened; };
      const recovery = f.run(["recover", "--principal-id", f.principalId, ...f.input({ newPassword: "fixture-expiring-new-password" })]).catch(error => error);
      await entered.opened;
      expect(await recovery).toMatchObject({ code: "database_admission_error" });
      expect((await f.run(["status"])).maintenance).toBe("failed");
      await expect(f.run(["recover", "--principal-id", f.principalId, ...f.input({ newPassword: "fixture-expiring-new-password" })])).rejects.toMatchObject({ code: "database_unavailable" });
      await expect(shutdownFor(f)()).rejects.toThrow("did not complete cleanly"); assertOwned(f); expect(f.loads()).toBe(1);
    } finally {
      resume.open(); await f.admin.close(); await f.store.closeAfterDrain(); f.lock.release(); f.remove();
    }
  });

  it.each(["listener", "driver-close"] as const)("retains both owners on %s failure after actual provider administration", async stage => {
    const f = await onlineCliFixture();
    try {
      await f.run(["enroll", "--principal-id", f.principalId, ...f.input(enrollment)]);
      if (stage === "listener") vi.spyOn(f.admin, "close").mockRejectedValueOnce(new Error("sentinel-listener-close"));
      else {
        // Fault at the actual owned driver's close, after the provider has disposed.
        const owned = (f.store as unknown as { ownedDatabase: OwnedSqliteDatabase }).ownedDatabase;
        vi.spyOn(owned.database, "close").mockImplementationOnce(() => { throw new Error("sentinel-driver-close"); });
      }
      const shutdown = shutdownFor(f);
      await expect(shutdown()).rejects.toThrow("did not complete cleanly"); assertOwned(f);
      await expect(shutdown()).rejects.toThrow("did not complete cleanly");
      await expect(f.administration.execute({ command: "auth-provider", action: "recover", principalId: f.principalId,
        input: { newPassword: "fixture-refused-after-shutdown" } })).rejects.toMatchObject({ code: "maintenance" });
    } finally {
      vi.restoreAllMocks(); await f.admin.close(); await f.administration.dispose(); await f.store.closeAfterDrain(); f.lock.release(); f.remove();
    }
  });
});
