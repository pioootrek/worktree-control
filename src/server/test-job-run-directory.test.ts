import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Worktree } from "@/shared/contracts";
import type { ResolvedTestEnvironment } from "@/server/modules/environments";
import type { RunDirectories } from "@/server/modules/verification";
import { openRunDirectoryRoot, RUN_DIRECTORY_ROOT_MARKER, unavailableRunDirectories, type RunDirectoryRoot } from "./infrastructure/run-directories";
import { nullLogWriter } from "./log-writer";
import { SqliteStateStore } from "./sqlite-store";
import type { TestCommand } from "./test-command";
import { TestJobManager } from "./test-job-manager";

const scratch: string[] = [];
const managers: TestJobManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.shutdown().catch(() => undefined)));
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function resolved(environment: Record<string, string> = {}): ResolvedTestEnvironment {
  return { environment, mode: "clean", profile: "unit", inheritedServerProfile: null, variableNames: Object.keys(environment).sort() };
}

/**
 * The child writes files into its TMPDIR, reports what it saw, then behaves as
 * `tail` says. Its directory and everything in it must be gone after the run.
 */
const CHILD = (tail: string) => `
const fs = require("fs"), path = require("path");
const dir = process.env.TMPDIR;
for (let i = 0; i < 200; i += 1) fs.writeFileSync(path.join(dir, "file-" + i), "x");
fs.mkdirSync(path.join(dir, "nested", "deep"), { recursive: true });
fs.writeFileSync(path.join(dir, "nested", "deep", "file"), "y");
console.log("seen:" + JSON.stringify({ TMPDIR: dir, TMP: process.env.TMP, TEMP: process.env.TEMP, mode: fs.statSync(dir).mode & 0o777, pid: process.pid }));
${tail}`;

/** Entries of the root other than its identity marker. */
const runDirectoriesIn = (root: RunDirectoryRoot) => readdirSync(root.path).filter(name => name !== RUN_DIRECTORY_ROOT_MARKER);

interface Seen { TMPDIR: string; TMP: string; TEMP: string; mode: number; pid: number }

async function fixture(options: { directories?: (root: RunDirectoryRoot) => RunDirectories } = {}) {
  const base = mkdtempSync(join(tmpdir(), "wtc-run-dir-test-"));
  scratch.push(base);
  const state = join(base, "state");
  const temporary = join(base, "tmp");
  const outside = join(base, "outside");
  for (const directory of [state, temporary, outside]) mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(outside, "keep.txt"), "keep");
  const store = new SqliteStateStore(join(base, "state.sqlite3"));
  const project = store.addProject({ name: "App", repositoryPath: base, port: 3211, executable: "node", args: [] });
  const logs = { ...nullLogWriter, controller: vi.fn() };
  const root = await openRunDirectoryRoot({ stateDirectory: state, temporaryDirectory: temporary, logs });
  const manager = new TestJobManager(store, logs);
  managers.push(manager);
  manager.configureRunDirectories(options.directories ? options.directories(root) : root);
  const worktree = (path: string): Worktree => ({ path, head: "abcdef123456", shortHead: "abcdef1", branch: "main", detached: false, locked: false, prunable: false, dirty: false });
  let worktrees = 0;
  const enqueue = (script: string, environment: Record<string, string> = {}, timeoutMs = 10_000, executable = process.execPath) => {
    const command: TestCommand = { preset: { id: "node:test", name: "test", adapter: "node", timeoutMs }, executable, args: ["-e", script], cwd: base };
    worktrees += 1;
    return manager.enqueue({ projectId: project.id, worktree: worktree(join(base, `worktree-${worktrees}`)), command, environment: resolved(environment), actor: "local-user" });
  };
  const seen = async (runId: string): Promise<Seen> => {
    let value: Seen | null = null;
    await vi.waitFor(() => {
      const line = store.getTestRun(runId)?.logs.find(entry => entry.startsWith("seen:"));
      expect(line).toBeTruthy();
      value = JSON.parse(line!.slice(5)) as Seen;
    }, { timeout: 5_000 });
    return value!;
  };
  const terminal = (runId: string, phase: string) => vi.waitFor(() => {
    const run = store.getTestRun(runId);
    expect(run?.phase).toBe(phase);
    expect(run?.telemetry?.finalizedAt).toBeTruthy();
  }, { timeout: 8_000 });
  const close = async () => {
    managers.splice(managers.indexOf(manager), 1);
    await manager.shutdown();
    store.close();
  };
  return { base, outside, temporary, store, logs, root, manager, enqueue, seen, terminal, close };
}

function expectPrivateRunDirectory(seen: Seen, root: RunDirectoryRoot) {
  expect(seen.TMP).toBe(seen.TMPDIR);
  expect(seen.TEMP).toBe(seen.TMPDIR);
  expect(dirname(seen.TMPDIR)).toBe(root.path);
  expect(seen.mode).toBe(0o700);
  // With /tmp as the OS temporary directory this is "/tmp/wtc-XXXXXX/rN".
  expect(seen.TMPDIR.length - dirname(root.path).length + "/tmp".length).toBeLessThanOrEqual(40);
}

describe("per-run private temporary directory", () => {
  it("gives a passing run a private TMPDIR, TMP and TEMP and removes its files after exit", async () => {
    const { store, root, enqueue, seen, terminal, close } = await fixture();
    const run = enqueue(CHILD("process.exit(0);"));
    const observed = await seen(run.id);
    expectPrivateRunDirectory(observed, root);
    await terminal(run.id, "passed");
    expect(existsSync(observed.TMPDIR)).toBe(false);
    expect(runDirectoriesIn(root)).toEqual([]);
    const stored = store.getTestRun(run.id)!;
    expect(stored.environmentVariableNames).toEqual(expect.arrayContaining(["TEMP", "TMP", "TMPDIR"]));
    expect(stored.source.reasonCodes).not.toContain("run_directory_cleanup_failed");
    expect(stored.telemetry?.cleanup).toBe("confirmed");
    await close();
    expect(existsSync(root.path)).toBe(false);
  });

  it("removes the directory after a failing exit", async () => {
    const { root, enqueue, seen, terminal, close } = await fixture();
    const run = enqueue(CHILD("process.exit(3);"));
    const observed = await seen(run.id);
    await terminal(run.id, "failed");
    expect(existsSync(observed.TMPDIR)).toBe(false);
    expect(runDirectoriesIn(root)).toEqual([]);
    await close();
  });

  it("removes the directory after cancellation", async () => {
    const { root, manager, enqueue, seen, terminal, close } = await fixture();
    const run = enqueue(CHILD("setInterval(() => {}, 1000);"));
    const observed = await seen(run.id);
    await manager.cancel(run.id, "local-user");
    await terminal(run.id, "cancelled");
    expect(existsSync(observed.TMPDIR)).toBe(false);
    expect(runDirectoriesIn(root)).toEqual([]);
    await close();
  });

  it("removes the directory after a timeout", async () => {
    const { root, enqueue, seen, terminal, close } = await fixture();
    const run = enqueue(CHILD("setInterval(() => {}, 1000);"), {}, 1_500);
    const observed = await seen(run.id);
    await terminal(run.id, "timed_out");
    expect(existsSync(observed.TMPDIR)).toBe(false);
    expect(runDirectoriesIn(root)).toEqual([]);
    await close();
  });

  it("removes the directory after an administrative stop", async () => {
    const { root, manager, enqueue, seen, terminal, close } = await fixture();
    const run = enqueue(CHILD("setInterval(() => {}, 1000);"));
    const observed = await seen(run.id);
    await expect(manager.administrativeStop(run.id)).resolves.toMatchObject({ action: "cancel" });
    await terminal(run.id, "cancelled");
    expect(existsSync(observed.TMPDIR)).toBe(false);
    expect(runDirectoriesIn(root)).toEqual([]);
    await close();
  });

  it("removes a created directory when the command cannot be spawned", async () => {
    const { store, root, enqueue, terminal, close } = await fixture();
    const run = enqueue("", {}, 10_000, join(root.path, "missing-executable"));
    await terminal(run.id, "failed");
    expect(store.getTestRun(run.id)?.environmentVariableNames).toEqual(expect.arrayContaining(["TMPDIR"]));
    expect(runDirectoriesIn(root)).toEqual([]);
    await close();
  });

  it("overrides profile values for TMPDIR, TMP and TEMP with the controller's directory", async () => {
    const { root, enqueue, seen, terminal, close, base } = await fixture();
    const profileDirectory = join(base, "profile-tmp");
    mkdirSync(profileDirectory);
    const run = enqueue(CHILD("process.exit(0);"), { TMPDIR: profileDirectory, TMP: profileDirectory, TEMP: profileDirectory, APP_FLAG: "1" });
    const observed = await seen(run.id);
    expectPrivateRunDirectory(observed, root);
    await terminal(run.id, "passed");
    expect(readdirSync(profileDirectory)).toEqual([]);
    await close();
  });

  it("keeps the process outcome, reports a reason code and keeps admission open when removal fails", async () => {
    const remove = vi.fn(async () => { throw new Error("EBUSY"); });
    const { store, logs, manager, root, enqueue, seen, terminal, close } = await fixture({
      directories: real => ({ create: () => real.create(), remove, close: () => real.close() }),
    });
    const run = enqueue(CHILD("process.exit(0);"));
    const observed = await seen(run.id);
    await terminal(run.id, "passed");
    const stored = store.getTestRun(run.id)!;
    expect(stored).toMatchObject({ exitCode: 0, source: { processOutcome: "passed" }, telemetry: { cleanup: "confirmed", termination: "exit" } });
    expect(stored.source.reasonCodes).toContain("run_directory_cleanup_failed");
    expect(remove).toHaveBeenCalledTimes(3);
    expect(logs.controller).toHaveBeenCalledWith("test_run.run_directory_cleanup_failed", expect.objectContaining({ runId: run.id, attempts: 3 }));
    expect(existsSync(observed.TMPDIR)).toBe(true);
    expect(manager.status().admissionBlockReason).toBeUndefined();
    const next = enqueue("process.exit(0);");
    await terminal(next.id, "passed");
    // The left-over directory goes with the root.
    await close();
    expect(existsSync(root.path)).toBe(false);
  });

  it("deletes nothing outside the root when a test swaps its directory for a link or plants links in it", async () => {
    const { store, outside, root, enqueue, seen, terminal, close } = await fixture();
    const planted = enqueue(CHILD(`
fs.symlinkSync(${JSON.stringify(outside)}, path.join(dir, "escape"));
fs.symlinkSync(${JSON.stringify(join(outside, "keep.txt"))}, path.join(dir, "nested", "file-link"));
process.exit(0);`));
    await seen(planted.id);
    await terminal(planted.id, "passed");
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(store.getTestRun(planted.id)?.source.reasonCodes).not.toContain("run_directory_cleanup_failed");

    const swapped = enqueue(CHILD(`
fs.renameSync(dir, dir + "-moved");
fs.symlinkSync(${JSON.stringify(outside)}, dir);
process.exit(0);`));
    await seen(swapped.id);
    await terminal(swapped.id, "passed");
    expect(store.getTestRun(swapped.id)?.source.reasonCodes).toContain("run_directory_cleanup_failed");
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    await close();
    expect(existsSync(root.path)).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
  }, 15_000);

  it("stops the owned process group before shutdown removes the directory and the root", async () => {
    let pid = 0;
    const removedWhileAlive: boolean[] = [];
    const { store, root, manager, enqueue, seen } = await fixture({
      directories: real => ({
        create: () => real.create(),
        remove: async path => {
          let alive = true;
          try { process.kill(pid, 0); } catch { alive = false; }
          removedWhileAlive.push(alive);
          await real.remove(path);
        },
        close: () => real.close(),
      }),
    });
    const run = enqueue(CHILD("setInterval(() => {}, 1000);"));
    pid = (await seen(run.id)).pid;
    managers.splice(managers.indexOf(manager), 1);
    await manager.shutdown();
    expect(store.getTestRun(run.id)?.phase).toBe("cancelled");
    store.close();
    expect(removedWhileAlive).toEqual([false]);
    expect(existsSync(root.path)).toBe(false);
  });

  it("fails a run before spawning when no directory can be created", async () => {
    const { store, base, enqueue, terminal, close } = await fixture({ directories: () => unavailableRunDirectories() });
    const marker = join(base, "never-written");
    const run = enqueue(`require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`);
    await terminal(run.id, "failed");
    expect(store.getTestRun(run.id)).toMatchObject({ error: "run_directory_unavailable", exitCode: null, telemetry: { termination: "spawn_error" } });
    expect(existsSync(marker)).toBe(false);
    await close();
  });

  it("leaves remote-worker attempts with their own directories untouched", async () => {
    const create = vi.fn();
    const { store, manager, base, terminal, close } = await fixture({
      directories: real => ({ create: () => { create(); return real.create(); }, remove: path => real.remove(path), close: () => real.close() }),
    });
    const project = store.listProjects()[0]!;
    const worktree: Worktree = { path: join(base, "remote"), head: "aaa", shortHead: "aaa", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
    const source = { observedAt: new Date().toISOString(), head: "aaa", branch: "main", dirty: false, statusDigest: "empty", statusEntries: 0, complete: true, errorCode: null };
    const attemptTemporary = join(base, "attempt-tmp");
    const command: TestCommand = { preset: { id: "node:test", name: "test", adapter: "node", timeoutMs: 10_000 }, executable: process.execPath, args: ["-e", "console.log('tmp:' + process.env.TMPDIR)"], cwd: base };
    const run = manager.enqueue({
      projectId: project.id, worktree, command, environment: resolved(), actor: "local-user",
      preparation: {
        prepare: async () => ({ worktree, command, environment: resolved({ TMPDIR: attemptTemporary }), sourceObservation: source }),
        observe: async () => ({ ...source, observedAt: new Date().toISOString() }),
        dispose: async () => undefined,
      },
    });
    await terminal(run.id, "passed");
    expect(create).not.toHaveBeenCalled();
    expect(store.getTestRun(run.id)?.logs).toContain(`tmp:${attemptTemporary}`);
    expect(store.getTestRun(run.id)?.environmentVariableNames).toEqual(["TMPDIR"]);
    await close();
  });
});
