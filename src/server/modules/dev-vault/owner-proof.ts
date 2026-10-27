import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { AuthenticatedPrincipal } from "../identity";
import type { DevOwnerProof, DevVaultCommand } from "@/shared/contracts/dev-vault";
import type { DevVaultOwnerVerifier } from "./contracts";
import { devOwnerSigningText } from "@/shared/contracts/dev-vault-signing";

export function devOwnerSigningMessage(command: DevVaultCommand, actor: Pick<AuthenticatedPrincipal, "principalId" | "credentialId">, issuedAt: string): Buffer {
  return Buffer.from(devOwnerSigningText(command, actor, issuedAt), "utf8");
}
/** External public key, never a DB setting writable by installation authority. */
export class Ed25519DevVaultOwnerVerifier implements DevVaultOwnerVerifier {
  constructor(private readonly publicKey: () => KeyObject | string | Buffer) {}
  verify(command: DevVaultCommand, actor: AuthenticatedPrincipal, proof: DevOwnerProof | undefined, now: string): boolean {
    try {
      if (actor.principalKind !== "owner" || actor.authenticationMethod !== "owner_session" || !proof) return false;
      const age = Date.parse(now) - Date.parse(proof.issuedAt);
      if (!Number.isFinite(age) || age < 0 || age > 60_000) return false;
      const configured = this.publicKey();
      const key = typeof configured === "string" || Buffer.isBuffer(configured) ? createPublicKey(configured) : configured;
      return key.type === "public" && key.asymmetricKeyType === "ed25519"
        && verify(null, devOwnerSigningMessage(command, actor, proof.issuedAt), key, Buffer.from(proof.signature, "base64"));
    } catch { return false; }
  }
}
