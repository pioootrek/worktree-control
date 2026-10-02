import { handleBackupHttp } from "./transports/backup-http";
import { createHttpServerCloser } from "./http-server-lifecycle";
import { BackupError, type BackupOperations, type RestoreOperations } from "./modules/backups";
import { KnowledgeError, knowledgeFailure } from "./modules/knowledge";
import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

import type { DashboardLiveResponse, DashboardResponse, DashboardSection, LaunchPreset, McpStatus, ProjectSnapshot, TestEnvironmentMode, TestEnvironmentProfile } from "@/shared/contracts";
import { ControlService } from "./control-service";
import { localeFrom } from "../i18n/messages";
import { localizeServerMessage } from "../i18n/server-errors";
import { DirectoryBrowser } from "./directory-browser";
import { EventStream } from "./events";
import { resolveControllerAuthentication, type ControllerAuthenticationDependencies } from "./modules/authentication";
import { IdentityError, type AuthenticatedPrincipal, type ControllerAuthentication, type IdentityService, type KnowledgePermission } from "./modules/identity";

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
  const record = strictRecord(value, ["name", "repositoryPath", "port", "launchPreset"]);
  const port = record.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Nieprawidłowe pole port.");
  const launchPreset = record.launchPreset ?? "auto";
  if (launchPreset !== "auto" && launchPreset !== "node" && launchPreset !== "django") throw new Error("Nieprawidłowy preset uruchomienia.");
  return {
    name: requiredString(record, "name", 80),
    repositoryPath: requiredString(record, "repositoryPath", 4096),
    port,
    launchPreset: launchPreset as LaunchPreset,
  };
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

function parseTestQueueSettings(value: unknown): { limit: number } {
  const record = strictRecord(value, ["limit"]);
  if (!Number.isInteger(record.limit) || (record.limit as number) < 1 || (record.limit as number) > 16) {
    throw new Error("Limit równoległych testów musi być liczbą całkowitą od 1 do 16.");
  }
  return { limit: record.limit as number };
}

function parseTestRun(value: unknown): { worktreePath: string; presetId: string } {
  const record = strictRecord(value, ["worktreePath", "presetId"]);
  return {
    worktreePath: requiredString(record, "worktreePath", 4096),
    presetId: requiredString(record, "presetId", 160),
  };
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

interface TestProfileInput {
  name: string;
  environment: Record<string, string>;
  mode: TestEnvironmentMode;
  serverProfile: string | null;
  nodeEnv: TestEnvironmentProfile["nodeEnv"];
  requiredVariables: string[];
}

function parseTestEnvironmentProfile(value: unknown): TestProfileInput {
  const record = strictRecord(value, ["name", "environment", "mode", "serverProfile", "nodeEnv", "requiredVariables"]);
  const environment = record.environment;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) throw new Error("Nieprawidłowe pole environment.");
  const mode = record.mode === undefined ? "clean" : record.mode;
  if (mode !== "clean" && mode !== "inherit-server-profile") throw new Error("Nieprawidłowe pole mode.");
  const nodeEnv = record.nodeEnv === undefined || record.nodeEnv === null ? null : record.nodeEnv;
  if (nodeEnv !== null && !["development", "production", "test"].includes(nodeEnv as string)) throw new Error("Nieprawidłowe pole nodeEnv.");
  const requiredVariables = record.requiredVariables === undefined ? [] : record.requiredVariables;
  if (!Array.isArray(requiredVariables) || requiredVariables.some((entry) => typeof entry !== "string")) throw new Error("Nieprawidłowe pole requiredVariables.");
  const serverProfile = record.serverProfile === undefined || record.serverProfile === null ? null : record.serverProfile;
  if (serverProfile !== null && typeof serverProfile !== "string") throw new Error("Nieprawidłowe pole serverProfile.");
  return {
    name: requiredString(record, "name", 40),
    environment: environment as Record<string, string>,
    mode,
    serverProfile,
    nodeEnv: nodeEnv as TestEnvironmentProfile["nodeEnv"],
    requiredVariables: requiredVariables as string[],
  };
}

function parseTestPresetProfile(value: unknown): { presetId: string; name: string | null } {
  const record = strictRecord(value, ["presetId", "name"]);
  const name = record.name === undefined || record.name === null ? null : record.name;
  if (name !== null && typeof name !== "string") throw new Error("Nieprawidłowe pole name.");
  return { presetId: requiredString(record, "presetId", 160), name: name as string | null };
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

async function readRequestJson(request: IncomingMessage, limit = JSON_LIMIT): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("Żądanie jest zbyt duże.");
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

function localizedProjectSnapshot(snapshot: ProjectSnapshot, locale: "pl" | "en"): ProjectSnapshot {
  if (locale === "pl") return snapshot;
  return {
      ...snapshot,
      discoveryError: snapshot.discoveryError
        ? localizeServerMessage(snapshot.discoveryError, locale)
        : undefined,
      runtime: {
        ...snapshot.runtime,
        error: snapshot.runtime.error ? localizeServerMessage(snapshot.runtime.error, locale) : null,
      },
      testPresets: snapshot.testPresets.map((entry) => ({
        ...entry,
        error: entry.error ? localizeServerMessage(entry.error, locale) : null,
      })),
      testRuns: snapshot.testRuns.map((run) => ({
        ...run,
        error: run.error ? localizeServerMessage(run.error, locale) : null,
      })),
  };
}

function localizedDashboard(dashboard: DashboardResponse, locale: "pl" | "en"): DashboardResponse {
  if (locale === "pl") return dashboard;
  return {
    ...dashboard,
    projects: dashboard.projects.map((snapshot) => localizedProjectSnapshot(snapshot, locale)),
  };
}

function parseLiveQuery(url: URL): { projectIds: string[]; sections: DashboardSection[] } {
  const projectIds = [...new Set(url.searchParams.getAll("project"))];
  const sections = [...new Set(url.searchParams.getAll("section"))] as DashboardSection[];
  const allowed: DashboardSection[] = ["runtime", "reservation", "tests", "storage", "controller"];
  if (projectIds.length > 128 || projectIds.some((id) => !id || id.length > 160)) throw new Error("Nieprawidłowa lista projektów.");
  if (sections.length === 0 || sections.some((section) => !allowed.includes(section))) throw new Error("Nieprawidłowy zakres odświeżenia.");
  return { projectIds, sections };
}

function localizedLive(response: DashboardLiveResponse, locale: "pl" | "en"): DashboardLiveResponse {
  if (locale === "pl") return response;
  return {
    ...response,
    projects: response.projects.map((project) => ({
      ...project,
      runtime: project.runtime ? {
        ...project.runtime,
        error: project.runtime.error ? localizeServerMessage(project.runtime.error, locale) : null,
      } : undefined,
      testRuns: project.testRuns?.map((run) => ({
        ...run,
        error: run.error ? localizeServerMessage(run.error, locale) : null,
      })),
    })),
  };
}

export interface ControllerServer {
  server: Server;
  close(): Promise<void>;
}

function hasValidToken(request: IncomingMessage, expected: string): boolean {
  const header = request.headers["x-worktree-switcher-token"];
  const supplied = typeof header === "string" ? header : null;
  if (!supplied) return false;
  const actualBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

function identityAdministration(
  service: IdentityService,
  actor: AuthenticatedPrincipal,
  value: unknown,
): unknown {
  const record = strictRecord(value, ["action", "principalId", "credentialId", "projectId", "label", "expiresAt", "name", "permissions", "sessionLifetimeSeconds"]);
  const action = requiredString(record, "action", 80);
  switch (action) {
    case "renew-owner": {
      const lifetime = record.sessionLifetimeSeconds;
      if (lifetime !== undefined && typeof lifetime !== "number") throw new Error("Nieprawidłowe pole sessionLifetimeSeconds.");
      return service.renewOwnerSession({
        label: optionalString(record, "label", 120),
        sessionLifetimeSeconds: lifetime,
      }, actor);
    }
    case "create-agent":
      return { principal: service.createAgent(actor) };
    case "list-agents":
      return { principals: service.listAgents(actor) };
    case "revoke-agent":
      return { principal: service.revokeAgent(requiredString(record, "principalId", 160), actor) };
    case "issue-agent-token":
      return service.issueAgentToken({
        principalId: requiredString(record, "principalId", 160),
        label: requiredString(record, "label", 120),
        expiresAt: optionalString(record, "expiresAt", 40),
      }, actor);
    case "list-agent-tokens":
      return { credentials: service.listAgentCredentials(requiredString(record, "principalId", 160), actor) };
    case "revoke-token":
      service.revokeCredential(requiredString(record, "credentialId", 160), actor);
      return { revoked: true };
    case "create-knowledge-project":
      return { project: service.createKnowledgeProject({ name: requiredString(record, "name", 120) }, actor) };
    case "grant-knowledge": {
      if (!Array.isArray(record.permissions) || record.permissions.some((permission) => typeof permission !== "string")) {
        throw new Error("Nieprawidłowe pole permissions.");
      }
      return { grant: service.setKnowledgeGrant({
        principalId: requiredString(record, "principalId", 160),
        projectId: requiredString(record, "projectId", 160),
        permissions: record.permissions as KnowledgePermission[],
      }, actor) };
    }
    case "list-knowledge-grants":
      return { grants: service.listKnowledgeGrants(requiredString(record, "principalId", 160), actor) };
    case "revoke-knowledge-grant":
      return { grant: service.revokeKnowledgeGrant(
        requiredString(record, "principalId", 160), requiredString(record, "projectId", 160), actor,
      ) };
    default:
      throw new Error("Nieobsługiwana operacja zarządzania tożsamością.");
  }
}

function hasValidOrigin(request: IncomingMessage, publicOrigin?: string): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (publicOrigin) return parsed.origin === publicOrigin && parsed.href === `${parsed.origin}/`;
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
  identity?: IdentityService;
  authentication?: ControllerAuthenticationDependencies["authentication"];
  publicOrigin?: string;
  backups?: BackupOperations;
  restores?: RestoreOperations;
  maintenance?: () => boolean;
}): ControllerServer {
  const readJson = async (request: IncomingMessage, limit?: number): Promise<unknown> => {
    const input = await readRequestJson(request, limit);
    if (options.maintenance?.()) throw new BackupError("backup_busy", 503);
    return input;
  };
  const fallbackOrigin = `http://${options.host}:${options.port}`;
  const dependencies = { authentication: options.authentication, identity: options.identity };
  /** Dashboard and runtime API: the pairing token in legacy mode, the installation token in token mode. */
  const authenticateRuntime = (request: IncomingMessage): ControllerAuthentication | null => {
    const header = request.headers["x-worktree-switcher-token"];
    const bearer = bearerToken(request);
    const candidate = typeof header === "string" && header.startsWith("wsi_") ? header
      : bearer?.startsWith("wsi_") ? bearer : null;
    const result = resolveControllerAuthentication(dependencies, {
      bearer: candidate,
      legacySecretValid: () => hasValidToken(request, options.accessToken),
    });
    return result?.kind === "legacy" || result?.kind === "installation" ? result : null;
  };
  /** Knowledge and identity API: a scoped credential or the installation token as a bearer. */
  const authenticateActor = (request: IncomingMessage): AuthenticatedPrincipal | null => {
    const result = resolveControllerAuthentication(dependencies, {
      bearer: bearerToken(request),
      legacySecretValid: () => false,
    });
    return result && result.kind !== "legacy" ? result.actor : null;
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", request.headers.host ? `http://${request.headers.host}` : fallbackOrigin);
    const locale = localeFrom(request.headers["accept-language"]);
    try {
      if (url.pathname.startsWith("/api/")) {
        response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
        if (url.pathname === "/api/backups" && options.backups && options.restores) {
          if (!hasValidOrigin(request, options.publicOrigin)) { json(response, 403, { code: "origin_forbidden", error: "origin_forbidden" }); return; }
          const runtime = authenticateRuntime(request);
          const actor = runtime?.kind === "installation" ? runtime.actor : authenticateActor(request);
          await handleBackupHttp(request, response, actor, options.backups, options.restores, readRequestJson, (status, body) => json(response, status, body));
          return;
        }
        if (options.maintenance?.()) { json(response, 503, { code: "backup_busy", error: "backup_busy" }); return; }
        if (url.pathname === "/api/knowledge") {
          if (request.headers.origin && !hasValidOrigin(request, options.publicOrigin)) {
            json(response, 403, { code: "origin_forbidden", error: "Request origin rejected." });
            return;
          }
          if (request.method !== "POST") {
            response.setHeader("Allow", "POST");
            json(response, 405, { code: "method_not_allowed", error: "Use POST." });
            return;
          }
          const actor = authenticateActor(request);
          if (!actor) {
            json(response, 401, { code: "invalid_credential", error: "An active knowledge credential is required." });
            return;
          }
          try {
            let input: unknown;
            try { input = await readJson(request, 14_100_000); }
            catch (error) { throw new KnowledgeError(error instanceof Error && error.message === "Żądanie jest zbyt duże." ? "limit_exceeded" : "invalid_request", "Invalid knowledge JSON request."); }
            json(response, 200, options.service.executeKnowledge(input, actor));
          } catch (error) {
            const failure = knowledgeFailure(error);
            json(response, failure.status, failure.body);
          }
          return;
        }
        if (url.pathname === "/api/identity/bootstrap") {
          if (request.headers.origin && !hasValidOrigin(request, options.publicOrigin)) {
            json(response, 403, { error: localizeServerMessage("Odrzucono żądanie z obcego originu.", locale) });
            return;
          }
          // Owner bootstrap belongs to legacy mode; token mode starts from the installation authority.
          if (authenticateRuntime(request)?.kind !== "legacy") {
            json(response, 401, { error: localizeServerMessage("Brak prawidłowego klucza dostępu.", locale) });
            return;
          }
          if (request.method !== "POST") {
            response.setHeader("Allow", "POST");
            json(response, 405, { error: "Method not allowed." });
            return;
          }
          if (!options.identity) {
            json(response, 503, { error: "Identity service is unavailable." });
            return;
          }
          const value = strictRecord(await readJson(request), ["label", "sessionLifetimeSeconds"]);
          const lifetime = value.sessionLifetimeSeconds;
          if (lifetime !== undefined && typeof lifetime !== "number") throw new Error("Nieprawidłowe pole sessionLifetimeSeconds.");
          try {
            json(response, 200, options.identity.bootstrapOwnerSession({
              label: optionalString(value, "label", 120),
              sessionLifetimeSeconds: lifetime,
            }));
          } catch (error) {
            if (error instanceof IdentityError && error.code === "owner_already_initialized") {
              json(response, 409, { code: error.code, error: localizeServerMessage(error.message, locale) });
              return;
            }
            throw error;
          }
          return;
        }
        if (url.pathname === "/api/identity/admin") {
          if (request.headers.origin && !hasValidOrigin(request, options.publicOrigin)) {
            json(response, 403, { error: localizeServerMessage("Odrzucono żądanie z obcego originu.", locale) });
            return;
          }
          const actor = authenticateActor(request);
          if (!actor || !options.identity) {
            json(response, 401, { error: localizeServerMessage("Brak prawidłowego klucza dostępu.", locale) });
            return;
          }
          if (request.method !== "POST") {
            response.setHeader("Allow", "POST");
            json(response, 405, { error: "Method not allowed." });
            return;
          }
          try {
            json(response, 200, identityAdministration(options.identity, actor, await readJson(request)));
          } catch (error) {
            if (error instanceof IdentityError && error.code === "owner_authentication_required") {
              json(response, 403, { error: localizeServerMessage(error.message, locale) });
              return;
            }
            throw error;
          }
          return;
        }
        if (url.pathname === "/api/identity") {
          if (request.headers.origin && !hasValidOrigin(request, options.publicOrigin)) {
            json(response, 403, { error: localizeServerMessage("Odrzucono żądanie z obcego originu.", locale) });
            return;
          }
          try {
            const actor = authenticateActor(request);
            if (!actor || !options.identity) throw new Error("invalid credential");
            if (request.method !== "GET") {
              response.setHeader("Allow", "GET");
              json(response, 405, { error: "Method not allowed." });
              return;
            }
            json(response, 200, options.identity.describeIdentity(actor));
          } catch {
            json(response, 401, { error: localizeServerMessage("Brak prawidłowego klucza dostępu.", locale) });
          }
          return;
        }
        const runtimeAuthentication = authenticateRuntime(request);
        if (!runtimeAuthentication) {
          json(response, 401, { error: localizeServerMessage("Brak prawidłowego klucza dostępu.", locale) });
          return;
        }
        if (request.headers.origin && !hasValidOrigin(request, options.publicOrigin)) {
          json(response, 403, { error: localizeServerMessage("Odrzucono żądanie z obcego originu.", locale) });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/dashboard") {
          json(response, 200, {
            ...localizedDashboard(await options.service.dashboard(), locale),
            mcp: options.mcpStatus(),
            authentication: { mode: options.authentication?.mode() ?? "legacy", listen: `${options.host}:${options.port}` },
          });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/dashboard/live") {
          const query = parseLiveQuery(url);
          json(response, 200, localizedLive({
            ...options.service.dashboardLive(query.projectIds, query.sections),
            version: options.events.version(),
          }, locale));
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
            "X-Accel-Buffering": "no",
          });
          // Invalid optional knowledge credentials must not interrupt runtime events.
          const actor = authenticateActor(request)
            ?? (runtimeAuthentication.kind === "installation" ? runtimeAuthentication.actor : undefined);
          options.events.add(response, actor && options.identity ? (projectId) => {
            // authorizeKnowledge rechecks credential expiry, revocation and grants without recording passive usage.
            options.identity!.authorizeKnowledge(actor, projectId, "knowledge:read");
          } : undefined);
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/projects") {
          const project = await options.service.addProject(parseAddProject(await readJson(request)));
          options.events.publish({ kinds: ["topology", "metadata"], projectIds: [project.id] });
          json(response, 201, { project });
          return;
        }
        const metadataRefreshMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/metadata\/refresh$/);
        if (request.method === "POST" && metadataRefreshMatch) {
          strictRecord(await readJson(request), []);
          const projectId = decodeURIComponent(metadataRefreshMatch[1]);
          const snapshot = await options.service.refreshProjectMetadata(projectId);
          options.events.publish({ kinds: ["metadata", "storage"], projectIds: [projectId] });
          json(response, 200, { snapshot: localizedProjectSnapshot(snapshot, locale) });
          return;
        }
        const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
        if (request.method === "DELETE" && projectMatch) {
          const project = await options.service.removeProject(decodeURIComponent(projectMatch[1]));
          options.events.publish({ kinds: ["topology"] });
          json(response, 200, { project });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/settings/capacity") {
          const capacity = options.service.setServerCapacity(parseCapacitySettings(await readJson(request)));
          options.events.publish({ kinds: ["controller"] });
          json(response, 200, { capacity });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/settings/test-queue") {
          const testQueue = options.service.setTestQueueLimit(parseTestQueueSettings(await readJson(request)).limit);
          options.events.publish({ kinds: ["controller", "tests"] });
          json(response, 200, { testQueue });
          return;
        }
        const testRunMatch = url.pathname.match(/^\/api\/test-runs\/([^/]+)$/);
        if (request.method === "GET" && testRunMatch) {
          const run = options.service.testRun(decodeURIComponent(testRunMatch[1]));
          json(response, 200, { run: { ...run, error: run.error ? localizeServerMessage(run.error, locale) : null } });
          return;
        }
        const testCancelMatch = url.pathname.match(/^\/api\/test-runs\/([^/]+)\/cancel$/);
        if (request.method === "POST" && testCancelMatch) {
          strictRecord(await readJson(request), []);
          const run = await options.service.cancelTest(decodeURIComponent(testCancelMatch[1]));
          options.events.publish({ kinds: ["tests"], projectIds: [run.projectId] });
          json(response, 200, { run });
          return;
        }
        const projectTestsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/tests$/);
        if (request.method === "POST" && projectTestsMatch) {
          const input = parseTestRun(await readJson(request));
          const run = await options.service.enqueueTest(
            decodeURIComponent(projectTestsMatch[1]), input.worktreePath, input.presetId,
          );
          options.events.publish({ kinds: ["tests"], projectIds: [run.projectId] });
          json(response, 202, { run });
          return;
        }
        const operationMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/operation$/);
        if (request.method === "POST" && operationMatch) {
          const input = parseOperation(await readJson(request));
          const projectId = decodeURIComponent(operationMatch[1]);
          await options.service.operate(projectId, input.operation, input.worktreePath);
          options.events.publish({ kinds: ["runtime", "reservation"], projectIds: [projectId] });
          json(response, 200, { ok: true });
          return;
        }
        const tlsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/tls$/);
        if (request.method === "POST" && tlsMatch) {
          await options.service.setProjectTls(
            decodeURIComponent(tlsMatch[1]),
            parseTlsSettings(await readJson(request)),
          );
          options.events.publish({ kinds: ["topology"], projectIds: [decodeURIComponent(tlsMatch[1])] });
          json(response, 200, { ok: true });
          return;
        }
        const environmentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/environment$/);
        if (request.method === "POST" && environmentMatch) {
          const project = await options.service.setProjectEnvironment(
            decodeURIComponent(environmentMatch[1]),
            parseEnvironment(await readJson(request)),
          );
          options.events.publish({ kinds: ["topology"], projectIds: [decodeURIComponent(environmentMatch[1])] });
          json(response, 200, { project });
          return;
        }
        const profilesMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/environment-profiles$/);
        if (request.method === "POST" && profilesMatch) {
          const input = parseEnvironmentProfile(await readJson(request));
          const project = await options.service.saveEnvironmentProfile(
            decodeURIComponent(profilesMatch[1]), input.name, input.environment, { owner: "local-user" }, input.restart,
          );
          options.events.publish({ kinds: ["topology", "metadata"], projectIds: [decodeURIComponent(profilesMatch[1])] });
          json(response, 200, { project });
          return;
        }
        if (request.method === "DELETE" && profilesMatch) {
          const input = parseProfileSelection(await readJson(request));
          const project = await options.service.deleteEnvironmentProfile(decodeURIComponent(profilesMatch[1]), input.name);
          options.events.publish({ kinds: ["topology", "metadata"], projectIds: [decodeURIComponent(profilesMatch[1])] });
          json(response, 200, { project });
          return;
        }
        const profileSelectionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/environment-profile-selection$/);
        if (request.method === "POST" && profileSelectionMatch) {
          const input = parseProfileSelection(await readJson(request));
          const project = await options.service.selectEnvironmentProfile(
            decodeURIComponent(profileSelectionMatch[1]), input.name, { owner: "local-user" }, input.restart,
          );
          options.events.publish({ kinds: ["topology", "metadata"], projectIds: [decodeURIComponent(profileSelectionMatch[1])] });
          json(response, 200, { project });
          return;
        }
        const testProfilesMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/test-environment-profiles$/);
        if (request.method === "GET" && testProfilesMatch) {
          json(response, 200, options.service.testEnvironmentProfiles(decodeURIComponent(testProfilesMatch[1])));
          return;
        }
        if (request.method === "POST" && testProfilesMatch) {
          const input = parseTestEnvironmentProfile(await readJson(request));
          const project = await options.service.saveTestEnvironmentProfile(decodeURIComponent(testProfilesMatch[1]), input);
          options.events.publish({ kinds: ["topology", "metadata"], projectIds: [decodeURIComponent(testProfilesMatch[1])] });
          json(response, 200, { project });
          return;
        }
        if (request.method === "DELETE" && testProfilesMatch) {
          const input = parseProfileSelection(await readJson(request));
          const project = await options.service.deleteTestEnvironmentProfile(decodeURIComponent(testProfilesMatch[1]), input.name);
          options.events.publish({ kinds: ["topology", "metadata"], projectIds: [decodeURIComponent(testProfilesMatch[1])] });
          json(response, 200, { project });
          return;
        }
        const testPresetProfileMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/test-preset-profiles$/);
        if (request.method === "POST" && testPresetProfileMatch) {
          const input = parseTestPresetProfile(await readJson(request));
          const project = await options.service.assignTestPresetProfile(
            decodeURIComponent(testPresetProfileMatch[1]), input.presetId, input.name,
          );
          options.events.publish({ kinds: ["topology", "metadata"], projectIds: [decodeURIComponent(testPresetProfileMatch[1])] });
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
          options.events.publish({ kinds: ["reservation", "runtime"], projectIds: [projectId] });
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
      if (error instanceof BackupError) { json(response, error.status, { code: error.code, error: error.code }); return; }
      const rawMessage = messageFrom(error);
      const conflict = /zajęty|zablokowany|osiągnięto limit|UNIQUE constraint/i.test(rawMessage);
      const message = localizeServerMessage(rawMessage, locale);
      json(response, conflict ? 409 : 400, { error: message });
    }
  });

  const closeServer = createHttpServerCloser(server);
  return {
    server,
    async close() {
      options.events.close();
      await closeServer();
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
