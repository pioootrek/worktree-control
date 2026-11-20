import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireControllerLock } from "./controller-lock";

vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>() }));

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

describe("ControllerLock.held bounded descriptor verification", () => {
  it("refuses a FIFO at the path without attempting a read", () => {
    const f = fixture(); unlinkSync(f.path); execFileSync("mkfifo", [f.path]);
    const read = vi.spyOn(fs, "readSync"), readFile = vi.spyOn(fs, "readFileSync");
    expect(f.lock.held()).toBe(false);
    expect(read).not.toHaveBeenCalled(); expect(readFile).not.toHaveBeenCalled();
  }, 10_000);

  it.each(["fifo", "directory"])("checks a %s swapped in at open before attempting a read", shape => {
    const f = fixture(), open = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementationOnce((path, flags, mode) => {
      renameSync(f.path, join(f.root, "original"));
      if (shape === "fifo") execFileSync("mkfifo", [f.path]);
      else mkdirSync(f.path, { mode: 0o700 });
      return open(path, flags, mode);
    });
    const read = vi.spyOn(fs, "readSync"), readFile = vi.spyOn(fs, "readFileSync");
    expect(f.lock.held()).toBe(false);
    expect(read).not.toHaveBeenCalled(); expect(readFile).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    rmSync(f.path, { recursive: true }); renameSync(join(f.root, "original"), f.path);
    refusesWithoutEffects(f);
  }, 10_000);

  it("refuses a record over 512 bytes before reading any bytes", () => {
    const f = fixture(); writeFileSync(f.path, f.original.padEnd(513, " "));
    const read = vi.spyOn(fs, "readSync"), readFile = vi.spyOn(fs, "readFileSync");
    expect(lstatSync(f.path).size).toBe(513);
    expect(f.lock.held()).toBe(false);
    expect(read).not.toHaveBeenCalled(); expect(readFile).not.toHaveBeenCalled();
    vi.restoreAllMocks(); writeFileSync(f.path, f.original); refusesWithoutEffects(f);
  }, 10_000);

  it("uses one read of at most 512 bytes even when the file grows during the read", () => {
    const f = fixture(), read = fs.readSync;
    const spy = vi.spyOn(fs, "readSync").mockImplementationOnce(((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      appendFileSync(f.path, " ".repeat(1024));
      return read(fd, buffer, offset, length, position);
    }) as typeof fs.readSync);
    const readFile = vi.spyOn(fs, "readFileSync");
    expect(f.lock.held()).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.any(Number), expect.any(Buffer), 0, 512, 0);
    expect(spy.mock.results[0].value).toBe(512);
    expect(readFile).not.toHaveBeenCalled();
    vi.restoreAllMocks(); writeFileSync(f.path, f.original); refusesWithoutEffects(f);
  }, 10_000);

  it.each(["different content of the same size", "identical content with changed mtime"])("refuses %s rewritten after the read, permanently", change => {
    const f = fixture(), read = fs.readSync, readFile = fs.readFileSync;
    // Make the timestamp difference deterministic without sleeps or filesystem-resolution assumptions.
    utimesSync(f.path, new Date("2000-01-01"), new Date("2000-01-01"));
    const before = lstatSync(f.path);
    const rewrite = () => {
      const other = JSON.parse(f.original);
      other.token = (other.token[0] === "a" ? "b" : "a") + other.token.slice(1);
      const replacement = change === "different content of the same size" ? `${JSON.stringify(other)}\n` : f.original;
      expect(Buffer.byteLength(replacement)).toBe(before.size);
      writeFileSync(f.path, replacement);
      utimesSync(f.path, before.atime, new Date("2001-01-01"));
    };
    const spy = vi.spyOn(fs, "readSync").mockImplementationOnce(((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      const size = read(fd, buffer, offset, length, position);
      rewrite();
      return size;
    }) as typeof fs.readSync);
    // Also inject into the old reader so this is a real rewrite regression test against that version.
    const fileSpy = vi.spyOn(fs, "readFileSync").mockImplementationOnce(((...args: Parameters<typeof fs.readFileSync>) => {
      const bytes = readFile(...args); rewrite(); return bytes;
    }) as typeof fs.readFileSync);
    expect(f.lock.held()).toBe(false);
    expect(spy.mock.calls.length + fileSpy.mock.calls.length).toBe(1);
    const after = lstatSync(f.path);
    expect({ ino: after.ino, size: after.size, mode: after.mode, nlink: after.nlink })
      .toEqual({ ino: before.ino, size: before.size, mode: before.mode, nlink: before.nlink });
    expect(after.mtimeMs).not.toBe(before.mtimeMs);
    vi.restoreAllMocks(); writeFileSync(f.path, f.original); refusesWithoutEffects(f);
  }, 10_000);

  it.for([0o4600, 0o2600, 0o1600])("refuses exact special mode %s without repairing it", { timeout: 10_000 }, (mode, context) => {
    const f = fixture();
    try { chmodSync(f.path, mode); }
    catch (error) {
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip(`Filesystem refused chmod to ${mode.toString(8)}: ${(error as NodeJS.ErrnoException).code}`); return;
      }
      throw error;
    }
    if ((lstatSync(f.path).mode & 0o7777) !== mode) {
      context.skip(`Filesystem did not retain special mode ${mode.toString(8)}`); return;
    }
    refusesWithoutEffects(f);
    chmodSync(f.path, 0o600); refusesWithoutEffects(f);
  });

  it.each(["EMFILE", "ENFILE", "EINTR"])("makes transient %s open failure sticky", code => {
    const f = fixture();
    vi.spyOn(fs, "openSync").mockImplementationOnce(() => { throw Object.assign(new Error(code), { code }); });
    expect(f.lock.held()).toBe(false);
    vi.restoreAllMocks(); refusesWithoutEffects(f);
  }, 10_000);

  it("makes a failing close sticky even after a successful read", () => {
    const f = fixture(), close = fs.closeSync;
    vi.spyOn(fs, "closeSync").mockImplementationOnce(fd => {
      close(fd); throw Object.assign(new Error("EINTR"), { code: "EINTR" });
    });
    expect(f.lock.held()).toBe(false);
    vi.restoreAllMocks(); refusesWithoutEffects(f);
  }, 10_000);

  it("keeps private-storage's UID fallback when process.getuid is unavailable", () => {
    const f = fixture();
    vi.stubGlobal("process", { ...process, getuid: undefined });
    try { expect(f.lock.held()).toBe(true); }
    finally { vi.unstubAllGlobals(); }
  }, 10_000);
});
