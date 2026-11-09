import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  const worktrees = [worktree];
  const git = { list: async () => worktrees, observe: async () => observation() };
  const logs = { ...nullLogWriter };
  const jobs = new TestJobManager(store, logs);
  cleanup.push(() => jobs.shutdown());
  const lifecycle = new ProjectLifecycle(store, processes);
  const holder: { service?: GodotWebService } = {};
  const commands = new ProjectLaunchCommandResolver({ executable: "node", args: ["server.js"], publicDirectory: (id) => holder.service!.publicDirectory(id) });
  const notify = vi.fn();
  const service = new GodotWebService({ storeRoot: join(root, "store"), store, git, processes, jobs, lifecycle, commands, logs: nullLogWriter, notify });
  holder.service = service;
  cleanup.push(() => service.close());
  const setRuntime = (phase: RuntimeStatusSummary["phase"], path = worktreePath) => {
    runtime = { phase, worktreePath: phase === "stopped" ? null : path, startedAt: phase === "stopped" ? null : "2026-11-06T00:00:00.000Z", failureCode: null, ownsProcess: phase !== "stopped" };
    service.runtimeChanged(project.id);
  };
  const state = () => JSON.parse(readFileSync(join(root, "store", project.id, "public", "state.json"), "utf8"));
  const served = (generation: string) => readFileSync(join(root, "store", project.id, "public", "generations", generation, "index.html"), "utf8");
  const runs = () => store.listTestRuns(project.id).filter((run) => run.presetId === "godot:web-export");
  return { root, worktreePath, store, project, service, jobs, control, setRuntime, state, served, runs, notify, worktrees, git, logs };
}

describe("GodotWebService", () => {
  it("keeps drain pending until a cancelled preflight's log and final receipt are durable", async () => {
    const f = fixture();
    let enteredPreflight!: () => void, releasePreflight!: () => void;
    let enteredLogClose!: () => void, releaseLogClose!: () => void;
    const preflight = new Promise<void>((resolve) => { enteredPreflight = resolve; });
    const preflightRelease = new Promise<void>((resolve) => { releasePreflight = resolve; });
    const logClose = new Promise<void>((resolve) => { enteredLogClose = resolve; });
    const logCloseRelease = new Promise<void>((resolve) => { releaseLogClose = resolve; });
    const observe = f.git.observe;
    let observations = 0;
    vi.spyOn(f.git, "observe").mockImplementation(async () => {
      if (++observations === 2) { enteredPreflight(); await preflightRelease; }
      return observe();
    });
    vi.spyOn(f.logs, "finishTest").mockImplementation(async () => { enteredLogClose(); await logCloseRelease; });
    let draining: Promise<void> | undefined;
    let drained = false;
    try {
      f.setRuntime("running");
      await preflight;
      f.setRuntime("stopping");
      await vi.waitFor(() => expect(f.runs()[0]).toMatchObject({ phase: "cancelled", telemetry: { finalizedAt: null } }));
      draining = f.service.drain(f.project.id).then(() => { drained = true; });
      releasePreflight();
      await logClose;
      // A turn boundary flushes drain's runnable continuations while log close
      // remains blocked by our barrier; no elapsed-time delay releases it.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(drained).toBe(false);
      expect(f.runs()[0].telemetry?.finalizedAt).toBeNull();
    } finally {
      releasePreflight();
      releaseLogClose();
      await draining;
    }
    expect(f.runs()[0].telemetry?.finalizedAt).toEqual(expect.any(String));
  });

  it.each([false, true])("drains the old exporter before restarting or switching (switch=%s)", async (switchWorktree) => {
    const f = fixture({ queueLimit: 2 });
    const other = join(f.root, "other");
    cpSync(f.worktreePath, other, { recursive: true });
    f.worktrees.push({ ...f.worktrees[0], path: other });
    for (const path of [f.worktreePath, other]) writeFileSync(join(path, "export_presets.cfg"), '[preset.0]\nname="Web"\nplatform="Web"\n');
    const started = join(f.root, "export-started"), ended = join(f.root, "export-ended");
    const executable = join(f.root, "fake-godot");
    writeFileSync(executable, `#!${process.execPath}
const {writeFileSync, existsSync} = require("node:fs");
const {dirname, join} = require("node:path");
const output = dirname(process.argv.at(-1));
if (!existsSync(${JSON.stringify(started)})) {
  process.on("SIGTERM", () => {});
  const timer = setInterval(() => writeFileSync(join(output, "index.pck"), "old-partial"), 20);
  writeFileSync(${JSON.stringify(started)}, "1");
  setTimeout(() => { clearInterval(timer); writeFileSync(${JSON.stringify(ended)}, "1"); process.exit(0); }, 900);
} else {
  if (!existsSync(${JSON.stringify(ended)})) process.exit(7);
  writeFileSync(join(output, "index.html"), "new");
  writeFileSync(join(output, "index.pck"), "new-pack");
}
`);
    chmodSync(executable, 0o755);
    await f.service.configure(f.project.id, { exporter: { kind: "preset", preset: "Web", godotExecutable: executable }, watch: { paths: ["src"] } });
    f.setRuntime("running");
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10_000 });
    f.setRuntime("stopping");
    f.setRuntime("running", switchWorktree ? other : f.worktreePath);
    // Even a manual request while replacement initialization waits must not bypass the drain.
    await f.service.rebuild(f.project.id);
    await vi.waitFor(() => expect(f.service.status(f.project.id)?.state).toBe("ready"), { timeout: 15_000 });
    const runs = f.runs();
    expect(runs).toHaveLength(2);
    expect(runs.find((run) => run.phase === "cancelled")?.telemetry?.cleanup).toBe("confirmed");
    const published = f.service.status(f.project.id)!.current!;
    expect(readFileSync(join(f.service.publicDirectory(f.project.id), "generations", published.id, "index.pck"), "utf8")).toBe("new-pack");
  });

  it("publishes a terminal failed state after three superseded exports, then recovers on manual rebuild", async () => {
    const f = fixture({ delayMs: 200 });
    f.setRuntime("running");
    await vi.waitFor(() => expect(f.service.status(f.project.id)?.state).toBe("ready"), { timeout: 10_000 });
    const good = f.service.status(f.project.id)!.current!.id;
    // Each exporter writes a watched source, so the completed output must be discarded.
    writeFileSync(join(f.worktreePath, "export.mjs"), EXPORTER.replace('mkdirSync("out",', 'writeFileSync("src/generated.gd", String(runs));\nmkdirSync("out",'));
    await f.service.rebuild(f.project.id);
    await vi.waitFor(() => {
      expect(f.service.status(f.project.id)).toMatchObject({ state: "failed", activeRunId: null, pendingRebuild: false, lastFailure: { code: "superseded" } });
      expect(f.state()).toMatchObject({ generation: good, build: "failed", failureCode: "superseded" });
      expect(f.runs()).toHaveLength(4);
      expect(f.runs().every((run) => run.phase !== "running" && run.phase !== "queued")).toBe(true);
    }, { timeout: 15_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(f.runs()).toHaveLength(4);
    writeFileSync(join(f.worktreePath, "export.mjs"), EXPORTER);
    await f.service.rebuild(f.project.id);
    await vi.waitFor(() => {
      expect(f.service.status(f.project.id)?.state).toBe("ready");
      expect(f.state()).toMatchObject({ build: "idle", failureCode: null });
      expect(f.state().generation).not.toBe(good);
    }, { timeout: 10_000 });
  }, 30_000);

  it("returns to verification-only even with a Node manifest or missing Godot manifest", async () => {
    const f = fixture();
    writeFileSync(join(f.worktreePath, "package.json"), JSON.stringify({ scripts: { dev: "node server.js" } }));
    rmSync(join(f.worktreePath, "project.godot"));
    expect(await f.service.configure(f.project.id, null)).toMatchObject({ launchPreset: "none", godotWeb: null });
  });

  it("reports initialization failure and can retry after storage recovers", async () => {
    const f = fixture();
    const storePath = join(f.root, "store");
    writeFileSync(storePath, "not a directory");
    f.setRuntime("running");
    await vi.waitFor(() => expect(f.service.status(f.project.id)).toMatchObject({ state: "failed", watcher: "stopped", lastFailure: { code: "configuration_invalid" } }));
    rmSync(storePath);
    f.service.runtimeChanged(f.project.id);
    await vi.waitFor(() => expect(f.service.status(f.project.id)?.state).toBe("ready"), { timeout: 10_000 });
  });

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
      command: { preset: { id: "node:test", name: "test", adapter: "node", timeoutMs: 10_000 }, executable: process.execPath, args: ["-e", "setTimeout(() => {}, 1500)"], cwd: f.root },
      environment: { environment: {}, mode: "clean", profile: "unit", inheritedServerProfile: null, variableNames: [] }, actor: "local-user",
    });
    // Queue admission is asynchronous; the export is requested only once the blocker holds the slot.
    await vi.waitFor(() => expect(f.store.getTestRun(blocker.id)?.phase).toBe("running"), { timeout: 10_000 });
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
