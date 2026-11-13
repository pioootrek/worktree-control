/**
 * Controller-owned private temporary directory of one locally executed queued
 * run. The concrete filesystem adapter is connected by bootstrap; without one
 * the queue keeps its previous environment behaviour.
 */
export interface RunDirectories {
  /**
   * Creates a new private (0700) directory for one run. Synchronous because it
   * belongs to the admitted phase that commits the running state and spawns.
   */
  create(): string;
  /**
   * Binds a directory returned by `create` to the process group of the run
   * spawned in it (the detached child's pid on POSIX, `null` where there is no
   * group id), so that a later controller start can prove the group stopped
   * before it removes the directory. Writes the ownership record durably.
   * Never throws: a failure is logged, the run continues, and the directory's
   * liveness stays unknown to a later sweep, which then keeps it.
   */
  bind(path: string, processGroupId: number | null): void;
  /**
   * Removes one directory returned by `create`, without following links, after
   * the run's owned process group is confirmed stopped, and then drops its
   * binding. Rejects when removal could not be confirmed; the directory is then
   * left for the startup sweep. A rejection whose `code` is
   * `RUN_DIRECTORY_REMOVAL_DEADLINE` means one attempt exceeded its time bound.
   */
  remove(path: string): Promise<void>;
  /** Removes the root once every owned process group has stopped. Idempotent. */
  close(): Promise<void>;
}

/** Temporary-directory variables the controller always sets for a run, overriding any profile value. */
export const RUN_DIRECTORY_VARIABLES = ["TMPDIR", "TMP", "TEMP"] as const;

/** Stable reason code when a run's directory could not be removed. The process outcome is unchanged. */
export const RUN_DIRECTORY_CLEANUP_FAILED = "run_directory_cleanup_failed";
/** Stable error code when one removal attempt exceeded its deadline; the queue does not retry it. */
export const RUN_DIRECTORY_REMOVAL_DEADLINE = "run_directory_removal_deadline";
/** Stable run error when no private directory could be created; the command is not spawned. */
export const RUN_DIRECTORY_UNAVAILABLE = "run_directory_unavailable";

export function withRunDirectory(environment: Readonly<Record<string, string>>, path: string): Record<string, string> {
  const result: Record<string, string> = { ...environment };
  for (const name of RUN_DIRECTORY_VARIABLES) result[name] = path;
  return result;
}
