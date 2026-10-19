import * as z from "zod/v4";

const timestamp = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  .refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s);
const filterShape = {
  projectId: z.string().uuid(), from: timestamp, to: timestamp,
  presetId: z.string().min(1).max(160).optional(), worktreePath: z.string().min(1).max(1024).optional(),
  head: z.string().min(1).max(128).optional(), statusDigest: z.string().min(1).max(128).optional(),
  dirty: z.boolean().optional(),
  processOutcome: z.enum(["passed", "failed", "cancelled", "timed_out", "interrupted", "unknown"]).optional(),
  attribution: z.enum(["pending", "observed_match", "changed", "uncertain", "legacy_unknown"]).optional(),
};
const windowValid = (s: { from: string; to: string }) => Date.parse(s.to) >= Date.parse(s.from)
  && Date.parse(s.to) - Date.parse(s.from) <= 31 * 24 * 60 * 60_000;
export const testHistorySchema = z.strictObject({ ...filterShape, limit: z.number().int().min(1).max(50).optional(), cursor: z.string().min(1).max(2048).optional() }).refine(windowValid);
export const testMetricsSchema = z.strictObject(filterShape).refine(windowValid);
export const testSummarySchema = z.strictObject({ projectId: filterShape.projectId, runId: z.string().uuid() });
export const testComparisonSchema = z.strictObject({ projectId: filterShape.projectId, leftRunId: z.string().uuid(), rightRunId: z.string().uuid() });
export function parseHistoryInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error("Invalid verification history request.");
  return result.data;
}
