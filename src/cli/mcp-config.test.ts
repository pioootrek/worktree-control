import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireControllerLock } from "../server/controller-lock";
import { resolveAppPaths } from "../server/paths";
import { runAuthCommand } from "./auth-management";
import { INSTALLATION_TOKEN_PLACEHOLDER, mcpConfigToken } from "./mcp-config";
import { controllerAccessToken, writeServiceAccess, type ServiceAccessRecord } from "./service-access";

const directories: string[] = [];
function paths() {
  const root = mkdtempSync(join(tmpdir(), "worktree-switcher-mcp-config-"));
  directories.push(root);
  return resolveAppPaths(join(root, "data"), join(root, "state"));
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const record = (overrides: Partial<ServiceAccessRecord> = {}): ServiceAccessRecord => ({
  pid: 4242, startedAt: "2026-09-26T12:00:00.000Z", version: "test", dashboardEndpoint: "http://127.0.0.1:47831",
  mcpEndpoint: "http://127.0.0.1:47832/mcp", accessUrl: "http://127.0.0.1:47831/?session=s#token=pairing", logDirectory: "/logs",
  ...overrides,
});

describe("MCP configuration and controller access tokens", () => {
  it("keeps the legacy mcp-token until token mode is selected, then never prints it", async () => {
    const appPaths = paths();
    const legacy = mcpConfigToken(appPaths, { environment: {} });
    expect(legacy).not.toMatch(/^wsi_/);
    expect(mcpConfigToken(appPaths, { environment: {} })).toBe(legacy);

    const output: string[] = [];
    await runAuthCommand(["token", "generate"], appPaths, { write: (line) => output.push(line) });
    await runAuthCommand(["mode", "set", "token"], appPaths, { write: () => undefined });
    const { token } = JSON.parse(output[0]!) as { token: string };
    expect(mcpConfigToken(appPaths, { environment: {} })).toBe(INSTALLATION_TOKEN_PLACEHOLDER);
    expect(mcpConfigToken(appPaths, { environment: { WORKTREE_SWITCHER_TOKEN: token } })).toBe(token);
  });

  it("reads the mode of a running service from its access record without opening the database", () => {
    const appPaths = paths();
    const lock = acquireControllerLock(appPaths.controllerLockPath);
    try {
      writeServiceAccess(appPaths.serviceAccessPath, record({ authenticationMode: "token" }));
      expect(mcpConfigToken(appPaths, { environment: {}, processExists: () => true })).toBe(INSTALLATION_TOKEN_PLACEHOLDER);
      writeServiceAccess(appPaths.serviceAccessPath, record());
      expect(mcpConfigToken(appPaths, { environment: {}, processExists: () => true })).not.toBe(INSTALLATION_TOKEN_PLACEHOLDER);
    } finally {
      lock.release();
    }
  });

  it("prefers WORKTREE_SWITCHER_TOKEN over the pairing token of the access URL", () => {
    expect(controllerAccessToken(record(), {})).toBe("pairing");
    expect(controllerAccessToken(record(), { WORKTREE_SWITCHER_TOKEN: "wsi_x" })).toBe("wsi_x");
    expect(controllerAccessToken(record({ accessUrl: "http://127.0.0.1:47831/" }), {})).toBeNull();
  });
});
