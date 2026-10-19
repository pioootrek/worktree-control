import type { ResolvedTestEnvironment } from "@/server/modules/environments";
import type { TestCommand } from "@/server/test-command";
import type { TestSourceObserver } from "@/server/test-source-attribution";
import type { TestQueueStatus, TestRun, TestSourceObservation, Worktree } from "@/shared/contracts";

export interface EnqueueTestInput {
  projectId: string;
  worktree: Worktree;
  command: TestCommand;
  environment: ResolvedTestEnvironment;
  actor: string;
  idempotencyKey?: string;
  sourceObservation?: TestSourceObservation;
}
export interface VerificationJobs {
  status(): TestQueueStatus;
  setLimit(limit: number): TestQueueStatus;
  enqueue(input: EnqueueTestInput): TestRun;
  cancel(runId: string, actor: string): Promise<TestRun>;
  configureSourceObserver?(observer: TestSourceObserver): void;
  replay?(actor: string, idempotencyKey: string, projectId: string, worktreePath: string, presetId: string): TestRun | null;
}
