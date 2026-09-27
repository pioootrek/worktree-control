export type RuntimePhase = "stopped" | "starting" | "running" | "stopping" | "failed";
export type DevServerTlsMode = "off" | "generated" | "custom";
export type LaunchPreset = "auto" | "node" | "django";
export type TestAdapterKind = "node" | "django";
export type TestRunPhase = "queued" | "running" | "passed" | "failed" | "cancelled" | "timed_out" | "interrupted";
export type TestSourceComparison = "match" | "changed" | "unknown";
export type TestSourceAttribution = "pending" | "observed_match" | "changed" | "uncertain" | "legacy_unknown";
export type TestProcessOutcome = "passed" | "failed" | "cancelled" | "timed_out" | "interrupted";

export interface TestSourceObservation {
  observedAt: string;
  head: string | null;
  branch: string | null;
  dirty: boolean | null;
  statusDigest: string | null;
  statusEntries: number | null;
  complete: boolean;
  errorCode: string | null;
}

export interface TestSourceEvidence {
  version: 1;
  scope: "git-observations";
  enqueue: TestSourceObservation | null;
  preflight: TestSourceObservation | null;
  finish: TestSourceObservation | null;
  queueComparison: TestSourceComparison;
  executionComparison: TestSourceComparison;
  attribution: TestSourceAttribution;
  reasonCodes: string[];
  processOutcome: TestProcessOutcome | null;
}

export interface TestPreset {
  id: string;
  name: string;
  adapter: TestAdapterKind;
  timeoutMs: number;
}

/** A discovered preset together with the test environment profile that would be applied. */
export interface DiscoveredTestPreset extends TestPreset {
  profile: string;
}

export interface WorktreeTestPresets {
  worktreePath: string;
  presets: DiscoveredTestPreset[];
  error: string | null;
}

export type TestEnvironmentMode = "clean" | "inherit-server-profile";

export interface TestEnvironmentPolicy {
  mode: TestEnvironmentMode;
  serverProfile: string | null;
}

export interface TestEnvironmentProfile {
  name: string;
  policy: TestEnvironmentPolicy;
  environment: Record<string, string>;
  nodeEnv: "development" | "production" | "test" | null;
  requiredVariables: string[];
}

export interface RedactedTestEnvironmentProfile extends Omit<TestEnvironmentProfile, "environment"> {
  variableNames: string[];
}

export interface TestRun {
  id: string;
  projectId: string;
  worktreePath: string;
  worktreeHead: string;
  worktreeBranch: string | null;
  worktreeDirty: boolean;
  presetId: string;
  presetName: string;
  adapter: TestAdapterKind;
  actor: string;
  phase: TestRunPhase;
  queuePosition: number | null;
  executable: string;
  args: string[];
  cwd: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  logs: string[];
  environmentMode: TestEnvironmentMode;
  environmentProfile: string;
  inheritedServerProfile: string | null;
  environmentVariableNames: string[];
  source: TestSourceEvidence;
}

export interface TestQueueSettings {
  limit: number;
}

export interface TestQueueStatus extends TestQueueSettings {
  running: number;
  queued: number;
}

export interface EnvironmentProfile {
  name: string;
  environment: Record<string, string>;
}

export interface Project {
  id: string;
  name: string;
  repositoryPath: string;
  port: number;
  launchPreset: LaunchPreset;
  tlsMode: DevServerTlsMode;
  tlsKeyPath: string | null;
  tlsCertPath: string | null;
  tlsCaPath: string | null;
  executable: string;
  args: string[];
  environment: Record<string, string>;
  environmentProfiles: EnvironmentProfile[];
  selectedEnvironmentProfile: string;
  testEnvironmentProfiles: TestEnvironmentProfile[];
  testPresetProfiles: Record<string, string>;
  healthcheckPath: string;
  startupTimeoutMs: number;
  selectedWorktreePath: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A project safe to return through REST/MCP snapshots. */
export interface ProjectView extends Omit<Project, "testEnvironmentProfiles"> {
  testEnvironmentProfiles: RedactedTestEnvironmentProfile[];
}

export interface Worktree {
  path: string;
  head: string;
  shortHead: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  dirty: boolean;
  statusError?: string;
  lastCommitAt?: string | null;
  mergedInto?: string | null;
  merged?: boolean | null;
  isDefaultBranch?: boolean;
}

export interface WorktreeMetadataStatus {
  status: "fresh" | "stale" | "refreshing" | "unavailable";
  lastSuccessfulAt: string | null;
  lastAttemptAt: string | null;
  retryAt: string | null;
  error: string | null;
}

export interface Reservation {
  id: string;
  projectId: string;
  worktreePath: string;
  kind: "human" | "agent";
  owner: string;
  reason: string | null;
  createdAt: string;
  expiresAt: string | null;
  maximumExpiresAt: string | null;
}

export interface RuntimeSnapshot {
  phase: RuntimePhase;
  pid: number | null;
  worktreePath: string | null;
  startedAt: string | null;
  error: string | null;
  failure: RuntimeFailure | null;
  logs: string[];
  resources: RuntimeResourceMetrics;
}

export type ClaimedRuntimeAction = "start" | "restart" | "stop";

export interface ClaimedRuntimeReceipt {
  schemaVersion: 1;
  operationId: string;
  action: ClaimedRuntimeAction;
  projectId: string;
  reservationId: string;
  outcome: "completed" | "noop" | "failed";
  replayed: boolean;
  observedAt: string;
  port: number;
  claimedWorktreePath: string;
  runtime: Pick<RuntimeSnapshot, "phase" | "worktreePath" | "startedAt">;
  error: { code: string; message: string } | null;
  leaseHeld: boolean;
  occupiesCapacity: boolean;
  capacity: Pick<ServerCapacityStatus, "enabled" | "limit" | "used" | "available">;
}

export type ResourceMetricsStatus = "idle" | "available" | "stale" | "unavailable" | "unsupported";

export interface ResourceHistoryPoint {
  sampledAt: string;
  rssBytes: number;
}

export interface RuntimeResourceMetrics {
  status: ResourceMetricsStatus;
  currentRssBytes: number | null;
  peakRssBytes: number | null;
  cpuPercent: number | null;
  processCount: number | null;
  sampledAt: string | null;
  sampleAgeSeconds: number | null;
  warningThresholdBytes: number | null;
  history: ResourceHistoryPoint[];
}

export interface RuntimeMetricsResponse {
  projects: Array<{ projectId: string; resources: RuntimeResourceMetrics }>;
}

export interface RuntimeFailure {
  code: "port_in_use" | "missing_dev_script" | "missing_dependency" | "invalid_arguments" | "missing_executable" | "resource_limit" | "startup_timeout" | "process_exit";
  title: string;
  message: string;
  suggestion: string;
  technicalDetails: string;
}

export interface ProjectSnapshot {
  /** Includes the full bounded retained test history, not only the legacy 20-run preview. */
  testHistoryComplete?: boolean;
  lastLaunchedAt?: Record<string, string>;
  project: ProjectView;
  runtime: RuntimeSnapshot;
  reservation: Reservation | null;
  worktrees: Worktree[];
  storage: WorktreeStorageSnapshot[];
  testPresets: WorktreeTestPresets[];
  testRuns: TestRun[];
  metadata?: WorktreeMetadataStatus;
  discoveryError?: string;
}

export type DashboardSection = "runtime" | "reservation" | "tests" | "storage" | "controller";
export type DashboardChangeKind = DashboardSection | "topology" | "metadata";

export interface DashboardChangeEvent {
  epoch: string;
  revision: number;
  kinds: DashboardChangeKind[];
  projectIds: string[];
  allProjects: boolean;
  at: string;
}

export interface ProjectLiveSnapshot {
  testHistoryComplete?: boolean;
  lastLaunchedAt?: Record<string, string>;
  projectId: string;
  runtime?: RuntimeSnapshot;
  reservation?: Reservation | null;
  testRuns?: TestRun[];
  storage?: WorktreeStorageSnapshot[];
}

export interface DashboardLiveResponse {
  projects: ProjectLiveSnapshot[];
  capacity?: ServerCapacityStatus;
  testQueue?: TestQueueStatus;
  version?: Pick<DashboardChangeEvent, "epoch" | "revision">;
}

export interface ProjectSummary {
  project: ProjectView;
  runtime: RuntimeSnapshot;
  reservation: Reservation | null;
}

export interface WorktreeStorageHistoryPoint {
  measuredAt: string;
  totalBytes: number;
  nextBytes: number;
  nextCacheBytes: number;
  nodeModulesBytes: number;
}

export interface WorktreeStorageDirectory {
  name: string;
  bytes: number;
}

export interface WorktreeStorageSnapshot {
  worktreePath: string;
  status: "unmeasured" | "pending" | "scanning" | "available" | "unavailable";
  totalBytes: number | null;
  nextBytes: number | null;
  nextCacheBytes: number | null;
  nodeModulesBytes: number | null;
  otherBytes: number | null;
  measuredAt: string | null;
  topDirectories: WorktreeStorageDirectory[];
  history: WorktreeStorageHistoryPoint[];
  error: string | null;
}

export type SafeCacheKind = "next";

export interface CacheDeletionResult {
  cache: SafeCacheKind;
  worktreePath: string;
  removed: boolean;
}

export interface DashboardResponse {
  projects: ProjectSnapshot[];
  capacity: ServerCapacityStatus;
  testQueue: TestQueueStatus;
}

export interface ServerCapacitySettings {
  enabled: boolean;
  limit: number;
}

export interface ServerCapacityHolder {
  projectId: string;
  projectName: string;
  phase: "starting" | "running" | "stopping";
}

export interface ServerCapacityStatus extends ServerCapacitySettings {
  used: number;
  available: number | null;
  holders: ServerCapacityHolder[];
}

export interface McpStatus {
  phase: "running" | "stopped" | "disabled" | "unknown";
  endpoint: string | null;
  transport: "streamable-http";
  network: "loopback";
  authentication: "bearer" | "none";
  activeSessions: number;
}

/** Installation-wide authentication shown to every signed-in client; never includes secrets. */
export interface ControllerAuthenticationStatus {
  mode: "legacy" | "open" | "token" | "better-auth";
  /** Address the controller listens on, so open mode shows what it exposes. */
  listen: string;
}

export interface ControllerDashboardResponse extends DashboardResponse {
  mcp: McpStatus;
  authentication?: ControllerAuthenticationStatus;
}

export interface DirectoryListing {
  root: string;
  current: string;
  parent: string | null;
  directories: Array<{ name: string; path: string }>;
  files: Array<{ name: string; path: string }>;
}
