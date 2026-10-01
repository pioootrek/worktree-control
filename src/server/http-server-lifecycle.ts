import type { Server } from "node:http";

/** Drain accepted responses; keep-alive polling cannot keep a closing listener open. */
export function createHttpServerCloser(server: Server): () => Promise<void> {
  let closing = false, completion: Promise<void> | null = null;
  server.on("request", (_request, response) => {
    if (closing && !response.headersSent) response.setHeader("Connection", "close");
    response.once("finish", () => { if (closing) server.closeIdleConnections(); });
  });
  return () => {
    if (completion) return completion;
    closing = true;
    completion = !server.listening ? Promise.resolve() : new Promise<void>((accept, reject) => { server.close(error => error ? reject(error) : accept()); });
    return completion;
  };
}
