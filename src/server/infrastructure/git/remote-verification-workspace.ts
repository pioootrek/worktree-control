import { execFile } from "node:child_process";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  PrepareRemoteVerificationWorkspaceInput,
  RemoteVerificationWorkspace,
  RemoteVerificationWorkspacePreparer,
} from "@/server/modules/remote-verification";
import { PreparationError } from "@/server/modules/verification";
import { GitCommandAdmission } from "@/server/git-worktrees";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const activeWorkspaceTargets = new Set<string>();

export type RemoteVerificationWorkspaceErrorCode =
  | "invalid_input"
  | "source_unavailable"
  | "commit_unavailable"
  | "workspace_conflict"
  | "workspace_invalid"
  | "operation_unavailable"
  | "cleanup_failed";

export class RemoteVerificationWorkspaceError extends Error {
  constructor(readonly code: RemoteVerificationWorkspaceErrorCode, message: string) {
    super(message);
    this.name = "RemoteVerificationWorkspaceError";
  }
}

function executeGit(args: string[], signal: AbortSignal, timeout: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024, signal }, (error, stdout) => {
      if (error) reject(error);
      else resolvePromise(String(stdout));
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class SystemRemoteVerificationWorkspacePreparer implements RemoteVerificationWorkspacePreparer {
  private readonly root: string;

  constructor(
    workspaceRoot: string,
    private readonly admission: GitCommandAdmission,
  ) {
    this.root = resolve(workspaceRoot);
  }

  async prepare(input: PrepareRemoteVerificationWorkspaceInput): Promise<RemoteVerificationWorkspace> {
    try {
      return await this.prepareOwned(input);
    } catch (error) {
      if (error instanceof RemoteVerificationWorkspaceError || error instanceof PreparationError) throw error;
      throw new RemoteVerificationWorkspaceError("workspace_invalid", "Nie udało się przygotować workspace dla zlecenia.");
    }
  }

  async cleanup(workspace: RemoteVerificationWorkspace): Promise<void> {
    try {
      await this.cleanupOwned(workspace);
    } catch (error) {
      if (error instanceof RemoteVerificationWorkspaceError || error instanceof PreparationError) throw error;
      throw new RemoteVerificationWorkspaceError("cleanup_failed", "Nie udało się bezpiecznie usunąć workspace zlecenia.");
    }
  }

  private async prepareOwned(input: PrepareRemoteVerificationWorkspaceInput): Promise<RemoteVerificationWorkspace> {
    const requestId = this.identifier(input.requestId, "Identyfikator zlecenia");
    const sourceRemote = this.identifier(input.sourceRemote, "Nazwa źródłowego remote");
    const commitSha = input.commitSha.trim().toLowerCase();
    if (!COMMIT_SHA.test(commitSha)) {
      throw new RemoteVerificationWorkspaceError("invalid_input", "Wymagany jest pełny identyfikator commita Git.");
    }

    const git = (args: string[], timeout: number, priority: "operational" | "remote" = "operational") => this.git(args, timeout, priority, input);
    input.preparation?.throwIfAborted();
    const repositoryPath = await this.canonicalRepository(input.repositoryPath, input);
    const root = await this.ensureRoot();
    const target = join(root, requestId);

    let remotes: string[];
    try {
      remotes = (await git(["-C", repositoryPath, "remote"], 5_000))
        .split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error instanceof PreparationError) throw error;
      input.preparation?.throwIfAborted();
      throw new RemoteVerificationWorkspaceError("operation_unavailable", "Nie udało się odczytać źródeł skonfigurowanego projektu.");
    }
    if (!remotes.includes(sourceRemote)) {
      throw new RemoteVerificationWorkspaceError("source_unavailable", "Skonfigurowane źródło projektu nie jest dostępne na workerze.");
    }

    try {
      await git(["-C", repositoryPath, "fetch", "--no-tags", "--prune", "--", sourceRemote], 120_000, "remote");
    } catch (error) {
      if (error instanceof PreparationError) throw error;
      input.preparation?.throwIfAborted();
      throw new RemoteVerificationWorkspaceError("source_unavailable", "Nie udało się pobrać skonfigurowanego źródła projektu.");
    }

    let resolvedCommit: string;
    try {
      resolvedCommit = (await git(
        ["-C", repositoryPath, "rev-parse", "--verify", `${commitSha}^{commit}`],
        5_000,
        "remote",
      )).trim();
    } catch (error) {
      if (error instanceof PreparationError) throw error;
      input.preparation?.throwIfAborted();
      throw new RemoteVerificationWorkspaceError("commit_unavailable", "Żądany commit nie jest dostępny w skonfigurowanym źródle.");
    }
    let containingRefs: string;
    try {
      containingRefs = (await git([
        "-C", repositoryPath, "for-each-ref", "--format=%(refname)", `--contains=${resolvedCommit}`,
        `refs/remotes/${sourceRemote}/`,
      ], 10_000, "remote")).trim();
    } catch (error) {
      if (error instanceof PreparationError) throw error;
      input.preparation?.throwIfAborted();
      throw new RemoteVerificationWorkspaceError("operation_unavailable", "Nie udało się potwierdzić pochodzenia żądanego commita.");
    }
    if (!containingRefs) {
      throw new RemoteVerificationWorkspaceError("commit_unavailable", "Żądany commit nie jest dostępny w skonfigurowanym źródle.");
    }

    if (activeWorkspaceTargets.has(target)) {
      throw new RemoteVerificationWorkspaceError("workspace_conflict", "Workspace zlecenia jest już przygotowywany.");
    }
    activeWorkspaceTargets.add(target);
    let cleanupUnconfirmed = false;
    try {
      if (await exists(target)) {
        await rm(target, { recursive: true, force: true });
      }
      await mkdir(target, { mode: 0o700 });
      try {
        await git(["clone", "--quiet", "--no-checkout", "--", repositoryPath, target], 60_000, "remote");
        await git(["-C", target, "checkout", "--quiet", "--detach", resolvedCommit], 30_000, "remote");
        const executedCommitSha = (await git(["-C", target, "rev-parse", "HEAD"], 5_000, "remote")).trim().toLowerCase();
        const status = await git(
          ["-C", target, "status", "--porcelain=v1", "--untracked-files=all"],
          10_000,
          "remote",
        );
        if (executedCommitSha !== commitSha || status.length > 0) {
          throw new RemoteVerificationWorkspaceError("workspace_invalid", "Przygotowany workspace nie odpowiada żądanemu commitowi.");
        }
        return {
          requestId,
          path: await realpath(target),
          repositoryPath,
          sourceRemote,
          requestedCommitSha: commitSha,
          executedCommitSha,
        };
      } catch (error) {
        cleanupUnconfirmed = error instanceof PreparationError && error.cleanupUnconfirmed;
        if (!cleanupUnconfirmed) {
          try { await rm(target, { recursive: true, force: true }); }
          catch { cleanupUnconfirmed = true; throw new PreparationError("workspace_cleanup_failed", true); }
        }
        if (error instanceof RemoteVerificationWorkspaceError || error instanceof PreparationError) throw error;
        throw new RemoteVerificationWorkspaceError("workspace_invalid", "Nie udało się przygotować workspace dla zlecenia.");
      }
    } finally {
      if (!cleanupUnconfirmed) activeWorkspaceTargets.delete(target);
    }
  }

  private async cleanupOwned(workspace: RemoteVerificationWorkspace): Promise<void> {
    const requestId = this.identifier(workspace.requestId, "Identyfikator zlecenia");
    const root = await this.ensureRoot();
    const target = join(root, requestId);
    if (resolve(workspace.path) !== target) {
      throw new RemoteVerificationWorkspaceError("invalid_input", "Workspace nie należy do katalogu zleceń kontrolera.");
    }
    if (await exists(target)) await rm(target, { recursive: true, force: true });
  }

  private identifier(value: string, label: string): string {
    if (typeof value !== "string" || !IDENTIFIER.test(value.trim())) {
      throw new RemoteVerificationWorkspaceError("invalid_input", `${label} ma nieprawidłowy format.`);
    }
    return value.trim();
  }

  private async canonicalRepository(path: string, input: PrepareRemoteVerificationWorkspaceInput): Promise<string> {
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch {
      throw new RemoteVerificationWorkspaceError("invalid_input", "Skonfigurowana ścieżka projektu nie jest katalogiem głównym repozytorium Git.");
    }
    let topLevel: string;
    try {
      topLevel = (await this.git(["-C", canonical, "rev-parse", "--show-toplevel"], 5_000, "operational", input)).trim();
    } catch (error) {
      if (error instanceof PreparationError) throw error;
      input.preparation?.throwIfAborted();
      throw new RemoteVerificationWorkspaceError("operation_unavailable", "Nie udało się sprawdzić skonfigurowanego repozytorium Git.");
    }
    try {
      if (await realpath(topLevel) !== canonical) throw new Error("not root");
      return canonical;
    } catch {
      throw new RemoteVerificationWorkspaceError("invalid_input", "Skonfigurowana ścieżka projektu nie jest katalogiem głównym repozytorium Git.");
    }
  }

  private async ensureRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new RemoteVerificationWorkspaceError("invalid_input", "Katalog workspace zleceń musi być zwykłym katalogiem.");
    }
    return realpath(this.root);
  }

  private git(args: string[], timeout: number, priority: "operational" | "remote" = "operational", input?: PrepareRemoteVerificationWorkspaceInput): Promise<string> {
    const context = input?.preparation;
    return this.admission.run(priority, (signal) => context ? context.command({
      executable: "git", args, cwd: input!.repositoryPath, environment: input!.environment ?? {},
      signal, timeoutMs: timeout, errorCode: "source_command_failed",
    }) : executeGit(args, signal, timeout), { signal: context?.signal });
  }
}
