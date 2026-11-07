import { z } from "zod";

const projectId = z.string().uuid();
const runId = z.string().uuid();
export const scopedTestPresetsSchema = z.object({ projectId }).strict();
export const scopedRunTestSchema = z.object({
  projectId, worktreePath: z.string().min(1).max(4096), presetId: z.string().min(1).max(160),
  idempotencyKey: z.string().min(1).max(120), reservationId: z.string().uuid().optional(),
  responseMode: z.enum(["full", "compact"]).optional(),
}).strict();
export const scopedTestRunSchema = z.object({ runId, projectId: projectId.optional() }).strict();
export const scopedWaitSchema = z.object({
  projectId: projectId.optional(), runId: runId.optional(), cursor: z.string().min(1).max(128),
  timeoutMs: z.number().int().min(1).max(20_000).optional(),
}).strict().refine(input => !!input.projectId !== !!input.runId, "Exactly one status target is required.");

/** No command, ENV, profile, logs, requester identifiers or queue/capacity metadata. */
export interface ScopedTestRunStatus {
  runId: string;
  projectId: string;
  presetId: string;
  worktreePath: string;
  phase: "queued" | "running" | "passed" | "failed" | "cancelled" | "timed_out" | "interrupted";
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  errorCode: "test_error" | null;
  source: {
    queuedHead: string | null;
    preflightHead: string | null;
    finishHead: string | null;
    attribution: "pending" | "observed_match" | "changed" | "uncertain" | "legacy_unknown";
    processOutcome: "passed" | "failed" | "cancelled" | "timed_out" | "interrupted" | "unknown" | null;
  };
}
