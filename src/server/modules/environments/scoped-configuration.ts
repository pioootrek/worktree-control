import type { GitWorktreeReader } from "@/server/git-worktrees";
import type { LogWriter } from "@/server/log-writer";
import type { ProcessManager } from "@/server/process-manager";
import type { ScopedConfigurationChange, ScopedConfigurationCommitResult, StateStore } from "@/server/state-store";
import type { Project, TestPreset, Worktree } from "@/shared/contracts";
import type { RuntimeAction } from "@/shared/contracts/runtime-access";
import {
  getScopedProjectConfigurationSchema, listScopedEnvironmentProfilesSchema, SCOPED_CONFIGURATION_LIST_LIMIT,
  SCOPED_TEST_PRESET_OVERRIDE_LIMIT, selectScopedEnvironmentProfileSchema, setScopedTestPresetTimeoutSchema,
  type ScopedConfigurationOperation, type ScopedConfigurationReceipt, type ScopedEnvironmentProfiles, type ScopedProjectConfiguration,
} from "@/shared/contracts/scoped-configuration";
import { createHash, randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import type { AuthenticatedPrincipal } from "../identity";
import { leaseTokenHash, type LifecycleAccess } from "../lifecycle";
import { RuntimeAccessDenied, ScopedRuntimeError, type RuntimeAuthorizer } from "../runtime";

/** The transport session that holds lease secrets; it resolves only claims it owns. */
export interface ScopedConfigurationSession {
  owner: string;
  claimToken(projectId: string, reservationId: string): string;
}

const ACTION: Record<ScopedConfigurationOperation, RuntimeAction> = {
  select_environment_profile: "profiles:select",
  set_test_preset_timeout: "config:write",
};

const REFUSALS: Record<Exclude<ScopedConfigurationCommitResult["status"], "completed" | "noop" | "project_missing">, [string, string]> = {
  claim_required: ["claim_required", "The project is claimed. A configuration change requires the caller's own active claim and its reservationId."],
  claim_stale: ["claim_stale", "The claim is stale, expired, or no longer active."],
  claim_worktree_mismatch: ["claim_worktree_mismatch", "The worktree is not the one held by this claim."],
  revision_conflict: ["revision_conflict", "The configuration revision changed. Read the current revision before retrying with a new idempotency key."],
  profile_not_found: ["profile_not_found", "The environment profile does not exist."],
  override_limit: ["override_limit", `A project may hold at most ${SCOPED_TEST_PRESET_OVERRIDE_LIMIT} preset timeout overrides.`],
};

/**
 * Normalized retry fingerprint: operation, project, every effective argument,
 * the expected revision and the claim context. Changing any of them conflicts.
 */
export function scopedConfigurationFingerprint(operation: ScopedConfigurationOperation, value: unknown): string {
  const input = operation === "select_environment_profile"
    ? parse(selectScopedEnvironmentProfileSchema, value)
    : parse(setScopedTestPresetTimeoutSchema, value);
  const normalized = "name" in input
    ? [operation, input.projectId, input.name, input.expectedRevision, input.reservationId ?? null]
    : [operation, input.projectId, input.worktreePath, input.presetId, input.timeoutMs, input.expectedRevision, input.reservationId ?? null];
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * Scoped `profiles:select` and `config:write` use cases. Authority is re-read
 * before lookup, after the shared project lock and every await, and immediately
 * before the atomic commit. Results are explicit allowlists; nothing here reads
 * ENV names or values, creates profiles or reaches a vault.
 */
export class ScopedConfigurationService {
  constructor(
    private readonly authorizer: RuntimeAuthorizer,
    private readonly store: Pick<StateStore, "getProject" | "getProjectConfigurationRevision" | "commitScopedConfiguration">,
    private readonly git: Pick<GitWorktreeReader, "list">,
    private readonly processes: Pick<ProcessManager, "snapshot"> & Partial<Pick<ProcessManager, "statusSummary">>,
    private readonly lifecycle: Pick<LifecycleAccess, "serialized" | "resolveWorktree" | "requireAgentClaim">,
    private readonly discoverPresets: (worktreePath: string) => TestPreset[],
    private readonly logs: Pick<LogWriter, "controller">,
  ) {}

  listEnvironmentProfiles(actor: AuthenticatedPrincipal, value: unknown): ScopedEnvironmentProfiles {
    const input = parse(listScopedEnvironmentProfilesSchema, value);
    this.check(actor, input.projectId, "profiles:select");
    const project = this.requireProject(input.projectId);
    return {
      schemaVersion: 1, projectId: project.id, configurationRevision: this.revision(project.id),
      selectedProfile: project.selectedEnvironmentProfile,
      profiles: project.environmentProfiles.slice(0, SCOPED_CONFIGURATION_LIST_LIMIT).map(({ name }) => ({ name })),
    };
  }

  async selectEnvironmentProfile(actor: AuthenticatedPrincipal, session: ScopedConfigurationSession, value: unknown): Promise<ScopedConfigurationReceipt> {
    const input = parse(selectScopedEnvironmentProfileSchema, value);
    const action = ACTION.select_environment_profile;
    this.check(actor, input.projectId, action);
    const claim = this.claim(session, input.projectId, input.reservationId);
    return this.lifecycle.serialized(input.projectId, async () => {
      this.check(actor, input.projectId, action);
      const project = this.requireProject(input.projectId);
      if (!project.environmentProfiles.some(({ name }) => name === input.name)) throw refusal("profile_not_found");
      // Selection never restarts: a changed selection waits until nothing owned remains, failed cleanup included.
      if (project.selectedEnvironmentProfile !== input.name && this.ownsManagedProcess(project.id)) {
        throw new ScopedRuntimeError("runtime_active", "Stop the managed server before selecting another profile. Selection never restarts it.");
      }
      return this.commit(actor, session, input.projectId, input.expectedRevision, claim, undefined,
        { kind: "select_environment_profile", profileName: input.name });
    });
  }

  async projectConfiguration(actor: AuthenticatedPrincipal, value: unknown): Promise<ScopedProjectConfiguration> {
    const input = parse(getScopedProjectConfigurationSchema, value);
    this.check(actor, input.projectId, "config:write");
    const worktree = await this.discoveredWorktree(actor, input.projectId, input.worktreePath);
    const presets = this.presets(worktree.path);
    this.check(actor, input.projectId, "config:write");
    const project = this.requireProject(input.projectId);
    return {
      schemaVersion: 1, projectId: project.id, configurationRevision: this.revision(project.id),
      presets: presets.slice(0, SCOPED_CONFIGURATION_LIST_LIMIT).map(preset => ({
        id: preset.id, timeoutMs: preset.timeoutMs, overrideTimeoutMs: project.testPresetTimeouts[preset.id] ?? null,
      })),
    };
  }

  async setTestPresetTimeout(actor: AuthenticatedPrincipal, session: ScopedConfigurationSession, value: unknown): Promise<ScopedConfigurationReceipt> {
    const input = parse(setScopedTestPresetTimeoutSchema, value);
    const action = ACTION.set_test_preset_timeout;
    this.check(actor, input.projectId, action);
    const claim = this.claim(session, input.projectId, input.reservationId);
    return this.lifecycle.serialized(input.projectId, async () => {
      this.check(actor, input.projectId, action);
      const worktree = await this.discoveredWorktree(actor, input.projectId, input.worktreePath);
      // Only a preset the controller discovers now may receive an override, not a syntactically valid ID.
      if (!this.presets(worktree.path).some(({ id }) => id === input.presetId)) {
        throw new ScopedRuntimeError("preset_not_found", "The preset is not discovered in this worktree.");
      }
      return this.commit(actor, session, input.projectId, input.expectedRevision, claim, worktree.path, {
        kind: "set_test_preset_timeout", presetId: input.presetId, timeoutMs: input.timeoutMs, overrideLimit: SCOPED_TEST_PRESET_OVERRIDE_LIMIT,
      });
    });
  }

  /** Admission checks precede retry-ledger allocation; operations still recheck at effect boundaries. */
  authorize(actor: AuthenticatedPrincipal, operation: ScopedConfigurationOperation, projectId: string): void {
    this.check(actor, projectId, ACTION[operation]);
  }

  /**
   * A retained receipt is released only to current authority and, when the
   * original operation ran under a claim, only while that exact claim is active.
   */
  authorizeReplay(actor: AuthenticatedPrincipal, session: ScopedConfigurationSession, operation: ScopedConfigurationOperation, projectId: string, reservationId?: string): void {
    this.check(actor, projectId, ACTION[operation]);
    const claim = this.claim(session, projectId, reservationId);
    if (!claim) return;
    try {
      this.lifecycle.requireAgentClaim(projectId, claim.reservationId, { owner: session.owner, leaseToken: claim.leaseToken, binding: bindingOf(actor) });
    } catch {
      throw refusal("claim_stale");
    }
  }

  private commit(
    actor: AuthenticatedPrincipal, session: ScopedConfigurationSession, projectId: string, expectedRevision: number,
    claim: { reservationId: string; leaseToken: string } | null, worktreePath: string | undefined, change: ScopedConfigurationChange,
  ): ScopedConfigurationReceipt {
    const operation = change.kind;
    const operationId = randomUUID();
    // Synchronous from this check through the commit: no await separates decision and write.
    this.check(actor, projectId, ACTION[operation]);
    const result = this.store.commitScopedConfiguration({
      projectId, expectedRevision, change,
      claim: claim && { reservationId: claim.reservationId, owner: session.owner, leaseTokenHash: leaseTokenHash(claim.leaseToken), binding: bindingOf(actor), worktreePath },
      attribution: { principalId: actor.principalId, credentialId: actor.credentialId, operationId },
    });
    if (result.status === "project_missing") throw new RuntimeAccessDenied();
    if (result.status !== "completed" && result.status !== "noop") throw refusal(result.status);
    if (result.status === "completed") {
      this.logs.controller(`agent.${operation}`, { projectId, operationId, principalId: actor.principalId, credentialId: actor.credentialId, revision: result.revision });
    }
    const base = {
      schemaVersion: 1 as const, operationId, projectId, configurationRevision: result.revision, outcome: result.status,
      replayed: false, observedAt: new Date().toISOString(),
    };
    return change.kind === "select_environment_profile"
      ? { ...base, operation: change.kind, selectedProfile: change.profileName }
      : { ...base, operation: change.kind, presetId: change.presetId, timeoutMs: change.timeoutMs };
  }

  private async discoveredWorktree(actor: AuthenticatedPrincipal, projectId: string, requested: string): Promise<Worktree> {
    const project = this.requireProject(projectId);
    let worktrees: Worktree[];
    try { worktrees = await this.git.list(project.repositoryPath); }
    catch { throw unavailableWorktree(); }
    // Git discovery awaited; authority may have changed meanwhile.
    this.check(actor, projectId, "config:write");
    try { return this.lifecycle.resolveWorktree(this.requireProject(projectId), worktrees, requested); }
    catch { throw unavailableWorktree(); }
  }

  private presets(worktreePath: string): TestPreset[] {
    try { return this.discoverPresets(worktreePath); }
    catch { throw new ScopedRuntimeError("preset_discovery_unavailable", "Test preset discovery is unavailable for this worktree."); }
  }

  private claim(session: ScopedConfigurationSession, projectId: string, reservationId: string | undefined): { reservationId: string; leaseToken: string } | null {
    if (reservationId === undefined) return null;
    return { reservationId, leaseToken: session.claimToken(projectId, reservationId) };
  }

  private ownsManagedProcess(projectId: string): boolean {
    const snapshot = this.processes.snapshot(projectId);
    return Boolean(this.processes.statusSummary?.(projectId).ownsProcess) || snapshot.pid !== null
      || snapshot.phase === "starting" || snapshot.phase === "running" || snapshot.phase === "stopping";
  }

  private check(actor: AuthenticatedPrincipal, projectId: string, action: RuntimeAction): void {
    try { this.authorizer.authorizeRuntime(actor, projectId, action); }
    catch { throw new RuntimeAccessDenied(); }
  }

  /** Authorized callers only: a project missing after authorization is the same denial. */
  private requireProject(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (!project) throw new RuntimeAccessDenied();
    return project;
  }

  private revision(projectId: string): number {
    const revision = this.store.getProjectConfigurationRevision(projectId);
    if (revision === null) throw new RuntimeAccessDenied();
    return revision;
  }
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ScopedRuntimeError("invalid_request", "Invalid or unsupported configuration request fields.");
  return parsed.data;
}

function refusal(status: keyof typeof REFUSALS): ScopedRuntimeError {
  const [code, message] = REFUSALS[status];
  return new ScopedRuntimeError(code, message);
}

function unavailableWorktree(): ScopedRuntimeError {
  return new ScopedRuntimeError("worktree_unavailable", "The requested worktree is unavailable.");
}

function bindingOf(actor: AuthenticatedPrincipal) {
  return { principalId: actor.principalId, credentialId: actor.credentialId };
}
