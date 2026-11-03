import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlService } from "@/server/control-service";
import { ProcessManager } from "@/server/process-manager";
import { OwnedProcessGroup } from "@/server/owned-process-group";
import { nullLogWriter } from "@/server/log-writer";
import { cleanupStrictRoots, closeStrictProof, gate, sleep, strictProof } from "./strict-fixture";

// Keep the real manager, lifecycle and gate; replace only OS process/network effects.
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: vi.fn(() => Object.assign(new EventEmitter(), { stdout: null, stderr: null, pid: undefined })) }));
vi.mock("node:net", async original => ({ ...await original<typeof import("node:net")>(), createConnection: () => {
  const socket = Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {} });
  queueMicrotask(() => socket.emit("error", new Error("fixture port is closed"))); return socket;
} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); cleanupStrictRoots(); });

describe("PR117 real process completion under admission contention", () => {
  for (const contention of ["ordinary-full", "reserve-full", "timeout"] as const) {
    it.each(["start", "stop", "restart", "switch"] as const)(`completes %s once after ${contention}`, async operation => {
      const f = await strictProof({}, { maxQueued: 32, reservedQueued: 2, admissionTimeoutMs: 1_000 });
      const entered = gate(), finishEffect = gate(), borrowed = gate(), releaseBorrow = gate();
      let armed = false;
      const waitEffect = async () => { if (armed) { armed = false; entered.open(); await finishEffect.opened; } };
      const fetchMock = vi.fn(async () => { if (operation === "start") await waitEffect(); return new Response("ok"); });
      vi.stubGlobal("fetch", fetchMock);
      const stopGroup = vi.spyOn(OwnedProcessGroup.prototype, "stop").mockImplementation(async () => { if (operation !== "start") await waitEffect(); });
      const logs = { ...nullLogWriter, controller: vi.fn() };
      const admission = f.store.admission;
      const processes = new ProcessManager(undefined, logs, { admission });
      const project = await f.run(() => f.store.addProject({ name: "completion", repositoryPath: f.root, port: 3999, executable: "node", args: [], launchPreset: "node" }));
      const worktree = { path: f.root, head: "a".repeat(40), shortHead: "aaaaaaa", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
      const service = new ControlService(f.store, { list: async () => [worktree] } as never, processes, logs,
        { resolve: () => ({ preset: "node", executable: "node", args: [], portMethod: "environment", tls: { mode: "off", keyPath: null, certPath: null, caPath: null } }) });
      if (operation !== "start") await service.operate(project.id, "start", f.root);
      vi.mocked(spawn).mockClear(); fetchMock.mockClear(); stopGroup.mockClear(); logs.controller.mockClear();
      const errors: string[] = [], idle = admission.idle.bind(admission);
      vi.spyOn(admission, "idle").mockImplementation(async (callback, options) => {
        try { return await idle(callback, options); }
        catch (error) { errors.push((error as { code: string }).code); throw error; }
      });
      armed = true;
      let settled = false;
      const pending = service.operate(project.id, operation, f.root).then(() => ({ ok: true }), error => ({ error })).finally(() => { settled = true; });
      await entered.opened;
      const storage = f.store.authenticationProviderStorage();
      const hold = storage.borrow(async () => { borrowed.open(); await releaseBorrow.opened; });
      await borrowed.opened;
      const queue = contention === "timeout" ? [] : Array.from({ length: contention === "reserve-full" ? 34 : 32 }, (_, i) =>
        f.store.admission.detached(() => undefined, { reserved: i >= 32 }));
      try {
        expect(f.store.admissionSnapshot().queuedCore).toBe(queue.length);
        finishEffect.open();
        await sleep(contention === "timeout" ? 1_150 : 120);
        expect(processes.snapshot(project.id).phase).toBe(operation === "start" ? "running" : "stopped");
        expect(settled).toBe(false);
        if (contention === "reserve-full") expect(errors).toContain("queue_full");
        if (contention === "timeout") expect(errors).toContain("admission_timeout");
        releaseBorrow.open(); await hold; await Promise.all(queue);
        expect(await pending).toEqual({ ok: true });
        expect(spawn).toHaveBeenCalledTimes(operation === "stop" ? 0 : 1);
        expect(stopGroup).toHaveBeenCalledTimes(operation === "start" ? 0 : 1);
        expect(fetchMock).toHaveBeenCalledTimes(operation === "stop" ? 0 : 1);
        expect(processes.snapshot(project.id).phase).toBe(operation === "stop" ? "stopped" : "running");
        expect(logs.controller).toHaveBeenCalledWith(`project.${operation === "stop" ? "stopped" : operation}`, expect.objectContaining({ projectId: project.id }));
        expect(logs.controller.mock.calls.some(([event]) => event === "project.operation_failed")).toBe(false);
        if (operation !== "stop") expect(await f.run(() => f.store.listWorktreeLaunches(project.id))).toHaveProperty(f.root);
      } finally {
        finishEffect.open(); releaseBorrow.open(); await hold; await Promise.allSettled(queue); await pending;
        await service.shutdown(); await closeStrictProof(f);
      }
    });
  }
});
