import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileProviderConfiguration } from "./authentication-provider-configuration";
import { readPrivateBoundedFile } from "./private-storage";

vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>() }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "provider-config-fault-")); roots.push(root);
  const entry = join(root, "module.mjs"); fs.writeFileSync(entry, "export {};", { mode: 0o600 });
  const path = join(root, "config.json"), config = new FileProviderConfiguration(path);
  const input = { module: entry, origin: "https://controller.test", signingSecret: { kind: "generate" as const } };
  return { root, entry, path, config, input };
}
describe("configuration publication and descriptor uncertainty", () => {
  it.each(["before-rename", "after-rename"] as const)("reports actual %s publication failure without claiming rollback or regenerating", stage => {
    const f = fixture();
    if (stage === "before-rename") vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("sentinel-disk-failure"); });
    else {
      const sync = fs.fsyncSync;
      vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { if (fs.fstatSync(fd).isDirectory()) throw new Error("sentinel-fsync"); sync(fd); });
    }
    expect(() => f.config.configure(f.input, false)).toThrowError(expect.objectContaining({ code: "configuration_write_unconfirmed" }));
    vi.restoreAllMocks();
    if (stage === "before-rename") { expect(f.config.read()).toBeNull(); expect(fs.readdirSync(f.root).filter(name => name.startsWith(".journal"))).toEqual([]); }
    else {
      const secret = f.config.read()!.secret;
      expect(() => f.config.configure(f.input, false)).toThrowError(expect.objectContaining({ code: "configuration_secret_preservation_required" }));
      expect(f.config.read()!.secret).toBe(secret);
      f.config.configure({ ...f.input, signingSecret: { kind: "preserve" } }, true);
      expect(f.config.read()!.secret).toBe(secret);
    }
  });

  it("refuses growing/replaced files and wrong UID without reading beyond the fixed allocation", () => {
    const f = fixture(), path = join(f.root, "input.json"); fs.writeFileSync(path, "{}", { mode: 0o600 });
    const read = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      fs.appendFileSync(path, " "); return read(fd, buffer, offset, length, position);
    }) as typeof fs.readSync);
    expect(() => readPrivateBoundedFile(path, 8192)).toThrow(); vi.restoreAllMocks();
    const stat = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => ({ ...stat(fd), uid: (process.getuid?.() ?? 0) + 1,
      isFile: () => true })) as typeof fs.fstatSync);
    expect(() => readPrivateBoundedFile(path, 8192)).toThrow();
  });
});
