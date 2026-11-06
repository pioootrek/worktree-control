import type { WebExportStatus } from "@/shared/contracts/godot-web";
import type {
  DashboardLiveResponse,
  DashboardResponse,
  DashboardSection,
  Project,
  ProjectSnapshot,
  ProjectSummary,
  Worktree,
  WorktreeMetadataStatus,
  WorktreeTestPresets,
} from "@/shared/contracts";
import type { GitWorktreeReader } from "../../git-worktrees";
import type { ProcessManager } from "../../process-manager";
import type { StateStore } from "../../state-store";
import type { WorktreeStorageManager } from "../../worktree-storage";
import { redactProject } from "../environments";

// Retention: 50 completed per project; admission: 100 queued and 16 running globally.
// This bound includes the entire retained set before latest-per-preset grouping.
const DASHBOARD_TEST_RUN_LIMIT = 200;

const DEFAULT_FRESHNESS_MS = 30_000;
const DEFAULT_FAILURE_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

interface CachedMetadata {
  worktrees: Worktree[];
  testPresets: WorktreeTestPresets[];
}

interface CacheEntry {
  value: CachedMetadata | null;
  bytes: number;
  lastAttemptAt: number | null;
  lastSuccessfulAt: number | null;
  lastUsedAt: number;
  error: string | null;
  inFlight: Promise<void> | null;
  invalidatedDuringRefresh: boolean;
}

export interface DashboardQueryOptions {
  freshnessMs?: number;
  failureCooldownMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
}

export interface DashboardQueryDependencies {
  store: StateStore;
  git: GitWorktreeReader;
  processes: ProcessManager;
  storage?: WorktreeStorageManager;
  discoverPresets(project: Project, worktreePath: string): WorktreeTestPresets;
  capacity(projects?: ProjectSnapshot[]): DashboardResponse["capacity"];
  testQueue(): DashboardResponse["testQueue"];
  webExport?(projectId: string): WebExportStatus | null;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read-only dashboard projection. Cached metadata is never used for operational validation. */
export class DashboardQueryService {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly freshnessMs: number;
  private readonly failureCooldownMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly dependencies: DashboardQueryDependencies, options: DashboardQueryOptions = {}) {
    this.freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
    this.failureCooldownMs = options.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  async dashboard(): Promise<DashboardResponse> {
    const projects = await Promise.all(this.dependencies.store.listProjects().map((project) => this.snapshot(project)));
    return {
      projects,
      capacity: this.dependencies.capacity(projects),
      testQueue: this.dependencies.testQueue(),
    };
  }

  async projectSnapshot(project: Project): Promise<ProjectSnapshot> {
    await this.load(project, true, "operational");
    return this.assemble(project, this.requireEntry(project.repositoryPath));
  }

  projectSummaries(): ProjectSummary[] {
    return this.dependencies.store.listProjects().map((project) => ({
      project: redactProject(project),
      runtime: this.dependencies.processes.snapshot(project.id),
      reservation: this.dependencies.store.getActiveReservation(project.id),
    }));
  }

  live(projectIds: string[], sections: DashboardSection[]): DashboardLiveResponse {
    const selected = new Set(projectIds);
    const include = (section: DashboardSection) => sections.includes(section);
    const projects = this.dependencies.store.listProjects()
      .filter((project) => selected.size === 0 || selected.has(project.id))
      .map((project) => {
        const paths = this.entries.get(project.repositoryPath)?.value?.worktrees.map(({ path }) => path) ?? [];
        return {
          projectId: project.id,
          ...(include("runtime") ? { lastLaunchedAt: this.dependencies.store.listWorktreeLaunches(project.id) } : {}),
          ...(include("runtime") ? { runtime: this.dependencies.processes.snapshot(project.id) } : {}),
          ...(include("runtime") && project.launchPreset === "godot-web" ? { webExport: this.dependencies.webExport?.(project.id) ?? null } : {}),
          ...(include("reservation") ? { reservation: this.dependencies.store.getActiveReservation(project.id) } : {}),
          ...(include("storage") ? { storage: this.dependencies.storage?.snapshots(project.id, paths) ?? [] } : {}),
          ...(include("tests") ? { testRuns: this.dependencies.store.listTestRuns(project.id, DASHBOARD_TEST_RUN_LIMIT), testHistoryComplete: true } : {}),
        };
      });
    return {
      projects,
      ...(include("controller") ? {
        capacity: this.dependencies.capacity(),
        testQueue: this.dependencies.testQueue(),
      } : {}),
    };
  }

  async refresh(project: Project, force = true): Promise<ProjectSnapshot> {
    await this.load(project, force);
    return this.assemble(project, this.requireEntry(project.repositoryPath));
  }

  invalidate(repositoryPath: string): void {
    const entry = this.entries.get(repositoryPath);
    if (!entry) return;
    entry.lastSuccessfulAt = null;
    if (entry.inFlight) entry.invalidatedDuringRefresh = true;
  }

  remove(repositoryPath: string): void {
    const entry = this.entries.get(repositoryPath);
    if (!entry?.inFlight) this.entries.delete(repositoryPath);
    else {
      entry.value = null;
      entry.bytes = 0;
      entry.invalidatedDuringRefresh = true;
    }
  }

  close(): void {
    this.closed = true;
    this.entries.clear();
  }

  private async snapshot(project: Project): Promise<ProjectSnapshot> {
    try {
      const entry = this.entries.get(project.repositoryPath);
      if (!entry?.value) await this.load(project, false);
      return this.assemble(project, this.requireEntry(project.repositoryPath));
    } catch (error) {
      const message = safeMessage(error);
      return this.assemble(project, {
        value: null,
        bytes: 0,
        lastAttemptAt: this.now(),
        lastSuccessfulAt: null,
        lastUsedAt: this.now(),
        error: message,
        inFlight: null,
        invalidatedDuringRefresh: false,
      });
    }
  }

  private assemble(project: Project, entry: CacheEntry): ProjectSnapshot {
    entry.lastUsedAt = this.now();
    const value = entry.value ?? { worktrees: [], testPresets: [] };
    const worktreePaths = value.worktrees.map(({ path }) => path);
    return {
      project: redactProject(project),
      runtime: this.dependencies.processes.snapshot(project.id),
      reservation: this.dependencies.store.getActiveReservation(project.id),
      worktrees: value.worktrees,
      lastLaunchedAt: this.dependencies.store.listWorktreeLaunches(project.id),
      storage: this.dependencies.storage?.snapshots(project.id, worktreePaths) ?? [],
      testPresets: value.testPresets,
      testRuns: this.dependencies.store.listTestRuns(project.id, DASHBOARD_TEST_RUN_LIMIT),
      testHistoryComplete: true,
      metadata: this.metadataStatus(entry),
      ...(entry.error ? { discoveryError: entry.error } : {}),
      ...(project.launchPreset === "godot-web" ? { webExport: this.dependencies.webExport?.(project.id) ?? null } : {}),
    };
  }

  private metadataStatus(entry: CacheEntry): WorktreeMetadataStatus {
    const now = this.now();
    const stale = entry.error !== null || entry.lastSuccessfulAt === null || now - entry.lastSuccessfulAt >= this.freshnessMs;
    const retryAt = entry.error && entry.lastAttemptAt !== null
      ? new Date(entry.lastAttemptAt + this.failureCooldownMs).toISOString()
      : null;
    return {
      status: entry.inFlight ? "refreshing" : !entry.value ? "unavailable" : stale ? "stale" : "fresh",
      lastSuccessfulAt: entry.lastSuccessfulAt === null ? null : new Date(entry.lastSuccessfulAt).toISOString(),
      lastAttemptAt: entry.lastAttemptAt === null ? null : new Date(entry.lastAttemptAt).toISOString(),
      retryAt,
      error: entry.error,
    };
  }

  private async load(project: Project, force: boolean, priority: "operational" | "background" = "background"): Promise<void> {
    if (this.closed) throw new Error("Projekcja panelu jest zamknięta.");
    const entry = this.entry(project.repositoryPath);
    entry.lastUsedAt = this.now();
    if (entry.inFlight) return entry.inFlight;
    if (!force && entry.error && entry.lastAttemptAt !== null && this.now() - entry.lastAttemptAt < this.failureCooldownMs) return;
    entry.lastAttemptAt = this.now();
    entry.invalidatedDuringRefresh = false;
    const operation = (async () => {
      try {
        const worktrees = await this.dependencies.git.list(project.repositoryPath, { priority, includeInsights: true });
        const testPresets = worktrees.map((worktree) => this.dependencies.discoverPresets(project, worktree.path));
        const value = { worktrees, testPresets };
        const bytes = Buffer.byteLength(JSON.stringify(value));
        if (bytes > this.maxBytes) throw new Error("Metadane worktree przekraczają limit projekcji panelu.");
        this.evictFor(project.repositoryPath, bytes);
        entry.value = value;
        entry.bytes = bytes;
        entry.lastSuccessfulAt = this.now();
        entry.error = worktrees.some(({ statusError }) => statusError)
          ? "Nie udało się potwierdzić stanu co najmniej jednego worktree. Przyjęto bezpiecznie, że zawiera zmiany."
          : null;
        this.dependencies.storage?.ensureFresh(project.id, worktrees.map(({ path }) => path));
      } catch (error) {
        entry.error = safeMessage(error);
      } finally {
        entry.inFlight = null;
        if (entry.invalidatedDuringRefresh) entry.lastSuccessfulAt = null;
      }
    })();
    entry.inFlight = operation;
    return operation;
  }

  private entry(repositoryPath: string): CacheEntry {
    const existing = this.entries.get(repositoryPath);
    if (existing) return existing;
    this.evictFor(repositoryPath, 0);
    const created: CacheEntry = {
      value: null,
      bytes: 0,
      lastAttemptAt: null,
      lastSuccessfulAt: null,
      lastUsedAt: this.now(),
      error: null,
      inFlight: null,
      invalidatedDuringRefresh: false,
    };
    this.entries.set(repositoryPath, created);
    return created;
  }

  private requireEntry(repositoryPath: string): CacheEntry {
    return this.entries.get(repositoryPath) ?? this.entry(repositoryPath);
  }

  private evictFor(repositoryPath: string, incomingBytes: number): void {
    const currentBytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    let neededEntries = this.entries.has(repositoryPath) ? this.entries.size : this.entries.size + 1;
    let neededBytes = currentBytes - (this.entries.get(repositoryPath)?.bytes ?? 0) + incomingBytes;
    const candidates = [...this.entries.entries()]
      .filter(([key, entry]) => key !== repositoryPath && !entry.inFlight)
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
    while ((neededEntries > this.maxEntries || neededBytes > this.maxBytes) && candidates.length) {
      const [key, entry] = candidates.shift()!;
      this.entries.delete(key);
      neededEntries -= 1;
      neededBytes -= entry.bytes;
    }
    if (neededEntries > this.maxEntries || neededBytes > this.maxBytes) {
      throw new Error("Pamięć projekcji panelu jest zajęta. Spróbuj ponownie później.");
    }
  }
}
