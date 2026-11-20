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

/**
 * Routes a body that names a project tool away from the describe witness. Only a
 * routing hint: the SDK stays the protocol authority, and project work starts
 * only when the SDK dispatches that tool's call. Session describe keeps its own path.
 */
function projectToolHint(body: Record<string, unknown>): ToolDescriptor | null {
  const own = (value: unknown, key: string): unknown => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  if (own(body, "method") !== "tools/call") return null;
  const name = own(own(body, "params"), "name");
  return OPERATIONS_MCP_TOOLS.find(each => each.name === name && each.operation !== "session.describe") ?? null;
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
    // Settles a project tool's handler left unanswered by its release, so the SDK's work stays finite.
    let abandon: (() => void) | undefined;
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
      const message = body as Record<string, unknown>;
      // From here a refusal is a JSON-RPC error carrying the request's ID.
      const engage = () => { rpcId = typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined; engaged = true; };
      // The one CallTool handler asks this for the called tool's released result. It
      // never runs application work: the request's own release supplies the answer.
      let answer: (name: string, args: unknown) => Promise<ToolResult> = async () => { throw new OperationError("not_found", "operation_not_found"); };
      let dispatched = false;
      /** Opens this request's one SDK pair and hands it the body. Resolves with the SDK's Response, bounded at send. */
      const dispatch = async (engageOnConnect: boolean): Promise<Response> => {
        if (dispatched) throw new OperationError("internal", "invalid_operation");
        dispatched = true;
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        server = new Server({ name: "worktree-control-operations", version: "1" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: OPERATIONS_MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
        server.setRequestHandler(CallToolRequestSchema, async call => {
          try {
            const result = await answer(call.params.name, call.params.arguments);
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
        if (engageOnConnect) engage();
        // Do not forward identity/session/resumption headers to the SDK. Version and
        // media negotiation are the only request headers it needs in stateless mode.
        const headers = new Headers({ "content-type": "application/json", accept: request.headers.accept ?? "" });
        if (request.headers["mcp-protocol-version"]) headers.set("mcp-protocol-version", String(request.headers["mcp-protocol-version"]));
        return Promise.race([transport.handleRequest(new Request("http://operations.invalid/mcp/operations", { method: "POST", headers, signal: abort.signal }), { parsedBody: body }), outputFailure, cancelled]);
      };
      /** Buffers the SDK's Response within the envelope bound. */
      const collect = async (sdk: Response): Promise<{ status: number; buffer: Buffer }> => {
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
      /**
       * The describe witness: the current public DTO, captured in an admitted phase.
       * Initialize, listing, notifications, session_describe and every body the SDK
       * answers without dispatching a project tool are written only after a final
       * readRelease reproduces it. An oversized DTO commits one refusal here, as on HTTP.
       */
      const witness = async (): Promise<{ readonly serialized: string; readonly canonical: string } | undefined> => {
        let snapshot: { readonly serialized: string; readonly canonical: string } | undefined;
        const initial = await runtime.runner.readRelease(operation, minted.context, {}, { ...releaseOptions,
          commit(dto) {
            const serialized = JSON.stringify(dto);
            if (Buffer.byteLength(serialized) > limits.responseBytes) {
              // Throwing here would be remapped to release_commit_failed by the runner.
              operationsFailure(response, failure("payload_too_large", "response_too_large")); return;
            }
            snapshot = Object.freeze({ serialized, canonical: canonicalJson(dto) });
          } });
        if (initial.status !== "committed") { refuse(initial.error); return undefined; }
        return snapshot;
      };
      const releaseWitnessed = async (snapshot: { readonly canonical: string }, output: { status: number; buffer: Buffer }) => {
        const released = await runtime.runner.readRelease(operation, minted.context, {}, {
          ...releaseOptions, expectedCanonical: snapshot.canonical, commit: write(output) });
        if (released.status !== "committed") refuse(released.error);
      };
      const hint = projectToolHint(message);
      const tool = hint ? runtime.registry.get(hint.operation) : undefined;
      if (!hint || !tool) {
        // Initialize, listing, notifications and session_describe: the witness precedes SDK dispatch.
        const snapshot = await witness();
        if (!snapshot) return;
        answer = async (name, args) => {
          if (name !== "session_describe") throw new OperationError("not_found", "operation_not_found");
          // Delegate input validation to the registered operation, not a transport schema.
          operation.parse(args);
          return Object.freeze({ ok: true as const, ...snapshot });
        };
        await releaseWitnessed(snapshot, await collect(await dispatch(true)));
        return;
      }
      // A project tool. The SDK decides first: only its dispatch of this tool's call,
      // with the arguments it parsed, starts the tool's release. Neither the describe
      // witness nor any project work precedes that, so a describe failure cannot
      // refuse a targeted read and a protocol rejection never reaches Git.
      let settle: { resolve(result: ToolResult): void; reject(error: unknown): void } | undefined;
      let enter!: (args: unknown) => void;
      const entered = new Promise<{ arguments: unknown }>(resolve => { enter = args => resolve({ arguments: args }); });
      answer = (name, args) => {
        if (name !== hint.name || settle) return Promise.reject(new OperationError("not_found", "operation_not_found"));
        return new Promise<ToolResult>((resolve, reject) => {
          settle = { resolve, reject };
          abandon = () => { reject(new OperationError("unavailable", "request_cancelled", { retry: "retry" })); };
          engage(); enter(args);
        });
      };
      const sdk = dispatch(false);
      void sdk.catch(() => undefined);
      const first = await Promise.race([entered, sdk.then(answered => ({ answered }))]);
      if ("answered" in first) {
        // The SDK answered without dispatching the tool (negotiation, protocol or
        // parameter refusal, or a notification): no project work, describe witness.
        const snapshot = await witness();
        if (!snapshot) return;
        engage();
        await releaseWitnessed(snapshot, await collect(first.answered));
        return;
      }
      // A project tool's answer, success or refusal, is released by that tool alone: its envelope is
      // built outside admission and written only inside a fresh admitted phase of the same tool and
      // arguments that reproduces it. The describe witness plays no part, so a change of unrelated
      // authority never replaces the tool's own answer.
      let output: { status: number; buffer: Buffer } | undefined, staged = false;
      const stageTool = async (result: ToolResult) => {
        // One envelope per request: the handler is answered once, by this request's own release.
        if (!settle || staged) throw new OperationError("internal", "invalid_operation");
        staged = true;
        settle.resolve(result);
        output = await collect(await sdk);
      };
      const commitTool = () => { if (!output) throw new OperationError("internal", "invalid_operation"); write(output)(); };
      // The DTO alone may not exceed the response ceiling; the envelope bound applies after the SDK.
      const toolValue = (dto: object): { result: ToolResult; canonical: string } => {
        const serialized = JSON.stringify(dto), canonical = canonicalJson(dto);
        return Buffer.byteLength(serialized) > limits.responseBytes
          ? { result: Object.freeze({ ok: false as const, error: failure("payload_too_large", "response_too_large") }), canonical }
          : { result: Object.freeze({ ok: true as const, serialized, canonical }), canonical };
      };
      const refusal = { stage: (error: PublicOperationError) => stageTool(Object.freeze({ ok: false as const, error })), commit: commitTool };
      if (tool.kind === "query") {
        // Discovery runs once. The envelope is built from the value of a fresh decision and
        // written only after another fresh decision re-projects it unchanged.
        const released = await runtime.runner.queryRelease(tool, minted.context, first.arguments, {
          ...releaseOptions, refusal, async stage(value: object) { await stageTool(toolValue(value).result); }, commit: commitTool });
        if (released.status !== "committed") refuse(released.error);
        return;
      }
      // A holder, not a local: the commit closure sets it, and narrowing must not assume undefined.
      const first$: { value?: { result: ToolResult; canonical: string } } = {};
      const read = await runtime.runner.readRelease(tool, minted.context, first.arguments, {
        ...releaseOptions, refusal, commit(dto) { first$.value = toolValue(dto); } });
      if (read.status !== "committed") { refuse(read.error); return; }
      // Committed without a value: the tool's refusal was written.
      const value = first$.value;
      if (!value) return;
      await stageTool(value.result);
      // A fresh read of the same tool must project exactly the value the envelope carries.
      const released = await runtime.runner.readRelease(tool, minted.context, first.arguments, {
        ...releaseOptions, expectedCanonical: value.canonical, commit: commitTool });
      if (released.status !== "committed") refuse(released.error);
    } catch (error) {
      refuse(operationsRequestFailure(error, abort.signal, timedOut));
    } finally {
      // All application reads are awaited by this function, never by the SDK. A
      // project tool's handler waits only for this request's own answer, settled
      // here at the latest. close aborts its protocol bookkeeping; notably SDK
      // close does not settle an abandoned JSON response promise.
      abandon?.();
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
