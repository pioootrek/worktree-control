import type { DatabaseAdmission, DatabaseAdmissionOptions } from "@/server/database-admission";
import type { IdentityService, ProviderSessionActor } from "../identity";
import { IdentityError } from "../identity";
import { ScopedRuntimeError } from "../runtime";
import { runtimeReadSchema, type RuntimeReadResult } from "@/shared/contracts/runtime-read";
import type { ScopedProjectStatus, ScopedProjectSummary, ScopedWorktree } from "@/shared/contracts/runtime-access";

/** Supplied controller facade; owns the existing lifecycle, projections and status sampler. */
export interface ProviderRuntimeReadPort {
  scopedProjects(actor: ProviderSessionActor, session: null): ScopedProjectSummary[];
  scopedProjectStatus(actor: ProviderSessionActor, session: null, projectId: string): ScopedProjectStatus;
  scopedWorktrees(actor: ProviderSessionActor, projectId: string, signal?: AbortSignal): Promise<ScopedWorktree[]>;
}

/** Only reads. Authenticate outside admission, authorize and release inside fresh core phases. */
export class ProviderRuntimeReadApplication {
  constructor(private readonly admission: DatabaseAdmission,
    private readonly identity: Pick<IdentityService, "describeIdentity" | "authorizeRuntime">,
    private readonly reads: ProviderRuntimeReadPort) {}

  execute(value: unknown, actor: ProviderSessionActor, options?: DatabaseAdmissionOptions, deliver?: (result: RuntimeReadResult) => void) {
    const parsed = runtimeReadSchema.safeParse(value);
    if (!parsed.success) return Promise.reject(new ScopedRuntimeError("invalid_request", "Invalid runtime read request."));
    const request = parsed.data;
    return this.admission.run(async () => {
      this.requireCurrent(actor);
      let result: RuntimeReadResult;
      switch (request.operation) {
        case "list-projects": result = { operation: request.operation, projects: this.reads.scopedProjects(actor, null) }; break;
        case "project-status": result = { operation: request.operation, status: this.reads.scopedProjectStatus(actor, null, request.projectId) }; break;
        case "list-worktrees": result = { operation: request.operation, worktrees: await this.reads.scopedWorktrees(actor, request.projectId, options?.signal) }; break;
      }
      // Discovery releases admission. Never deliver a retained result under stale authority.
      this.requireCurrent(actor);
      if (request.operation !== "list-projects") this.identity.authorizeRuntime(actor, request.projectId, "projects:read");
      if (options?.signal?.aborted) throw new ScopedRuntimeError("cancelled", "Runtime read cancelled.");
      deliver?.(result);
      return result;
    }, options);
  }
  private requireCurrent(actor: ProviderSessionActor): void {
    if (actor?.authenticationMethod !== "provider_session") throw new IdentityError("invalid_credential", "Invalid provider session.");
    this.identity.describeIdentity(actor);
  }
}
