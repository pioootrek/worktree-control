import { describe, expect, it } from "vitest";

import { inheritedRuntimeEnvironment } from "./runtime-environment";

describe("inheritedRuntimeEnvironment", () => {
  it("removes NODE_ENV while preserving PATH and unrelated variables", () => {
    expect(inheritedRuntimeEnvironment({
      NODE_ENV: "production",
      PATH: "/opt/project/bin:/usr/bin",
      SWITCHER_TEST_VALUE: "preserved",
    })).toEqual({
      PATH: "/opt/project/bin:/usr/bin",
      SWITCHER_TEST_VALUE: "preserved",
    });
  });

  it("never passes controller credentials under the current or legacy prefix to managed runtimes", () => {
    const sentinel = "sentinel-controller-credential";
    const credentials = [
      "TOKEN", "OWNER_TOKEN", "KNOWLEDGE_TOKEN", "DEV_VAULT_TOKEN", "DEV_VAULT_KEY_FILE",
      "DEV_VAULT_OWNER_PRIVATE_KEY_FILE", "DEV_VAULT_OWNER_PUBLIC_KEY_FILE", "FUTURE_API_SECRET",
    ].flatMap(suffix => [`WORKTREE_CONTROL_${suffix}`, `WORKTREE_SWITCHER_${suffix}`]);
    const inherited = inheritedRuntimeEnvironment({
      ...Object.fromEntries(credentials.map(name => [name, sentinel])),
      WORKTREE_CONTROL_DATA_DIR: "/data",
      DATABASE_URL: "project-owned",
    });
    expect(JSON.stringify(inherited)).not.toContain(sentinel);
    expect(inherited).toEqual({ WORKTREE_CONTROL_DATA_DIR: "/data", DATABASE_URL: "project-owned" });
  });
});
