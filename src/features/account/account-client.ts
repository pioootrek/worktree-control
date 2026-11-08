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

export const authStatus = (signal?: AbortSignal) => call<BrowserAuthenticationStatus>("/api/auth/status", { signal });
export const getSession = (signal?: AbortSignal) => call<BrowserSession>("/api/auth/get-session", { signal });
export const signIn = (email: string, password: string, signal?: AbortSignal) =>
  call<BrowserFactorResult>("/api/auth/sign-in/email", { body: { email, password }, signal });
export const signOut = (signal?: AbortSignal) => call<BrowserSession>("/api/auth/sign-out", { body: {}, signal });
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
