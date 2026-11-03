import { existsSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenAdminSocket, requestAdminSocket } from "@/server/admin-socket";
import { createControllerShutdown } from "@/server/bootstrap/controller-shutdown";
import { ControlService } from "@/server/control-service";
import { acquireControllerLock } from "@/server/controller-lock";
import type { DirectoryBrowser } from "@/server/directory-browser";
import { EventStream } from "@/server/events";
import { createControllerServer } from "@/server/http-server";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import { createMcpControllerServer } from "@/server/mcp-http-server";
import { ProcessManager } from "@/server/process-manager";
import { KnowledgeService } from "@/server/modules/knowledge";
import { createRemoteVerificationServer } from "@/server/transports/remote-verification-http";
import type { RemoteVerificationController } from "@/server/modules/remote-verification";
import type { ProofFaultInjection } from "../src/index";
import { readCommitted } from "./fixture";
import { cleanupStrictRoots, closeStrictProof, gate, pauseProvisioning, strictProof } from "./strict-fixture";

afterEach(cleanupStrictRoots);
async function listen(server: Server, path: string) {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { server.off("error", reject); resolve(); }); });
}
function post(path: string, token: string, body: unknown) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const call = httpRequest({ socketPath: path, path: "/api/knowledge", method: "POST", headers: { authorization: `Bearer ${token}`, host: "controller.test", "content-type": "application/json", connection: "close" } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    call.on("error", reject); call.end(JSON.stringify(body));
  });
}
async function fixture(options = {}) {
  const faults: ProofFaultInjection = {}, f = await strictProof(faults, options);
  const processes = new ProcessManager();
  const service = new ControlService(f.store, { list: async () => [] } as never, processes, undefined, undefined, undefined, undefined, undefined, undefined, undefined, new KnowledgeService(f.store, f.identity));
  const lockPath = join(f.root, "controller.lock"), controllerLock = acquireControllerLock(lockPath);
  let maintenance = false;
  const controller = createControllerServer({ service, identity: f.identity, admission: f.store.admission,
    maintenance: () => maintenance,
    directoryBrowser: {} as DirectoryBrowser, events: new EventStream(f.store.admission),
    mcpStatus: () => ({ phase: "disabled", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "bearer", activeSessions: 0 }),
    webRoot: f.root, host: "127.0.0.1", port: 0, accessToken: "fixture" });
  const mcp = createMcpControllerServer({ service, identity: f.identity, accessToken: "fixture", port: 0 });
  const remote = createRemoteVerificationServer({ controller: {} as RemoteVerificationController, identity: f.identity, admission: f.store.admission, allowLoopbackHttpFixture: true });
  const adminProject = await f.run(() => f.store.addProject({ name: "Admin audit", repositoryPath: f.root, port: 3902, executable: "", args: [], launchPreset: "none" }));
  const adminEffect = vi.fn(() => f.store.recordProjectEvent(adminProject.id, "fixture.admin-completion", "test", {}));
  const adminPath = join(f.root, "admin.sock");
  const admin = await listenAdminSocket(adminPath, () => {
    // Bootstrap checks maintenance before admitting an already parsed admin request.
    if (maintenance) throw new Error("Controller is in maintenance.");
    return f.store.admission.run(() => { adminEffect(); return { ok: true }; });
  });
  const httpPath = join(f.root, "http.sock");
  // Temporary Unix sockets exercise Node's real accepted-response drain. No TCP ports or service commands.
  await listen(controller.server, httpPath); await listen(mcp.server, join(f.root, "mcp.sock")); await listen(remote.server, join(f.root, "remote.sock"));
  const closers = [remote, mcp, controller, admin].map(owner => vi.spyOn(owner, "close"));
  const accessRemoved = vi.fn(), stopping = vi.fn(), schedules = { close: vi.fn() }, backups = { close: vi.fn(async () => undefined) };
  const shutdown = createControllerShutdown({
    service: { closeAdmission: () => { maintenance = true; service.closeAdmission(); }, shutdown: () => service.shutdown() },
    stopping, userSchedules: schedules, backups,
    remoteVerification: remote, mcp, controller, adminSocket: admin, removeServiceAccess: accessRemoved, controllerLock });
  return { ...f, faults, service, processes, controllerLock, lockPath, controller, mcp, remote, admin, closers, adminEffect, adminPath, httpPath,
    accessRemoved, stopping, schedules, backups, shutdown,
    cleanup: async () => { await Promise.allSettled([remote.close(), mcp.close(), controller.close(), admin.close()]); await service.shutdown(); controllerLock.release(); await closeStrictProof(f); } };
}

describe("owning CLI shutdown sequence with installed listeners", () => {
  it("closes installed listeners, refuses queued HTTP dispatch and drains the accepted admin write/response before releasing both locks", async () => {
    const f = await fixture();
    const project = await f.run(() => {
      const project = f.identity.createKnowledgeProject({ name: "CLI completion" }, f.ownerActor);
      f.identity.setKnowledgeGrant({ principalId: f.owner.principalId, projectId: project.id, permissions: ["knowledge:read", "knowledge:write"] }, f.ownerActor);
      return project;
    });
    const hold = pauseProvisioning(f, f.faults, "rollback");
    let closing: Promise<void> | undefined;
    try {
      await hold.paused;
      const http = post(f.httpPath, f.owner.token, { operation: "create_task", input: { projectId: project.id, title: "Accepted", description: "once", idempotencyKey: "cli-once" } });
      const admin = requestAdminSocket(f.adminPath, { command: "fixture" });
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBe(2));
      let settled = false; closing = f.shutdown().then(() => { settled = true; });
      await vi.waitFor(() => f.closers.forEach(close => expect(close).toHaveBeenCalledOnce()));
      expect([f.controller, f.mcp, f.remote, f.admin].map(owner => owner.server.listening)).toEqual([false, false, false, false]);
      await expect(post(f.httpPath, f.owner.token, {})).rejects.toThrow();
      await expect(f.service.reserve({ projectId: "unknown", worktreePath: f.root, owner: "local-user", kind: "human", reason: "new" })).rejects.toThrow("zamykany");
      expect(settled).toBe(false); expect(existsSync(f.lockPath)).toBe(true); expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
      hold.resume(); await hold.pending;
      // The socket was accepted, but HTTP application dispatch had not entered
      // before maintenance. Its response drains without a Knowledge mutation.
      expect(await http).toMatchObject({ status: 503, body: { code: "backup_busy" } }); expect(await admin).toEqual({ ok: true });
      await closing;
      expect(f.adminEffect).toHaveBeenCalledOnce();
      expect(readCommitted(f.path, db => (db.prepare("SELECT count(*) n FROM knowledge_tasks").get() as { n: number }).n)).toBe(0);
      expect(f.accessRemoved).toHaveBeenCalledOnce(); expect(f.schedules.close).toHaveBeenCalledOnce(); expect(f.backups.close).toHaveBeenCalledOnce();
      expect(existsSync(f.lockPath)).toBe(false); expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
    } finally { hold.resume(); await hold.pending; await closing; await f.cleanup(); }
  });

  it("retains the controller lock as well as the database owner when provider drain is unconfirmed", async () => {
    const f = await fixture({ borrowTimeoutMs: 100 });
    const close = f.store.closeAfterDrain.bind(f.store);
    vi.spyOn(f.store, "closeAfterDrain").mockImplementation(() => close(25));
    const hold = pauseProvisioning(f, f.faults, "rollback");
    try {
      await hold.paused; expect(await hold.pending).toBe("expired");
      await expect(f.shutdown()).rejects.toThrow("Controller shutdown did not complete cleanly");
      expect.soft(existsSync(`${f.path}.owner.lock`)).toBe(true);
      expect.soft(existsSync(f.lockPath)).toBe(true);
      expect(() => new SqliteStateStore(f.path)).toThrow();
      await expect(f.shutdown()).rejects.toThrow("Controller shutdown did not complete cleanly");
      expect(f.accessRemoved).not.toHaveBeenCalled();
    } finally { hold.resume(); await hold.pending; await f.store.authenticationProviderStorage().drain(2000); await f.cleanup(); }
  });

  it("retains ownership when an installed listener cannot confirm closure", async () => {
    const f = await fixture();
    f.closers[2].mockRejectedValueOnce(new Error("listener closure unconfirmed"));
    try {
      await expect(f.shutdown()).rejects.toThrow("Controller shutdown did not complete cleanly");
      expect.soft(f.controller.server.listening).toBe(true);
      expect.soft(existsSync(f.lockPath)).toBe(true);
      expect.soft(existsSync(`${f.path}.owner.lock`)).toBe(true);
      await expect(f.shutdown()).rejects.toThrow("Controller shutdown did not complete cleanly");
      expect(f.closers[2]).toHaveBeenCalledOnce();
      expect(f.accessRemoved).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it("retains both owners if managed process cleanup cannot be confirmed", async () => {
    const f = await fixture();
    vi.spyOn(f.processes, "stopAll").mockRejectedValueOnce(new Error("process cleanup unconfirmed"));
    try {
      await expect(f.shutdown()).rejects.toThrow("Controller shutdown did not complete cleanly");
      expect(existsSync(f.lockPath)).toBe(true);
      expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
      expect(() => new SqliteStateStore(f.path)).toThrow();
      expect(f.accessRemoved).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it("joins concurrent handoff shutdown to the actual response/provider drain instead of returning early", async () => {
    const f = await fixture(), hold = pauseProvisioning(f, f.faults, "rollback"), returned = gate();
    let first: Promise<void> | undefined;
    try {
      await hold.paused;
      first = f.shutdown(true);
      await expect(f.shutdown(false)).rejects.toThrow("shutdown mode cannot change");
      let handoffSettled = false;
      const second = f.shutdown(true).then(() => { handoffSettled = true; returned.open(); });
      await Promise.race([returned.opened, new Promise(resolve => setImmediate(resolve))]);
      expect.soft(handoffSettled).toBe(false);
      expect(existsSync(f.lockPath)).toBe(true); expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
      hold.resume(); await hold.pending; await first; await second;
      expect(existsSync(f.lockPath)).toBe(true); expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
    } finally { hold.resume(); await hold.pending; await first; await f.cleanup(); }
  });
});
