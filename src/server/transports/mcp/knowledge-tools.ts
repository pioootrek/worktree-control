import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { knowledgeSchemas } from "@/shared/contracts/knowledge";
import type { ControlService } from "@/server/control-service";
import type { AuthenticatedPrincipal } from "@/server/modules/identity";
import { knowledgeFailure } from "@/server/modules/knowledge";

const attachmentDescriptions: Record<string, string> = {
  attachment_policy: "Read authorized server attachment limits and project usage: file bytes, total logical bytes and attachment records, remaining capacity and all exceeded constraints. Shared hashes and archived parents still count per record; physicalDiskUsage=null is not a disk-space measurement.",
  check_attachment_batch: "Preflight the WHOLE set before sending base64. Required: projectId, recordKind, recordId, files[{filename,size (decoded bytes),sha256 (lowercase hex)}]. Optional mediaType+idempotencyKey identify identical committed retries, which do not consume capacity again. Names must be unique basenames (1–255 characters, no slash, backslash or controls). Optional evidence declares a task bundle; all its fields are required: setId, taskId matching the target, full commit SHA, command, result, executedAt (ISO time with zone), scope (what the evidence confirms). Store that metadata and manifest as a JSON report attachment with the same setId as screenshots. Preflight validates declarations, not file content; reserves no capacity and gives no atomic batch guarantee. Each upload rechecks current authorization and quota.",
  create_attachment: "Upload one immutable file. Required: projectId, recordKind, recordId, filename (basename, 1–255 characters, no slash, backslash or controls), mediaType, dataBase64 (canonical padded RFC 4648 base64, no data URL), idempotencyKey (1–200 characters). Limits count decoded bytes, not base64 characters. Optional sha256 is lowercase 64-digit SHA-256; server computes and verifies content. Call attachment_policy for dynamic limits and check_attachment_batch for the entire planned set first. Retry identical fields/content with the same idempotencyKey; changed content with that key conflicts. Evidence bundles must record task, setId, commit, command, result, executedAt and scope in a JSON report attachment; use setId in report/screenshot filenames. Image compression and concise reports are recommendations, not admission requirements.",
  task_state: "Read a task's recorded current state with a deterministic assessment: freshness (changes since the state was written), conflicts, unsourced claims, owner-consent tier and evidence presence. Required: projectId, taskId. Nothing is generated; a missing state stays missing.",
  update_task_state: "Record a task's current state; replaces the previous state, keeps it in task history and advances the task revision. Required: projectId, idempotencyKey, taskId, expectedRevision (current task revision), state {changeNote ≤280 chars '<what changed>; blocker: <none|key opened|key resolved>; next: <actor> — <action>; decision: <none|needed|recorded>', outcome, blockers, nextStep, ownerDecision, delivery {merge, ci, review, evidence, deploy}}. Each field is known, explicitly none/not applicable, or {known:false}. Optional status changes task status atomically. Consent is never written: ownerDecision.recorded only points to a decision memory. Call approve_memory only on the owner's explicit instruction.",
};

/** Scoped sessions expose knowledge only; legacy runtime sessions never enter here. */
export function registerKnowledgeTools(server: McpServer, service: ControlService, actor: AuthenticatedPrincipal): void {
  for (const [operation, schema] of Object.entries(knowledgeSchemas)) {
    const readOnly = ["project", "projects", "threads", "thread", "replies", "reply", "tasks", "task", "relations", "history", "memories", "memory", "search", "task_context", "task_state", "export_context", "check_context_export", "attachments", "attachment", "attachment_policy", "check_attachment_batch"].includes(operation);
    server.registerTool(`knowledge_${operation}`, {
      description: attachmentDescriptions[operation] ?? `${operation.replaceAll("_", " ")} in project knowledge. Writes require a stable idempotencyKey; reuse it for an identical retry. Read pages expose nextOffset. No runtime claim or server operation.`,
      inputSchema: schema,
      annotations: { readOnlyHint: readOnly, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    }, async (input: unknown) => {
      try {
        const result = service.executeKnowledge({ operation, input }, actor);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(knowledgeFailure(error).body) }] };
      }
    });
  }
}
