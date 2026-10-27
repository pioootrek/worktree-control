import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { DevVaultService } from "@/server/modules/dev-vault";
import { IdentityService } from "@/server/modules/identity";
import { vaultFixture } from "@/server/modules/dev-vault/test-fixture";
import { SqliteStateStore } from "./index";

const fixtures: ReturnType<typeof vaultFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
describe("vault SQLite atomicity and backup", () => {
  it("rejects stale state CAS so competing once consumers cannot both commit", () => {
    const f = vaultFixture(); fixtures.push(f);
    const first = f.store.devVault.load(f.project.id)!, second = f.store.devVault.load(f.project.id)!;
    expect(f.store.devVault.commit(f.project.id, first.version, first.ciphertext)).toBe(true);
    expect(f.store.devVault.commit(f.project.id, second.version, second.ciphertext)).toBe(false);
  });
  it("does not consume a once grant when the atomic commit fails", () => {
    const f = vaultFixture(); fixtures.push(f);
    const grant = f.approve(f.request("read"));
    const cmd = f.command({ operation: "read", ...f.imported, grantId: grant.id });
    const store = f.store.devVault;
    const unavailable = new DevVaultService({ load: p => store.load(p), projectExists: p => store.projectExists(p), commit: () => false },
      { key: () => f.key }, f.identity, f.verifier, () => f.now);
    expect(() => unavailable.execute({ command: cmd }, f.first.actor)).toThrow("vault_conflict");
    expect(f.execute(cmd, f.first.actor)).toMatchObject({ environment: { FAKE_DEV_KEY_NAME: "FAKE_DEV_ONLY_VALUE_987654321" } });
  });
  it("roundtrips encrypted state through full backup/restore without bundling a key or exposing metadata", async () => {
    const f = vaultFixture(); fixtures.push(f);
    const backup = join(f.root, "backup"), restoredPath = join(f.root, "restored.sqlite3");
    const grant = f.approve(f.request("read"), "until-revoked");
    const read = f.command({ operation: "read", ...f.imported, grantId: grant.id });
    f.execute(read, f.first.actor);
    const manifest = await createControllerBackup(f.store, backup, { applicationVersion: "test", attachmentDirectory: join(f.root, "attachments") });
    expect(manifest.database.schemaVersion).toBe(33);
    expect(readdirSync(backup).sort()).toEqual(["attachments", "manifest.json", "state.sqlite3"]);
    for (const file of ["state.sqlite3", "manifest.json"]) {
      const bytes = readFileSync(join(backup, file));
      for (const value of ["FAKE_DEV_KEY_NAME", "FAKE_DEV_ONLY_VALUE_987654321", f.key.toString("hex")]) expect(bytes.includes(Buffer.from(value))).toBe(false);
    }
    restoreControllerBackup(backup, restoredPath);
    const restored = new SqliteStateStore(restoredPath);
    try {
      expect(restored.devVault.load(f.project.id)).toEqual(f.store.devVault.load(f.project.id));
      const identity = new IdentityService(restored, () => f.now);
      const vault = new DevVaultService(restored.devVault, { key: () => f.key }, identity, f.verifier, () => f.now);
      const cmd = f.command({ operation: "read", ...f.imported });
      expect(vault.execute({ command: cmd, proof: f.proof(cmd) }, identity.authenticateBearer(f.ownerToken)).result)
        .toMatchObject({ environment: { FAKE_DEV_KEY_NAME: "FAKE_DEV_ONLY_VALUE_987654321" } });
      const wrong = new DevVaultService(restored.devVault, { key: () => Buffer.alloc(32) }, identity, f.verifier, () => f.now);
      expect(() => wrong.execute({ command: cmd, proof: f.proof(cmd) }, f.owner)).toThrow("vault_unavailable");
    } finally { restored.close(); }
  });
});
