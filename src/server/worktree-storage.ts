import { lstat, opendir, readFile, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import type { CacheDeletionResult, SafeCacheKind, WorktreeStorageSnapshot } from "@/shared/contracts";
import type { StateStore, WorktreeStorageSample } from "./state-store";
import { admissionOf, admitWithRetry } from "./database-admission";
import type { WorktreeMaintenanceAccess } from "./modules/lifecycle";

const AUTO_REFRESH_MS = 6 * 60 * 60_000;
const FAILED_ATTEMPT_COOLDOWN_MS = 30_000;

export interface WorktreeDiskScanner {
  scan(worktreePath: string, signal?: AbortSignal): Promise<Omit<WorktreeStorageSample, "projectId" | "measuredAt">>;
}

export interface WorktreeCacheCleaner {
  remove(worktreePath: string, cache: SafeCacheKind): Promise<CacheDeletionResult>;
}

const SAFE_CACHE_DIRECTORIES: Record<SafeCacheKind, string> = { next: ".next" };

export class AllowlistedWorktreeCacheCleaner implements WorktreeCacheCleaner {
  async remove(worktreePath: string, cache: SafeCacheKind): Promise<CacheDeletionResult> {
    const root = resolve(worktreePath);
    const rootStats = await lstat(root);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new Error("Worktree nie jest zwykłym katalogiem. Pamięć podręczna nie została usunięta.");
    }
    let packageJson: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    try {
      packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as typeof packageJson;
    } catch {
      throw new Error("Ta operacja jest dostępna tylko dla projektów Next.js.");
    }
    if (!("next" in (packageJson.dependencies ?? {})) && !("next" in (packageJson.devDependencies ?? {}))) {
      throw new Error("Ta operacja jest dostępna tylko dla projektów Next.js.");
    }
    const target = resolve(root, SAFE_CACHE_DIRECTORIES[cache]);
    if (dirname(target) !== root) throw new Error("Nieprawidłowy katalog pamięci podręcznej.");
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { cache, worktreePath: root, removed: false };
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Katalog .next nie jest zwykłym katalogiem. Nie został usunięty.");
    }
    await rm(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
    return { cache, worktreePath: root, removed: true };
  }
}

function allocatedBytes(stats: Awaited<ReturnType<typeof lstat>>): number {
  const blocks = Number(stats.blocks);
  return Number.isFinite(blocks) && blocks > 0 ? blocks * 512 : Number(stats.size);
}

export class FilesystemWorktreeDiskScanner implements WorktreeDiskScanner {
  async scan(worktreePath: string, signal?: AbortSignal): Promise<Omit<WorktreeStorageSample, "projectId" | "measuredAt">> {
    const root = resolve(worktreePath);
    const topDirectories = new Map<string, number>();
    const rootDirectories = new Set<string>();
    let totalBytes = 0;
    let nextBytes = 0;
    let nextCacheBytes = 0;
    let nodeModulesBytes = 0;

    const visit = async (path: string): Promise<void> => {
      signal?.throwIfAborted();
      const relativePath = relative(root, path);
      const parts = relativePath ? relativePath.split(sep) : [];
      if (parts[0] === ".git") return;
      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (stats.isSymbolicLink()) return;
      const bytes = allocatedBytes(stats);
      totalBytes += bytes;
      if (parts.length === 1 && stats.isDirectory()) rootDirectories.add(parts[0]);
      if (parts[0]) topDirectories.set(parts[0], (topDirectories.get(parts[0]) ?? 0) + bytes);
      if (parts[0] === ".next") nextBytes += bytes;
      if (parts[0] === ".next" && parts[1] === "cache") nextCacheBytes += bytes;
      if (parts[0] === "node_modules") nodeModulesBytes += bytes;
      if (!stats.isDirectory()) return;
      const directory = await opendir(path);
      for await (const entry of directory) await visit(resolve(path, entry.name));
    };

    await visit(root);
    return {
      worktreePath: root,
      totalBytes,
      nextBytes,
      nextCacheBytes,
      nodeModulesBytes,
      topDirectories: [...topDirectories.entries()]
        .filter(([name]) => rootDirectories.has(name))
        .map(([name, bytes]) => ({ name, bytes }))
        .sort((left, right) => right.bytes - left.bytes)
        .slice(0, 5),
    };
  }
}

export class WorktreeStorageManager {
  private tail: Promise<void> = Promise.resolve();
  private readonly queued = new Set<string>();
  private readonly states = new Map<string, { status: "pending" | "scanning" | "unavailable"; error: string | null }>();
  private readonly lastAttempts = new Map<string, number>();
  private readonly abortController = new AbortController();
  private closing = false;

  constructor(
    private readonly store: StateStore,
    private readonly lifecycle: WorktreeMaintenanceAccess,
    private readonly scanner: WorktreeDiskScanner = new FilesystemWorktreeDiskScanner(),
    private readonly onChange: (projectId: string) => void = () => undefined,
  ) {}

  assertLifecycle(lifecycle: WorktreeMaintenanceAccess): void {
    if (this.lifecycle !== lifecycle) {
      throw new Error("WorktreeStorageManager and ControlService must share one ProjectLifecycle instance.");
    }
  }

  snapshots(projectId: string, worktreePaths: string[]): WorktreeStorageSnapshot[] {
    return worktreePaths.map((worktreePath) => {
      const stored = this.store.getWorktreeStorage(projectId, worktreePath);
      const state = this.states.get(this.key(projectId, worktreePath));
      if (state?.status === "scanning" || state?.status === "pending") {
        return stored ? { ...stored, status: state.status } : this.empty(worktreePath, state.status);
      }
      if (state?.status === "unavailable") {
        return stored ? { ...stored, status: "unavailable", error: state.error } : { ...this.empty(worktreePath, "unavailable"), error: state.error };
      }
      return stored ?? this.empty(worktreePath, "unmeasured");
    });
  }

  ensureFresh(projectId: string, worktreePaths: string[]): void {
    const staleBefore = Date.now() - AUTO_REFRESH_MS;
    for (const worktreePath of worktreePaths) {
      const current = this.store.getWorktreeStorage(projectId, worktreePath);
      if (!current?.measuredAt || new Date(current.measuredAt).getTime() < staleBefore) this.queue(projectId, worktreePath);
    }
  }

  isBusy(projectId: string, worktreePath: string): boolean {
    return this.queued.has(this.key(projectId, worktreePath));
  }

  queue(projectId: string, worktreePath: string, force = false): boolean {
    if (this.closing) return false;
    const key = this.key(projectId, worktreePath);
    if (this.queued.has(key)) return false;
    if (!force) {
      const current = this.store.getWorktreeStorage(projectId, worktreePath);
      if (current?.measuredAt && Date.now() - new Date(current.measuredAt).getTime() < AUTO_REFRESH_MS) return false;
      const lastAttempt = this.lastAttempts.get(key);
      if (lastAttempt !== undefined && Date.now() - lastAttempt < FAILED_ATTEMPT_COOLDOWN_MS) return false;
    }
    const releaseScan = this.lifecycle.acquireScan(projectId, worktreePath);
    if (!releaseScan) return false;
    this.queued.add(key);
    this.states.set(key, { status: "pending", error: null });
    this.tail = this.tail.catch(() => undefined).then(async () => {
      try {
        this.lastAttempts.set(key, Date.now());
        if (this.closing) return;
        this.states.set(key, { status: "scanning", error: null });
        this.onChange(projectId);
        try {
          // The scan holds no database admission; only its result is saved under a fresh one.
          const sample = await this.scanner.scan(worktreePath, this.abortController.signal);
          if (this.closing) return;
          const measuredAt = new Date().toISOString();
          const saved = await admitWithRetry(admissionOf(this.store), () => {
            if (this.closing) return false;
            this.store.saveWorktreeStorage({ ...sample, projectId, measuredAt });
            return true;
          });
          if (!saved) return;
          this.states.delete(key);
        } catch (error) {
          this.lastAttempts.set(key, Date.now());
          if (!this.closing) this.states.set(key, { status: "unavailable", error: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        this.queued.delete(key);
        releaseScan();
        if (!this.closing) this.onChange(projectId);
      }
    });
    return true;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.abortController.abort();
    await this.tail.catch(() => undefined);
    this.queued.clear();
    this.states.clear();
    this.lastAttempts.clear();
  }

  private empty(worktreePath: string, status: "unmeasured" | "pending" | "scanning" | "unavailable"): WorktreeStorageSnapshot {
    return { worktreePath, status, totalBytes: null, nextBytes: null, nextCacheBytes: null, nodeModulesBytes: null, otherBytes: null, measuredAt: null, topDirectories: [], history: [], error: null };
  }

  private key(projectId: string, worktreePath: string): string {
    return `${projectId}\0${worktreePath}`;
  }
}
