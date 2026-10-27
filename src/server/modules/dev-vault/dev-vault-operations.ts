import type { AuthenticatedPrincipal } from "../identity";
import { devVaultRequestSchema } from "@/shared/contracts/dev-vault";
import { DevVaultError } from "./contracts";
import type { DevVaultService } from "./dev-vault-service";

/** Uses the controller's shared project lifecycle, never a separate lock map. */
export interface DevVaultLifecycle {
  serialized<T>(projectId: string, operation: () => Promise<T>): Promise<T>;
}

/** Online application boundary shared by HTTP, MCP and the online CLI. */
export class DevVaultOperations {
  constructor(private readonly service: DevVaultService, private readonly lifecycle: DevVaultLifecycle) {}

  async execute(input: unknown, actor: AuthenticatedPrincipal) {
    try {
      // Parse and snapshot the command before choosing its lock. Authorization,
      // proof freshness and project existence are checked after admission.
      const parsed = devVaultRequestSchema.safeParse(input);
      if (!parsed.success) throw new DevVaultError("vault_invalid_request");
      return await this.lifecycle.serialized(parsed.data.command.projectId,
        async () => this.service.execute(parsed.data, actor));
    } catch (error) {
      if (error instanceof DevVaultError) throw error;
      throw new DevVaultError("vault_unavailable");
    }
  }
}
