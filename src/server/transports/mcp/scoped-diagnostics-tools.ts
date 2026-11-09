import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ControlService } from "../../control-service";
import type { AuthenticatedPrincipal } from "../../modules/identity";
import { jsonContent, safe } from "./scoped-runtime-tools";

type Api = Pick<ControlService, "scopedDiagnosticActions" | "scopedRuntimeLogs" | "scopedTestLogs" | "scopedProjectStorage" | "scopedServerCapacity" | "scopedTestQueue">;

export function registerScopedDiagnosticsTools(server: McpServer, service: Api, actor: AuthenticatedPrincipal) {
  const actions = service.scopedDiagnosticActions(actor);
  const annotations = { readOnlyHint: true, idempotentHint: true };
  const limit = z.number().int().min(1).max(100).optional();
  const projectId = z.string().uuid();
  if (actions.includes("logs:read")) {
    server.registerTool("get_runtime_logs", { description: "Bounded retained runtime log tail for an authorized project (explicit logs:read). Application logs may contain secrets.",
      inputSchema: { projectId, limit }, annotations }, async input => jsonContent(await safe(() => service.scopedRuntimeLogs(actor, input))));
    if (actions.includes("tests:run")) server.registerTool("get_test_run_logs", { description: "Bounded own-run log tail (logs:read AND current tests:run, exact original principal/credential attribution).",
      inputSchema: { runId: z.string().uuid(), projectId: projectId.optional(), limit }, annotations },
    async input => jsonContent(await safe(() => service.scopedTestLogs(actor, input))));
  }
  if (actions.includes("storage:read")) server.registerTool("get_project_storage", { description: "Read cached size and bounded history for one project/worktree (storage:read). No scan, contents or cleanup.",
    inputSchema: { projectId, worktreePath: z.string().min(1).max(4096).optional() }, annotations },
  async input => jsonContent(await safe(() => service.scopedProjectStorage(actor, input))));
  if (actions.includes("capacity:read")) {
    server.registerTool("get_server_capacity", { description: "Aggregate server availability/counts (capacity:read). No holder identities.", annotations },
      async () => jsonContent(await safe(() => service.scopedServerCapacity(actor))));
    server.registerTool("get_test_queue", { description: "Aggregate test queue availability/counts (capacity:read). No project, run or owner identities.", annotations },
      async () => jsonContent(await safe(() => service.scopedTestQueue(actor))));
    for (const [name, uri, read] of [
      ["server-capacity", "worktree-switcher://capacity", () => service.scopedServerCapacity(actor)],
      ["test-queue", "worktree-switcher://tests/queue", () => service.scopedTestQueue(actor)],
    ] as const) server.registerResource(name, uri, { description: "Authorized aggregate capacity counts", mimeType: "application/json" },
      async url => ({ contents: [{ uri: url.href, mimeType: "application/json", text: JSON.stringify(await safe<unknown>(read)) }] }));
  }
}
