import { createHash } from "node:crypto";
import { admissionOf, databaseAdmissionFailure, type DatabaseAdmissionOptions } from "@/server/database-admission";
import type { GitWorktreeReader } from "@/server/git-worktrees";
import type { StateStore, HumanTestRunRequester } from "@/server/state-store";
import type { ProjectTestCommandResolver } from "@/server/test-command";
import type { TestRun, TestPreset, Project } from "@/shared/contracts";
import { humanVerificationSchema } from "@/shared/contracts/human-verification";
import type { ProviderSessionActor, HumanVerificationAuthorizer } from "../identity";
import type { HumanRuntimeStore } from "../runtime";
import { sameHumanRuntimeAuthority, RuntimeAccessDenied, ScopedRuntimeError } from "../runtime";
import { testProfileFor } from "../environments";
import type { StatusService } from "../status";
import { projectTestPreset } from "./preset-timeout";
import type { VerificationService } from "./verification-service";
import { safeTestStatus } from "./scoped-verification";

/** Human queue operations use actual provider authority; they never manufacture an agent/session. */
export class HumanVerificationService {
  constructor(private readonly authorizer: HumanVerificationAuthorizer,
    private readonly store: Pick<StateStore, "getProject" | "getActiveReservation" | "getHumanTestRunRequester" | "getTestRunStatus">,
    private readonly leases: HumanRuntimeStore, private readonly git: Pick<GitWorktreeReader, "list">,
    private readonly commands: Pick<ProjectTestCommandResolver, "discover">,
    private readonly verification: VerificationService, private readonly status: StatusService,
    private readonly dispatchAvailable: boolean) {}

  execute(value: unknown, actor: ProviderSessionActor, options?: DatabaseAdmissionOptions, deliver?: (result: unknown) => void): Promise<unknown> {
    const parsed = humanVerificationSchema.safeParse(value);
    if (!parsed.success) return Promise.reject(new ScopedRuntimeError("invalid_request", "Invalid verification request."));
    const input = parsed.data, admission = admissionOf(this.store);
    return admission.run(async () => {
      let original: HumanTestRunRequester;
      if (input.operation === "presets" || input.operation === "enqueue") {
        const captured = this.capture(actor, input.projectId);
        original = { kind: "human", projectId: input.projectId, ...captured,
          sessionOwner: `human:test:${captured.authority.principalId}`,
          reservationId: input.operation === "enqueue" ? input.reservationId ?? null : null,
          fingerprint: createHash("sha256").update(JSON.stringify(input)).digest("hex") };
      } else original = this.owned(actor, input.runId, input.projectId);
      const current = () => { this.check(original); this.sameSession(actor, original); this.cancelled(options); };
      current();
      let result: unknown;
      if (input.operation === "presets") {
        const project = this.project(original.projectId);
        let trees;
        try { trees = await admission.idle(() => this.git.list(project.repositoryPath), options); }
        catch (error) { if (databaseAdmissionFailure(error)) throw error; current(); throw new ScopedRuntimeError("worktree_unavailable", "Worktree discovery is unavailable."); }
        current();
        let remaining = 256;
        result = trees.filter(tree => !tree.prunable).slice(0, 64).map(tree => ({ worktreePath: tree.path,
          presets: this.discover(tree.path).filter(preset => testProfileFor(this.project(project.id), preset).policy.mode === "clean")
            .slice(0, remaining).map(preset => { remaining--; return { id: preset.id, timeoutMs: projectTestPreset(this.project(project.id), preset).timeoutMs }; }),
        }));
        if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) throw new ScopedRuntimeError("discovery_limit", "Test discovery exceeds the response limit.");
      } else if (input.operation === "enqueue") {
        if (!this.dispatchAvailable || !this.store.getHumanTestRunRequester) throw new ScopedRuntimeError("test_queue_unavailable", "Human test dispatch is unavailable.");
        const verify = () => { current(); this.reservation(original, input.worktreePath); };
        verify();
        let run;
        try {
          run = await this.verification.enqueueTest(input.projectId, input.worktreePath, input.presetId, {
            owner: original.sessionOwner, revalidate: verify,
            humanTestReservation: (projectId, path) => {
              if (projectId !== original.projectId || path !== input.worktreePath) throw new RuntimeAccessDenied();
              verify();
            },
          }, input.idempotencyKey, original, cleanProfile);
        } catch (error) {
          if (databaseAdmissionFailure(error) || error instanceof ScopedRuntimeError || error instanceof RuntimeAccessDenied) throw error;
          throw new ScopedRuntimeError("test_enqueue_failed", "The discovered test preset could not be queued.");
        }
        const retained = this.owned(actor, run.id, input.projectId);
        if (retained.fingerprint !== original.fingerprint || retained.reservationId !== original.reservationId) {
          throw new ScopedRuntimeError("idempotency_conflict", "The intent differs from the retained test run.");
        }
        verify();
        result = this.envelope(actor, run.id, original.projectId);
      } else if (input.operation === "status") result = this.envelope(actor, input.runId, input.projectId);
      else if (input.operation === "cancel") {
        await this.verification.cancelTest(input.runId, { owner: original.sessionOwner, revalidate: current });
        current();
        result = this.envelope(actor, input.runId, input.projectId);
      } else {
        result = await this.status.wait({ kind: "scoped-run", id: input.runId,
          read: () => { current(); return this.envelope(actor, input.runId, input.projectId); } },
          input.cursor, this.waitBinding(original), input.timeoutMs, options?.signal);
      }
      current();
      deliver?.(result);
      return result;
    }, options);
  }

  /** Called by the ONE typed dispatcher, within existing queue admission. */
  authorizeDispatch(run: TestRun, requester: HumanTestRunRequester): void {
    if (run.projectId !== requester.projectId || run.actor !== requester.sessionOwner) throw new RuntimeAccessDenied();
    this.check(requester);
    this.reservation(requester, run.worktreePath);
    cleanProfile(this.project(run.projectId), { id: run.presetId, name: run.presetName, adapter: run.adapter, timeoutMs: 1 });
  }
  private discover(path: string): TestPreset[] {
    try { return this.commands.discover(path); } catch { throw new ScopedRuntimeError("preset_discovery_unavailable", "Test preset discovery is unavailable."); }
  }
  private capture(actor: ProviderSessionActor, projectId: string) {
    try { return this.authorizer.captureHumanVerificationAuthority(actor, projectId); } catch { throw new RuntimeAccessDenied(); }
  }
  private sameSession(actor: ProviderSessionActor, original: HumanTestRunRequester): void {
    const { authority, reference } = this.capture(actor, original.projectId);
    if (!sameHumanRuntimeAuthority(authority, original.authority) || reference.nativeSessionId !== original.reference.nativeSessionId) throw new RuntimeAccessDenied();
  }
  private check(requester: HumanTestRunRequester): void {
    try { this.authorizer.validateHumanVerificationAuthority(requester.authority, requester.reference, requester.projectId); }
    catch { throw new RuntimeAccessDenied(); }
    this.project(requester.projectId);
  }
  private owned(actor: ProviderSessionActor, id: string, projectId?: string): HumanTestRunRequester {
    let retained;
    try { retained = this.store.getHumanTestRunRequester?.(id); } catch { throw new RuntimeAccessDenied(); }
    if (!retained || (projectId !== undefined && retained.projectId !== projectId)) throw new RuntimeAccessDenied();
    this.check(retained); this.sameSession(actor, retained);
    return retained;
  }
  private envelope(actor: ProviderSessionActor, id: string, projectId?: string) {
    const requester = this.owned(actor, id, projectId), run = this.store.getTestRunStatus(id);
    if (!run) throw new RuntimeAccessDenied();
    return this.status.scopedTest(safeTestStatus(run), this.waitBinding(requester));
  }
  private waitBinding(r: HumanTestRunRequester) { return JSON.stringify(["provider", r.authority.principalId, r.authority.sessionKey]); }
  private reservation(r: HumanTestRunRequester, worktreePath: string): void {
    const active = this.store.getActiveReservation(r.projectId);
    if (!r.reservationId) { if (active) throw stale(); return; }
    const retained = this.leases.lease(r.reservationId), now = new Date().toISOString();
    if (!active || active.id !== r.reservationId || active.worktreePath !== worktreePath || !retained || retained.released
      || !retained.reservation.expiresAt || retained.reservation.expiresAt <= now
      || !sameHumanRuntimeAuthority(retained.authority, r.authority)) throw stale();
  }
  private project(id: string) { const p = this.store.getProject(id); if (!p) throw new RuntimeAccessDenied(); return p; }
  private cancelled(options?: DatabaseAdmissionOptions) { if (options?.signal?.aborted) throw new ScopedRuntimeError("cancelled", "Verification request cancelled."); }
}
function stale() { return new ScopedRuntimeError("claim_stale", "The original test reservation is unavailable."); }
function cleanProfile(project: Project, preset: TestPreset) {
  if (testProfileFor(project, preset).policy.mode !== "clean") throw new ScopedRuntimeError("test_environment_denied", "This preset requires separate environment authority.");
}
