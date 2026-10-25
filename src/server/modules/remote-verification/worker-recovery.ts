import type { AuthenticatedPrincipal, IdentityService } from "@/server/modules/identity";
import { remoteAssignmentSchema } from "@/shared/contracts/remote-verification";
import type { RemoteConnectionStore, WorkerReceipt, WorkerReceiptSummary } from "./connection-contracts";
import { hasUnconfirmedRemoteExecution } from "./remote-worker";

export interface RecoveryPathIdentity { path: string; device: string; inode: string; uid: number }
export interface WorkerRecoveryProvenance {
  version: 1;
  attemptId: string;
  localRunId: string;
  assignmentDigest: string;
  installation: string;
  host: string;
  boot: string;
  root: RecoveryPathIdentity;
  cache: RecoveryPathIdentity;
  /** Slots were absent when journaled, before even the first Git subprocess. */
  retainedPaths: string[];
  signature: string;
}
export interface WorkerRecoveryAudit {
  version: 1;
  operationId: string;
  attemptId: string;
  principalId: string;
  credentialId: string;
  reconciledAt: string;
  boot: string;
  provenanceSignature: string;
  processExit: "same-host-different-boot";
  artifacts: "retained-excluded";
  signature: string;
}
/** Local evidence, independent of the immutable report outbox. Never pruned with run details. */
export interface WorkerRecoveryJournal { provenance: WorkerRecoveryProvenance; audit?: WorkerRecoveryAudit }
export interface RecoveryAssessment {
  code: string;
  provenance: WorkerRecoveryProvenance | null;
  audit: WorkerRecoveryAudit | null;
  reconciled: boolean;
  recoverable: boolean;
}
/** Trusted Linux installation adapter. Caller-supplied host/boot/path evidence is never accepted. */
export interface WorkerRecoveryHost {
  capture(receipt: WorkerReceipt, root: string, cache: string): WorkerRecoveryProvenance;
  assess(receipt: WorkerReceiptSummary): RecoveryAssessment;
  audit(provenance: WorkerRecoveryProvenance, operationId: string, actor: AuthenticatedPrincipal): WorkerRecoveryAudit;
  assertPathsAvailable(paths: string[], receipts: WorkerReceiptSummary[]): void;
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function exact(value: string): void { if (!identifier.test(value)) throw new Error("invalid_recovery_identifier"); }

/** Shared application operations. The caller holds the installation singleton lock throughout. */
export class WorkerRecoveryService {
  constructor(private readonly connection: RemoteConnectionStore, private readonly host: WorkerRecoveryHost,
    private readonly identity?: Pick<IdentityService, "requireOwnerSession">) {}

  recordStart(receipt: WorkerReceipt, root: string, cache: string): void {
    remoteAssignmentSchema.parse(receipt.assignment);
    exact(receipt.localRunId);
    // Capture can create only the installation anchor. No work may execute until
    // this transaction commits; an ambiguous save leaves a conservative blocker.
    const provenance = this.host.capture(receipt, root, cache);
    this.assertPathsAvailable(provenance.retainedPaths);
    this.connection.atomic(() => {
      const saved = this.connection.receipt(receipt.assignment.attemptId);
      if (!saved || saved.localRunId !== receipt.localRunId || JSON.stringify(saved.assignment) !== JSON.stringify(receipt.assignment)) throw new Error("recovery_receipt_mismatch");
      if (saved.recovery) throw new Error("recovery_attempt_already_started");
      this.connection.saveRecovery(receipt.assignment.attemptId, { provenance });
    });
  }
  isReconciled(receipt: WorkerReceiptSummary): boolean { return !!receipt.recovery?.audit && this.host.assess(receipt).reconciled; }
  assertPathsAvailable(paths: string[]): void { this.host.assertPathsAvailable(paths, this.connection.receipts()); }

  inspectAll(actor: AuthenticatedPrincipal) {
    this.owner(actor);
    return this.connection.receipts().map(receipt => this.describe(receipt));
  }
  inspect(attemptId: string, actor: AuthenticatedPrincipal) {
    this.owner(actor); exact(attemptId);
    const receipt = this.connection.receipts().find(item => item.assignment.attemptId === attemptId);
    if (!receipt) throw new Error("worker_receipt_missing");
    return this.describe(receipt);
  }
  private describe(receipt: WorkerReceiptSummary) {
    const assessment = this.host.assess(receipt);
    const attemptId = receipt.assignment.attemptId;
    const blocked = hasUnconfirmedRemoteExecution([receipt], () => null, () => assessment.reconciled);
    return {
      attemptId, localRunId: receipt.localRunId, workerId: receipt.assignment.workerId,
      lastPhase: receipt.lastPhase, cleanup: receipt.cleanup, acknowledgedSequence: receipt.acknowledgedSequence,
      // No local history is used to bypass an uncertain receipt during recovery.
      blocked,
      code: assessment.code, recoverable: blocked && assessment.recoverable,
      prerequisites: "Linux; original installation and paths; same host after a different boot; current owner session; stopped controller",
      provenance: assessment.provenance, recovery: assessment.audit,
    };
  }
  reconcile(attemptId: string, operationId: string, actor: AuthenticatedPrincipal) {
    this.owner(actor); exact(attemptId); exact(operationId);
    return this.connection.atomic(() => {
      const receipts = this.connection.receipts();
      const receipt = receipts.find(item => item.assignment.attemptId === attemptId);
      if (!receipt) throw new Error("worker_receipt_missing");
      const assessment = this.host.assess(receipt);
      for (const candidate of receipts) {
        if (candidate.recovery?.audit?.operationId === operationId && candidate.assignment.attemptId !== attemptId) throw new Error("recovery_operation_conflict");
      }
      if (assessment.reconciled && assessment.audit) {
        if (assessment.audit.operationId !== operationId || assessment.audit.principalId !== actor.principalId) throw new Error("recovery_operation_conflict");
        return assessment.audit;
      }
      if (receipt.recovery?.audit) throw new Error("recovery_audit_invalid");
      if (!hasUnconfirmedRemoteExecution([receipt], () => null)) throw new Error("recovery_not_required");
      if (!assessment.recoverable || !assessment.provenance) throw new Error(assessment.code);
      // No signals, deletion, rename or report rewrites. Retained artifacts and
      // source cache are permanently excluded by their original signed paths.
      const audit = this.host.audit(assessment.provenance, operationId, actor);
      this.connection.saveRecovery(attemptId, { provenance: assessment.provenance, audit });
      return audit;
    });
  }
  private owner(actor: AuthenticatedPrincipal): void {
    if (!this.identity || actor.principalKind !== "owner" || actor.authenticationMethod !== "owner_session") throw new Error("owner_session_required");
    this.identity.requireOwnerSession(actor);
  }
}
