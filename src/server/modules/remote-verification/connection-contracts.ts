import type { RemoteAssignment, RemoteWorkerReport } from "@/shared/contracts/remote-verification";
import type { RemoteVerificationAttemptStore, RemoteVerificationStore } from "./contracts";

export interface WorkerReceipt {
  assignment: RemoteAssignment;
  localRunId: string;
  cancellationRequested: boolean;
  /** Durable ordered outbox. An acknowledged report remains immutable for replay. */
  reports: RemoteWorkerReport[];
  acknowledgedSequence: number;
}

/** Uses the owning controller connection, including compound report transactions. */
export interface RemoteConnectionStore {
  atomic<T>(operation: () => T): T;
  contact(workerId: string, at: string): void;
  pendingRequests(workerId: string): string[];
  cancellationAttempts(workerId: string): string[];
  requestCancellation(requestId: string, at: string): void;
  cancellationRequested(requestId: string): boolean;
  report(attemptId: string, sequence: number): RemoteWorkerReport | null;
  latestReport(attemptId: string): RemoteWorkerReport | null;
  saveReport(report: RemoteWorkerReport): void;
  accept(receipt: WorkerReceipt): WorkerReceipt;
  receipts(): WorkerReceipt[];
  saveReceipt(receipt: WorkerReceipt): void;
}
export type RemoteControllerStore = RemoteVerificationStore & RemoteVerificationAttemptStore;
