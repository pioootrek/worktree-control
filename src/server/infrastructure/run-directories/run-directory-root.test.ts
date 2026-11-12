import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { nullLogWriter } from "@/server/log-writer";
import { MAX_RECORDED_ROOTS, openRunDirectoryRoot, RUN_DIRECTORY_PATH_BUDGET, RUN_DIRECTORY_RECORD, RUN_DIRECTORY_ROOT_MARKER, unavailableRunDirectories, type RunDirectoryRootOptions } from "./index";
import { ProcessGroups } from "./process-group-fixture";

/** Order of directory synchronizations and record publications; the real calls still run. */
const storage = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/server/private-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/private-storage")>();
  return {
    ...actual,
    syncDirectory: (path: string) => { storage.calls.push(`sync:${path}`); actual.syncDirectory(path); },
    durableJson: (path: string, value: unknown) => { storage.calls.push(`record:${JSON.stringify(value)}`); actual.durableJson(path, value); },
  };
});

const IGNORED_COPY = "run-directory-root.ignored.json";
const RECORD_MAX_BYTES = 64 * 1024;
const groups = new ProcessGroups();
const scratch: string[] = [];

/** Restores owner access a test removed anywhere below `path`, without following links. */
function restoreAccess(path: string): void {
  let stats: Stats;
  try { stats = lstatSync(path); } catch { return; }
  if (!stats.isDirectory()) return;
  try { chmodSync(path, 0o700); } catch { return; }
  for (const name of readdirSync(path)) restoreAccess(join(path, name));
}

afterEach(async () => {
  storage.calls.splice(0);
  expect(await groups.stopAll()).toEqual([]);
  for (const directory of scratch.splice(0)) {
    restoreAccess(directory);
    rmSync(directory, { recursive: true, force: true });
    expect(existsSync(directory)).toBe(false);
  }
});

interface RecordedRoot { path: string; token: string; bootId?: string | null; runs?: { name: string; processGroupId: number | null }[] }

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
  const open = (stateDirectory = state, options: Partial<RunDirectoryRootOptions> = {}) => openRunDirectoryRoot({ stateDirectory, temporaryDirectory: temporary, logs, ...options });
  const outsideIntact = () => {
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(readFileSync(join(outside, "nested", "keep.txt"), "utf8")).toBe("keep");
  };
  const record = (stateDirectory = state) => JSON.parse(readFileSync(join(stateDirectory, RUN_DIRECTORY_RECORD), "utf8")) as { version: number; roots: Required<RecordedRoot>[] };
  /** Writes a current-format record; entries default to an unknown boot and no bound runs. */
  const writeRecord = (roots: RecordedRoot[], stateDirectory = state) => writeFileSync(join(stateDirectory, RUN_DIRECTORY_RECORD),
    JSON.stringify({ version: 3, roots: roots.map(entry => ({ bootId: null, runs: [], ...entry })) }));
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
    expect(record()).toMatchObject({ version: 3, roots: [{ path: root.path, runs: [] }] });
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
    const leftOver = crashed.create();
    const escape = crashed.create();
    writeFileSync(join(leftOver, "left-over"), "x");
    symlinkSync(outside, join(escape, "escape"));
    // Their test processes have exited, so the sweep may remove both run directories.
    crashed.bind(leftOver, await groups.exited());
    crashed.bind(escape, await groups.exited());
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
    expect(logs.controller).toHaveBeenCalledWith("run_directory.record_ignored", { error: "record_version_unsupported", copy: join(state, IGNORED_COPY) });
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
    expect(record().roots).toEqual(leaked.map(entry => ({ ...entry, bootId: null, runs: [] })));
    expect(logs.controller).toHaveBeenCalledWith("run_directory.record_full", {
      record: join(state, RUN_DIRECTORY_RECORD), entries: MAX_RECORDED_ROOTS + 1, entryLimit: MAX_RECORDED_ROOTS, bytes: expect.any(Number), byteLimit: RECORD_MAX_BYTES,
    });
    // After the operator removes one leaked directory, its entry is dropped and a root is created.
    rmSync(leaked[0]!.path, { recursive: true });
    const root = await open();
    expect(record().roots.map(entry => entry.path)).toEqual([...leaked.slice(1).map(entry => entry.path), root.path]);
    await root.close();
  });

  it("restores the marker with its token when the final removal of a root fails", async () => {
    const { open, temporary, record } = fixture();
    const root = await open();
    const token = readFileSync(marker(root.path), "utf8");
    writeFileSync(join(root.create(), "left-over"), "x");
    // The temporary parent lost write permission: the emptied root cannot be unlinked from it.
    chmodSync(temporary, 0o500);
    try {
      await expect(root.close()).rejects.toMatchObject({ code: "EACCES" });
    } finally { chmodSync(temporary, 0o700); }
    expect(readdirSync(root.path)).toEqual([RUN_DIRECTORY_ROOT_MARKER]);
    expect(readFileSync(marker(root.path), "utf8")).toBe(token);
    expect(mode(marker(root.path))).toBe(0o600);
    expect(record().roots.map(entry => entry.path)).toEqual([root.path]);
    // Still provably ours, so the next start removes it.
    const restarted = await open();
    expect(existsSync(root.path)).toBe(false);
    expect(record().roots.map(entry => entry.path)).toEqual([restarted.path]);
    await restarted.close();
  });

  it("drops a recorded path without the name prefix once it no longer exists", async () => {
    const { open, temporary, record, writeRecord, logs } = fixture();
    const gone = join(temporary, "gone-without-prefix");
    writeRecord([{ path: gone, token: newToken() }]);
    const root = await open();
    expect(logs.controller).toHaveBeenCalledWith("run_directory.previous_root_missing", { path: gone });
    expect(record().roots.map(entry => entry.path)).toEqual([root.path]);
    await root.close();
  });

  it("refuses to create or remove run directories once the live root's marker does not match", async () => {
    const { open } = fixture();
    const root = await open();
    const run = root.create();
    writeFileSync(join(run, "kept"), "x");
    const token = readFileSync(marker(root.path), "utf8");
    writeFileSync(marker(root.path), newToken());
    expect(() => root.create()).toThrow("marker_mismatch");
    await expect(root.remove(run)).rejects.toThrow("marker_mismatch");
    expect(existsSync(join(run, "kept"))).toBe(true);
    rmSync(marker(root.path));
    expect(() => root.create()).toThrow("marker_missing");
    await expect(root.remove(run)).rejects.toThrow("marker_missing");
    writeFileSync(marker(root.path), token, { mode: 0o600 });
    await root.remove(run);
    expect(existsSync(run)).toBe(false);
    await root.close();
  });

  it("synchronizes the marker's directory entries before the record names the root", async () => {
    const { open, temporary } = fixture();
    const root = await open();
    const published = storage.calls.findIndex(call => call.startsWith("record:") && call.includes(JSON.stringify(root.path)));
    expect(published).toBeGreaterThan(-1);
    for (const directory of [root.path, temporary]) {
      const synchronized = storage.calls.indexOf(`sync:${directory}`);
      expect(synchronized).toBeGreaterThan(-1);
      expect(synchronized).toBeLessThan(published);
    }
    await root.close();
  });

  it("keeps one private bounded copy of an ignored record and never uses it for deletion", async () => {
    const { open, state, logs } = fixture();
    const recordPath = join(state, RUN_DIRECTORY_RECORD);
    const copy = join(state, IGNORED_COPY);
    writeFileSync(recordPath, "{not json");
    const first = await open();
    expect(logs.controller).toHaveBeenCalledWith("run_directory.record_ignored", { error: expect.any(String), copy });
    expect(readFileSync(copy, "utf8")).toBe("{not json");
    expect(mode(copy)).toBe(0o600);
    await first.close();

    // Overwritten at the next ignored record, and never larger than a record may be.
    writeFileSync(recordPath, "x".repeat(RECORD_MAX_BYTES + 10));
    const second = await open();
    expect(statSync(copy).size).toBe(RECORD_MAX_BYTES);
    await second.close();

    // An earlier record shape naming a real root: copied, but nothing it names is removed.
    const crashed = await open();
    writeFileSync(join(crashed.create(), "left-over"), "x");
    const earlier = JSON.stringify({ version: 2, roots: [{ path: crashed.path, token: readFileSync(marker(crashed.path), "utf8") }] });
    writeFileSync(recordPath, earlier);
    const third = await open();
    expect(readFileSync(copy, "utf8")).toBe(earlier);
    const fourth = await open();
    expect(existsSync(join(crashed.path, "r1", "left-over"))).toBe(true);
    expect(existsSync(third.path)).toBe(false);
    await fourth.close();
  });

  it("reports entries and bytes against both limits when the record has no room for another root", async () => {
    const { open, state, record, writeRecord, logs } = fixture();
    const crashed = await open();
    const { token } = record().roots[0]!;
    // Run directories of unknown liveness fill the record almost to its byte limit.
    const runs: { name: string; processGroupId: null }[] = [];
    const size = () => Buffer.byteLength(JSON.stringify({ version: 3, roots: [{ path: crashed.path, token, bootId: null, runs }] }));
    for (let index = 1; size() < RECORD_MAX_BYTES - 100; index += 1) {
      const name = `r${index.toString(36)}`;
      mkdirSync(join(crashed.path, name));
      runs.push({ name, processGroupId: null });
    }
    writeRecord([{ path: crashed.path, token, runs }]);
    await expect(open()).rejects.toThrow("run_directory_record_full");
    const event = logs.controller.mock.calls.find(call => call[0] === "run_directory.record_full")?.[1] as Record<string, unknown>;
    expect(event).toEqual({ record: join(state, RUN_DIRECTORY_RECORD), entries: 2, entryLimit: MAX_RECORDED_ROOTS, bytes: expect.any(Number), byteLimit: RECORD_MAX_BYTES });
    expect(event.bytes).toBeGreaterThan(RECORD_MAX_BYTES);
    expect(record().roots).toEqual([{ path: crashed.path, token, bootId: null, runs }]);
  });

  it("stops removing a run directory at its deadline and keeps it and the marker", async () => {
    const { open } = fixture();
    let now = 0;
    let advancing = true;
    const root = await open(undefined, { clock: () => (advancing ? (now += 1_000) : now), removalDeadlineMs: 5_000 });
    const run = root.create();
    for (let index = 0; index < 50; index += 1) writeFileSync(join(run, `file-${index}`), "x");
    await expect(root.remove(run)).rejects.toMatchObject({ code: "run_directory_removal_deadline" });
    expect(existsSync(run)).toBe(true);
    expect(existsSync(marker(root.path))).toBe(true);
    advancing = false;
    await root.close();
    expect(existsSync(root.path)).toBe(false);
  });

  it("leaves roots that the startup budget does not reach recorded for a later start", async () => {
    const { base, open, state, record, writeRecord, logs } = fixture();
    const entries: Required<RecordedRoot>[] = [];
    for (let index = 0; index < 3; index += 1) {
      const other = join(base, `state-${index}`);
      mkdirSync(other, { mode: 0o700 });
      await open(other);
      entries.push(record(other).roots[0]!);
    }
    writeRecord(entries);
    let now = 0;
    // Removing a root takes longer than the whole startup budget.
    logs.controller.mockImplementation((event: string) => { if (event === "run_directory.previous_root_removed") now += 10_000; });
    const root = await open(state, { clock: () => now, sweepBudgetMs: 5_000 });
    expect(existsSync(entries[0]!.path)).toBe(false);
    for (const entry of entries.slice(1)) {
      expect(existsSync(entry.path)).toBe(true);
      expect(logs.controller).toHaveBeenCalledWith("run_directory.previous_root_skipped", { path: entry.path, reason: "sweep_budget_exhausted" });
    }
    expect(record().roots.map(entry => entry.path)).toEqual([entries[1]!.path, entries[2]!.path, root.path]);

    const next = await open();
    for (const entry of entries) expect(existsSync(entry.path)).toBe(false);
    expect(existsSync(root.path)).toBe(false);
    expect(record().roots.map(entry => entry.path)).toEqual([next.path]);
    await next.close();
  });

  it("keeps the bindings of entries a truncated listing did not examine", async () => {
    const { open, record, logs } = fixture();
    const crashed = await open();
    const gone = await groups.exited();
    const runs = [crashed.create(), crashed.create(), crashed.create()];
    for (const run of runs) crashed.bind(run, gone);
    // Two of the three quiescent run directories fit the listing; whichever one it leaves out stays on disk.
    await open(undefined, { rootListingLimit: 2 });
    const remaining = runs.filter(run => existsSync(run));
    expect(remaining).toHaveLength(1);
    expect(logs.controller).toHaveBeenCalledWith("run_directory.previous_root_retained", { path: crashed.path, reason: "listing_limit", kept: 0, removed: 2 });
    // The directory that is still there keeps the group id that proves it quiescent.
    expect(record().roots.find(entry => entry.path === crashed.path)?.runs).toEqual([{ name: basename(remaining[0]!), processGroupId: gone }]);

    // The next start, with room to list everything, finishes the job.
    const next = await open();
    expect(existsSync(crashed.path)).toBe(false);
    expect(record().roots.map(entry => entry.path)).toEqual([next.path]);
    await next.close();
  });

  it("stops at the deadline while removing top-level entries and keeps the remaining bindings", async () => {
    const { open, record, writeRecord, logs } = fixture();
    const crashed = await open();
    const gone = await groups.exited();
    const names = Array.from({ length: 20 }, (_, index) => `r${index + 1}`);
    // Top-level files: nothing but the sweep's own unlink calls spends time on them.
    for (const name of names) writeFileSync(join(crashed.path, name), "x");
    writeRecord([{ path: crashed.path, token: record().roots[0]!.token, runs: names.map(name => ({ name, processGroupId: gone })) }]);
    // One second passes for every entry that has been removed.
    let last = 0;
    const clock = () => {
      try { last = (names.length + 1 - readdirSync(crashed.path).length) * 1_000; } catch { /* the root is gone */ }
      return last;
    };
    await open(undefined, { clock, sweepBudgetMs: 5_000 });
    const remaining = names.filter(name => existsSync(join(crashed.path, name)));
    expect(remaining).toHaveLength(15);
    expect(existsSync(marker(crashed.path))).toBe(true);
    expect(record().roots.find(entry => entry.path === crashed.path)?.runs.map(run => run.name).sort()).toEqual([...remaining].sort());
    expect(logs.controller).toHaveBeenCalledWith("run_directory.previous_root_skipped", { path: crashed.path, reason: "sweep_budget_exhausted" });
    expect(logs.controller).toHaveBeenCalledWith("run_directory.sweep_budget_exhausted", { notReached: 1, budgetMs: 5_000 });
  });

  it("stops at the deadline while listing a root and keeps every binding", async () => {
    const { open, record, writeRecord, logs } = fixture();
    const crashed = await open();
    const gone = await groups.exited();
    const names = Array.from({ length: 200 }, (_, index) => `r${index + 1}`);
    for (const name of names) writeFileSync(join(crashed.path, name), "x");
    writeRecord([{ path: crashed.path, token: record().roots[0]!.token, runs: names.map(name => ({ name, processGroupId: gone })) }]);
    // Every reading of the clock costs one second, far more than the listing can afford.
    let now = 0;
    await open(undefined, { clock: () => (now += 1_000), sweepBudgetMs: 20_000 });
    expect(readdirSync(crashed.path)).toHaveLength(names.length + 1);
    expect(record().roots.find(entry => entry.path === crashed.path)?.runs).toHaveLength(names.length);
    expect(logs.controller).toHaveBeenCalledWith("run_directory.previous_root_skipped", { path: crashed.path, reason: "sweep_budget_exhausted" });
  });

  it("removes a bound run directory and drops its binding from the record", async () => {
    const { open, record } = fixture();
    const root = await open();
    const run = root.create();
    root.bind(run, await groups.exited());
    expect(record().roots[0]!.runs.map(entry => entry.name)).toEqual([basename(run)]);
    await root.remove(run);
    expect(record().roots[0]!.runs).toEqual([]);
    await root.close();
  });

  it("fails run creation when no root is available", async () => {
    const directories = unavailableRunDirectories();
    expect(() => directories.create()).toThrow("run_directory_unavailable");
    await expect(directories.close()).resolves.toBeUndefined();
  });
});
