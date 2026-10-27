import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEV_VAULT_DISCLAIMER } from "@/shared/contracts/dev-vault";
import type { DevVaultService } from "@/server/modules/dev-vault";
import type { AuthenticatedPrincipal } from "@/server/modules/identity";
import { devVaultFailure, executeDevVault } from "../dev-vault";

export function registerDevVaultTools(server: McpServer, vault: DevVaultService | undefined, actor: AuthenticatedPrincipal): void {
  if (!vault || actor.principalKind === "worker") return;
  server.registerTool("dev_vault", {
    description: `${DEV_VAULT_DISCLAIMER} Encrypted profiles are separate from literal profiles. Request read/write/use for an exact profile revision. Owner approval requires an external signature. Write executes the immutable approved inline-dotenv patch. Use remains unavailable; no secret delivery or job integration. Reuse operationId only for identical retries; receipts are bounded to 64/24h, and live authorization is rechecked. Never put real credentials in tool arguments.`,
    // Validate values at the application boundary so SDK validation cannot echo secret-bearing keys.
    inputSchema: {
      command: z.unknown().describe("JSON command, always including projectId (runtime project UUID), operationId (retry UUID), environment='DEV', and operation. Operations: import {dotenv}; update {profileId,revision,dotenv}; list {}; read {profileId,revision,grantId}; request {profileId,revision,permission:'read'|'write'|'use', write-only dotenv and source:'inline-dotenv', use-only binding:{commit:40-hex,presetId,commandDigest:64-hex,workerId:UUID}}; requests {}; inspect-request {requestId}; approve {requestId,revision,lifetime:'once'|'15-minutes'|'until-revoked'}; reject {requestId}; revoke {grantId}; write {grantId}; use {profileId,revision,grantId,binding}; audit {}. Owner read omits grantId. Owner operations need an external signed proof; agents cannot create profiles or self-approve. Full contract: docs/dev-environment-vault.md."),
      proof: z.unknown().optional().describe("Owner only: {issuedAt:ISO-UTC,signature:base64 Ed25519}. Requires an active owner session AND the separately configured owner signing key. No installation-token or transport-based substitute."),
    },
    annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input: unknown) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(executeDevVault(vault, input, actor)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(devVaultFailure(error).body) }] }; }
  });
}
