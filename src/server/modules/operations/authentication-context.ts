import type { AccountId, AuthenticationMode, ListenerKind } from "@/shared/contracts/operations";
import { pathActorKind, resolveAcceptance, type AcceptedPath, type PresentedCredentials } from "./acceptance";
import { OperationError } from "./errors";

/** The four actor kinds. A worker is an installation (open/token) or an agent holding `executor`. */
export type Actor =
  | { kind: "installation" }
  | { kind: "operator"; via: "unix" | "offline" }
  | { kind: "human"; accountId: AccountId }
  | { kind: "agent"; accountId: AccountId };

/**
 * Current provider evidence for a human session, re-read on every revalidation.
 * Milliseconds since the epoch of the session's original authentication.
 */
export interface ProviderEvidence { authenticatedAt: number }

/** Server-issued coordination session (MCP session, bounded browser or CLI session). Never caller-supplied. */
export interface CoordinationSessionRef { id: string; generation: number; credentialId: string }

/** Identity and generation of the credential a context was minted from. */
export interface CredentialIdentity { path: AcceptedPath; credentialId: string; generation: number }

export interface VerifiedCredential {
  identity: CredentialIdentity;
  actor: Actor;
  evidence: ProviderEvidence | null;
  coordinationSession: CoordinationSessionRef | null;
}

/** Port to the credential stores. Implementations never substitute another credential or actor. */
export interface CredentialVerifier {
  /** Checks a presented secret for an accepted path. `null` when invalid. */
  verify(path: AcceptedPath, secret: string | null): VerifiedCredential | null;
  /** Current state of a previously verified credential. `null` when revoked, rotated, expired or unknown. */
  current(identity: CredentialIdentity): VerifiedCredential | null;
}

/** What one admitted phase may rely on. Obtained only through `revalidate`. */
export interface CurrentAuthority {
  actor: Actor;
  mode: AuthenticationMode;
  listener: ListenerKind;
  evidence: ProviderEvidence | null;
  coordinationSession: CoordinationSessionRef | null;
}

/**
 * Opaque, server-owned authentication of one request. Only a listener or
 * offline boundary can mint it. It is never serialized: `toJSON` throws, so a
 * projection that leaks it fails instead of releasing it.
 */
export interface AuthenticationContext {
  readonly mode: AuthenticationMode;
  readonly listener: ListenerKind;
  /** Re-reads the original credential. Throws `unauthenticated`; never falls back. */
  revalidate(): CurrentAuthority;
}

const minting = Symbol("authentication-context-minting");

function sameActor(left: Actor, right: Actor): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "operator" && right.kind === "operator") return left.via === right.via;
  if ((left.kind === "human" || left.kind === "agent") && (right.kind === "human" || right.kind === "agent")) return left.accountId === right.accountId;
  return true;
}

function sameIdentity(left: CredentialIdentity, right: CredentialIdentity): boolean {
  return left.path === right.path && left.credentialId === right.credentialId && left.generation === right.generation;
}

function sameSession(left: CoordinationSessionRef | null, right: CoordinationSessionRef | null): boolean {
  if (!left || !right) return left === right;
  return left.id === right.id && left.generation === right.generation && left.credentialId === right.credentialId;
}

function validVerification(path: AcceptedPath, verified: VerifiedCredential | null): verified is VerifiedCredential {
  if (!verified || verified.identity.path !== path || verified.actor.kind !== pathActorKind[path]) return false;
  if (path !== "provider_session" && verified.evidence !== null) return false;
  if (verified.evidence && !Number.isFinite(verified.evidence.authenticatedAt)) return false;
  // A coordination session is bound to the credential that opened it.
  if (verified.coordinationSession && verified.coordinationSession.credentialId !== verified.identity.credentialId) return false;
  return true;
}

class MintedAuthenticationContext implements AuthenticationContext {
  readonly #current: () => CurrentAuthority;
  constructor(token: symbol, readonly mode: AuthenticationMode, readonly listener: ListenerKind, current: () => CurrentAuthority) {
    if (token !== minting) throw new TypeError("Authentication contexts are minted only at listener boundaries.");
    this.#current = current;
    Object.freeze(this);
  }
  revalidate(): CurrentAuthority { return this.#current(); }
  toJSON(): never { throw new TypeError("An authentication context is never released."); }
}

const unauthenticated = (reason: string) => new OperationError("unauthenticated", reason);

export interface ListenerBoundary {
  readonly mode: AuthenticationMode;
  readonly listener: Exclude<ListenerKind, "offline">;
  /** Throws `unauthenticated` for a rejected combination or an invalid credential. */
  mint(presented: PresentedCredentials): AuthenticationContext;
}

/**
 * Bootstrap creates one boundary per listener with the mode active at start.
 * `open()` reports whether this listener is still serving (a closed unix
 * listener must not keep operator authority alive).
 */
export function createListenerBoundary(options: {
  mode: AuthenticationMode;
  listener: Exclude<ListenerKind, "offline">;
  verifier: CredentialVerifier;
  open: () => boolean;
}): ListenerBoundary {
  const { mode, listener, verifier, open } = options;
  return Object.freeze({
    mode, listener,
    mint(presented: PresentedCredentials): AuthenticationContext {
      const acceptance = resolveAcceptance(mode, listener, presented);
      if (!acceptance.accepted) throw unauthenticated(acceptance.reason);
      const { path } = acceptance;
      if (path === "operator_unix") {
        const current = (): CurrentAuthority => {
          if (!open()) throw unauthenticated("listener_closed");
          return { actor: { kind: "operator", via: "unix" }, mode, listener, evidence: null, coordinationSession: null };
        };
        current();
        return new MintedAuthenticationContext(minting, mode, listener, current);
      }
      const secret = path === "provider_session" ? presented.providerSession?.secret ?? null
        : path === "anonymous_installation" ? null : presented.bearers[0]?.secret ?? null;
      const verified = verifier.verify(path, secret);
      if (!validVerification(path, verified)) throw unauthenticated("invalid_credential");
      const { identity, actor, coordinationSession: session } = verified;
      const current = (): CurrentAuthority => {
        if (!open()) throw unauthenticated("listener_closed");
        const now = verifier.current(identity);
        if (!validVerification(path, now) || !sameIdentity(identity, now.identity) || !sameActor(actor, now.actor)) {
          throw unauthenticated("credential_no_longer_valid");
        }
        if (!sameSession(session, now.coordinationSession)) throw unauthenticated("coordination_session_changed");
        return { actor: now.actor, mode, listener, evidence: now.evidence, coordinationSession: now.coordinationSession };
      };
      return new MintedAuthenticationContext(minting, mode, listener, current);
    },
  });
}

/** An offline CLI invocation: operator authority only while the exclusive lock is held. */
export function mintOfflineContext(options: { mode: AuthenticationMode; lockHeld: () => boolean }): AuthenticationContext {
  const none: PresentedCredentials = { bearers: [], providerSession: null, legacySecret: false, browserHeaders: false };
  const acceptance = resolveAcceptance(options.mode, "offline", none, options.lockHeld());
  if (!acceptance.accepted) throw unauthenticated(acceptance.reason);
  const current = (): CurrentAuthority => {
    if (!options.lockHeld()) throw unauthenticated("offline_lock_not_held");
    return { actor: { kind: "operator", via: "offline" }, mode: options.mode, listener: "offline", evidence: null, coordinationSession: null };
  };
  return new MintedAuthenticationContext(minting, options.mode, "offline", current);
}

export function isFullAuthority(actor: Actor): boolean {
  return actor.kind === "installation" || actor.kind === "operator";
}
