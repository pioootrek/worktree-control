import { z } from "zod";

export const userBackupPolicySchema = z.object({
  enabled: z.boolean().default(false), projects: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/)).max(256).default([]),
  scopes: z.array(z.literal("knowledge-discussions")).max(1).default([]),
  targets: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), directory: z.string().min(1).max(4096) }).strict()).max(16).default([]),
  minIntervalSeconds: z.number().int().min(60).max(30 * 86400).default(3600),
  maxSchedules: z.number().int().min(1).max(32).default(4),
  maxBytes: z.number().int().min(1024 ** 2).max(1024 ** 3).default(64 * 1024 ** 2),
  timeoutSeconds: z.number().int().min(1).max(300).default(30),
  queueLimit: z.number().int().min(1).max(32).default(2),
  retainCount: z.number().int().min(1).max(100).default(10), retainDays: z.number().int().min(1).max(365).default(30),
}).strict().superRefine((policy, ctx) => {
  if (policy.enabled && (!policy.projects.length || !policy.targets.length || !policy.scopes.length)) ctx.addIssue({ code: "custom", message: "User schedules require allowed projects and targets." });
  if (new Set(policy.projects).size !== policy.projects.length || new Set(policy.targets.map(value => value.id)).size !== policy.targets.length || new Set(policy.targets.map(value => value.directory)).size !== policy.targets.length) ctx.addIssue({ code: "custom", message: "Duplicate user backup project or target." });
});
export type UserBackupPolicy = z.infer<typeof userBackupPolicySchema>;
export class UserBackupError extends Error {
  constructor(readonly code: "forbidden" | "policy" | "limit" | "busy" | "changed" | "invalid" | "failed", readonly status = 400) { super(code); }
}
