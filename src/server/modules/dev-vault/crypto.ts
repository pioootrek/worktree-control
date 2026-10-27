import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { canonicalJson } from "@/shared/contracts/dev-vault-signing";
import { DevVaultError, type DevVaultKeyProvider } from "./contracts";

/** Canonical JSON for signatures and encrypted idempotency comparisons, never a value hash. */
export { canonicalJson };

export class DevVaultCipher {
  constructor(private readonly provider: DevVaultKeyProvider) {}
  assertAvailable(): void { this.key(); }
  private key(): Buffer {
    try {
      const key = this.provider.key();
      if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error();
      return key;
    } catch { throw new DevVaultError("vault_unavailable"); }
  }
  seal(value: unknown, projectId: string, profileId: string, revision: number): string {
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key(), nonce);
      cipher.setAAD(Buffer.from(canonicalJson(["wtc-dev-vault-v1", projectId, profileId, revision])));
      const data = Buffer.concat([cipher.update(canonicalJson(value), "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString("base64");
    } catch { throw new DevVaultError("vault_unavailable"); }
  }
  open<T>(ciphertext: string, projectId: string, profileId: string, revision: number): T {
    try {
      const data = Buffer.from(ciphertext, "base64");
      if (data.length < 30 || data.toString("base64") !== ciphertext) throw new Error();
      const cipher = createDecipheriv("aes-256-gcm", this.key(), data.subarray(0, 12));
      cipher.setAAD(Buffer.from(canonicalJson(["wtc-dev-vault-v1", projectId, profileId, revision])));
      cipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8")) as T;
    } catch { throw new DevVaultError("vault_unavailable"); }
  }
}
