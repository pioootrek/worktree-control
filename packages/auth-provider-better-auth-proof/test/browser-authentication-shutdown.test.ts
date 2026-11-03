import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireControllerLock } from "@/server/controller-lock";
import { createControllerShutdown } from "@/server/bootstrap/controller-shutdown";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import { browserFixture } from "./browser-authentication-fixture";
import { OWNER_PASSWORD } from "./fixture";
import { cleanupStrictRoots, gate } from "./strict-fixture";
import type { ProofFaultInjection } from "../src/index";

afterEach(cleanupStrictRoots);
describe("owning shutdown with the mounted optional browser provider", () => {
  it.each([false, true])("drains the real accepted HTTP response before provider disposal and retains owners on disposal failure=%s", async fail => {
    const faults: ProofFaultInjection = {}, f = await browserFixture(faults), client = await f.client().authenticated();
    const lockPath = join(f.root, "controller.lock"), lock = acquireControllerLock(lockPath);
    const entered = gate(), release = gate();
    faults.beforePasswordWrite = async () => { entered.open(); await release.opened; };
    const removed = vi.fn(), closeDatabase = vi.fn(async () => { await f.store.closeAfterDrain(); });
    if (fail) faults.afterDispose = async () => { throw new Error("sentinel-provider-dispose"); };
    const dispose = vi.spyOn(f.runtime, "dispose");
    const shutdown = createControllerShutdown({ service: { closeAdmission: f.setMaintenance, shutdown: closeDatabase },
      stopping: () => {}, userSchedules: undefined, backups: { close() {} }, remoteVerification: null, mcp: null,
      controller: f.http, adminSocket: { close() {} }, authenticationProvider: f.runtime, removeServiceAccess: removed, controllerLock: lock });
    let closing: Promise<void> | undefined;
    try {
      const response = client.call("/api/auth/change-password", { body: { currentPassword: OWNER_PASSWORD, newPassword: "fixture-new-password-2" } });
      await entered.opened;
      closing = shutdown(); const failed = closing.catch(error => error);
      expect(shutdown()).toBe(closing);
      await vi.waitFor(() => expect(f.http.server.listening).toBe(false));
      expect(dispose).not.toHaveBeenCalled(); expect(closeDatabase).not.toHaveBeenCalled();
      expect(existsSync(lockPath)).toBe(true); expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
      release.open();
      expect((await response).status).toBe(503);
      const outcome = await failed;
      expect(dispose).toHaveBeenCalledOnce(); expect(f.runtime.disposed).toBe(true);
      if (fail) {
        expect(outcome).toBeInstanceOf(AggregateError); expect(String(outcome)).not.toContain("sentinel-provider-dispose");
        expect(closeDatabase).not.toHaveBeenCalled(); expect(removed).not.toHaveBeenCalled();
        expect(existsSync(lockPath)).toBe(true); expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
        expect(() => new SqliteStateStore(f.path)).toThrow();
        await expect(shutdown()).rejects.toThrow("did not complete cleanly");
        await expect(f.runtime.dispose()).rejects.toMatchObject({ code: "disposal_unconfirmed" });
      } else {
        expect(outcome).toBeUndefined(); expect(closeDatabase).toHaveBeenCalledOnce(); expect(removed).toHaveBeenCalledOnce();
        expect(existsSync(lockPath)).toBe(false); expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
      }
    } finally {
      release.open(); await closing?.catch(() => {}); await f.http.close();
      // This fault is after actual Kysely destruction. Fixture cleanup owns its isolated files.
      await f.store.closeAfterDrain(); lock.release();
    }
  });
});
