import { describe, expect, it } from "vitest";

import { legacyEnvironmentName, readProductEnvironment } from "./product-environment";

describe("readProductEnvironment", () => {
  it("prefers the current name and reads the legacy name with one deprecation warning", () => {
    const messages: string[] = [];
    const warn = (message: string) => messages.push(message);
    expect(readProductEnvironment({ WORKTREE_CONTROL_TOKEN: "new", WORKTREE_SWITCHER_TOKEN: "old" }, "WORKTREE_CONTROL_TOKEN", warn)).toBe("new");
    expect(messages).toEqual([]);
    expect(readProductEnvironment({ WORKTREE_SWITCHER_TOKEN: "old" }, "WORKTREE_CONTROL_TOKEN", warn)).toBe("old");
    expect(readProductEnvironment({ WORKTREE_SWITCHER_TOKEN: "old" }, "WORKTREE_CONTROL_TOKEN", warn)).toBe("old");
    expect(messages).toEqual(["Warning: WORKTREE_SWITCHER_TOKEN is deprecated; set WORKTREE_CONTROL_TOKEN instead."]);
    expect(readProductEnvironment({}, "WORKTREE_CONTROL_TOKEN", warn)).toBeUndefined();
  });

  it("maps only product variables to their legacy names", () => {
    expect(legacyEnvironmentName("WORKTREE_CONTROL_OWNER_TOKEN")).toBe("WORKTREE_SWITCHER_OWNER_TOKEN");
    expect(() => legacyEnvironmentName("PATH")).toThrow();
  });
});
