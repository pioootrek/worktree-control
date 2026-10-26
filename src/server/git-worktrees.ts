import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import type { TestSourceObservation, Worktree } from "@/shared/contracts";

export type GitCommandPriority = "operational" | "background" | "remote";

interface AdmissionJob<T> {
  priority: GitCommandPriority;
  operation: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  dispose?: () => void;
  signal?: AbortSignal;
}

export class GitCommandAdmission {
  private readonly operational: AdmissionJob<unknown>[] = [];
  private readonly background: AdmissionJob<unknown>[] = [];
  private readonly remote: AdmissionJob<unknown>[] = [];
  private readonly controllers = new Set<AbortController>();
  private running = 0;
  private remoteRunning = 0;
  private closed = false;

  constructor(
    private readonly limit = 4,
    private readonly maxQueued = 128,
    private readonly remoteLimit = 1,
  ) {}

  run<T>(priority: GitCommandPriority, operation: (signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    if (this.closed) return Promise.reject(new Error("Obsługa poleceń Git jest zamknięta."));
    const queue = priority === "operational" ? this.operational
      : priority === "remote" ? this.remote : this.background;
    if (queue.length >= this.maxQueued) {
      return Promise.reject(new Error("Kolejka poleceń Git jest zajęta. Spróbuj ponownie później."));
    }
    return new Promise<T>((resolve, reject) => {
      const job = { priority, operation, resolve, reject, signal: options.signal } as AdmissionJob<T>;
      const abort = () => {
        const index = queue.indexOf(job as AdmissionJob<unknown>);
        if (index < 0) return; // An admitted operation owns cleanup before its promise settles.
        queue.splice(index, 1);
        job.dispose?.();
        reject(options.signal!.reason);
      };
      job.dispose = () => options.signal?.removeEventListener("abort", abort);
      options.signal?.addEventListener("abort", abort, { once: true });
      queue.push(job as AdmissionJob<unknown>);
      this.pump();
    });
  }

  close(): void {
    this.closed = true;
    const error = new Error("Obsługa poleceń Git została zamknięta.");
    for (const job of [...this.operational.splice(0), ...this.remote.splice(0), ...this.background.splice(0)]) { job.dispose?.(); job.reject(error); }
    for (const controller of this.controllers) controller.abort();
  }

  private pump(): void {
    while (!this.closed && this.running < this.limit) {
      const job = this.operational.shift()
        ?? (this.remoteRunning < this.remoteLimit ? this.remote.shift() : undefined)
        ?? this.background.shift();
      if (!job) return;
      job.dispose?.();
      this.running += 1;
      if (job.priority === "remote") this.remoteRunning += 1;
      const controller = new AbortController();
      this.controllers.add(controller);
      void job.operation(job.signal ? AbortSignal.any([controller.signal, job.signal]) : controller.signal).then(job.resolve, job.reject).finally(() => {
        this.controllers.delete(controller);
        this.running -= 1;
        if (job.priority === "remote") this.remoteRunning -= 1;
        this.pump();
      });
    }
  }
}

function execute(
  executable: string,
  args: string[],
  options: { encoding: BufferEncoding; timeout: number; maxBuffer?: number; signal: AbortSignal },
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout) });
    });
  });
}

export interface GitWorktreeReader {
  canonicalRepositoryPath(path: string): Promise<string>;
  list(repositoryPath: string, options?: { priority?: GitCommandPriority; includeInsights?: boolean }): Promise<Worktree[]>;
  observe(worktreePath: string, options?: GitObservationOptions): Promise<TestSourceObservation>;
  close?(): void;
}
export interface GitObservationOptions {
  signal?: AbortSignal;
  /** Trusted queue-owned execution, used when observation is part of remote preparation. */
  execute?: (args: string[], signal: AbortSignal) => Promise<string>;
}
export function parseWorktreePorcelain(output: string): Omit<Worktree, "dirty">[] {
  const records = output.split("\0\0").filter(Boolean);
  return records.flatMap((record) => {
    const lines = record.split("\0").filter(Boolean);
    const fields = new Map<string, string>();
    const flags = new Set<string>();
    for (const line of lines) {
      const separator = line.indexOf(" ");
      if (separator === -1) flags.add(line);
      else fields.set(line.slice(0, separator), line.slice(separator + 1));
    }
    const path = fields.get("worktree");
    const head = fields.get("HEAD");
    if (!path || !head || flags.has("bare")) return [];
    const branchRef = fields.get("branch");
    return [{
      path,
      head,
      shortHead: head.slice(0, 8),
      branch: branchRef?.replace(/^refs\/heads\//, "") ?? null,
      detached: flags.has("detached"),
      locked: fields.has("locked") || flags.has("locked"),
      prunable: fields.has("prunable") || flags.has("prunable"),
    }];
  });
}

export class SystemGitWorktreeReader implements GitWorktreeReader {
  constructor(private readonly admission = new GitCommandAdmission()) {}

  async canonicalRepositoryPath(path: string): Promise<string> {
    const canonicalInput = await realpath(path);
    try {
      const { stdout } = await this.admission.run("operational", (signal) => execute(
        "git", ["-C", canonicalInput, "rev-parse", "--show-toplevel"],
        { encoding: "utf8", timeout: 5000, signal },
      ));
      return realpath(stdout.trim());
    } catch {
      throw new Error("Wybrana ścieżka nie jest repozytorium Git.");
    }
  }

  async list(repositoryPath: string, options: { priority?: GitCommandPriority; includeInsights?: boolean } = {}): Promise<Worktree[]> {
    const priority = options.priority ?? "operational";
    const { stdout } = await this.admission.run(priority, (signal) => execute(
      "git", ["-C", repositoryPath, "worktree", "list", "--porcelain", "-z"],
      { encoding: "utf8", timeout: 8000, maxBuffer: 2 * 1024 * 1024, signal },
    ));
    const worktrees = parseWorktreePorcelain(stdout);
    const insights = options.includeInsights ? await this.branchInsights(repositoryPath, priority) : new Map<string, Partial<Worktree>>();
    return Promise.all(worktrees.map(async (worktree) => {
      let dirty = false;
      let statusError: string | undefined;
      try {
        const { stdout: status } = await this.admission.run(priority, (signal) => execute(
          "git", ["-C", worktree.path, "status", "--porcelain", "--untracked-files=normal"],
          { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, signal },
        ));
        dirty = status.length > 0;
      } catch {
        dirty = true;
        statusError = "Nie udało się odczytać stanu worktree.";
      }
      return { ...worktree, ...insights.get(worktree.branch ?? ""), dirty, ...(statusError ? { statusError } : {}) };
    }));
  }

  private async branchInsights(repositoryPath: string, priority: GitCommandPriority): Promise<Map<string, Partial<Worktree>>> {
    const read = async (args: string[]) => (await this.admission.run(priority, (signal) => execute(
      "git", ["-C", repositoryPath, ...args], { encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024, signal },
    ))).stdout.trim();
    const result = new Map<string, Partial<Worktree>>();
    try {
      const refs = await read(["for-each-ref", "--format=%(refname:short)%09%(committerdate:iso-strict)", "refs/heads/"]);
      for (const row of refs.split("\n").filter(Boolean)) {
        const [branch, date] = row.split("\t");
        result.set(branch, { lastCommitAt: date || null, merged: null, mergedInto: null });
      }
      let target: string | null = null;
      try { target = (await read(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).replace(/^origin\//, ""); } catch { /* local-only repository */ }
      if (!target) target = result.has("main") ? "main" : result.has("master") ? "master" : null;
      if (!target) return result;
      const targetRef = result.has(target) ? `refs/heads/${target}` : `refs/remotes/origin/${target}`;
      const merged = new Set((await read(["for-each-ref", `--merged=${targetRef}`, "--format=%(refname:short)", "refs/heads/"])).split("\n"));
      for (const [branch, info] of result) result.set(branch, { ...info, mergedInto: target, merged: branch === target ? false : merged.has(branch), isDefaultBranch: branch === target });
    } catch { /* Missing evidence stays unknown; ordinary worktree discovery still works. */ }
    return result;
  }

  async observe(worktreePath: string, options: GitObservationOptions = {}): Promise<TestSourceObservation> {
    const observedAt = new Date().toISOString();
    try {
      const canonical = await realpath(worktreePath);
      const read = (args: string[]) => this.admission.run("operational", async (signal) => options.execute
        ? { stdout: await options.execute(["-C", canonical, ...args], signal) }
        : execute("git", ["-C", canonical, ...args], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, signal }), { signal: options.signal });
      const optionalRead = async (args: string[], fallback: string) => {
        try {
          return (await read(args)).stdout;
        } catch (error) {
          if ((error as { code?: string | number }).code === 1 || (error as { exitCode?: number }).exitCode === 1) return fallback;
          throw error;
        }
      };
      const before = (await read(["rev-parse", "HEAD"])).stdout.trim();
      const branch = (await optionalRead(["symbolic-ref", "--quiet", "--short", "HEAD"], "")).trim() || null;
      const status = (await read(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"])).stdout;
      const indexFlags = (await read(["ls-files", "-v", "-z"])).stdout.split("\0").filter(Boolean);
      const sparse = (await optionalRead(["config", "--bool", "core.sparseCheckout"], "false")).trim() === "true";
      const after = (await read(["rev-parse", "HEAD"])).stdout.trim();
      const records = status.split("\0").filter(Boolean).sort();
      const unsupportedIndex = indexFlags.some((record) => record.startsWith("S ") || /^[a-z] /.test(record));
      const complete = before === after && !sparse && !unsupportedIndex;
      const errorCode = before !== after ? "unstable_head" : sparse ? "sparse_checkout_unsupported" : unsupportedIndex ? "index_flags_unsupported" : null;
      return { observedAt, head: after || null, branch, dirty: records.length > 0, statusDigest: createHash("sha256").update(records.join("\0")).digest("hex"), statusEntries: records.length, complete, errorCode };
    } catch (error) {
      if (options.signal?.aborted || (error as { cleanupUnconfirmed?: boolean }).cleanupUnconfirmed) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      return { observedAt, head: null, branch: null, dirty: null, statusDigest: null, statusEntries: null, complete: false, errorCode: code === "ENOENT" ? "missing_worktree" : code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "status_limit_exceeded" : "source_observation_failed" };
    }
  }

  close(): void {
    this.admission.close();
  }
}
