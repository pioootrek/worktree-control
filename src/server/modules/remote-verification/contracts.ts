import type { IdentityStatus, Principal, PrincipalKind } from "@/server/modules/identity";

export type RemotePrincipalKind = PrincipalKind;
export type RemoteIdentityStatus = IdentityStatus;
export type RemotePrincipal = Principal;

export interface RemoteProjectIdentity {
  id: string;
  name: string;
  sourceRemote: string;
  status: RemoteIdentityStatus;
}

export interface RemoteWorkerRegistration {
  id: string;
  principalId: string;
  name: string;
  status: RemoteIdentityStatus;
  lastContactAt: string | null;
}

export interface RemotePrincipalProjectGrant {
  principalId: string;
  projectId: string;
  permissions: Array<"submit" | "read">;
  revokedAt: string | null;
}

export interface RemoteWorkerProjectGrant {
  workerId: string;
  projectId: string;
  localProjectId: string;
  presetIds: string[];
  revokedAt: string | null;
}

export type RemoteVerificationRequestPhase = "pending" | "assigned" | "completed" | "cancelled";
export type RemoteVerificationAttemptPhase =
  | "assigned"
  | "preparing"
  | "running"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "uncertain";

export interface RemoteVerificationRequest {
  id: string;
  projectId: string;
  workerId: string;
  requestedBy: string;
  commitSha: string;
  presetId: string;
  idempotencyKey: string;
  phase: RemoteVerificationRequestPhase;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteVerificationAttempt {
  id: string;
  requestId: string;
  workerId: string;
  sequence: number;
  phase: RemoteVerificationAttemptPhase;
  version: number;
  localRunId: string | null;
  executedCommitSha: string | null;
  failureKind: "setup" | "execution" | null;
  errorCode: string | null;
  acceptedAt: string;
  lastReportedAt: string;
  finishedAt: string | null;
}

export interface AssignRemoteVerificationAttemptInput {
  requestId: string;
  workerId: string;
}

export interface ReportRemoteVerificationAttemptInput {
  attemptId: string;
  expectedVersion: number;
  phase: RemoteVerificationAttemptPhase;
  localRunId?: string;
  executedCommitSha?: string;
  failureKind?: "setup" | "execution";
  errorCode?: string;
}

export interface SubmitRemoteVerificationInput {
  projectId: string;
  workerId: string;
  commitSha: string;
  presetId: string;
  idempotencyKey: string;
}

/** The transport authenticates the caller and supplies this trusted identity. */
export interface RemoteVerificationActor {
  principalId: string;
}

export interface RemoteVerificationStore {
  getRemotePrincipal(id: string): RemotePrincipal | null;
  getRemoteProjectIdentity(id: string): RemoteProjectIdentity | null;
  getRemoteWorker(id: string): RemoteWorkerRegistration | null;
  getRemotePrincipalProjectGrant(principalId: string, projectId: string): RemotePrincipalProjectGrant | null;
  getRemoteWorkerProjectGrant(workerId: string, projectId: string): RemoteWorkerProjectGrant | null;
  findRemoteVerificationRequestByIdempotency(principalId: string, idempotencyKey: string): RemoteVerificationRequest | null;
  /** Atomically creates the request or returns the request that already owns its principal/key pair. */
  createOrReplayRemoteVerificationRequest(request: RemoteVerificationRequest): RemoteVerificationRequest;
}

export interface RemoteVerificationAttemptStore {
  getRemoteVerificationRequest(id: string): RemoteVerificationRequest | null;
  getRemoteVerificationAttempt(id: string): RemoteVerificationAttempt | null;
  findRemoteVerificationAttemptForRequest(requestId: string): RemoteVerificationAttempt | null;
  /** Atomically creates the first attempt and assigns its request, or returns that attempt on replay. */
  createOrReplayRemoteVerificationAttempt(attempt: RemoteVerificationAttempt): RemoteVerificationAttempt | null;
  /** Atomically applies an optimistic attempt update and keeps the parent request phase in sync. */
  updateRemoteVerificationAttempt(
    attempt: RemoteVerificationAttempt,
    expectedVersion: number,
    requestPhase: RemoteVerificationRequestPhase,
  ): boolean;
  /** Converts controller-owned in-flight attempts into honest, recoverable uncertainty after a restart. */
  markRemoteVerificationAttemptsUncertain(observedAt: string): number;
}

export interface RemoteVerificationProvisioningStore {
  saveRemotePrincipal(principal: RemotePrincipal, actor: string): void;
  saveRemoteProjectIdentity(project: RemoteProjectIdentity, actor: string): void;
  saveRemoteWorker(worker: RemoteWorkerRegistration, actor: string): void;
  saveRemotePrincipalProjectGrant(grant: RemotePrincipalProjectGrant, actor: string): void;
  saveRemoteWorkerProjectGrant(grant: RemoteWorkerProjectGrant, actor: string): void;
}

export interface PrepareRemoteVerificationWorkspaceInput {
  requestId: string;
  repositoryPath: string;
  sourceRemote: string;
  commitSha: string;
  preparation?: import("@/server/modules/verification").VerificationPreparationContext;
  environment?: Record<string, string>;
}

export interface RemoteVerificationWorkspace {
  requestId: string;
  path: string;
  repositoryPath: string;
  sourceRemote: string;
  requestedCommitSha: string;
  executedCommitSha: string;
}

export interface RemoteVerificationWorkspacePreparer {
  prepare(input: PrepareRemoteVerificationWorkspaceInput): Promise<RemoteVerificationWorkspace>;
  cleanup(workspace: RemoteVerificationWorkspace): Promise<void>;
}
