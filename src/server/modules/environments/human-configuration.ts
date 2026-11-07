import { randomUUID } from "node:crypto";
import { type DatabaseAdmission, admissionOf, databaseAdmissionFailure, type DatabaseAdmissionOptions } from "@/server/database-admission";
import type { GitWorktreeReader } from "@/server/git-worktrees";
import type { ProcessManager } from "@/server/process-manager";
import type { StateStore } from "@/server/state-store";
import type { TestPreset } from "@/shared/contracts";
import { humanConfigurationSchema } from "@/shared/contracts/human-configuration";
import { SCOPED_CONFIGURATION_LIST_LIMIT } from "@/shared/contracts/scoped-configuration";
import type { RuntimeAction } from "@/shared/contracts/runtime-access";
import type { ProviderSessionActor } from "../identity";
import type { LifecycleAccess } from "../lifecycle";
import { RuntimeAccessDenied, ScopedRuntimeError, sameHumanRuntimeAuthority, type HumanRuntimeAuthorizer, type HumanRuntimeStore } from "../runtime";
import { humanConfigurationFingerprint, type HumanConfigurationIntent, type HumanConfigurationStore } from "./human-configuration-store";

/** Actual-provider-session operations, sharing lifecycle and the agent/legacy configuration aggregate. */
export class HumanConfigurationService {
  constructor(private readonly authorizer: HumanRuntimeAuthorizer,
    private readonly store: Pick<StateStore, "getProject" | "getActiveReservation" | "getProjectConfigurationRevision"> & HumanConfigurationStore & { admission: DatabaseAdmission },
    private readonly leases: HumanRuntimeStore, private readonly git: Pick<GitWorktreeReader, "list">,
    private readonly processes: Pick<ProcessManager, "snapshot" | "statusSummary">,
    private readonly lifecycle: Pick<LifecycleAccess, "serialized" | "resolveWorktree">,
    private readonly discover: (path: string) => TestPreset[]) {}

  execute(value: unknown, actor: ProviderSessionActor, options?: DatabaseAdmissionOptions, deliver?: (result: unknown) => void): Promise<unknown> {
    const parsed = humanConfigurationSchema.safeParse(value);
    if (!parsed.success) return Promise.reject(new ScopedRuntimeError("invalid_request", "Invalid configuration request."));
    const input = parsed.data, action: RuntimeAction = input.operation === "profiles" || input.operation === "select_environment_profile" ? "profiles:select" : "config:write";
    const admission = admissionOf(this.store);
    return admission.run(async () => {
      const original = this.authorizer.resolveHumanRuntimeAuthority(actor, input.projectId, [action]);
      const current = () => {
        const authority = this.authorizer.resolveHumanRuntimeAuthority(actor, input.projectId, [action]);
        if (!sameHumanRuntimeAuthority(original, authority)) throw new RuntimeAccessDenied();
        if (options?.signal?.aborted) throw new ScopedRuntimeError("cancelled", "Configuration request cancelled.");
      };
      current();
      let intent: HumanConfigurationIntent | undefined, prior: import("@/shared/contracts/scoped-configuration").ScopedConfigurationReceipt | null = null;
      if (input.operation === "select_environment_profile" || input.operation === "set_test_preset_timeout") {
        intent = { authority: original, request: input, projectId: input.projectId, key: input.idempotencyKey,
          fingerprint: "",
          reservationId: input.reservationId ?? null, worktreePath: "worktreePath" in input ? input.worktreePath : null };
        // Capture placement before allocating an intent. A new claim can never adopt this request.
        if (intent.reservationId && !intent.worktreePath) intent.worktreePath = this.lease(intent, action).worktreePath;
        intent.fingerprint = humanConfigurationFingerprint(intent);
        this.reservation(intent, action);
        prior = this.store.beginHumanConfiguration(intent);
      }
      const context = intent;
      const result = await this.lifecycle.serialized(input.projectId, async () => {
        current();
        if (context) this.reservation(context, action);
        if (prior) return { ...prior, replayed: true };
        let project = this.project(input.projectId);
        if (input.operation === "profiles") return { schemaVersion: 1, projectId: project.id,
          configurationRevision: this.revision(project.id), selectedProfile: project.selectedEnvironmentProfile,
          profiles: project.environmentProfiles.slice(0, SCOPED_CONFIGURATION_LIST_LIMIT).map(({ name }) => ({ name })) };
        if (input.operation === "configuration" || input.operation === "set_test_preset_timeout") {
          let trees;
          try { trees = await admission.idle(() => this.git.list(project.repositoryPath), options); }
          catch (error) { if (databaseAdmissionFailure(error)) throw error; current(); throw unavailable(); }
          current();
          if (context) this.reservation(context, action);
          project = this.project(input.projectId);
          let path: string;
          try { path = this.lifecycle.resolveWorktree(project, trees, input.worktreePath).path; } catch { throw unavailable(); }
          let presets;
          try { presets = this.discover(path); } catch { throw new ScopedRuntimeError("preset_discovery_unavailable", "Test preset discovery is unavailable."); }
          current();
          if (input.operation === "configuration") return { schemaVersion: 1, projectId: project.id, configurationRevision: this.revision(project.id),
            presets: presets.slice(0, SCOPED_CONFIGURATION_LIST_LIMIT).map(p => ({ id: p.id, timeoutMs: p.timeoutMs, overrideTimeoutMs: project.testPresetTimeouts[p.id] ?? null })) };
          if (!presets.some(p => p.id === input.presetId)) throw new ScopedRuntimeError("preset_not_found", "The preset is not discovered in this worktree.");
        } else {
          if (!project.environmentProfiles.some(p => p.name === input.name)) throw new ScopedRuntimeError("profile_not_found", "The environment profile does not exist.");
          const snapshot = this.processes.snapshot(project.id);
          if (project.selectedEnvironmentProfile !== input.name && (this.processes.statusSummary(project.id).ownsProcess || snapshot.pid !== null
            || ["starting", "running", "stopping"].includes(snapshot.phase))) throw new ScopedRuntimeError("runtime_active", "Stop the managed server before selecting another profile.");
        }
        current(); this.reservation(context!, action);
        return this.store.commitHumanConfiguration({ intent: context!, operationId: randomUUID() });
      });
      current();
      if (context) this.reservation(context, action);
      deliver?.(result);
      return result;
    }, options);
  }
  private lease(intent: HumanConfigurationIntent, action: RuntimeAction) {
    const lease = this.leases.lease(intent.reservationId!);
    if (!lease || lease.released || !lease.reservation.expiresAt || lease.reservation.expiresAt <= new Date().toISOString()
      || lease.reservation.projectId !== intent.projectId || !sameHumanRuntimeAuthority(lease.authority, intent.authority)
      || !lease.authority.permissions.includes(action)) throw stale();
    return lease.reservation;
  }
  private reservation(intent: HumanConfigurationIntent, action: RuntimeAction) {
    let active;
    try { active = this.store.getActiveReservation(intent.projectId); } catch { throw stale(); }
    if (!intent.reservationId) { if (active) throw stale(); return; }
    const lease = this.lease(intent, action);
    if (!active || active.id !== intent.reservationId || active.worktreePath !== intent.worktreePath || lease.worktreePath !== intent.worktreePath) throw stale();
  }
  private project(id: string) { const p = this.store.getProject(id); if (!p) throw new RuntimeAccessDenied(); return p; }
  private revision(id: string) { const r = this.store.getProjectConfigurationRevision(id); if (r === null) throw new RuntimeAccessDenied(); return r; }
}
function stale() { return new ScopedRuntimeError("claim_stale", "The original configuration reservation is unavailable."); }
function unavailable() { return new ScopedRuntimeError("worktree_unavailable", "The requested worktree is unavailable."); }
