import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SourceWatcher, type WatchFactory } from "./source-watcher";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tree() {
  const root = mkdtempSync(join(tmpdir(), "wtc-watch-")); roots.push(root);
  for (const directory of ["game/units", ".git/objects", ".godot/imported", "exports/web", "node_modules/x", "analysis-local"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "project.godot"), "");
  const outside = mkdtempSync(join(tmpdir(), "wtc-watch-outside-")); roots.push(outside);
  mkdirSync(join(outside, "deep"));
  symlinkSync(outside, join(root, "linked"));
  return root;
}
/** Records watched directories and lets the test emit events synchronously. */
function fakeWatch() {
  const listeners = new Map<string, (event: string, name: string | null) => void>();
  const closed: string[] = [];
  const factory: WatchFactory = (path, listener) => {
    listeners.set(path, listener as (event: string, name: string | null) => void);
    return { close: () => { closed.push(path); listeners.delete(path); }, on: () => undefined } as unknown as ReturnType<WatchFactory>;
  };
  return { factory, listeners, closed };
}

describe("Godot Web source watcher", () => {
  it("watches one directory at a time, skipping symlinks, .git/.godot/output and Git-ignored paths", async () => {
    const root = tree(), fake = fakeWatch();
    const watcher = new SourceWatcher({ root, paths: ["."], ignore: ["exports/web", "analysis-local"], debounceMs: 100, onChange: () => undefined, watch: fake.factory });
    await watcher.start();
    expect([...fake.listeners.keys()].map((path) => path.slice(root.length)).sort()).toEqual(["", "/exports", "/game", "/game/units"]);
    expect(watcher.state).toBe("watching");
    watcher.dispose();
    expect(fake.listeners.size).toBe(0);
    expect(watcher.state).toBe("stopped");
  });

  it("coalesces bursts into one debounced change and ignores generated or temporary files", async () => {
    vi.useFakeTimers();
    const root = tree(), fake = fakeWatch(), onChange = vi.fn();
    const watcher = new SourceWatcher({ root, paths: ["."], ignore: ["exports/web"], debounceMs: 200, maxWaitMs: 1_000, onChange, watch: fake.factory });
    await watcher.start();
    const emit = (directory: string, name: string) => fake.listeners.get(join(root, directory))!("change", name);
    emit("exports", "web"); emit("game", ".unit.gd.swp"); emit("game", "unit.gd~");
    await vi.advanceTimersByTimeAsync(500);
    expect(onChange).not.toHaveBeenCalled();
    for (let index = 0; index < 5; index += 1) { emit("game", "unit.gd"); await vi.advanceTimersByTimeAsync(100); }
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).toHaveBeenCalledTimes(1);
    // A continuous stream still yields a change once maxWait elapses.
    for (let index = 0; index < 12; index += 1) { emit("game/units", "tank.tscn"); await vi.advanceTimersByTimeAsync(100); }
    expect(onChange).toHaveBeenCalledTimes(2);
    watcher.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("limits configured files to their own names and caps the directory count", async () => {
    const root = tree(), fake = fakeWatch(), onChange = vi.fn(), states: string[] = [];
    const files = new SourceWatcher({ root, paths: ["project.godot"], ignore: [], debounceMs: 100, onChange, watch: fake.factory });
    await files.start();
    expect([...fake.listeners.keys()]).toEqual([root]);
    fake.listeners.get(root)!("change", "README.md");
    files.dispose();
    expect(onChange).not.toHaveBeenCalled();
    const limited = new SourceWatcher({ root, paths: ["."], ignore: [], debounceMs: 100, maxDirectories: 2, onChange, onState: (state) => states.push(state), watch: fakeWatch().factory });
    await limited.start();
    expect(limited.state).toBe("limit_exceeded");
    expect(limited.watchedDirectories).toBe(0);
    expect(states).toEqual(["limit_exceeded"]);
  });

  it("adds watchers for directories created later with real fs events", async () => {
    const root = tree(), onChange = vi.fn();
    const watcher = new SourceWatcher({ root, paths: ["game"], ignore: [], debounceMs: 50, onChange });
    await watcher.start();
    mkdirSync(join(root, "game/new"));
    await vi.waitFor(() => expect(watcher.watchedDirectories).toBe(3), { timeout: 2_000 });
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2_000 });
    onChange.mockClear();
    writeFileSync(join(root, "game/new/scene.tscn"), "x");
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    watcher.dispose();
  });
});
