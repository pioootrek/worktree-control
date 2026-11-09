import { z } from "zod";
import { scopedTestPresetsSchema, scopedRunTestSchema, scopedTestRunSchema } from "./scoped-verification";

/** Authority is entirely server-owned. These DTOs select resources/intent only. */
export const humanVerificationSchema = z.discriminatedUnion("operation", [
  scopedTestPresetsSchema.extend({ operation: z.literal("presets") }).strict(),
  scopedRunTestSchema.omit({ responseMode: true }).extend({ operation: z.literal("enqueue") }).strict(),
  scopedTestRunSchema.extend({ operation: z.literal("status") }).strict(),
  scopedTestRunSchema.extend({ operation: z.literal("cancel") }).strict(),
  scopedTestRunSchema.extend({ operation: z.literal("wait"), cursor: z.string().min(1).max(128),
    timeoutMs: z.number().int().min(1).max(20_000).default(10_000) }).strict(),
]);
export type HumanVerificationRequest = z.infer<typeof humanVerificationSchema>;
