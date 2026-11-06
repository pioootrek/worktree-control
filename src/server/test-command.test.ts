import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectTestCommandResolver } from "./test-command";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "worktree-control-tests-"));
  directories.push(directory);
  return directory;
}

describe("ProjectTestCommandResolver", () => {
  it("discovers finite Node.js verification scripts and preserves the package manager", () => {
    const directory = fixture();
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      packageManager: "pnpm@11.22.0",
      scripts: { test: "vitest run", "test:e2e": "playwright test", build: "ng build", watch: "ng build --watch", dev: "ng serve" },
    }));
    const resolver = new ProjectTestCommandResolver();

    expect(resolver.discover(directory).map(({ id }) => id)).toEqual(["node:test", "node:test:e2e", "node:build"]);
    expect(resolver.resolve(directory, "node:build")).toMatchObject({ executable: "pnpm", args: ["run", "build"], cwd: directory });
  });

  it("discovers Django and resolves the interpreter inside the exact worktree", () => {
    const directory = fixture();
    writeFileSync(join(directory, "manage.py"), "# fixture");
    mkdirSync(join(directory, ".venv", "bin"), { recursive: true });
    writeFileSync(join(directory, ".venv", "bin", "python"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(directory, ".venv", "bin", "python"), 0o755);
    const resolver = new ProjectTestCommandResolver();

    expect(resolver.discover(directory)).toEqual([
      { id: "django:test", name: "Django tests", adapter: "django", timeoutMs: 900_000 },
    ]);
    expect(resolver.resolve(directory, "django:test")).toMatchObject({
      executable: "./.venv/bin/python", args: ["manage.py", "test"], cwd: directory,
    });
  });

  it("rejects stale and unknown presets before spawning a process", () => {
    const directory = fixture();
    writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const resolver = new ProjectTestCommandResolver();
    expect(() => resolver.resolve(directory, "node:removed")).toThrow("nie istnieje");
    expect(() => resolver.resolve(directory, "shell:anything")).toThrow("adapter");
  });
});

describe("Godot public verification entrypoint", () => {
  it("defaults to the built-in finite script operations and revalidates removal", () => {
    const directory = fixture();
    writeFileSync(join(directory, "project.godot"), "config_version=5\n");
    const resolver = new ProjectTestCommandResolver();
    expect(resolver.discover(directory)).toEqual([]);
    mkdirSync(join(directory, "scripts"));
    writeFileSync(join(directory, "scripts/project.sh"), "# public project script\n");
    expect(resolver.discover(directory).map(p => [p.id, p.adapter])).toEqual([["godot:check", "godot"], ["godot:export-macos", "godot"]]);
    for (const name of ["check", "export-macos"]) {
      expect(resolver.resolve(directory, `godot:${name}`)).toMatchObject({ executable: "bash", args: ["scripts/project.sh", name], cwd: directory });
    }
    expect(() => resolver.resolve(directory, "godot:editor")).toThrow("nie istnieje");
    rmSync(join(directory, "scripts/project.sh"));
    expect(() => resolver.resolve(directory, "godot:check")).toThrow("nie istnieje");
  });

  it("does not follow project script symlinks outside the discovered worktree", async () => {
    const { symlinkSync } = await import("node:fs");
    const directory = fixture(), outside = fixture();
    writeFileSync(join(directory, "project.godot"), "fixture");
    writeFileSync(join(outside, "project.sh"), "exit 0\n");
    mkdirSync(join(directory, "scripts"));
    symlinkSync(join(outside, "project.sh"), join(directory, "scripts/project.sh"));
    expect(new ProjectTestCommandResolver().discover(directory)).toEqual([]);
  });
});

describe("Godot project preset manifest", () => {
  const manifestPath = "scripts/worktree-control-presets.json";
  const builtins = ["godot:check", "godot:export-macos"];
  const resolver = new ProjectTestCommandResolver();
  function project(): string {
    const directory = fixture();
    writeFileSync(join(directory, "project.godot"), "config_version=5\n");
    mkdirSync(join(directory, "scripts"));
    writeFileSync(join(directory, "scripts/project.sh"), "# public script\n");
    return directory;
  }
  function manifest(directory: string, presets: unknown): void {
    writeFileSync(join(directory, manifestPath), JSON.stringify({ version: 1, godot: { presets } }));
  }

  it("appends project names in order and resolves them through the public wrapper", () => {
    const directory = project();
    const names = ["suite-python", "suite-game", "suite-ai-decision", "suite-ai-runtime"];
    manifest(directory, names);
    expect(resolver.discover(directory).map(({ id }) => id)).toEqual([...builtins, ...names.map(name => `godot:${name}`)]);
    for (const name of names) {
      expect(resolver.resolve(directory, `godot:${name}`)).toEqual({
        preset: { id: `godot:${name}`, name, adapter: "godot", timeoutMs: 900_000 },
        executable: "bash", args: ["scripts/project.sh", name], cwd: directory,
      });
    }
  });

  it("accepts an empty list and revalidates a removed or malformed manifest at resolution", () => {
    const directory = project();
    manifest(directory, ["suite-game"]);
    resolver.discover(directory);
    manifest(directory, []);
    expect(resolver.discover(directory).map(({ id }) => id)).toEqual(builtins);
    expect(() => resolver.resolve(directory, "godot:suite-game")).toThrow("nie istnieje");
    writeFileSync(join(directory, manifestPath), "{");
    expect(() => resolver.resolve(directory, "godot:check")).toThrow("worktree-control-presets.json");
    rmSync(join(directory, manifestPath));
    expect(resolver.discover(directory).map(({ id }) => id)).toEqual(builtins);
  });

  it.each([
    "", "{", "null", "[]", "{}",
    JSON.stringify({ version: 2, godot: { presets: [] } }),
    JSON.stringify({ version: "1", godot: { presets: [] } }),
    JSON.stringify({ version: 1, godot: [] }),
    JSON.stringify({ version: 1, godot: { presets: [], timeoutMs: 1000 } }),
    JSON.stringify({ version: 1, godot: { presets: [] }, command: "sh" }),
  ])("rejects invalid JSON/schema without falling back to builtins: %s", (document) => {
    const directory = project();
    writeFileSync(join(directory, manifestPath), document);
    expect(() => resolver.discover(directory)).toThrow("worktree-control-presets.json");
  });

  it.each([
    null, "suite", {}, [null], [1], [""], ["check"], ["export-macos"], ["same", "same"],
    ["../escape"], ["suite;id"], ["suite\n"], ["a b"], ["--help"], ["Suite"], ["a_b"],
    ["a:b"], ["a".repeat(64)], Array.from({ length: 17 }, (_, i) => `suite-${i}`),
  ].map((names) => [names]))("rejects invalid preset lists: %j", (names) => {
    const directory = project();
    manifest(directory, names);
    expect(() => resolver.discover(directory)).toThrow("worktree-control-presets.json");
  });

  it("accepts the name/count/byte boundaries and rejects oversized files", () => {
    const directory = project();
    const names = ["a".repeat(63), ...Array.from({ length: 15 }, (_, i) => `suite-${i}`)];
    const document = JSON.stringify({ version: 1, godot: { presets: names } });
    writeFileSync(join(directory, manifestPath), document.padEnd(16 * 1024, " "));
    expect(resolver.discover(directory)).toHaveLength(18);
    writeFileSync(join(directory, manifestPath), document.padEnd(16 * 1024 + 1, " "));
    expect(() => resolver.discover(directory)).toThrow("worktree-control-presets.json");
  });

  it("rejects invalid UTF-8 instead of repairing the document", () => {
    const directory = project();
    writeFileSync(join(directory, manifestPath), Buffer.from([0xff, 0xfe]));
    expect(() => resolver.discover(directory)).toThrow("worktree-control-presets.json");
  });

  it("rejects directories and dangling or escaping manifest links", () => {
    const directory = project(), outside = fixture();
    const path = join(directory, manifestPath);
    mkdirSync(path);
    expect(() => resolver.discover(directory)).toThrow("worktree-control-presets.json");
    rmSync(path, { recursive: true });
    symlinkSync(join(directory, "missing.json"), path);
    expect(() => resolver.discover(directory)).toThrow("worktree-control-presets.json");
    rmSync(path);
    writeFileSync(join(outside, "manifest.json"), JSON.stringify({ version: 1, godot: { presets: [] } }));
    symlinkSync(join(outside, "manifest.json"), path);
    expect(() => resolver.discover(directory)).toThrow("worktree-control-presets.json");
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO without opening a blocking reader", () => {
    const directory = project();
    execFileSync("mkfifo", [join(directory, manifestPath)]);
    expect(() => resolver.discover(directory)).toThrow("worktree-control-presets.json");
  });

  it("accepts contained manifest links but rechecks replacement targets", () => {
    const directory = project();
    const path = join(directory, manifestPath);
    writeFileSync(join(directory, "presets.json"), JSON.stringify({ version: 1, godot: { presets: ["suite"] } }));
    symlinkSync(join(directory, "presets.json"), path);
    expect(resolver.resolve(directory, "godot:suite").args).toEqual(["scripts/project.sh", "suite"]);
    rmSync(join(directory, "presets.json"));
    expect(() => resolver.resolve(directory, "godot:suite")).toThrow("worktree-control-presets.json");
  });

  it("does not apply Godot manifests to Node or Django projects", () => {
    const directory = project();
    rmSync(join(directory, "project.godot"));
    writeFileSync(join(directory, manifestPath), "malformed");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { check: "tsc" } }));
    writeFileSync(join(directory, "manage.py"), "# django");
    expect(resolver.discover(directory).map(({ id }) => id)).toEqual(["node:check", "django:test"]);
  });
});
