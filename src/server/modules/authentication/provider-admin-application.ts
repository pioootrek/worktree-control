import type { DatabaseAdmission } from "../../database-admission";
import type { HumanAccountService, Principal } from "../identity";
import type { AuthenticationService } from "./authentication-service";
import type { AuthenticationProviderRuntime } from "./provider-runtime";
import { parseProviderAdminCommand, ProviderAdminError, providerAdminFailure, type ProviderConfigurationInput } from "./provider-admin-commands";

/** Private persisted material. Never serialize through a transport. */
export interface ProviderConfiguration {
  format: 1; providerId: "better-auth"; entry: string; baseURL: string; secret: string;
}
export interface ProviderConfigurationPort {
  read(): ProviderConfiguration | null;
  configure(input: ProviderConfigurationInput, hasProviderData: boolean): void;
}
export type ProviderMaintenanceState = "not_loaded" | "loading" | "ready" | "failed" | "disposing" | "disposal_unconfirmed";
export interface ProviderAdministrationRuntime {
  state(): ProviderMaintenanceState;
  configurationRestartRequired(current: ProviderConfiguration | null): boolean;
  get(current: ProviderConfiguration): Promise<AuthenticationProviderRuntime>;
}
export interface ProviderAdministrationIdentity {
  ownerStatus(): { state: "none" | "single" | "ambiguous"; principal?: Principal };
  createOwner(actor: "local-cli" | "local-admin"): Principal;
  principal(id: string): (Principal & { enrollment: "absent" | "active" | "revoked" }) | null;
  hasProviderData(): boolean;
}

/** Shared local-operator workflow. Only short synchronous phases hold core admission. */
export class ProviderAdminApplication {
  constructor(private readonly deps: {
    admission: DatabaseAdmission; authentication: AuthenticationService;
    configuration: ProviderConfigurationPort; identity: ProviderAdministrationIdentity;
    runtime: ProviderAdministrationRuntime; maintenance(): boolean;
    actor: "local-cli" | "local-admin";
    humans: HumanAccountService;
  }) {}

  async execute(body: unknown): Promise<unknown> {
    try {
      const request = parseProviderAdminCommand(body), d = this.deps;
      const phase = <T>(operation: () => T) => d.admission.run(() => {
        if (d.maintenance()) throw new ProviderAdminError("maintenance");
        return operation();
      });
      if (request.action === "status") return await phase(() => {
        let current: ProviderConfiguration | null = null, configuration: "missing" | "valid" | "invalid" = "missing";
        try { current = d.configuration.read(); if (current) configuration = "valid"; } catch { configuration = "invalid"; }
        const mode = d.authentication.status();
        const principal = request.principalId === undefined ? undefined : d.identity.principal(request.principalId);
        if (request.principalId !== undefined && !principal) throw new ProviderAdminError("principal_unavailable");
        return { configuration, activeMode: mode.activeMode, configuredMode: mode.configuredMode,
          modeRestartRequired: mode.restartRequired, maintenance: d.runtime.state(),
          configurationRestartRequired: d.runtime.configurationRestartRequired(current),
          productionAccountModeAvailable: false, owner: d.identity.ownerStatus(), ...(principal ? { principal } : {}) };
      });
      if (request.action === "configure") return await phase(() => {
        d.configuration.configure(request.input, d.identity.hasProviderData());
        return { configured: true, configurationRestartRequired: d.runtime.configurationRestartRequired(d.configuration.read()) };
      });
      if (request.action === "owner-create") return await phase(() => ({ principal: d.identity.createOwner(d.actor) }));
      if (request.action === "human-create") return await phase(() => ({ principal: d.humans.create() }));
      if (request.action === "human-list") return await phase(() => d.humans.list(request.input));
      if (request.action === "human-disable") {
        const result = await phase(() => d.humans.disable(request.principalId));
        // Authority ends at the first commit. Yield the sole connection between
        // one-row reclamation transactions; a repeated disable resumes safely.
        while (await phase(() => d.humans.reclaimDisabledSession(request.principalId))) { /* Bounded phases, no provider load. */ }
        return result;
      }
      if (request.action === "knowledge-access-list") return await phase(() => d.humans.memberships(request.input));
      if (request.action === "knowledge-access-set") return await phase(() => d.humans.set(request.input));
      if (request.action === "knowledge-access-revoke") return await phase(() => d.humans.revoke(request.input));
      const material = await phase(() => {
        const current = d.configuration.read();
        if (!current) throw new ProviderAdminError("configuration_missing");
        if (d.runtime.configurationRestartRequired(current)) throw new ProviderAdminError("provider_configuration_restart_required");
        return current;
      });
      // Import, readiness and account effects must never upgrade a core participant.
      const runtime = await d.runtime.get(material);
      if (request.action === "enroll") await runtime.provisionLocal({ principalId: request.principalId, ...request.input, actor: d.actor });
      else await runtime.recoverLocal({ principalId: request.principalId, ...request.input, actor: d.actor });
      return { principalId: request.principalId, ...(request.action === "enroll" ? { enrolled: true } : { recovered: true }) };
    } catch (error) { throw providerAdminFailure(error); }
  }
}
