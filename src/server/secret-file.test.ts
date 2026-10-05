import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadOrCreateSecret } from "./secret-file";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("loadOrCreateSecret", () => {
  it("creates one persistent owner-only secret", () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-secret-"));
    directories.push(directory);
    const path = join(directory, "nested", "token");
    const first = loadOrCreateSecret(path);
    expect(loadOrCreateSecret(path)).toBe(first);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
