import { z } from "zod";
import type { AuthenticatedPrincipal } from "../identity";
import { RuntimeAccessDenied, ScopedRuntimeError, type RuntimeAuthorizer } from "../runtime";
import type { StateStore } from "@/server/state-store";
import type { ServerCapacityStatus, TestQueueStatus } from "@/shared/contracts";

const id = z.string().min(1).max(160);
const logs = z.object({ projectId: id, limit: z.number().int().min(1).max(100).default(40) }).strict();
const runLogs = z.object({ runId: id, projectId: id.optional(), limit: z.number().int().min(1).max(100).default(40) }).strict();
const storage = z.object({ projectId: id, worktreePath: z.string().min(1).max(4096).optional() }).strict();

/** Cache-only reads. No discovery, filesystem scan, timer, process or new admission budget. */
export class ScopedDiagnostics {
  constructor(private readonly authority: RuntimeAuthorizer,
    private readonly store: Pick<StateStore, "getProject" | "getWorktreeStorage" | "getTestRun">,
    private readonly sources: {
      logs(projectId: string, limit: number): { lines: string[]; truncated: boolean };
      ownRun(actor: AuthenticatedPrincipal, input: { runId: string; projectId?: string }): { projectId: string };
      capacity(): Pick<ServerCapacityStatus, "enabled" | "limit" | "used" | "available">; queue(): TestQueueStatus;
    }) {}

  actions(actor: AuthenticatedPrincipal) {
    if (actor.principalKind !== "agent" || actor.authenticationMethod !== "agent_token") throw new RuntimeAccessDenied();
    return [...new Set(this.authority.runtimeAccessFor(actor).flatMap(entry => entry.actions))];
  }

  runtimeLogs(actor: AuthenticatedPrincipal, value: unknown) {
    const input = parse(logs, value);
    this.check(actor, input.projectId, "logs:read");
    const tail = this.sources.logs(input.projectId, input.limit);
    const result = { projectId: input.projectId, ...boundedLogs(tail.lines, input.limit, tail.truncated) };
    this.check(actor, input.projectId, "logs:read");
    return result;
  }

  testLogs(actor: AuthenticatedPrincipal, value: unknown) {
    const input = parse(runLogs, value);
    const target = { runId: input.runId, ...(input.projectId ? { projectId: input.projectId } : {}) };
    // Existing original principal/credential attribution and current tests:run are mandatory.
    const status = this.sources.ownRun(actor, target);
    this.check(actor, status.projectId, "logs:read");
    const run = this.store.getTestRun(input.runId);
    if (!run || run.projectId !== status.projectId) throw new RuntimeAccessDenied();
    const result = { runId: input.runId, projectId: status.projectId, ...boundedLogs(run.logs, input.limit) };
    this.sources.ownRun(actor, target);
    this.check(actor, status.projectId, "logs:read");
    return result;
  }

  projectStorage(actor: AuthenticatedPrincipal, value: unknown) {
    const input = parse(storage, value);
    this.check(actor, input.projectId, "storage:read");
    const project = this.store.getProject(input.projectId);
    if (!project) throw new RuntimeAccessDenied();
    const path = input.worktreePath ?? project.selectedWorktreePath ?? project.repositoryPath;
    const cached = this.store.getWorktreeStorage(project.id, path);
    // The cache is keyed by the authorized project. Supplied paths never reach a filesystem API.
    const snapshot = cached ? { worktreePath: path, status: cached.status, measuredAt: cached.measuredAt,
      totalBytes: cached.totalBytes, nextBytes: cached.nextBytes, nextCacheBytes: cached.nextCacheBytes,
      nodeModulesBytes: cached.nodeModulesBytes, otherBytes: cached.otherBytes,
      history: cached.history.slice(-16).map(point => ({ measuredAt: point.measuredAt, totalBytes: point.totalBytes,
        nextBytes: point.nextBytes, nextCacheBytes: point.nextCacheBytes, nodeModulesBytes: point.nodeModulesBytes })) } : null;
    this.check(actor, input.projectId, "storage:read");
    return { projectId: project.id, cached: true, snapshot };
  }

  capacity(actor: AuthenticatedPrincipal) {
    this.aggregate(actor);
    const { enabled, limit, used, available } = this.sources.capacity();
    this.aggregate(actor);
    return { enabled, limit, used, available };
  }
  queue(actor: AuthenticatedPrincipal) {
    this.aggregate(actor);
    const { limit, running, queued, admissionBlockReason } = this.sources.queue();
    this.aggregate(actor);
    return { limit, running, queued, available: Math.max(0, limit - running), admissionAvailable: !admissionBlockReason };
  }
  private aggregate(actor: AuthenticatedPrincipal) {
    if (actor.principalKind !== "agent" || actor.authenticationMethod !== "agent_token") throw new RuntimeAccessDenied();
    const access = this.authority.runtimeAccessFor(actor);
    const entry = access.find(entry => entry.actions.includes("capacity:read"));
    if (!entry) throw new RuntimeAccessDenied();
    this.check(actor, entry.projectId, "capacity:read");
  }
  private check(actor: AuthenticatedPrincipal, projectId: string, action: "logs:read" | "storage:read" | "capacity:read") {
    if (actor.principalKind !== "agent" || actor.authenticationMethod !== "agent_token") throw new RuntimeAccessDenied();
    try { this.authority.authorizeRuntime(actor, projectId, action); }
    catch { throw new RuntimeAccessDenied(); }
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ScopedRuntimeError("invalid_request", "Invalid diagnostics request.");
  return parsed.data;
}

/** Known controller credential formats/fields only. Application log secrets require explicit consent. */
export function boundedLogs(input: readonly string[], limit: number, priorTruncation = false) {
  let lines = input.slice(-limit).map(line => line.slice(0, 4000)
    .replace(/\b(?:wsi|wts)_[0-9a-f-]{36}_[0-9a-f]{1,64}\b/gi, "[controller-credential]")
    .replace(/((?:["']?)(?:authorization|cookie|set-cookie|signingSecret|verifierHash|__Secure-wtc\.(?:session_token|two_factor|passkey_challenge)|WORKTREE_(?:CONTROL|SWITCHER)_[A-Z_]*TOKEN)["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi, "$1[redacted]"));
  let truncated = priorTruncation || input.length > lines.length || input.some(line => line.length > 4000);
  while (Buffer.byteLength(JSON.stringify(lines)) > 15 * 1024 && lines.length) { lines = lines.slice(1); truncated = true; }
  return { lines, truncated, observedAt: new Date().toISOString() };
}
