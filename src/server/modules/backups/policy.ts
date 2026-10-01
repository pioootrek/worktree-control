import { z } from "zod";

export const backupPolicySchema = z.object({
  directory: z.string().min(1).max(4096).optional(),
  intervalSeconds: z.number().int().min(60).max(30 * 86400).nullable().default(null),
  retainCount: z.number().int().min(1).max(1000).default(30),
  retainDays: z.number().int().min(1).max(3650).default(30),
  maxBytes: z.number().int().min(1024 ** 2).max(128 * 1024 ** 3).default(16 * 1024 ** 3),
  timeoutSeconds: z.number().int().min(1).max(3600).default(300),
  queueLimit: z.number().int().min(1).max(32).default(4),
  uiActions: z.array(z.enum(["create", "restore"])).max(2).default([]),
}).strict().superRefine((value, ctx) => {
  if ((value.intervalSeconds !== null || value.uiActions.length > 0) && !value.directory) ctx.addIssue({ code: "custom", message: "Backup schedule and web actions require --backup-dir." });
  if (new Set(value.uiActions).size !== value.uiActions.length) ctx.addIssue({ code: "custom", message: "Duplicate backup action." });
});
export type BackupPolicy = z.infer<typeof backupPolicySchema>;
export class BackupError extends Error {
  constructor(readonly code: "backup_forbidden" | "backup_busy" | "backup_limit" | "backup_invalid" | "backup_failed", readonly status = 400) { super(code); }
}
