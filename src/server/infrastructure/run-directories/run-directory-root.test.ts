import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { nullLogWriter } from "@/server/log-writer";
import { openRunDirectoryRoot, RUN_DIRECTORY_PATH_BUDGET, RUN_DIRECTORY_RECORD, unavailableRunDirectories } from "./index";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    // Restore owner access a test removed so the fixture itself can be cleaned.
    try { chmodSync(directory, 0o700); } catch { /* already gone */ }
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
  const record = (stateDirectory = state) => JSON.parse(readFileSync(join(stateDirectory, RUN_DIRECTORY_RECORD), "utf8")) as { roots: string[] };
  return { base, state, temporary, outside, logs, open, outsideIntact, record };
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe("run directory root", () => {
  it("creates and records a private root and short private run directories directly inside it", async () => {
    const { open, temporary, record } = fixture();
    const root = await open();
    expect(dirname(root.path)).toBe(temporary);
    expect(mode(root.path)).toBe(0o700);
    expect(record().roots).toEqual([root.path]);
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
    expect(record().roots).toEqual([restarted.path]);
    expect(readdirSync(neighbour.path)).toHaveLength(1);
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
    expect(record(state).roots).toEqual([root.path, restarted.path]);
    expect(logs.controller).toHaveBeenCalledWith("run_directory.previous_root_cleanup_failed", { path: root.path, error: "not_a_directory" });
    await restarted.close();
    expect(record(state).roots).toEqual([root.path]);
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

  it("fails run creation when no root is available", async () => {
    const directories = unavailableRunDirectories();
    expect(() => directories.create()).toThrow("run_directory_unavailable");
    await expect(directories.close()).resolves.toBeUndefined();
  });
});
