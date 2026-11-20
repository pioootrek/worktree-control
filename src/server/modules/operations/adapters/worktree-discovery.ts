import { OperationError } from "../errors";
import type { WorktreeDiscoveryPort, WorktreeFact } from "../project-reads";

/** Structural Git reader: the controller's `GitWorktreeReader.list`. */
export interface WorktreeLister {
  list(repositoryPath: string): Promise<ReadonlyArray<unknown>>;
}

export interface WorktreeDiscoveryLimits {
  /** Distinct repositories discovered at once; another is `busy`/`discovery_capacity` with retry. */
  maxInFlight: number;
  /** Trees kept per repository; more set `truncated`. */
  maxTrees: number;
}
export const WORKTREE_DISCOVERY_LIMITS: Readonly<WorktreeDiscoveryLimits> = Object.freeze({ maxInFlight: 16, maxTrees: 64 });

/**
 * Bounded, coalesced discovery for `project.worktrees`. Concurrent callers of
 * one repository share a single Git listing that is in flight; nothing is
 * cached after it settles, so every call after that discovers again (the
 * operation has no refresh). A caller's abort detaches only that caller: the
 * shared listing keeps running for the others and is bounded by the Git
 * reader's own timeouts and process admission. Distinct repositories in
 * flight are bounded. Results are copied, bounded and frozen before sharing,
 * so one caller cannot change what another receives.
 */
export class CoalescingWorktreeDiscovery implements WorktreeDiscoveryPort {
  readonly #inFlight = new Map<string, Promise<{ worktrees: readonly WorktreeFact[]; truncated: boolean }>>();
  readonly #limits: WorktreeDiscoveryLimits;

  constructor(private readonly git: WorktreeLister, limits: Partial<WorktreeDiscoveryLimits> = {}) {
    if (typeof git?.list !== "function") throw new TypeError("Invalid worktree lister.");
    this.#limits = { ...WORKTREE_DISCOVERY_LIMITS, ...limits };
  }

  /** Distinct repositories currently being discovered. */
  get inFlight(): number { return this.#inFlight.size; }

  discover(repositoryPath: string, signal: AbortSignal): Promise<{ worktrees: readonly WorktreeFact[]; truncated: boolean }> {
    if (signal.aborted) return Promise.reject(new OperationError("unavailable", "request_cancelled", { retry: "retry" }));
    let shared = this.#inFlight.get(repositoryPath);
    if (!shared) {
      if (this.#inFlight.size >= this.#limits.maxInFlight) return Promise.reject(new OperationError("busy", "discovery_capacity"));
      const maxTrees = this.#limits.maxTrees;
      let listing: Promise<ReadonlyArray<unknown>>;
      try { listing = Promise.resolve(this.git.list(repositoryPath)); } catch (error) { listing = Promise.reject(error); }
      shared = listing.then(found => {
        if (!Array.isArray(found)) throw new Error("Malformed worktree listing.");
        const worktrees = found.slice(0, maxTrees).map(tree => Object.freeze({ ...(tree as object) }) as WorktreeFact);
        return Object.freeze({ worktrees: Object.freeze(worktrees), truncated: found.length > maxTrees });
      }).finally(() => { this.#inFlight.delete(repositoryPath); });
      // The shared promise must never become an unhandled rejection when every caller left.
      shared.catch(() => undefined);
      this.#inFlight.set(repositoryPath, shared);
    }
    const settled = shared;
    return new Promise((resolve, reject) => {
      const abort = () => reject(new OperationError("unavailable", "request_cancelled", { retry: "retry" }));
      signal.addEventListener("abort", abort, { once: true });
      settled.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
}
