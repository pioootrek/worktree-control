import type { DatabaseAdmissionOptions } from "@/server/database-admission";
import type { RuntimeMutateResult } from "@/shared/contracts/runtime-mutate";
import type { ProviderSessionActor } from "../identity";
export interface ProviderRuntimeMutatePort {
  mutateHumanRuntime(actor: ProviderSessionActor, value: unknown, options?: DatabaseAdmissionOptions,
    deliver?: (result: RuntimeMutateResult) => void): Promise<RuntimeMutateResult>;
}
/** Transport composition only. The runtime application owns validation, authority and admitted delivery. */
export class ProviderRuntimeMutateApplication {
  constructor(private readonly port: ProviderRuntimeMutatePort) {}
  execute(value: unknown, actor: ProviderSessionActor, options?: DatabaseAdmissionOptions, deliver?: (result: RuntimeMutateResult) => void) {
    return this.port.mutateHumanRuntime(actor, value, options, deliver);
  }
}
