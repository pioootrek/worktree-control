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
  it("never prints the legacy mcp-token for a new token-mode installation", async () => {
    const appPaths = paths();
    expect(await mcpConfigToken(appPaths, { environment: {} })).toBe(INSTALLATION_TOKEN_PLACEHOLDER);

    const output: string[] = [];
    await runAuthCommand(["token", "generate"], appPaths, { write: (line) => output.push(line) });
    const { token } = JSON.parse(output[0]!) as { token: string };
    expect(await mcpConfigToken(appPaths, { environment: {} })).toBe(INSTALLATION_TOKEN_PLACEHOLDER);
    expect(await mcpConfigToken(appPaths, { environment: { WORKTREE_SWITCHER_TOKEN: token } })).toBe(token);

    await runAuthCommand(["mode", "set", "open"], appPaths, { write: () => undefined });
    expect(await mcpConfigToken(appPaths, { environment: {} })).toBeNull();
  });

  it("reads the mode of a running service from its access record without opening the database", async () => {
    const appPaths = paths();
    const lock = acquireControllerLock(appPaths.controllerLockPath);
    try {
      writeServiceAccess(appPaths.serviceAccessPath, record({ authenticationMode: "token" }));
      expect(await mcpConfigToken(appPaths, { environment: {}, processExists: () => true })).toBe(INSTALLATION_TOKEN_PLACEHOLDER);
      writeServiceAccess(appPaths.serviceAccessPath, record());
      expect(await mcpConfigToken(appPaths, { environment: {}, processExists: () => true })).not.toBe(INSTALLATION_TOKEN_PLACEHOLDER);
    } finally {
      lock.release();
    }
  });

  it("asks a foreground controller's admin socket instead of guessing the legacy token", async () => {
    const appPaths = paths();
    const lock = acquireControllerLock(appPaths.controllerLockPath);
    try {
      const status = (mode: string) => ({ environment: {}, requestStatus: async () => ({ mode, token: null, generation: 1 }) });
      expect(await mcpConfigToken(appPaths, status("token"))).toBe(INSTALLATION_TOKEN_PLACEHOLDER);
      expect(await mcpConfigToken(appPaths, status("open"))).toBeNull();
      expect(await mcpConfigToken(appPaths, status("legacy"))).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await expect(mcpConfigToken(appPaths, { environment: {}, requestStatus: async () => { throw new Error("ENOENT"); } }))
        .rejects.toThrow("MCP credential is unknown");
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
