import { registerKnowledgeTools } from "./knowledge-tools";
import { McpDiagnostics, type McpSessionObservation, type McpCloseReason } from "../../mcp-diagnostics";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ErrorCode, McpError, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import packageJson from "../../../../package.json";
import type { ClaimedRuntimeAction, ClaimedRuntimeReceipt, ProjectSnapshot } from "@/shared/contracts";
import { localizeServerMessage } from "../../../i18n/server-errors";
import type { ControlService } from "../../control-service";
import type { ControllerAuthentication, IdentityService } from "../../modules/identity";
import { McpSessionGovernor, type GovernedMcpSession, type McpPolicyCloseReason, type McpTimer } from "../../modules/mcp-sessions";

interface ClaimSecret {
  projectId: string;
  reservationId: string;
  token: string;
  ttlSeconds: number;
  timer: McpTimer | null;
}

interface McpSession {
  observation: McpSessionObservation;
  closeReason: McpCloseReason;
  authentication: ControllerAuthentication;
  authenticationKey: string;
  owner: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  claims: Map<string, ClaimSecret>;
  idempotencyTokens: Map<string, string>;
  runtimeOperations: Map<string, RuntimeOperationEntry>;
  /** Admission, liveness and drain policy owned by the mcp-sessions module. */
  governed: GovernedMcpSession;
  /** No new work: set when a policy close begins draining or the session closes. */
  closing: boolean;
  /** Final disposal ran; late settlements release their own resources. */
  closed: boolean;
  cleanedUp: boolean;
  closeAnnounced: boolean;
  /** Call responses still awaiting the SDK; answered with an unknown outcome if the session closes first. */
  pendingCalls: Map<ServerResponse, unknown>;
}

interface RuntimeOperationEntry {
  fingerprint: string;
  promise: Promise<ClaimedRuntimeReceipt>;
  settled: boolean;
  counted: boolean;
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
    testPresets: snapshot.testPresets.map((entry) => ({
      ...entry,
      error: entry.error ? localizeServerMessage(entry.error, "en") : null,
    })),
    testRuns: snapshot.testRuns.map((run) => ({
      ...run,
      error: run.error ? localizeServerMessage(run.error, "en") : null,
    })),
  };
}

export class McpRuntime {
  private readonly sessions = new Map<string, McpSession>();
  /** Sessions removed from routing that still drain accepted calls. */
  private readonly draining = new Set<McpSession>();
  private runtimeOperationCount = 0;

  constructor(
    private readonly service: ControlService,
    private readonly diagnostic: (message: string, details?: Record<string, unknown>) => void = () => undefined,
    private readonly identity?: Pick<IdentityService, "describeIdentity">,
    private readonly diagnostics = new McpDiagnostics(),
    private readonly governor = new McpSessionGovernor(),
  ) {}

  private get clock() { return this.governor.clock; }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    authentication: ControllerAuthentication,
    body?: unknown,
  ): Promise<void> {
    const sessionId = header(request, "mcp-session-id");
    let session = sessionId ? this.sessions.get(sessionId) : undefined;

    if (!session && request.method === "POST" && !sessionId && isInitializeRequest(body)) {
      const admission = this.governor.admit(this.authenticationKey(authentication));
      if (!admission.admitted) {
        // Predictable refusal: established sessions are untouched and no
        // session state, timer or transport is created for this request.
        this.diagnostics.refused();
        this.diagnostic("mcp.session_refused", { reason: "admission-refused", scope: admission.scope, limit: admission.limit });
        response.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Retry-After": "60" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: `MCP session limit reached (${admission.scope === "global" ? "controller" : "per-credential"} limit ${admission.limit}). Existing sessions keep working; close unused MCP clients or retry later.`,
            data: { reason: "admission-refused", scope: admission.scope, limit: admission.limit },
          },
          id: (body as { id?: string | number }).id ?? null,
        }));
        return;
      }
      session = this.createSession(authentication, admission.session);
      try {
        await session.server.connect(session.transport);
        this.observeMessages(session);
        await this.handleTransport(session, request, response, body, true);
        if (!session.transport.sessionId) { session.closeReason = "initialization-failed"; await session.server.close(); this.cleanupSession(session); }
      } catch (error) {
        session.closeReason = "initialization-failed";
        await session.server.close();
        this.cleanupSession(session);
        throw error;
      }
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
    if (session.authenticationKey !== this.authenticationKey(authentication)) {
      response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "MCP session authentication changed." },
        id: null,
      }));
      return;
    }
    await this.handleTransport(session, request, response, body);
  }

  /** Immediate close for controller shutdown and authentication policy; draining sessions keep their policy reason. */
  async close(reason: McpCloseReason = "controller-shutdown"): Promise<void> {
    const sessions = [...this.sessions.values(), ...this.draining];
    this.sessions.clear();
    for (const session of sessions) {
      if (!session.closing) session.closeReason = reason;
      session.closing = true;
      this.clearTimers(session);
      this.disposeRuntimeOperations(session);
    }
    await Promise.allSettled(sessions.map((session) => session.server.close()));
  }

  diagnosticsSnapshot() {
    const snapshot = this.diagnostics.snapshot();
    const live = new Map<number, McpSession>();
    for (const session of [...this.sessions.values(), ...this.draining]) live.set(session.observation.label, session);
    return {
      ...snapshot,
      runtimeRetryEntries: this.runtimeOperationCount,
      ...this.governor.describe(),
      sessions: snapshot.sessions.map(entry => {
        const session = live.get(entry.label);
        const deadline = session?.governed.deadline ?? null;
        return {
          ...entry,
          state: session ? session.governed.state : "closed",
          transportPhase: session && !session.closing ? session.governed.transport : "closed",
          renewalPolicyState: !session || session.claims.size === 0 ? "none" : session.governed.renewalStopped ? "stopped-idle" : "renewing",
          closeDueAt: deadline ? new Date(deadline.at).toISOString() : null,
          closeDueReason: deadline?.reason ?? null,
          statusWaits: session && !session.closing ? this.service.statusWaitDiagnostics?.(session.owner) ?? null : null,
        };
      }),
    };
  }

  private observeMessages(session: McpSession): void {
    const onmessage = session.transport.onmessage;
    session.transport.onmessage = (message, extra) => {
      this.diagnostics.clientMessage(session.observation, "method" in message && ["tools/call", "tools/list", "resources/read", "resources/list", "resources/templates/list", "prompts/get", "prompts/list"].includes(message.method));
      onmessage?.(message, extra);
    };
  }

  private async handleTransport(session: McpSession, request: IncomingMessage, response: ServerResponse, body?: unknown, initialize = false): Promise<void> {
    this.diagnostics.change(session.observation, "openResponses", 1);
    const governed = session.governed.openResponse();
    if (request.method === "POST" && !initialize) session.pendingCalls.set(response, body && typeof body === "object" && "id" in body ? body.id : null);
    let ended = false, sse = false;
    const end = () => {
      if (ended) return;
      ended = true;
      session.pendingCalls.delete(response);
      response.off("finish", end); response.off("close", end);
      if (response.writeHead === observeHead) response.writeHead = writeHead;
      this.diagnostics.change(session.observation, "openResponses", -1);
      if (sse) this.diagnostics.change(session.observation, "sseResponses", -1);
      session.observation.lastTransportEndedAt = new Date(this.clock.now()).toISOString();
      governed.close();
    };
    // The SDK/Hono handler remains pending for a streaming body. Observe the
    // public HTTP header write, rather than awaiting that handler or inspecting
    // SDK internals. Successful SDK GET is its standalone SSE transport.
    const writeHead = response.writeHead;
    const observeHead: typeof response.writeHead = function (this: ServerResponse, ...args: [number, ...unknown[]]) {
      const result = Reflect.apply(writeHead, this, args);
      if (!ended && !sse && request.method === "GET" && args[0] === 200) {
        sse = true;
        diagnostics.change(session.observation, "sseResponses", 1);
        governed.markStream();
      }
      return result;
    };
    const diagnostics = this.diagnostics;
    response.writeHead = observeHead;
    response.once("finish", end); response.once("close", end);
    await session.transport.handleRequest(request, response, body);
  }

  private authenticationKey(authentication: ControllerAuthentication): string {
    if (authentication.kind === "legacy") return "legacy";
    return `${authentication.kind}:${authentication.actor.credentialId}`;
  }

  private createSession(authentication: ControllerAuthentication, governed: GovernedMcpSession): McpSession {
    const session: McpSession = {
      observation: this.diagnostics.create(),
      closeReason: "transport-close",
      authentication,
      authenticationKey: this.authenticationKey(authentication),
      owner: "",
      server: null as unknown as McpServer,
      transport: null as unknown as StreamableHTTPServerTransport,
      claims: new Map(),
      idempotencyTokens: new Map(),
      runtimeOperations: new Map(),
      governed,
      closing: false,
      closed: false,
      cleanedUp: false,
      closeAnnounced: false,
      pendingCalls: new Map(),
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessionclosed: () => { if (!session.closing) session.closeReason = "client-delete"; },
      onsessioninitialized: (sessionId) => {
        session.owner = `agent:mcp:${sessionId}`;
        this.sessions.set(sessionId, session);
        this.diagnostics.initialize(session.observation);
        this.diagnostic("mcp.session_started", { sessionId });
      },
    });
    session.transport = transport;
    session.server = this.createProtocolServer(session);
    // One deadline timer per session covers absolute lifetime and idle policy;
    // the diagnostics keep reporting it as the session's lifetime timer.
    governed.start(
      reason => this.beginClose(session, reason),
      (kind, delta) => this.diagnostics.change(session.observation, kind === "deadline" ? "lifetimeTimers" : "drainTimers", delta),
    );
    transport.onclose = () => {
      this.cleanupSession(session);
    };
    return session;
  }

  /**
   * Policy close: admit no new work, stop renewal and drain accepted calls for
   * a bounded time. Their real outcomes stay reported; nothing is replayed.
   * Managed servers, accepted test jobs and client processes are untouched.
   */
  private beginClose(session: McpSession, reason: McpPolicyCloseReason): void {
    if (session.closing) return;
    session.closing = true;
    session.closeReason = reason;
    const sessionId = session.transport.sessionId;
    if (sessionId) this.sessions.delete(sessionId);
    this.draining.add(session);
    this.clearTimers(session);
    this.diagnostics.close(session.observation, reason);
    this.announceClosed(session);
    session.governed.beginDrain(() => { void session.server.close(); });
  }

  private announceClosed(session: McpSession): void {
    if (session.closeAnnounced) return;
    session.closeAnnounced = true;
    this.diagnostic("mcp.session_closed", { sessionId: session.transport.sessionId, reason: session.closeReason });
  }

  private cleanupSession(session: McpSession): void {
    if (session.cleanedUp) return;
    session.cleanedUp = true;
    session.closing = true;
    const sessionId = session.transport.sessionId;
    if (sessionId && this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    this.draining.delete(session);
    this.clearTimers(session);
    this.disposeRuntimeOperations(session);
    this.answerPendingCalls(session);
    session.governed.markClosed();
    this.diagnostics.close(session.observation, session.closeReason);
    this.announceClosed(session);
  }

  /**
   * The SDK drops a pending JSON response when its transport closes, which
   * would keep the HTTP response and the admission slot open indefinitely.
   * Answer it truthfully instead: the call may still complete, so its outcome
   * is unknown and must be inspected rather than replayed.
   */
  private answerPendingCalls(session: McpSession): void {
    for (const [response, id] of [...session.pendingCalls]) {
      session.pendingCalls.delete(response);
      if (response.headersSent || response.writableEnded) continue;
      response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "The MCP session closed before this request completed. Its outcome is unknown: inspect current status before retrying, and do not repeat a mutation blindly.",
          data: { reason: session.closeReason, outcome: "unknown" },
        },
        id: id ?? null,
      }));
    }
  }

  private recordActivity(session: McpSession): void {
    if (session.closing) return;
    const resumed = session.governed.activity();
    this.diagnostics.qualifyingActivity(session.observation, new Date(this.clock.now()).toISOString());
    // A returning client resumes renewal of claims whose renewal stopped for
    // idleness, provided the persisted lease has not expired meanwhile.
    if (resumed) for (const claim of session.claims.values()) if (!claim.timer) this.scheduleRenewal(session, claim, 0);
  }

  private createProtocolServer(session: McpSession): McpServer {
    const server = new McpServer({ name: "worktree-control", version: packageJson.version });
    const setRequestHandler = server.server.setRequestHandler.bind(server.server);
    server.server.setRequestHandler = (schema, handler) => setRequestHandler(schema, async (request, extra) => {
      if (session.closing) throw new McpError(ErrorCode.InvalidRequest, "The MCP session is closing and accepts no new work. Start a new session.");
      // Qualifying activity: an authenticated tool call or resource read,
      // stamped when it starts and when it settles. Listing, initialize,
      // ping, SSE reconnects and server renewals never extend liveness.
      const qualifying = request.method === "tools/call" || request.method === "resources/read";
      const settle = session.governed.callStarted();
      this.diagnostics.change(session.observation, "operations", 1);
      if (qualifying) this.recordActivity(session);
      try { return await handler(request, extra); }
      finally {
        if (qualifying) this.recordActivity(session);
        this.diagnostics.change(session.observation, "operations", -1);
        settle();
      }
    });
    if (session.authentication.kind !== "legacy") {
      const actor = session.authentication.actor;
      registerKnowledgeTools(server, this.service, actor);
      server.registerTool("get_identity", {
        description: "Read the authenticated principal, credential metadata, and active knowledge grants.",
        annotations: { readOnlyHint: true, idempotentHint: true },
      }, async () => {
        if (!this.identity) throw new Error("Scoped identity authentication is unavailable.");
        return jsonContent(this.identity.describeIdentity(actor));
      });
      // Scoped credentials stop here; the installation authority also controls the runtime.
      if (session.authentication.kind === "principal") return server;
    }
    const owner = () => {
      if (!session.owner) throw new Error("MCP session is not initialized.");
      return session.owner;
    };
    const actorFor = (projectId: string) => {
      const claim = [...session.claims.values()].find((candidate) => candidate.projectId === projectId);
      return { owner: owner(), leaseToken: claim?.token };
    };
    const projectList = async () => (await english(() => this.service.projectSummaries())).map(({ project, runtime, reservation }) => ({
      id: project.id,
      name: project.name,
      port: project.port,
      runtime: runtime.phase,
      worktreePath: runtime.worktreePath ?? project.selectedWorktreePath,
      resources: runtime.resources,
      reservation,
    }));

    // Resource URIs are a stable client contract like tool names, so they keep the
    // `worktree-switcher://` scheme from before the product rename.
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
      "test-queue",
      "worktree-switcher://tests/queue",
      { description: "Global test queue limit and current usage", mimeType: "application/json" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await english(() => this.service.testQueueStatus()), null, 2) }] }),
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

    server.registerTool("get_test_queue", {
      description: "Read the global parallel-test limit and current running and queued counts.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async () => jsonContent(await english(() => this.service.testQueueStatus())));

    server.registerTool("get_project_status", {
      description: "Read the full runtime, reservation, and selected-worktree status of one project.",
      inputSchema: { projectId: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ projectId }) => jsonContent(agentSnapshot(await english(() => this.service.projectSnapshot(projectId)))));

    server.registerTool("get_project_status_compact", {
      description: "Read cheap bounded project placement, ownership, runtime, and capacity status without discovery or histories.",
      inputSchema: { projectId: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ projectId }) => jsonContent(await english(() => this.service.compactProjectStatus(projectId, owner()))));

    server.registerTool("get_runtime_logs", {
      description: "Read a bounded tail of the managed runtime's in-memory logs.",
      inputSchema: { projectId: z.string().uuid(), limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ projectId, limit }) => jsonContent(await english(() => this.service.runtimeLogs(projectId, limit))));

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

    server.registerTool("list_test_presets", {
      description: "List safe test and verification presets discovered in each worktree of one project.",
      inputSchema: { projectId: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ projectId }) => jsonContent((await english(() => this.service.projectSnapshot(projectId))).testPresets));

    server.registerTool("run_test", {
      description: "Queue one discovered test preset for an exact worktree. Runs are globally bounded and serialized per worktree.",
      inputSchema: {
        projectId: z.string().uuid(),
        worktreePath: z.string().min(1).max(4096),
        presetId: z.string().min(1).max(160),
        idempotencyKey: z.string().min(1).max(120),
        responseMode: z.enum(["full", "compact"]).optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    }, async ({ projectId, worktreePath, presetId, idempotencyKey, responseMode }) => {
      const run = await english(() => this.service.enqueueTest(projectId, worktreePath, presetId, actorFor(projectId), idempotencyKey));
      return jsonContent(responseMode === "compact" ? await english(() => this.service.compactTestRunStatus(run.id)) : run);
    });

    server.registerTool("get_test_run", {
      description: "Read one queued, active, or completed test run including its bounded output tail.",
      inputSchema: { runId: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ runId }) => {
      const run = await english(() => this.service.testRun(runId));
      return jsonContent({ ...run, error: run.error ? localizeServerMessage(run.error, "en") : null });
    });

    server.registerTool("get_test_run_status", {
      description: "Read a cheap bounded test phase, placement, process result, and explicitly qualified source summary.",
      inputSchema: { runId: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ runId }) => jsonContent(await english(() => this.service.compactTestRunStatus(runId))));

    server.registerTool("wait_for_status_change", {
      description: "Wait up to 20 seconds for one compact project or test status cursor to change.",
      inputSchema: {
        projectId: z.string().uuid().optional(),
        runId: z.string().uuid().optional(),
        cursor: z.string().min(1).max(128),
        timeoutMs: z.number().int().min(1).max(20_000).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ projectId, runId, cursor, timeoutMs }, extra) => {
      if ((projectId ? 1 : 0) + (runId ? 1 : 0) !== 1) throw new Error("Exactly one of projectId or runId is required.");
      return jsonContent(await english(() => this.service.waitForStatusChange(
        { projectId, runId, cursor, timeoutMs }, owner(), extra.signal,
      )));
    });

    server.registerTool("cancel_test_run", {
      description: "Cancel a queued or active test run created by this MCP session.",
      inputSchema: { runId: z.string().uuid() },
      annotations: { destructiveHint: true },
    }, async ({ runId }) => jsonContent(await english(() => this.service.cancelTest(runId, { owner: owner() }))));

    server.registerTool("set_project_environment", {
      description: "Replace a project's literal development-server environment overrides. The server must be stopped; PORT and NODE_ENV are reserved.",
      inputSchema: {
        projectId: z.string().uuid(),
        environment: z.record(z.string(), z.string()),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    }, async ({ projectId, environment }) => jsonContent({
      project: await english(() => this.service.setProjectEnvironment(projectId, environment, actorFor(projectId))),
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
      project: await english(() => this.service.saveEnvironmentProfile(projectId, name, environment, actorFor(projectId))),
    }));

    server.registerTool("select_environment_profile", {
      description: "Select an existing environment profile for subsequent managed-server starts. The server must be stopped.",
      inputSchema: { projectId: z.string().uuid(), name: z.string().min(1).max(40) },
      annotations: { destructiveHint: true, idempotentHint: true },
    }, async ({ projectId, name }) => jsonContent({
      project: await english(() => this.service.selectEnvironmentProfile(projectId, name, actorFor(projectId))),
      restartRequired: true,
    }));

    server.registerTool("delete_environment_profile", {
      description: "Delete a non-default, non-selected environment profile.",
      inputSchema: { projectId: z.string().uuid(), name: z.string().min(1).max(40) },
      annotations: { destructiveHint: true, idempotentHint: true },
    }, async ({ projectId, name }) => jsonContent({
      project: await english(() => this.service.deleteEnvironmentProfile(projectId, name, actorFor(projectId))),
    }));

    server.registerTool("list_test_environment_profiles", {
      description: "List a project's test environment profiles, their policy, and the profile assigned to each test preset. Variable names are returned without values.",
      inputSchema: { projectId: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ projectId }) => jsonContent(await english(() => this.service.testEnvironmentProfiles(projectId))));

    server.registerTool("save_test_environment_profile", {
      description: "Create or replace a test environment profile. Test processes start from a fixed system allowlist; a profile only adds its own variables. Inheriting a development-server profile requires naming that profile explicitly.",
      inputSchema: {
        projectId: z.string().uuid(),
        name: z.string().min(1).max(40),
        environment: z.record(z.string(), z.string()),
        mode: z.enum(["clean", "inherit-server-profile"]).optional(),
        serverProfile: z.string().min(1).max(40).nullable().optional(),
        nodeEnv: z.enum(["development", "production", "test"]).nullable().optional(),
        requiredVariables: z.array(z.string().min(1).max(128)).optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    }, async ({ projectId, name, environment, mode, serverProfile, nodeEnv, requiredVariables }) => {
      await english(() => this.service.saveTestEnvironmentProfile(
        projectId, { name, environment, mode, serverProfile, nodeEnv, requiredVariables }, actorFor(projectId),
      ));
      return jsonContent(await english(() => this.service.testEnvironmentProfiles(projectId)));
    });

    server.registerTool("delete_test_environment_profile", {
      description: "Delete a test environment profile that is neither built in nor assigned to a preset.",
      inputSchema: { projectId: z.string().uuid(), name: z.string().min(1).max(40) },
      annotations: { destructiveHint: true, idempotentHint: true },
    }, async ({ projectId, name }) => {
      await english(() => this.service.deleteTestEnvironmentProfile(projectId, name, actorFor(projectId)));
      return jsonContent(await english(() => this.service.testEnvironmentProfiles(projectId)));
    });

    server.registerTool("assign_test_preset_profile", {
      description: "Assign a test environment profile to one discovered preset, or clear the assignment to fall back to the built-in default.",
      inputSchema: { projectId: z.string().uuid(), presetId: z.string().min(1).max(160), name: z.string().min(1).max(40).nullable() },
      annotations: { destructiveHint: true, idempotentHint: true },
    }, async ({ projectId, presetId, name }) => {
      await english(() => this.service.assignTestPresetProfile(projectId, presetId, name, actorFor(projectId)));
      return jsonContent(await english(() => this.service.testEnvironmentProfiles(projectId)));
    });

    server.registerTool("claim_project", {
      description: "Acquire an expiring agent claim and atomically move/start the project server on a discovered worktree. The claim remains held if startup fails.",
      inputSchema: {
        projectId: z.string().uuid(),
        worktreePath: z.string().min(1).max(4096),
        reason: z.string().min(1).max(240),
        idempotencyKey: z.string().min(1).max(120),
        ttlSeconds: z.number().int().min(30).max(1800).optional(),
        responseMode: z.enum(["full", "compact"]).optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    }, async ({ projectId, worktreePath, reason, idempotencyKey, ttlSeconds, responseMode }) => {
      const idempotencyScope = `${projectId}:${idempotencyKey}`;
      const existingToken = session.idempotencyTokens.get(idempotencyScope);
      const result = await english(() => this.service.claimProject({
        projectId,
        worktreePath,
        reason,
        idempotencyKey,
        ttlSeconds,
        owner: owner(),
      }, existingToken, responseMode !== "compact"));
      if (session.closing) {
        // The accepted operation may have completed, but this closed session
        // cannot retain its secret or acquire a new renewal resource. Preserve
        // the resulting lease's TTL and the project's independent lifecycle.
        throw new Error("The MCP session closed after claim acquisition. The reservation may remain until its TTL expires; automatic renewal was not started.");
      }
      session.idempotencyTokens.set(idempotencyScope, result.leaseToken);
      const claim: ClaimSecret = {
        projectId,
        reservationId: result.reservation.id,
        token: result.leaseToken,
        ttlSeconds: ttlSeconds ?? 1800,
        timer: null,
      };
      if (!session.claims.has(result.reservation.id)) this.diagnostics.change(session.observation, "claims", 1);
      const previous = session.claims.get(result.reservation.id);
      if (previous?.timer) { this.clock.clearTimeout(previous.timer); this.diagnostics.change(session.observation, "renewalTimers", -1); }
      session.claims.set(result.reservation.id, claim);
      this.scheduleRenewal(session, claim);
      if (responseMode === "compact") return jsonContent({
        reservationId: result.reservation.id,
        projectId,
        worktreePath: result.reservation.worktreePath,
        operationErrorCode: result.operationErrorCode,
        leaseHeld: true,
        status: await english(() => this.service.compactProjectStatus(projectId, owner())),
      });
      return jsonContent({
        reservation: result.reservation,
        runtime: agentSnapshot(result.snapshot!).runtime,
        operationError: result.operationError ? localizeServerMessage(result.operationError, "en") : null,
        leaseHeld: true,
      });
    });

    const registerRuntimeTool = (name: `${ClaimedRuntimeAction}_project`, action: ClaimedRuntimeAction, description: string) => {
      server.registerTool(name, {
        description,
        inputSchema: {
          projectId: z.string().uuid(),
          reservationId: z.string().uuid(),
          idempotencyKey: z.string().min(1).max(120),
        },
        annotations: { destructiveHint: true, idempotentHint: true },
      }, async ({ projectId, reservationId, idempotencyKey }, extra) => {
        const claim = this.requireClaim(session, projectId, reservationId);
        const receipt = await english(() => this.runRuntimeOperation(
          session, idempotencyKey, projectId, reservationId, action, claim, extra.signal,
        ));
        return jsonContent(receipt);
      });
    };
    registerRuntimeTool("start_project", "start", "Start the managed server on this session's actively claimed worktree. Already running is a no-op.");
    registerRuntimeTool("restart_project", "restart", "Restart the managed server on this session's actively claimed worktree while retaining its claim and capacity slot.");
    registerRuntimeTool("stop_project", "stop", "Stop the managed server owned by this session's active claim. The claim remains held.");

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
      if (claim.timer) { this.clock.clearTimeout(claim.timer); claim.timer = null; this.diagnostics.change(session.observation, "renewalTimers", -1); }
      if (session.claims.delete(reservationId)) this.diagnostics.change(session.observation, "claims", -1);
      return jsonContent({ released: true, projectId, reservationId });
    });
    return server;
  }

  private requireClaim(session: McpSession, projectId: string, reservationId: string): ClaimSecret {
    const claim = session.claims.get(reservationId);
    if (!claim || claim.projectId !== projectId) throw new Error("This MCP session does not own the requested claim.");
    return claim;
  }

  private async runRuntimeOperation(
    session: McpSession,
    idempotencyKey: string,
    projectId: string,
    reservationId: string,
    action: ClaimedRuntimeAction,
    claim: ClaimSecret,
    signal?: AbortSignal,
  ): Promise<ClaimedRuntimeReceipt> {
    const fingerprint = `${action}\0${projectId}\0${reservationId}`;
    const existing = session.runtimeOperations.get(idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("The idempotency key was already used for a different runtime operation.");
      return { ...(await existing.promise), replayed: true };
    }
    if (session.closing) throw new Error("The MCP session is closed.");
    if (session.runtimeOperations.size >= 64 || this.runtimeOperationCount >= 512) {
      throw new Error("The runtime operation retry ledger is full. Start a new MCP session before submitting another operation.");
    }
    const entry: RuntimeOperationEntry = { fingerprint, promise: null as unknown as Promise<ClaimedRuntimeReceipt>, settled: false, counted: true };
    this.runtimeOperationCount += 1;
    entry.promise = this.service.operateClaimedRuntime(
      projectId, reservationId, action, { owner: session.owner, leaseToken: claim.token }, signal, () => session.closing,
    ).then((receipt) => {
      entry.settled = true;
      return receipt;
    }, (error) => {
      entry.settled = true;
      throw error;
    }).finally(() => {
      if (session.closed) this.releaseRuntimeOperationEntry(session, idempotencyKey, entry);
    });
    session.runtimeOperations.set(idempotencyKey, entry);
    return entry.promise;
  }

  private disposeRuntimeOperations(session: McpSession): void {
    session.closed = true;
    for (const [key, entry] of session.runtimeOperations) {
      if (entry.settled) this.releaseRuntimeOperationEntry(session, key, entry);
    }
  }

  private releaseRuntimeOperationEntry(session: McpSession, key: string, entry: RuntimeOperationEntry): void {
    if (!entry.counted) return;
    entry.counted = false;
    session.runtimeOperations.delete(key);
    this.runtimeOperationCount -= 1;
  }

  private scheduleRenewal(session: McpSession, claim: ClaimSecret, delayMs?: number): void {
    if (session.closing || session.claims.get(claim.reservationId) !== claim) return;
    if (claim.timer) { this.clock.clearTimeout(claim.timer); this.diagnostics.change(session.observation, "renewalTimers", -1); }
    const delay = delayMs ?? Math.max(10_000, Math.min(10 * 60_000, Math.floor(claim.ttlSeconds * 1000 / 3)));
    this.diagnostics.change(session.observation, "renewalTimers", 1);
    claim.timer = this.clock.setTimeout(() => {
      claim.timer = null;
      this.diagnostics.change(session.observation, "renewalTimers", -1);
      if (session.closing || session.claims.get(claim.reservationId) !== claim) return;
      if (!session.governed.renewalAllowed()) {
        // Without qualifying activity the lease is not extended. It stays held
        // for its remaining TTL and is never released early or handed over.
        this.diagnostics.renewalSkipped(session.observation);
        this.diagnostic("mcp.claim_auto_renew_stopped", { projectId: claim.projectId, reservationId: claim.reservationId, reason: "client-idle" });
        return;
      }
      try {
        this.service.renewAgentClaim(claim.projectId, claim.reservationId, session.owner, claim.token, claim.ttlSeconds);
        this.diagnostics.renewed(session.observation, true);
        this.scheduleRenewal(session, claim);
      } catch (error) {
        if (session.claims.get(claim.reservationId) === claim && session.claims.delete(claim.reservationId)) {
          this.diagnostics.change(session.observation, "claims", -1);
        }
        this.diagnostics.renewed(session.observation, false);
        this.diagnostic("mcp.claim_auto_renew_failed", {
          projectId: claim.projectId,
          reservationId: claim.reservationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, delay);
  }

  /** Dispose session-held claim handles and secrets; persisted leases keep their remaining TTL. */
  private clearTimers(session: McpSession): void {
    for (const claim of session.claims.values()) if (claim.timer) { this.clock.clearTimeout(claim.timer); claim.timer = null; this.diagnostics.change(session.observation, "renewalTimers", -1); }
    this.diagnostics.change(session.observation, "claims", -session.observation.claims);
    session.claims.clear();
    session.idempotencyTokens.clear();
  }
}
