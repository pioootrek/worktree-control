import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { isProviderCommandArgs, parseProviderArguments, providerCommandFromArgs, readProviderStdin } from "./auth-provider-input";
import { FileProviderConfiguration, decodeProviderJson } from "../server/authentication-provider-configuration";
import { parseProviderAdminCommand } from "../server/modules/authentication";
import { readPrivateBoundedFile } from "../server/private-storage";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "provider-input-")); roots.push(root);
  const entry = join(root, "provider.mjs"); writeFileSync(entry, "throw new Error('MUST_NOT_IMPORT_CONFIGURE');", { mode: 0o600 });
  const path = join(root, "authentication-provider.json"), file = new FileProviderConfiguration(path);
  const input = { module: entry, origin: "https://controller.test", signingSecret: { kind: "generate" as const } };
  return { root, entry, path, file, input };
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("protected provider input", () => {
  it.each([
    ["provider", "status", "--data-dir", "/tmp/a", "--data-dir", "/tmp/b"],
    ["provider", "status", "--state-dir", "/tmp/a", "--state-dir", "/tmp/b"],
    ["provider", "status", "--unknown"], ["provider", "configure"],
    ["provider", "configure", "--input-stdin", "--input-stdin"],
    ["provider", "configure", "--input-file", "--input-stdin"],
    ["provider", "configure", "--input-file", "/tmp/a", "--input-stdin"],
    ["provider", "owner", "create", "--principal-id", "chosen"],
    ["provider", "enroll", "--input-stdin"], ["provider", "status", "--input-stdin"],
    ["provider", "recover", "--principal-id", "p", "--input-stdin", "--role", "owner"],
    ["--data-dir", "/tmp/a", "--data-dir", "/tmp/b", "provider", "status"],
    ["--state-dir", "/tmp/a", "provider", "status", "--state-dir", "/tmp/b"],
  ])("rejects raw flags before reading sensitive bytes %j", (...args) => {
    expect(() => parseProviderArguments(args)).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });

  it("recognizes global paths before the provider family without dropping raw validation", () => {
    const args = ["--data-dir", "/private/data", "provider", "status", "--state-dir", "/private/state"];
    expect(isProviderCommandArgs(args)).toBe(true);
    expect(parseProviderArguments(args)).toMatchObject({ action: "status", dataDir: "/private/data", stateDir: "/private/state" });
    expect(isProviderCommandArgs(["mode", "set", "provider"])).toBe(false);
    expect(isProviderCommandArgs(["status", "--data-dir", "provider"])).toBe(false);
  });

  it("reads one bounded strict UTF-8 JSON value and rejects injected IPC authority", async () => {
    const input = { email: "owner@fixture.invalid", name: "Owner", password: "password-sentinel-123" };
    expect(await providerCommandFromArgs(["provider", "enroll", "--principal-id", "opaque-owner", "--input-stdin"],
      Readable.from([Buffer.from(JSON.stringify(input))]))).toEqual({ command: "auth-provider", action: "enroll", principalId: "opaque-owner", input });
    for (const bytes of [Buffer.from("{}{}"), Buffer.from([0xff]), Buffer.alloc(8193, 32)]) {
      expect(() => decodeProviderJson(bytes)).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    }
    for (const extra of ["actor", "role", "subject", "faultInjection", "credentialId", "mode"]) {
      expect(() => parseProviderAdminCommand({ command: "auth-provider", action: "enroll", principalId: "owner", input, [extra]: "sentinel" }))
        .toThrowError(expect.objectContaining({ code: "invalid_input" }));
    }
    const held = new PassThrough();
    await expect(readProviderStdin(held, 5)).rejects.toMatchObject({ code: "invalid_input" });
    expect(held.listenerCount("data")).toBe(0); held.destroy();
  });

  it("refuses terminal stdin before reading any sensitive bytes", async () => {
    let reads = 0;
    const terminal = Object.assign(new Readable({ read() { reads++; } }), { isTTY: true });
    try {
      await expect(providerCommandFromArgs(["provider", "enroll", "--principal-id", "owner", "--input-stdin"], terminal))
        .rejects.toMatchObject({ code: "invalid_input" });
      expect(reads).toBe(0);
      expect(terminal.listenerCount("data")).toBe(0);
      expect(terminal.readableFlowing).toBeNull();
    } finally { terminal.destroy(); }
  });

  it("refuses parent traversal that hides a symlink before private-file validation", async () => {
    const { root } = fixture();
    const privateRoot = join(root, "private"), otherRoot = join(root, "other");
    mkdirSync(privateRoot, { mode: 0o700 }); mkdirSync(otherRoot, { mode: 0o700 });
    mkdirSync(join(otherRoot, "dir"), { mode: 0o700 }); mkdirSync(join(otherRoot, ".git"));
    writeFileSync(join(privateRoot, "input.json"), "{}", { mode: 0o600 });
    writeFileSync(join(otherRoot, "input.json"), '{"newPassword":"sentinel-hidden-by-alias"}', { mode: 0o600 });
    symlinkSync(join(otherRoot, "dir"), join(privateRoot, "link"));
    const path = `${privateRoot}/link/../input.json`;
    expect(readFileSync(path, "utf8")).toContain("sentinel-hidden-by-alias");
    expect(() => readPrivateBoundedFile(path, 8192)).toThrow();
    await expect(providerCommandFromArgs(["provider", "recover", "--principal-id", "owner", "--input-file", path]))
      .rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses unsafe private files and never repairs their permissions", () => {
    const { root } = fixture(), path = join(root, "input.json");
    writeFileSync(path, "{}", { mode: 0o600 });
    expect(readPrivateBoundedFile(path, 8192).toString()).toBe("{}");
    chmodSync(path, 0o644); expect(() => readPrivateBoundedFile(path, 8192)).toThrow();
    chmodSync(path, 0o600); linkSync(path, join(root, "hardlink")); expect(() => readPrivateBoundedFile(path, 8192)).toThrow();
    const link = join(root, "link"); symlinkSync(path, link); expect(() => readPrivateBoundedFile(link, 8192)).toThrow();
    expect(() => readPrivateBoundedFile(root, 8192)).toThrow();
    const dir = join(root, "git"); mkdirSync(dir, { mode: 0o700 }); mkdirSync(join(dir, ".git"));
    const secret = join(dir, "secret"); writeFileSync(secret, "{}", { mode: 0o600 });
    expect(() => readPrivateBoundedFile(secret, 8192)).toThrow();
    const alias = join(root, "alias"); symlinkSync(dir, alias); expect(() => readPrivateBoundedFile(join(alias, "secret"), 8192)).toThrow();
  });

  it("configures without importing code, preserves material and refuses lost-material generation", () => {
    const f = fixture(); f.file.configure(f.input, false);
    const original = f.file.read()!;
    expect(Buffer.from(original.secret, "base64url")).toHaveLength(32);
    expect(() => f.file.configure(f.input, false)).toThrowError(expect.objectContaining({ code: "configuration_secret_preservation_required" }));
    f.file.configure({ ...f.input, origin: "https://other.test", signingSecret: { kind: "preserve" } }, true);
    expect(f.file.read()!.secret).toBe(original.secret);
    expect(() => f.file.configure({ ...f.input, signingSecret: { kind: "supplied", value: Buffer.alloc(32, 3).toString("base64url") } }, true)).toThrow();
    rmSync(f.path);
    expect(() => f.file.configure(f.input, true)).toThrowError(expect.objectContaining({ code: "configuration_restore_required" }));
    expect(f.file.read()).toBeNull();
  });

  it.each(["better-auth", "./relative.mjs", "https://remote.test/module", "file:///tmp/provider.mjs?secret=x", "file:///tmp/provider.mjs#fragment"])("refuses module %s", module => {
    const f = fixture(); expect(() => f.file.configure({ ...f.input, module }, false)).toThrow();
  });
  it.each(["http://controller.test", "https://user:password@controller.test", "https://controller.test/path", "https://controller.test/?x=y", "https://controller.test/#fragment"])("refuses origin %s", origin => {
    const f = fixture(); expect(() => f.file.configure({ ...f.input, origin }, false)).toThrow();
  });
  it.each(["a", "x".repeat(42), `${Buffer.alloc(32).toString("base64url")}=`, "+".repeat(43)])("refuses malformed supplied material %s", value => {
    const f = fixture(); expect(() => f.file.configure({ ...f.input, signingSecret: { kind: "supplied", value } }, false)).toThrow();
  });
  it("refuses an unsafe existing configuration instead of rotating or chmodding it", () => {
    const f = fixture(); f.file.configure(f.input, false); const before = readFileSync(f.path);
    chmodSync(f.path, 0o644);
    expect(() => f.file.configure({ ...f.input, signingSecret: { kind: "preserve" } }, false)).toThrow();
    expect(readFileSync(f.path)).toEqual(before);
  });
});
