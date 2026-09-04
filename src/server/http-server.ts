import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

import type { DashboardResponse, McpStatus } from "@/shared/contracts";
import { ControlService } from "./control-service";
import { localeFrom } from "../i18n/messages";
import { localizeServerMessage } from "../i18n/server-errors";
import { DirectoryBrowser } from "./directory-browser";
import { EventStream } from "./events";

const JSON_LIMIT = 64 * 1024;
const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

type JsonRecord = Record<string, unknown>;

function strictRecord(value: unknown, allowed: readonly string[]): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Oczekiwano obiektu JSON.");
  const record = value as JsonRecord;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error("Żądanie zawiera nieobsługiwane pole.");
  return record;
}

function requiredString(record: JsonRecord, key: string, max: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`Nieprawidłowe pole ${key}.`);
  return value;
}

function optionalString(record: JsonRecord, key: string, max: number): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) throw new Error(`Nieprawidłowe pole ${key}.`);
  return value;
}

function parseAddProject(value: unknown) {
  const record = strictRecord(value, ["name", "repositoryPath", "port"]);
  const port = record.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Nieprawidłowe pole port.");
  return { name: requiredString(record, "name", 80), repositoryPath: requiredString(record, "repositoryPath", 4096), port };
}

function parseOperation(value: unknown): {
  operation: "start" | "stop" | "restart" | "switch";
  worktreePath?: string;
} {
  const record = strictRecord(value, ["operation", "worktreePath"]);
  const operation = record.operation;
  if (operation !== "start" && operation !== "stop" && operation !== "restart" && operation !== "switch") throw new Error("Nieprawidłowa operacja.");
  return { operation, worktreePath: optionalString(record, "worktreePath", 4096) };
}

function parseTlsSettings(value: unknown): {
  mode: "off" | "generated" | "custom";
  keyPath: string | null;
  certPath: string | null;
  caPath: string | null;
} {
  const record = strictRecord(value, ["mode", "keyPath", "certPath", "caPath"]);
  const mode = record.mode;
  if (mode !== "off" && mode !== "generated" && mode !== "custom") throw new Error("Nieprawidłowy tryb HTTPS.");
  const nullablePath = (key: string): string | null => {
    const value = record[key];
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || value.length > 4096) throw new Error(`Nieprawidłowe pole ${key}.`);
    return value;
  };
  return { mode, keyPath: nullablePath("keyPath"), certPath: nullablePath("certPath"), caPath: nullablePath("caPath") };
}

function parseCapacitySettings(value: unknown): { enabled: boolean; limit: number } {
  const record = strictRecord(value, ["enabled", "limit"]);
  if (typeof record.enabled !== "boolean") throw new Error("Nieprawidłowe pole enabled.");
  if (!Number.isInteger(record.limit) || (record.limit as number) < 1 || (record.limit as number) > 64) {
    throw new Error("Limit serwerów musi być liczbą całkowitą od 1 do 64.");
  }
  return { enabled: record.enabled, limit: record.limit as number };
}

function parseEnvironment(value: unknown): Record<string, string> {
  const record = strictRecord(value, ["environment"]);
  const environment = record.environment;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) throw new Error("Nieprawidłowe pole environment.");
  return environment as Record<string, string>;
}

function parseEnvironmentProfile(value: unknown): { name: string; environment: Record<string, string>; restart: boolean } {
  const record = strictRecord(value, ["name", "environment", "restart"]);
  const environment = record.environment;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) throw new Error("Nieprawidłowe pole environment.");
  if (record.restart !== undefined && typeof record.restart !== "boolean") throw new Error("Nieprawidłowe pole restart.");
  return { name: requiredString(record, "name", 40), environment: environment as Record<string, string>, restart: record.restart === true };
}

function parseProfileSelection(value: unknown): { name: string; restart: boolean } {
  const record = strictRecord(value, ["name", "restart"]);
  if (record.restart !== undefined && typeof record.restart !== "boolean") throw new Error("Nieprawidłowe pole restart.");
  return { name: requiredString(record, "name", 40), restart: record.restart === true };
}

function parseStorageRefresh(value: unknown): { worktreePath: string } {
  const record = strictRecord(value, ["worktreePath"]);
  return { worktreePath: requiredString(record, "worktreePath", 4096) };
}

function parseCacheDeletion(value: unknown): { worktreePath: string; cache: "next" } {
  const record = strictRecord(value, ["worktreePath", "cache"]);
  if (record.cache !== "next") throw new Error("Nieprawidłowy katalog pamięci podręcznej.");
  return { worktreePath: requiredString(record, "worktreePath", 4096), cache: record.cache };
}

function parseReservation(value: unknown): {
  action: "acquire" | "release" | "force-release";
  worktreePath?: string;
  reason?: string;
} {
  const record = strictRecord(value, ["action", "worktreePath", "reason"]);
  const action = record.action;
  if (action !== "acquire" && action !== "release" && action !== "force-release") throw new Error("Nieprawidłowa operacja blokady.");
  return {
    action,
    worktreePath: optionalString(record, "worktreePath", 4096),
    reason: optionalString(record, "reason", 240),
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > JSON_LIMIT) throw new Error("Żądanie jest zbyt duże.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Nieprawidłowy JSON.");
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function messageFrom(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function localizedDashboard(dashboard: DashboardResponse, locale: "pl" | "en"): DashboardResponse {
  if (locale === "pl") return dashboard;
  return {
    ...dashboard,
    projects: dashboard.projects.map((snapshot) => ({
      ...snapshot,
      discoveryError: snapshot.discoveryError
        ? localizeServerMessage(snapshot.discoveryError, locale)
        : undefined,
      runtime: {
        ...snapshot.runtime,
        error: snapshot.runtime.error ? localizeServerMessage(snapshot.runtime.error, locale) : null,
      },
    })),
  };
}

export interface ControllerServer {
  server: Server;
  close(): Promise<void>;
}

function hasValidToken(request: IncomingMessage, url: URL, expected: string): boolean {
  const header = request.headers["x-worktree-switcher-token"];
  const supplied = typeof header === "string"
    ? header
    : url.pathname === "/api/events"
      ? url.searchParams.get("token")
      : null;
  if (!supplied) return false;
  const actualBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function hasValidOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && parsed.host === request.headers.host;
  } catch {
    return false;
  }
}

export function createControllerServer(options: {
  service: ControlService;
  directoryBrowser: DirectoryBrowser;
  events: EventStream;
  mcpStatus: () => McpStatus;
  webRoot: string;
  host: string;
  port: number;
  accessToken: string;
}): ControllerServer {
  const fallbackOrigin = `http://${options.host}:${options.port}`;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", request.headers.host ? `http://${request.headers.host}` : fallbackOrigin);
    const locale = localeFrom(request.headers["accept-language"]);
    try {
      if (url.pathname.startsWith("/api/")) {
        response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
        if (!hasValidToken(request, url, options.accessToken)) {
          json(response, 401, { error: localizeServerMessage("Brak prawidłowego klucza dostępu.", locale) });
          return;
        }
        if (request.method !== "GET" && !hasValidOrigin(request)) {
          json(response, 403, { error: localizeServerMessage("Odrzucono żądanie z obcego originu.", locale) });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/dashboard") {
          json(response, 200, {
            ...localizedDashboard(await options.service.dashboard(), locale),
            mcp: options.mcpStatus(),
          });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/metrics") {
          json(response, 200, options.service.runtimeMetrics());
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/directories") {
          json(response, 200, await options.directoryBrowser.list(
            url.searchParams.get("path") ?? undefined,
            url.searchParams.get("files") === "certificates",
          ));
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/events") {
          response.writeHead(200, {
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "Content-Type": "text/event-stream",
          });
          options.events.add(response);
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/projects") {
          const project = await options.service.addProject(parseAddProject(await readJson(request)));
          options.events.publish();
          json(response, 201, { project });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/settings/capacity") {
          const capacity = options.service.setServerCapacity(parseCapacitySettings(await readJson(request)));
          options.events.publish();
          json(response, 200, { capacity });
          return;
        }
        const operationMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/operation$/);
        if (request.method === "POST" && operationMatch) {
          const input = parseOperation(await readJson(request));
          await options.service.operate(decodeURIComponent(operationMatch[1]), input.operation, input.worktreePath);
          options.events.publish();
          json(response, 200, { ok: true });
          return;
        }
        const tlsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/tls$/);
        if (request.method === "POST" && tlsMatch) {
          await options.service.setProjectTls(
            decodeURIComponent(tlsMatch[1]),
            parseTlsSettings(await readJson(request)),
          );
          options.events.publish();
          json(response, 200, { ok: true });
          return;
        }
        const environmentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/environment$/);
        if (request.method === "POST" && environmentMatch) {
          const project = options.service.setProjectEnvironment(
            decodeURIComponent(environmentMatch[1]),
            parseEnvironment(await readJson(request)),
          );
          options.events.publish();
          json(response, 200, { project });
          return;
        }
        const profilesMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/environment-profiles$/);
        if (request.method === "POST" && profilesMatch) {
          const input = parseEnvironmentProfile(await readJson(request));
          const project = await options.service.saveEnvironmentProfile(
            decodeURIComponent(profilesMatch[1]), input.name, input.environment, "local-user", input.restart,
          );
          options.events.publish();
          json(response, 200, { project });
          return;
        }
        if (request.method === "DELETE" && profilesMatch) {
          const input = parseProfileSelection(await readJson(request));
          const project = options.service.deleteEnvironmentProfile(decodeURIComponent(profilesMatch[1]), input.name);
          options.events.publish();
          json(response, 200, { project });
          return;
        }
        const profileSelectionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/environment-profile-selection$/);
        if (request.method === "POST" && profileSelectionMatch) {
          const input = parseProfileSelection(await readJson(request));
          const project = await options.service.selectEnvironmentProfile(
            decodeURIComponent(profileSelectionMatch[1]), input.name, "local-user", input.restart,
          );
          options.events.publish();
          json(response, 200, { project });
          return;
        }
        const storageRefreshMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/storage\/refresh$/);
        if (request.method === "POST" && storageRefreshMatch) {
          const input = parseStorageRefresh(await readJson(request));
          await options.service.refreshWorktreeStorage(decodeURIComponent(storageRefreshMatch[1]), input.worktreePath);
          json(response, 202, { queued: true });
          return;
        }
        const cacheMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/storage\/cache$/);
        if (request.method === "DELETE" && cacheMatch) {
          const input = parseCacheDeletion(await readJson(request));
          const result = await options.service.deleteWorktreeCache(decodeURIComponent(cacheMatch[1]), input.worktreePath, input.cache);
          json(response, 200, result);
          return;
        }
        const reservationMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/reservation$/);
        if (request.method === "POST" && reservationMatch) {
          const projectId = decodeURIComponent(reservationMatch[1]);
          const input = parseReservation(await readJson(request));
          if (input.action === "acquire") {
            if (!input.worktreePath) throw new Error("Wybierz worktree do zablokowania.");
            await options.service.reserve({
              projectId,
              worktreePath: input.worktreePath,
              kind: "human",
              owner: "local-user",
              reason: input.reason,
            });
          } else {
            await options.service.release(projectId, input.action === "force-release");
          }
          options.events.publish();
          json(response, 200, { ok: true });
          return;
        }
        json(response, 404, { error: localizeServerMessage("Nie znaleziono endpointu.", locale) });
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end();
        return;
      }
      serveStatic(options.webRoot, url.pathname, response, request.method === "HEAD");
    } catch (error) {
      const rawMessage = messageFrom(error);
      const conflict = /zajęty|zablokowany|osiągnięto limit|UNIQUE constraint/i.test(rawMessage);
      const message = localizeServerMessage(rawMessage, locale);
      json(response, conflict ? 409 : 400, { error: message });
    }
  });

  return {
    server,
    async close() {
      options.events.close();
      if (!server.listening) return;
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => error ? reject(error) : resolveClose());
      });
    },
  };
}

function serveStatic(webRoot: string, pathname: string, response: ServerResponse, headOnly: boolean): void {
  const root = resolve(webRoot);
  const decoded = decodeURIComponent(pathname);
  const relative = normalize(decoded).replace(/^[/\\]+/, "");
  let candidate = resolve(root, relative || "index.html");
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end();
    return;
  }
  if (existsSync(candidate) && statSync(candidate).isDirectory()) candidate = join(candidate, "index.html");
  if (!existsSync(candidate) && !extname(candidate)) candidate = join(candidate, "index.html");
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  response.writeHead(200, {
    "Cache-Control": extname(candidate) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    "Content-Type": MIME_TYPES[extname(candidate)] ?? "application/octet-stream",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  if (headOnly) response.end();
  else createReadStream(candidate).pipe(response);
}
