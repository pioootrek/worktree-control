import * as fsPromises from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileLogWriter } from "./log-writer";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("FileLogWriter", () => {
  it("stores controller and project output in separate files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-logs-"));
    directories.push(directory);
    const logs = new FileLogWriter(directory);
    logs.controller("project.switch", { projectId: "project-1" });
    logs.project("project-1", "ready on port 3000");
    logs.openTest("run-1");
    logs.test("run-1", "3 tests passed");
    await logs.close();

    expect(readFileSync(join(directory, "controller.log"), "utf8")).toContain("project.switch");
    expect(readFileSync(join(directory, "projects", "project-1.log"), "utf8")).toContain("ready on port 3000");
    expect(readFileSync(join(directory, "tests", "run-1.log"), "utf8")).toContain("3 tests passed");
  });
});

it("flushes rotation before close and keeps the last output in order", async () => {
  const directory = mkdtempSync(join(tmpdir(), "switcher-log-rotation-"));
  directories.push(directory);
  const logs = new FileLogWriter(directory);
  logs.openTest("rotation");
  const largeLine = "x".repeat(1024 * 1024);
  for (let index = 0; index < 6; index += 1) logs.test("rotation", `${index}:${largeLine}`);
  logs.test("rotation", "last line");
  await logs.finishTest("rotation");
  await logs.finishTest("rotation");
  expect(readFileSync(join(directory, "tests", "rotation.log.1"), "utf8")).toContain(`3:${largeLine}`);
  const current = readFileSync(join(directory, "tests", "rotation.log"), "utf8");
  expect(current).toContain(`4:${largeLine}`);
  expect(current).toContain(`5:${largeLine}`);
  expect(current.endsWith("last line\n")).toBe(true);
  await logs.close();
});

it("surfaces write failures during finalization and releases the writer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "switcher-log-failure-"));
  directories.push(directory);
  const logs = new FileLogWriter(directory);
  mkdirSync(join(directory, "tests", "blocked.log"));
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    logs.openTest("blocked");
    logs.test("blocked", "cannot write");
    await expect(logs.finishTest("blocked")).rejects.toThrow();
    await expect(logs.finishTest("blocked")).resolves.toBeUndefined();
    logs.test("blocked", "late write");
    await logs.close();
    expect(errors).toHaveBeenCalledOnce();
  } finally {
    errors.mockRestore();
  }
});

it("prunes only owned regular UUID logs and protects retained, open, foreign and symlinked files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "switcher-log-prune-"));
  directories.push(directory);
  const logs = new FileLogWriter(directory);
  const expired = randomUUID();
  const retained = randomUUID();
  const active = randomUUID();
  const linked = randomUUID();
  const root = join(directory, "tests");
  for (const id of [expired, retained]) {
    writeFileSync(join(root, `${id}.log`), "output");
    writeFileSync(join(root, `${id}.log.1`), "rotated output");
  }
  writeFileSync(join(root, "foreign.log"), "foreign");
  writeFileSync(join(directory, "outside"), "outside");
  symlinkSync(join(directory, "outside"), join(root, `${linked}.log`));
  mkdirSync(join(root, `${randomUUID()}.log`));
  logs.openTest(active);
  logs.test(active, "active output");
  await Promise.all([logs.pruneTests((id) => id === retained), logs.pruneTests((id) => id === retained)]);
  expect(existsSync(join(root, `${expired}.log`))).toBe(false);
  expect(existsSync(join(root, `${expired}.log.1`))).toBe(false);
  expect(readFileSync(join(root, `${retained}.log`), "utf8")).toBe("output");
  expect(readFileSync(join(root, `${retained}.log.1`), "utf8")).toBe("rotated output");
  expect(readFileSync(join(root, "foreign.log"), "utf8")).toBe("foreign");
  expect(lstatSync(join(root, `${linked}.log`)).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(directory, "outside"), "utf8")).toBe("outside");
  await logs.finishTest(active);
  expect(readFileSync(join(root, `${active}.log`), "utf8")).toContain("active output");
  await logs.close();
});

it("refuses a symlinked test-log directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "switcher-log-root-"));
  directories.push(directory);
  mkdirSync(join(directory, "outside"));
  symlinkSync(join(directory, "outside"), join(directory, "tests"));
  expect(() => new FileLogWriter(directory)).toThrow("zwykłym katalogiem");
});

it("runs a prune requested between the final scan check and promise settlement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "switcher-log-prune-handoff-"));
  directories.push(directory);
  const logs = new FileLogWriter(directory);
  const id = randomUUID();
  const path = join(directory, "tests", `${id}.log`);
  writeFileSync(path, "expired output");
  let subsequent: Promise<void> | undefined;
  const scan = vi.spyOn(fsPromises, "opendir").mockImplementationOnce(async () => ({
    [Symbol.asyncIterator]() {
      return {
        next() {
          // The first microtask precedes the loop's done continuation; the
          // second lands after its final condition but before promise reactions.
          queueMicrotask(() => queueMicrotask(() => {
            subsequent = logs.pruneTests(() => false);
          }));
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  }) as Awaited<ReturnType<typeof fsPromises.opendir>>);
  try {
    await logs.pruneTests(() => true);
    await subsequent;
    expect(existsSync(path)).toBe(false);
    expect(scan).toHaveBeenCalledTimes(2);
  } finally {
    scan.mockRestore();
    await logs.close();
  }
});


it("batches burst output, drains lines arriving during a write and preserves close ordering", async () => {
  const directory = mkdtempSync(join(tmpdir(), "switcher-log-batch-"));
  directories.push(directory);
  const actualOpen = fsPromises.open;
  let writes = 0;
  let logs: FileLogWriter;
  const opened = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
    const file = await actualOpen(...args);
    if (String(args[0]).endsWith("burst.log")) {
      const actualWrite = file.writeFile.bind(file);
      vi.spyOn(file, "writeFile").mockImplementation(async (...writeArgs) => {
        writes++;
        if (writes === 1) logs.test("burst", "arrived during write");
        return actualWrite(...writeArgs);
      });
    }
    return file;
  });
  try {
    logs = new FileLogWriter(directory);
    logs.openTest("burst");
    for (let i = 0; i < 2000; i++) logs.test("burst", `line ${i} ${"x".repeat(100)}`);
    // Let the first disk write begin before finalization closes admission.
    await vi.waitFor(() => expect(writes).toBeGreaterThan(0));
    await logs.finishTest("burst");
    const lines = readFileSync(join(directory, "tests", "burst.log"), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2001);
    for (let i = 0; i < 2000; i++) expect(lines[i].slice(25)).toBe(`line ${i} ${"x".repeat(100)}`);
    expect(lines.at(-1)).toContain("arrived during write");
    expect(writes).toBeLessThan(10);
    await logs.close();
  } finally { opened.mockRestore(); }
});


it("rotates small batched lines without crossing the file byte limit or losing output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "switcher-log-batch-rotation-"));
  directories.push(directory);
  const logs = new FileLogWriter(directory);
  const path = join(directory, "tests", "boundary.log");
  const limit = 5 * 1024 * 1024;
  const prefix = `${"p".repeat(limit - 250 - 1)}\n`;
  writeFileSync(path, prefix);
  const expected = Array.from({ length: 20 }, (_, i) => `line ${i} ${"ą".repeat(40)}`);
  try {
    logs.openTest("boundary");
    for (const line of expected) logs.test("boundary", line);
    await logs.finishTest("boundary");
    const rotated = readFileSync(`${path}.1`);
    const current = readFileSync(path);
    expect(rotated.length).toBeLessThanOrEqual(limit);
    expect(current.length).toBeLessThanOrEqual(limit);
    expect(rotated.subarray(0, prefix.length).toString()).toBe(prefix);
    const beforeRotation = rotated.subarray(prefix.length).toString().trimEnd().split("\n");
    const afterRotation = current.toString().trimEnd().split("\n");
    expect(beforeRotation).toHaveLength(2);
    expect(afterRotation).toHaveLength(18);
    expect([...beforeRotation, ...afterRotation].map(line => line.slice(25))).toEqual(expected);
  } finally { await logs.close(); }
});
