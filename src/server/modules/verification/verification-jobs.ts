import type { ResolvedTestEnvironment } from "@/server/modules/environments";
import type { TestCommand } from "@/server/test-command";
import type { TestSourceObserver } from "@/server/test-source-attribution";
import type { TestQueueStatus, TestRun, TestSourceObservation, Worktree } from "@/shared/contracts";

export interface EnqueueTestInput {
  /** Only trusted application adapters may supply a durable execution identity. */
  runId?: string;
  preparation?: VerificationPreparation;
  projectId: string;
  worktree: Worktree;
  command: TestCommand;
  environment: ResolvedTestEnvironment;
  actor: string;
  idempotencyKey?: string;
  sourceObservation?: TestSourceObservation;
}
export interface VerificationPreparation {
  /** Runs inside the finite queue's preparation slot, before process creation. */
  prepare(): Promise<Pick<EnqueueTestInput, "worktree" | "command" | "environment"> & { sourceObservation: TestSourceObservation }>;
  observe: TestSourceObserver;
  starting?(): void;
  started?(): void;
  /** Runs after owned-tree cleanup, before releasing the slot. */
  dispose(): Promise<void>;
}
export interface VerificationJobs {
  status(): TestQueueStatus;
  setLimit(limit: number): TestQueueStatus;
  enqueue(input: EnqueueTestInput): TestRun;
  cancel(runId: string, actor: string): Promise<TestRun>;
  configureSourceObserver?(observer: TestSourceObserver): void;
  replay?(actor: string, idempotencyKey: string, projectId: string, worktreePath: string, presetId: string): TestRun | null;
}
