import type { WorkerRecoveryJournal } from "./recovery-contracts";
import type { RemoteAssignment, RemoteWorkerReport } from "@/shared/contracts/remote-verification";
import type { RemoteVerificationAttemptStore, RemoteVerificationStore } from "./contracts";

export interface WorkerReceipt {
  recovery?: WorkerRecoveryJournal;
  assignment: RemoteAssignment;
  localRunId: string;
  cancellationRequested: boolean;
  /** Durable ordered outbox. An acknowledged report remains immutable for replay. */
  reports: RemoteWorkerReport[];
  acknowledgedSequence: number;
}

/** Replay/cleanup index: report bodies stay in SQLite and are read one attempt at a time. */
export interface WorkerReceiptSummary {
  recovery?: WorkerRecoveryJournal;
  assignment: RemoteAssignment;
  localRunId: string;
  cancellationRequested: boolean;
  acknowledgedSequence: number;
  reportCount: number;
  lastPhase: RemoteWorkerReport["phase"] | null;
  cleanup: string | null;
}
export function summarizeReceipt(receipt: WorkerReceipt): WorkerReceiptSummary {
  const last = receipt.reports.at(-1);
  return {
    ...(receipt.recovery ? { recovery: receipt.recovery } : {}),
    assignment: receipt.assignment, localRunId: receipt.localRunId,
    cancellationRequested: receipt.cancellationRequested, acknowledgedSequence: receipt.acknowledgedSequence,
    reportCount: receipt.reports.length, lastPhase: last?.phase ?? null, cleanup: last?.execution?.cleanup ?? null,
  };
}

/** Uses the owning controller connection, including compound report transactions. */
export interface RemoteConnectionStore {
  atomic<T>(operation: () => T): T;
  contact(workerId: string, at: string): void;
  pendingRequests(workerId: string): string[];
  /** Advances one bounded page; limit reserves poll capacity for assignment cancellation. */
  cancellationAttempts(workerId: string, limit?: number): string[];
  requestCancellation(requestId: string, at: string): void;
  cancellationRequested(requestId: string): boolean;
  report(attemptId: string, sequence: number): RemoteWorkerReport | null;
  latestReport(attemptId: string): RemoteWorkerReport | null;
  saveReport(report: RemoteWorkerReport): void;
  accept(receipt: WorkerReceipt): WorkerReceipt;
  /** Bounded metadata only; never hydrates report bodies. */
  receipts(): WorkerReceiptSummary[];
  /** Read one durable outbox on demand, including immutable acknowledged evidence. */
  receipt(attemptId: string): WorkerReceipt | null;
  saveReceipt(receipt: WorkerReceipt): void;
  /** Monotonic local recovery journal; never alters report or acknowledgement bytes. */
  saveRecovery(attemptId: string, journal: WorkerRecoveryJournal): void;
}
export type RemoteControllerStore = RemoteVerificationStore & RemoteVerificationAttemptStore;
