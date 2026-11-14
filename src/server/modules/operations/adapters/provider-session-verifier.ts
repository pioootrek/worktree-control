import { createHash, randomBytes } from "node:crypto";
import {
  canonicalInstant, evaluateSessionAuthority,
  type ProviderSessionAuthority, type ProviderSessionState, type VerifiedProviderSession,
} from "@/server/modules/authentication";
import { accountId } from "@/shared/contracts/operations";
import type { AcceptedPath } from "../acceptance";
import type { CredentialIdentity, CredentialVerifier, VerifiedCredential } from "../authentication-context";
import { absorb, holds, isThenable } from "../synchronous";

/**
 * Committed provider session state, read synchronously on the controller's
 * owned connection. Structurally the `currentSession` of the provider storage
 * (`AuthenticationProviderStorage`); this adapter opens nothing itself.
 */
export interface ProviderSessionReader {
  currentSession(providerId: string, sessionId: string): ProviderSessionState | null;
}

export interface ProviderSessionVerifierOptions {
  /** The provider whose committed sessions this adapter reads. */
  providerId: string;
  reader: ProviderSessionReader;
  /** Milliseconds since the epoch. Synchronous; anything but a finite number refuses. */
  now: () => number;
  /** Staged sessions waiting for `verify`. Required, no default: a full registry refuses new ones. */
  stagedCapacity: number;
  /** How long a staged session may wait for `verify`. Required, no default. */
  stagedTtlMs: number;
  /**
   * Whether the provider may answer for its sessions at all right now: the
   * runtime is not disposed, supports session authority and its storage is
   * available. Required, no default. Called on every `stage`, `verify` and
   * `current`; only a synchronous `true` lets the call continue. A throw, a
   * thenable or any other value refuses. Never cached.
   */
  eligible: () => boolean;
}

/** A provider session the provider resolved, staged for one `verify`. Holds no cookie or token. */
interface StagedClaim { readonly sessionId: string; readonly subject: string; readonly createdAt: string; readonly method: string; readonly expires: number }

const PATH: AcceptedPath = "provider_session";
/** Session IDs longer than this are refused before any read, as the runtime's retained-session check does. */
const MAX_SESSION_ID = 512;
const FINGERPRINT_VERSION = "wtc-provider-session-credential-v1";

const isText = (value: unknown, max = Number.POSITIVE_INFINITY): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** A synchronous answer only: a thenable is absorbed and counts as no answer (decision W). */
function settled<T>(value: T): T | null {
  if (isThenable(value)) { absorb(value); return null; }
  return value;
}

interface Current { state: ProviderSessionState; authority: ProviderSessionAuthority; generation: number }

/**
 * The human half of the `CredentialVerifier` port: the `provider_session`
 * accepted path. Every other path answers `null`.
 *
 * The provider resolves its cookie asynchronously and outside this module. A
 * transport hands the resolved session to `stage`, which returns a one-use,
 * unguessable handle; the transport presents that handle as the provider
 * session secret. `verify` consumes it and, like the runtime's own
 * resolution, takes authority only from committed state: it re-reads the
 * session through the reader, decides through `evaluateSessionAuthority`, and
 * refuses when the staged claim (subject, creation time, method) disagrees
 * with it. A cookie, a session ID or any other string presented as the secret
 * is not a staged handle and verifies nothing.
 *
 * Every call first asks the injected `eligible` check. While it does not
 * answer `true`, `stage` refuses, `verify` consumes the handle and answers
 * `null`, and `current` answers `null`. Nothing is latched: once it answers
 * `true` again, `current` answers from committed state as before.
 *
 * `verify` and `current` are synchronous and never throw: a reader that
 * throws or returns a promise, a malformed state and a malformed clock all
 * answer `null`, without passing the thrown value on.
 */
export class ProviderSessionVerifier implements CredentialVerifier {
  readonly #providerId: string;
  readonly #reader: ProviderSessionReader;
  readonly #now: () => number;
  readonly #capacity: number;
  readonly #ttl: number;
  readonly #eligibleCheck: () => boolean;
  readonly #staged = new Map<string, StagedClaim>();

  constructor(options: ProviderSessionVerifierOptions) {
    const { providerId, reader, now, stagedCapacity, stagedTtlMs, eligible } = options ?? ({} as ProviderSessionVerifierOptions);
    if (!isText(providerId) || typeof reader?.currentSession !== "function" || typeof now !== "function" || !positive(stagedCapacity) || !positive(stagedTtlMs)
      || typeof eligible !== "function") {
      throw new TypeError("Invalid provider session verifier options.");
    }
    this.#providerId = providerId;
    this.#reader = reader;
    this.#now = now;
    this.#capacity = stagedCapacity;
    this.#ttl = stagedTtlMs;
    this.#eligibleCheck = eligible;
  }

  /** Number of staged handles not yet consumed or expired. */
  get staged(): number { return this.#staged.size; }

  /**
   * Stages a session the provider resolved for this request. Returns the
   * handle to present as the secret, or `null` for another provider, a
   * malformed claim, a broken clock, a full registry or while the provider
   * is not eligible. Copies the claim's
   * fields; nothing the caller keeps can change it afterwards.
   */
  stage(session: VerifiedProviderSession): string | null {
    try {
      if (!this.#eligible()) return null;
      const now = this.#clock();
      if (now === null || typeof session !== "object" || session === null) return null;
      const { providerId, sessionId, subject, createdAt } = session;
      const method = session.authentication?.method;
      if (providerId !== this.#providerId || !isText(sessionId, MAX_SESSION_ID) || !isText(subject) || !canonicalInstant(createdAt) || !isText(method)) return null;
      this.#prune(now);
      if (this.#staged.size >= this.#capacity) return null;
      const handle = randomBytes(32).toString("base64url");
      this.#staged.set(handle, Object.freeze({ sessionId, subject, createdAt, method, expires: now + this.#ttl }));
      return handle;
    } catch {
      return null;
    }
  }

  verify(path: AcceptedPath, secret: string | null): VerifiedCredential | null {
    try {
      const eligible = this.#eligible();
      if (path !== PATH || typeof secret !== "string") return null;
      const claim = this.#staged.get(secret);
      if (!claim) return null;
      // One use, whatever follows.
      this.#staged.delete(secret);
      if (!eligible) return null;
      const now = this.#clock();
      if (now === null || claim.expires <= now) return null;
      const current = this.#current(claim.sessionId, now);
      if (!current) return null;
      const { state, authority } = current;
      if (state.subject !== claim.subject || state.createdAt !== claim.createdAt || authority.authentication.method !== claim.method) return null;
      return this.#answer(claim.sessionId, current);
    } catch {
      return null;
    }
  }

  current(identity: CredentialIdentity): VerifiedCredential | null {
    try {
      if (!this.#eligible()) return null;
      if (typeof identity !== "object" || identity === null) return null;
      const { path, credentialId, generation } = identity;
      if (path !== PATH || !isText(credentialId, MAX_SESSION_ID) || !Number.isSafeInteger(generation)) return null;
      const now = this.#clock();
      if (now === null) return null;
      const current = this.#current(credentialId, now);
      // A changed fingerprint is another credential, not a newer state of this one.
      return current && current.generation === generation ? this.#answer(credentialId, current) : null;
    } catch {
      return null;
    }
  }

  /** Point in time, never cached. Only a synchronous `true`; a throw or a thenable (absorbed) is `false`. */
  #eligible(): boolean {
    try { return holds(this.#eligibleCheck()); } catch { return false; }
  }

  #clock(): number | null {
    const now = settled(this.#now());
    return typeof now === "number" && Number.isFinite(now) ? now : null;
  }

  #prune(now: number): void {
    for (const [handle, claim] of this.#staged) if (claim.expires <= now) this.#staged.delete(handle);
  }

  /**
   * Committed state of one session, if it authorizes now. `evaluateSessionAuthority`
   * is the rule; the further checks are the principal and evidence checks
   * the runtime's `#issueActor` makes. The runtime's eligibility checks are
   * the injected `eligible`, asked before this.
   */
  #current(sessionId: string, now: number): Current | null {
    const state = settled(this.#reader.currentSession(this.#providerId, sessionId));
    if (typeof state !== "object" || state === null) return null;
    const authority = evaluateSessionAuthority(state, new Date(now).toISOString());
    if (!authority) return null;
    const evidence = authority.evidence;
    if ((state.principalKind !== "owner" && state.principalKind !== "human") || !isText(state.principalId) || !canonicalInstant(state.mappingLinkedAt)
      || evidence.sessionId !== sessionId || evidence.subject !== state.subject || !Number.isFinite(Date.parse(evidence.authenticatedAt))) return null;
    return { state, authority, generation: this.#fingerprint(sessionId, state, authority) };
  }

  /**
   * The credential generation: 48 bits of a SHA-256 over every committed fact
   * the session's authority depends on. A refresh changes none of them; a
   * relinked mapping, another principal, a recreated row, other evidence, an
   * advanced account generation or policy revision, or a changed factor
   * binding changes it, so the boundary's baseline comparison refuses even if
   * the rule above did not.
   */
  #fingerprint(sessionId: string, state: ProviderSessionState, authority: ProviderSessionAuthority): number {
    const evidence = authority.evidence, account = state.account!;
    const text = JSON.stringify([FINGERPRINT_VERSION, this.#providerId, sessionId, state.subject, state.principalId, state.principalKind, state.mappingLinkedAt,
      state.createdAt, evidence.method, evidence.authenticatedAt, evidence.originalDeadline, evidence.generation, evidence.policyRevision,
      evidence.credential, evidence.credentialBinding, evidence.attemptId, account.generation, account.policyRevision, state.currentBinding]);
    return createHash("sha256").update(text, "utf8").digest().readUIntBE(0, 6);
  }

  /** A new object on every call; the boundary copies it again. The target has no owner sessions: both principal kinds are a human. */
  #answer(sessionId: string, current: Current): VerifiedCredential {
    return {
      identity: { path: PATH, credentialId: sessionId, generation: current.generation },
      actor: { kind: "human", accountId: accountId(current.state.principalId) },
      evidence: { authenticatedAt: Date.parse(current.authority.evidence.authenticatedAt) },
      coordinationSession: null,
    };
  }
}
