import type { DevOwnerProof, DevVaultCommand } from "@/shared/contracts/dev-vault";
import { devOwnerSigningText } from "@/shared/contracts/dev-vault-signing";

/** Same bound as the CLI's external key-file read. */
export const OWNER_KEY_FILE_BYTES = 8192;

export type OwnerKeyError = "unsupported" | "too_large" | "not_private_key" | "encrypted" | "invalid";
export class OwnerKeyImportError extends Error {
  constructor(readonly reason: OwnerKeyError) { super(reason); }
}

/** WebCrypto is limited to secure contexts (HTTPS or loopback) and Ed25519 needs a current browser. */
export function ownerSigningAvailable(scope: { isSecureContext?: boolean; crypto?: Crypto } = globalThis): boolean {
  return scope.isSecureContext !== false && typeof scope.crypto?.subtle?.importKey === "function" && typeof scope.crypto.randomUUID === "function";
}

function pemBody(text: string): Uint8Array<ArrayBuffer> {
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text)) throw new OwnerKeyImportError("encrypted");
  const match = /^-----BEGIN PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END PRIVATE KEY-----\s*$/.exec(text.trim() + "\n");
  if (!match) throw new OwnerKeyImportError("not_private_key");
  const base64 = match[1].replace(/\s+/g, "");
  let binary: string;
  try { binary = atob(base64); } catch { throw new OwnerKeyImportError("invalid"); }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Imports an unencrypted PKCS#8 Ed25519 PEM as a non-extractable signing key. The decoded DER is
 * overwritten after import; the source text and engine copies cannot be reliably erased.
 */
export async function importOwnerSigningKey(text: string, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<CryptoKey> {
  if (new TextEncoder().encode(text).length > OWNER_KEY_FILE_BYTES) throw new OwnerKeyImportError("too_large");
  const der = pemBody(text);
  try {
    const key = await subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
    if (key.type !== "private" || key.extractable || key.algorithm.name !== "Ed25519") throw new OwnerKeyImportError("invalid");
    return key;
  } catch (error) {
    if (error instanceof OwnerKeyImportError) throw error;
    // NotSupportedError means the browser lacks Ed25519; other failures mean another key type or bad DER.
    throw new OwnerKeyImportError(error instanceof DOMException && error.name === "NotSupportedError" ? "unsupported" : "invalid");
  } finally {
    der.fill(0);
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Signs the exact canonical command for one owner session credential. */
export async function signOwnerCommand(
  key: CryptoKey,
  command: DevVaultCommand,
  actor: { principalId: string; credentialId: string },
  issuedAt: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<DevOwnerProof> {
  const message = new TextEncoder().encode(devOwnerSigningText(command, actor, issuedAt));
  const signature = new Uint8Array(await subtle.sign({ name: "Ed25519" }, key, message));
  return { issuedAt, signature: base64(signature) };
}
