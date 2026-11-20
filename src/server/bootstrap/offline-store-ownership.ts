import type { ControllerLock } from "../controller-lock";
import type { SqliteStateStore } from "../sqlite-store";

/** Release only after accepted database work drained and the store closed successfully.
 * Callers dispose their other producers first and retain their owner on failure.
 */
export async function closeOfflineStore(store: Pick<SqliteStateStore, "closeAfterDrain"> | null, lock: Pick<ControllerLock, "release">): Promise<void> {
  await store?.closeAfterDrain();
  lock.release();
}
