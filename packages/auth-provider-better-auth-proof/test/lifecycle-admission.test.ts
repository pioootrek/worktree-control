import { existsSync } from "node:fs";
import { ControlService } from "@/server/control-service";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectLifecycle } from "@/server/modules/lifecycle";
import { ProcessManager } from "@/server/process-manager";
import type { ProofFaultInjection } from "../src/index";
import { cleanupStrictRoots, closeStrictProof, gate, pauseProvisioning, sleep, strictProof } from "./strict-fixture";

afterEach(cleanupStrictRoots);
describe("project lock and strict database admission ordering", () => {
  it("serializes two operations without retaining admission in a project-lock wait, lets the provider run during readiness, and drains accepted work", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults);
    const project = await f.run(() => f.store.addProject({ name: "lifecycle", repositoryPath: f.root, port: 3895, executable: "node", args: [] }));
    const lifecycle = new ProjectLifecycle(f.store, new ProcessManager()), ready = gate(), reached = gate();
    const effects: string[] = [];
    const first = lifecycle.serialized(project.id, async () => {
      expect(f.store.getProject(project.id)?.name).toBe("lifecycle"); effects.push("first-start"); reached.open();
      await f.store.admission.idle(() => ready.opened);
      effects.push("first-finish"); f.store.recordProjectEvent(project.id, "fixture.first", "test", {});
    });
    await reached.opened;
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused;
      const second = lifecycle.serialized(project.id, async () => {
        expect(f.store.getProject(project.id)?.name).toBe("lifecycle"); effects.push("second"); f.store.recordProjectEvent(project.id, "fixture.second", "test", {});
      });
      await sleep(20); expect(effects).toEqual(["first-start"]);
      // Second is waiting on the project, not holding a database participant.
      expect(f.store.admissionSnapshot()).toMatchObject({ providerActive: true, coreActive: 0, queuedCore: 0 });
      lifecycle.closeAdmission();
      await expect(lifecycle.serialized(project.id, async () => { effects.push("forbidden"); })).rejects.toThrow("zamykany");
      let drained = false; const draining = lifecycle.closeAndDrain().then(() => { drained = true; });
      ready.open(); await sleep(20); expect(drained).toBe(false);
      hold.resume(); await hold.pending; await Promise.all([first, second, draining]);
      expect(effects).toEqual(["first-start", "first-finish", "second"]); expect(drained).toBe(true);
      expect(f.store.admissionSnapshot()).toMatchObject({ coreActive: 0, queuedCore: 0 });
    } finally { ready.open(); hold.resume(); await hold.pending; await first; await lifecycle.closeAndDrain(); await closeStrictProof(f); }
  });

  it("rejects SQL in a concurrent joined branch while its sibling idles; detached branches remain independently admitted", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults), idle = gate(), resume = gate();
    let waiting!: Promise<unknown>;
    const root = f.run(async () => {
      waiting = f.store.admission.run(async () => { await f.store.admission.idle(async () => { idle.open(); await resume.opened; }); });
      await idle.opened;
      // Intentional contract probe: a shared participant is sequential across idle.
      expect(() => f.store.listProjects()).toThrow(expect.objectContaining({ code: "unadmitted" }));
      await waiting;
    });
    await idle.opened;
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused;
      let executions = 0;
      const independent = f.store.admission.detached(() => { executions++; return f.store.listProjects(); });
      resume.open(); await sleep(20); expect(executions).toBe(0);
      hold.resume(); await hold.pending; expect(await independent).toEqual([]); await root;
      expect(executions).toBe(1);
    } finally { resume.open(); hold.resume(); await hold.pending; await root; await closeStrictProof(f); }
  });

  it("the owning service rejects new lifecycle work during shutdown while accepted operations and the provider settle", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults);
    const project = await f.run(() => f.store.addProject({ name: "shutdown", repositoryPath: f.root, port: 3896, executable: "node", args: [], launchPreset: "node" }));
    const processes = new ProcessManager(), ready = gate(), entered = gate();
    const start = vi.spyOn(processes, "start").mockImplementation(async () => { entered.open(); await f.store.admission.idle(() => ready.opened); });
    const stopped = vi.spyOn(processes, "stop").mockResolvedValue(undefined);
    const worktree = { path: f.root, head: "a".repeat(40), shortHead: "aaaaaaa", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
    const service = new ControlService(f.store, { list: async () => [worktree] } as never, processes, undefined,
      { resolve: () => ({ preset: "node", executable: "node", args: [], portMethod: "environment", tls: { mode: "off", keyPath: null, certPath: null, caPath: null } }) });
    const first = service.operate(project.id, "start", f.root); await entered.opened;
    const second = service.operate(project.id, "stop");
    const hold = pauseProvisioning(f, faults, "rollback");
    let shutdown: Promise<void> | undefined;
    try {
      await hold.paused;
      let closed = false; shutdown = service.shutdown().then(() => { closed = true; });
      await expect(service.operate(project.id, "start", f.root)).rejects.toThrow("zamykany");
      expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
      ready.open(); await sleep(20); expect(closed).toBe(false);
      hold.resume(); await hold.pending; await first; await second; await shutdown;
      expect(start).toHaveBeenCalledOnce(); expect(stopped).toHaveBeenCalledOnce();
      expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
    } finally { ready.open(); hold.resume(); await hold.pending; await Promise.allSettled([first, second]); await shutdown; await closeStrictProof(f); }
  });

  it("characterizes the separate local readiness gap: a new foreign reservation does not change the completed local result", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults);
    const project = await f.run(() => f.store.addProject({ name: "local readiness", repositoryPath: f.root, port: 3899, executable: "node", args: [], launchPreset: "node" }));
    const processes = new ProcessManager(), ready = gate(), entered = gate();
    const start = vi.spyOn(processes, "start").mockImplementation(async () => { entered.open(); await f.store.admission.idle(() => ready.opened); });
    const worktree = { path: f.root, head: "a".repeat(40), shortHead: "aaaaaaa", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
    const service = new ControlService(f.store, { list: async () => [worktree] } as never, processes, undefined,
      { resolve: () => ({ preset: "node", executable: "node", args: [], portMethod: "environment", tls: { mode: "off", keyPath: null, certPath: null, caPath: null } }) });
    const operation = service.operate(project.id, "start", f.root); await entered.opened;
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused;
      // Model a competing administrative state change independently of this project's lock.
      const changed = f.run(() => f.store.acquireReservation({ projectId: project.id, worktreePath: f.root, owner: "other-owner", kind: "human", reason: "fixture takeover" }));
      ready.open(); hold.resume(); await hold.pending; await changed;
      await expect(operation).resolves.toBeUndefined();
      expect(await f.run(() => f.store.getActiveReservation(project.id)?.owner)).toBe("other-owner");
      expect(start).toHaveBeenCalledOnce();
      // Characterization only. Local operateLocked has no post-readiness lease/authority port;
      // the scoped policy is tested separately and must not inherit this assumption.
    } finally { ready.open(); hold.resume(); await hold.pending; await operation; await service.shutdown(); await closeStrictProof(f); }
  });

});
