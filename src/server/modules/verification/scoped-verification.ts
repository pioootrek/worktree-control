import type { GitWorktreeReader } from "@/server/git-worktrees";
import type { StateStore, TestRunRequester } from "@/server/state-store";
import type { ProjectTestCommandResolver } from "@/server/test-command";
import type { Project, TestPreset, TestRun } from "@/shared/contracts";
import { scopedRunTestSchema, scopedTestPresetsSchema, scopedTestRunSchema, type ScopedTestRunStatus } from "@/shared/contracts/scoped-verification";
import { type AuthenticatedPrincipal } from "../identity";
import { leaseTokenHash } from "../lifecycle";
import { RuntimeAccessDenied, ScopedRuntimeError, type RuntimeAuthorizer } from "../runtime";
import { testProfileFor } from "../environments";
import type { ScopedConfigurationSession } from "../environments";
import { projectTestPreset } from "./preset-timeout";
import type { VerificationService } from "./verification-service";
import type { VerificationJobs } from "./verification-jobs";

/** Shared application policy; all caller bindings come from authenticated server context. */
export class ScopedVerificationService {
  private readonly dispatchAvailable: boolean;
  constructor(
    private readonly authorizer: RuntimeAuthorizer,
    private readonly store: Pick<StateStore, "getProject" | "getTestRunRequester" | "getTestRunStatus" | "authorizeReservation">,
    private readonly git: Pick<GitWorktreeReader, "list">,
    private readonly commands: Pick<ProjectTestCommandResolver, "discover">,
    private readonly verification: VerificationService,
    tests?: VerificationJobs,
    humanDispatch?: (run: TestRun, requester: import("@/server/state-store").HumanTestRunRequester) => void,
  ) {
    this.dispatchAvailable = !!tests?.configureRequesterAuthorizer;
    tests?.configureRequesterAuthorizer?.((run, requester) => {
      if ("kind" in requester) {
        if (!humanDispatch) throw new RuntimeAccessDenied();
        humanDispatch(run, requester);
      } else this.authorizeDispatch(run, requester);
    });
  }

  async presets(actor: AuthenticatedPrincipal, value: unknown) {
    const input = parse(scopedTestPresetsSchema, value);
    this.check(actor, input.projectId);
    const project = this.project(input.projectId);
    let trees;
    try { trees = await this.git.list(project.repositoryPath); }
    catch { throw new ScopedRuntimeError("worktree_unavailable", "Worktree discovery is unavailable."); }
    this.check(actor, input.projectId);
    // An execution-only credential needs its own exact-path discovery; projects:read is independent.
    let remaining = 256;
    const result = trees.filter(tree => !tree.prunable).slice(0, 64).map(tree => ({
      worktreePath: tree.path,
      presets: this.discover(tree.path).slice(0, remaining).map(preset => {
        remaining--;
        return { id: preset.id, timeoutMs: projectTestPreset(this.project(input.projectId), preset).timeoutMs };
      }),
    }));
    this.check(actor, input.projectId);
    if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) throw new ScopedRuntimeError("discovery_limit", "Test discovery exceeds the response limit.");
    return result;
  }

  private discover(path: string): TestPreset[] {
    try { return this.commands.discover(path); }
    catch { throw new ScopedRuntimeError("preset_discovery_unavailable", "Test preset discovery is unavailable."); }
  }

  async enqueue(actor: AuthenticatedPrincipal, session: ScopedConfigurationSession, value: unknown): Promise<ScopedTestRunStatus> {
    const input = parse(scopedRunTestSchema, value);
    this.check(actor, input.projectId);
    if (!this.dispatchAvailable) throw new ScopedRuntimeError("test_queue_unavailable", "Scoped test dispatch authorization is unavailable.");
    const binding = this.binding(actor);
    if (!session.owner.startsWith("agent:mcp:") || session.owner.length <= 10 || session.owner.length > 512) throw invalid();
    const token = input.reservationId ? session.claimToken(input.projectId, input.reservationId) : undefined;
    const requester: TestRunRequester = {
      ...binding, projectId: input.projectId, sessionOwner: session.owner,
      reservationId: input.reservationId ?? null, leaseTokenHash: token ? leaseTokenHash(token) : null,
    };
    const revalidate = () => { this.check(actor, input.projectId); this.reservation(requester, input.worktreePath); };
    revalidate();
    let run: TestRun;
    try {
      run = await this.verification.enqueueTest(input.projectId, input.worktreePath, input.presetId, {
        owner: session.owner, leaseToken: token, binding, revalidate,
      }, input.idempotencyKey, requester, cleanProfile);
    } catch (error) {
      if (error instanceof RuntimeAccessDenied || error instanceof ScopedRuntimeError) throw error;
      throw new ScopedRuntimeError("test_enqueue_failed", "The discovered test preset could not be queued.");
    }
    // The underlying durable retry may refer to a job bound to an older credential or claim.
    const retained = this.owned(actor, run.id);
    if (retained.sessionOwner !== session.owner || retained.reservationId !== requester.reservationId
      || retained.leaseTokenHash !== requester.leaseTokenHash) throw new RuntimeAccessDenied();
    revalidate();
    return this.status(actor, { runId: run.id, projectId: input.projectId });
  }

  status(actor: AuthenticatedPrincipal, value: unknown): ScopedTestRunStatus {
    const input = parse(scopedTestRunSchema, value);
    this.owned(actor, input.runId, input.projectId);
    const run = this.store.getTestRunStatus(input.runId);
    if (!run) throw new RuntimeAccessDenied();
    return safeTestStatus(run);
  }

  async cancel(actor: AuthenticatedPrincipal, session: { owner: string }, value: unknown): Promise<ScopedTestRunStatus> {
    const input = parse(scopedTestRunSchema, value);
    const retained = this.owned(actor, input.runId, input.projectId);
    // Preserve originating-session cancellation; a reconnect does not adopt this right.
    if (retained.sessionOwner !== session.owner) throw new RuntimeAccessDenied();
    await this.verification.cancelTest(input.runId, { owner: session.owner, revalidate: () => {
      const current = this.owned(actor, input.runId, input.projectId);
      if (current.sessionOwner !== session.owner) throw new RuntimeAccessDenied();
    } });
    return this.status(actor, input);
  }

  private owned(actor: AuthenticatedPrincipal, runId: string, projectId?: string): TestRunRequester {
    const binding = this.binding(actor);
    const requester = this.store.getTestRunRequester(runId);
    if (!requester || requester.principalId !== binding.principalId || requester.credentialId !== binding.credentialId
      || (projectId !== undefined && projectId !== requester.projectId)) throw new RuntimeAccessDenied();
    this.check(actor, requester.projectId);
    return requester;
  }

  private authorizeDispatch(run: TestRun, requester: TestRunRequester): void {
    if (run.projectId !== requester.projectId || run.actor !== requester.sessionOwner) throw new RuntimeAccessDenied();
    const actor: AuthenticatedPrincipal = { principalId: requester.principalId, credentialId: requester.credentialId,
      principalKind: "agent", authenticationMethod: "agent_token" };
    this.check(actor, run.projectId);
    this.reservation(requester, run.worktreePath);
    cleanProfile(this.project(run.projectId), { id: run.presetId, name: run.presetName, adapter: run.adapter, timeoutMs: 1 });
  }

  private reservation(requester: TestRunRequester, worktreePath: string): void {
    try {
      const reservation = this.store.authorizeReservation(requester.projectId, requester.sessionOwner,
        requester.leaseTokenHash ?? undefined, { principalId: requester.principalId, credentialId: requester.credentialId });
      if (requester.reservationId !== (reservation?.id ?? null)
        || (reservation && reservation.worktreePath !== worktreePath)) throw new Error("claim changed");
    } catch { throw new ScopedRuntimeError("claim_stale", "The test reservation is unavailable or no longer active."); }
  }

  private project(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (!project) throw new RuntimeAccessDenied();
    return project;
  }
  private binding(actor: AuthenticatedPrincipal) {
    if (actor.principalKind !== "agent" || actor.authenticationMethod !== "agent_token") throw new RuntimeAccessDenied();
    return { principalId: actor.principalId, credentialId: actor.credentialId };
  }
  private check(actor: AuthenticatedPrincipal, projectId: string): void {
    this.binding(actor);
    try { this.authorizer.authorizeRuntime(actor, projectId, "tests:run"); }
    catch { throw new RuntimeAccessDenied(); }
    this.project(projectId);
  }
}

function cleanProfile(project: Project, preset: TestPreset): void {
  // No server-profile secret-use authority is delivered by this slice. Human-configured
  // clean test profiles retain their declared environment policy; vault delivery stays separate.
  if (testProfileFor(project, preset).policy.mode !== "clean") {
    throw new ScopedRuntimeError("test_environment_denied", "This preset requires separate environment authority.");
  }
}
function invalid() { return new ScopedRuntimeError("invalid_request", "Invalid or unsupported verification request fields."); }
function parse<T>(schema: import("zod").ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}

export function safeTestStatus(run: import("@/server/state-store").TestRunStatusRecord): ScopedTestRunStatus {
  return {
    runId: run.id, projectId: run.projectId, presetId: run.presetId, worktreePath: run.worktreePath,
    phase: run.phase, queuedAt: run.queuedAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
    exitCode: run.exitCode, errorCode: run.error ? "test_error" : null,
    source: {
      queuedHead: run.source.enqueue?.head ?? run.worktreeHead,
      preflightHead: run.source.preflight?.head ?? null, finishHead: run.source.finish?.head ?? null,
      attribution: run.source.attribution, processOutcome: run.source.processOutcome,
    },
  };
}
