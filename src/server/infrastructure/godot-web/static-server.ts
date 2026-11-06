import { constants, watch, type FSWatcher } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative } from "node:path";

import { LIVE_RELOAD_SCRIPT, placeholderPage } from "./live-reload-client";
import { GENERATION_ID, SERVED_EXTENSIONS, SERVED_MIME_TYPES, SERVED_SEGMENT } from "./served-files";

export interface GodotWebServerOptions {
  /** The project's public store directory: `state.json` and `generations/<id>/`. */
  root: string;
  worktreeKey: string;
  liveReload: boolean;
  /** Send COOP/COEP so thread-enabled exports can use SharedArrayBuffer in a secure context. */
  isolation: boolean;
  maxEventClients?: number;
  pollMs?: number;
  heartbeatMs?: number;
}

/** What a served page may learn: an opaque generation ID and coarse build state. */
export interface ServedState {
  generation: string | null;
  publishedAt: string | null;
  build: "idle" | "queued" | "building" | "failed";
  failureCode: string | null;
}

const MAX_URL_LENGTH = 2048;
const MAX_SEGMENTS = 9;
const IMMUTABLE = "public, max-age=31536000, immutable";
const LIVE_RELOAD_TAG = '<script src="/__wtc/live-reload.js" defer></script>';

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function sameState(left: ServedState, right: ServedState): boolean {
  return left.generation === right.generation && left.build === right.build && left.failureCode === right.failureCode;
}

/**
 * Serves only completed, controller-published generations of one project.
 * It holds no controller credentials and exposes no control endpoint.
 */
export class GodotWebStaticServer {
  readonly server: Server;
  private state: ServedState = { generation: null, publishedAt: null, build: "idle", failureCode: null };
  private readonly clients = new Set<ServerResponse>();
  private watcher: FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private stateMtime = -1;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly options: GodotWebServerOptions) {
    this.server = createServer((request, response) => { void this.handle(request, response); });
  }

  get currentState(): ServedState { return this.state; }
  get eventClients(): number { return this.clients.size; }

  async listen(port: number, host: string): Promise<void> {
    await this.refresh();
    try {
      this.watcher = watch(this.options.root, { persistent: false }, (_event, name) => {
        if (name === null || String(name) === "state.json") void this.refresh();
      });
      this.watcher.on("error", () => { this.watcher?.close(); this.watcher = null; });
    } catch { /* The bounded poll below still observes publication. */ }
    this.poll = setInterval(() => { void this.refresh(); }, this.options.pollMs ?? 1_000);
    this.poll.unref();
    this.heartbeat = setInterval(() => { for (const client of this.clients) client.write(": ping\n\n"); }, this.options.heartbeatMs ?? 25_000);
    this.heartbeat.unref();
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => { this.server.off("error", reject); resolve(); });
    });
  }

  async close(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
    if (this.poll) clearInterval(this.poll);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.poll = this.heartbeat = null;
    for (const client of this.clients) client.end();
    this.clients.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Re-reads the published pointer; a generation for another worktree or a missing directory is not served. */
  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      const path = join(this.options.root, "state.json");
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs === this.stateMtime) return;
      this.stateMtime = info?.mtimeMs ?? -1;
      let next: ServedState = { generation: null, publishedAt: null, build: "idle", failureCode: null };
      try {
        const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        const generation = typeof raw.generation === "string" && GENERATION_ID.test(raw.generation)
          && raw.worktreeKey === this.options.worktreeKey ? raw.generation : null;
        const exists = generation ? Boolean(await stat(join(this.options.root, "generations", generation)).catch(() => null)) : false;
        const build = raw.build === "queued" || raw.build === "building" || raw.build === "failed" ? raw.build : "idle";
        next = {
          generation: exists ? generation : null,
          publishedAt: exists && typeof raw.publishedAt === "string" ? raw.publishedAt : null,
          build,
          failureCode: build === "failed" && typeof raw.failureCode === "string" && /^[a-z_]{1,40}$/.test(raw.failureCode) ? raw.failureCode : null,
        };
      } catch { /* No pointer yet: placeholder page until the first publication. */ }
      if (sameState(next, this.state)) return;
      this.state = next;
      this.broadcast();
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private broadcast(): void {
    const message = `event: state\ndata: ${JSON.stringify(this.state)}\n\n`;
    for (const client of this.clients) {
      if (!client.write(message)) { this.clients.delete(client); client.destroy(); }
    }
  }

  private headers(cache: string, type?: string): Record<string, string> {
    return {
      "Cache-Control": cache,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      ...(this.options.isolation ? { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } : {}),
      ...(type ? { "Content-Type": type } : {}),
    };
  }

  private plain(response: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
    const body = Buffer.from(`${text}\n`);
    response.writeHead(status, { ...this.headers("no-store", "text/plain; charset=utf-8"), "Content-Length": String(body.length), ...extra });
    response.end(response.req.method === "HEAD" ? undefined : body);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return this.plain(response, 405, "Method not allowed", { Allow: "GET, HEAD" });
      const target = request.url ?? "/";
      if (target.length > MAX_URL_LENGTH) return this.plain(response, 414, "URI too long");
      let url: URL;
      try { url = new URL(target, "http://godot-web.invalid"); } catch { return this.plain(response, 400, "Bad request"); }
      const path = url.pathname;
      if (path === "/" || path === "/index.html") return this.entry(request, response, url);
      if (path === "/__wtc/state") return this.body(response, 200, this.headers("no-store", "application/json; charset=utf-8"), Buffer.from(JSON.stringify(this.state)));
      if (path === "/__wtc/live-reload.js") return this.body(response, 200, this.headers("no-cache", "text/javascript; charset=utf-8"), Buffer.from(LIVE_RELOAD_SCRIPT));
      if (path === "/__wtc/events") return this.events(request, response);
      if (path.startsWith("/g/")) return await this.generationFile(request, response, path);
      return this.plain(response, 404, "Not found");
    } catch {
      if (!response.headersSent) this.plain(response, 500, "Internal error");
      else response.destroy();
    }
  }

  private entry(request: IncomingMessage, response: ServerResponse, url: URL): void {
    if (this.state.generation) {
      // Pin every resource of this page load to one immutable generation.
      response.writeHead(302, { ...this.headers("no-store"), Location: `/g/${this.state.generation}/${url.search}`, "Content-Length": "0" });
      response.end();
      return;
    }
    this.body(response, 200, this.headers("no-store", "text/html; charset=utf-8"), Buffer.from(placeholderPage(this.options.liveReload)));
  }

  private events(request: IncomingMessage, response: ServerResponse): void {
    if (!this.options.liveReload) return this.plain(response, 404, "Not found");
    if (request.method === "HEAD") return this.body(response, 200, this.headers("no-store", "text/event-stream"), Buffer.alloc(0));
    if (this.clients.size >= (this.options.maxEventClients ?? 32)) return this.plain(response, 503, "Too many live-reload clients", { "Retry-After": "10" });
    response.writeHead(200, { ...this.headers("no-store", "text/event-stream; charset=utf-8"), Connection: "keep-alive" });
    response.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(this.state)}\n\n`);
    this.clients.add(response);
    const release = () => this.clients.delete(response);
    request.once("close", release);
    response.once("close", release);
  }

  private async generationFile(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const raw = path.slice(3).split("/");
    if (raw.length > MAX_SEGMENTS + 1) return this.plain(response, 404, "Not found");
    let segments: string[];
    try { segments = raw.map((segment) => decodeURIComponent(segment)); } catch { return this.plain(response, 400, "Bad request"); }
    const [generation, ...rest] = segments;
    if (!GENERATION_ID.test(generation)) return this.plain(response, 404, "Not found");
    if (rest.length === 0) {
      response.writeHead(301, { ...this.headers("no-store"), Location: `/g/${generation}/`, "Content-Length": "0" });
      response.end();
      return;
    }
    if (rest.at(-1) === "") rest[rest.length - 1] = "index.html";
    if (!rest.every((segment) => SERVED_SEGMENT.test(segment))) return this.plain(response, 404, "Not found");
    const extension = extname(rest.at(-1)!).toLowerCase();
    if (!SERVED_EXTENSIONS.has(extension)) return this.plain(response, 404, "Not found");
    const directory = join(this.options.root, "generations", generation);
    const root = await realpath(directory).catch(() => null);
    // Pruned or foreign generation: the page should reload from "/".
    if (!root) return this.plain(response, 410, "Generation no longer available");
    const file = join(root, ...rest);
    const resolved = await realpath(file).catch(() => null);
    if (!resolved || !inside(root, resolved) || resolved !== file) return this.plain(response, 404, "Not found");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    if (!handle) return this.plain(response, 404, "Not found");
    try {
      const info = await handle.stat();
      if (!info.isFile()) return this.plain(response, 404, "Not found");
      const type = SERVED_MIME_TYPES[extension];
      if (extension === ".html") {
        let html = (await handle.readFile()).toString("utf8");
        if (this.options.liveReload && rest.length === 1) html = injectLiveReload(html);
        return this.body(response, 200, this.headers("no-cache", type), Buffer.from(html));
      }
      response.writeHead(200, { ...this.headers(IMMUTABLE, type), "Content-Length": String(info.size) });
      if (request.method === "HEAD") { response.end(); return; }
      await new Promise<void>((resolve) => {
        const stream = handle.createReadStream({ autoClose: false });
        stream.once("error", () => { response.destroy(); resolve(); });
        response.once("close", () => { stream.destroy(); resolve(); });
        stream.once("end", () => resolve());
        stream.pipe(response);
      });
    } finally { await handle.close(); }
  }

  private body(response: ServerResponse, status: number, headers: Record<string, string>, body: Buffer): void {
    response.writeHead(status, { ...headers, "Content-Length": String(body.length) });
    response.end(response.req.method === "HEAD" ? undefined : body);
  }
}

export function injectLiveReload(html: string): string {
  const head = html.search(/<\/head\s*>/i);
  return head >= 0 ? `${html.slice(0, head)}${LIVE_RELOAD_TAG}${html.slice(head)}` : `${html}${LIVE_RELOAD_TAG}`;
}
