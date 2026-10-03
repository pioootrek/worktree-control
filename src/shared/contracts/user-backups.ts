import { z } from "zod";

export const userScheduleInputSchema = z.object({
  projectId: z.string().min(1).max(120), scope: z.literal("knowledge-discussions"),
  targetId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), enabled: z.boolean(),
  intervalSeconds: z.number().int().min(60).max(30 * 86400),
  retainCount: z.number().int().min(1).max(1000), retainDays: z.number().int().min(1).max(3650),
}).strict();
export type UserScheduleInput = z.infer<typeof userScheduleInputSchema>;
/** Keep a pending key unchanged on retries, including after refreshing the overview. */
export function userScheduleMutationKey(generation: string, id: string, version: number, nonce: string): string {
  return `usm1:${generation}:${id}:${version}:${nonce.replaceAll("-", "")}`;
}
export function parseUserScheduleMutationKey(key: string): { generation: string; id: string; version: number } | null {
  const match = /^usm1:([a-f0-9]{32}):([a-fA-F0-9-]{36}):(0|[1-9][0-9]{0,15}):[a-f0-9]{32}$/.exec(key);
  if (!match || !z.uuid().safeParse(match[2]).success || !Number.isSafeInteger(Number(match[3]))) return null;
  return { generation: match[1]!, id: match[2]!, version: Number(match[3]) };
}
export const userScheduleCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), id: z.uuid(), version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1), idempotencyKey: z.string().min(1).max(128), configuration: userScheduleInputSchema }).strict(),
  z.object({ action: z.literal("status"), idempotencyKey: z.string().min(1).max(128) }).strict(),
  z.object({ action: z.literal("artifact"), executionId: z.uuid() }).strict(),
]);
export type UserScheduleCommand = z.infer<typeof userScheduleCommandSchema>;
export type ScheduleReason = "disabled" | "forbidden" | "policy" | "limit" | "busy" | "changed" | "failed" | "interrupted";
export interface UserExportResult {
  executionId: string; scheduleId: string; version: number; dueAt: string;
  state: "queued" | "running" | "succeeded" | "failed" | "interrupted" | "denied";
  reason: ScheduleReason | null; finishedAt: string | null; artifactAvailable: boolean;
}
export interface UserSchedule extends UserScheduleInput {
  id: string; ownerId: string; version: number; nextAt: string | null;
  reason: ScheduleReason | null; lastResult: UserExportResult | null; retention: "idle" | "succeeded" | "failed";
}
export interface UserScheduleOverview {
  mutationGeneration: string;
  policy: { enabled: boolean; minIntervalSeconds: number; maxSchedules: number; maxBytes: number; timeoutSeconds: number; queueLimit: number; retainCount: number; retainDays: number };
  projects: Array<{ id: string; name: string }>; targets: string[]; schedules: UserSchedule[];
  artifacts: UserExportResult[]; maintenance: boolean;
}
