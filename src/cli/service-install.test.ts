import { describe, expect, it } from "vitest";

import { buildServiceStartArguments } from "./service-install";

describe("service install arguments", () => {
  it("carries the canonical public origin into the installed controller command", () => {
    expect(buildServiceStartArguments({
      host: "127.0.0.1",
      port: 47831,
      mcpPort: 47832,
      browseRoot: "/srv/projects",
      dataDirectory: "/srv/data",
      stateDirectory: "/srv/state",
      webRoot: "/opt/worktree-control/out",
      noMcp: false,
      memoryWarningMiB: null,
      publicOrigin: "https://switcher.example.test",
    })).toEqual([
      "--service-mode", "--no-open",
      "--host", "127.0.0.1",
      "--port", "47831",
      "--mcp-port", "47832",
      "--browse-root", "/srv/projects",
      "--data-dir", "/srv/data",
      "--state-dir", "/srv/state",
      "--web-root", "/opt/worktree-control/out",
      "--public-url", "https://switcher.example.test",
    ]);
  });
});
