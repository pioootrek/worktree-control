export type StartupCleanupStep = () => void | Promise<void>;

/**
 * Abandons a worker startup that failed before the first poll. At that point the process has
 * admitted no job and owns no process tree, so nothing it holds needs the lock for recovery.
 * Every step runs, newest first, even after one rejects; the lock release is then always
 * attempted. Rejects with the original error when all of that succeeded, otherwise with an
 * `AggregateError` holding the original error first and each cleanup or release failure after it.
 */
export async function abandonWorkerStartup(error: unknown, steps: readonly StartupCleanupStep[], lock: { release(): void }): Promise<never> {
  const failures: unknown[] = [];
  for (const step of [...steps].reverse()) {
    try { await step(); } catch (failure) { failures.push(failure); }
  }
  try { lock.release(); } catch (failure) { failures.push(failure); }
  // The CLI prints only the message, so it names the original failure too.
  if (failures.length) throw new AggregateError([error, ...failures], `${error instanceof Error ? error.message : String(error)}; worker startup cleanup did not complete (${failures.length} failed step${failures.length === 1 ? "" : "s"}).`);
  throw error;
}
