import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getScopedProjectConfigurationSchema, listScopedEnvironmentProfilesSchema, selectScopedEnvironmentProfileSchema,
  setScopedTestPresetTimeoutSchema, type ScopedConfigurationOperation,
} from "@/shared/contracts/scoped-configuration";
import type { ControlService } from "../../control-service";
import { scopedConfigurationFingerprint, type ScopedConfigurationSession } from "../../modules/environments";
import type { AuthenticatedPrincipal } from "../../modules/identity";
import { jsonContent, safe, type ScopedSessionPort } from "./scoped-runtime-tools";

type ScopedConfigurationApi = Pick<ControlService,
  "scopedEnvironmentProfiles" | "selectScopedEnvironmentProfile" | "scopedProjectConfiguration"
  | "setScopedTestPresetTimeout" | "authorizeScopedConfigurationReplay">;

/**
 * Configuration tools for an agent credential. Registration grants nothing:
 * each call needs its own action (`profiles:select` or `config:write`) under the
 * current delegation, credential ceiling and sponsor. Schemas are strict; profile
 * editing, ENV, launch, TLS, capacity and identity settings are not reachable.
 */
export function registerScopedConfigurationTools(server: McpServer, service: ScopedConfigurationApi, actor: AuthenticatedPrincipal, session: ScopedSessionPort): void {
  const configurationSession = (): ScopedConfigurationSession => ({
    owner: session.owner(),
    claimToken: (projectId, reservationId) => session.claimToken(projectId, reservationId),
  });
  const mutation = <T extends { projectId: string; idempotencyKey: string; reservationId?: string }>(
    operation: ScopedConfigurationOperation,
    input: T,
    execute: () => ReturnType<ScopedConfigurationApi["setScopedTestPresetTimeout"]>,
  ) => safe(() => session.runOperation(
    input.idempotencyKey, scopedConfigurationFingerprint(operation, input), execute,
    () => service.authorizeScopedConfigurationReplay(actor, configurationSession(), operation, input.projectId, input.reservationId),
  ));

  server.registerTool("list_environment_profiles", {
    description: "List environment profile names, the selected profile and the configuration revision of one project (profiles:select). Names only: no variables or values.",
    inputSchema: listScopedEnvironmentProfilesSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async input => jsonContent(await safe(() => service.scopedEnvironmentProfiles(actor, input))));

  server.registerTool("select_environment_profile", {
    description: "Select an existing environment profile for future managed-server starts (profiles:select). Requires expectedRevision; a changed selection requires a stopped server and never restarts it. Pass reservationId when the project is claimed by this session.",
    inputSchema: selectScopedEnvironmentProfileSchema,
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async input => jsonContent(await mutation("select_environment_profile", input,
    () => service.selectScopedEnvironmentProfile(actor, configurationSession(), input))));

  server.registerTool("get_project_configuration", {
    description: "Read the configuration revision and the test presets discovered in one exact worktree, with their default and project-wide override timeouts (config:write).",
    inputSchema: getScopedProjectConfigurationSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async input => jsonContent(await safe(() => service.scopedProjectConfiguration(actor, input))));

  server.registerTool("set_test_preset_timeout", {
    description: "Set a project-wide timeout override (1–86400000 ms, or null to remove it) for a preset discovered in the given worktree (config:write). Applies to future enqueues only. Requires expectedRevision; pass reservationId when the project is claimed by this session.",
    inputSchema: setScopedTestPresetTimeoutSchema,
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async input => jsonContent(await mutation("set_test_preset_timeout", input,
    () => service.setScopedTestPresetTimeout(actor, configurationSession(), input))));
}
