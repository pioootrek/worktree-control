import { request, type ClientRequest, type IncomingMessage, type Server } from "node:http";
import { createConnection, type AddressInfo } from "node:net";

export const operationRoute = "/api/operations/session.describe";
export type Headers = Record<string, string> | string[];
// The driver preserves unknown wire payloads; scenarios validate the relevant DTO fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Reply = { status: number; body: Record<string, any>; headers: IncomingMessage["headers"] };
export type RequestOptions = { path?: string; method?: string; headers?: Headers; body?: string | Buffer; slow?: boolean };
export type WireReply = { status: number; body: string };
export type BoundaryDriver = ReturnType<typeof createBoundaryDriver>;

/** Only mounted transports belong here. Capacity is observed through saturation,
 * not a second counter or access to the listener's private accepted-work set. */
export function createBoundaryDriver(options: {
  kind: "api" | "unix"; server: Server; socketPath?: string; close(): Promise<void>;
  legacyPath: string; acceptedCredentials: readonly string[];
}) {
  const address = () => options.socketPath ? { socketPath: options.socketPath }
    : { hostname: "127.0.0.1", port: (options.server.address() as AddressInfo).port };
  const send = (input: RequestOptions = {}) => {
    let call!: ClientRequest;
    const reply = new Promise<Reply>((resolve, reject) => {
      call = request({ ...address(), path: input.path ?? operationRoute, method: input.method ?? "POST",
        headers: input.headers ?? { "Content-Type": "application/json" } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
        response.on("end", () => {
          try { resolve({ status: response.statusCode!, headers: response.headers,
            body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {} }); } catch (error) { reject(error); }
        });
      });
      call.on("error", reject);
      if (input.slow) { call.flushHeaders(); call.write("{"); } else call.end(input.body ?? "{}");
    });
    void reply.catch(() => undefined); // Cancellation scenarios explicitly await their expected reset.
    return { call, reply };
  };
  return {
    ...options, capacity: 32, send,
    capacityProbe: () => send().reply,
    connection: () => createConnection(options.socketPath ? { path: options.socketPath, allowHalfOpen: true }
      : { port: (options.server.address() as AddressInfo).port, host: "127.0.0.1", allowHalfOpen: true }),
    wire(path: string, method = "GET", upgrade = false): Promise<WireReply> {
      return new Promise((resolve, reject) => {
        const call = request({ ...address(), path, method, headers: { "Content-Type": "application/json",
          ...(upgrade ? { Connection: "Upgrade, HTTP2-Settings", Upgrade: "h2c", "HTTP2-Settings": "" } : {}) } }, res => {
          const chunks: Buffer[] = [];
          res.on("data", chunk => chunks.push(chunk)); res.on("error", reject);
          res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
        });
        call.setTimeout(2000, () => call.destroy(new Error("Wire response timed out")));
        call.on("error", reject); call.end(method === "POST" ? '{"command":"status"}' : undefined);
      });
    },
  };
}

/** A failure is data with an exact assertion identity. Mutant tests accept only
 * this type AND these values; network, parse, setup and earlier assertion errors escape. */
export class ConformanceFailure extends Error {
  constructor(readonly assertion: string, readonly observed: unknown, readonly expected: unknown) {
    super(`${assertion}: observed ${JSON.stringify(observed)}; expected ${JSON.stringify(expected)}`);
  }
}
export function conform(assertion: string, observed: unknown, expected: unknown): void {
  if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new ConformanceFailure(assertion, observed, expected);
}
