import { createHash, timingSafeEqual } from "node:crypto";
import { accountId } from "@/shared/contracts/operations";
import { classifyBearer, type AcceptedPath } from "../acceptance";
import type { CredentialIdentity, CredentialVerifier, VerifiedCredential } from "../authentication-context";
import { isInstant, isText, isTokenId, isVerifierHash, settled } from "./credential-values";

/** Stored facts only. Structurally satisfied by StoredMachineCredential, with no infrastructure import. */
export interface AgentCredentialRecord {
  readonly id: string;
  readonly principalId: string;
  readonly kind: "owner_session" | "agent_token" | "worker_token";
  readonly verifierHash: string;
  readonly status: "active" | "revoked";
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly principal: { readonly id: string; readonly kind: "owner" | "human" | "agent" | "worker" | "installation"; readonly status: "active" | "revoked" };
}
/** Synchronous read on the store owner's admitted connection. No usage writer. */
export interface AgentCredentialReader { credential(id: string): AgentCredentialRecord | null }
export interface AgentTokenVerifierOptions { reader: AgentCredentialReader; now: () => number }

const DUMMY_HASH = Buffer.alloc(32);
const FINGERPRINT_VERSION = "wtc-agent-token-credential-v1";

/**
 * Only committed agent_token credentials belonging to active agent principals
 * authorize. verify hashes the entire wire token as the old hashToken does.
 * Every throw, thenable, malformed row or non-finite clock is no answer.
 *
 * current rechecks eligibility and returns the recomputed identity, even if
 * its fingerprint changed; the boundary compares it with the mint baseline.
 * Disabling either row ends authority immediately. Re-enabling with all
 * fingerprinted facts unchanged can validate that request-scoped context
 * again: it grants nothing the same secret could not grant by minting anew.
 * A same-ID secret replacement (no supported writer does this) changes the
 * fingerprint. Principals have no incarnation: deletion and recreation under
 * the same principal ID with the same facts is NOT detected.
 */
export class AgentTokenVerifier implements CredentialVerifier {
  readonly #reader: AgentCredentialReader;
  readonly #now: () => number;
  constructor(options: AgentTokenVerifierOptions) {
    if (typeof options?.reader?.credential !== "function" || typeof options?.now !== "function") throw new TypeError("Invalid agent token verifier options.");
    this.#reader = options.reader;
    this.#now = options.now;
  }

  verify(path: AcceptedPath, secret: string | null): VerifiedCredential | null {
    try {
      if (path !== "agent_token" || typeof secret !== "string" || classifyBearer(secret) !== "agent_token") return null;
      const id = secret.slice(4, 40);
      const row = this.#row(id);
      // A missing or malformed row still hashes and compares, using a fixed
      // equal-length dummy, before any eligibility decision.
      const expected = row ? Buffer.from(row.verifierHash, "hex") : DUMMY_HASH;
      const supplied = createHash("sha256").update(secret, "utf8").digest();
      const matches = expected.length === supplied.length && timingSafeEqual(expected, supplied);
      const now = settled(this.#now());
      return matches && row && this.#eligible(row, now) ? this.#answer(row) : null;
    } catch { return null; }
  }

  current(identity: CredentialIdentity): VerifiedCredential | null {
    try {
      if (typeof identity !== "object" || identity === null) return null;
      const { path, credentialId, generation } = identity;
      if (path !== "agent_token" || !isTokenId(credentialId) || !Number.isSafeInteger(generation)) return null;
      const row = this.#row(credentialId), now = settled(this.#now());
      return row && this.#eligible(row, now) ? this.#answer(row) : null;
    } catch { return null; }
  }

  /** Copy once before checking: a getter or retained mutable row cannot change the checked facts afterwards. */
  #row(credentialId: string): AgentCredentialRecord | null {
    const row = settled(this.#reader.credential(credentialId));
    if (typeof row !== "object" || row === null) return null;
    const { id, principalId, kind, verifierHash, status, expiresAt, createdAt, revokedAt, principal: rawPrincipal } = row;
    const principal = settled(rawPrincipal);
    if (typeof principal !== "object" || principal === null) return null;
    const { id: principalRowId, kind: principalKind, status: principalStatus } = principal;
    if (id !== credentialId || !isText(principalId) || principalRowId !== principalId || !isVerifierHash(verifierHash)
      || !["owner_session", "agent_token", "worker_token"].includes(kind) || !["active", "revoked"].includes(status)
      || !["owner", "human", "agent", "worker", "installation"].includes(principalKind) || !["active", "revoked"].includes(principalStatus)
      || !isInstant(createdAt) || (expiresAt !== null && !isInstant(expiresAt)) || (revokedAt !== null && !isInstant(revokedAt))) return null;
    return { id, principalId, kind, verifierHash, status, expiresAt, createdAt, revokedAt,
      principal: { id: principalRowId, kind: principalKind, status: principalStatus } };
  }

  #eligible(row: AgentCredentialRecord, now: number | null): boolean {
    return typeof now === "number" && Number.isFinite(now) && row.kind === "agent_token" && row.principal.kind === "agent"
      && row.status === "active" && row.revokedAt === null && row.principal.status === "active"
      && (row.expiresAt === null || Date.parse(row.expiresAt) > now);
  }

  /**
   * Versioned canonical encoding: UTF-8 JSON.stringify of this ordered array,
   * nulls preserved, no whitespace; SHA-256, first six digest bytes interpreted
   * as an unsigned big-endian integer (48 bits, always a safe integer).
   * Exactly these facts, never usage time, label or prefix.
   */
  #fingerprint(row: AgentCredentialRecord): number {
    return createHash("sha256").update(JSON.stringify([FINGERPRINT_VERSION,
      row.id, row.principalId, row.kind, row.verifierHash, row.status, row.expiresAt, row.createdAt, row.revokedAt,
      row.principal.id, row.principal.kind, row.principal.status]), "utf8").digest().readUIntBE(0, 6);
  }

  #answer(row: AgentCredentialRecord): VerifiedCredential {
    return { identity: { path: "agent_token", credentialId: row.id, generation: this.#fingerprint(row) },
      actor: { kind: "agent", accountId: accountId(row.principal.id) }, evidence: null, coordinationSession: null };
  }
}
