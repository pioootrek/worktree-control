import type { DatabaseAdmission, DatabaseAdmissionOptions } from "@/server/database-admission";
import { IdentityError, type IdentityService, type ProviderSessionActor } from "@/server/modules/identity";
import type { KnowledgeService } from "@/server/modules/knowledge";

/**
 * First provider-session application boundary. Prepare the actor with
 * `runtime.authenticate(headers)` outside admission, then call this boundary.
 * The injected IdentityService must use that runtime as its ProviderSessionAuthority.
 *
 * Each call is a single synchronous core phase: Knowledge checks current
 * authentication and project/action policy before effects and retained results.
 * No callback, asynchronous effect, transport, or installation tool is exposed.
 * Call again after an idle/project-lock wait; never retain a decision across it.
 */
export class ProviderKnowledgeApplication {
  constructor(
    private readonly admission: DatabaseAdmission,
    private readonly identity: Pick<IdentityService, "describeIdentity">,
    private readonly knowledge: Pick<KnowledgeService, "execute">,
  ) {}

  execute(value: unknown, actor: ProviderSessionActor, options?: DatabaseAdmissionOptions) {
    return this.admission.run(() => {
      return this.executeAdmitted(value, actor);
    }, options);
  }

  /** Synchronous phase for transports that release a response in the same admitted callback. */
  executeAdmitted(value: unknown, actor: ProviderSessionActor) {
    this.requireProviderActor(actor);
    this.identity.describeIdentity(actor);
    return this.knowledge.execute(value, actor);
  }

  describeIdentity(actor: ProviderSessionActor, options?: DatabaseAdmissionOptions) {
    return this.admission.run(() => {
      this.requireProviderActor(actor);
      return this.identity.describeIdentity(actor);
    }, options);
  }

  private requireProviderActor(actor: ProviderSessionActor): void {
    if (actor?.authenticationMethod !== "provider_session") throw new IdentityError("invalid_credential", "Invalid provider session.");
  }
}
