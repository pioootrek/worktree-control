import { z } from "zod";

export const backupIdSchema = z.string().regex(/^(backup-[0-9a-f-]{36}|pre-migration-v[0-9]+-[0-9a-f-]{36})$/);
export const backupKeySchema = z.string().min(1).max(256);
/** Bounded admission/preflight evidence. Bytes for capacity reasons, counts otherwise. */
export const backupLimitSchema = z.object({
  reason: z.enum(["catalog_bytes", "filesystem_space", "manual_history", "service_history", "queue", "catalog_scan", "catalog_entries", "snapshot_bytes"]),
  current: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  required: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  maximum: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type BackupLimit = z.infer<typeof backupLimitSchema>;
export const backupCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), idempotencyKey: backupKeySchema }).strict(),
  z.object({ action: z.literal("preview"), backupId: backupIdSchema }).strict(),
  z.object({ action: z.literal("restore"), backupId: backupIdSchema, idempotencyKey: backupKeySchema, confirmation: z.literal("replace-entire-installation") }).strict(),
  z.object({ action: z.literal("status"), backupId: backupIdSchema.optional(), idempotencyKey: backupKeySchema }).strict(),
]);
export type BackupCommand = z.infer<typeof backupCommandSchema>;
export interface BackupEntry {
  id: string; createdAt: string | null; sizeBytes: number | null;
  compatibility: "supported" | "unsupported"; verification: "verified" | "unverified" | "failed";
  protected: boolean;
}
export interface BackupOperation {
  operationId: string; backupId: string; state: "queued" | "running" | "succeeded" | "failed" | "interrupted";
  createdAt: string; finishedAt: string | null; error: "backup_failed" | "backup_interrupted" | "backup_limit" | null;
  /** Absent for historical outcomes whose precise refusal was not recorded. */
  limit?: BackupLimit;
}
export interface BackupOverview {
  policy: { destinationConfigured: boolean; intervalSeconds: number | null; retainCount: number; retainDays: number; maxBytes: number; timeoutSeconds: number; queueLimit: number; uiActions: Array<"create" | "restore"> };
  schedule: { nextAt: string | null; lastOperation: BackupOperation | null; error: "backup_failed" | "backup_limit" | null; limit?: BackupLimit; retention: "idle" | "succeeded" | "failed" };
  maintenance: boolean; copies: BackupEntry[];
  operations: BackupOperation[];
}
export interface RestorePreview {
  backup: BackupEntry; scope: "entire-installation";
  invalidatesScopedCredentials: true; stopsManagedProcessesAndTests: true;
}
export interface RestoreOperation {
  operationId: string; backupId: string; state: "requested" | "maintenance" | "executing" | "verified" | "interrupted" | "failed"; createdAt: string;
}
