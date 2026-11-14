import { authenticationModes, listenerKinds, type AccountId, type AuthenticationMode, type ListenerKind } from "@/shared/contracts/operations";
import { pathActorKind, resolveAcceptance, type AcceptedPath, type PresentedCredentials } from "./acceptance";
import { OperationError } from "./errors";
import { absorb, holds, isThenable } from "./synchronous";

/** The four actor kinds. A worker is an installation (open/token) or an agent holding `executor`. */
export type Actor =
  | { readonly kind: "installation" }
  | { readonly kind: "operator"; readonly via: "unix" | "offline" }
  | { readonly kind: "human"; readonly accountId: AccountId }
  | { readonly kind: "agent"; readonly accountId: AccountId };

/**
 * Current provider evidence for a human session, re-read on every revalidation.
 * Milliseconds since the epoch of the session's original authentication.
 */
export interface ProviderEvidence { readonly authenticatedAt: number }

/** Server-issued coordination session (MCP session, bounded browser or CLI session). Never caller-supplied. */
export interface CoordinationSessionRef { readonly id: string; readonly generation: number; readonly credentialId: string }

/** Identity and generation of the credential a context was minted from. */
export interface CredentialIdentity { readonly path: AcceptedPath; readonly credentialId: string; readonly generation: number }

export interface VerifiedCredential {
  identity: CredentialIdentity;
  actor: Actor;
  evidence: ProviderEvidence | null;
  coordinationSession: CoordinationSessionRef | null;
}

/**
 * Port to the credential stores. Implementations never substitute another
 * credential or actor. Whatever they return is copied before use, so an
 * implementation that keeps, mutates or shares the returned objects cannot
 * change a context's baseline.
 */
export interface CredentialVerifier {
  /** Checks a presented secret for an accepted path. `null` when invalid. */
  verify(path: AcceptedPath, secret: string | null): VerifiedCredential | null;
  /** Current state of a previously verified credential. `null` when revoked, rotated, expired or unknown. */
  current(identity: CredentialIdentity): VerifiedCredential | null;
}

/** What one admitted phase may rely on. Obtained only through revalidation; always a fresh, deeply frozen copy. */
export interface CurrentAuthority {
  readonly actor: Actor;
  readonly mode: AuthenticationMode;
  readonly listener: ListenerKind;
  readonly evidence: ProviderEvidence | null;
  readonly coordinationSession: CoordinationSessionRef | null;
}

/** Type-level brand only. There is no runtime symbol: membership is checked against a module-private registry. */
declare const mintedBrand: unique symbol;

/**
 * Opaque, server-owned authentication of one request. Only a listener or
 * offline boundary of this module can mint it. Consumers accept a context only
 * when it is registered in this module's private registry (`currentAuthority`);
 * an object of the same shape, a copy or a proxy is `unauthenticated`. It is
 * never serialized: `toJSON` throws.
 */
export interface AuthenticationContext {
  readonly mode: AuthenticationMode;
  readonly listener: ListenerKind;
  /** Re-reads the original credential. Throws `unauthenticated`; never falls back. */
  revalidate(): CurrentAuthority;
  readonly [mintedBrand]: true;
}

const unauthenticated = (reason: string) => new OperationError("unauthenticated", reason);

/** Module-private registry of minted contexts and their revalidation closures. Never exported. */
const minted = new WeakMap<object, () => CurrentAuthority>();

/**
 * The only way a consumer of this module obtains authority from a context.
 * Anything not minted here (including a structurally identical object) is
 * `unauthenticated`; the object's own `revalidate` is never called.
 */
export function currentAuthority(context: unknown): CurrentAuthority {
  const current = typeof context === "object" && context !== null ? minted.get(context) : undefined;
  if (!current) throw unauthenticated("unrecognized_context");
  return current();
}

/** Whether a value is a context minted by this module. */
export function isMintedContext(value: unknown): value is AuthenticationContext {
  return typeof value === "object" && value !== null && minted.has(value);
}

class MintedAuthenticationContext {
  readonly mode: AuthenticationMode;
  readonly listener: ListenerKind;
  constructor(mode: AuthenticationMode, listener: ListenerKind) {
    this.mode = mode;
    this.listener = listener;
  }
  revalidate(): CurrentAuthority { return currentAuthority(this); }
  toJSON(): never { throw new TypeError("An authentication context is never released."); }
}
Object.freeze(MintedAuthenticationContext.prototype);

function mint(mode: AuthenticationMode, listener: ListenerKind, current: () => CurrentAuthority): AuthenticationContext {
  const context = Object.freeze(new MintedAuthenticationContext(mode, listener));
  minted.set(context, current);
  return context as unknown as AuthenticationContext;
}

// Copies read every field once and keep only known fields, so getters, extra
// properties and later mutation of the verifier's objects cannot reach the baseline.
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isGeneration = (value: unknown): value is number => Number.isSafeInteger(value);

function copyActor(value: unknown): Actor | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  const kind = source.kind;
  if (kind === "installation") return Object.freeze({ kind });
  if (kind === "operator") {
    const via = source.via;
    return via === "unix" || via === "offline" ? Object.freeze({ kind, via }) : null;
  }
  if (kind === "human" || kind === "agent") {
    const accountId = source.accountId;
    return isString(accountId) ? Object.freeze({ kind, accountId: accountId as AccountId }) : null;
  }
  return null;
}

function copySession(value: unknown): CoordinationSessionRef | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === undefined) return undefined;
  const source = value as Record<string, unknown>;
  const id = source.id, generation = source.generation, credentialId = source.credentialId;
  if (!isString(id) || !isGeneration(generation) || !isString(credentialId)) return undefined;
  return Object.freeze({ id, generation, credentialId });
}

function copyEvidence(value: unknown): ProviderEvidence | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === undefined) return undefined;
  const authenticatedAt = (value as Record<string, unknown>).authenticatedAt;
  return typeof authenticatedAt === "number" && Number.isFinite(authenticatedAt) ? Object.freeze({ authenticatedAt }) : undefined;
}

function copyIdentity(value: unknown): CredentialIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  const path = source.path, credentialId = source.credentialId, generation = source.generation;
  if (typeof path !== "string" || !(path in pathActorKind) || !isString(credentialId) || !isGeneration(generation)) return null;
  return Object.freeze({ path: path as AcceptedPath, credentialId, generation });
}

interface Verified { identity: CredentialIdentity; actor: Actor; evidence: ProviderEvidence | null; session: CoordinationSessionRef | null }

/** Copies and validates one verifier answer for `path`. `null` when anything is malformed or does not fit the path. */
function copyVerification(path: AcceptedPath, value: VerifiedCredential | null): Verified | null {
  // A verifier is synchronous (decision W): a thenable answer is no answer, and its rejection is absorbed.
  if (isThenable(value)) { absorb(value); return null; }
  if (typeof value !== "object" || value === null) return null;
  const source = value as unknown as Record<string, unknown>;
  const identity = copyIdentity(source.identity);
  const actor = copyActor(source.actor);
  const evidence = copyEvidence(source.evidence);
  const session = copySession(source.coordinationSession);
  if (!identity || !actor || evidence === undefined || session === undefined) return null;
  if (identity.path !== path || actor.kind !== pathActorKind[path]) return null;
  if (path !== "provider_session" && evidence !== null) return null;
  // A coordination session is bound to the credential that opened it.
  if (session && session.credentialId !== identity.credentialId) return null;
  return { identity, actor, evidence, session };
}

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

function authority(actor: Actor, mode: AuthenticationMode, listener: ListenerKind, evidence: ProviderEvidence | null, session: CoordinationSessionRef | null): CurrentAuthority {
  // Fresh frozen copies on every call: a caller mutating or retaining one result affects nothing else.
  return Object.freeze({
    actor: copyActor(actor)!, mode, listener,
    evidence: evidence ? Object.freeze({ authenticatedAt: evidence.authenticatedAt }) : null,
    coordinationSession: session ? Object.freeze({ id: session.id, generation: session.generation, credentialId: session.credentialId }) : null,
  });
}

export interface ListenerBoundary {
  readonly mode: AuthenticationMode;
  readonly listener: Exclude<ListenerKind, "offline">;
  /** Throws `unauthenticated` for a rejected combination or an invalid credential. */
  mint(presented: PresentedCredentials): AuthenticationContext;
}

/**
 * Bootstrap creates one boundary per listener with the mode active at start.
 * `open()` reports whether this listener is still serving (a closed unix
 * listener must not keep operator authority alive). Only a synchronous `true`
 * means open; anything else, a promise included, is closed (decision W).
 */
export function createListenerBoundary(options: {
  mode: AuthenticationMode;
  listener: Exclude<ListenerKind, "offline">;
  verifier: CredentialVerifier;
  open: () => boolean;
}): ListenerBoundary {
  const { mode, listener, verifier, open } = options;
  if (!(authenticationModes as readonly string[]).includes(mode) || !(listenerKinds as readonly string[]).includes(listener) || listener === ("offline" as string)) {
    throw new TypeError("Invalid listener boundary.");
  }
  return Object.freeze({
    mode, listener,
    mint(presented: PresentedCredentials): AuthenticationContext {
      const acceptance = resolveAcceptance(mode, listener, presented);
      if (!acceptance.accepted) throw unauthenticated(acceptance.reason);
      const { path } = acceptance;
      if (path === "operator_unix") {
        const current = (): CurrentAuthority => {
          if (!holds(open())) throw unauthenticated("listener_closed");
          return authority({ kind: "operator", via: "unix" }, mode, listener, null, null);
        };
        current();
        return mint(mode, listener, current);
      }
      const secret = path === "provider_session" ? presented.providerSession?.secret ?? null
        : path === "anonymous_installation" ? null : presented.bearers[0]?.secret ?? null;
      // The baseline is a deep, frozen copy taken once at mint.
      const baseline = copyVerification(path, verifier.verify(path, secret));
      if (!baseline) throw unauthenticated("invalid_credential");
      const current = (): CurrentAuthority => {
        if (!holds(open())) throw unauthenticated("listener_closed");
        // The verifier receives its own copy of the identity, never the baseline object.
        const now = copyVerification(path, verifier.current({ ...baseline.identity }));
        if (!now || !sameIdentity(baseline.identity, now.identity) || !sameActor(baseline.actor, now.actor)) {
          throw unauthenticated("credential_no_longer_valid");
        }
        if (!sameSession(baseline.session, now.session)) throw unauthenticated("coordination_session_changed");
        return authority(baseline.actor, mode, listener, now.evidence, now.session);
      };
      return mint(mode, listener, current);
    },
  });
}

/** An offline CLI invocation: operator authority only while the exclusive lock is held. */
export function mintOfflineContext(options: { mode: AuthenticationMode; lockHeld: () => boolean }): AuthenticationContext {
  const { mode, lockHeld } = options;
  const none: PresentedCredentials = { bearers: [], providerSession: null, legacySecret: false, browserHeaders: false };
  // Only a synchronous `true` means the lock is held; a promise is not (decision W).
  const acceptance = resolveAcceptance(mode, "offline", none, holds(lockHeld()));
  if (!acceptance.accepted) throw unauthenticated(acceptance.reason);
  const current = (): CurrentAuthority => {
    if (!holds(lockHeld())) throw unauthenticated("offline_lock_not_held");
    return authority({ kind: "operator", via: "offline" }, mode, "offline", null, null);
  };
  return mint(mode, "offline", current);
}

export function isFullAuthority(actor: Actor): boolean {
  return actor.kind === "installation" || actor.kind === "operator";
}
