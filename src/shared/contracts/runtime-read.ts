import { z } from "zod";
import type { ScopedProjectStatus, ScopedProjectSummary, ScopedWorktree } from "./runtime-access";

const projectId = z.string().min(1).max(160);
export const runtimeReadSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list-projects") }).strict(),
  z.object({ operation: z.literal("project-status"), projectId }).strict(),
  z.object({ operation: z.literal("list-worktrees"), projectId }).strict(),
]);
export type RuntimeReadRequest = z.infer<typeof runtimeReadSchema>;
export type RuntimeReadResult =
  | { operation: "list-projects"; projects: ScopedProjectSummary[] }
  | { operation: "project-status"; status: ScopedProjectStatus }
  | { operation: "list-worktrees"; worktrees: ScopedWorktree[] };
