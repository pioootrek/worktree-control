import type { IncomingMessage } from "node:http";
import { parseStrictProviderJson, BROWSER_COOKIE, type BrowserOperation } from "@/server/modules/authentication";

export class BoundaryError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export function fail(status: number, code: string): never { throw new BoundaryError(status, code); }

/** Explicit transport inputs. There are no defaults, so a fixture value cannot become policy. */
export interface AuthenticationTransportLimits {
  passwordBodyBytes: number;
  webAuthnBodyBytes: number;
  knowledgeBodyBytes: number;
  cookieBytes: number;
  bodyTimeoutMs: number;
  json: { maxDepth: number; maxFields: number };
  knowledgeJson: { maxDepth: number; maxFields: number };
  /** In-flight slots that an initiating request may never take. */
  reservedCompletionSlots: number;
}
export function validateTransportLimits(limits: AuthenticationTransportLimits | undefined, maxInFlight: number): AuthenticationTransportLimits {
  const positive = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
  const ceiling = (value: { maxDepth?: unknown; maxFields?: unknown } | undefined) => positive(value?.maxDepth) && positive(value?.maxFields);
  if (!limits || !positive(limits.passwordBodyBytes) || !positive(limits.webAuthnBodyBytes) || !positive(limits.knowledgeBodyBytes) || !positive(limits.cookieBytes)
    || !positive(limits.bodyTimeoutMs) || !ceiling(limits.json) || !ceiling(limits.knowledgeJson)
    || !Number.isSafeInteger(limits.reservedCompletionSlots) || limits.reservedCompletionSlots < 0 || limits.reservedCompletionSlots >= maxInFlight) {
    throw new Error("Invalid authentication transport limits.");
  }
  return Object.freeze({ ...limits, json: Object.freeze({ ...limits.json }), knowledgeJson: Object.freeze({ ...limits.knowledgeJson }) });
}

/**
 * Reads one body as bytes, on no admission. `Content-Length`, when present, is
 * only an early refusal; the streamed count is what decides. Every terminal path
 * removes its listeners and timer.
 */
export async function readBoundedBody(request: IncomingMessage, options: { limit: number; timeoutMs: number; signal: AbortSignal }): Promise<string> {
  if (request.headers["content-encoding"] !== undefined) fail(400, "invalid_request");
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > options.limit)) fail(/^[0-9]+$/.test(declared) ? 413 : 400, /^[0-9]+$/.test(declared) ? "request_too_large" : "invalid_request");
  return new Promise((resolve, reject) => {
    let bytes = 0, settled = false;
    const chunks: Buffer[] = [];
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off("data", data); request.off("end", end); request.off("error", broken);
      options.signal.removeEventListener("abort", broken);
      settle();
    };
    const refuse = (status: number, code: string, stop: boolean) => finish(() => { if (stop) request.pause(); reject(new BoundaryError(status, code)); });
    const broken = () => refuse(400, "invalid_request", false);
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.limit) refuse(413, "request_too_large", true);
      else chunks.push(chunk);
    };
    const end = () => finish(() => {
      try { resolve(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))); }
      catch { reject(new BoundaryError(400, "invalid_request")); }
    });
    const timer = setTimeout(() => refuse(408, "request_timeout", true), options.timeoutMs);
    timer.unref();
    if (options.signal.aborted) { broken(); return; }
    options.signal.addEventListener("abort", broken, { once: true });
    request.on("data", data); request.once("end", end); request.once("error", broken);
  });
}

/**
 * Parses JSON that is already bounded, refusing repeated object keys, which
 * `JSON.parse` would silently resolve as last-wins, plus excess depth and fields.
 */
export function parseStrictJson(text: string, ceiling: { maxDepth: number; maxFields: number }): unknown {
  try { return parseStrictProviderJson(text, ceiling); } catch { fail(400, "invalid_request"); }
}

export const { session: SESSION_COOKIE, challenge: CHALLENGE_COOKIE, passkey: PASSKEY_COOKIE } = BROWSER_COOKIE;
const TRUST_COOKIE = "__Secure-wtc.trust_device";
const MANAGED = [SESSION_COOKIE, CHALLENGE_COOKIE, PASSKEY_COOKIE] as const;
const ALIASES = new Set(MANAGED.flatMap(name => [name.toLowerCase(), name.toLowerCase().replace("__secure-", "")]));
type ManagedCookie = typeof MANAGED[number];

/**
 * Reads the managed cookies out of the whole header, before any filtering, so a
 * duplicate cannot disappear when the forwarded header is rebuilt. Node has
 * already joined repeated raw Cookie fields. Unsigned or case-changed names are
 * refused; unrelated cookies and any trust cookie are simply never forwarded.
 */
export function requestCookies(header: string | undefined): Map<ManagedCookie, string> {
  const found = new Map<ManagedCookie, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (name === TRUST_COOKIE) continue;
    if (!ALIASES.has(name.toLowerCase())) continue;
    if (!MANAGED.includes(name as ManagedCookie) || found.has(name as ManagedCookie)) fail(400, "invalid_request");
    found.set(name as ManagedCookie, part.slice(index + 1).trim());
  }
  return found;
}

interface CookiePolicy {
  /** Forwarded when present. The provider never sees any other request cookie. */
  forward: readonly ManagedCookie[];
  /** Required, or the request refuses before the provider. */
  require: readonly ManagedCookie[];
  /** Live cookies the response may set. Everything else may only be deleted. */
  live: readonly ManagedCookie[];
}
const S = SESSION_COOKIE, T = CHALLENGE_COOKIE, P = PASSKEY_COOKIE;
export const COOKIE_POLICY: Record<BrowserOperation, CookiePolicy> = {
  "sign-in": { forward: [], require: [], live: [S, T] },
  session: { forward: [S], require: [], live: [S] },
  "sign-out": { forward: [S], require: [], live: [] },
  password: { forward: [S], require: [S], live: [S] },
  "totp-enable": { forward: [S], require: [S], live: [] },
  // Exactly one of S or T: see `factorCookies`.
  "totp-verify": { forward: [S, T], require: [], live: [S] },
  "passkey-register-options": { forward: [S], require: [S], live: [P] },
  // P stays with the client: confirmation issues from this same source.
  "passkey-registration": { forward: [S, P], require: [S, P], live: [] },
  "passkey-confirm-options": { forward: [S, P], require: [S, P], live: [P] },
  "passkey-confirmation": { forward: [S, P], require: [S, P], live: [] },
  "passkey-authenticate-options": { forward: [], require: [], live: [P] },
  "passkey-authentication": { forward: [P], require: [P], live: [S] },
};

const MAX_AGE: Record<ManagedCookie, number> = { [S]: 8 * 60 * 60, [T]: 60 * 60, [P]: 60 * 60 };
// Native sign-out also deletes disabled cache cookies. Only deletions are allowed for those names.
const DELETION_COOKIES = new Set<string>([...MANAGED, TRUST_COOKIE, "__Secure-wtc.session_data", "__Secure-wtc.account_data", "__Secure-wtc.dont_remember"]);
export const deletionCookie = (name: string) => `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;

/** Validate the complete cookie set before releasing ANY cookie. Never comma-split Set-Cookie. */
export function approvedAuthenticationCookies(headers: Headers, live: readonly string[] = [SESSION_COOKIE]): string[] {
  const lines = headers.getSetCookie();
  if (lines.length > 8 || lines.reduce((sum, line) => sum + line.length, 0) > 16 * 1024) fail(502, "provider_failed");
  const seen = new Set<string>();
  for (const line of lines) {
    const [pair, ...attributes] = line.split(";").map(part => part.trim());
    if (!pair || /[\r\n]/.test(line)) fail(502, "provider_failed");
    const equals = pair.indexOf("="), name = pair.slice(0, equals), value = pair.slice(equals + 1);
    if (equals < 1 || seen.has(name) || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/.test(value)) fail(502, "provider_failed");
    seen.add(name);
    const attrs = new Map<string, string>();
    for (const attr of attributes) {
      const index = attr.indexOf("="), key = (index < 0 ? attr : attr.slice(0, index)).toLowerCase();
      if (attrs.has(key)) fail(502, "provider_failed");
      attrs.set(key, index < 0 ? "" : attr.slice(index + 1));
    }
    if (attrs.get("path") !== "/" || attrs.get("secure") !== "" || attrs.get("httponly") !== ""
      || attrs.get("samesite")?.toLowerCase() !== "strict"
      || [...attrs.keys()].some(key => !["path", "secure", "httponly", "samesite", "max-age", "expires"].includes(key))) fail(502, "provider_failed");
    if (attrs.has("max-age") && !/^(?:0|[1-9][0-9]{0,8})$/.test(attrs.get("max-age")!)) fail(502, "provider_failed");
    if (attrs.has("expires")) {
      const expiry = new Date(attrs.get("expires")!);
      if (!Number.isFinite(expiry.getTime()) || expiry.toUTCString() !== attrs.get("expires")) fail(502, "provider_failed");
    }
    const deletion = !value && attrs.get("max-age") === "0";
    if (deletion ? !DELETION_COOKIES.has(name) : !live.includes(name) || !value) fail(502, "provider_failed");
    if (!deletion && Number(attrs.get("max-age") ?? 0) > MAX_AGE[name as ManagedCookie]) fail(502, "provider_failed");
  }
  return lines;
}
