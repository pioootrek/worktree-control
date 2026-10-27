import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExternalFileDevVaultKeyProvider, readExternalVaultFile } from "./index";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() { const root = mkdtempSync(join(tmpdir(), "external-vault-key-")); roots.push(root); return root; }
describe("external vault key files", () => {
  it("requires an explicit private external regular file and never generates a missing key", () => {
    const root = setup(), data = join(root, "data"), path = join(root, "fake-key"); mkdirSync(data);
    for (const value of [undefined, "relative", join(root, "missing"), data]) {
      expect(() => new ExternalFileDevVaultKeyProvider(value, [data]).key()).toThrow("vault_unavailable");
    }
    writeFileSync(path, randomBytes(32), { mode: 0o600 });
    expect(new ExternalFileDevVaultKeyProvider(path, [data]).key()).toHaveLength(32);
    chmodSync(path, 0o644);
    expect(() => new ExternalFileDevVaultKeyProvider(path, [data]).key()).toThrow("vault_unavailable");
    chmodSync(path, 0o600);
    symlinkSync(path, join(root, "link"));
    expect(() => new ExternalFileDevVaultKeyProvider(join(root, "link"), [data]).key()).toThrow("vault_unavailable");
    writeFileSync(join(data, "fake-key"), randomBytes(32), { mode: 0o600 });
    expect(() => new ExternalFileDevVaultKeyProvider(join(data, "fake-key"), [data]).key()).toThrow("vault_unavailable");
  });
  it("refuses key replacement and deletion during a controller lifetime", () => {
    const root = setup(), path = join(root, "fake-key"); writeFileSync(path, randomBytes(32), { mode: 0o600 });
    const provider = new ExternalFileDevVaultKeyProvider(path, []); provider.key();
    writeFileSync(path, randomBytes(32)); expect(() => provider.key()).toThrow("vault_unavailable");
    rmSync(path); expect(() => provider.key()).toThrow("vault_unavailable");
  });
  it("rejects symlink aliases of data roots and keys inside a Git checkout", () => {
    const root = setup(), data = join(root, "data"), alias = join(root, "data-alias");
    mkdirSync(data); symlinkSync(data, alias);
    const path = join(data, "fake-key"); writeFileSync(path, randomBytes(32), { mode: 0o600 });
    expect(() => new ExternalFileDevVaultKeyProvider(path, [alias]).key()).toThrow("vault_unavailable");
    mkdirSync(join(root, ".git"));
    expect(() => new ExternalFileDevVaultKeyProvider(path, []).key()).toThrow("vault_unavailable");
  });
  it("bounds public/signing files and sanitizes filenames from errors", () => {
    const root = setup(), path = join(root, "FAKE_FILE_NAME_SECRET");
    expect(() => readExternalVaultFile(path, [], false, 8192)).toThrow(/^vault_unavailable$/);
    writeFileSync(path, Buffer.alloc(8193), { mode: 0o600 });
    expect(() => readExternalVaultFile(path, [], false, 8192)).toThrow(/^vault_unavailable$/);
  });
});
