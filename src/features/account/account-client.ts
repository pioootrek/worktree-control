import type { BrowserAuthenticationStatus, BrowserFactorResult, BrowserSession } from "@/shared/contracts/authentication";

/**
 * Closed account-mode authentication routes. The HttpOnly session cookie is the
 * only credential: these requests never carry a bearer, product token or CSRF
 * value, and no secret is read back from a response. The browser attaches the
 * cookie automatically; `credentials: "same-origin"` makes that explicit.
 */
export class AccountApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Account request failed (${status} ${code}).`);
    this.name = "AccountApiError";
  }
}

async function call<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    cache: "no-store",
    credentials: "same-origin",
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  const value = await response.json().catch(() => ({})) as { code?: string };
  if (!response.ok) throw new AccountApiError(response.status, typeof value.code === "string" ? value.code : "authentication_failed");
  return value as T;
}

/** The provider's canonical instant (`canonicalInstant` on the server): exact millisecond ISO-8601 UTC that round-trips. */
function canonicalInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

const SESSION_FACTORS = { password: 1, password_totp: 2, passkey_uv: 2 } as const;

/**
 * Strict reading of the `get-session` DTO the server emits (`browserSession`
 * or `{authenticated:false}`). Only the literal `false` is anonymous; only
 * `true` with every required field in its contract form is a session. Any
 * other 200 (an empty or non-JSON proxy page, a missing flag, a foreign
 * principal kind, a non-canonical expiry, a method/factor mismatch) is not an
 * answer and throws, so callers keep their unavailable or unconfirmed state.
 */
export function parseBrowserSession(value: unknown): BrowserSession {
  const malformed = new AccountApiError(200, "malformed_response");
  if (typeof value !== "object" || value === null) throw malformed;
  const session = value as Record<string, unknown>;
  if (session.authenticated === false) return { authenticated: false };
  if (session.authenticated !== true) throw malformed;
  const principal = session.principal as Record<string, unknown> | null | undefined;
  const authentication = session.authentication as Record<string, unknown> | null | undefined;
  if (typeof principal !== "object" || principal === null || typeof principal.id !== "string" || principal.id === ""
    || (principal.kind !== "owner" && principal.kind !== "human")) throw malformed;
  if (!canonicalInstant(session.expiresAt)) throw malformed;
  if (typeof authentication !== "object" || authentication === null || typeof authentication.method !== "string"
    || !Object.hasOwn(SESSION_FACTORS, authentication.method)
    || authentication.factors !== SESSION_FACTORS[authentication.method as keyof typeof SESSION_FACTORS]) throw malformed;
  return {
    authenticated: true,
    principal: { id: principal.id, kind: principal.kind },
    expiresAt: session.expiresAt,
    authentication: { method: authentication.method, factors: authentication.factors } as Extract<BrowserSession, { authenticated: true }>["authentication"],
  };
}

export const authStatus = (signal?: AbortSignal) => call<BrowserAuthenticationStatus>("/api/auth/status", { signal });
export const getSession = async (signal?: AbortSignal) => parseBrowserSession(await call<unknown>("/api/auth/get-session", { signal }));
export const signIn = (email: string, password: string, signal?: AbortSignal) =>
  call<BrowserFactorResult>("/api/auth/sign-in/email", { body: { email, password }, signal });
/** Resolves only on the server's sign-out proof (`{authenticated:false}`); any other 200 body is not a confirmation. */
export const signOut = async (signal?: AbortSignal): Promise<void> => {
  const value = await call<unknown>("/api/auth/sign-out", { body: {}, signal });
  if (typeof value !== "object" || value === null || (value as { authenticated?: unknown }).authenticated !== false) {
    throw new AccountApiError(200, "malformed_response");
  }
};
export const changePassword = (currentPassword: string, newPassword: string, signal?: AbortSignal) =>
  call<{ changed: true }>("/api/auth/change-password", { body: { currentPassword, newPassword }, signal });
export const totpEnable = (password: string, signal?: AbortSignal) =>
  call<BrowserFactorResult>("/api/auth/two-factor/enable", { body: { password }, signal });
export const totpVerify = (code: string, signal?: AbortSignal) =>
  call<BrowserFactorResult>("/api/auth/two-factor/verify-totp", { body: { code }, signal });

export type PasskeyOptionsKind = "register" | "confirm" | "authenticate";
export type PasskeyVerifyKind = "registration" | "confirmation" | "authentication";
export const passkeyOptions = (kind: PasskeyOptionsKind, signal?: AbortSignal) =>
  call<BrowserFactorResult>(`/api/auth/passkey/generate-${kind}-options`, { signal });
export const passkeyVerify = (kind: PasskeyVerifyKind, response: unknown, signal?: AbortSignal) =>
  call<BrowserFactorResult>(`/api/auth/passkey/verify-${kind}`, { body: { response }, signal });

/** A 401 on the closed surface means the session is gone or never valid; the caller returns to sign-in. A 403 is a current-authority denial, not session loss. */
export function isSessionLoss(error: unknown): boolean {
  return error instanceof AccountApiError && error.status === 401;
}
