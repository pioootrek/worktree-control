import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireControllerLock } from "./controller-lock";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "controller-lock-held-")); roots.push(root);
  const path = join(root, "controller.lock"), lock = acquireControllerLock(path);
  return { root, path, lock, original: readFileSync(path, "utf8") };
}
function snapshot(path: string) {
  const stat = lstatSync(path);
  return { ino: stat.ino, dev: stat.dev, mode: stat.mode, uid: stat.uid, nlink: stat.nlink, size: stat.size,
    mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, bytes: stat.isFile() ? readFileSync(path, "utf8") : null };
}
function refusesWithoutEffects(f: ReturnType<typeof fixture>) {
  const before = snapshot(f.path);
  expect(() => expect(f.lock.held()).toBe(false)).not.toThrow();
  expect(f.lock.held()).toBe(false);
  expect(snapshot(f.path)).toEqual(before);
}

describe("ControllerLock.held real records", () => {
  it("is read-only while held and permanently false after release", () => {
    const f = fixture(), before = snapshot(f.path), release = vi.spyOn(f.lock, "release");
    expect(f.lock.held()).toBe(true); expect(f.lock.held()).toBe(true);
    expect(snapshot(f.path)).toEqual(before); expect(release).not.toHaveBeenCalled();
    f.lock.release(); expect(f.lock.held()).toBe(false); expect(existsSync(f.path)).toBe(false);
    writeFileSync(f.path, f.original, { mode: 0o600 });
    refusesWithoutEffects(f);
  }, 10_000);

  it("never repairs a missing record, and never recovers after observing its loss", () => {
    const f = fixture(); unlinkSync(f.path);
    expect(() => expect(f.lock.held()).toBe(false)).not.toThrow();
    expect(existsSync(f.path)).toBe(false);
    writeFileSync(f.path, f.original, { mode: 0o600 }); refusesWithoutEffects(f);
  }, 10_000);

  it.each(["pid", "token", "both"])("refuses a well-formed different owner (%s), even on the same inode", change => {
    const f = fixture(), other = JSON.parse(f.original);
    if (change !== "token") other.pid++;
    if (change !== "pid") other.token = "another-owner";
    writeFileSync(f.path, JSON.stringify(other)); refusesWithoutEffects(f);
    writeFileSync(f.path, f.original); refusesWithoutEffects(f);
  }, 10_000);

  it("refuses a byte-for-byte copied replacement before observing any missing interval", () => {
    const f = fixture(); renameSync(f.path, join(f.root, "old-record"));
    writeFileSync(f.path, f.original, { mode: 0o600 }); refusesWithoutEffects(f);
    unlinkSync(f.path); renameSync(join(f.root, "old-record"), f.path); refusesWithoutEffects(f);
  }, 10_000);

  it("cannot detect an unobserved byte-for-byte rewrite of the same inode", () => {
    // No ownership identity changed. This is an accidental-loss check, not a same-UID adversary fence.
    const f = fixture(); writeFileSync(f.path, "broken"); writeFileSync(f.path, f.original);
    expect(f.lock.held()).toBe(true);
  }, 10_000);

  it.each(["", "{", "null", "[]", "{}", '{"pid":0,"token":"x","startedAt":"now"}',
    '{"pid":1,"token":"","startedAt":"now"}', '{"pid":1,"token":"x"}'])("refuses malformed record %j without changing it", bytes => {
    const f = fixture(); writeFileSync(f.path, bytes); refusesWithoutEffects(f);
    writeFileSync(f.path, f.original); refusesWithoutEffects(f);
  }, 10_000);

  it.each([0o644, 0o660, 0o400, 0o700, 0o000])("refuses mode %s without permission repair", mode => {
    const f = fixture(); chmodSync(f.path, mode);
    const before = lstatSync(f.path);
    expect(() => expect(f.lock.held()).toBe(false)).not.toThrow();
    const after = lstatSync(f.path);
    expect({ mode: after.mode, ino: after.ino, ctimeMs: after.ctimeMs }).toEqual({ mode: before.mode, ino: before.ino, ctimeMs: before.ctimeMs });
    chmodSync(f.path, 0o600); refusesWithoutEffects(f);
  }, 10_000);

  it("refuses foreign ownership under the existing UID rule", () => {
    const f = fixture(), uid = process.getuid!();
    // An unprivileged test cannot chown; exercise the real metadata check with a different caller UID.
    const caller = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    refusesWithoutEffects(f); caller.mockRestore(); refusesWithoutEffects(f);
  }, 10_000);

  it.each(["directory", "symlink", "hardlink", "fifo"])("refuses unsafe %s without touching it", shape => {
    const f = fixture(), target = join(f.root, "target");
    if (shape === "hardlink") linkSync(f.path, target);
    else {
      renameSync(f.path, target);
      if (shape === "directory") mkdirSync(f.path, { mode: 0o700 });
      if (shape === "symlink") symlinkSync(target, f.path);
      if (shape === "fifo") execFileSync("mkfifo", [f.path]);
    }
    const release = vi.spyOn(f.lock, "release"); refusesWithoutEffects(f);
    expect(release).not.toHaveBeenCalled(); expect(readFileSync(target, "utf8")).toBe(f.original);
  }, 10_000);

  it("refuses a socket without touching or closing it", async () => {
    const f = fixture(); unlinkSync(f.path);
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(f.path, resolve); });
    try { refusesWithoutEffects(f); expect(server.listening).toBe(true); }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }, 10_000);
});
