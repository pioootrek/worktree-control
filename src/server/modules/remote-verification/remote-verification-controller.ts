import { remoteReportSchema, remoteSubmissionSchema, type RemoteAssignment } from "@/shared/contracts/remote-verification";
import type { AuthenticatedPrincipal, IdentityService } from "@/server/modules/identity";
import type { RemoteConnectionStore, RemoteControllerStore } from "./connection-contracts";
import { RemoteVerificationService } from "./remote-verification-service";
import { RemoteVerificationAttemptService } from "./remote-verification-attempt-service";

export class RemoteProtocolError extends Error {
  constructor(readonly code: string) { super(code); }
}
const terminal = new Set(["succeeded", "failed", "cancelled"]);

/** Shared authorization and operations for MCP callers and the outbound worker protocol. */
export class RemoteVerificationController {
  private readonly submissions: RemoteVerificationService;
  private readonly attempts: RemoteVerificationAttemptService;
  constructor(
    private readonly store: RemoteControllerStore,
    private readonly connection: RemoteConnectionStore,
    private readonly identity: Pick<IdentityService, "describeIdentity">,
    private readonly now = () => new Date().toISOString(),
  ) {
    this.submissions = new RemoteVerificationService(store, now);
    this.attempts = new RemoteVerificationAttemptService(store, now);
  }
  recover(): number { return this.attempts.recoverInterruptedAttempts(); }

  submit(input: unknown, actor: AuthenticatedPrincipal) {
    this.identity.describeIdentity(actor);
    return this.submissions.submit(remoteSubmissionSchema.parse(input), actor);
  }
  status(requestId: string, actor: AuthenticatedPrincipal) {
    const request = this.authorizeRequest(requestId, actor, "read");
    const attempt = this.store.findRemoteVerificationAttemptForRequest(request.id);
    const worker = this.store.getRemoteWorker(request.workerId);
    const disconnected = !worker?.lastContactAt || Date.parse(this.now()) - Date.parse(worker.lastContactAt) > 30_000;
    return {
      request, attempt, cancellationRequested: this.connection.cancellationRequested(request.id),
      lastContactAt: worker?.lastContactAt ?? null,
      executionUncertain: !!attempt && !terminal.has(attempt.phase) && (disconnected || attempt.phase === "uncertain"),
      result: attempt ? this.connection.latestReport(attempt.id) : null,
      artifacts: [],
    };
  }
  cancel(requestId: string, actor: AuthenticatedPrincipal) {
    const request = this.authorizeRequest(requestId, actor, "submit");
    if (request.requestedBy !== actor.principalId) throw new RemoteProtocolError("cancel_forbidden");
    if (request.phase !== "completed" && request.phase !== "cancelled") this.connection.requestCancellation(request.id, this.now());
    return { requestId, cancellationRequested: this.connection.cancellationRequested(request.id) };
  }
  poll(workerId: string, actor: AuthenticatedPrincipal) {
    this.authorizeWorker(workerId, actor);
    const assignments: RemoteAssignment[] = [];
    for (const requestId of this.connection.pendingRequests(workerId)) {
      const request = this.store.getRemoteVerificationRequest(requestId)!;
      // Revalidate the source identity and both grants at delivery, after queue wait.
      try {
        this.authorizeProject(workerId, request.projectId, request.presetId);
        const submitter = this.store.getRemotePrincipal(request.requestedBy);
        const grant = this.store.getRemotePrincipalProjectGrant(request.requestedBy, request.projectId);
        if (submitter?.status !== "active" || grant?.revokedAt !== null || !grant.permissions.includes("submit")) continue;
        const attempt = this.attempts.assign({ requestId, workerId }, actor);
        assignments.push({ requestId, attemptId: attempt.id, workerId, projectId: request.projectId, presetId: request.presetId, commitSha: request.commitSha });
        break;
      } catch { continue; }
    }
    return { version: 1 as const, assignments, cancellations: this.connection.cancellationAttempts(workerId) };
  }
  report(workerId: string, input: unknown, actor: AuthenticatedPrincipal) {
    this.authorizeWorker(workerId, actor);
    const report = remoteReportSchema.parse(input);
    return this.connection.atomic(() => {
      const attempt = this.store.getRemoteVerificationAttempt(report.attemptId);
      if (!attempt || attempt.workerId !== workerId) throw new RemoteProtocolError("assignment_forbidden");
      const request = this.store.getRemoteVerificationRequest(attempt.requestId)!;
      this.authorizeProject(workerId, request.projectId, request.presetId);
      const previous = this.connection.report(attempt.id, report.sequence);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(report)) throw new RemoteProtocolError("report_conflict");
        return { acceptedSequence: report.sequence };
      }
      const latest = this.connection.latestReport(attempt.id);
      if (report.sequence !== (latest?.sequence ?? 0) + 1 || terminal.has(attempt.phase)) throw new RemoteProtocolError("stale_report");
      if (latest && latest.localRunId !== report.localRunId) throw new RemoteProtocolError("invalid_evidence");
      for (const key of ["presetFingerprint", "environmentFingerprint", "executedCommitSha"] as const) {
        if (latest?.[key] !== undefined && report[key] !== undefined && latest[key] !== report[key]) throw new RemoteProtocolError("invalid_evidence");
      }
      if (["running", "succeeded"].includes(report.phase) || report.failureKind === "execution") {
        if (!report.presetFingerprint || !report.environmentFingerprint || report.executedCommitSha !== request.commitSha) throw new RemoteProtocolError("invalid_evidence");
      }
      if (report.phase === "succeeded" && (report.source?.attribution !== "observed_match" || report.source.finishCommitSha !== request.commitSha || report.exitCode !== 0)) throw new RemoteProtocolError("invalid_evidence");
      if (terminal.has(report.phase) && attempt.executedCommitSha && report.execution?.cleanup !== "confirmed") throw new RemoteProtocolError("cleanup_unconfirmed");
      let current = attempt;
      if (report.phase === "cancelled") {
        if (!this.connection.cancellationRequested(request.id)) throw new RemoteProtocolError("cancellation_not_requested");
        if (current.phase !== "cancel_requested") current = this.attempts.report({ attemptId: current.id, expectedVersion: current.version, phase: "cancel_requested" }, actor);
      }
      // Report sequencing is durable and independent of controller restart/version recovery.
      this.attempts.report({
        attemptId: current.id, expectedVersion: current.version, phase: report.phase,
        localRunId: report.localRunId, executedCommitSha: report.executedCommitSha,
        failureKind: report.failureKind, errorCode: report.errorCode,
      }, actor);
      this.connection.saveReport(report);
      return { acceptedSequence: report.sequence };
    });
  }
  private authorizeRequest(requestId: string, actor: AuthenticatedPrincipal, permission: "read" | "submit") {
    this.identity.describeIdentity(actor);
    const request = this.store.getRemoteVerificationRequest(requestId);
    const project = request ? this.store.getRemoteProjectIdentity(request.projectId) : null;
    const grant = request ? this.store.getRemotePrincipalProjectGrant(actor.principalId, request.projectId) : null;
    if (actor.principalKind === "worker" || !request || project?.status !== "active" || !grant || grant.revokedAt || !grant.permissions.includes(permission)) throw new RemoteProtocolError("request_forbidden");
    return request;
  }
  private authorizeWorker(workerId: string, actor: AuthenticatedPrincipal) {
    this.identity.describeIdentity(actor);
    const worker = this.store.getRemoteWorker(workerId);
    if (actor.authenticationMethod !== "worker_token" || actor.principalKind !== "worker" || !worker || worker.status !== "active" || worker.principalId !== actor.principalId) throw new RemoteProtocolError("worker_forbidden");
    this.connection.contact(workerId, this.now());
  }
  private authorizeProject(workerId: string, projectId: string, presetId: string) {
    const project = this.store.getRemoteProjectIdentity(projectId);
    const grant = this.store.getRemoteWorkerProjectGrant(workerId, projectId);
    if (!project || project.status !== "active" || !grant || grant.revokedAt || !grant.presetIds.includes(presetId)) throw new RemoteProtocolError("project_forbidden");
  }
}
