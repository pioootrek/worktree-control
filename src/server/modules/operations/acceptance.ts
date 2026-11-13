import { authenticationModes, listenerKinds, type ActorKind, type AuthenticationMode, type ListenerKind } from "@/shared/contracts/operations";

/**
 * What an adapter observed on one request, classified but not yet verified.
 * Classification by format happens here once; nothing after acceptance looks
 * at a token prefix or credential kind again.
 */
export type BearerClass = "installation_token" | "agent_token" | "legacy_owner_token" | "legacy_worker_token" | "unrecognized";
export interface PresentedCredentials {
  /** Every bearer-like credential found (Authorization, token headers). */
  bearers: readonly { class: BearerClass; secret: string }[];
  /** A provider session cookie. */
  providerSession: { secret: string } | null;
  /** A legacy pairing or MCP secret header. */
  legacySecret: boolean;
  /** Cookie, Origin or Fetch-Metadata headers: a browser context. */
  browserHeaders: boolean;
}

export type CredentialClass = "none" | "provider_session" | "legacy_secret" | BearerClass;
export const credentialClasses: readonly CredentialClass[] = Object.freeze([
  "none", "installation_token", "agent_token", "provider_session",
  "legacy_owner_token", "legacy_worker_token", "legacy_secret", "unrecognized",
]);

/** How an accepted request was authenticated. Fixes the actor kind it may produce. */
export type AcceptedPath =
  | "anonymous_installation" | "installation_token" | "provider_session" | "agent_token"
  | "operator_unix" | "operator_offline";

export const pathActorKind: Readonly<Record<AcceptedPath, ActorKind>> = Object.freeze({
  anonymous_installation: "installation",
  installation_token: "installation",
  provider_session: "human",
  agent_token: "agent",
  operator_unix: "operator",
  operator_offline: "operator",
});

export interface AcceptanceRow {
  mode: AuthenticationMode;
  listener: ListenerKind;
  credential: CredentialClass;
  path: AcceptedPath;
}

const tcp: readonly ListenerKind[] = ["api", "mcp", "worker"];
const row = (mode: AuthenticationMode, listener: ListenerKind, credential: CredentialClass, path: AcceptedPath): AcceptanceRow =>
  Object.freeze({ mode, listener, credential, path });

/**
 * Every accepted combination. Anything absent is rejected: there is no
 * default actor and no fallback to another credential or mode.
 */
export const acceptanceTable: readonly AcceptanceRow[] = Object.freeze([
  ...tcp.map(listener => row("open", listener, "none", "anonymous_installation")),
  ...tcp.map(listener => row("token", listener, "installation_token", "installation_token")),
  row("better-auth", "api", "provider_session", "provider_session"),
  ...tcp.map(listener => row("better-auth", listener, "agent_token", "agent_token")),
  ...authenticationModes.map(mode => row(mode, "unix", "none", "operator_unix")),
  ...authenticationModes.map(mode => row(mode, "offline", "none", "operator_offline")),
]);

/**
 * Routes that are deliberately not operations: they never produce an actor
 * (in particular never an installation actor) and never reach the registry.
 */
export const unregisteredRouteClasses = Object.freeze(["pre_login", "mfa_ceremony", "public_status", "static_asset"] as const);

export type AcceptanceRejection =
  | "unknown_mode" | "unknown_listener" | "mixed_credentials" | "browser_headers_on_unix" | "credential_on_local_listener"
  | "legacy_credential" | "installation_token_in_account_mode" | "credential_in_open_mode" | "credential_required"
  | "credential_not_accepted_here" | "unrecognized_credential" | "offline_lock_not_held";

export type AcceptanceResult = { accepted: true; path: AcceptedPath; credential: CredentialClass } | { accepted: false; reason: AcceptanceRejection };

export function credentialClassOf(presented: PresentedCredentials): CredentialClass | "mixed" {
  const found: CredentialClass[] = presented.bearers.map(bearer => bearer.class);
  if (presented.providerSession) found.push("provider_session");
  if (presented.legacySecret) found.push("legacy_secret");
  if (found.length > 1) return "mixed";
  return found[0] ?? "none";
}

/** Pure resolver over `acceptanceTable`. `offlineLockHeld` matters only to the offline listener. */
export function resolveAcceptance(mode: string, listener: string, presented: PresentedCredentials, offlineLockHeld = false): AcceptanceResult {
  if (!(authenticationModes as readonly string[]).includes(mode)) return { accepted: false, reason: "unknown_mode" };
  if (!(listenerKinds as readonly string[]).includes(listener)) return { accepted: false, reason: "unknown_listener" };
  const credential = credentialClassOf(presented);
  if (credential === "mixed") return { accepted: false, reason: "mixed_credentials" };
  if (listener === "unix" || listener === "offline") {
    if (listener === "unix" && presented.browserHeaders) return { accepted: false, reason: "browser_headers_on_unix" };
    if (credential !== "none") return { accepted: false, reason: "credential_on_local_listener" };
    if (listener === "offline" && !offlineLockHeld) return { accepted: false, reason: "offline_lock_not_held" };
  }
  const match = acceptanceTable.find(entry => entry.mode === mode && entry.listener === listener && entry.credential === credential);
  if (match) return { accepted: true, path: match.path, credential };
  if (credential === "legacy_owner_token" || credential === "legacy_worker_token" || credential === "legacy_secret") {
    return { accepted: false, reason: "legacy_credential" };
  }
  if (credential === "unrecognized") return { accepted: false, reason: "unrecognized_credential" };
  if (mode === "open") return { accepted: false, reason: "credential_in_open_mode" };
  if (credential === "installation_token" && mode === "better-auth") return { accepted: false, reason: "installation_token_in_account_mode" };
  if (credential === "none") return { accepted: false, reason: "credential_required" };
  return { accepted: false, reason: "credential_not_accepted_here" };
}
