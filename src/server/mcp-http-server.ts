import { createOperationsMcp } from "./transports/operations-mcp";
import { operationsFailure, type OperationsHttpRuntime } from "./transports/operations-http";
import { containsProviderCookie } from "@/shared/contracts/authentication";
import type { DevVaultOperations } from "./modules/dev-vault";
import type { McpDiagnosticsSnapshot } from "@/shared/contracts/mcp-diagnostics";
import { McpDiagnostics, type McpCloseReason } from "./mcp-diagnostics";
import { timingSafeEqual } from "node:crypto";
import { createHttpServerCloser } from "./http-server-lifecycle";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ControlService } from "./control-service";
import { admissionOf, databaseAdmissionFailure } from "./database-admission";
import { resolveControllerAuthentication, type ControllerAuthenticationDependencies } from "./modules/authentication";
import type { ControllerAuthentication, IdentityService } from "./modules/identity";
import { knowledgeRequestLimit } from "@/shared/contracts/knowledge";
import { McpSessionGovernor, type McpSessionClock, type McpSessionLimits } from "./modules/mcp-sessions";

const BODY_LIMIT = 1024 * 1024;
const ATTACHMENT_BODY_LIMIT = knowledgeRequestLimit("create_attachment") + 16 * 1024;
const MANIFEST_BODY_LIMIT = knowledgeRequestLimit("check_attachment_batch") + 16 * 1024;

interface McpRuntimeLike {
  handle(request: IncomingMessage, response: ServerResponse, authentication: ControllerAuthentication, body?: unknown): Promise<void>;
  close(reason?: McpCloseReason): Promise<void>;
  diagnosticsSnapshot(): McpDiagnosticsSnapshot;
}

export interface McpControllerServer {
  server: Server;
  /** Ends every MCP session so clients must reconnect under the current authentication policy. */
  closeSessions(): Promise<void>;
  stopOperations(): void;
  mountOperations(runtime: OperationsHttpRuntime): void;
  diagnosticsSnapshot(): Promise<McpDiagnosticsSnapshot>;
  close(): Promise<void>;
}

function authenticate(
  request: IncomingMessage,
  expected: string,
  dependencies: ControllerAuthenticationDependencies,
): ControllerAuthentication | null {
  const header = request.headers.authorization;
  // Open mode needs no header; every other mode rejects a missing bearer in the resolver.
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  return resolveControllerAuthentication(dependencies, {
    bearer: token,
    legacySecretValid: () => {
      if (token === null) return false;
      const supplied = Buffer.from(token);
      const expectedBuffer = Buffer.from(expected);
      return supplied.length === expectedBuffer.length && timingSafeEqual(supplied, expectedBuffer);
    },
  });
}

function validOrigin(request: IncomingMessage, port: number): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:"
      && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]")
      && parsed.port === String(port);
  } catch {
    return false;
  }
}

function jsonError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > ATTACHMENT_BODY_LIMIT) throw new Error("MCP request is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("MCP request JSON is invalid."); }
  const limit = body?.method === "tools/call" && body?.params?.name === "knowledge_create_attachment" ? ATTACHMENT_BODY_LIMIT
    : body?.method === "tools/call" && body?.params?.name === "knowledge_check_attachment_batch" ? MANIFEST_BODY_LIMIT : BODY_LIMIT;
  if (size > limit) throw new Error("MCP request is too large.");
  return body;
}

export function createMcpControllerServer(options: {
  service: ControlService;
  port: number;
  accessToken: string;
  identity?: Pick<IdentityService, "authenticateBearer" | "describeIdentity">;
  devVault?: DevVaultOperations;
  authentication?: ControllerAuthenticationDependencies["authentication"];
  onDiagnostic?: (message: string, details?: Record<string, unknown>) => void;
  /** Session admission, idle and renewal limits; defaults apply to omitted values. */
  sessionLimits?: Partial<McpSessionLimits>;
  /** Timer port for session policy; tests supply a manual clock. */
  sessionClock?: McpSessionClock;
  operations?: OperationsHttpRuntime;
}): McpControllerServer {
  let operationsRuntime = options.operations;
  let operations = operationsRuntime ? createOperationsMcp({ runtime: operationsRuntime }) : null;
  let stopped = false, completion: Promise<void> | undefined, policyClose: Promise<void> | undefined;
  const stopOperations = () => { stopped = true; operations?.stop(); };
  const diagnostics = new McpDiagnostics();
  const governor = new McpSessionGovernor(options.sessionLimits, options.sessionClock);
  let runtimePromise: Promise<McpRuntimeLike> | null = null;
  const runtime = () => {
    runtimePromise ??= import("./transports/mcp/mcp-runtime").then(({ McpRuntime }) => new McpRuntime(
      options.service,
      options.onDiagnostic,
      options.identity,
      diagnostics,
      governor,
      options.devVault,
    ));
    return runtimePromise;
  };

  // Authentication is admitted on its own; each tool call or resource read is admitted by the runtime.
  // SSE streams and body reads hold no admission.
  const admission = admissionOf(options.service);
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    void (async () => {
      // Claim the raw namespace before legacy routing or authentication. The
      // neighbour's Origin check and the adapter's stricter check both apply.
      if (operations?.claims(request)) {
        if (!validOrigin(request, options.port)) {
          operationsFailure(response, { category: "forbidden", status: 403, reason: "origin_forbidden", retry: "none", effect: null });
          return;
        }
        await operations.handle(request, response); return;
      }
      if (request.url !== "/mcp") return jsonError(response, 404, "MCP endpoint not found.");
      if (options.authentication?.mode() === "better-auth" &&
        (request.headers["x-worktree-control-token"] !== undefined || request.headers["x-worktree-switcher-token"] !== undefined)) {
        return jsonError(response, 401, "A valid MCP bearer token is required.");
      }
      // This transport is not converted to provider sessions. Never promote a cookie in open mode.
      if (containsProviderCookie(request.headers.cookie)) return jsonError(response, 401, "Provider sessions are unavailable on this transport.");
      let authentication;
      try { authentication = await admission.run(() => authenticate(request, options.accessToken, options)); }
      catch (error) {
        const failure = databaseAdmissionFailure(error);
        if (!failure) return jsonError(response, 500, "MCP request failed.");
        if (failure.retryable) response.setHeader("Retry-After", "1");
        return jsonError(response, failure.status, "The controller database is unavailable; retry the request.");
      }
      if (!authentication) return jsonError(response, 401, "A valid MCP bearer token is required.");
      if (!validOrigin(request, options.port)) return jsonError(response, 403, "The request origin was rejected.");
      if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
        response.setHeader("Allow", "POST, GET, DELETE");
        return jsonError(response, 405, "Method not allowed.");
      }
      try {
        const body = request.method === "POST" ? await readJson(request) : undefined;
        const currentRuntime = await runtime();
        const currentAuthentication = await admission.run(() => authenticate(request, options.accessToken, options));
        if (!currentAuthentication) return jsonError(response, 401, "A valid MCP bearer token is required.");
        await currentRuntime.handle(request, response, currentAuthentication, body);
      } catch (error) {
        options.onDiagnostic?.("mcp.request_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        const failure = databaseAdmissionFailure(error);
        if (!response.headersSent) {
          if (failure?.retryable) response.setHeader("Retry-After", "1");
          jsonError(response, failure?.status ?? 500, failure ? "The controller database is unavailable; retry the request." : "MCP request failed.");
        }
      }
    })();
  });

  server.on("connection", socket => {
    diagnostics.connection(1);
    socket.once("close", () => diagnostics.connection(-1));
  });
  const closeServer = createHttpServerCloser(server);
  return {
    server, stopOperations,
    mountOperations(runtime) {
      if (server.listening || operations || stopped || completion) throw new Error("mcp_operations_already_configured");
      operationsRuntime = runtime;
      operations = createOperationsMcp({ runtime });
    },
    async diagnosticsSnapshot() {
      return runtimePromise ? (await runtimePromise).diagnosticsSnapshot() : { ...diagnostics.snapshot(), sessions: [], runtimeRetryEntries: 0, ...governor.describe() };
    },
    closeSessions() {
      if (policyClose) return policyClose;
      // Fence before the first await. Keep this owner installed until its real
      // work settles; no replacement may let capacity escape the drain.
      const owner = operations;
      owner?.stop();
      const drained = (owner?.drain() ?? Promise.resolve()).then(() => {
        if (!stopped && operationsRuntime) operations = createOperationsMcp({ runtime: operationsRuntime });
      });
      // Legacy failure must not strand the request owner. Join both sides before
      // permitting another policy attempt, even when legacy cleanup fails first.
      policyClose = Promise.allSettled([
        drained,
        runtimePromise?.then(runtime => runtime.close("authentication-policy")),
      ]).then(results => {
        for (const result of results) if (result.status === "rejected") throw result.reason;
      });
      const current = policyClose;
      const clear = () => { if (policyClose === current) policyClose = undefined; };
      void current.then(clear, clear);
      return current;
    },
    close() {
      stopOperations();
      // One shutdown attempt/result for all callers. Preserve legacy ordering:
      // a failed runtime close propagates without starting listener close.
      return completion ??= Promise.allSettled([
        (async () => {
          if (runtimePromise) await (await runtimePromise).close();
          await closeServer();
        })(),
        operations?.drain(), policyClose,
      ]).then(results => {
        for (const result of results) if (result.status === "rejected") throw result.reason;
      });
    },
  };
}
