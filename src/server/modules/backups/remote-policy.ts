import { z } from "zod";
import type { RemoteProgress } from "./remote-records";

export const remoteBackupPolicySchema = z.object({
  pendingLimit: z.number().int().min(1).max(32).default(4),
  attemptLimit: z.number().int().min(1).max(10).default(3),
  retrySeconds: z.number().int().min(60).max(86400).default(300),
  timeoutSeconds: z.number().int().min(1).max(3600).default(300),
}).strict();
export type RemoteBackupPolicy = z.infer<typeof remoteBackupPolicySchema>;
export interface RemoteBackupSource {
  installationId: string; backupId: string; source: string; manifestSha256: string;
  files: Array<{ path: string; size: number }>;
  reconciliation?: RemoteProgress;
  proofLimit?: number;
}
export class RemoteBackupReconciliationError extends Error {
  constructor() { super("remote_inventory_changed"); }
}
export type RemoteBackupOutcome = { snapshotId: string; proofs?: RemoteProgress["proofs"]; inventoryHash?: string } | { progress: true; proofs: RemoteProgress["proofs"]; inventoryHash?: string; uploadAttempted: boolean };
/** Adapters must reconcile an uncertain prior upload before creating a snapshot. */
export interface RemoteBackupTransport {
  readonly destinationId: string;
  readonly policy: RemoteBackupPolicy;
  upload(source: RemoteBackupSource, options?: { reconcileOnly: boolean }): Promise<RemoteBackupOutcome>;
  close(): Promise<void>;
}
