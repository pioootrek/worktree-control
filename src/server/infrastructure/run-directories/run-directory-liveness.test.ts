import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { nullLogWriter } from "@/server/log-writer";
import { openRunDirectoryRoot, RUN_DIRECTORY_RECORD } from "./index";
import { ProcessGroups } from "./process-group-fixture";

interface RunEntry { name: string; processGroupId: number | null }
interface RecordedRoot { path: string; token: string; bootId: string | null; runs: RunEntry[] }

const groups = new ProcessGroups();
const scratch: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  // Every process group a test created is stopped, and nothing is left on disk.
  expect(await groups.stopAll()).toEqual([]);
  for (const directory of scratch.splice(0)) {
    chmodSync(directory, 0o700);
    for (const child of ["state", "tmp"]) { try { chmodSync(join(directory, child), 0o700); } catch { /* absent */ } }
    rmSync(directory, { recursive: true, force: true });
    expect(existsSync(directory)).toBe(false);
  }
});

const bootIdKnown = existsSync("/proc/sys/kernel/random/boot_id");

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "wtc-liveness-test-"));
  scratch.push(base);
  const state = join(base, "state");
  const temporary = join(base, "tmp");
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(temporary, { mode: 0o700 });
  const logs = { ...nullLogWriter, controller: vi.fn() };
  const open = () => openRunDirectoryRoot({ stateDirectory: state, temporaryDirectory: temporary, logs });
  const recordPath = join(state, RUN_DIRECTORY_RECORD);
  const record = () => JSON.parse(readFileSync(recordPath, "utf8")) as { version: number; roots: RecordedRoot[] };
  const rewrite = (change: (roots: RecordedRoot[]) => void) => {
    const current = record();
    change(current.roots);
    writeFileSync(recordPath, JSON.stringify(current));
  };
  return { base, state, temporary, logs, open, record, rewrite };
}

/** Zero-signal probes of process groups issued through `process.kill`. */
function probes(kill: { mock: { calls: unknown[][] } }): number[] {
  return kill.mock.calls.filter(call => call[1] === 0 && typeof call[0] === "number" && call[0] < 0).map(call => -(call[0] as number));
}

describe("run directory liveness at the startup sweep", () => {
  it("records the process group bound to a run directory and drops it once the directory is removed", async () => {
    const { open, record } = fixture();
    const root = await open();
    const run = root.create();
    const group = await groups.exited();
    root.bind(run, group);
    expect(record()).toMatchObject({ version: 3, roots: [{ path: root.path, runs: [{ name: basename(run), processGroupId: group }] }] });
    expect(record().roots[0]!.bootId).toBe(bootIdKnown ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() : null);
    await root.remove(run);
    expect(record().roots[0]!.runs).toEqual([]);
    await root.close();
  });

  it("keeps a root whose run's process group is alive and removes it at a later start once the group is gone", async () => {
    const { open, record, logs } = fixture();
    const crashed = await open();
    const run = crashed.create();
    writeFileSync(join(run, "in-use"), "x");
    const group = await groups.live();
    crashed.bind(run, group);

    // The controller stopped without closing the root; its test process still runs.
    const second = await open();
    expect(existsSync(join(run, "in-use"))).toBe(true);
    expect(record().roots.map(root => root.path)).toEqual([crashed.path, second.path]);
    expect(record().roots[0]!.runs).toEqual([{ name: basename(run), processGroupId: group }]);
    expect(logs.controller).toHaveBeenCalledWith("run_directory.previous_root_retained", { path: crashed.path, reason: "liveness_unknown", kept: 1, removed: 0 });
    expect(logs.controller.mock.calls.filter(call => call[0] === "run_directory.previous_root_retained")).toHaveLength(1);

    await groups.stop(group);
    const third = await open();
    expect(existsSync(crashed.path)).toBe(false);
    expect(existsSync(second.path)).toBe(false);
    expect(record().roots.map(root => root.path)).toEqual([third.path]);
    await third.close();
  });

  it("removes the quiescent run directory of a root and keeps the one whose group is alive", async () => {
    const { open, record, logs } = fixture();
    const crashed = await open();
    const alive = crashed.create();
    const quiet = crashed.create();
    writeFileSync(join(alive, "in-use"), "x");
    writeFileSync(join(quiet, "left-over"), "x");
    const liveGroup = await groups.live();
    crashed.bind(alive, liveGroup);
    crashed.bind(quiet, await groups.exited());

    const restarted = await open();
    expect(existsSync(join(alive, "in-use"))).toBe(true);
    expect(existsSync(quiet)).toBe(false);
    expect(record().roots[0]).toMatchObject({ path: crashed.path, runs: [{ name: basename(alive), processGroupId: liveGroup }] });
    expect(logs.controller).toHaveBeenCalledWith("run_directory.previous_root_retained", { path: crashed.path, reason: "liveness_unknown", kept: 1, removed: 1 });
    await restarted.close();
  });

  it.runIf(bootIdKnown)("removes a root recorded during another boot without probing any group", async () => {
    const { open, record, rewrite, logs } = fixture();
    const crashed = await open();
    const run = crashed.create();
    writeFileSync(join(run, "left-over"), "x");
    crashed.bind(run, await groups.live());
    rewrite(roots => { roots[0]!.bootId = randomUUID(); });
    const kill = vi.spyOn(process, "kill");

    const restarted = await open();
    expect(probes(kill)).toEqual([]);
    expect(existsSync(crashed.path)).toBe(false);
    expect(logs.controller).toHaveBeenCalledWith("run_directory.previous_root_removed", { path: crashed.path });
    expect(record().roots.map(root => root.path)).toEqual([restarted.path]);
    await restarted.close();
  });

  it("keeps run directories without a recorded process group", async () => {
    const { open, record, logs } = fixture();
    const crashed = await open();
    const unbound = crashed.create();
    const withoutGroup = crashed.create();
    crashed.bind(withoutGroup, null);
    const kill = vi.spyOn(process, "kill");

    const restarted = await open();
    expect(probes(kill)).toEqual([]);
    expect(existsSync(unbound)).toBe(true);
    expect(existsSync(withoutGroup)).toBe(true);
    expect(record().roots[0]).toMatchObject({ path: crashed.path, runs: [{ name: basename(withoutGroup), processGroupId: null }] });
    expect(logs.controller).toHaveBeenCalledWith("run_directory.previous_root_retained", { path: crashed.path, reason: "liveness_unknown", kept: 2, removed: 0 });
    await restarted.close();
  });

  it("never probes a recorded group id that is not a safe integer greater than 1", async () => {
    const { open, rewrite } = fixture();
    const crashed = await open();
    const unsafe = [0, 1, -5, 2.5, 2 ** 53];
    const runs = unsafe.map(() => crashed.create());
    rewrite(roots => { roots[0]!.runs = runs.map((run, index) => ({ name: basename(run), processGroupId: unsafe[index]! })); });
    const kill = vi.spyOn(process, "kill");

    const restarted = await open();
    // No zero-signal call at all, whatever sign or target.
    expect(kill.mock.calls.filter(call => call[1] === 0)).toEqual([]);
    for (const run of runs) expect(existsSync(run)).toBe(true);
    await restarted.close();
  });

  it("lets the run continue and logs when its binding cannot be recorded", async () => {
    const { open, state, logs } = fixture();
    const root = await open();
    const run = root.create();
    const group = await groups.exited();
    chmodSync(state, 0o500);
    try {
      expect(() => root.bind(run, group)).not.toThrow();
      expect(logs.controller).toHaveBeenCalledWith("run_directory.binding_not_recorded", expect.objectContaining({ root: root.path, name: basename(run) }));
    } finally { chmodSync(state, 0o700); }
    await root.remove(run);
    await root.close();
  });
});
