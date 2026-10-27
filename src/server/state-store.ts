import type { TestSummaryEntry, TestHistoryCoverage } from "@/shared/contracts/verification-history";
import type { DevServerTlsMode, EnvironmentProfile, LaunchPreset, Project, Reservation, ServerCapacitySettings, TestEnvironmentProfile, TestQueueSettings, TestRun, WorktreeStorageHistoryPoint, WorktreeStorageSnapshot } from "@/shared/contracts";

export interface WorktreeStorageSample extends WorktreeStorageHistoryPoint {
  projectId: string;
  worktreePath: string;
  topDirectories: Array<{ name: string; bytes: number }>;
}

export interface NewProject {
  name: string;
  repositoryPath: string;
  port: number;
  launchPreset?: LaunchPreset;
}

export interface ProjectRegistration extends NewProject {
  executable: string;
  args: string[];
}

export interface ProjectLaunchUpdate {
  tlsMode: DevServerTlsMode;
  tlsKeyPath: string | null;
  tlsCertPath: string | null;
  tlsCaPath: string | null;
  executable: string;
  args: string[];
}

export type PendingTestRun = Pick<TestRun, "id" | "projectId" | "worktreePath" | "phase" | "queuePosition" | "queuedAt">;
export type TestRunStatusRecord = Pick<TestRun,
  "id" | "projectId" | "worktreePath" | "worktreeHead" | "worktreeBranch" | "worktreeDirty"
  | "presetId" | "phase" | "queuePosition" | "queuedAt" | "startedAt" | "finishedAt"
  | "exitCode" | "signal" | "error"
  | "source"
>;

export interface ReservationRequest {
  projectId: string;
  worktreePath: string;
  kind: "human" | "agent";
  owner: string;
  reason?: string;
  ttlSeconds?: number;
  maximumLifetimeSeconds?: number;
  leaseTokenHash?: string;
  idempotencyKey?: string;
}

export interface TestHistoryPosition { queuedAt: string; runId: string }
export interface TestHistoryScan {
  projectId: string; from: string; to: string; before?: TestHistoryPosition; ceiling?: TestHistoryPosition;
}
export interface TestHistoryScanResult {
  items: TestSummaryEntry[]; scanned: number; more: boolean;
  last?: TestHistoryPosition; ceiling?: TestHistoryPosition;
}
export interface StateStore {
  scanTestHistory(input: TestHistoryScan, scanLimit: number, accept: (entry: TestSummaryEntry) => boolean, matchLimit: number): TestHistoryScanResult;
  getTestSummary(projectId: string, runId: string): TestSummaryEntry | null;
  getTestHistoryCoverage(projectId: string): TestHistoryCoverage;
  listProjects(): Project[];
  getProject(id: string): Project | null;
  addProject(input: ProjectRegistration): Project;
  /** Check durable deletion restrictions before stopping a managed runtime. */
  assertProjectRemovalAllowed(projectId: string): void;
  removeProject(projectId: string, actor: string): void;
  updateProjectLaunch(projectId: string, input: ProjectLaunchUpdate): void;
  updateProjectEnvironment(projectId: string, environment: Record<string, string>, actor: string): void;
  saveProjectEnvironmentProfile(projectId: string, profile: EnvironmentProfile, actor: string): void;
  deleteProjectEnvironmentProfile(projectId: string, profileName: string, actor: string): void;
  selectProjectEnvironmentProfile(projectId: string, profileName: string, actor: string): void;
  saveProjectTestEnvironmentProfile(projectId: string, profile: TestEnvironmentProfile, actor: string): void;
  deleteProjectTestEnvironmentProfile(projectId: string, profileName: string, actor: string): void;
  assignProjectTestPresetProfile(projectId: string, presetId: string, profileName: string | null, actor: string): void;
  setProjectTestPresetTimeout(projectId: string, presetId: string, timeoutMs: number | null, actor: string): void;
  setSelectedWorktree(projectId: string, path: string): void;
  getServerCapacitySettings(): ServerCapacitySettings;
  setServerCapacitySettings(settings: ServerCapacitySettings): void;
  getTestQueueSettings(): TestQueueSettings;
  setTestQueueSettings(settings: TestQueueSettings): void;
  countTestRuns(phases: TestRun["phase"][], projectId?: string, worktreePath?: string): number;
  listPendingTestRuns(): PendingTestRun[];
  listTestRuns(projectId?: string, limit?: number): TestRun[];
  hasTestRun(id: string): boolean;
  getTestRun(id: string): TestRun | null;
  getTestRunStatus(id: string): TestRunStatusRecord | null;
  findTestRunByIdempotency(actor: string, idempotencyKey: string): TestRun | null;
  saveTestRun(run: TestRun, idempotencyKey?: string): void;
  markInterruptedTestRuns(): void;
  pruneTestSummaryHistory(): number;
  getWorktreeStorage(projectId: string, worktreePath: string): WorktreeStorageSnapshot | null;
  saveWorktreeStorage(sample: WorktreeStorageSample): void;
  recordProjectEvent(projectId: string, eventType: string, actor: string, details: unknown): void;
  listWorktreeLaunches(projectId: string): Record<string, string>;
  getActiveReservation(projectId: string): Reservation | null;
  getEffectiveReservation(projectId: string, observedAt: string): Reservation | null;
  acquireReservation(input: ReservationRequest): Reservation;
  authorizeReservation(projectId: string, owner: string, leaseTokenHash?: string): Reservation | null;
  renewAgentReservation(projectId: string, reservationId: string, owner: string, leaseTokenHash: string, ttlSeconds: number): Reservation;
  releaseAgentReservation(projectId: string, reservationId: string, owner: string, leaseTokenHash: string): void;
  releaseReservation(projectId: string, owner: string, force?: boolean): void;
  close(): void;
}
