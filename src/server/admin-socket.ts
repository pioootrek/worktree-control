import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { dirname } from "node:path";

const BODY_LIMIT = 16 * 1024;

export interface AdminSocketServer {
  server: Server;
  close(): Promise<void>;
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
  const server = createServer((request, response) => {
    void (async () => {
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify(body));
      };
      if (request.url !== "/auth" || request.method !== "POST") return reply(404, { error: "Unknown admin operation." });
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += (chunk as Buffer).length;
          if (size > BODY_LIMIT) throw new Error("Admin request is too large.");
          chunks.push(chunk as Buffer);
        }
        reply(200, { result: await execute(JSON.parse(Buffer.concat(chunks).toString("utf8"))) });
      } catch (error) {
        const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
        reply(400, { ...(code ? { code } : {}), error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  chmodSync(path, 0o600);
  return {
    server,
    async close() {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      removeStaleSocket(path);
    },
  };
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
  constructor(readonly code: string | undefined, message: string) {
    super(message);
    this.name = "AdminRequestError";
  }
}

/** Sends one request to a running controller's admin socket. */
export function requestAdminSocket(path: string, body: unknown, timeoutMs = 15_000): Promise<unknown> {
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
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { result?: unknown; code?: string; error?: string };
          if (response.statusCode === 200) resolve(value.result);
          else reject(new AdminRequestError(value.code, value.error ?? `Admin request failed with HTTP ${response.statusCode}.`));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Admin request timed out.")));
    request.on("error", reject);
    request.end(payload);
  });
}
