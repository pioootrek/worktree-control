/** Browser storage key prefix. */
const KEY_PREFIX = "worktree-control-";
/** Pre-rename prefix; values stored under it are read once and moved to the current key. */
const LEGACY_KEY_PREFIX = "worktree-switcher-";

type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function storageKey(name: string): string {
  return KEY_PREFIX + name;
}

/**
 * Reads `worktree-control-<name>`. When it is absent, a value saved by an older version under
 * `worktree-switcher-<name>` is returned and moved to the current key.
 */
export function readStoredValue(storage: KeyValueStorage, name: string): string | null {
  const current = storage.getItem(storageKey(name));
  if (current !== null) return current;
  const legacyKey = LEGACY_KEY_PREFIX + name;
  const legacy = storage.getItem(legacyKey);
  if (legacy === null) return null;
  try {
    storage.setItem(storageKey(name), legacy);
    storage.removeItem(legacyKey);
  } catch {
    // Storage may be full or blocked; the value is still usable for this read.
  }
  return legacy;
}

export function writeStoredValue(storage: KeyValueStorage, name: string, value: string): void {
  storage.setItem(storageKey(name), value);
}

/** Removes the value under both the current and the pre-rename key. */
export function removeStoredValue(storage: KeyValueStorage, name: string): void {
  storage.removeItem(storageKey(name));
  storage.removeItem(LEGACY_KEY_PREFIX + name);
}
