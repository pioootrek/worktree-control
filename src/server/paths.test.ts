import { describe, expect, it } from "vitest";

import { resolveAppPaths } from "./paths";

const home = "/home/me";

function resolveWith(options: { existing?: string[]; environment?: Record<string, string>; data?: string; state?: string } = {}) {
  const messages: string[] = [];
  const existing = new Set(options.existing ?? []);
  const paths = resolveAppPaths(options.data, options.state, {
    environment: options.environment ?? {},
    homeDirectory: home,
    exists: (path) => existing.has(path),
    warn: (message) => messages.push(message),
  });
  return { paths, messages };
}

describe("resolveAppPaths", () => {
  it("uses worktree-control directories for a fresh installation", () => {
    const { paths, messages } = resolveWith();
    expect(paths.dataDirectory).toBe("/home/me/.local/share/worktree-control");
    expect(paths.databasePath).toBe("/home/me/.local/share/worktree-control/state.sqlite3");
    expect(paths.stateDirectory).toBe("/home/me/.local/state/worktree-control");
    expect(paths.logDirectory).toBe("/home/me/.local/state/worktree-control/logs");
    expect(messages).toEqual([]);
  });

  it("keeps using existing legacy default directories with a notice and never prefers them over new ones", () => {
    const legacy = resolveWith({ existing: ["/home/me/.local/share/worktree-switcher", "/home/me/.local/state/worktree-switcher"] });
    expect(legacy.paths.dataDirectory).toBe("/home/me/.local/share/worktree-switcher");
    expect(legacy.paths.stateDirectory).toBe("/home/me/.local/state/worktree-switcher");
    expect(legacy.messages).toHaveLength(2);
    expect(legacy.messages[0]).toContain("/home/me/.local/share/worktree-switcher");
    expect(legacy.messages[0]).toContain("--data-dir");

    const both = resolveWith({ existing: [
      "/home/me/.local/share/worktree-switcher", "/home/me/.local/share/worktree-control",
      "/home/me/.local/state/worktree-switcher", "/home/me/.local/state/worktree-control",
    ] });
    expect(both.paths.dataDirectory).toBe("/home/me/.local/share/worktree-control");
    expect(both.paths.stateDirectory).toBe("/home/me/.local/state/worktree-control");
    expect(both.messages).toEqual([]);
  });

  it("applies the legacy fallback under XDG base directories", () => {
    const { paths } = resolveWith({
      environment: { XDG_DATA_HOME: "/xdg/data", XDG_STATE_HOME: "/xdg/state" },
      existing: ["/xdg/data/worktree-switcher"],
    });
    expect(paths.dataDirectory).toBe("/xdg/data/worktree-switcher");
    expect(paths.stateDirectory).toBe("/xdg/state/worktree-control");
  });

  it("uses explicit directories exactly as before, ignoring environment and legacy directories", () => {
    const { paths, messages } = resolveWith({
      data: "/srv/data",
      state: "/srv/state",
      environment: { WORKTREE_CONTROL_DATA_DIR: "/env/data", WORKTREE_SWITCHER_STATE_DIR: "/legacy/state" },
      existing: ["/home/me/.local/share/worktree-switcher", "/home/me/.local/state/worktree-switcher"],
    });
    expect(paths.dataDirectory).toBe("/srv/data");
    expect(paths.stateDirectory).toBe("/srv/state");
    expect(messages).toEqual([]);
    expect(resolveWith({ data: "/srv/data" }).paths.stateDirectory).toBe("/srv/data/state");
  });

  it("prefers WORKTREE_CONTROL_* over WORKTREE_SWITCHER_* and warns when only the legacy variable is set", () => {
    const current = resolveWith({ environment: {
      WORKTREE_CONTROL_DATA_DIR: "/new/data", WORKTREE_SWITCHER_DATA_DIR: "/old/data",
      WORKTREE_CONTROL_STATE_DIR: "/new/state", WORKTREE_SWITCHER_STATE_DIR: "/old/state",
    } });
    expect(current.paths.dataDirectory).toBe("/new/data");
    expect(current.paths.stateDirectory).toBe("/new/state");
    expect(current.messages).toEqual([]);

    const legacy = resolveWith({ environment: { WORKTREE_SWITCHER_DATA_DIR: "/old/data", WORKTREE_SWITCHER_STATE_DIR: "/old/state" } });
    expect(legacy.paths.dataDirectory).toBe("/old/data");
    expect(legacy.paths.stateDirectory).toBe("/old/state");
    expect(legacy.messages).toEqual([
      "Warning: WORKTREE_SWITCHER_DATA_DIR is deprecated; set WORKTREE_CONTROL_DATA_DIR instead.",
      "Warning: WORKTREE_SWITCHER_STATE_DIR is deprecated; set WORKTREE_CONTROL_STATE_DIR instead.",
    ]);
  });

  it("lets an environment data directory override the default while state keeps its own default", () => {
    const { paths } = resolveWith({ environment: { WORKTREE_CONTROL_DATA_DIR: "/env/data" } });
    expect(paths.dataDirectory).toBe("/env/data");
    expect(paths.stateDirectory).toBe("/home/me/.local/state/worktree-control");
  });
});
