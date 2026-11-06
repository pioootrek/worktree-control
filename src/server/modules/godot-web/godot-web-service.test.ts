import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectLaunchCommandResolver, webWorktreeKey } from "@/server/launch-command";
import { nullLogWriter } from "@/server/log-writer";
import type { RuntimeStatusSummary } from "@/server/process-manager";
import { SqliteStateStore } from "@/server/sqlite-store";
import { TestJobManager } from "@/server/test-job-manager";
import type { RuntimeSnapshot, TestSourceObservation, Worktree } from "@/shared/contracts";
import { parseGodotWebConfig } from "@/shared/contracts/godot-web";
import { ProjectLifecycle } from "../lifecycle";
import { GODOT_WEB_ACTOR, GodotWebService } from "./godot-web-service";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

/** Fake exporter: waits, optionally fails, then writes a complete flat Web export. */
const EXPORTER = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const control = JSON.parse(readFileSync("control/control.json", "utf8"));
const runs = Number(readFileSync("control/runs", "utf8")) + 1;
writeFileSync("control/runs", String(runs));
await new Promise((resolve) => setTimeout(resolve, control.delayMs));
if (control.fail) { console.error("template missing"); process.exit(3); }
mkdirSync("out", { recursive: true });
writeFileSync("out/index.html", "<html><head></head><body>run " + runs + " " + readFileSync("src/main.gd", "utf8") + "</body></html>");
writeFileSync("out/index.wasm", "wasm");
writeFileSync("out/index.pck", "pck");
`;

function fixture(options: { delayMs?: number; queueLimit?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wtc-godot-web-service-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const worktreePath = join(root, "game");
  for (const directory of ["src", "control"]) mkdirSync(join(worktreePath, directory), { recursive: true });
  writeFileSync(join(worktreePath, "project.godot"), "config_version=5\n");
  writeFileSync(join(worktreePath, "export.mjs"), EXPORTER);
  writeFileSync(join(worktreePath, "src/main.gd"), "v1");
  writeFileSync(join(worktreePath, "control/runs"), "0");
  const control = (value: { delayMs?: number; fail?: boolean }) => writeFileSync(join(worktreePath, "control/control.json"), JSON.stringify({ delayMs: options.delayMs ?? 50, fail: false, ...value }));
  control({});
  const store = new SqliteStateStore(join(root, "state.sqlite3"));
  cleanup.push(() => store.close());
  const godotWeb = parseGodotWebConfig({
    exporter: { kind: "command", command: ["node", "export.mjs"], outputDirectory: "out" },
    watch: { paths: ["src"], debounceMs: 100 },
  });
  const project = store.addProject({ name: "Game", repositoryPath: worktreePath, port: 3901, launchPreset: "godot-web", godotWeb, executable: "node", args: [] });
  store.setTestQueueSettings({ limit: options.queueLimit ?? 1 });
  let runtime: RuntimeStatusSummary = { phase: "stopped", worktreePath: null, startedAt: null, failureCode: null, ownsProcess: false };
  const processes = {
    statusSummary: () => runtime,
    snapshot: () => ({ phase: runtime.phase, pid: null, worktreePath: runtime.worktreePath, startedAt: runtime.startedAt, error: null, failure: null, logs: [], resources: {} }) as unknown as RuntimeSnapshot,
  };
  const worktree: Worktree = { path: worktreePath, head: "abc", shortHead: "abc", branch: "main", detached: false, locked: false, prunable: false, dirty: true };
  const observation = (): TestSourceObservation => ({ observedAt: new Date().toISOString(), head: "abc", branch: "main", dirty: true, statusDigest: "same", statusEntries: 1, complete: true, errorCode: null });
  const git = { list: async () => [worktree], observe: async () => observation(), ignoredPaths: async () => [] };
  const jobs = new TestJobManager(store, nullLogWriter);
  cleanup.push(() => jobs.shutdown());
  const lifecycle = new ProjectLifecycle(store, processes);
  const holder: { service?: GodotWebService } = {};
  const commands = new ProjectLaunchCommandResolver({ executable: "node", args: ["server.js"], publicDirectory: (id) => holder.service!.publicDirectory(id) });
  const notify = vi.fn();
  const service = new GodotWebService({ storeRoot: join(root, "store"), store, git, processes, jobs, lifecycle, commands, logs: nullLogWriter, notify });
  holder.service = service;
  cleanup.push(() => service.close());
  const setRuntime = (phase: RuntimeStatusSummary["phase"]) => {
    runtime = { phase, worktreePath: phase === "stopped" ? null : worktreePath, startedAt: phase === "stopped" ? null : "2026-11-06T00:00:00.000Z", failureCode: null, ownsProcess: phase !== "stopped" };
    service.runtimeChanged(project.id);
  };
  const state = () => JSON.parse(readFileSync(join(root, "store", project.id, "public", "state.json"), "utf8"));
  const served = (generation: string) => readFileSync(join(root, "store", project.id, "public", "generations", generation, "index.html"), "utf8");
  const runs = () => store.listTestRuns(project.id).filter((run) => run.presetId === "godot:web-export");
  return { root, worktreePath, store, project, service, jobs, control, setRuntime, state, served, runs, notify };
}

describe("GodotWebService", () => {
  it("exports through the shared queue and publishes one complete generation bound to the worktree", async () => {
    const f = fixture();
    f.setRuntime("running");
    await vi.waitFor(() => expect(f.service.status(f.project.id)?.state).toBe("ready"), { timeout: 10_000 });
    const status = f.service.status(f.project.id)!;
    expect(status.current).toMatchObject({ files: 3, dirty: true, head: "abc" });
    expect(f.state()).toMatchObject({ generation: status.current!.id, worktreeKey: webWorktreeKey(f.worktreePath), build: "idle" });
    expect(f.served(status.current!.id)).toContain("run 1 v1");
    const [run] = f.runs();
    // Dirty dev worktrees are served, but the queue never certifies them as a clean pass.
    expect(run).toMatchObject({ actor: GODOT_WEB_ACTOR, adapter: "godot", environmentProfile: "tooling", phase: "failed", executable: "node", args: ["export.mjs"] });
    expect(run.source.processOutcome).toBe("passed");
    expect(run.logs.some((line) => line.startsWith("web_export.published generation="))).toBe(true);
    expect(JSON.stringify(f.state())).not.toContain(f.worktreePath);
  });

  it("reruns once with fresh sources when files change during an export, coalescing bursts", async () => {
    const f = fixture({ delayMs: 900 });
    f.setRuntime("running");
    await vi.waitFor(() => expect(f.runs()[0]?.phase).toBe("running"), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const value of ["v2", "v3", "v4"]) { writeFileSync(join(f.worktreePath, "src/main.gd"), value); await new Promise((resolve) => setTimeout(resolve, 30)); }
    await vi.waitFor(() => expect(f.service.status(f.project.id)?.state).toBe("ready"), { timeout: 15_000 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const runs = f.runs();
    expect(runs).toHaveLength(2);
    expect(runs.find((run) => run.logs.some((line) => line.includes("reason=source_changed_during_export")))).toBeTruthy();
    const status = f.service.status(f.project.id)!;
    expect(f.served(status.current!.id)).toContain("run 2 v4");
    expect(readdirSync(join(f.root, "store", f.project.id, "public", "generations"))).toHaveLength(1);
  });

  it("keeps the last good generation and reports a failure when an export fails", async () => {
    const f = fixture();
    f.setRuntime("running");
    await vi.waitFor(() => expect(f.service.status(f.project.id)?.state).toBe("ready"), { timeout: 10_000 });
    const good = f.service.status(f.project.id)!.current!.id;
    f.control({ fail: true });
    writeFileSync(join(f.worktreePath, "src/main.gd"), "broken");
    await vi.waitFor(() => expect(f.service.status(f.project.id)?.state).toBe("failed"), { timeout: 10_000 });
    const status = f.service.status(f.project.id)!;
    expect(status.lastFailure).toMatchObject({ code: "export_failed", message: "The export command exited with code 3." });
    expect(status.current?.id).toBe(good);
    expect(f.state()).toMatchObject({ generation: good, build: "failed", failureCode: "export_failed" });
    expect(f.served(good)).toContain("v1");
  });

  it("cancels the export and suppresses publication when the runtime stops mid-build", async () => {
    const f = fixture({ delayMs: 5_000 });
    f.setRuntime("running");
    await vi.waitFor(() => expect(f.runs()[0]?.phase).toBe("running"), { timeout: 10_000 });
    f.setRuntime("stopping");
    await f.service.drain(f.project.id);
    // Drain returns only after the queue persisted the terminal phase (removal relies on it).
    expect(f.runs()[0]?.phase).toBe("cancelled");
    expect(f.runs()[0].logs).toContain("web_export.publication=suppressed reason=session_ended");
    expect(f.state().generation).toBeNull();
    expect(f.service.status(f.project.id)).toMatchObject({ state: "stopped", watcher: "stopped", activeRunId: null });
    writeFileSync(join(f.worktreePath, "src/main.gd"), "after stop");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(f.runs()).toHaveLength(1);
  });

  it("waits in the finite queue behind other work instead of running in parallel", async () => {
    const f = fixture();
    const blocker = f.jobs.enqueue({
      projectId: f.project.id,
      worktree: { path: "/other", head: "x", shortHead: "x", branch: null, detached: true, locked: false, prunable: false, dirty: false },
      command: { preset: { id: "node:test", name: "test", adapter: "node", timeoutMs: 10_000 }, executable: process.execPath, args: ["-e", "setTimeout(() => {}, 600)"], cwd: f.root },
      environment: { environment: {}, mode: "clean", profile: "unit", inheritedServerProfile: null, variableNames: [] }, actor: "local-user",
    });
    f.setRuntime("running");
    await vi.waitFor(() => expect(f.service.status(f.project.id)?.state).toBe("queued"), { timeout: 10_000 });
    expect(f.store.getTestRun(blocker.id)?.phase).toBe("running");
    await vi.waitFor(() => expect(f.service.status(f.project.id)?.state).toBe("ready"), { timeout: 10_000 });
    expect(f.store.getTestRun(blocker.id)?.phase).toBe("passed");
  });

  it("rebuilds on request only while running and coalesces with the export in flight", async () => {
    const f = fixture({ delayMs: 400 });
    await expect(f.service.rebuild(f.project.id)).rejects.toThrow(/Start the Godot Web server/);
    f.setRuntime("running");
    await vi.waitFor(() => expect(f.runs()[0]?.phase).toBe("running"), { timeout: 10_000 });
    await f.service.rebuild(f.project.id);
    await f.service.rebuild(f.project.id);
    expect(f.service.status(f.project.id)?.pendingRebuild).toBe(true);
    await vi.waitFor(() => expect(f.runs().filter((run) => run.finishedAt)).toHaveLength(2), { timeout: 15_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(f.runs()).toHaveLength(2);
  });
});
