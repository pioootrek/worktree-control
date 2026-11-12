import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { removeOwnedTree } from "./owned-tree-removal";

/** Fault injection for the asynchronous calls removal makes; every hook defaults to the real call. */
const control = vi.hoisted(() => ({
  unlinkDelayMs: 0,
  failUnlink: null as null | ((path: string) => boolean),
  lstatDelayMs: null as null | ((path: string) => number),
  failLstat: null as null | ((path: string) => boolean),
  afterRmdir: null as null | ((path: string) => void),
  unlinksInFlight: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const injected = (code: string) => Object.assign(new Error(`injected ${code}`), { code });
  return {
    ...actual,
    unlink: async (path: string) => {
      control.unlinksInFlight += 1;
      try {
        await delay(control.unlinkDelayMs);
        if (control.failUnlink?.(String(path))) throw injected("EBUSY");
        return await actual.unlink(path);
      } finally { control.unlinksInFlight -= 1; }
    },
    lstat: async (path: string, ...rest: unknown[]) => {
      const ms = control.lstatDelayMs?.(String(path)) ?? 0;
      if (ms) await delay(ms);
      if (control.failLstat?.(String(path))) throw injected("EIO");
      return (actual.lstat as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    },
    rmdir: async (path: string) => {
      await actual.rmdir(path);
      control.afterRmdir?.(String(path));
    },
  };
});

const scratch: string[] = [];
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

beforeEach(() => { process.on("unhandledRejection", onUnhandled); });

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  unhandled.splice(0);
  Object.assign(control, { unlinkDelayMs: 0, failUnlink: null, lstatDelayMs: null, failLstat: null, afterRmdir: null, unlinksInFlight: 0 });
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
    expect(existsSync(directory)).toBe(false);
  }
});

/**
 * A directory listed as: subdirectory, a few files, subdirectory. Whatever the
 * file system's listing order, at least one file precedes a subdirectory, so
 * an unlink is still pending while removal awaits that subdirectory's `lstat`.
 */
function tree() {
  const base = mkdtempSync(join(tmpdir(), "wtc-owned-tree-test-"));
  scratch.push(base);
  const target = join(base, "target");
  mkdirSync(target);
  mkdirSync(join(target, "d-first"));
  writeFileSync(join(target, "d-first", "inner"), "x");
  for (let index = 0; index < 5; index += 1) writeFileSync(join(target, `f-${index}`), "x");
  mkdirSync(join(target, "d-last"));
  writeFileSync(join(target, "d-last", "inner"), "x");
  return target;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 100));

describe("owned tree removal failures", () => {
  it("reports an unlink failure through the returned promise while traversal awaits another call", async () => {
    const target = tree();
    control.unlinkDelayMs = 1;
    control.failUnlink = path => basename(path).startsWith("f-");
    control.lstatDelayMs = path => (basename(path).startsWith("d-") ? 30 : 0);
    await expect(removeOwnedTree(target, lstatSync(target))).rejects.toMatchObject({ code: "EBUSY" });
    await settle();
    expect(unhandled).toEqual([]);
    expect(control.unlinksInFlight).toBe(0);
  });

  it("drains pending unlinks before a traversal error propagates", async () => {
    const target = tree();
    control.unlinkDelayMs = 60;
    control.failUnlink = path => basename(path).startsWith("f-");
    control.lstatDelayMs = path => (basename(path).startsWith("d-") ? 10 : 0);
    // The second subdirectory is reached after the files, whose unlinks are then still in flight.
    let directories = 0;
    control.failLstat = path => basename(path).startsWith("d-") && ++directories === 2;
    let inFlightAtRejection = -1;
    await expect(removeOwnedTree(target, lstatSync(target)).catch((error: unknown) => {
      inFlightAtRejection = control.unlinksInFlight;
      throw error;
    })).rejects.toBeTruthy();
    expect(inFlightAtRejection).toBe(0);
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("keeps the entry named last when removal fails before it", async () => {
    const target = tree();
    writeFileSync(join(target, "keep-last"), "token");
    control.failUnlink = path => basename(path) === "f-0";
    await expect(removeOwnedTree(target, lstatSync(target), { last: "keep-last" })).rejects.toMatchObject({ code: "EBUSY" });
    expect(existsSync(join(target, "keep-last"))).toBe(true);
    control.failUnlink = null;
    await removeOwnedTree(target, lstatSync(target), { last: "keep-last" });
    expect(existsSync(target)).toBe(false);
    expect(unhandled).toEqual([]);
  });

  it("rejects at its deadline while a producer keeps recreating a directory, after settling every unlink", async () => {
    const target = tree();
    writeFileSync(join(target, "keep-last"), "token");
    const again = join(target, "again");
    mkdirSync(again);
    writeFileSync(join(again, "file"), "x");
    // Every removal of `again` is followed at once by a new one; bounded so a missing deadline cannot hang the suite.
    let recreated = 0;
    control.afterRmdir = path => {
      if (path !== again || recreated >= 2_000) return;
      recreated += 1;
      mkdirSync(again);
      writeFileSync(join(again, "file"), "x");
    };
    control.unlinkDelayMs = 1;
    let now = 0;
    const deadline = { now: () => (now += 1), expiresAt: 400 };
    let inFlightAtRejection = -1;
    await expect(removeOwnedTree(target, lstatSync(target), { last: "keep-last", deadline }).catch((error: unknown) => {
      inFlightAtRejection = control.unlinksInFlight;
      throw error;
    })).rejects.toMatchObject({ code: "run_directory_removal_deadline" });
    expect(recreated).toBeGreaterThan(0);
    expect(recreated).toBeLessThan(2_000);
    expect(inFlightAtRejection).toBe(0);
    expect(existsSync(join(target, "keep-last"))).toBe(true);
    await settle();
    expect(unhandled).toEqual([]);
    control.afterRmdir = null;
    await removeOwnedTree(target, lstatSync(target), { last: "keep-last" });
    expect(existsSync(target)).toBe(false);
  });

  it("rejects at its deadline inside a large flat directory without unlinking past it", async () => {
    const target = tree();
    for (let index = 0; index < 500; index += 1) writeFileSync(join(target, `g-${index}`), "");
    let now = 0;
    const deadline = { now: () => (now += 1), expiresAt: 50 };
    await expect(removeOwnedTree(target, lstatSync(target), { deadline })).rejects.toMatchObject({ code: "run_directory_removal_deadline" });
    expect(control.unlinksInFlight).toBe(0);
    expect(readdirSync(target).length).toBeGreaterThan(300);
  });
});
