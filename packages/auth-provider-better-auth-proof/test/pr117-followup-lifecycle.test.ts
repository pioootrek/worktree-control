import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlService } from "@/server/control-service";
import { ProcessManager } from "@/server/process-manager";
import { AuthenticationService } from "@/server/modules/authentication";
import { createControllerServer } from "@/server/http-server";
import { EventStream } from "@/server/events";
import { nullLogWriter } from "@/server/log-writer";
import type { DirectoryBrowser } from "@/server/directory-browser";
import { request } from "./server-request";
import { cleanupStrictRoots, closeStrictProof, gate, strictProof } from "./strict-fixture";

afterEach(() => { vi.restoreAllMocks(); cleanupStrictRoots(); });

async function fixture() {
  const f = await strictProof();
  const authentication = await f.run(() => new AuthenticationService(f.store));
  const credential = await f.run(() => authentication.generateToken("fixture"));
  const project = await f.run(() => f.store.addProject({ name: "completed effects", repositoryPath: f.root, port: 3904, executable: "node", args: [], launchPreset: "node" }));
  const processes = new ProcessManager(), entered = gate(), resume = gate();
  const logs = { ...nullLogWriter, controller: vi.fn() };
  const worktree = { path: f.root, head: "a".repeat(40), shortHead: "aaaaaaa", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
  const service = new ControlService(f.store, { list: async () => [worktree] } as never, processes, logs,
    { resolve: () => ({ preset: "node", executable: "node", args: [], portMethod: "environment", tls: { mode: "off", keyPath: null, certPath: null, caPath: null } }) });
  const events = new EventStream(f.store.admission), publish = vi.spyOn(events, "publish").mockImplementation(() => undefined);
  let maintenance = false;
  const http = createControllerServer({ service, authentication, identity: f.identity, admission: f.store.admission,
    directoryBrowser: {} as DirectoryBrowser, events, maintenance: () => maintenance,
    mcpStatus: () => ({ phase: "disabled", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "bearer", activeSessions: 0 }),
    webRoot: f.root, host: "127.0.0.1", port: 0, accessToken: "fixture" });
  const invalidate = async (cause: string) => {
    if (cause === "rotation") await f.run(() => authentication.rotateToken("fixture"));
    else maintenance = true;
  };
  return { f, project, processes, service, logs, publish, entered, resume, invalidate,
    call: (route: string, body: unknown) => request(http.server, `/api/projects/${project.id}/${route}`, credential.token, JSON.stringify(body)),
    close: async () => { resume.open(); await http.close(); await service.shutdown(); await closeStrictProof(f); } };
}

describe("PR117 completed lifecycle effects", () => {
  for (const cause of ["rotation", "maintenance"] as const) {
    it.each(["start", "stop", "restart", "switch"] as const)(`retains completed %s evidence and notification after ${cause}, without a new unauthorized effect`, async operation => {
      const x = await fixture();
      let applied: "start" | "stop" | null = null;
      const apply = async (effect: "start" | "stop") => {
        applied = effect; x.entered.open();
        await x.f.store.admission.idle(() => x.resume.opened);
      };
      const start = vi.spyOn(x.processes, "start").mockImplementation(async (_project, _path, beforeSpawn) => { beforeSpawn?.(); await apply("start"); });
      const stop = vi.spyOn(x.processes, "stop").mockImplementation(async () => { await apply("stop"); });
      const pending = x.call("operation", { operation, worktreePath: x.f.root });
      try {
        await x.entered.opened; await x.invalidate(cause); x.resume.open();
        expect(await pending.completed).toMatchObject({ status: cause === "rotation" ? 401 : 503 });
        expect(applied).toBe(operation === "start" ? "start" : "stop");
        expect(start).toHaveBeenCalledTimes(operation === "start" ? 1 : 0);
        expect(stop).toHaveBeenCalledTimes(operation === "start" ? 0 : 1);
        if (operation === "start") {
          expect(await x.f.run(() => x.f.store.listWorktreeLaunches(x.project.id))).toHaveProperty(x.f.root);
          expect(x.logs.controller).toHaveBeenCalledWith("project.start", expect.objectContaining({ projectId: x.project.id }));
        } else {
          expect(x.logs.controller).toHaveBeenCalledWith("project.stopped", { projectId: x.project.id });
        }
        if (operation === "start" || operation === "stop") expect(x.logs.controller.mock.calls.some(([event]) => event === "project.operation_failed")).toBe(false);
        expect(x.publish).toHaveBeenCalledWith({ kinds: ["runtime", "reservation"], projectIds: [x.project.id] });
      } finally { x.resume.open(); await pending.completed; await x.close(); }
    });

    it.each(["acquire", "release", "force-release"] as const)(`notifies a completed reservation %s before denying the caller after ${cause}`, async action => {
      const x = await fixture();
      if (action !== "acquire") await x.f.run(() => x.f.store.acquireReservation({ projectId: x.project.id, worktreePath: x.f.root, kind: "human", owner: "local-user", reason: "fixture" }));
      const finish = async () => { x.entered.open(); await x.f.store.admission.idle(() => x.resume.opened); };
      if (action === "acquire") {
        const reserve = x.service.reserve.bind(x.service);
        vi.spyOn(x.service, "reserve").mockImplementation(async (...args) => { await reserve(...args); await finish(); });
      } else {
        const release = x.service.release.bind(x.service);
        vi.spyOn(x.service, "release").mockImplementation(async (...args) => { await release(...args); await finish(); });
      }
      const pending = x.call("reservation", { action, worktreePath: x.f.root, reason: "fixture" });
      try {
        await x.entered.opened;
        const reservation = await x.f.run(() => x.f.store.getActiveReservation(x.project.id));
        if (action === "acquire") expect(reservation?.owner).toBe("local-user"); else expect(reservation).toBeNull();
        await x.invalidate(cause); x.resume.open();
        expect(await pending.completed).toMatchObject({ status: cause === "rotation" ? 401 : 503 });
        expect(x.publish).toHaveBeenCalledWith({ kinds: ["reservation", "runtime"], projectIds: [x.project.id] });
      } finally { x.resume.open(); await pending.completed; await x.close(); }
    });
  }
});
