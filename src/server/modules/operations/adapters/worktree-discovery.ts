import { GitCommandCapacityError } from "@/server/git-worktrees";
import { OperationError } from "../errors";
import type { RepositoryDiscovery, WorktreeDiscoveryPort, WorktreeFact } from "../project-reads";

/**
 * The two reads of the controller's Git reader (`SystemGitWorktreeReader`)
 * that discovery needs, run through its one Git command admission. A signal
 * leaves the admission queue or stops the running Git process.
 */
export interface WorktreeGit {
  /** `git worktree list`, parsed: no status read per tree. */
  listTrees(repositoryPath: string, options: { signal: AbortSignal }): Promise<ReadonlyArray<unknown>>;
  /** `git status` of one worktree; rejects when Git cannot answer. */
  worktreeDirty(worktreePath: string, options: { signal: AbortSignal }): Promise<boolean>;
}

export interface WorktreeDiscoveryLimits {
  /** Distinct repository listings in flight; a call needing more is `busy`/`discovery_capacity`. */
  maxRepositories: number;
  /** Distinct status reads in flight; a call needing more is `busy`/`discovery_capacity`. */
  maxStatuses: number;
  /** Trees kept from one listing; any one call uses at most its budget of them. */
  maxTrees: number;
}
export const WORKTREE_DISCOVERY_LIMITS: Readonly<WorktreeDiscoveryLimits> = Object.freeze({ maxRepositories: 16, maxStatuses: 64, maxTrees: 64 });

interface Listing { trees: readonly WorktreeFact[]; truncated: boolean }
interface Shared<T> { promise: Promise<T>; controller: AbortController; waiters: number }

const cancelled = () => new OperationError("unavailable", "request_cancelled", { retry: "retry" });
const capacity = () => new OperationError("busy", "discovery_capacity", { retry: "retry" });
const isCapacity = (error: unknown) => error instanceof GitCommandCapacityError || (error instanceof OperationError && error.category === "busy");
const settle = <T>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

/**
 * Bounded, coalesced discovery for `project.worktrees`. One call discovers the
 * repositories of one project in order, with one budget of status reads for
 * all of them:
 *
 * 1. Every repository is listed (`git worktree list`), with no status read.
 * 2. The budget is assigned in the caller's order: the first repository's
 *    trees first, until the budget is spent. Trees past it are never read;
 *    their repository reports `truncated`.
 * 3. Only the assigned trees get a `git status`, so a call with many
 *    registrations or trees schedules at most its budget of status reads.
 *
 * Concurrent calls share a listing of one repository and a status read of one
 * worktree while it is in flight; nothing is cached after it settles, so every
 * call discovers again. A caller that leaves detaches only itself. When the
 * last caller of a shared read leaves before it settles, that read is aborted:
 * Git admission drops it from its queue or stops its process. Distinct reads
 * in flight are bounded; a call that would exceed a bound starts nothing new
 * and is refused as `busy`/`discovery_capacity` with retry, as is a call whose
 * Git command admission is full. A tree whose status Git could not read is
 * released with `dirty: null` and makes its repository `partial`; a
 * repository whose listing failed is `unavailable`. Shared results are frozen
 * copies, so one caller cannot change what another receives.
 */
export class CoalescingWorktreeDiscovery implements WorktreeDiscoveryPort {
  readonly #listings = new Map<string, Shared<Listing>>();
  readonly #statuses = new Map<string, Shared<boolean>>();
  readonly #limits: WorktreeDiscoveryLimits;

  constructor(private readonly git: WorktreeGit, limits: Partial<WorktreeDiscoveryLimits> = {}) {
    if (typeof git?.listTrees !== "function" || typeof git.worktreeDirty !== "function") throw new TypeError("Invalid worktree reader.");
    this.#limits = { ...WORKTREE_DISCOVERY_LIMITS, ...limits };
  }

  /** Distinct repository listings in flight. */
  get inFlight(): number { return this.#listings.size; }
  /** Distinct status reads in flight. */
  get statusesInFlight(): number { return this.#statuses.size; }

  async discover(repositoryPaths: readonly string[], budget: number, signal: AbortSignal): Promise<RepositoryDiscovery[]> {
    if (!Number.isSafeInteger(budget) || budget < 0 || !Array.isArray(repositoryPaths) || !repositoryPaths.every(path => typeof path === "string")) {
      throw new OperationError("internal", "invalid_discovery");
    }
    if (signal.aborted) throw cancelled();
    const repositories = [...new Set(repositoryPaths)];
    if (this.#listings.size + repositories.filter(path => !this.#listings.has(path)).length > this.#limits.maxRepositories) throw capacity();
    const maxTrees = this.#limits.maxTrees;
    const listed = new Map(await Promise.all(repositories.map(async path => [path, await settle(this.#join(this.#listings, path, async shared => {
      const found = await this.git.listTrees(path, { signal: shared });
      if (!Array.isArray(found)) throw new Error("Malformed worktree listing.");
      const trees = found.slice(0, maxTrees).map(tree => {
        if (typeof tree !== "object" || tree === null || typeof (tree as { path?: unknown }).path !== "string") throw new Error("Malformed worktree.");
        return Object.freeze({ ...(tree as object) }) as WorktreeFact;
      });
      return Object.freeze({ trees: Object.freeze(trees), truncated: found.length > maxTrees });
    }, signal))] as const)));
    this.#refuse(signal, [...listed.values()]);

    // The budget, in the caller's order, before any status read is scheduled.
    let remaining = budget;
    const assigned = repositoryPaths.map(path => {
      const listing = listed.get(path)!;
      if (!listing.ok) return null;
      const trees = listing.value.trees.slice(0, remaining);
      remaining -= trees.length;
      return { trees, truncated: listing.value.truncated || trees.length < listing.value.trees.length };
    });
    const paths = [...new Set(assigned.flatMap(entry => entry ? entry.trees.map(tree => tree.path as string) : []))];
    if (this.#statuses.size + paths.filter(path => !this.#statuses.has(path)).length > this.#limits.maxStatuses) throw capacity();
    const statuses = new Map(await Promise.all(paths.map(async path =>
      [path, await settle(this.#join(this.#statuses, path, shared => this.git.worktreeDirty(path, { signal: shared }), signal))] as const)));
    this.#refuse(signal, [...statuses.values()]);

    return assigned.map((entry): RepositoryDiscovery => {
      if (!entry) return { state: "unavailable" };
      let complete = true;
      const worktrees = entry.trees.map(tree => {
        const status = statuses.get(tree.path as string)!;
        const dirty = status.ok && typeof status.value === "boolean" ? status.value : null;
        if (dirty === null) complete = false;
        return Object.freeze({ ...tree, dirty });
      });
      return { state: complete ? "complete" : "partial", worktrees, truncated: entry.truncated };
    });
  }

  /** A cancelled caller, or any read refused for capacity, fails the whole call: it is never reported as a Git failure. */
  #refuse(signal: AbortSignal, outcomes: ReadonlyArray<{ ok: boolean; error?: unknown }>): void {
    if (signal.aborted) throw cancelled();
    if (outcomes.some(outcome => !outcome.ok && isCapacity(outcome.error))) throw capacity();
  }

  /** Joins the shared read of `key`, starting it when none is in flight. Aborts it when its last caller leaves before it settles. */
  #join<T>(map: Map<string, Shared<T>>, key: string, start: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    let entry = map.get(key);
    if (!entry) {
      const controller = new AbortController();
      let promise: Promise<T>;
      try { promise = Promise.resolve(start(controller.signal)); } catch (error) { promise = Promise.reject(error); }
      const created: Shared<T> = { promise, controller, waiters: 0 };
      // The shared promise must never become an unhandled rejection when every caller left.
      promise.then(() => undefined, () => undefined).finally(() => { if (map.get(key) === created) map.delete(key); });
      map.set(key, created);
      entry = created;
    }
    const shared = entry;
    shared.waiters += 1;
    return new Promise<T>((resolve, reject) => {
      let left = false;
      const leave = () => { if (left) return false; left = true; signal.removeEventListener("abort", abort); shared.waiters -= 1; return true; };
      const abort = () => {
        if (!leave()) return;
        if (shared.waiters === 0 && map.get(key) === shared) { map.delete(key); shared.controller.abort(); }
        reject(cancelled());
      };
      signal.addEventListener("abort", abort, { once: true });
      shared.promise.then(value => { if (leave()) resolve(value); }, error => { if (leave()) reject(error); });
    });
  }
}
