import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
