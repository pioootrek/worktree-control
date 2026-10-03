import { z } from "zod";
import type { UserExportResult, UserScheduleInput } from "@/shared/contracts/user-backups";

export const artifactSchema = z.object({ format: z.literal(1), source: z.literal("user-schedule"), ownerId: z.string(), scope: z.literal("knowledge-discussions"), projectId: z.string(), targetId: z.string(), scheduleId: z.uuid(), version: z.number(), executionId: z.uuid(), dueAt: z.string(), data: z.record(z.string(), z.unknown()) }).strict();


/** Immutable execution port. Binding hashes the entire captured configuration, including internal fields. */
export interface RecoveryExecution {
  executionId: string;
  configuration: UserScheduleInput & { id: string; ownerId: string; version: number };
  dueAt: number;
  deadline: number | null;
  state: UserExportResult["state"];
  destination: string;
  hash: string | null;
}
