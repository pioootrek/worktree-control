import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlService } from "@/server/control-service";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import { nullLogWriter } from "@/server/log-writer";
import { ProcessManager } from "@/server/process-manager";
import { TestJobManager } from "@/server/test-job-manager";
import type { ProofFaultInjection } from "../src/index";
import { readCommitted } from "./fixture";
import { cleanupStrictRoots, closeStrictProof, pauseProvisioning, sleep, strictProof } from "./strict-fixture";

afterEach(cleanupStrictRoots);
describe("owning service shutdown with strict provider admission", () => {
  it("drains accepted process completion and a backup before releasing the sole owner", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults);
    const logs = { ...nullLogWriter, finishTest: vi.fn(async () => undefined) };
    const jobs = await f.run(() => new TestJobManager(f.store, logs));
    const service = new ControlService(f.store, { list: async () => [] } as never, new ProcessManager(), undefined, undefined, undefined, undefined, undefined, jobs);
    const project = await f.run(() => f.store.addProject({ name: "shutdown completion", repositoryPath: f.root, port: 3901, executable: "", args: [], launchPreset: "none" }));
    const release = join(f.root, "release-child"), started = join(f.root, "child-started");
    const input = { projectId: project.id, actor: "local-user",
      worktree: { path: f.root, head: "a".repeat(40), shortHead: "aaaaaaa", branch: "main", detached: false, locked: false, prunable: false, dirty: false },
      command: { preset: { id: "node:test", name: "test", adapter: "node" as const, timeoutMs: 5000 }, executable: process.execPath,
        args: ["-e", "const fs=require('node:fs');fs.writeFileSync(process.argv[2],'ready');const t=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(t);console.log('accepted-output')}},10)", release, started], cwd: f.root },
      environment: { environment: {}, mode: "clean" as const, profile: "unit", inheritedServerProfile: null, variableNames: [] } };
    const run = await f.run(() => jobs.enqueue(input));
    await vi.waitFor(() => expect(existsSync(started)).toBe(true));
    const saved: string[] = [], save = f.store.saveTestRun.bind(f.store);
    vi.spyOn(f.store, "saveTestRun").mockImplementation((value, key) => { if (value.telemetry?.finalizedAt) saved.push(value.phase); return save(value, key); });
    const hold = pauseProvisioning(f, faults, "rollback");
    let shutdown: Promise<void> | undefined, backup: Promise<void> | undefined;
    const destination = join(f.root, "accepted-backup.sqlite3");
    try {
      await hold.paused; writeFileSync(release, "finish");
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBeGreaterThan(0));
      // Completion has reached its durable write before shutdown lists unfinished jobs.
      await vi.waitFor(() => expect(logs.finishTest).toHaveBeenCalledOnce());
      backup = f.run(() => ({ pending: f.store.backup(destination) })).then(value => value.pending);
      let closed = false; shutdown = service.shutdown().then(() => { closed = true; });
      await expect(service.operate(project.id, "start", f.root)).rejects.toThrow("zamykany");
      expect(() => jobs.enqueue(input)).toThrow("zamknięta");
      await sleep(20); expect(closed).toBe(false);
      expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
      hold.resume(); await hold.pending; await backup; await shutdown;
      expect(saved).toEqual(["passed"]);
      const durable = readCommitted(f.path, db => db.prepare("SELECT phase, exit_code, logs_json, telemetry_json FROM test_runs WHERE id = ?").get(run.id)) as { phase: string; exit_code: number; logs_json: string; telemetry_json: string };
      expect(durable).toMatchObject({ phase: "passed", exit_code: 0 });
      expect(JSON.parse(durable.logs_json).filter((line: string) => line === "accepted-output")).toEqual(["accepted-output"]);
      expect(JSON.parse(durable.telemetry_json)).toMatchObject({ cleanup: "confirmed", finalizedAt: expect.any(String) });
      expect(readCommitted(destination, db => (db.prepare("SELECT count(*) n FROM projects").get() as { n: number }).n)).toBe(1);
      expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
    } finally { writeFileSync(release, "finish"); hold.resume(); await hold.pending; await backup; if (shutdown) await shutdown; else await service.shutdown(); await closeStrictProof(f); }
  });

  it("reports failed owning-service drain, retains the singleton lock, and closes on retry after late provider execution settles", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults, { borrowTimeoutMs: 100 });
    const service = new ControlService(f.store, { list: async () => [] } as never, new ProcessManager());
    // Exercise the real drain with a finite fixture deadline, without changing any host setting.
    const close = f.store.closeAfterDrain.bind(f.store);
    vi.spyOn(f.store, "closeAfterDrain").mockImplementation(() => close(25));
    const hold = pauseProvisioning(f, faults, "commit");
    try {
      await hold.paused;
      expect(await hold.pending).toBe("expired");
      await expect(f.runtime.dispose({ timeoutMs: 25 })).rejects.toMatchObject({ code: "disposal_unconfirmed" });
      await expect(service.shutdown()).rejects.toThrow("zasobów kontrolera");
      expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
      expect(() => new SqliteStateStore(f.path)).toThrow();
      await expect(f.runtime.resolve(new Headers())).rejects.toMatchObject({ code: "provider_disposed" });
      await expect(service.operate("new-project", "start", f.root)).rejects.toThrow("zamykany");
      // Internal core completion remains possible during drain; lifecycle admission is the firewall.
      expect(await f.store.admission.run(() => f.store.listProjects())).toEqual([]);
      hold.resume();
      expect(await f.store.authenticationProviderStorage().drain(2000)).toBe(true);
      await service.shutdown();
      expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
      const reopened = new SqliteStateStore(f.path);
      try { expect(reopened.schemaVersion()).toBe(44); } finally { reopened.close(); }
      // No late write/notification survived the forced rollback; dispose's failed result stays idempotent.
      expect(readCommitted(f.path, db => (db.prepare("SELECT count(*) n FROM authentication_ba_user").get() as { n: number }).n)).toBe(0);
      expect(f.evidence.events).toEqual([]);
      await expect(f.runtime.dispose()).rejects.toMatchObject({ code: "disposal_unconfirmed" });
    } finally { hold.resume(); await hold.pending; await f.store.authenticationProviderStorage().drain(2000); await service.shutdown(); }
  });
});
