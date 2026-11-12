import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { nullLogWriter } from "@/server/log-writer";
import { MAX_RECORDED_ROOTS, openRunDirectoryRoot, RUN_DIRECTORY_PATH_BUDGET, RUN_DIRECTORY_RECORD, RUN_DIRECTORY_ROOT_MARKER, unavailableRunDirectories } from "./index";

const scratch: string[] = [];

/** Restores owner access a test removed anywhere below `path`, without following links. */
function restoreAccess(path: string): void {
  let stats: Stats;
  try { stats = lstatSync(path); } catch { return; }
  if (!stats.isDirectory()) return;
  try { chmodSync(path, 0o700); } catch { return; }
  for (const name of readdirSync(path)) restoreAccess(join(path, name));
}

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    restoreAccess(directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "wtc-root-test-"));
  scratch.push(base);
  const state = join(base, "state");
  const temporary = join(base, "tmp");
  const outside = join(base, "outside");
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(temporary, { mode: 0o700 });
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "keep");
  mkdirSync(join(outside, "nested"));
  writeFileSync(join(outside, "nested", "keep.txt"), "keep");
  const logs = { ...nullLogWriter, controller: vi.fn() };
  const open = (stateDirectory = state) => openRunDirectoryRoot({ stateDirectory, temporaryDirectory: temporary, logs });
  const outsideIntact = () => {
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(readFileSync(join(outside, "nested", "keep.txt"), "utf8")).toBe("keep");
  };
  const record = (stateDirectory = state) => JSON.parse(readFileSync(join(stateDirectory, RUN_DIRECTORY_RECORD), "utf8")) as { version: number; roots: { path: string; token: string }[] };
  const writeRecord = (roots: { path: string; token: string }[], stateDirectory = state) => writeFileSync(join(stateDirectory, RUN_DIRECTORY_RECORD), JSON.stringify({ version: 2, roots }));
  /** Recorded root paths, whatever the entry shape. */
  const recordedPaths = (stateDirectory = state) => (JSON.parse(readFileSync(join(stateDirectory, RUN_DIRECTORY_RECORD), "utf8")) as { roots: (string | { path: string })[] })
    .roots.map(entry => (typeof entry === "string" ? entry : entry.path));
  return { base, state, temporary, outside, logs, open, outsideIntact, record, recordedPaths, writeRecord };
}

const mode = (path: string) => statSync(path).mode & 0o777;
const newToken = () => randomBytes(32).toString("hex");
const marker = (root: string) => join(root, RUN_DIRECTORY_ROOT_MARKER);

describe("run directory root", () => {
  it("creates and records a private root and short private run directories directly inside it", async () => {
    const { open, temporary, record, logs } = fixture();
    const root = await open();
    expect(dirname(root.path)).toBe(temporary);
    expect(basename(root.path)).toMatch(/^wtc-/);
    expect(mode(root.path)).toBe(0o700);
    // The record stores the path and the random token held by the root's marker.
    const [entry] = record().roots;
    expect(record()).toMatchObject({ version: 2, roots: [{ path: root.path }] });
    expect(entry!.token).toMatch(/^[0-9a-f]{64}$/);
    expect(lstatSync(marker(root.path)).isFile()).toBe(true);
    expect(mode(marker(root.path))).toBe(0o600);
    expect(readFileSync(marker(root.path), "utf8")).toBe(entry!.token);
    expect(JSON.stringify(logs.controller.mock.calls)).not.toContain(entry!.token);
    const first = root.create();
    const second = root.create();
    expect(dirname(first)).toBe(root.path);
    expect(first).not.toBe(second);
    expect(mode(first)).toBe(0o700);
    // On Linux with /tmp the complete run directory stays inside the socket-path budget.
    const suffix = first.length - temporary.length;
    expect("/tmp".length + suffix).toBeLessThanOrEqual(RUN_DIRECTORY_PATH_BUDGET);
    for (let index = 0; index < 1_000; index += 1) root.create();
    expect(root.create().length - temporary.length).toBeLessThanOrEqual(RUN_DIRECTORY_PATH_BUDGET - "/tmp".length);
    await root.close();
  });

  it("removes a large nested tree, read-only directories and links without following them", async () => {
    const { open, outside, outsideIntact } = fixture();
    const root = await open();
    const run = root.create();
    for (let index = 0; index < 2_000; index += 1) writeFileSync(join(run, `file-${index}`), "x");
    mkdirSync(join(run, "a", "b", "c"), { recursive: true });
    writeFileSync(join(run, "a", "b", "c", "deep"), "x");
    symlinkSync(outside, join(run, "link-to-directory"));
    symlinkSync(join(outside, "keep.txt"), join(run, "link-to-file"));
    symlinkSync(outside, join(run, "a", "b", "nested-link"));
    mkdirSync(join(run, "read-only"));
    writeFileSync(join(run, "read-only", "file"), "x");
    chmodSync(join(run, "read-only"), 0o500);
    await root.remove(run);
    expect(existsSync(run)).toBe(false);
    expect(existsSync(root.path)).toBe(true);
    outsideIntact();
    await root.close();
  });

  it("refuses a run directory replaced by a symbolic link and deletes nothing outside the root", async () => {
    const { open, outside, outsideIntact } = fixture();
    const root = await open();
    const run = root.create();
    renameSync(run, `${run}-moved`);
    symlinkSync(outside, run);
    await expect(root.remove(run)).rejects.toThrow("not_a_directory");
    outsideIntact();
    // The root sweep unlinks the link itself and never enters its target.
    await root.close();
    expect(existsSync(root.path)).toBe(false);
    outsideIntact();
  });

  it("refuses any target that is not directly inside the root", async () => {
    const { open, outside, outsideIntact } = fixture();
    const root = await open();
    const run = root.create();
    mkdirSync(join(run, "child"));
    await expect(root.remove(outside)).rejects.toThrow("outside_root");
    await expect(root.remove(join(run, "child"))).rejects.toThrow("outside_root");
    await expect(root.remove(`${root.path}/../${basename(outside)}`)).rejects.toThrow("outside_root");
    await expect(root.remove(root.path)).rejects.toThrow("outside_root");
    expect(existsSync(join(run, "child"))).toBe(true);
    outsideIntact();
    await root.close();
  });

  it("removes the root on close and records that nothing remains", async () => {
    const { open, record } = fixture();
    const root = await open();
    writeFileSync(join(root.create(), "left-over"), "x");
    await root.close();
    await root.close();
    expect(existsSync(root.path)).toBe(false);
    expect(record().roots).toEqual([]);
    expect(() => root.create()).toThrow("run_directory_unavailable");
  });

  it("sweeps only the root recorded by its own state directory at the next start", async () => {
    const { base, open, temporary, record, outside, outsideIntact } = fixture();
    const otherState = join(base, "other-state");
    mkdirSync(otherState, { mode: 0o700 });
    const crashed = await open();
    writeFileSync(join(crashed.create(), "left-over"), "x");
    symlinkSync(outside, join(crashed.create(), "escape"));
    const neighbour = await open(otherState);
    writeFileSync(join(neighbour.create(), "in-use"), "x");
    const unrecorded = join(temporary, "wtc-unrecorded");
    mkdirSync(unrecorded);
    writeFileSync(join(unrecorded, "kept"), "x");

    const restarted = await open();
    expect(existsSync(crashed.path)).toBe(false);
    expect(record().roots.map(entry => entry.path)).toEqual([restarted.path]);
    expect(readdirSync(neighbour.path).sort()).toEqual([RUN_DIRECTORY_ROOT_MARKER, "r1"]);
    expect(existsSync(join(unrecorded, "kept"))).toBe(true);
    outsideIntact();
    await restarted.close();
    await neighbour.close();
  });

  it("never follows a recorded root that became a symbolic link and keeps it recorded", async () => {
    const { open, state, outside, outsideIntact, record, logs } = fixture();
    const root = await open();
    rmSync(root.path, { recursive: true });
    symlinkSync(outside, root.path);
    const restarted = await open();
    outsideIntact();
    expect(lstatSync(root.path).isSymbolicLink()).toBe(true);
    expect(record(state).roots.map(entry => entry.path)).toEqual([root.path, restarted.path]);
    expect(logs.controller).toHaveBeenCalledWith("run_directory.previous_root_skipped", { path: root.path, reason: "not_a_directory" });
    await restarted.close();
    expect(record(state).roots.map(entry => entry.path)).toEqual([root.path]);
  });

  it("ignores a malformed record instead of treating anything as owned", async () => {
    const { open, state, temporary } = fixture();
    const victim = join(temporary, "not-ours");
    mkdirSync(victim);
    writeFileSync(join(state, RUN_DIRECTORY_RECORD), JSON.stringify({ version: 2, roots: [victim] }));
    const root = await open();
    expect(existsSync(victim)).toBe(true);
    writeFileSync(join(state, RUN_DIRECTORY_RECORD), JSON.stringify({ version: 1, roots: ["relative/path", "/", `${victim}/../not-ours`] }));
    const second = await open();
    expect(existsSync(victim)).toBe(true);
    await root.close().catch(() => undefined);
    await second.close();
  });

  it("never deletes an unrelated directory that a path-only record names", async () => {
    const { base, open, state, temporary } = fixture();
    const home = join(base, "home");
    const lookalike = join(temporary, "wtc-lookalike");
    for (const directory of [home, lookalike]) {
      mkdirSync(join(directory, "project", "src"), { recursive: true });
      writeFileSync(join(directory, "project", "src", "index.ts"), "keep");
    }
    writeFileSync(join(state, RUN_DIRECTORY_RECORD), JSON.stringify({ version: 1, roots: [home, lookalike] }));
    const root = await open();
    for (const directory of [home, lookalike]) expect(readFileSync(join(directory, "project", "src", "index.ts"), "utf8")).toBe("keep");
    await root.close();
  });

  it("keeps every recorded root that still exists, however many accumulate", async () => {
    const { open, outside, recordedPaths } = fixture();
    const leaked: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const root = await open();
      // A root that cannot be removed: it became a symbolic link, which is never followed.
      rmSync(root.path, { recursive: true });
      symlinkSync(outside, root.path);
      leaked.push(root.path);
    }
    const last = await open();
    expect(recordedPaths()).toEqual(expect.arrayContaining(leaked));
    await last.close();
    expect(recordedPaths()).toEqual(expect.arrayContaining(leaked));
  });

  it("removes directories without any owner permission at every depth", async () => {
    const { open, outsideIntact } = fixture();
    const root = await open();
    const run = root.create();
    mkdirSync(join(run, "a", "b", "c"), { recursive: true });
    writeFileSync(join(run, "a", "b", "c", "deep"), "x");
    writeFileSync(join(run, "a", "b", "file"), "x");
    mkdirSync(join(run, "top"));
    writeFileSync(join(run, "top", "file"), "x");
    chmodSync(join(run, "a", "b", "c"), 0o000);
    chmodSync(join(run, "a", "b"), 0o000);
    chmodSync(join(run, "top"), 0o000);
    await root.remove(run);
    expect(existsSync(run)).toBe(false);
    outsideIntact();
    await root.close();
  });

  it("removes a recorded root whose marker holds the recorded token and updates the record", async () => {
    const { open, record, logs } = fixture();
    const crashed = await open();
    const run = crashed.create();
    writeFileSync(join(run, "left-over"), "x");
    // Run directories never remove the marker.
    await crashed.remove(run);
    await expect(crashed.remove(marker(crashed.path))).rejects.toThrow("root_marker");
    expect(existsSync(marker(crashed.path))).toBe(true);
    const restarted = await open();
    expect(existsSync(crashed.path)).toBe(false);
    expect(logs.controller).toHaveBeenCalledWith("run_directory.previous_root_removed", { path: crashed.path });
    expect(record().roots.map(entry => entry.path)).toEqual([restarted.path]);
    await restarted.close();
    expect(record().roots).toEqual([]);
  });

  it("never deletes an unrelated user directory that a well-formed record names", async () => {
    const { base, open, temporary, record, writeRecord, logs } = fixture();
    const home = join(base, "home");
    const lookalike = join(temporary, "wtc-lookalike");
    for (const directory of [home, lookalike]) {
      mkdirSync(join(directory, "project", "src"), { recursive: true });
      writeFileSync(join(directory, "project", "src", "index.ts"), "keep");
    }
    writeRecord([{ path: home, token: newToken() }, { path: lookalike, token: newToken() }]);
    const root = await open();
    for (const directory of [home, lookalike]) expect(readFileSync(join(directory, "project", "src", "index.ts"), "utf8")).toBe("keep");
    expect(logs.controller).toHaveBeenCalledWith("run_directory.previous_root_skipped", { path: home, reason: "name_mismatch" });
    expect(logs.controller).toHaveBeenCalledWith("run_directory.previous_root_skipped", { path: lookalike, reason: "marker_missing" });
    // Directories that still exist stay recorded so an operator can see them.
    expect(record().roots.map(entry => entry.path)).toEqual([home, lookalike, root.path]);
    await root.close();
  });

  it("keeps a root whose marker holds a different token", async () => {
    const { open, record, writeRecord, logs } = fixture();
    const crashed = await open();
    writeFileSync(join(crashed.create(), "left-over"), "x");
    writeRecord([{ path: crashed.path, token: newToken() }]);
    const restarted = await open();
    expect(existsSync(join(crashed.path, "r1", "left-over"))).toBe(true);
    expect(logs.controller).toHaveBeenCalledWith("run_directory.previous_root_skipped", { path: crashed.path, reason: "marker_mismatch" });
    expect(record().roots.map(entry => entry.path)).toEqual([crashed.path, restarted.path]);
    await restarted.close();
  });

  it("keeps a root whose marker was replaced by a link to a file holding the right token", async () => {
    const { open, outside, logs } = fixture();
    const crashed = await open();
    writeFileSync(join(crashed.create(), "left-over"), "x");
    const copy = join(outside, "token-copy");
    writeFileSync(copy, readFileSync(marker(crashed.path)));
    rmSync(marker(crashed.path));
    symlinkSync(copy, marker(crashed.path));
    const restarted = await open();
    expect(existsSync(join(crashed.path, "r1", "left-over"))).toBe(true);
    expect(existsSync(copy)).toBe(true);
    expect(logs.controller).toHaveBeenCalledWith("run_directory.previous_root_skipped", { path: crashed.path, reason: "marker_not_regular" });
    await restarted.close();
  });

  it("never uses a path-only version 1 record, even for a real root", async () => {
    const { open, state, logs } = fixture();
    const crashed = await open();
    writeFileSync(join(crashed.create(), "left-over"), "x");
    writeFileSync(join(state, RUN_DIRECTORY_RECORD), JSON.stringify({ version: 1, roots: [crashed.path] }));
    const restarted = await open();
    expect(existsSync(join(crashed.path, "r1", "left-over"))).toBe(true);
    expect(logs.controller).toHaveBeenCalledWith("run_directory.record_ignored", { error: "record_version_unsupported" });
    await restarted.close();
  });

  it("drops the entry of a recorded root that no longer exists", async () => {
    const { open, temporary, record, writeRecord, logs } = fixture();
    const gone = join(temporary, "wtc-gone");
    writeRecord([{ path: gone, token: newToken() }]);
    const root = await open();
    expect(logs.controller).toHaveBeenCalledWith("run_directory.previous_root_missing", { path: gone });
    expect(record().roots.map(entry => entry.path)).toEqual([root.path]);
    await root.close();
  });

  it("keeps the live root recorded when its marker is gone at close", async () => {
    const { open, record, logs } = fixture();
    const root = await open();
    writeFileSync(join(root.create(), "left-over"), "x");
    rmSync(marker(root.path));
    await expect(root.close()).rejects.toThrow("marker_missing");
    expect(existsSync(join(root.path, "r1", "left-over"))).toBe(true);
    expect(record().roots.map(entry => entry.path)).toEqual([root.path]);
    expect(logs.controller).toHaveBeenCalledWith("run_directory.root_cleanup_failed", { root: root.path, error: "marker_missing" });
  });

  it("creates no root when the record is full and keeps every existing entry", async () => {
    const { open, temporary, state, record, writeRecord, logs } = fixture();
    const leaked = Array.from({ length: MAX_RECORDED_ROOTS }, (_, index) => {
      const path = join(temporary, `wtc-leak${index}`);
      mkdirSync(path);
      return { path, token: newToken() };
    });
    writeRecord(leaked);
    await expect(open()).rejects.toThrow("run_directory_record_full");
    expect(readdirSync(temporary)).toHaveLength(MAX_RECORDED_ROOTS);
    expect(record().roots).toEqual(leaked);
    expect(logs.controller).toHaveBeenCalledWith("run_directory.record_full", { record: join(state, RUN_DIRECTORY_RECORD), count: MAX_RECORDED_ROOTS, limit: MAX_RECORDED_ROOTS });
    // After the operator removes one leaked directory, its entry is dropped and a root is created.
    rmSync(leaked[0]!.path, { recursive: true });
    const root = await open();
    expect(record().roots.map(entry => entry.path)).toEqual([...leaked.slice(1).map(entry => entry.path), root.path]);
    await root.close();
  });

  it("fails run creation when no root is available", async () => {
    const directories = unavailableRunDirectories();
    expect(() => directories.create()).toThrow("run_directory_unavailable");
    await expect(directories.close()).resolves.toBeUndefined();
  });
});
