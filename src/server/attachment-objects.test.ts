import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidAttachmentObject, attachmentObjectPath, publishAttachmentObject } from "./attachment-objects";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(path => fs.rmSync(path, { recursive: true, force: true })); });
function fixture() {
  const parent = fs.mkdtempSync(join(tmpdir(), "durable-object-")); roots.push(parent);
  const root = join(parent, "attachments"), bytes = Buffer.from("immutable object");
  const object = { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  return { parent, root, bytes, object, path: join(root, object.sha256.slice(0, 2), object.sha256) };
}
function noStaging(root: string) { expect(fs.readdirSync(root, { recursive: true }).some(name => String(name).includes(".object-"))).toBe(false); }

describe("durable attachment objects", () => {
  it("publishes private bytes and reuses the same inode without another write", () => {
    const f = fixture(), mask = process.umask(0);
    try { publishAttachmentObject(f.root, f.object, f.bytes); } finally { process.umask(mask); }
    const inode = fs.statSync(f.path).ino, write = vi.spyOn(fs, "writeSync");
    publishAttachmentObject(f.root, f.object, f.bytes);
    expect(write).not.toHaveBeenCalled();
    expect(fs.statSync(f.path).ino).toBe(inode);
    expect(fs.statSync(f.path).nlink).toBe(1);
    expect(fs.statSync(f.path).mode & 0o777).toBe(0o600);
    for (const path of [f.root, dirname(f.path)]) expect(fs.statSync(path).mode & 0o777).toBe(0o700);
    noStaging(f.root);
  });

  it("retains legacy directory modes and accepts a canonical parent alias", () => {
    const f = fixture(), alias = join(f.parent, "alias"); fs.chmodSync(f.parent, 0o755);
    fs.symlinkSync(f.parent, alias, "dir");
    publishAttachmentObject(join(alias, "attachments"), f.object, f.bytes);
    expect(fs.readFileSync(f.path)).toEqual(f.bytes); expect(fs.statSync(f.parent).mode & 0o777).toBe(0o755);
  });

  it.each(["publish", "backup source"])("hardens owned legacy 0775 root/shard directories for %s", operation => {
    const f = fixture(); fs.mkdirSync(dirname(f.path), { recursive: true });
    fs.chmodSync(f.root, 0o775); fs.chmodSync(dirname(f.path), 0o775);
    fs.writeFileSync(f.path, f.bytes, { mode: 0o600 });
    const inode = fs.statSync(f.path).ino;
    if (operation === "publish") publishAttachmentObject(f.root, f.object, f.bytes);
    else expect(attachmentObjectPath(f.root, f.object)).toBe(f.path);
    for (const path of [f.root, dirname(f.path)]) expect(fs.statSync(path).mode & 0o777).toBe(0o700);
    expect(fs.statSync(f.path).ino).toBe(inode); expect(fs.readFileSync(f.path)).toEqual(f.bytes);
  });

  it("publishes and retries under an unreadable outer ancestor without syncing it", () => {
    const f = fixture(), data = join(f.parent, "data"), root = join(data, "attachments");
    fs.mkdirSync(data, { mode: 0o700 }); fs.chmodSync(f.parent, 0o111);
    try {
      expect(() => fs.readdirSync(f.parent)).toThrow(expect.objectContaining({ code: "EACCES" }));
      const open = vi.spyOn(fs, "openSync"), sync = fs.fsyncSync;
      vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
        if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("interrupted sync"), { code: "EIO" });
        sync(fd);
      });
      expect(() => publishAttachmentObject(root, f.object, f.bytes)).toThrow("interrupted sync");
      vi.mocked(fs.fsyncSync).mockImplementation(sync);
      const path = publishAttachmentObject(root, f.object, f.bytes);
      expect(fs.readFileSync(path)).toEqual(f.bytes);
      expect(attachmentObjectPath(root, f.object)).toBe(path);
      expect(open.mock.calls.some(([path]) => path === f.parent)).toBe(false);
    } finally { fs.chmodSync(f.parent, 0o700); }
  });

  it.each(["root", "shard"])("refuses a legacy %s symlink without hardening its target", location => {
    const f = fixture(), outside = join(f.parent, "outside");
    fs.mkdirSync(outside); fs.chmodSync(outside, 0o775);
    if (location === "shard") fs.mkdirSync(f.root, { mode: 0o700 });
    fs.symlinkSync(outside, location === "root" ? f.root : dirname(f.path), "dir");
    expect(() => publishAttachmentObject(f.root, f.object, f.bytes)).toThrow(InvalidAttachmentObject);
    expect(fs.statSync(outside).mode & 0o777).toBe(0o775);
  });

  it("never creates outer ancestors whose entries it cannot retain across retries", () => {
    const f = fixture();
    expect(() => publishAttachmentObject(join(f.parent, "missing", "attachments"), f.object, f.bytes)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(fs.existsSync(join(f.parent, "missing"))).toBe(false);
  });

  it("rejects a writable outer ancestor without changing its mode", () => {
    const f = fixture(); fs.chmodSync(f.parent, 0o775);
    expect(() => publishAttachmentObject(f.root, f.object, f.bytes)).toThrow(InvalidAttachmentObject);
    expect(fs.statSync(f.parent).mode & 0o777).toBe(0o775);
    expect(fs.existsSync(f.root)).toBe(false);
  });

  it("never hardens a foreign-owned legacy object directory", () => {
    const f = fixture(); fs.mkdirSync(f.root); fs.chmodSync(f.root, 0o775);
    const stat = fs.lstatSync, chmod = vi.spyOn(fs, "fchmodSync");
    vi.spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike) => {
      const info = stat(path);
      if (path === f.root) Object.defineProperty(info, "uid", { value: (process.getuid?.() ?? 0) + 1 });
      return info;
    }) as typeof fs.lstatSync);
    expect(() => publishAttachmentObject(f.root, f.object, f.bytes)).toThrow(InvalidAttachmentObject);
    expect(chmod).not.toHaveBeenCalled(); expect(fs.statSync(f.root).mode & 0o777).toBe(0o775);
  });

  it("synchronizes content before linking and every required directory before returning", () => {
    const f = fixture(), events: string[] = [], sync = fs.fsyncSync, link = fs.linkSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { events.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file"); sync(fd); });
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => { events.push("publish"); link(from, to); });
    publishAttachmentObject(f.root, f.object, f.bytes);
    expect(events.slice(0, 3)).toEqual(["file", "publish", "file"]);
    expect(events.slice(3).every(event => event === "directory")).toBe(true);
    expect(events.filter(event => event === "directory").length).toBeGreaterThanOrEqual(3);
  });

  it("handles a competing publisher between absence check and exclusive link", () => {
    const f = fixture(), link = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementationOnce((from, to) => {
      // A complete winner appears at exactly the contested boundary.
      publishAttachmentObject(f.root, f.object, f.bytes);
      link(from, to);
    });
    publishAttachmentObject(f.root, f.object, f.bytes);
    expect(fs.readFileSync(f.path)).toEqual(f.bytes);
    expect(fs.statSync(f.path).nlink).toBe(1); noStaging(f.root);
  });

  it.each(["bytes", "hash", "existing", "symlink"])("rejects conflicting %s without replacing an existing object", variant => {
    const f = fixture();
    if (variant === "bytes" || variant === "hash") {
      expect(() => publishAttachmentObject(f.root, { ...f.object, ...(variant === "bytes" ? { size: 1 } : { sha256: "0".repeat(64) }) }, f.bytes)).toThrow(InvalidAttachmentObject);
    } else {
      fs.mkdirSync(dirname(f.path), { recursive: true, mode: 0o700 });
      if (variant === "existing") fs.writeFileSync(f.path, "conflict", { mode: 0o600 });
      else { fs.writeFileSync(join(f.parent, "outside"), f.bytes); fs.symlinkSync(join(f.parent, "outside"), f.path); }
      const before = fs.lstatSync(f.path).ino;
      expect(() => publishAttachmentObject(f.root, f.object, f.bytes)).toThrow(InvalidAttachmentObject);
      expect(fs.lstatSync(f.path).ino).toBe(before);
    }
    noStaging(f.root);
  });

  it.each(["write:EIO", "write:ENOSPC", "write:EACCES", "file-sync:EIO", "file-sync:ENOSPC", "directory-sync:EIO", "directory-sync:EACCES", "publish:EACCES"])("propagates %s and allows a verified retry", fault => {
    const f = fixture(), [stage, code] = fault.split(":"), error = Object.assign(new Error("injected storage failure"), { code });
    if (stage === "write") vi.spyOn(fs, "writeSync").mockImplementationOnce(() => { throw error; });
    if (stage === "publish") vi.spyOn(fs, "linkSync").mockImplementationOnce(() => { throw error; });
    if (stage.endsWith("sync")) {
      const sync = fs.fsyncSync;
      vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
        if (fs.fstatSync(fd).isDirectory() === (stage === "directory-sync")) throw error;
        sync(fd);
      });
    }
    expect(() => publishAttachmentObject(f.root, f.object, f.bytes)).toThrow(error);
    expect(fs.existsSync(f.path)).toBe(stage === "directory-sync");
    noStaging(f.root); vi.restoreAllMocks();
    publishAttachmentObject(f.root, f.object, f.bytes);
    expect(fs.readFileSync(f.path)).toEqual(f.bytes); noStaging(f.root);
  });

  it("reports actual directory permission denial without publishing a file", () => {
    const f = fixture(); fs.mkdirSync(f.root, { recursive: true, mode: 0o700 }); fs.chmodSync(f.root, 0o500);
    try { expect(() => publishAttachmentObject(f.root, f.object, f.bytes)).toThrow(expect.objectContaining({ code: "EACCES" })); }
    finally { fs.chmodSync(f.root, 0o700); }
    expect(fs.existsSync(f.path)).toBe(false);
  });

  it("copies with bounded reads, handles short writes and rejects an invalid source", () => {
    const f = fixture(), source = join(f.parent, "source"); fs.writeFileSync(source, f.bytes, { mode: 0o600 });
    const write = fs.writeSync;
    const shortWrite = (fd: number, buffer: NodeJS.ArrayBufferView, offset = 0, length = buffer.byteLength) => write(fd, buffer, offset, Math.min(3, length));
    vi.spyOn(fs, "writeSync").mockImplementation(shortWrite as typeof fs.writeSync);
    publishAttachmentObject(f.root, f.object, { path: source });
    expect(fs.readFileSync(f.path)).toEqual(f.bytes);
    fs.writeFileSync(source, "wrong");
    expect(() => publishAttachmentObject(f.root, f.object, { path: source })).toThrow(InvalidAttachmentObject);
    expect(fs.readFileSync(f.path)).toEqual(f.bytes);
    expect(() => publishAttachmentObject(join(f.parent, "another"), f.object, { path: source })).toThrow(InvalidAttachmentObject);
  });
  it("deduplicates simultaneous publishers in separate processes without a lock map", async () => {
    const f = fixture(), worker = fileURLToPath(new URL("./infrastructure/sqlite/fixtures/object-publisher-worker.ts", import.meta.url));
    const children = [0, 1].map(() => fork(worker, [f.root], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] }));
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 5000);
    try {
      const messages = children.map(child => once(child, "message", { signal: abort.signal }));
      expect((await Promise.all(messages)).map(message => message[0])).toEqual([{ ready: true }, { ready: true }]);
      const published = children.map(child => once(child, "message", { signal: abort.signal }));
      const exited = children.map(child => once(child, "exit"));
      children.forEach(child => child.send({ publish: true }));
      expect((await Promise.all(published)).map(message => message[0])).toEqual([{ published: true }, { published: true }]);
      expect(await Promise.all(exited)).toEqual([[0, null], [0, null]]);
      const sha256 = createHash("sha256").update("two simultaneous publishers").digest("hex"), path = join(f.root, sha256.slice(0, 2), sha256);
      expect(fs.readFileSync(path, "utf8")).toBe("two simultaneous publishers"); expect(fs.statSync(path).nlink).toBe(1); noStaging(f.root);
    } finally {
      clearTimeout(timeout);
      for (const child of children) if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); await ended; }
    }
  });

});
