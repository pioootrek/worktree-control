import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControllerShutdown } from "@/server/bootstrap/controller-shutdown";
import { ControlService } from "@/server/control-service";
import { acquireControllerLock } from "@/server/controller-lock";
import type { DirectoryBrowser } from "@/server/directory-browser";
import { EventStream } from "@/server/events";
import { createControllerServer } from "@/server/http-server";
import { AuthenticationService } from "@/server/modules/authentication";
import { BackupOperations, backupPolicySchema, RestoreOperations } from "@/server/modules/backups";
import { ProcessManager } from "@/server/process-manager";
import { executeControllerRestoreRequest } from "@/server/restore-requests";
import type { ProofFaultInjection } from "../src/index";
import { request } from "./server-request";
import { cleanupStrictRoots, closeStrictProof, pauseProvisioning, strictProof } from "./strict-fixture";

// Keep the installed handler and owning RestoreOperations. Replace only physical
// database replacement/restart, after asserting the real owner has fully closed.
vi.mock("@/server/restore-requests", async importOriginal => ({
  ...await importOriginal<typeof import("@/server/restore-requests")>(), executeControllerRestoreRequest: vi.fn(),
}));
afterEach(() => { vi.mocked(executeControllerRestoreRequest).mockReset(); cleanupStrictRoots(); });

describe("installed restore HTTP completion to owning launch", () => {
  it.each(["finish-close", "close-finish", "already-disconnected", "revoked", "cleanup-unconfirmed"] as const)("hands off once with current authority after contention: %s", async mode => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults);
    const authentication = new AuthenticationService(f.store);
    const credential = await f.run(() => authentication.generateToken("fixture"));
    const actor = await f.run(() => authentication.authenticateInstallation(credential.token)!);
    const backups = new BackupOperations(backupPolicySchema.parse({ directory: join(f.root, "copies"), uiActions: ["create", "restore"] }), {
      source: f.store, databasePath: f.path, attachmentDirectory: join(f.root, "attachments"), applicationVersion: "test",
      estimateBytes: () => f.store.backupEstimateBytes(), authorize: current => authentication.isCurrentInstallationActor(current), maintenance: () => false, admission: f.store.admission,
    });
    const copy = await f.run(() => backups.create(actor, "http-copy")); await backups.drain();
    const service = new ControlService(f.store, { list: async () => [] } as never, new ProcessManager());
    const lockPath = join(f.root, "controller.lock"), controllerLock = acquireControllerLock(lockPath);
    const failed = vi.fn(), restarted = vi.fn();
    let maintenance = false;
    let shutdown!: ReturnType<typeof createControllerShutdown>;
    const restart = vi.fn(async (execute: () => void) => {
      await shutdown(true);
      execute();
      restarted(); // No second controller or service is actually launched.
    });
    const restores = new RestoreOperations(backups, f.path, join(f.root, "attachments"), {
      authentication: () => f.store.getAuthenticationPolicy(), enterMaintenance: () => { maintenance = true; service.closeAdmission(); }, restart, failure: failed,
    });
    const controller = createControllerServer({ service, identity: f.identity, authentication, admission: f.store.admission,
      directoryBrowser: {} as DirectoryBrowser, events: new EventStream(f.store.admission),
      mcpStatus: () => ({ phase: "disabled", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "bearer", activeSessions: 0 }),
      backups, restores, maintenance: () => maintenance, webRoot: f.root, host: "127.0.0.1", port: 0, accessToken: "fixture" });
    shutdown = createControllerShutdown({ service, stopping: () => undefined, userSchedules: undefined, backups,
      remoteVerification: null, mcp: null, controller, adminSocket: { close: async () => undefined }, removeServiceAccess: () => undefined, controllerLock });
    if (mode === "cleanup-unconfirmed") vi.spyOn(service, "shutdown").mockRejectedValueOnce(new Error("cleanup_unconfirmed"));
    vi.mocked(executeControllerRestoreRequest).mockImplementation(() => {
      expect(existsSync(lockPath)).toBe(true); expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
    });
    const launch = vi.spyOn(restores, "launch");
    const input = { action: "restore", backupId: copy.backupId, idempotencyKey: "http-restore", confirmation: "replace-entire-installation" };
    const call = request(controller.server, "/api/backups", credential.token, JSON.stringify(input), { autoFinish: false, destroyed: mode === "already-disconnected" });
    // For the disconnected branch, fence before async validation can install the callback.
    const hold = mode === "already-disconnected" ? pauseProvisioning(f, faults, "rollback") : null;
    let secondHold: ReturnType<typeof pauseProvisioning> | null = null;
    try {
      if (hold) { await hold.paused; hold.resume(); await hold.pending; }
      expect(await call.completed).toMatchObject({ status: 202, body: { state: "requested" } });
      if (mode !== "already-disconnected") expect(launch).not.toHaveBeenCalled();
      secondHold = pauseProvisioning(f, faults, "rollback"); await secondHold.paused;
      const revoke = mode === "revoked" ? f.run(() => authentication.rotateToken("fixture")) : Promise.resolve();
      if (mode === "close-finish") { call.disconnect(); call.finish(); }
      else { call.finish(); call.disconnect(); }
      await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
      expect(restart).not.toHaveBeenCalled(); expect(executeControllerRestoreRequest).not.toHaveBeenCalled();
      secondHold.resume(); await secondHold.pending; await revoke;
      const refused = mode === "revoked" || mode === "cleanup-unconfirmed";
      await vi.waitFor(() => expect(refused ? failed : restarted).toHaveBeenCalledOnce());
      expect(restart).toHaveBeenCalledTimes(mode === "revoked" ? 0 : 1);
      expect(executeControllerRestoreRequest).toHaveBeenCalledTimes(refused ? 0 : 1);
      expect(restarted).toHaveBeenCalledTimes(refused ? 0 : 1);
      expect(existsSync(lockPath)).toBe(true);
      expect(existsSync(`${f.path}.owner.lock`)).toBe(refused);
      const handoff = JSON.parse(readFileSync(join(backups.recordDirectory, "handoff.json"), "utf8")).payload;
      expect(handoff.state).toBe(refused ? "failed" : "executing");
      // 202 reports durable admission; it does not claim that restore/restart succeeded.
    } finally {
      hold?.resume(); await hold?.pending; secondHold?.resume(); await secondHold?.pending;
      await controller.close(); await backups.close(); await service.shutdown(); controllerLock.release(); await closeStrictProof(f);
    }
  });
});
