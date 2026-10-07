import { describe, expect, it } from "vitest";

import { mcpSessionArguments, mcpSessionLimits, parseMcpSessionOptions } from "./mcp-session-options";
import { buildServiceStartArguments } from "./service-install";

describe("MCP session options", () => {
  it("parses explicit limits into controller units and leaves omitted values to the defaults", () => {
    const options = parseMcpSessionOptions(["--port", "47831", "--mcp-claim-renewal-idle-minutes", "20", "--mcp-max-sessions", "96", "--mcp-reconnect-grace-seconds", "90"]);
    expect(mcpSessionLimits(options)).toEqual({ claimRenewalIdleMs: 20 * 60_000, maxSessions: 96, reconnectGraceMs: 90_000 });
    expect(mcpSessionLimits(parseMcpSessionOptions([]))).toEqual({});
  });

  it("rejects invalid, duplicate, inconsistent and misplaced options", () => {
    expect(() => parseMcpSessionOptions(["--mcp-drain-seconds", "0"])).toThrow("integer from 1 to 600");
    expect(() => parseMcpSessionOptions(["--mcp-session-idle-minutes"])).toThrow("integer from 1 to 1440");
    expect(() => parseMcpSessionOptions(["--mcp-max-sessions", "8", "--mcp-max-sessions", "9"])).toThrow("Duplicate");
    expect(() => parseMcpSessionOptions(["--mcp-max-sessions", "8", "--mcp-max-sessions-per-credential", "9"])).toThrow("cannot exceed");
    expect(() => parseMcpSessionOptions(["--mcp-max-sessions", "8"], false)).toThrow("only to start or service install");
  });

  it("writes only explicit values into the service definition", () => {
    const options = parseMcpSessionOptions(["--mcp-open-session-idle-minutes", "90", "--mcp-max-sessions-per-credential", "16"]);
    expect(mcpSessionArguments(options)).toEqual(["--mcp-open-session-idle-minutes", "90", "--mcp-max-sessions-per-credential", "16"]);
    expect(buildServiceStartArguments({
      host: "127.0.0.1", port: 47831, mcpPort: 47832, browseRoot: "/srv/projects", dataDirectory: "/srv/data", stateDirectory: "/srv/state",
      webRoot: "/opt/worktree-control/out", noMcp: false, memoryWarningMiB: null, mcpSessionOptions: options,
    }).slice(-4)).toEqual(["--mcp-open-session-idle-minutes", "90", "--mcp-max-sessions-per-credential", "16"]);
  });
});
