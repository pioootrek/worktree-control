import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ControlService } from "@/server/control-service";
import type { AuthenticatedPrincipal } from "@/server/modules/identity";
import { remoteSubmissionSchema } from "@/shared/contracts/remote-verification";

export function registerRemoteVerificationTools(server: McpServer, service: ControlService, actor: AuthenticatedPrincipal): void {
  if (!service.remoteVerificationEnabled() || actor.principalKind === "worker") return;
  const content = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const requestId = z.string().min(1).max(128);
  server.registerTool("submit_remote_verification", {
    description: "Verify an exact pushed Git SHA on the selected configured remote worker. Requires a submit grant. No runtime claim or development server.",
    inputSchema: remoteSubmissionSchema, annotations: { idempotentHint: true },
  }, async input => content(service.submitRemoteVerification(input, actor)));
  server.registerTool("get_remote_verification", {
    description: "Read authorized durable request, attempt, result, bounded logs and disconnect/cancellation evidence. Uncertain work is never automatically repeated.",
    inputSchema: { requestId }, annotations: { readOnlyHint: true, idempotentHint: true },
  }, async input => content(service.getRemoteVerification(input.requestId, actor)));
  server.registerTool("get_remote_verification_logs", {
    description: "Read the last uploaded bounded output for an authorized remote request. Live local logs may not yet be uploaded.",
    inputSchema: { requestId }, annotations: { readOnlyHint: true, idempotentHint: true },
  }, async input => {
    const status = service.getRemoteVerification(input.requestId, actor);
    return content({ requestId: input.requestId, attemptId: status.attempt?.id ?? null, logs: status.result?.logs ?? [] });
  });
  server.registerTool("cancel_remote_verification", {
    description: "Persist cancellation intent for your remote request, including while the worker is offline. Intent is separate from confirmed process-tree termination.",
    inputSchema: { requestId }, annotations: { idempotentHint: true },
  }, async input => content(service.cancelRemoteVerification(input.requestId, actor)));
}
