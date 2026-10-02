import { z } from "zod";

export const backupIdSchema = z.string().regex(/^(backup-[0-9a-f-]{36}|pre-migration-v[0-9]+-[0-9a-f-]{36})$/);
export const backupKeySchema = z.string().min(1).max(256);
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
}
export interface BackupOverview {
  policy: { destinationConfigured: boolean; intervalSeconds: number | null; retainCount: number; retainDays: number; maxBytes: number; timeoutSeconds: number; queueLimit: number; uiActions: Array<"create" | "restore"> };
  schedule: { nextAt: string | null; lastOperation: BackupOperation | null; error: "backup_failed" | "backup_limit" | null; retention: "idle" | "succeeded" | "failed" };
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
