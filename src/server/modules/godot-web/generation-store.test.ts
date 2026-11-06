import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GenerationOutputError, GenerationStore, GenerationSupersededError } from "./generation-store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temp(prefix: string) { const path = mkdtempSync(join(tmpdir(), prefix)); roots.push(path); return path; }
function exportDirectory(files: Record<string, string>) {
  const root = temp("wtc-export-"), output = join(root, "out");
  mkdirSync(output);
  for (const [name, content] of Object.entries(files)) { mkdirSync(join(output, name, ".."), { recursive: true }); writeFileSync(join(output, name), content); }
  return { root, output };
}
const meta = { runId: "run", head: "abc", dirty: true, worktreePath: "/worktree" };

describe("Godot Web generation store", () => {
  it("publishes only complete, allowlisted regular files and atomically repoints state", async () => {
    const store = new GenerationStore(temp("wtc-store-"));
    await store.initialize();
    const { root, output } = exportDirectory({ "index.html": "<html></html>", "index.wasm": "wasm", "index.pck": "pck", "index.js": "js", "sub/icon.png": "png", ".env": "SECRET=1", "notes.gd": "source", "build.json": "{}" });
    const secret = join(root, "secret.txt"); writeFileSync(secret, "outside");
    symlinkSync(secret, join(output, "linked.txt"));
    const { generation, skipped } = await store.publish(output, root, meta, "0123456789abcdef");
    expect(skipped).toBe(3); // dotfile, .gd source and symlink
    const served = join(store.publicDirectory, "generations", generation.id);
    expect(readdirSync(served).sort()).toEqual(["build.json", "index.html", "index.js", "index.pck", "index.wasm", "sub"]);
    expect(existsSync(join(served, ".env")) || existsSync(join(served, "linked.txt"))).toBe(false);
    expect(generation).toMatchObject({ runId: "run", head: "abc", dirty: true, files: 6, bytes: 27 });
    const state = JSON.parse(readFileSync(join(store.publicDirectory, "state.json"), "utf8"));
    expect(state).toMatchObject({ version: 1, generation: generation.id, worktreeKey: "0123456789abcdef", build: "idle" });
    expect(JSON.stringify(state)).not.toContain("/worktree");
    expect((await store.readMeta(generation.id))?.worktreePath).toBe("/worktree");
  });

  it("keeps the previous generation when an export output is incomplete, unsafe or too large", async () => {
    const store = new GenerationStore(temp("wtc-store-"), { maxFiles: 3, maxBytes: 100, maxDepth: 2, retain: 2 });
    await store.initialize();
    const good = exportDirectory({ "index.html": "ok" });
    const { generation } = await store.publish(good.output, good.root, meta, "0123456789abcdef");
    const failures = [
      exportDirectory({ "index.js": "no entry" }),
      exportDirectory({ "index.html": "x", "a.js": "1", "b.js": "2", "c.js": "3" }),
      exportDirectory({ "index.html": "x".repeat(200) }),
    ];
    for (const failure of failures) await expect(store.publish(failure.output, failure.root, meta, "0123456789abcdef")).rejects.toBeInstanceOf(GenerationOutputError);
    const outside = exportDirectory({ "index.html": "outside" });
    await expect(store.publish(outside.output, good.root, meta, "0123456789abcdef")).rejects.toThrow(/leaves its allowed directory/);
    const linkRoot = temp("wtc-link-"); symlinkSync(good.output, join(linkRoot, "out"));
    await expect(store.publish(join(linkRoot, "out"), linkRoot, meta, "0123456789abcdef")).rejects.toThrow(/real directory/);
    expect((await store.readState()).generation).toBe(generation.id);
    expect(readdirSync(join(store.root, "incoming"))).toEqual([]);
    expect(readdirSync(join(store.publicDirectory, "generations"))).toEqual([generation.id]);
  });

  it("does not repoint the served build when its session ended during the copy", async () => {
    const store = new GenerationStore(temp("wtc-store-"));
    await store.initialize();
    const good = exportDirectory({ "index.html": "ok" });
    const { generation } = await store.publish(good.output, good.root, meta, "0123456789abcdef");
    const late = exportDirectory({ "index.html": "late" });
    await expect(store.publish(late.output, late.root, meta, "0123456789abcdef", () => false)).rejects.toBeInstanceOf(GenerationSupersededError);
    expect((await store.readState()).generation).toBe(generation.id);
    expect(readdirSync(join(store.publicDirectory, "generations"))).toEqual([generation.id]);
  });

  it("retains the current generation plus bounded predecessors", async () => {
    const store = new GenerationStore(temp("wtc-store-"), { maxFiles: 10, maxBytes: 1000, maxDepth: 2, retain: 2 });
    await store.initialize();
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const output = exportDirectory({ "index.html": String(index) });
      ids.push((await store.publish(output.output, output.root, meta, "0123456789abcdef")).generation.id);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(readdirSync(join(store.publicDirectory, "generations")).sort()).toEqual(ids.slice(-2).sort());
    expect(await store.readMeta(ids[0])).toBeNull();
  });
});
