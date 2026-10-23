import { z } from "zod";

export const REMOTE_VERIFICATION_PROTOCOL = 1 as const;
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const remoteSubmissionSchema = z.object({
  projectId: identifier, workerId: identifier,
  commitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  presetId: identifier, idempotencyKey: identifier,
}).strict();
export const remoteAssignmentSchema = remoteSubmissionSchema.omit({ idempotencyKey: true }).extend({
  requestId: identifier, attemptId: identifier,
}).strict();
export type RemoteAssignment = z.infer<typeof remoteAssignmentSchema>;
export const remoteReportSchema = z.object({
  attemptId: identifier, sequence: z.number().int().min(1).max(8),
  phase: z.enum(["preparing", "running", "succeeded", "failed", "cancelled", "uncertain"]),
  localRunId: identifier,
  executedCommitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  failureKind: z.enum(["setup", "execution"]).optional(),
  errorCode: identifier.optional(),
  presetFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  environmentFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().max(32).nullable().optional(),
  execution: z.object({
    queuedAt: z.string().datetime(), startedAt: z.string().datetime().nullable(), finishedAt: z.string().datetime().nullable(),
    termination: z.string().max(64), cleanup: z.string().max(64),
  }).strict().optional(),
  source: z.object({
    attribution: z.enum(["pending", "observed_match", "changed", "uncertain", "legacy_unknown"]),
    finishCommitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
    queueComparison: z.enum(["match", "changed", "unknown"]),
    executionComparison: z.enum(["match", "changed", "unknown"]),
    reasonCodes: z.array(z.string().max(128)).max(12),
  }).strict().optional(),
  logs: z.array(z.string().max(2000)).max(200).default([]),
}).strict();
export type RemoteWorkerReport = z.infer<typeof remoteReportSchema>;
export const remotePollSchema = z.object({ version: z.literal(REMOTE_VERIFICATION_PROTOCOL), workerId: identifier }).strict();
export const remoteReportEnvelopeSchema = remotePollSchema.extend({ report: remoteReportSchema }).strict();
export const remotePollResultSchema = z.object({
  version: z.literal(REMOTE_VERIFICATION_PROTOCOL),
  assignments: z.array(remoteAssignmentSchema).max(1),
  cancellations: z.array(identifier).max(100),
}).strict();
export type RemotePollResult = z.infer<typeof remotePollResultSchema>;
