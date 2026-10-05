import { describe, expect, it } from "vitest";

import { readStoredValue, removeStoredValue, storageKey, writeStoredValue } from "./browser-storage";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("browser storage keys", () => {
  it("writes and reads the worktree-control key", () => {
    const storage = memoryStorage();
    writeStoredValue(storage, "theme", "light");
    expect(storage.values.get("worktree-control-theme")).toBe("light");
    expect(readStoredValue(storage, "theme")).toBe("light");
    expect(storageKey("locale")).toBe("worktree-control-locale");
  });

  it("reads a pre-rename key once and moves it to the current key", () => {
    const storage = memoryStorage({ "worktree-switcher-locale": "pl" });
    expect(readStoredValue(storage, "locale")).toBe("pl");
    expect([...storage.values]).toEqual([["worktree-control-locale", "pl"]]);
  });

  it("prefers the current key and leaves an unrelated legacy value untouched", () => {
    const storage = memoryStorage({ "worktree-control-theme": "dark", "worktree-switcher-theme": "light" });
    expect(readStoredValue(storage, "theme")).toBe("dark");
    expect(storage.values.get("worktree-switcher-theme")).toBe("light");
  });

  it("removes both keys", () => {
    const storage = memoryStorage({ "worktree-control-token": "a", "worktree-switcher-token": "b" });
    removeStoredValue(storage, "token");
    expect(storage.values.size).toBe(0);
  });
});
