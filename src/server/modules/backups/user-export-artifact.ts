import { z } from "zod";

export const artifactSchema = z.object({ format: z.literal(1), source: z.literal("user-schedule"), ownerId: z.string(), scope: z.literal("knowledge-discussions"), projectId: z.string(), targetId: z.string(), scheduleId: z.uuid(), version: z.number(), executionId: z.uuid(), dueAt: z.string(), data: z.record(z.string(), z.unknown()) }).strict();
