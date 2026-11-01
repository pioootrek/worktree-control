import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { containsProviderCookie, browserChangePasswordSchema, browserSignInSchema, browserSignOutSchema, type BrowserAuthenticationStatus } from "@/shared/contracts/authentication";
import { IdentityError } from "@/server/modules/identity";
import { databaseAdmissionFailure, type DatabaseAdmission } from "@/server/database-admission";
import { AuthenticationProviderError, type AuthenticationProviderRuntime, type ProviderKnowledgeApplication } from "@/server/modules/authentication";

const SESSION_COOKIE = "__Secure-wtc.session_token";
// Native sign-out also deletes disabled cache cookies. Only deletions are allowed for those names.
const DELETION_COOKIES = new Set(["__Secure-wtc.session_data", "__Secure-wtc.account_data", "__Secure-wtc.dont_remember"]);
const ROUTES = new Map([
  ["/api/auth/sign-in/email", ["POST", "sign-in"]], ["/api/auth/get-session", ["GET", "session"]],
  ["/api/auth/sign-out", ["POST", "sign-out"]], ["/api/auth/change-password", ["POST", "password"]],
] as const);
class BoundaryError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const fail = (status: number, code: string): never => { throw new BoundaryError(status, code); };

export function hasProviderCookie(request: IncomingMessage): boolean {
  return containsProviderCookie(request.headers.cookie);
}
export function authenticationJson(response: ServerResponse, status: number, body: unknown, cookies: string[] = []): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  if (cookies.length) response.setHeader("Set-Cookie", cookies);
  response.writeHead(status).end(JSON.stringify(body));
}

/** Validate the complete cookie set before releasing ANY cookie. Never comma-split Set-Cookie. */
export function approvedAuthenticationCookies(headers: Headers): string[] {
  const lines = headers.getSetCookie();
  if (lines.length > 8 || lines.reduce((sum, line) => sum + line.length, 0) > 16 * 1024) fail(502, "provider_failed");
  const seen = new Set<string>();
  for (const line of lines) {
    const [pair, ...attributes] = line.split(";").map(part => part.trim());
    if (!pair || /[\r\n]/.test(line)) fail(502, "provider_failed");
    const equals = pair.indexOf("="), name = pair.slice(0, equals), value = pair.slice(equals + 1);
    if (equals < 1 || seen.has(name) || !/^[\x21-\x2b\x2d-\x3a\x3c-\x7e]*$/.test(value)) fail(502, "provider_failed");
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
    if (name !== SESSION_COOKIE && !(DELETION_COOKIES.has(name) && deletion)) fail(502, "provider_failed");
  }
  return lines;
}

/** Explicit HTTPS boundary. Mounting this adapter does not select or enable a product mode. */
export class AuthenticationHttp {
  readonly #origin: string;
  readonly #authority: string;
  #active = 0;
  constructor(private readonly deps: {
    origin: string;
    runtime: AuthenticationProviderRuntime;
    admission: DatabaseAdmission;
    knowledge: ProviderKnowledgeApplication;
    status(): BrowserAuthenticationStatus;
    maintenance?(): boolean;
    /** Finite proof fixtures only; production derives peer exclusively from socket.remoteAddress. */
    trustedFixturePeer?: string;
    maxInFlight?: number;
  }) {
    const origin = new URL(deps.origin);
    if (origin.protocol !== "https:" || origin.origin !== deps.origin || origin.username || origin.password) throw new Error("Authentication requires a canonical HTTPS origin.");
    if (!Number.isInteger(deps.maxInFlight ?? 8) || (deps.maxInFlight ?? 8) < 1 || (deps.maxInFlight ?? 8) > 64) throw new Error("Invalid authentication capacity.");
    if (deps.trustedFixturePeer && !isIP(deps.trustedFixturePeer)) throw new Error("Invalid fixture peer.");
    this.#origin = origin.origin; this.#authority = origin.host;
  }

  /** Runs before blanket core admission. All body reads and provider work remain outside it. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = request.url ?? "";
    const cookie = hasProviderCookie(request);
    if (!path.includes("auth") && !cookie) return false;
    let counted = false, operationFinished = false, responseFinished = response.writableFinished || response.destroyed;
    const release = () => {
      if (counted && operationFinished && responseFinished) { counted = false; this.#active--; }
    };
    const finished = () => { responseFinished = true; release(); };
    let discard: Awaited<ReturnType<AuthenticationProviderRuntime["authenticate"]>> = null;
    try {
      this.boundary(request);
      if (this.deps.maintenance?.()) fail(503, "database_unavailable");
      if (path === "/api/auth/status" && request.method === "GET") {
        authenticationJson(response, 200, this.deps.status()); return true;
      }
      const knowledge = path === "/api/knowledge" && cookie;
      const route = ROUTES.get(path as Parameters<typeof ROUTES.get>[0]);
      if (!route && !knowledge) fail(401, "invalid_credential");
      if (request.method !== (knowledge ? "POST" : route![0])) fail(405, "method_not_allowed");
      if (this.#active >= (this.deps.maxInFlight ?? 8)) fail(503, "database_busy");
      this.#active++; counted = true;
      response.once("finish", finished); response.once("close", finished);
      const nativeHeaders = this.headers(request);
      let input: unknown;
      if (request.method === "POST") {
        if (request.headers.origin !== this.#origin) fail(403, "origin_forbidden");
        if (request.headers["content-type"] !== "application/json") fail(400, "invalid_request");
        input = await readBody(request, knowledge ? 64 * 1024 : 4096);
      }
      if (this.deps.maintenance?.()) fail(503, "database_unavailable");
      if (knowledge) {
        const actor = await this.deps.runtime.authenticate(nativeHeaders);
        if (!actor) fail(401, "invalid_credential");
        await this.deps.admission.run(() => {
          if (this.deps.maintenance?.()) fail(503, "database_unavailable");
          const result = this.deps.knowledge.executeAdmitted(input, actor);
          authenticationJson(response, 200, result);
        }); return true;
      }
      const operation = route![1];
      if (operation === "sign-in") {
        const parsed = browserSignInSchema.safeParse(input);
        if (!parsed.success) fail(400, "invalid_request");
        input = parsed.data; nativeHeaders.delete("cookie");
      } else if (operation === "sign-out") {
        if (!browserSignOutSchema.safeParse(input).success) fail(400, "invalid_request");
        input = {};
      } else if (operation === "password") {
        const parsed = browserChangePasswordSchema.safeParse(input);
        if (!parsed.success) fail(400, "invalid_request");
        input = { ...parsed.data, revokeOtherSessions: true };
      } else if (request.headers["content-length"] && request.headers["content-length"] !== "0") fail(400, "invalid_request");
      const actor = operation === "password" ? await this.deps.runtime.authenticate(nativeHeaders) : null;
      if (operation === "password" && !actor) fail(401, "invalid_credential");
      const native = new Request(`${this.#origin}${path}`, { method: request.method, headers: nativeHeaders,
        ...(request.method === "POST" ? { body: JSON.stringify(input) } : {}) });
      const result = await this.deps.runtime.browser(operation, native, actor);
      if (operation === "sign-in" || operation === "password") discard = result.actor;
      if (result.response.status === 429) fail(429, "rate_limited");
      if (!result.response.ok) fail(result.response.status >= 500 ? 502 : 401, "authentication_failed");
      const cookies = approvedAuthenticationCookies(result.response.headers);
      if (operation === "sign-out") authenticationJson(response, 200, { authenticated: false }, cookies);
      else if (!result.actor) {
        if (operation !== "session") fail(401, "authentication_failed");
        authenticationJson(response, 200, { authenticated: false });
      } else {
        // Last current-authority check and response release form one synchronous admitted phase.
        await this.deps.admission.run(() => {
          if (this.deps.maintenance?.()) fail(503, "database_unavailable");
          const session = this.deps.runtime.browserSession(result.actor!);
          authenticationJson(response, 200, operation === "session" ? session : operation === "password" ? { changed: true } : { authenticated: true }, cookies);
          discard = null;
        });
      }
    } catch (error) {
      if (discard) { try { await this.deps.runtime.discardBrowserSession(discard); } catch { /* Still deny; never release its cookie. */ } }
      const admission = databaseAdmissionFailure(error);
      const code = error instanceof BoundaryError ? error.code : admission?.code
        ?? (error instanceof AuthenticationProviderError && error.committed ? "committed_notification_failed"
          : (error instanceof AuthenticationProviderError && error.code === "invalid_session") || (error instanceof IdentityError && error.code === "invalid_credential") ? "invalid_credential"
            : (error as { code?: string })?.code === "knowledge_forbidden" ? "knowledge_forbidden" : "authentication_failed");
      const status = error instanceof BoundaryError ? error.status : admission?.status ?? (code === "knowledge_forbidden" ? 403 : code === "invalid_credential" ? 401 : 500);
      if (status === 429 || status === 503) response.setHeader("Retry-After", status === 429 ? "60" : "1");
      response.setHeader("Connection", "close");
      authenticationJson(response, status, { code, ...(error instanceof AuthenticationProviderError && error.committed ? { committed: true } : {}) });
    } finally { operationFinished = true; release(); }
    return true;
  }

  private boundary(request: IncomingMessage): void {
    const path = request.url ?? "";
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path) || path.includes("//") || path.endsWith("/")) fail(400, "invalid_request");
    if (request.headers.host !== this.#authority || countHeader(request, "host") > 1) fail(421, "invalid_authority");
    if (countHeader(request, "origin") > 1 || (request.headers.origin !== undefined && request.headers.origin !== this.#origin)
      || (request.headers["sec-fetch-site"] !== undefined && request.headers["sec-fetch-site"] !== "same-origin")) fail(403, "origin_forbidden");
    if (request.method === "GET" && (request.headers["transfer-encoding"] || (request.headers["content-length"] && request.headers["content-length"] !== "0"))) fail(400, "invalid_request");
    if ((request.headers.cookie?.length ?? 0) > 8192) fail(400, "invalid_request");
  }
  private headers(request: IncomingMessage): Headers {
    const peer = this.deps.trustedFixturePeer ?? request.socket.remoteAddress;
    if (!peer || !isIP(peer)) fail(503, "database_unavailable");
    // Rebuild from an allowlist; Authorization, product tokens, internal IP and all forwarding headers disappear.
    const canonicalPeer = isIP(peer) === 6 ? (peer.toLowerCase().startsWith("::ffff:") && isIP(peer.slice(7)) === 4 ? peer.slice(7) : new URL(`http://[${peer}]/`).hostname.slice(1, -1)) : peer;
    const headers = new Headers({ "x-worktree-control-client-ip": canonicalPeer, "content-type": "application/json" });
    for (const name of ["origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"] as const) {
      const value = request.headers[name]; if (typeof value === "string") headers.set(name, value);
    }
    const matches = (request.headers.cookie ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${SESSION_COOKIE}=`));
    if (matches.length > 1) fail(400, "invalid_request");
    if (matches[0]) headers.set("cookie", matches[0]);
    return headers;
  }
}
function countHeader(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < (request.rawHeaders?.length ?? 0); index += 2) if (request.rawHeaders[index].toLowerCase() === name) count++;
  return count;
}
async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0; const chunks: Buffer[] = [];
    const cleanup = () => {
      clearTimeout(timer); request.off("data", data); request.off("end", end); request.off("error", error); request.off("aborted", aborted);
    };
    const error = () => { cleanup(); reject(new BoundaryError(400, "invalid_request")); };
    const aborted = () => error();
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) { cleanup(); request.pause(); reject(new BoundaryError(413, "request_too_large")); }
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new BoundaryError(400, "invalid_request")); }
    };
    const timer = setTimeout(() => { cleanup(); request.pause(); reject(new BoundaryError(408, "request_timeout")); }, 10_000);
    timer.unref();
    request.on("data", data); request.once("end", end); request.once("error", error); request.once("aborted", aborted);
  });
}
