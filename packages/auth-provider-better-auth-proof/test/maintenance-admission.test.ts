import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileLogWriter } from "@/server/log-writer";
import { ProcessManager } from "@/server/process-manager";
import { ProjectLifecycle } from "@/server/modules/lifecycle";
import { TestJobManager } from "@/server/test-job-manager";
import { WorktreeStorageManager } from "@/server/worktree-storage";
import type { ProofFaultInjection } from "../src/index";
import { cleanupStrictRoots, closeStrictProof, gate, pauseProvisioning, sleep, strictProof } from "./strict-fixture";

afterEach(cleanupStrictRoots);
describe("strict maintenance completion beside the provider", () => {
  it.each(["commit", "rollback"] as const)("retains one completed scan through provider %s and bounds duplicate pending work", async outcome => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults);
    const project = await f.run(() => f.store.addProject({ name: "scan", repositoryPath: f.root, port: 3890, executable: "node", args: [] }));
    const lifecycle = new ProjectLifecycle(f.store, new ProcessManager());
    const scanned = gate(), finishScan = gate();
    const scanner = { scan: vi.fn(async () => { scanned.open(); await finishScan.opened; return { worktreePath: f.root, totalBytes: 8192, nextBytes: 1024, nextCacheBytes: 512, nodeModulesBytes: 2048, topDirectories: [{ name: "src", bytes: 512 }] }; }) };
    const changes = vi.fn(), storage = new WorktreeStorageManager(f.store, lifecycle, scanner, changes);
    const save = vi.spyOn(f.store, "saveWorktreeStorage");
    expect(await f.run(() => storage.queue(project.id, f.root))).toBe(true);
    await scanned.opened;
    const hold = pauseProvisioning(f, faults, outcome);
    try {
      await hold.paused; finishScan.open();
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBe(1));
      for (let i = 0; i < 20; i++) expect(storage.queue(project.id, f.root, true)).toBe(false);
      expect(save).not.toHaveBeenCalled(); expect(storage.isBusy(project.id, f.root)).toBe(true);
      hold.resume(); await hold.pending;
      await vi.waitFor(() => expect(storage.isBusy(project.id, f.root)).toBe(false));
      expect(save).toHaveBeenCalledOnce(); expect(scanner.scan).toHaveBeenCalledOnce();
      expect((await f.run(() => storage.snapshots(project.id, [f.root])))[0]).toMatchObject({ status: "ready", totalBytes: 8192, nextBytes: 1024, error: null });
      await storage.close(); expect(storage.queue(project.id, f.root, true)).toBe(false);
      expect(lifecycle.acquireMaintenance(project.id, f.root)).not.toBeNull();
    } finally { finishScan.open(); hold.resume(); await hold.pending; await storage.close(); await closeStrictProof(f); }
  });

  it("closes a scan waiting to save without publishing a late result or retaining a permit", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults);
    const project = await f.run(() => f.store.addProject({ name: "close scan", repositoryPath: f.root, port: 3891, executable: "node", args: [] }));
    const lifecycle = new ProjectLifecycle(f.store, new ProcessManager()), scan = gate(), finish = gate();
    const storage = new WorktreeStorageManager(f.store, lifecycle, { scan: async () => { scan.open(); await finish.opened; return { worktreePath: f.root, totalBytes: 1, nextBytes: 0, nextCacheBytes: 0, nodeModulesBytes: 0, topDirectories: [] }; } });
    await f.run(() => storage.queue(project.id, f.root)); await scan.opened;
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused; finish.open();
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBe(1));
      let closed = false; const closing = storage.close().then(() => { closed = true; });
      await sleep(20); expect(closed).toBe(false);
      hold.resume(); await hold.pending; await closing;
      expect(await f.run(() => f.store.getWorktreeStorage(project.id, f.root))).toBeNull();
      expect(storage.isBusy(project.id, f.root)).toBe(false);
      expect(lifecycle.acquireMaintenance(project.id, f.root)).not.toBeNull();
    } finally { finish.open(); hold.resume(); await hold.pending; await storage.close(); await closeStrictProof(f); }
  });

  it("waits for retention lookup without deleting a log, and fails closed if admission closes", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults);
    const directory = join(f.root, "logs"); mkdirSync(join(directory, "tests"), { recursive: true });
    const logs = new FileLogWriter(directory), manager = await f.run(() => new TestJobManager(f.store, logs));
    const id = randomUUID(), path = join(directory, "tests", `${id}.log`); writeFileSync(path, "fixture log\n");
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused;
      const pruning = manager.pruneLogs();
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBeGreaterThan(0));
      expect(existsSync(path)).toBe(true);
      hold.resume(); await hold.pending; await pruning;
      expect(existsSync(path)).toBe(false); // A successful current lookup found no retained run.
      await manager.shutdown();
      await f.runtime.dispose(); await f.store.closeAfterDrain();
      writeFileSync(path, "must survive failed lookup\n");
      await logs.pruneTests(() => f.store.admission.detached(() => f.store.hasTestRun(id))).catch(() => undefined);
      expect(existsSync(path)).toBe(true);
    } finally { hold.resume(); await hold.pending; await manager.shutdown(); await logs.close(); await closeStrictProof(f); }
  });
});
