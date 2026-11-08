import type { DatabaseAdmissionOptions } from "@/server/database-admission";
import type { ProviderSessionActor } from "../identity";
export interface ProviderVerificationPort {
  humanVerificationOperation(actor: ProviderSessionActor, value: unknown, options?: DatabaseAdmissionOptions,
    deliver?: (result: unknown) => void): Promise<unknown>;
}
/** Transport composition only; shared verification owns current authorization and delivery. */
export class ProviderVerificationApplication {
  constructor(private readonly port: ProviderVerificationPort) {}
  execute(value: unknown, actor: ProviderSessionActor, options?: DatabaseAdmissionOptions, deliver?: (result: unknown) => void) {
    return this.port.humanVerificationOperation(actor, value, options, deliver);
  }
}
