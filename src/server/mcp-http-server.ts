import { McpDiagnostics, type McpCloseReason } from "./mcp-diagnostics";
import { timingSafeEqual } from "node:crypto";
import { createHttpServerCloser } from "./http-server-lifecycle";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ControlService } from "./control-service";
import { resolveControllerAuthentication, type ControllerAuthenticationDependencies } from "./modules/authentication";
import type { ControllerAuthentication, IdentityService } from "./modules/identity";
import { knowledgeRequestLimit } from "@/shared/contracts/knowledge";

const BODY_LIMIT = 1024 * 1024;
const ATTACHMENT_BODY_LIMIT = knowledgeRequestLimit("create_attachment") + 16 * 1024;
const MANIFEST_BODY_LIMIT = knowledgeRequestLimit("check_attachment_batch") + 16 * 1024;

interface McpRuntimeLike {
  handle(request: IncomingMessage, response: ServerResponse, authentication: ControllerAuthentication, body?: unknown): Promise<void>;
  close(reason?: McpCloseReason): Promise<void>;
  diagnosticsSnapshot(): unknown;
}

export interface McpControllerServer {
  server: Server;
  /** Ends every MCP session so clients must reconnect under the current authentication policy. */
  closeSessions(): Promise<void>;
  diagnosticsSnapshot(): Promise<unknown>;
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
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  authentication?: ControllerAuthenticationDependencies["authentication"];
  onDiagnostic?: (message: string, details?: Record<string, unknown>) => void;
}): McpControllerServer {
  const diagnostics = new McpDiagnostics();
  let runtimePromise: Promise<McpRuntimeLike> | null = null;
  const runtime = () => {
    runtimePromise ??= import("./mcp-runtime").then(({ McpRuntime }) => new McpRuntime(
      options.service,
      options.onDiagnostic,
      options.identity,
      diagnostics,
    ));
    return runtimePromise;
  };

  const server = createServer((request, response) => {
    void (async () => {
      if (request.url !== "/mcp") return jsonError(response, 404, "MCP endpoint not found.");
      const authentication = authenticate(request, options.accessToken, options);
      if (!authentication) return jsonError(response, 401, "A valid MCP bearer token is required.");
      if (!validOrigin(request, options.port)) return jsonError(response, 403, "The request origin was rejected.");
      if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
        response.setHeader("Allow", "POST, GET, DELETE");
        return jsonError(response, 405, "Method not allowed.");
      }
      try {
        const body = request.method === "POST" ? await readJson(request) : undefined;
        const currentRuntime = await runtime();
        const currentAuthentication = authenticate(request, options.accessToken, options);
        if (!currentAuthentication) return jsonError(response, 401, "A valid MCP bearer token is required.");
        await currentRuntime.handle(request, response, currentAuthentication, body);
      } catch (error) {
        options.onDiagnostic?.("mcp.request_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!response.headersSent) jsonError(response, 500, "MCP request failed.");
      }
    })();
  });

  server.on("connection", socket => {
    diagnostics.connection(1);
    socket.once("close", () => diagnostics.connection(-1));
  });
  const closeServer = createHttpServerCloser(server);
  return {
    server,
    async diagnosticsSnapshot() {
      return runtimePromise ? (await runtimePromise).diagnosticsSnapshot() : { ...diagnostics.snapshot(), runtimeRetryEntries: 0 };
    },
    async closeSessions() {
      if (runtimePromise) await (await runtimePromise).close("authentication-policy");
    },
    async close() {
      if (runtimePromise) await (await runtimePromise).close();
      await closeServer();
    },
  };
}
