import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import type { ProjectSnapshot } from "@/shared/contracts";
import { localizeServerMessage } from "../i18n/server-errors";
import type { ControlService } from "./control-service";

interface ClaimSecret {
  projectId: string;
  reservationId: string;
  token: string;
  ttlSeconds: number;
  timer: NodeJS.Timeout | null;
}

interface McpSession {
  owner: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  claims: Map<string, ClaimSecret>;
  idempotencyTokens: Map<string, string>;
  lifetimeTimer: NodeJS.Timeout | null;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

async function english<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(localizeServerMessage(message, "en"));
  }
}

function agentSnapshot(snapshot: ProjectSnapshot) {
  return {
    ...snapshot,
    discoveryError: snapshot.discoveryError
      ? localizeServerMessage(snapshot.discoveryError, "en")
      : undefined,
    runtime: {
      ...snapshot.runtime,
      error: snapshot.runtime.error ? localizeServerMessage(snapshot.runtime.error, "en") : null,
      failure: snapshot.runtime.failure ? {
        code: snapshot.runtime.failure.code,
        technicalDetails: snapshot.runtime.failure.technicalDetails,
      } : null,
    },
  };
}

export class McpRuntime {
  private readonly sessions = new Map<string, McpSession>();

  constructor(
    private readonly service: ControlService,
    private readonly diagnostic: (message: string, details?: Record<string, unknown>) => void = () => undefined,
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse, body?: unknown): Promise<void> {
    const sessionId = header(request, "mcp-session-id");
    let session = sessionId ? this.sessions.get(sessionId) : undefined;

    if (!session && request.method === "POST" && !sessionId && isInitializeRequest(body)) {
      session = this.createSession();
      await session.server.connect(session.transport);
      await session.transport.handleRequest(request, response, body);
      return;
    }
    if (!session) {
      const status = sessionId ? 404 : 400;
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: sessionId ? "MCP session not found." : "Missing MCP session ID.",
        },
        id: null,
      }));
      return;
    }
    await session.transport.handleRequest(request, response, body);
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) this.clearTimers(session);
    await Promise.allSettled(sessions.map((session) => session.server.close()));
  }

  private createSession(): McpSession {
    const session: McpSession = {
      owner: "",
      server: null as unknown as McpServer,
      transport: null as unknown as StreamableHTTPServerTransport,
      claims: new Map(),
      idempotencyTokens: new Map(),
      lifetimeTimer: null,
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        session.owner = `agent:mcp:${sessionId}`;
        this.sessions.set(sessionId, session);
        this.diagnostic("mcp.session_started", { sessionId });
      },
    });
    session.transport = transport;
    session.server = this.createProtocolServer(session);
    session.lifetimeTimer = setTimeout(() => void session.server.close(), 8 * 60 * 60_000);
    session.lifetimeTimer.unref();
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) this.sessions.delete(sessionId);
      this.clearTimers(session);
      this.diagnostic("mcp.session_closed", { sessionId });
    };
    return session;
  }

  private createProtocolServer(session: McpSession): McpServer {
    const server = new McpServer({ name: "worktree-switcher", version: "0.0.1" });
    const owner = () => {
      if (!session.owner) throw new Error("MCP session is not initialized.");
      return session.owner;
    };
    const dashboard = () => english(() => this.service.dashboard());
    const projectList = async () => (await dashboard()).projects.map(({ project, runtime, reservation }) => ({
      id: project.id,
      name: project.name,
      port: project.port,
      runtime: runtime.phase,
      worktreePath: runtime.worktreePath ?? project.selectedWorktreePath,
      resources: runtime.resources,
      reservation,
    }));

    server.registerResource(
      "projects",
      "worktree-switcher://projects",
      { description: "Registered projects and their current runtime placement", mimeType: "application/json" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await projectList(), null, 2) }] }),
    );
    server.registerResource(
      "server-capacity",
      "worktree-switcher://capacity",
      { description: "Global managed-server capacity and current slot holders", mimeType: "application/json" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await english(() => this.service.serverCapacity()), null, 2) }] }),
    );
    server.registerResource(
      "project-status",
      new ResourceTemplate("worktree-switcher://projects/{projectId}/status", {
        list: async () => ({ resources: (await projectList()).map((project) => ({
          uri: `worktree-switcher://projects/${project.id}/status`,
          name: `${project.name} status`,
          mimeType: "application/json",
        })) }),
      }),
      { description: "Runtime, reservation, and worktree status for one project", mimeType: "application/json" },
      async (uri, variables) => {
        const snapshot = await english(() => this.service.projectSnapshot(String(variables.projectId)));
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(agentSnapshot(snapshot), null, 2) }] };
      },
    );
    server.registerResource(
      "project-worktrees",
      new ResourceTemplate("worktree-switcher://projects/{projectId}/worktrees", {
        list: async () => ({ resources: (await projectList()).map((project) => ({
          uri: `worktree-switcher://projects/${project.id}/worktrees`,
          name: `${project.name} worktrees`,
          mimeType: "application/json",
        })) }),
      }),
      { description: "Discovered Git worktrees for one project", mimeType: "application/json" },
      async (uri, variables) => {
        const snapshot = await english(() => this.service.projectSnapshot(String(variables.projectId)));
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(snapshot.worktrees, null, 2) }] };
      },
    );

    server.registerTool("list_projects", {
      description: "List registered projects with their runtime placement and active reservation.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async () => jsonContent(await projectList()));

    server.registerTool("get_server_capacity", {
      description: "Read the global managed-server limit, current usage, available slots, and slot holders.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async () => jsonContent(await english(() => this.service.serverCapacity())));

    server.registerTool("get_project_status", {
      description: "Read the full runtime, reservation, and selected-worktree status of one project.",
      inputSchema: { projectId: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ projectId }) => jsonContent(agentSnapshot(await english(() => this.service.projectSnapshot(projectId)))));

    server.registerTool("get_project_storage", {
      description: "Read cached disk-usage snapshots and bounded history for every discovered worktree in one project.",
      inputSchema: { projectId: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ projectId }) => jsonContent((await english(() => this.service.projectSnapshot(projectId))).storage));

    server.registerTool("list_worktrees", {
      description: "List Git worktrees discovered for one registered project.",
      inputSchema: { projectId: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ projectId }) => jsonContent((await english(() => this.service.projectSnapshot(projectId))).worktrees));

    server.registerTool("set_project_environment", {
      description: "Replace a project's literal development-server environment overrides. The server must be stopped; PORT and NODE_ENV are reserved.",
      inputSchema: {
        projectId: z.string().uuid(),
        environment: z.record(z.string(), z.string()),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    }, async ({ projectId, environment }) => jsonContent({
      project: await english(() => this.service.setProjectEnvironment(projectId, environment, owner())),
      restartRequired: true,
    }));

    server.registerTool("list_environment_profiles", {
      description: "List a project's named environment profiles and the selected profile.",
      inputSchema: { projectId: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ projectId }) => {
      const project = (await english(() => this.service.projectSnapshot(projectId))).project;
      return jsonContent({ selectedProfile: project.selectedEnvironmentProfile, profiles: project.environmentProfiles });
    });

    server.registerTool("save_environment_profile", {
      description: "Create or replace a named literal environment profile. Editing the selected profile requires a stopped server.",
      inputSchema: { projectId: z.string().uuid(), name: z.string().min(1).max(40), environment: z.record(z.string(), z.string()) },
      annotations: { destructiveHint: true, idempotentHint: true },
    }, async ({ projectId, name, environment }) => jsonContent({
      project: await english(() => this.service.saveEnvironmentProfile(projectId, name, environment, owner())),
    }));

    server.registerTool("select_environment_profile", {
      description: "Select an existing environment profile for subsequent managed-server starts. The server must be stopped.",
      inputSchema: { projectId: z.string().uuid(), name: z.string().min(1).max(40) },
      annotations: { destructiveHint: true, idempotentHint: true },
    }, async ({ projectId, name }) => jsonContent({
      project: await english(() => this.service.selectEnvironmentProfile(projectId, name, owner())),
      restartRequired: true,
    }));

    server.registerTool("delete_environment_profile", {
      description: "Delete a non-default, non-selected environment profile.",
      inputSchema: { projectId: z.string().uuid(), name: z.string().min(1).max(40) },
      annotations: { destructiveHint: true, idempotentHint: true },
    }, async ({ projectId, name }) => jsonContent({
      project: await english(() => this.service.deleteEnvironmentProfile(projectId, name, owner())),
    }));

    server.registerTool("claim_project", {
      description: "Acquire an expiring agent claim and atomically move/start the project server on a discovered worktree. The claim remains held if startup fails.",
      inputSchema: {
        projectId: z.string().uuid(),
        worktreePath: z.string().min(1).max(4096),
        reason: z.string().min(1).max(240),
        idempotencyKey: z.string().min(1).max(120),
        ttlSeconds: z.number().int().min(30).max(1800).optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    }, async ({ projectId, worktreePath, reason, idempotencyKey, ttlSeconds }) => {
      const idempotencyScope = `${projectId}:${idempotencyKey}`;
      const existingToken = session.idempotencyTokens.get(idempotencyScope);
      const result = await english(() => this.service.claimProject({
        projectId,
        worktreePath,
        reason,
        idempotencyKey,
        ttlSeconds,
        owner: owner(),
      }, existingToken));
      session.idempotencyTokens.set(idempotencyScope, result.leaseToken);
      const claim: ClaimSecret = {
        projectId,
        reservationId: result.reservation.id,
        token: result.leaseToken,
        ttlSeconds: ttlSeconds ?? 1800,
        timer: null,
      };
      session.claims.set(result.reservation.id, claim);
      this.scheduleRenewal(session, claim);
      return jsonContent({
        reservation: result.reservation,
        runtime: agentSnapshot(result.snapshot).runtime,
        operationError: result.operationError ? localizeServerMessage(result.operationError, "en") : null,
        leaseHeld: true,
      });
    });

    server.registerTool("renew_project_claim", {
      description: "Renew a claim owned by this MCP session without exposing its lease secret.",
      inputSchema: {
        projectId: z.string().uuid(),
        reservationId: z.string().uuid(),
        ttlSeconds: z.number().int().min(30).max(1800).optional(),
      },
      annotations: { idempotentHint: true },
    }, async ({ projectId, reservationId, ttlSeconds }) => {
      const claim = this.requireClaim(session, projectId, reservationId);
      const reservation = await english(() => this.service.renewAgentClaim(projectId, reservationId, owner(), claim.token, ttlSeconds));
      claim.ttlSeconds = ttlSeconds ?? claim.ttlSeconds;
      this.scheduleRenewal(session, claim);
      return jsonContent({ reservation });
    });

    server.registerTool("release_project_claim", {
      description: "Release a claim owned by this MCP session. It does not stop the development server.",
      inputSchema: { projectId: z.string().uuid(), reservationId: z.string().uuid() },
      annotations: { destructiveHint: true, idempotentHint: true },
    }, async ({ projectId, reservationId }) => {
      const claim = this.requireClaim(session, projectId, reservationId);
      await english(() => this.service.releaseAgentClaim(projectId, reservationId, owner(), claim.token));
      if (claim.timer) clearTimeout(claim.timer);
      session.claims.delete(reservationId);
      return jsonContent({ released: true, projectId, reservationId });
    });
    return server;
  }

  private requireClaim(session: McpSession, projectId: string, reservationId: string): ClaimSecret {
    const claim = session.claims.get(reservationId);
    if (!claim || claim.projectId !== projectId) throw new Error("This MCP session does not own the requested claim.");
    return claim;
  }

  private scheduleRenewal(session: McpSession, claim: ClaimSecret): void {
    if (claim.timer) clearTimeout(claim.timer);
    const delay = Math.max(10_000, Math.min(10 * 60_000, Math.floor(claim.ttlSeconds * 1000 / 3)));
    claim.timer = setTimeout(() => {
      try {
        this.service.renewAgentClaim(claim.projectId, claim.reservationId, session.owner, claim.token, claim.ttlSeconds);
        this.scheduleRenewal(session, claim);
      } catch (error) {
        session.claims.delete(claim.reservationId);
        this.diagnostic("mcp.claim_auto_renew_failed", {
          projectId: claim.projectId,
          reservationId: claim.reservationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, delay);
    claim.timer.unref();
  }

  private clearTimers(session: McpSession): void {
    if (session.lifetimeTimer) clearTimeout(session.lifetimeTimer);
    for (const claim of session.claims.values()) if (claim.timer) clearTimeout(claim.timer);
  }
}
