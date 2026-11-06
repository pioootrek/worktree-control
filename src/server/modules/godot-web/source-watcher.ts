import { watch as nodeWatch, type FSWatcher } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export type WatcherState = "watching" | "limit_exceeded" | "unavailable" | "stopped";
export type WatchFactory = (path: string, listener: (event: string, filename: string | Buffer | null) => void) => Pick<FSWatcher, "close" | "on">;

export interface SourceWatcherOptions {
  root: string;
  /** Worktree-relative directories (recursive) or files; "." is the root. */
  paths: string[];
  /** Worktree-relative prefixes never watched or reported. */
  ignore: string[];
  /** Resolve live Git rules without scanning the worktree. At most 128 paths per call. */
  checkIgnoredPaths?(paths: string[], signal: AbortSignal): Promise<string[]>;
  debounceMs: number;
  /** A continuous stream of edits still produces a change after this long. */
  maxWaitMs?: number;
  maxDirectories?: number;
  onChange(): void;
  /** Immediate freshness invalidation, separate from the debounced rebuild request. */
  onInvalidate?(): void;
  onState?(state: WatcherState): void;
  watch?: WatchFactory;
}

const EDITOR_TEMPORARY = /(?:^\.#|~$|\.sw[a-p]$|\.tmp$|^4913$|\.crdownload$|^\.DS_Store$)/;
export const ALWAYS_IGNORED = [".git", ".godot", ".import", ".vscode", ".idea", ".venv", "node_modules", "__pycache__"];

interface WatchedDirectory { watcher: Pick<FSWatcher, "close" | "on">; recursive: boolean; only: Set<string> | null }

/**
 * Bounded, opt-in watcher used only while a Godot Web runtime is active. It
 * places one non-recursive watcher per directory, skips symlinks and ignored
 * prefixes, caps the directory count and debounces bursts into one callback.
 */
export class SourceWatcher {
  private readonly directories = new Map<string, WatchedDirectory>();
  private readonly ignore: string[];
  private readonly maxDirectories: number;
  private readonly maxWaitMs: number;
  private readonly watch: WatchFactory;
  private timer: NodeJS.Timeout | null = null;
  private firstPendingAt: number | null = null;
  private disposed = false;
  private readonly cancellation = new AbortController();
  private readonly pendingEvents = new Map<string, { directory: string; event: string; name: string }>();
  private checking: Promise<void> | null = null;
  private currentState: WatcherState = "stopped";

  constructor(private readonly options: SourceWatcherOptions) {
    this.ignore = [...new Set([...ALWAYS_IGNORED, ...options.ignore])].map((path) => path.replace(/\/+$/, ""));
    this.maxDirectories = options.maxDirectories ?? 4096;
    this.maxWaitMs = options.maxWaitMs ?? Math.max(options.debounceMs * 4, 5_000);
    this.watch = options.watch ?? ((path, listener) => nodeWatch(path, { persistent: false }, listener));
  }

  get state(): WatcherState { return this.currentState; }
  get watchedDirectories(): number { return this.directories.size; }

  isIgnored(relativePath: string): boolean {
    return this.ignore.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`));
  }

  async start(rescan = false): Promise<void> {
    if (this.disposed || this.cancellation.signal.aborted || this.currentState === "limit_exceeded") return;
    try {
      if (this.options.checkIgnoredPaths) this.add(".", false, ".gitignore");
      for (const path of this.options.paths) {
        if (this.disposed || this.cancellation.signal.aborted) return;
        const relativePath = path === "." ? "." : path.replace(/\/+$/, "");
        if (relativePath !== "." && this.isIgnored(relativePath)) continue;
        await this.attachConfiguredPath(relativePath, rescan);
      }
      if (!this.disposed && !this.cancellation.signal.aborted && this.currentState !== "limit_exceeded") this.setState("watching");
    } catch (error) {
      if (error instanceof WatchLimitError) return;
      this.closeWatchers();
      if (!this.disposed) this.setState("unavailable");
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancellation.abort();
    this.pendingEvents.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.firstPendingAt = null;
    this.closeWatchers();
    this.currentState = "stopped";
  }

  private setState(state: WatcherState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.options.onState?.(state);
  }

  private closeWatchers(): void {
    for (const { watcher } of this.directories.values()) { try { watcher.close(); } catch { /* already closed */ } }
    this.directories.clear();
  }

  /** Keep filtered ancestor subscriptions even while a selected path is absent. */
  private async attachConfiguredPath(relativePath: string, rescan = false): Promise<void> {
    if (this.disposed || this.currentState === "limit_exceeded") return;
    if (relativePath === ".") { await this.walk(".", rescan); return; }
    const parts = relativePath.split("/");
    let parent = ".";
    for (let index = 0; index < parts.length; index += 1) {
      if (this.disposed || this.state === "limit_exceeded") return;
      const name = parts[index];
      const child = parent === "." ? name : `${parent}/${name}`;
      if (this.isIgnored(child)) return;
      this.add(parent, false, name);
      if ((await this.gitIgnored([child])).has(child)) { this.forget(child); return; }
      const info = await lstat(join(this.options.root, child)).catch(() => null);
      if (!info || info.isSymbolicLink()) return;
      if (index === parts.length - 1) {
        if (info.isDirectory()) await this.walk(child, rescan);
      } else if (!info.isDirectory()) return;
      parent = child;
    }
  }

  private async walk(relativePath: string, rescan = false): Promise<void> {
    if (this.disposed || this.currentState === "limit_exceeded" || (!rescan && this.directories.get(relativePath)?.recursive)) return;
    if (relativePath !== "." && (await this.gitIgnored([relativePath])).has(relativePath)) { this.forget(relativePath); return; }
    if (this.disposed || this.state === "unavailable") return;
    this.add(relativePath, true, null);
    const entries = await readdir(join(this.options.root, relativePath), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (this.disposed || this.cancellation.signal.aborted) return;
      if (!entry.isDirectory()) continue; // Symlinks report isSymbolicLink, never isDirectory.
      const child = relativePath === "." ? entry.name : `${relativePath}/${entry.name}`;
      if (!this.isIgnored(child)) await this.walk(child, rescan);
    }
  }

  private add(relativePath: string, recursive: boolean, only: string | null): void {
    if (this.disposed || this.cancellation.signal.aborted) return;
    const existing = this.directories.get(relativePath);
    if (existing) {
      if (recursive) { existing.recursive = true; existing.only = null; }
      else if (only && existing.only) existing.only.add(only);
      return;
    }
    if (this.directories.size >= this.maxDirectories) {
      this.closeWatchers();
      this.setState("limit_exceeded");
      throw new WatchLimitError();
    }
    const watcher = this.watch(join(this.options.root, relativePath), (event, filename) => this.event(relativePath, event, filename));
    watcher.on("error", () => this.forget(relativePath));
    this.directories.set(relativePath, { watcher, recursive, only: only ? new Set([only]) : null });
  }

  private forget(relativePath: string): void {
    for (const [path, entry] of this.directories) {
      if (path !== relativePath && !path.startsWith(`${relativePath}/`)) continue;
      try { entry.watcher.close(); } catch { /* already closed */ }
      this.directories.delete(path);
    }
  }

  private event(directory: string, event: string, filename: string | Buffer | null): void {
    if (this.disposed || this.cancellation.signal.aborted) return;
    const entry = this.directories.get(directory);
    if (!entry) return;
    const name = filename === null ? null : String(filename);
    if (name !== null && (EDITOR_TEMPORARY.test(name) || (entry.only && !entry.only.has(name) && !(name === ".gitignore" && this.options.checkIgnoredPaths)))) return;
    const child = name === null ? directory : directory === "." ? name : `${directory}/${name}`;
    if (this.isIgnored(child)) return;
    if (name !== null && this.options.checkIgnoredPaths) {
      if (this.pendingEvents.size >= 4096 && !this.pendingEvents.has(child)) { this.unavailable(); return; }
      const previous = this.pendingEvents.get(child);
      this.pendingEvents.set(child, { directory, event: previous?.event === "rename" ? "rename" : event, name });
      if (!this.checking) {
        this.checking = Promise.resolve().then(() => this.checkEvents()).finally(() => { this.checking = null; });
      }
      return;
    }
    this.acceptEvent(directory, event, name, child);
  }

  /** Publication waits for ignore classification, never for the debounce timer. */
  async flush(): Promise<void> { await this.checking; }

  private async gitIgnored(paths: string[]): Promise<Set<string>> {
    return new Set(await this.options.checkIgnoredPaths?.(paths, this.cancellation.signal) ?? []);
  }

  private unavailable(): void {
    if (this.disposed) return;
    this.cancellation.abort();
    this.pendingEvents.clear();
    this.closeWatchers();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.firstPendingAt = null;
    this.options.onInvalidate?.();
    this.setState("unavailable");
  }

  private async checkEvents(): Promise<void> {
    // A stuck Git query or endless event storm cannot hold an export's queue slot forever.
    const deadline = setTimeout(() => this.unavailable(), 10_000);
    deadline.unref();
    try {
      while (!this.disposed && this.pendingEvents.size > 0) {
        const batch = [...this.pendingEvents.entries()].slice(0, 128);
        for (const [path] of batch) this.pendingEvents.delete(path);
        const ignored = await this.gitIgnored(batch.map(([path]) => path));
        if (this.disposed || this.state === "unavailable") return;
        for (const [path, value] of batch) {
          if (value.name === ".gitignore" || !ignored.has(path)) this.acceptEvent(value.directory, value.event, value.name, path);
        }
        // Revisit skipped subtrees on rule edits, preserving existing subscriptions. This
        // remains inside the bounded classification task, which publication awaits.
        if (batch.some(([, value]) => value.name === ".gitignore")) await this.start(true);
      }
    } catch { this.unavailable(); }
    finally { clearTimeout(deadline); }
  }

  private acceptEvent(directory: string, event: string, name: string | null, child: string): void {
    const entry = this.directories.get(directory);
    if (this.disposed || !entry) return;
    this.options.onInvalidate?.();
    this.schedule();
    if (event !== "rename" || name === null || (name === ".gitignore" && this.options.checkIgnoredPaths)) return;
    // Inode-bound subscriptions must be replaced after removal/recreation.
    this.forget(child);
    if (!entry.recursive) {
      void this.start();
      return;
    }
    // A created directory gains watchers; a removed one releases them.
    void lstat(join(this.options.root, child)).then((info) => {
      if (this.disposed || this.cancellation.signal.aborted) return;
      if (info.isDirectory() && !info.isSymbolicLink()) return this.walk(child).catch((error: unknown) => {
        if (!(error instanceof WatchLimitError)) this.unavailable();
      });
    }, () => this.forget(child));
  }

  private schedule(): void {
    const now = Date.now();
    this.firstPendingAt ??= now;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, Math.min(this.options.debounceMs, this.maxWaitMs - (now - this.firstPendingAt)));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.firstPendingAt = null;
      if (!this.disposed) this.options.onChange();
    }, delay);
    this.timer.unref();
  }
}

class WatchLimitError extends Error {}
