import { z } from "zod";

/** Safe, constant-size projection of recorded evidence; never a recovery guarantee. */
export const backupMonitorMetadataSchema = z.object({
  format: z.literal(1), observedAt: z.iso.datetime(), scheduleEnabled: z.boolean(), maintenance: z.boolean(),
  local: z.object({
    dataAt: z.iso.datetime().nullable(),
    lastAttempt: z.object({ dataAt: z.iso.datetime(), state: z.enum(["queued", "running", "succeeded", "failed", "interrupted"]), error: z.enum(["backup_failed", "backup_interrupted", "backup_limit"]).nullable() }).strict().nullable(),
    error: z.enum(["backup_failed", "backup_limit", "retention_failed", "metadata_unavailable"]).nullable(),
  }).strict(),
  remote: z.object({ enabled: z.boolean(), dataAt: z.iso.datetime().nullable(), confirmedAt: z.iso.datetime().nullable(), pending: z.number().int().nonnegative().max(4096), error: z.enum(["remote_failed", "remote_limit"]).nullable() }).strict(),
}).strict();
export type BackupMonitorMetadata = z.infer<typeof backupMonitorMetadataSchema>;
