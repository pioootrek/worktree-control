import type { IncomingMessage, ServerResponse } from "node:http";
import { CONTROLLER_TOKEN_HEADER, LEGACY_CONTROLLER_TOKEN_HEADER } from "@/shared/controller-token";
import { containsProviderCookie } from "@/shared/contracts/authentication";
import {
  classifyBearer, OperationError, publicError,
  type AuthenticationContext, type OperationRegistry, type OperationRunner, type OperationRuntime, type PresentedCredentials,
} from "../modules/operations";
import type { DatabaseAdmissionOptions } from "../database-admission";
import type { PublicOperationError } from "@/shared/contracts/operations";
import { BoundaryError, parseStrictJson, readBoundedBody } from "./authentication-http-boundary";
import { parseOperationsPath } from "./operations-path";

type Mint = (listener: "api" | "unix", presented: PresentedCredentials, session: null, options: DatabaseAdmissionOptions) => Promise<
  { readonly ok: true; readonly context: AuthenticationContext } | { readonly ok: false; readonly error: PublicOperationError }>;
/** Value supplied by the one bootstrap composition. No boundary is constructed here. */
export type OperationsHttpRuntime = { supported: false; mint: Mint } | {
  supported: true; mint: Mint; eligible(): boolean;
  runtime: Pick<OperationRuntime, "now">;
  registry: Pick<OperationRegistry, "get" | "idsOn">;
  runner: Pick<OperationRunner, "readRelease">;
};

/** API's existing 64 KiB ceiling; unix's ordinary-command ceiling is stricter. */
export const OPERATIONS_HTTP_LIMITS = Object.freeze({ bodyBytes: 64 * 1024, unixBodyBytes: 16 * 1024,
  responseBytes: 256 * 1024, deadlineMs: 10_000, maxInFlight: 32, json: Object.freeze({ maxDepth: 8, maxFields: 128 }) });

/** Preserve raw multiplicity, including headers Node would otherwise discard. */
export function presentedCredentials(request: IncomingMessage): PresentedCredentials {
  const bearers: PresentedCredentials["bearers"][number][] = [];
  let cookie = false, browserHeaders = false;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i].toLowerCase(), value = request.rawHeaders[i + 1];
    if (name === "authorization" || name === CONTROLLER_TOKEN_HEADER.toLowerCase() || name === LEGACY_CONTROLLER_TOKEN_HEADER.toLowerCase()) {
      const secret = name === "authorization" ? (/^Bearer\s+(.+)$/i.exec(value)?.[1] ?? "") : value;
      bearers.push({ class: classifyBearer(secret), secret });
    }
    if (name === "cookie") cookie ||= containsProviderCookie(value);
    if (name === "cookie" || name === "origin" || name.startsWith("sec-fetch-")) browserHeaders = true;
  }
  return { bearers, providerSession: cookie ? { secret: "" } : null, legacySecret: false, browserHeaders };
}

export function operationsFailure(response: ServerResponse, error: PublicOperationError): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  // Refused bodies are not drained. Close this connection after the finite response.
  response.setHeader("Connection", "close");
  write(response, error.status, JSON.stringify({ error }));
}
function write(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" });
  response.end(body);
}
const failure = (category: ConstructorParameters<typeof OperationError>[0], reason: string) => publicError(new OperationError(category, reason));

/** Lifetime includes Node response completion AND all started application work. */
export function createOperationsHttp(options: {
  runtime: OperationsHttpRuntime; listener: "api" | "unix";
  originAllowed?(request: IncomingMessage): boolean;
  /** Unix passes its existing owner; it must never acquire a second slot here. */
  externallyOwned?: boolean;
  limits?: { bodyBytes?: number; responseBytes?: number; deadlineMs?: number; maxInFlight?: number };
}) {
  const { runtime, listener } = options, limits = { ...OPERATIONS_HTTP_LIMITS, ...options.limits };
  const accepted = new Set<Promise<void>>();
  const cancellations = new Set<AbortController>();
  let closing = false;
  const path = (request: IncomingMessage) => parseOperationsPath(request.url ?? "", runtime.supported ? runtime.registry.idsOn(listener) : ["session.describe"]);
  const preflight = (request: IncomingMessage, response: ServerResponse): boolean => {
    // One fixed refusal, independent of mode, method, malformed path or other credentials.
    if (presentedCredentials(request).providerSession) {
      operationsFailure(response, failure("unauthenticated", "provider_cookie_not_supported")); return false;
    }
    return true;
  };
  const execute = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const abort = new AbortController();
    cancellations.add(abort);
    const cancel = () => { abort.abort(); };
    let complete!: () => void;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    const finished = () => { complete(); };
    const closed = () => { if (!response.writableFinished) cancel(); complete(); };
    request.once("aborted", cancel); request.once("error", cancel);
    response.once("finish", finished); response.once("close", closed);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; cancel(); }, limits.deadlineMs); timer.unref();
    const connected = () => !abort.signal.aborted && !response.destroyed && !response.writableEnded;
    try {
      const parsed = path(request);
      if (!parsed.claimed || !parsed.operation || parsed.surface !== "api") {
        operationsFailure(response, failure("not_found", "operation_not_found")); return;
      }
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        operationsFailure(response, failure("invalid_request", "method_not_allowed")); return;
      }
      if (!runtime.supported) {
        const result = await runtime.mint(listener, presentedCredentials(request), null, { signal: abort.signal });
        if (!result.ok) operationsFailure(response, result.error);
        return;
      }
      if (closing || !runtime.eligible()) { operationsFailure(response, failure("unavailable", "release_not_eligible")); return; }
      if (options.originAllowed && !options.originAllowed(request)) { operationsFailure(response, failure("forbidden", "origin_forbidden")); return; }
      // Do not let Node collapse singleton transport fields into an accepted value.
      const single = new Set(["host", "origin", "content-type", "content-length", "content-encoding", "transfer-encoding"]);
      const seen = new Set<string>();
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const name = request.rawHeaders[i].toLowerCase();
        if (single.has(name) && seen.has(name)) throw new BoundaryError(400, "invalid_request");
        seen.add(name);
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) throw new BoundaryError(400, "invalid_request");
      const deadline = runtime.runtime.now() + limits.deadlineMs;
      const body = parseStrictJson(await readBoundedBody(request, {
        limit: listener === "unix" ? Math.min(limits.bodyBytes, limits.unixBodyBytes) : limits.bodyBytes,
        timeoutMs: limits.deadlineMs, signal: abort.signal,
      }), limits.json);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new BoundaryError(400, "invalid_request");
      const minted = await runtime.mint(listener, presentedCredentials(request), null, { signal: abort.signal });
      if (!minted.ok) { operationsFailure(response, minted.error); return; }
      const operation = runtime.registry.get(parsed.operation);
      if (!operation) { operationsFailure(response, failure("not_found", "operation_not_found")); return; }
      const result = await runtime.runner.readRelease(operation, minted.context, body, {
        eligible: () => !closing && runtime.eligible(), connected, deadline, signal: abort.signal,
        commit(value) {
          const serialized = JSON.stringify(value);
          if (Buffer.byteLength(serialized) > limits.responseBytes) {
            operationsFailure(response, failure("payload_too_large", "response_too_large")); return;
          }
          write(response, 200, serialized);
        },
      });
      if (result.status !== "committed") operationsFailure(response, result.error);
    } catch (error) {
      operationsFailure(response, timedOut ? publicError(new OperationError("unavailable", "request_timed_out", { retry: "retry" })) : error instanceof BoundaryError
        ? failure(error.status === 413 ? "payload_too_large" : "invalid_request", error.code)
        : publicError(error));
    } finally {
      // Never relinquish ownership merely because the handler returned or the client disconnected.
      await completed;
      clearTimeout(timer);
      cancellations.delete(abort);
      request.off("aborted", cancel); request.off("error", cancel);
      response.off("finish", finished); response.off("close", closed);
    }
  };
  return {
    claims(request: IncomingMessage) { const parsed = path(request); return parsed.claimed && parsed.surface === "api"; },
    preflight,
    handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      if (!preflight(request, response)) return Promise.resolve();
      if (closing || (!options.externallyOwned && accepted.size >= limits.maxInFlight)) {
        operationsFailure(response, failure("busy", "listener_capacity")); return Promise.resolve();
      }
      const work = execute(request, response);
      if (!options.externallyOwned) {
        accepted.add(work);
        const forget = () => { accepted.delete(work); }; work.then(forget, forget);
      }
      return work;
    },
    stop() { closing = true; for (const abort of cancellations) abort.abort(); },
    async drain() { await Promise.allSettled([...accepted]); },
  };
}
