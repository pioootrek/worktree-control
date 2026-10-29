import { EventEmitter } from "node:events";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";

/** Exercise Node's installed request handler without listening or reserving a port. */
export function request(server: Server, path: string, token: string, body?: string, options: { autoFinish?: boolean; destroyed?: boolean } = {}) {
  const incoming = Object.assign(new PassThrough(), { method: "POST", url: path, headers: { host: "controller.test", authorization: `Bearer ${token}` }, socket: { remoteAddress: "127.0.0.1" } });
  const headers = new Map<string, unknown>();
  let status = 0, ended = false;
  let finish!: (value: { status: number; headers: Map<string, unknown>; body: Record<string, unknown> }) => void;
  const completed = new Promise<{ status: number; headers: Map<string, unknown>; body: Record<string, unknown> }>(resolve => { finish = resolve; });
  const events = new EventEmitter();
  const response = Object.assign(events, {
    headersSent: false,
    destroyed: options.destroyed ?? false,
    writableFinished: false,
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); },
    writeHead(code: number, values: Record<string, unknown> = {}) { status = code; this.headersSent = true; for (const [name, value] of Object.entries(values)) headers.set(name.toLowerCase(), value); return this; },
    end(value: string) { ended = true; finish({ status, headers, body: JSON.parse(value) }); if (options.autoFinish !== false) { this.writableFinished = true; events.emit("finish"); } },
    destroy() { throw new Error("Unexpected destroyed proof response"); },
  });
  server.emit("request", incoming as unknown as IncomingMessage, response as unknown as ServerResponse);
  if (body !== undefined) incoming.end(body);
  return { completed, send: (value: string) => incoming.end(value),
    finish: () => { response.writableFinished = true; events.emit("finish"); },
    disconnect: () => { response.destroyed = true; events.emit("close"); },
    get ended() { return ended; } };
}
