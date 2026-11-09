import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { scopedRunTestSchema, scopedTestPresetsSchema, scopedTestRunSchema } from "@/shared/contracts/scoped-verification";
import type { ControlService } from "../../control-service";
import type { AuthenticatedPrincipal } from "../../modules/identity";
import { jsonContent, safe, type ScopedSessionPort } from "./scoped-runtime-tools";

type Api = Pick<ControlService, "scopedTestPresets" | "enqueueScopedTest" | "scopedTestRun" | "cancelScopedTest">;

export function registerScopedVerificationTools(server: McpServer, service: Api, actor: AuthenticatedPrincipal, session: ScopedSessionPort): void {
  const scoped = () => ({ owner: session.owner(), claimToken: session.claimToken });
  server.registerTool("list_test_presets", {
    description: "Discover exact worktree paths and supported test preset IDs/timeouts (tests:run). No commands or environment metadata.",
    inputSchema: scopedTestPresetsSchema, annotations: { readOnlyHint: true, idempotentHint: true },
  }, async input => jsonContent(await safe(() => service.scopedTestPresets(actor, input))));
  server.registerTool("run_test", {
    description: "Queue a supported preset in an exact discovered worktree (tests:run). Use reservationId for this session's active claim. Never starts a development server. Both response modes return only safe own-run status.",
    inputSchema: scopedRunTestSchema, annotations: { destructiveHint: true, idempotentHint: true },
  }, async input => jsonContent(await safe(async () => {
    const run = await service.enqueueScopedTest(actor, scoped(), input);
    if (session.closing()) throw new Error("STATUS_CLOSED");
    return service.scopedTestRun(actor, scoped(), { runId: run.runId, projectId: input.projectId });
  })));
  for (const name of ["get_test_run", "get_test_run_status"] as const) server.registerTool(name, {
    description: "Read safe status of a run owned by this exact principal and credential (tests:run). No logs or global queue data.",
    inputSchema: scopedTestRunSchema, annotations: { readOnlyHint: true, idempotentHint: true },
  }, async input => jsonContent(await safe(() => service.scopedTestRun(actor, scoped(), input))));
  server.registerTool("cancel_test_run", {
    description: "Request cancellation of this credential's run from its originating MCP session (tests:run). Running remains running until process cleanup is confirmed.",
    inputSchema: scopedTestRunSchema, annotations: { destructiveHint: true, idempotentHint: true },
  }, async input => jsonContent(await safe(() => service.cancelScopedTest(actor, scoped(), input))));
}
