import { createHash, timingSafeEqual } from "node:crypto";
import { classifyBearer, type AcceptedPath } from "../acceptance";
import type { CredentialIdentity, CredentialVerifier, VerifiedCredential } from "../authentication-context";
import { isInstallationTokenId, isInstant, isVerifierHash, settled } from "./credential-values";

/** Structural policy port on the store owner's admitted connection. No write or connection ownership. */
export interface InstallationPolicy {
  readonly mode: "legacy" | "open" | "token" | "better-auth";
  readonly generation: number;
  readonly token: { readonly id: string; readonly prefix: string; readonly verifierHash: string; readonly createdAt: string } | null;
}
export interface InstallationPolicyReader { getAuthenticationPolicy(): InstallationPolicy }
export interface InstallationVerifierOptions { reader: InstallationPolicyReader }

// Outside the 36-character lowercase hex/hyphen token-ID grammar. Also a
// different accepted path, so anonymous and token identities cannot collide.
const ANONYMOUS_CREDENTIAL_ID = "anonymous-installation";
const DUMMY_HASH = Buffer.alloc(32);
const FINGERPRINT_VERSION = "wtc-installation-credential-v1";

/**
 * Installation and anonymous halves. Reads the stored mode on every call,
 * rather than the old service's immutable controller boot mode. Identity is
 * token ID (or the fixed anonymous ID) and a versioned fingerprint of the mode,
 * authentication generation and, for tokens, all stored token facts. current
 * returns a fresh identity; the boundary compares it with the mint baseline.
 * A throw, thenable or malformed policy is no answer. No usage is written.
 */
export class InstallationVerifier implements CredentialVerifier {
  readonly #reader: InstallationPolicyReader;
  constructor(options: InstallationVerifierOptions) {
    if (typeof options?.reader?.getAuthenticationPolicy !== "function") throw new TypeError("Invalid installation verifier options.");
    this.#reader = options.reader;
  }

  verify(path: AcceptedPath, secret: string | null): VerifiedCredential | null {
    try {
      if (path !== "installation_token" && path !== "anonymous_installation") return null;
      const policy = this.#policy();
      if (!policy) return null;
      if (path === "anonymous_installation") return secret === null && policy.mode === "open" ? this.#answer(path, policy) : null;
      if (typeof secret !== "string") return null;
      const expected = policy.token ? Buffer.from(policy.token.verifierHash, "hex") : DUMMY_HASH;
      const supplied = createHash("sha256").update(secret, "utf8").digest();
      const matches = expected.length === supplied.length && timingSafeEqual(expected, supplied);
      return policy.mode === "token" && policy.token && classifyBearer(secret) === "installation_token"
        && secret.slice(4, 40) === policy.token.id && matches ? this.#answer(path, policy) : null;
    } catch { return null; }
  }

  current(identity: CredentialIdentity): VerifiedCredential | null {
    try {
      if (typeof identity !== "object" || identity === null) return null;
      const { path, credentialId, generation } = identity;
      if ((path !== "installation_token" && path !== "anonymous_installation") || !Number.isSafeInteger(generation)) return null;
      const policy = this.#policy();
      if (!policy) return null;
      if (path === "anonymous_installation") return policy.mode === "open" && credentialId === ANONYMOUS_CREDENTIAL_ID ? this.#answer(path, policy) : null;
      return policy.mode === "token" && policy.token?.id === credentialId ? this.#answer(path, policy) : null;
    } catch { return null; }
  }

  #policy(): InstallationPolicy | null {
    const row = settled(this.#reader.getAuthenticationPolicy());
    if (typeof row !== "object" || row === null) return null;
    const { mode, generation, token: rawToken } = row;
    if (!["legacy", "open", "token", "better-auth"].includes(mode) || !Number.isSafeInteger(generation) || generation < 0) return null;
    if (rawToken === null) return { mode, generation, token: null };
    const token = settled(rawToken);
    if (typeof token !== "object" || token === null) return null;
    const { id, prefix, verifierHash, createdAt } = token;
    if (!isInstallationTokenId(id) || prefix !== `wsi_${id}` || !isVerifierHash(verifierHash) || !isInstant(createdAt)) return null;
    return { mode, generation, token: { id, prefix, verifierHash, createdAt } };
  }

  /**
   * UTF-8 JSON.stringify of the ordered array below, without whitespace;
   * SHA-256, first six digest bytes as an unsigned big-endian integer.
   * Anonymous identities depend only on the mode and authentication generation.
   */
  #fingerprint(path: "installation_token" | "anonymous_installation", policy: InstallationPolicy): number {
    const facts = [FINGERPRINT_VERSION, policy.mode, policy.generation];
    if (path === "installation_token") {
      const token = policy.token!;
      facts.push(token.id, token.prefix, token.verifierHash, token.createdAt);
    }
    return createHash("sha256").update(JSON.stringify(facts), "utf8").digest().readUIntBE(0, 6);
  }

  #answer(path: "installation_token" | "anonymous_installation", policy: InstallationPolicy): VerifiedCredential {
    return { identity: { path, credentialId: path === "installation_token" ? policy.token!.id : ANONYMOUS_CREDENTIAL_ID, generation: this.#fingerprint(path, policy) },
      actor: { kind: "installation" }, evidence: null, coordinationSession: null };
  }
}
