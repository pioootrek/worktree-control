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
