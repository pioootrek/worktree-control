import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Ed25519DevVaultOwnerVerifier, devOwnerSigningMessage } from "@/server/modules/dev-vault";
import type { AuthenticatedPrincipal } from "@/server/modules/identity";
import type { DevVaultCommand } from "@/shared/contracts/dev-vault";
import { canonicalJson, devOwnerSigningText } from "@/shared/contracts/dev-vault-signing";
import { importOwnerSigningKey, OwnerKeyImportError, ownerSigningAvailable, signOwnerCommand } from "./owner-signer";

const owner: AuthenticatedPrincipal = { principalId: "owner-principal", credentialId: "owner-credential", principalKind: "owner", authenticationMethod: "owner_session" };
const command = {
  projectId: "00000000-0000-4000-8000-000000000001", operationId: "00000000-0000-4000-8000-000000000002", environment: "DEV",
  operation: "import", dotenv: "FAKE_DEV_NAME=fake \"quoted\" ünïcode ☃ value\r\n# comment",
} as DevVaultCommand;
const pair = () => generateKeyPairSync("ed25519");
const pkcs8 = (keys: ReturnType<typeof pair>) => keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

describe("browser owner signer", () => {
  it("keeps the canonical signing bytes of the pre-extraction controller implementation", () => {
    // Golden text: recursive key sort, undefined omitted, arrays ordered, JSON string escaping.
    expect(canonicalJson({ b: [3, { z: 1, a: undefined, y: null }], a: "x\" ", c: true })).toBe("{\"a\":\"x\\\" \",\"b\":[3,{\"y\":null,\"z\":1}],\"c\":true}");
    expect(devOwnerSigningText(command, owner, "2026-10-27T12:00:00.000Z")).toBe(
      "{\"command\":{\"dotenv\":\"FAKE_DEV_NAME=fake \\\"quoted\\\" ünïcode ☃ value\\r\\n# comment\",\"environment\":\"DEV\",\"operation\":\"import\","
      + "\"operationId\":\"00000000-0000-4000-8000-000000000002\",\"projectId\":\"00000000-0000-4000-8000-000000000001\"},"
      + "\"context\":\"worktree-control-dev-vault-owner-v1\",\"credentialId\":\"owner-credential\",\"issuedAt\":\"2026-10-27T12:00:00.000Z\",\"principalId\":\"owner-principal\"}");
    expect(devOwnerSigningMessage(command, owner, "2026-10-27T12:00:00.000Z").equals(Buffer.from(devOwnerSigningText(command, owner, "2026-10-27T12:00:00.000Z"), "utf8"))).toBe(true);
  });

  it("produces byte-identical Ed25519 signatures to the CLI path and passes the controller verifier", async () => {
    const keys = pair();
    const key = await importOwnerSigningKey(pkcs8(keys));
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(["sign"]);
    await expect(crypto.subtle.exportKey("pkcs8", key)).rejects.toThrow();
    const issuedAt = "2026-10-27T12:00:00.000Z";
    const proof = await signOwnerCommand(key, command, owner, issuedAt);
    // Ed25519 is deterministic, so WebCrypto and node:crypto (CLI) must agree exactly.
    expect(proof.signature).toBe(sign(null, devOwnerSigningMessage(command, owner, issuedAt), keys.privateKey).toString("base64"));
    const verifier = new Ed25519DevVaultOwnerVerifier(() => keys.publicKey);
    expect(verifier.verify(command, owner, proof, "2026-10-27T12:00:30.000Z")).toBe(true);
    // Any change to the command, actor or time breaks the proof.
    expect(verifier.verify({ ...command, operationId: randomUUID() }, owner, proof, "2026-10-27T12:00:30.000Z")).toBe(false);
    expect(verifier.verify(command, { ...owner, credentialId: "other" }, proof, "2026-10-27T12:00:30.000Z")).toBe(false);
    expect(verifier.verify(command, owner, proof, "2026-10-27T12:01:01.000Z")).toBe(false);
    expect(verifier.verify(command, { ...owner, authenticationMethod: "installation_token" }, proof, "2026-10-27T12:00:30.000Z")).toBe(false);
    // A different owner key is rejected.
    expect(new Ed25519DevVaultOwnerVerifier(() => pair().publicKey).verify(command, owner, proof, "2026-10-27T12:00:30.000Z")).toBe(false);
  });

  it("refuses public, encrypted, non-Ed25519, malformed and oversized key files with fixed reasons", async () => {
    const keys = pair();
    const reason = async (text: string) => importOwnerSigningKey(text).then(() => "imported", (error: unknown) => error instanceof OwnerKeyImportError ? error.reason : "other");
    expect(await reason(keys.publicKey.export({ format: "pem", type: "spki" }).toString())).toBe("not_private_key");
    expect(await reason(keys.privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "fixture-only" }).toString())).toBe("encrypted");
    expect(await reason(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString())).toBe("invalid");
    expect(await reason("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n")).toBe("invalid");
    expect(await reason("FAKE_DEV_NAME=value")).toBe("not_private_key");
    expect(await reason(pkcs8(keys) + " ".repeat(9000))).toBe("too_large");
  });

  it("reports signing unavailable outside a secure context or without Web Crypto", () => {
    expect(ownerSigningAvailable({ isSecureContext: false, crypto: globalThis.crypto })).toBe(false);
    expect(ownerSigningAvailable({ isSecureContext: true })).toBe(false);
    expect(ownerSigningAvailable({ isSecureContext: true, crypto: globalThis.crypto })).toBe(true);
  });
});
