import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { canonicalJson, OperationError, publicError } from "../modules/operations";
import type { PublicOperationError, SessionDescription } from "@/shared/contracts/operations";
import { BoundaryError, parseStrictJson, readBoundedBody } from "./authentication-http-boundary";
import { OPERATIONS_HTTP_LIMITS, operationsFailure, presentedCredentials, validateOperationsSingletonHeaders,
  writeOperationsResponse, type OperationsHttpRuntime } from "./operations-http";
import { parseOperationsPath } from "./operations-path";

/** Explicit descriptors, checked against registry.idsOn("mcp") in conformance. */
export const OPERATIONS_MCP_TOOLS = Object.freeze([Object.freeze({
  name: "session_describe", operation: "session.describe", description: "Describe your current authority.",
  inputSchema: Object.freeze({ type: "object" as const, properties: Object.freeze({}), additionalProperties: false }),
})]);

/** Built in D1a-7a, deliberately unmounted. Each handle owns exactly one SDK pair. */
export function createOperationsMcp(options: {
  runtime: OperationsHttpRuntime;
  limits?: { bodyBytes?: number; responseBytes?: number; deadlineMs?: number; maxInFlight?: number };
}) {
  const { runtime } = options, limits = { ...OPERATIONS_HTTP_LIMITS, ...options.limits };
  const accepted = new Set<Promise<void>>(), cancellations = new Set<() => void>();
  let closing = false;
  const failure = (category: ConstructorParameters<typeof OperationError>[0], reason: string) => publicError(new OperationError(category, reason));
  const path = (request: IncomingMessage) => parseOperationsPath(request.url ?? "", runtime.supported ? runtime.registry.idsOn("mcp") : []);
  const execute = async (request: IncomingMessage, response: ServerResponse) => {
    const abort = new AbortController();
    let timedOut = false, server: Server | undefined;
    let engaged = false, rpcId: string | number | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abort.signal.addEventListener("abort", () => reject(new OperationError("unavailable", timedOut ? "request_timed_out" : "request_cancelled", { retry: "retry" })), { once: true });
    });
    void cancelled.catch(() => undefined);
    const cancel = () => { abort.abort(); if (response.writableEnded && !response.writableFinished) response.destroy(); };
    cancellations.add(cancel);
    let finish!: () => void;
    const completed = new Promise<void>(resolve => { finish = resolve; });
    const closed = () => { if (!response.writableFinished) cancel(); finish(); };
    request.once("aborted", cancel); request.once("error", cancel);
    response.once("finish", finish); response.once("close", closed);
    if (response.destroyed || response.writableFinished) closed();
    const timer = setTimeout(() => { timedOut = true; cancel(); }, limits.deadlineMs); timer.unref();
    const connected = () => !abort.signal.aborted && !response.destroyed && !response.writableEnded;
    const refuse = (error: PublicOperationError) => {
      if (!engaged || rpcId === undefined) { operationsFailure(response, error); return; }
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      if (error.retry === "retry") response.setHeader("Retry-After", "1");
      writeOperationsResponse(response, 200, JSON.stringify({ jsonrpc: "2.0", id: rpcId,
        error: { code: -32000, message: error.reason, data: error } }));
    };
    try {
      const parsed = path(request);
      if (!parsed.claimed || parsed.surface !== "mcp" || request.url !== "/mcp/operations") {
        operationsFailure(response, failure("not_found", "operation_not_found")); return;
      }
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        operationsFailure(response, { ...failure("invalid_request", "method_not_allowed"), status: 405 }); return;
      }
      if (closing || (runtime.supported && !runtime.eligible())) { refuse(failure("unavailable", "release_not_eligible")); return; }
      if (!runtime.supported) {
        const minted = await runtime.mint("mcp", presentedCredentials(request), null, { signal: abort.signal });
        refuse(minted.ok ? failure("unauthenticated", "unknown_mode") : minted.error); return;
      }
      // Fail closed for browser Origins. The canonical loopback origin must match
      // the local socket port; a supplied Host is never an authority for this check.
      if (request.headers.origin !== undefined) {
        let allowed = false;
        try {
          const origin = new URL(request.headers.origin);
          allowed = origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
            && origin.port === String(request.socket.localPort) && origin.origin === request.headers.origin;
        } catch { /* refused */ }
        if (!allowed) { refuse(failure("forbidden", "origin_forbidden")); return; }
      }
      validateOperationsSingletonHeaders(request, ["accept", "mcp-protocol-version"]);
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) throw new BoundaryError(400, "invalid_request");
      // Same bearer order as HTTP: strict bounded body, then admitted mint.
      const deadline = runtime.supported ? runtime.runtime.now() + limits.deadlineMs : 0;
      const body = parseStrictJson(await readBoundedBody(request, { limit: limits.bodyBytes, timeoutMs: limits.deadlineMs, signal: abort.signal }), limits.json);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new BoundaryError(400, "invalid_request");
      const minted = await runtime.mint("mcp", presentedCredentials(request), null, { signal: abort.signal });
      if (!minted.ok) { refuse(minted.error); return; }
      if (!runtime.supported) { refuse(failure("unauthenticated", "unknown_mode")); return; }
      const operation = runtime.registry.get("session.describe");
      if (!operation) { refuse(failure("not_found", "operation_not_found")); return; }
      const releaseOptions = { eligible: () => !closing && runtime.eligible(), connected, deadline, signal: abort.signal };
      // This witness also gates initialize, listing and notifications. It is never
      // sent for those methods, but must still match at the real Node commit.
      let value!: SessionDescription;
      const initial = await runtime.runner.readRelease(operation, minted.context, {}, { ...releaseOptions,
        commit(dto) { value = dto as SessionDescription; } });
      if (initial.status !== "committed") { refuse(initial.error); return; }
      const context = Object.freeze({ authentication: minted.context, value, canonical: canonicalJson(value) });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      server = new Server({ name: "worktree-control-operations", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: OPERATIONS_MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
      server.setRequestHandler(CallToolRequestSchema, async call => {
        try {
          if (call.params.name !== "session_describe") throw new OperationError("not_found", "operation_not_found");
          // Delegate input validation to the registered operation, not a transport schema.
          operation.parse(call.params.arguments);
          return { content: [{ type: "text", text: JSON.stringify(context.value) }], structuredContent: context.value };
        } catch (error) {
          const payload = { error: publicError(error) };
          return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
        }
      });
      // The SDK has no JSON response ceiling. Bound its message before it allocates
      // a Response, then bound the actual Response bytes too. This is NOT release.
      let rejectOutput!: (error: unknown) => void;
      const outputFailure = new Promise<never>((_, reject) => { rejectOutput = reject; });
      void outputFailure.catch(() => undefined);
      const send = transport.send.bind(transport);
      transport.send = async (...args) => {
        if (Buffer.byteLength(JSON.stringify(args[0])) > limits.responseBytes) {
          const error = new OperationError("payload_too_large", "response_too_large"); rejectOutput(error); throw error;
        }
        return send(...args);
      };
      await server.connect(transport);
      const message = body as Record<string, unknown>;
      rpcId = typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
      engaged = true;
      // Do not forward identity/session/resumption headers to the SDK. Version and
      // media negotiation are the only request headers it needs in stateless mode.
      const headers = new Headers({ "content-type": "application/json", accept: request.headers.accept ?? "" });
      if (request.headers["mcp-protocol-version"]) headers.set("mcp-protocol-version", String(request.headers["mcp-protocol-version"]));
      const sdk = await Promise.race([transport.handleRequest(new Request("http://operations.invalid/mcp/operations", { method: "POST", headers, signal: abort.signal }), { parsedBody: body }), outputFailure, cancelled]);
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = sdk.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            const chunk = await Promise.race([reader.read(), cancelled]);
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > limits.responseBytes) { await reader.cancel(); throw new OperationError("payload_too_large", "response_too_large"); }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
      }
      const buffer = Buffer.concat(chunks);
      const released = await runtime.runner.readRelease(operation, context.authentication, {}, {
        ...releaseOptions, expectedCanonical: context.canonical,
        commit() {
          // No await, SDK send, or network drain inside admission. SDK security or
          // session headers cannot replace this boundary's response headers.
          writeOperationsResponse(response, sdk.status, buffer.toString("utf8"));
        },
      });
      if (released.status !== "committed") refuse(released.error);
    } catch (error) {
      refuse(timedOut ? publicError(new OperationError("unavailable", "request_timed_out", { retry: "retry" }))
        : error instanceof BoundaryError ? failure(error.status === 413 ? "payload_too_large" : "invalid_request", error.code) : publicError(error));
    } finally {
      // All application reads are awaited before SDK dispatch. SDK handlers are
      // finite and perform no async work. close aborts its protocol bookkeeping;
      // notably SDK close does not settle an abandoned JSON response promise.
      await server?.close();
      await completed;
      clearTimeout(timer); cancellations.delete(cancel);
      request.off("aborted", cancel); request.off("error", cancel);
      response.off("finish", finish); response.off("close", closed);
    }
  };
  return {
    claims(request: IncomingMessage) { return path(request).claimed; },
    handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      // Match HTTP's fixed preflight: before path/method, slot, body or admission.
      if (presentedCredentials(request).providerSession) {
        operationsFailure(response, failure("unauthenticated", "provider_cookie_not_supported")); return Promise.resolve();
      }
      if (closing || accepted.size >= limits.maxInFlight) {
        operationsFailure(response, failure("busy", "listener_capacity")); return Promise.resolve();
      }
      const work = execute(request, response); accepted.add(work);
      const forget = () => { accepted.delete(work); }; void work.then(forget, forget);
      return work;
    },
    stop() { closing = true; for (const cancel of cancellations) cancel(); },
    async drain() { await Promise.allSettled([...accepted]); },
  };
}
