import type { BrowserFactorResult, BrowserSession } from "@/shared/contracts/authentication";

/**
 * The closed browser surface: one provider path and method per operation. There
 * is no suffix, query, native catch-all or caller-selected route.
 * `actor`: needs a current session of the same account.
 * `initiating`: starts a ceremony, so it never uses capacity kept for completions.
 */
export const BROWSER_OPERATIONS = {
  "sign-in": { path: "/sign-in/email", method: "POST", initiating: true },
  session: { path: "/get-session", method: "GET" },
  "sign-out": { path: "/sign-out", method: "POST" },
  password: { path: "/change-password", method: "POST", actor: true },
  "totp-enable": { path: "/two-factor/enable", method: "POST", actor: true, factor: true },
  "totp-verify": { path: "/two-factor/verify-totp", method: "POST", factor: true },
  "passkey-register-options": { path: "/passkey/generate-register-options", method: "GET", actor: true, factor: true },
  "passkey-registration": { path: "/passkey/verify-registration", method: "POST", actor: true, factor: true },
  "passkey-confirm-options": { path: "/passkey/generate-confirm-options", method: "GET", actor: true, factor: true },
  "passkey-confirmation": { path: "/passkey/verify-confirmation", method: "POST", actor: true, factor: true },
  "passkey-authenticate-options": { path: "/passkey/generate-authenticate-options", method: "GET", initiating: true, factor: true },
  "passkey-authentication": { path: "/passkey/verify-authentication", method: "POST", factor: true },
} as const satisfies Record<string, { path: string; method: "GET" | "POST"; actor?: true; factor?: true; initiating?: true }>;
export type BrowserOperation = keyof typeof BROWSER_OPERATIONS;
export const browserOperationRequires = (operation: BrowserOperation, flag: "actor" | "factor" | "initiating"): boolean =>
  (BROWSER_OPERATIONS[operation] as { actor?: true; factor?: true; initiating?: true })[flag] === true;

export const BROWSER_COOKIE = {
  session: "__Secure-wtc.session_token",
  challenge: "__Secure-wtc.two_factor",
  passkey: "__Secure-wtc.passkey_challenge",
} as const;

/** What a safe result is. Carries no value; only its own runtime can finish it. */
export type BrowserOutcome = "session" | "password" | "signed-out" | "unauthenticated" | "challenge" | "enrollment" | "enrolled" | "staged" | "options";
export interface BrowserRelease { readonly operation: BrowserOperation; readonly outcome: BrowserOutcome }
export type BrowserResultBody = BrowserFactorResult | BrowserSession | { changed: true };

/**
 * `result` answers the request. `settled` resolves once no queued callback can
 * start and any started one really ended, which can be after `result` when a
 * borrow's public promise timed out. Neither is a caller callback.
 */
export interface BrowserLifetime<T> { result: Promise<T>; settled: Promise<void> }
