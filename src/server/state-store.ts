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

/** Durable credential binding of a scoped agent lease, in addition to session owner and lease hash. */
export interface ReservationBinding {
  principalId: string;
  credentialId: string;
}

/** Stable reservation failure categories; messages remain compatible with legacy callers. */
export class ReservationError extends Error {
  constructor(readonly code: "claim_conflict" | "idempotency_conflict" | "claim_stale", message: string) {
    super(message);
    this.name = "ReservationError";
  }
}

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
  binding?: ReservationBinding;
  /** Normalized scoped mutation options; retries cannot alter TTL, placement or execution intent. */
  requestFingerprint?: string;
}

/** A scoped agent configuration change, committed atomically with its ownership, revision and audit checks. */
export type ScopedConfigurationChange =
  | { kind: "select_environment_profile"; profileName: string }
  | { kind: "set_test_preset_timeout"; presetId: string; timeoutMs: number | null; overrideLimit: number };
export interface ScopedConfigurationCommit {
  projectId: string;
  expectedRevision: number;
  /**
   * Null: the project must have no active reservation. Otherwise the caller's
   * exact scoped lease; `worktreePath`, when given, must be the claimed worktree.
   */
  claim: { reservationId: string; owner: string; leaseTokenHash: string; binding: ReservationBinding; worktreePath?: string } | null;
  change: ScopedConfigurationChange;
  attribution: { principalId: string; credentialId: string; operationId: string };
}
export type ScopedConfigurationCommitResult =
  | { status: "completed" | "noop"; revision: number }
  | { status: "project_missing" | "claim_required" | "claim_stale" | "claim_worktree_mismatch" | "revision_conflict" | "profile_not_found" | "override_limit" };

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
  updateProjectLaunch(projectId: string, input: ProjectLaunchUpdate, actor?: string): void;
  updateProjectEnvironment(projectId: string, environment: Record<string, string>, actor: string): void;
  saveProjectEnvironmentProfile(projectId: string, profile: EnvironmentProfile, actor: string): void;
  deleteProjectEnvironmentProfile(projectId: string, profileName: string, actor: string): void;
  selectProjectEnvironmentProfile(projectId: string, profileName: string, actor: string): void;
  saveProjectTestEnvironmentProfile(projectId: string, profile: TestEnvironmentProfile, actor: string): void;
  deleteProjectTestEnvironmentProfile(projectId: string, profileName: string, actor: string): void;
  assignProjectTestPresetProfile(projectId: string, presetId: string, profileName: string | null, actor: string): void;
  setProjectTestPresetTimeout(projectId: string, presetId: string, timeoutMs: number | null, actor: string): void;
  /** Incremented by every configuration write; null when the project does not exist. */
  getProjectConfigurationRevision(projectId: string): number | null;
  commitScopedConfiguration(input: ScopedConfigurationCommit): ScopedConfigurationCommitResult;
  setSelectedWorktree(projectId: string, path: string, actor?: string): void;
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
  authorizeReservation(projectId: string, owner: string, leaseTokenHash?: string, binding?: ReservationBinding | null): Reservation | null;
  renewAgentReservation(projectId: string, reservationId: string, owner: string, leaseTokenHash: string, ttlSeconds: number, binding?: ReservationBinding | null): Reservation;
  releaseAgentReservation(projectId: string, reservationId: string, owner: string, leaseTokenHash: string, binding?: ReservationBinding | null): void;
  releaseReservation(projectId: string, owner: string, force?: boolean): void;
  close(): void;
}
