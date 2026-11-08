import type { DatabaseAdmissionOptions } from "@/server/database-admission";
import type { ProviderSessionActor } from "../identity";
export interface ProviderConfigurationApplicationPort {
  humanConfigurationOperation(actor: ProviderSessionActor, value: unknown, options?: DatabaseAdmissionOptions,
    deliver?: (result: unknown) => void): Promise<unknown>;
}
/** Closed transport composition; authorization and effects live in the shared application. */
export class ProviderConfigurationApplication {
  constructor(private readonly port: ProviderConfigurationApplicationPort) {}
  execute(value: unknown, actor: ProviderSessionActor, options?: DatabaseAdmissionOptions, deliver?: (result: unknown) => void) {
    return this.port.humanConfigurationOperation(actor, value, options, deliver);
  }
}
