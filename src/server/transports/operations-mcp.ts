import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { canonicalJson, OperationError, publicError } from "../modules/operations";
import type { PublicOperationError } from "@/shared/contracts/operations";
import { BoundaryError, parseStrictJson, readBoundedBody } from "./authentication-http-boundary";
import { OPERATIONS_HTTP_LIMITS, operationsFailure, operationsRequestFailure, presentedCredentials, validateOperationsSingletonHeaders,
  writeOperationsResponse, type OperationsHttpRuntime } from "./operations-http";
import { parseOperationsPath } from "./operations-path";

const PROJECT_ID_SCHEMA = Object.freeze({ type: "string" as const, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$" });
/**
 * Explicit descriptors, sorted by operation ID and checked against
 * registry.idsOn("mcp") in conformance. The schema only advertises the input;
 * the registered operation's parse is the one validation on every transport.
 */
export const OPERATIONS_MCP_TOOLS = Object.freeze([
  Object.freeze({
    name: "project_list", operation: "project.list",
    description: "List the projects you can read, with their registrations' port, runtime phase, worktree and claim relation. Paginated.",
    inputSchema: Object.freeze({ type: "object" as const, additionalProperties: false, properties: Object.freeze({
      limit: Object.freeze({ type: "integer" as const, minimum: 1, maximum: 100 }),
      cursor: Object.freeze({ type: "string" as const, minLength: 1, maxLength: 512 }),
    }) }),
  }),
  Object.freeze({
    name: "project_status", operation: "project.status",
    description: "Read one project's status: Knowledge revision, writability and each registration's placement and claim. compact omits the detail.",
    inputSchema: Object.freeze({ type: "object" as const, additionalProperties: false, required: Object.freeze(["projectId"]),
      properties: Object.freeze({ projectId: PROJECT_ID_SCHEMA, compact: Object.freeze({ type: "boolean" as const }) }) }),
  }),
  Object.freeze({
    name: "project_worktrees", operation: "project.worktrees",
    description: "Discover the Git worktrees of each registration of one project. Every call discovers.",
    inputSchema: Object.freeze({ type: "object" as const, additionalProperties: false, required: Object.freeze(["projectId"]),
      properties: Object.freeze({ projectId: PROJECT_ID_SCHEMA }) }),
  }),
  Object.freeze({
    name: "session_describe", operation: "session.describe", description: "Describe your current authority.",
    inputSchema: Object.freeze({ type: "object" as const, properties: Object.freeze({}), additionalProperties: false }),
  }),
]);
type ToolDescriptor = typeof OPERATIONS_MCP_TOOLS[number];
type ToolResult = { readonly ok: true; readonly serialized: string; readonly canonical: string } | { readonly ok: false; readonly error: PublicOperationError };

/** The tool a JSON-RPC body calls, when it is a call of a project tool. Session describe keeps its own path. */
function projectToolCall(body: Record<string, unknown>): { tool: ToolDescriptor; arguments: unknown } | null {
  const own = (value: unknown, key: string): unknown => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  if (own(body, "method") !== "tools/call") return null;
  const params = own(body, "params"), name = own(params, "name");
  const tool = OPERATIONS_MCP_TOOLS.find(each => each.name === name && each.operation !== "session.describe");
  return tool ? { tool, arguments: own(params, "arguments") } : null;
}

/**
 * SDK Protocol adds { result, jsonrpc, id }; JSON response mode serializes that
 * object directly, without a session or SSE frame. Reserve 128 bytes for the
 * fixed tool/JSON-RPC framing and 64 KiB for an echoed ID (the default request
 * bound). Larger fixture request limits do not enlarge this fixed allowance.
 */
export const OPERATIONS_MCP_ENVELOPE_OVERHEAD = OPERATIONS_HTTP_LIMITS.bodyBytes + 128;

/** Canonical HTTP loopback origin at the listener's effective port. */
export function isOperationsMcpOrigin(originHeader: string, localPort: number | undefined): boolean {
  try {
    const origin = new URL(originHeader);
    return origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
      && (origin.port || "80") === String(localPort) && origin.origin === originHeader;
  } catch { return false; }
}

/** Mounted on the separate MCP listener. Each handle owns exactly one SDK pair. */
export function createOperationsMcp(options: {
  runtime: OperationsHttpRuntime;
  limits?: { bodyBytes?: number; responseBytes?: number; deadlineMs?: number; maxInFlight?: number };
}) {
  const { runtime } = options, limits = { ...OPERATIONS_HTTP_LIMITS, ...options.limits };
  // The structured DTO costs at most 1x; its JSON-string text copy at most
  // 2x (quotes/backslashes escaped). The two string delimiters are framing.
  const envelopeBytes = 3 * limits.responseBytes + OPERATIONS_MCP_ENVELOPE_OVERHEAD;
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
        const minted = await runtime.mint("mcp", presentedCredentials(request, "refuse"), null, { signal: abort.signal });
        refuse(minted.ok ? failure("unauthenticated", "unknown_mode") : minted.error); return;
      }
      // Fail closed for browser Origins. The canonical loopback origin must match
      // the local socket port; a supplied Host is never an authority for this check.
      if (request.headers.origin !== undefined && !isOperationsMcpOrigin(request.headers.origin, request.socket.localPort)) {
        refuse(failure("forbidden", "origin_forbidden")); return;
      }
      // MCP never promotes a token carried by a legacy secret header. The
      // shared classifier preserves raw multiplicity for the acceptance table.
      validateOperationsSingletonHeaders(request, ["accept", "mcp-protocol-version"]);
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) throw new BoundaryError(400, "invalid_request");
      // Same bearer order as HTTP: strict bounded body, then admitted mint.
      const deadline = runtime.supported ? runtime.runtime.now() + limits.deadlineMs : 0;
      const body = parseStrictJson(await readBoundedBody(request, { limit: limits.bodyBytes, timeoutMs: limits.deadlineMs, signal: abort.signal }), limits.json);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new BoundaryError(400, "invalid_request");
      const minted = await runtime.mint("mcp", presentedCredentials(request, "refuse"), null, { signal: abort.signal });
      if (!minted.ok) { refuse(minted.error); return; }
      if (!runtime.supported) { refuse(failure("unauthenticated", "unknown_mode")); return; }
      const operation = runtime.registry.get("session.describe");
      if (!operation) { refuse(failure("not_found", "operation_not_found")); return; }
      const releaseOptions = { eligible: () => !closing && runtime.eligible(), connected, deadline, signal: abort.signal };
      // This witness also gates initialize, listing and notifications. It is never
      // sent for those methods, but must still match at the real Node commit.
      let snapshot: { readonly serialized: string; readonly canonical: string } | undefined;
      const initial = await runtime.runner.readRelease(operation, minted.context, {}, { ...releaseOptions,
        commit(dto) {
          const serialized = JSON.stringify(dto);
          if (Buffer.byteLength(serialized) > limits.responseBytes) {
            // Match HTTP: commit one refusal inside admission, before SDK dispatch.
            // Throwing here would be remapped to release_commit_failed by the runner.
            operationsFailure(response, failure("payload_too_large", "response_too_large")); return;
          }
          snapshot = Object.freeze({ serialized, canonical: canonicalJson(dto) });
        } });
      if (initial.status !== "committed") { refuse(initial.error); return; }
      if (!snapshot) return;
      const context = Object.freeze({ authentication: minted.context, ...snapshot });
      // A project tool's own result: released DTO text, or its public refusal as a tool error.
      const target = projectToolCall(body as Record<string, unknown>);
      // A holder, not a local: closures set it, and control-flow narrowing must not assume null.
      const tool$: { result: ToolResult | null } = { result: null };
      const toolValue = (dto: object) => {
        const serialized = JSON.stringify(dto);
        // The DTO alone may not exceed the response ceiling; the envelope bound applies after the SDK.
        tool$.result = Buffer.byteLength(serialized) > limits.responseBytes
          ? Object.freeze({ ok: false as const, error: failure("payload_too_large", "response_too_large") })
          : Object.freeze({ ok: true as const, serialized, canonical: canonicalJson(dto) });
      };
      let dispatched = false;
      const dispatch = async (): Promise<{ status: number; buffer: Buffer }> => {
        if (dispatched) throw new OperationError("internal", "invalid_operation");
        dispatched = true;
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        server = new Server({ name: "worktree-control-operations", version: "1" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: OPERATIONS_MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
        server.setRequestHandler(CallToolRequestSchema, async call => {
          try {
            if (call.params.name === "session_describe") {
              // Delegate input validation to the registered operation, not a transport schema.
              operation.parse(call.params.arguments);
              return { content: [{ type: "text", text: context.serialized }], structuredContent: JSON.parse(context.serialized) };
            }
            // Only the tool this body names was run, and only its own released result is returned.
            const result = tool$.result;
            if (!target || call.params.name !== target.tool.name || result === null) throw new OperationError("not_found", "operation_not_found");
            if (!result.ok) {
              const payload = { error: result.error };
              return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
            }
            return { content: [{ type: "text", text: result.serialized }], structuredContent: JSON.parse(result.serialized) };
          } catch (error) {
            const payload = { error: publicError(error) };
            return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
          }
        });
        // Bound messages sent via send before Response allocation. SDK protocol
        // errors bypass send, so also bound the buffered Response. This is NOT release.
        let rejectOutput!: (error: unknown) => void;
        const outputFailure = new Promise<never>((_, reject) => { rejectOutput = reject; });
        void outputFailure.catch(() => undefined);
        const send = transport.send.bind(transport);
        transport.send = async (...args) => {
          if (Buffer.byteLength(JSON.stringify(args[0])) > envelopeBytes) {
            const error = new OperationError("payload_too_large", "response_too_large"); rejectOutput(error); throw error;
          }
          return send(...args);
        };
        await Promise.race([server.connect(transport), cancelled]);
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
              if (bytes > envelopeBytes) { await reader.cancel(); throw new OperationError("payload_too_large", "response_too_large"); }
              chunks.push(chunk.value);
            }
          } finally { reader.releaseLock(); }
        }
        return { status: sdk.status, buffer: Buffer.concat(chunks) };
      };
      // No await, SDK send, or network drain inside admission. SDK security or
      // session headers cannot replace this boundary's response headers.
      const write = (output: { status: number; buffer: Buffer }) => () => { writeOperationsResponse(response, output.status, output.buffer.toString("utf8")); };
      // The final write of everything but a project tool's own success is gated by the describe witness.
      const describedRelease = async () => {
        const output = await dispatch();
        const released = await runtime.runner.readRelease(operation, context.authentication, {}, {
          ...releaseOptions, expectedCanonical: context.canonical, commit: write(output) });
        if (released.status !== "committed") refuse(released.error);
      };
      const tool = target ? runtime.registry.get(target.tool.operation) : undefined;
      if (!target || !tool) { await describedRelease(); return; }
      if (tool.kind === "query") {
        // Discovery runs once. The SDK envelope is built from the value of a fresh
        // decision, and written only after another fresh decision re-projects it unchanged.
        let output: { status: number; buffer: Buffer } | undefined;
        const released = await runtime.runner.queryRelease(tool, context.authentication, target.arguments, {
          ...releaseOptions,
          async stage(value: object) { toolValue(value); output = await dispatch(); },
          commit() { if (output) write(output)(); },
        });
        if (released.status === "committed") return;
        if (dispatched) { refuse(released.error); return; }
        tool$.result = Object.freeze({ ok: false as const, error: released.error });
        await describedRelease(); return;
      }
      const first = await runtime.runner.readRelease(tool, context.authentication, target.arguments, { ...releaseOptions, commit: toolValue });
      if (first.status !== "committed") tool$.result = Object.freeze({ ok: false as const, error: first.error });
      const succeeded = tool$.result;
      if (!succeeded?.ok) { await describedRelease(); return; }
      const output = await dispatch();
      // A fresh read of the same tool must project exactly the value the envelope carries.
      const released = await runtime.runner.readRelease(tool, context.authentication, target.arguments, {
        ...releaseOptions, expectedCanonical: succeeded.canonical, commit: write(output) });
      if (released.status !== "committed") refuse(released.error);
    } catch (error) {
      refuse(operationsRequestFailure(error, abort.signal, timedOut));
    } finally {
      // All application reads are awaited before SDK dispatch. SDK handlers are
      // finite and perform no async work. close aborts its protocol bookkeeping;
      // notably SDK close does not settle an abandoned JSON response promise.
      try { await server?.close(); }
      catch { /* Disposal errors are contained; the committed response cannot be replaced. */ }
      finally {
        // A close that never settles retains ownership. A rejection must still
        // wait for real Node completion and remove every request-owned resource.
        try { await completed; }
        finally {
          clearTimeout(timer); cancellations.delete(cancel);
          request.off("aborted", cancel); request.off("error", cancel);
          response.off("finish", finish); response.off("close", closed);
        }
      }
    }
  };
  return {
    claims(request: IncomingMessage) { return path(request).claimed; },
    handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      // Match HTTP's fixed preflight: before path/method, slot, body or admission.
      if (presentedCredentials(request, "refuse").providerSession) {
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
