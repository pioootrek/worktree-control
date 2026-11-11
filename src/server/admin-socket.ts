import { decodeProviderJson } from "./authentication-provider-configuration";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { dirname } from "node:path";
import { createHttpServerCloser } from "./http-server-lifecycle";
import { ProviderAdminError, providerAdminErrorBody, parseStrictProviderJson } from "./modules/authentication";

const BODY_LIMIT = 16 * 1024;
/** Project commands carry Godot Web configuration files of up to 64 KiB plus the command envelope. */
const PROJECT_BODY_LIMIT = 96 * 1024;

export interface AdminSocketServer {
  server: Server;
  close(): Promise<void>;
}

/** A failed listener cleanup still has an owner; callers must join it before releasing storage. */
export class AdminSocketStartupError extends Error {
  constructor(readonly owner: AdminSocketServer) { super("Admin listener cleanup is unconfirmed."); }
}

/**
 * Local administration channel for a running controller. Operating-system permissions are the
 * credential: a 0700 directory and a 0600 socket, reachable only by the controller's user.
 */
export async function listenAdminSocket(
  path: string,
  execute: (request: unknown) => unknown,
): Promise<AdminSocketServer> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  removeStaleSocket(path);
  const accepted = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const pending = (async () => {
      const reply = (status: number, body: unknown) => {
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify(body));
      };
      if (request.url !== "/auth" || request.method !== "POST") return reply(404, { error: "Unknown admin operation." });
      if (closing || accepted.size >= 32) return reply(503, { error: "Admin operation unavailable." });
      let provider = false;
      const deadline = setTimeout(() => { request.destroy(); }, 10_000);
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += (chunk as Buffer).length;
          if (size > PROJECT_BODY_LIMIT) throw new ProviderAdminError("invalid_input");
          chunks.push(chunk as Buffer);
        }
        clearTimeout(deadline);
        let body: unknown;
        try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw new ProviderAdminError("invalid_input"); }
        const projectCommand = typeof body === "object" && body !== null && "command" in body && body.command === "project";
        if (size > BODY_LIMIT && !projectCommand) throw new ProviderAdminError("invalid_input");
        provider = typeof body === "object" && body !== null && "command" in body && body.command === "auth-provider";
        if (provider) body = decodeProviderJson(Buffer.concat(chunks));
        else if (typeof body === "object" && body !== null && "command" in body && body.command === "identity-admin") {
          // Identity ceilings can contain 64 project scopes. Keep the socket's
          // 16KiB body bound and strict duplicate-key parsing without imposing
          // the provider configuration's smaller 8KiB/128-field envelope.
          try { body = parseStrictProviderJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), { maxDepth: 8, maxFields: 1024 }); }
          catch { throw new ProviderAdminError("invalid_input"); }
        }
        const result = await execute(body);
        if (provider && Buffer.byteLength(JSON.stringify(result)) > BODY_LIMIT) throw new ProviderAdminError("provider_failed");
        reply(200, { result });
      } catch (error) {
        if (provider || error instanceof ProviderAdminError) return reply(400, providerAdminErrorBody(error));
        const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
        reply(400, { ...(code ? { code } : {}), error: error instanceof Error ? error.message : String(error) });
      } finally { clearTimeout(deadline); }
    })();
    accepted.add(pending);
    const forget = () => { accepted.delete(pending); };
    pending.then(forget, forget);
  });
  const closeServer = createHttpServerCloser(server);
  const owner: AdminSocketServer = {
    server,
    close() {
      closing ??= Promise.resolve().then(async () => {
        await closeServer();
        // A disconnected response does NOT cancel its accepted command or initialization.
        await Promise.allSettled([...accepted]);
        removeStaleSocket(path);
      });
      return closing;
    },
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => { server.off("error", reject); resolve(); });
    });
    chmodSync(path, 0o600);
    return owner;
  } catch (error) {
    try { await owner.close(); } catch { throw new AdminSocketStartupError(owner); }
    throw error;
  }
}

/** Only the lock holder calls this, so a leftover socket belongs to a dead controller. */
function removeStaleSocket(path: string): void {
  try {
    if (!lstatSync(path).isSocket()) throw new Error(`Refusing to replace non-socket file at ${path}.`);
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export class AdminRequestError extends Error {
  constructor(readonly code: string | undefined, message: string, readonly committed?: true, readonly cleanupConfirmed?: false) {
    super(message);
    this.name = "AdminRequestError";
  }
}

/** Sends one request to a running controller's admin socket. */
export function requestAdminSocket(path: string, body: unknown, timeoutMs = 15_000, maxResponseBytes?: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = httpRequest({
      socketPath: path,
      path: "/auth",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: timeoutMs,
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("error", reject);
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (maxResponseBytes !== undefined && bytes > maxResponseBytes) {
          reject(Object.assign(new Error("Admin response is too large."), { code: "admin_response_limit" }));
          response.destroy(); request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { result?: unknown; code?: string; error?: string; committed?: unknown; cleanupConfirmed?: unknown };
          if (response.statusCode === 200) resolve(value.result);
          else reject(new AdminRequestError(value.code, value.error ?? `Admin request failed with HTTP ${response.statusCode}.`,
            value.committed === true ? true : undefined, value.cleanupConfirmed === false ? false : undefined));
        } catch (error) {
          reject(error);
        }
      });
    });
    // A finite probe must also bound a server that keeps sending small chunks.
    const timedOut = () => {
      reject(Object.assign(new Error("Admin request timed out."), maxResponseBytes === undefined ? {} : { code: "admin_timeout" }));
      request.destroy();
    };
    const deadline = maxResponseBytes === undefined ? undefined : setTimeout(timedOut, timeoutMs);
    request.once("close", () => { if (deadline) clearTimeout(deadline); });
    request.on("timeout", timedOut);
    request.on("error", reject);
    request.end(payload);
  });
}
