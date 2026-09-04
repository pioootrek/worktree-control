import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlService } from "./control-service";
import { DirectoryBrowser } from "./directory-browser";
import { EventStream } from "./events";
import { createControllerServer, type ControllerServer } from "./http-server";

const controllers: ControllerServer[] = [];
const directories: string[] = [];

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "worktree-switcher-http-"));
  directories.push(directory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>Switcher</title>");
  const capacity = { enabled: true, limit: 2, used: 0, available: 2, holders: [] };
  const dashboard = vi.fn(async () => ({ projects: [], capacity }));
  const addProject = vi.fn(async () => undefined);
  const setProjectTls = vi.fn(async () => undefined);
  const setProjectEnvironment = vi.fn(() => ({ id: "project-1" }));
  const saveEnvironmentProfile = vi.fn(async () => ({ id: "project-1" }));
  const selectEnvironmentProfile = vi.fn(async () => ({ id: "project-1" }));
  const deleteEnvironmentProfile = vi.fn(() => ({ id: "project-1" }));
  const setServerCapacity = vi.fn(() => capacity);
  const runtimeMetrics = vi.fn(() => ({ projects: [] }));
  const refreshWorktreeStorage = vi.fn(async () => undefined);
  const deleteWorktreeCache = vi.fn(async () => ({ cache: "next" as const, worktreePath: "/code/web-feature", removed: true }));
  const listDirectories = vi.fn(async () => ({
    root: "/home/test",
    current: "/home/test",
    parent: null,
    directories: [{ name: "code", path: "/home/test/code" }],
    files: [],
  }));
  const service = { addProject, dashboard, deleteEnvironmentProfile, deleteWorktreeCache, refreshWorktreeStorage, runtimeMetrics, saveEnvironmentProfile, selectEnvironmentProfile, setProjectEnvironment, setProjectTls, setServerCapacity } as unknown as ControlService;
  const controller = createControllerServer({
    service,
    directoryBrowser: { list: listDirectories } as unknown as DirectoryBrowser,
    events: new EventStream(),
    mcpStatus: () => ({
      phase: "running",
      endpoint: "http://127.0.0.1:47832/mcp",
      transport: "streamable-http",
      network: "loopback",
      authentication: "bearer",
      activeSessions: 2,
    }),
    webRoot: directory,
    host: "0.0.0.0",
    port: 0,
    accessToken: "test-access-token",
  });
  controllers.push(controller);
  await new Promise<void>((resolve, reject) => {
    controller.server.once("error", reject);
    controller.server.listen(0, "127.0.0.1", resolve);
  });
  const address = controller.server.address() as AddressInfo;
  return { addProject, base: `http://127.0.0.1:${address.port}`, dashboard, deleteEnvironmentProfile, deleteWorktreeCache, listDirectories, refreshWorktreeStorage, runtimeMetrics, saveEnvironmentProfile, selectEnvironmentProfile, setProjectEnvironment, setProjectTls, setServerCapacity };
}

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("controller access boundary", () => {
  it("allows the inline bootstrap scripts required by a static Next.js export", async () => {
    const { base } = await fixture();
    const response = await fetch(base);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self' 'unsafe-inline'");
  });

  it("protects dashboard data with the pairing token", async () => {
    const { base, dashboard } = await fixture();
    expect((await fetch(`${base}/api/dashboard`)).status).toBe(401);

    const response = await fetch(`${base}/api/dashboard`, {
      headers: { "X-Worktree-Switcher-Token": "test-access-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projects: [],
      capacity: { enabled: true, limit: 2, used: 0, available: 2, holders: [] },
      mcp: {
        phase: "running",
        endpoint: "http://127.0.0.1:47832/mcp",
        transport: "streamable-http",
        network: "loopback",
        authentication: "bearer",
        activeSessions: 2,
      },
    });
    expect(dashboard).toHaveBeenCalledOnce();
  });

  it("serves lightweight runtime metrics without rediscovering worktrees", async () => {
    const { base, dashboard, runtimeMetrics } = await fixture();
    const response = await fetch(`${base}/api/metrics`, {
      headers: { "X-Worktree-Switcher-Token": "test-access-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: [] });
    expect(runtimeMetrics).toHaveBeenCalledOnce();
    expect(dashboard).not.toHaveBeenCalled();
  });

  it("localizes API errors from Accept-Language", async () => {
    const { base } = await fixture();
    const response = await fetch(`${base}/api/dashboard`, { headers: { "Accept-Language": "en-US" } });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "A valid access token is required." });
  });

  it("keeps conflict status codes when localizing an error", async () => {
    const { addProject, base } = await fixture();
    addProject.mockRejectedValueOnce(new Error("Projekt jest zablokowany przez agent:test."));
    const response = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: {
        "Accept-Language": "en-US",
        "Content-Type": "application/json",
        "X-Worktree-Switcher-Token": "test-access-token",
      },
      body: JSON.stringify({ name: "App", repositoryPath: "/tmp/app", port: 3000 }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "The project is locked by agent:test." });
  });

  it("serves authenticated directory listings through the browser service", async () => {
    const { base, listDirectories } = await fixture();
    const response = await fetch(`${base}/api/directories?path=${encodeURIComponent("/home/test/code")}`, {
      headers: { "X-Worktree-Switcher-Token": "test-access-token" },
    });

    expect(response.status).toBe(200);
    expect((await response.json()).directories).toEqual([{ name: "code", path: "/home/test/code" }]);
    expect(listDirectories).toHaveBeenCalledWith("/home/test/code", false);
  });

  it("rejects authenticated mutations from a different browser origin", async () => {
    const { base } = await fixture();
    const response = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://attacker.invalid",
        "X-Worktree-Switcher-Token": "test-access-token",
      },
      body: JSON.stringify({ name: "App", repositoryPath: "/tmp/app", port: 3000 }),
    });
    expect(response.status).toBe(403);
  });

  it("accepts explicit Next.js TLS settings", async () => {
    const { base, setProjectTls } = await fixture();
    const response = await fetch(`${base}/api/projects/project-1/tls`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Worktree-Switcher-Token": "test-access-token" },
      body: JSON.stringify({ mode: "custom", keyPath: "/certs/key.pem", certPath: "/certs/cert.pem", caPath: null }),
    });
    expect(response.status).toBe(200);
    expect(setProjectTls).toHaveBeenCalledWith("project-1", {
      mode: "custom",
      keyPath: "/certs/key.pem",
      certPath: "/certs/cert.pem",
      caPath: null,
    });
  });

  it("accepts literal project environment overrides", async () => {
    const { base, setProjectEnvironment } = await fixture();
    const environment = { PLAYWRIGHT_E2E: "1", WINPATH_DEV_ROUTE_DELAY_MS: "0" };
    const response = await fetch(`${base}/api/projects/project-1/environment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Worktree-Switcher-Token": "test-access-token" },
      body: JSON.stringify({ environment }),
    });
    expect(response.status).toBe(200);
    expect(setProjectEnvironment).toHaveBeenCalledWith("project-1", environment);
  });

  it("saves, selects, and deletes named environment profiles", async () => {
    const { base, deleteEnvironmentProfile, saveEnvironmentProfile, selectEnvironmentProfile } = await fixture();
    const headers = { "Content-Type": "application/json", "X-Worktree-Switcher-Token": "test-access-token" };
    expect((await fetch(`${base}/api/projects/project-1/environment-profiles`, {
      method: "POST", headers, body: JSON.stringify({ name: "e2e", environment: { PLAYWRIGHT_E2E: "1" }, restart: true }),
    })).status).toBe(200);
    expect(saveEnvironmentProfile).toHaveBeenCalledWith("project-1", "e2e", { PLAYWRIGHT_E2E: "1" }, "local-user", true);
    expect((await fetch(`${base}/api/projects/project-1/environment-profile-selection`, {
      method: "POST", headers, body: JSON.stringify({ name: "e2e", restart: false }),
    })).status).toBe(200);
    expect(selectEnvironmentProfile).toHaveBeenCalledWith("project-1", "e2e", "local-user", false);
    expect((await fetch(`${base}/api/projects/project-1/environment-profiles`, {
      method: "DELETE", headers, body: JSON.stringify({ name: "e2e" }),
    })).status).toBe(200);
    expect(deleteEnvironmentProfile).toHaveBeenCalledWith("project-1", "e2e");
  });

  it("updates the global server capacity", async () => {
    const { base, setServerCapacity } = await fixture();
    const response = await fetch(`${base}/api/settings/capacity`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Worktree-Switcher-Token": "test-access-token" },
      body: JSON.stringify({ enabled: true, limit: 2 }),
    });
    expect(response.status).toBe(200);
    expect(setServerCapacity).toHaveBeenCalledWith({ enabled: true, limit: 2 });
  });

  it("queues a storage refresh for an explicit worktree", async () => {
    const { base, refreshWorktreeStorage } = await fixture();
    const response = await fetch(`${base}/api/projects/project-1/storage/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Worktree-Switcher-Token": "test-access-token" },
      body: JSON.stringify({ worktreePath: "/code/web-feature" }),
    });
    expect(response.status).toBe(202);
    expect(refreshWorktreeStorage).toHaveBeenCalledWith("project-1", "/code/web-feature");
  });

  it("accepts only the allowlisted Next.js cache deletion", async () => {
    const { base, deleteWorktreeCache } = await fixture();
    const response = await fetch(`${base}/api/projects/project-1/storage/cache`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-Worktree-Switcher-Token": "test-access-token" },
      body: JSON.stringify({ worktreePath: "/code/web-feature", cache: "next" }),
    });
    expect(response.status).toBe(200);
    expect(deleteWorktreeCache).toHaveBeenCalledWith("project-1", "/code/web-feature", "next");

    const rejected = await fetch(`${base}/api/projects/project-1/storage/cache`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-Worktree-Switcher-Token": "test-access-token" },
      body: JSON.stringify({ worktreePath: "/code/web-feature", cache: "node_modules" }),
    });
    expect(rejected.status).toBe(400);
    expect(deleteWorktreeCache).toHaveBeenCalledOnce();
  });
});
