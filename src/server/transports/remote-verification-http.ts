import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { IdentityService } from "@/server/modules/identity";
import type { RemoteVerificationController, RemoteWorkerTransport } from "@/server/modules/remote-verification";
import { remotePollResultSchema, remotePollSchema, remoteReportEnvelopeSchema, type RemoteWorkerReport } from "@/shared/contracts/remote-verification";
import { createHttpServerCloser } from "@/server/http-server-lifecycle";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Dedicated worker-only listener; HTTPS is mandatory except an explicit loopback fixture. */
export function createRemoteVerificationServer(options: {
  controller: RemoteVerificationController;
  identity: Pick<IdentityService, "authenticateBearer">;
  tls?: { key: Buffer; cert: Buffer };
  allowLoopbackHttpFixture?: boolean;
}) {
  if (!options.tls && !options.allowLoopbackHttpFixture) throw new Error("remote_https_required");
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (!options.tls && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) return json(response, 403, { error: "loopback_fixture_only" });
    if (request.headers.origin) return json(response, 403, { error: "origin_forbidden" });
    if (request.method !== "POST") return json(response, 405, { error: "method_not_allowed" });
    if (request.url !== "/remote-verification/v1/poll" && request.url !== "/remote-verification/v1/report") return json(response, 404, { error: "protocol_not_found" });
    let actor;
    const token = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "";
    try {
      actor = options.identity.authenticateBearer(token);
      if (actor.authenticationMethod !== "worker_token") throw new Error("worker_token_required");
    } catch { return json(response, 401, { error: "worker_authentication_required" }); }
    try {
      const input = await body(request);
      actor = options.identity.authenticateBearer(token);
      if (request.url.endsWith("/poll")) {
        const poll = remotePollSchema.parse(input);
        json(response, 200, options.controller.poll(poll.workerId, actor));
      } else {
        const report = remoteReportEnvelopeSchema.parse(input);
        json(response, 200, { version: 1, ...options.controller.report(report.workerId, report.report, actor) });
      }
    } catch { json(response, 400, { error: "remote_protocol_rejected" }); }
  };
  const listener = (request: IncomingMessage, response: ServerResponse) => { void handle(request, response).catch(() => { if (!response.headersSent) json(response, 500, { error: "remote_protocol_failed" }); else response.destroy(); }); };
  const server = options.tls ? createHttpsServer(options.tls, listener) : createHttpServer(listener);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 32;
  return { server, close: createHttpServerCloser(server) };
}

export class HttpRemoteWorkerTransport implements RemoteWorkerTransport {
  private readonly origin: string;
  constructor(origin: string, private readonly workerId: string, private readonly token: () => string, allowLoopbackHttpFixture = false) {
    const url = new URL(origin);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("invalid_remote_origin");
    if (url.protocol !== "https:" && !(allowLoopbackHttpFixture && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("remote_https_required");
    this.origin = url.origin;
  }
  async poll() { return remotePollResultSchema.parse(await this.post("poll", { version: 1, workerId: this.workerId })); }
  async report(report: RemoteWorkerReport): Promise<void> {
    const result = await this.post("report", { version: 1, workerId: this.workerId, report }) as { version?: unknown; acceptedSequence?: unknown };
    if (result.version !== 1 || result.acceptedSequence !== report.sequence) throw new Error("report_not_acknowledged");
  }
  private async post(operation: string, input: unknown): Promise<unknown> {
    const response = await fetch(`${this.origin}/remote-verification/v1/${operation}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${this.token()}`, "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("remote_request_rejected"); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("remote_response_missing");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > MAX_BODY_BYTES) throw new Error("remote_response_too_large");
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
}
