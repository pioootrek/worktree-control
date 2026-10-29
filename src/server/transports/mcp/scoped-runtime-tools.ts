import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { ClaimedRuntimeAction } from "@/shared/contracts";
import type { ScopedRuntimeReceipt } from "@/shared/contracts/runtime-access";
import type { ScopedConfigurationReceipt } from "@/shared/contracts/scoped-configuration";
import type { ControlService } from "../../control-service";
import type { AuthenticatedPrincipal } from "../../modules/identity";
import { RuntimeAccessDenied, ScopedRuntimeError } from "../../modules/runtime";

type ScopedService = Pick<ControlService,
  "scopedProjects" | "scopedProjectStatus" | "scopedWorktrees" | "claimScopedProject" | "renewScopedClaim"
  | "releaseScopedClaim" | "operateScopedRuntime" | "authorizeScopedRuntimeReplay">;

/** Session-held secrets and timers stay in the MCP runtime; tools only reach them through this port. */
export interface ScopedSessionPort {
  owner(): string;
  closing(): boolean;
  claimToken(projectId: string, reservationId: string): string;
  existingToken(idempotencyScope: string): string | undefined;
  track(claim: { projectId: string; reservationId: string; token: string; ttlSeconds: number; idempotencyScope: string }): void;
  renewed(reservationId: string, ttlSeconds: number): void;
  forget(reservationId: string): void;
  /**
   * Bounded session-only retry ledger shared by runtime and configuration
   * receipts. `beforeReplay` re-authorizes before a retained outcome is returned.
   */
  runOperation<T extends ScopedRuntimeReceipt | ScopedConfigurationReceipt>(idempotencyKey: string, fingerprint: string, execute: () => Promise<T>, beforeReplay: () => void): Promise<T>;
}

export function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** Only fixed scoped codes cross this boundary; unexpected failures never expose internal messages. */
export async function safe<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RuntimeAccessDenied || error instanceof ScopedRuntimeError) throw new Error(`${error.code}: ${error.message}`);
    throw new Error("runtime_operation_failed: The scoped runtime operation failed.");
  }
}

/**
 * Runtime tools for an agent credential. Registration grants nothing: every call
 * is authorized against current delegation, credential ceiling and sponsor.
 * Token minting and grant administration are deliberately not exposed over MCP.
 */
export function registerScopedRuntimeTools(server: McpServer, service: ScopedService, actor: AuthenticatedPrincipal, session: ScopedSessionPort): void {
  const scoped = () => ({ owner: session.owner() });

  server.registerTool("list_projects", {
    description: "List registered projects this credential may read, with runtime phase, placement and own-claim relation.",
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async () => jsonContent(await safe(() => service.scopedProjects(actor, scoped()))));

  server.registerTool("get_project_status", {
    description: "Read safe runtime status and own-claim details of one authorized project.",
    inputSchema: { projectId: z.string().uuid() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ projectId }) => jsonContent(await safe(() => service.scopedProjectStatus(actor, scoped(), projectId))));

  server.registerTool("list_worktrees", {
    description: "List Git worktrees discovered for one authorized project.",
    inputSchema: { projectId: z.string().uuid() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ projectId }) => jsonContent(await safe(() => service.scopedWorktrees(actor, projectId))));

  server.registerTool("claim_project", {
    description: "Acquire an expiring claim on a discovered worktree (claims:manage). The server is started or moved only with start: true, which also requires runtime:control. The claim remains held if startup fails.",
    inputSchema: {
      projectId: z.string().uuid(),
      worktreePath: z.string().min(1).max(4096),
      reason: z.string().min(1).max(240),
      idempotencyKey: z.string().min(1).max(120),
      ttlSeconds: z.number().int().min(30).max(1800).optional(),
      start: z.boolean().optional(),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ projectId, worktreePath, reason, idempotencyKey, ttlSeconds, start }) => {
    const idempotencyScope = `${projectId}:${idempotencyKey}`;
    const { result, leaseToken } = await safe(() => service.claimScopedProject(actor, scoped(), {
      projectId, worktreePath, reason, idempotencyKey, ttlSeconds, start,
    }, session.existingToken(idempotencyScope)));
    if (session.closing()) {
      throw new Error("session_closed: The MCP session closed after claim acquisition. The reservation may remain until its TTL expires; automatic renewal was not started.");
    }
    session.track({ projectId, reservationId: result.reservationId, token: leaseToken, ttlSeconds: ttlSeconds ?? 1800, idempotencyScope });
    return jsonContent(result);
  });

  const registerRuntimeTool = (name: `${ClaimedRuntimeAction}_project`, action: ClaimedRuntimeAction, description: string) => {
    server.registerTool(name, {
      description,
      inputSchema: { projectId: z.string().uuid(), reservationId: z.string().uuid(), idempotencyKey: z.string().min(1).max(120) },
      annotations: { destructiveHint: true, idempotentHint: true },
    }, async ({ projectId, reservationId, idempotencyKey }, extra) => {
      const receipt = await safe(() => {
        const token = session.claimToken(projectId, reservationId);
        return session.runOperation(idempotencyKey, `${action}\0${projectId}\0${reservationId}`,
          () => service.operateScopedRuntime(actor, scoped(), token, projectId, reservationId, action, extra.signal, () => session.closing()),
          () => service.authorizeScopedRuntimeReplay(actor, scoped(), token, projectId, reservationId));
      });
      return jsonContent(receipt);
    });
  };
  registerRuntimeTool("start_project", "start", "Start the managed server on this session's actively claimed worktree (runtime:control). Already running is a no-op.");
  registerRuntimeTool("restart_project", "restart", "Restart the managed server on this session's actively claimed worktree (runtime:control).");
  registerRuntimeTool("stop_project", "stop", "Stop the managed server owned by this session's active claim (runtime:control). The claim remains held.");

  server.registerTool("renew_project_claim", {
    description: "Renew a claim owned by this MCP session (claims:manage) without exposing its lease secret.",
    inputSchema: { projectId: z.string().uuid(), reservationId: z.string().uuid(), ttlSeconds: z.number().int().min(30).max(1800).optional() },
    annotations: { idempotentHint: true },
  }, async ({ projectId, reservationId, ttlSeconds }) => {
    const claim = await safe(() => service.renewScopedClaim(actor, scoped(), projectId, reservationId, session.claimToken(projectId, reservationId), ttlSeconds));
    session.renewed(reservationId, ttlSeconds ?? 1800);
    return jsonContent({ projectId, claim });
  });

  server.registerTool("release_project_claim", {
    description: "Release a claim owned by this MCP session (claims:manage). It does not stop the development server.",
    inputSchema: { projectId: z.string().uuid(), reservationId: z.string().uuid() },
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ projectId, reservationId }) => {
    await safe(() => service.releaseScopedClaim(actor, scoped(), projectId, reservationId, session.claimToken(projectId, reservationId)));
    session.forget(reservationId);
    return jsonContent({ released: true, projectId, reservationId });
  });
}
