import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlService } from "./control-service";
import { DirectoryBrowser } from "./directory-browser";
import { EventStream } from "./events";
import { createControllerServer, type ControllerServer } from "./http-server";
import { IdentityError, type IdentityService } from "./modules/identity";

const controllers: ControllerServer[] = [];
const directories: string[] = [];

async function fixture(options: {
  publicOrigin?: string;
  identity?: IdentityService;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "worktree-control-http-"));
  directories.push(directory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>Switcher</title>");
  const capacity = { enabled: true, limit: 2, used: 0, available: 2, holders: [] };
  const testQueue = { limit: 1, running: 0, queued: 0 };
  const dashboard = vi.fn(async () => ({ projects: [], capacity, testQueue }));
  const dashboardLive = vi.fn(() => ({ projects: [], capacity, testQueue }));
  const refreshProjectMetadata = vi.fn(async () => ({
    project: { id: "project-1" }, runtime: { error: null }, reservation: null,
    worktrees: [], storage: [], testPresets: [], testRuns: [],
  }));
  const addProject = vi.fn(async () => ({ id: "project-1" }));
  const removeProject = vi.fn(async () => ({ id: "project-1", name: "App" }));
  const setProjectTls = vi.fn(async () => undefined);
  const setProjectEnvironment = vi.fn(() => ({ id: "project-1" }));
  const saveEnvironmentProfile = vi.fn(async () => ({ id: "project-1" }));
  const selectEnvironmentProfile = vi.fn(async () => ({ id: "project-1" }));
  const deleteEnvironmentProfile = vi.fn(() => ({ id: "project-1" }));
  const testEnvironmentProfiles = vi.fn(() => ({ profiles: [], presetProfiles: {}, systemVariableNames: ["PATH"] }));
  const redactedTestProject = {
    id: "project-1",
    testEnvironmentProfiles: [{ name: "e2e", variableNames: ["E2E_RESET_DB_CONFIRM"] }],
  };
  const saveTestEnvironmentProfile = vi.fn(async () => redactedTestProject);
  const deleteTestEnvironmentProfile = vi.fn(async () => redactedTestProject);
  const assignTestPresetProfile = vi.fn(async () => redactedTestProject);
  const setServerCapacity = vi.fn(() => capacity);
  const setTestQueueLimit = vi.fn(() => testQueue);
  const enqueueTest = vi.fn(async () => ({ id: "run-1", phase: "queued" }));
  const cancelTest = vi.fn(async () => ({ id: "run-1", phase: "cancelled" }));
  const testRun = vi.fn(() => ({ id: "run-1", phase: "running" }));
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
  const service = { addProject, assignTestPresetProfile, cancelTest, dashboard, dashboardLive, deleteEnvironmentProfile, deleteTestEnvironmentProfile, saveTestEnvironmentProfile, testEnvironmentProfiles, deleteWorktreeCache, enqueueTest, refreshProjectMetadata, refreshWorktreeStorage, removeProject, runtimeMetrics, saveEnvironmentProfile, selectEnvironmentProfile, setProjectEnvironment, setProjectTls, setServerCapacity, setTestQueueLimit, testRun } as unknown as ControlService;
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
    publicOrigin: options.publicOrigin,
    identity: options.identity,
  });
  controllers.push(controller);
  await new Promise<void>((resolve, reject) => {
    controller.server.once("error", reject);
    controller.server.listen(0, "127.0.0.1", resolve);
  });
  const address = controller.server.address() as AddressInfo;
  return { addProject, assignTestPresetProfile, base: `http://127.0.0.1:${address.port}`, cancelTest, deleteTestEnvironmentProfile, saveTestEnvironmentProfile, testEnvironmentProfiles, dashboard, dashboardLive, deleteEnvironmentProfile, deleteWorktreeCache, enqueueTest, listDirectories, refreshProjectMetadata, refreshWorktreeStorage, removeProject, runtimeMetrics, saveEnvironmentProfile, selectEnvironmentProfile, setProjectEnvironment, setProjectTls, setServerCapacity, setTestQueueLimit, testRun };
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
      headers: { "X-Worktree-Control-Token": "test-access-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projects: [],
      capacity: { enabled: true, limit: 2, used: 0, available: 2, holders: [] },
      testQueue: { limit: 1, running: 0, queued: 0 },
      mcp: {
        phase: "running",
        endpoint: "http://127.0.0.1:47832/mcp",
        transport: "streamable-http",
        network: "loopback",
        authentication: "bearer",
        activeSessions: 2,
      },
      authentication: { mode: "legacy", listen: "0.0.0.0:0" },
    });
    expect(dashboard).toHaveBeenCalledOnce();
  });

  it("accepts the pre-rename token header during the transition and prefers the current one", async () => {
    const { base } = await fixture();
    expect((await fetch(`${base}/api/dashboard`, { headers: { "X-Worktree-Switcher-Token": "test-access-token" } })).status).toBe(200);
    expect((await fetch(`${base}/api/dashboard`, { headers: { "X-Worktree-Switcher-Token": "wrong-token" } })).status).toBe(401);
    expect((await fetch(`${base}/api/dashboard`, {
      headers: { "X-Worktree-Control-Token": "wrong-token", "X-Worktree-Switcher-Token": "test-access-token" },
    })).status).toBe(401);
  });

  it("exposes scoped identity without granting access to runtime APIs", async () => {
    let active = true;
    const actor = {
      principalId: "agent-1",
      principalKind: "agent" as const,
      credentialId: "credential-1",
      authenticationMethod: "agent_token" as const,
    };
    const identity = {
      authenticateBearer: vi.fn((token: string) => {
        if (!active || token !== "scoped-token") throw new Error("invalid credential");
        return actor;
      }),
      describeIdentity: vi.fn(() => ({
        principal: { id: "agent-1", kind: "agent" as const, status: "active" as const },
        credential: {
          id: "credential-1", principalId: "agent-1", kind: "agent_token" as const,
          label: "Codex", tokenPrefix: "wts_credential", status: "active" as const,
          expiresAt: null, createdAt: "2026-09-13T12:00:00.000Z", revokedAt: null, lastUsedAt: null,
        },
        knowledgeGrants: [{ projectId: "knowledge-a", permissions: ["knowledge:read" as const] }],
      })),
    };
    const { base, dashboard } = await fixture({ identity: identity as unknown as IdentityService });

    const response = await fetch(`${base}/api/identity`, {
      headers: { Authorization: "Bearer scoped-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      principal: { id: "agent-1", kind: "agent" },
      knowledgeGrants: [{ projectId: "knowledge-a", permissions: ["knowledge:read"] }],
    });
    expect((await fetch(`${base}/api/dashboard`, {
      headers: { Authorization: "Bearer scoped-token" },
    })).status).toBe(401);
    expect((await fetch(`${base}/api/identity`, {
      headers: { "X-Worktree-Control-Token": "test-access-token" },
    })).status).toBe(401);
    active = false;
    expect((await fetch(`${base}/api/identity`, {
      headers: { Authorization: "Bearer scoped-token" },
    })).status).toBe(401);
    expect(dashboard).not.toHaveBeenCalled();
  });

  it("executes owner-authorized identity revocation through the running controller", async () => {
    const actor = {
      principalId: "owner-1", principalKind: "owner" as const,
      credentialId: "owner-session", authenticationMethod: "owner_session" as const,
    };
    const revokeCredential = vi.fn();
    const identity = {
      authenticateBearer: vi.fn((token: string) => {
        if (token !== "owner-token") throw new Error("invalid credential");
        return actor;
      }),
      revokeCredential,
    } as unknown as IdentityService;
    const { base } = await fixture({ identity });

    const response = await fetch(`${base}/api/identity/admin`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "revoke-token", credentialId: "agent-token" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });
    expect(revokeCredential).toHaveBeenCalledWith("agent-token", actor);
  });

  it("bootstraps the first owner through authenticated controller access", async () => {
    const bootstrapOwnerSession = vi.fn(() => ({ principalId: "owner-1", token: "owner-token" }));
    const { base } = await fixture({ identity: { bootstrapOwnerSession } as unknown as IdentityService });

    expect((await fetch(`${base}/api/identity/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })).status).toBe(401);
    const response = await fetch(`${base}/api/identity/bootstrap`, {
      method: "POST",
      headers: { "X-Worktree-Control-Token": "test-access-token", "Content-Type": "application/json" },
      body: JSON.stringify({ label: "First owner", sessionLifetimeSeconds: 300 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ principalId: "owner-1", token: "owner-token" });
    expect(bootstrapOwnerSession).toHaveBeenCalledWith({ label: "First owner", sessionLifetimeSeconds: 300 });
  });

  it("reports a repeated owner bootstrap as a conflict", async () => {
    const bootstrapOwnerSession = vi.fn(() => {
      throw new IdentityError("owner_already_initialized", "Właściciel został już zainicjalizowany.");
    });
    const { base } = await fixture({ identity: { bootstrapOwnerSession } as unknown as IdentityService });

    const response = await fetch(`${base}/api/identity/bootstrap`, {
      method: "POST",
      headers: { "Accept-Language": "en", "X-Worktree-Control-Token": "test-access-token", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "owner_already_initialized",
      error: "The owner has already been initialized.",
    });
  });

  it("requires the event token in a header and rejects cross-origin event reads", async () => {
    const { base } = await fixture({ publicOrigin: "https://switcher.example.test" });
    expect((await fetch(`${base}/api/events?token=test-access-token`)).status).toBe(401);
    expect((await fetch(`${base}/api/dashboard`, {
      headers: {
        Origin: "https://attacker.invalid",
        "X-Worktree-Control-Token": "test-access-token",
      },
    })).status).toBe(403);
    expect((await fetch(`${base}/api/events`, {
      headers: {
        Origin: "https://attacker.invalid",
        "X-Worktree-Control-Token": "test-access-token",
      },
    })).status).toBe(403);
    expect((await fetch(`${base}/api/events`, {
      headers: {
        Origin: "null",
        "X-Worktree-Control-Token": "test-access-token",
      },
    })).status).toBe(403);

    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, {
      headers: {
        Origin: "https://switcher.example.test",
        "X-Worktree-Control-Token": "test-access-token",
      },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    controller.abort();
  });

  it("serves lightweight runtime metrics without rediscovering worktrees", async () => {
    const { base, dashboard, runtimeMetrics } = await fixture();
    const response = await fetch(`${base}/api/metrics`, {
      headers: { "X-Worktree-Control-Token": "test-access-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: [] });
    expect(runtimeMetrics).toHaveBeenCalledOnce();
    expect(dashboard).not.toHaveBeenCalled();
  });

  it("serves bounded authenticated live sections without invoking the full dashboard", async () => {
    const { base, dashboard, dashboardLive } = await fixture();
    const response = await fetch(`${base}/api/dashboard/live?project=project-1&section=runtime&section=controller`, {
      headers: { "X-Worktree-Control-Token": "test-access-token" },
    });
    expect(response.status).toBe(200);
    expect(dashboardLive).toHaveBeenCalledWith(["project-1"], ["runtime", "controller"]);
    expect(dashboard).not.toHaveBeenCalled();
    expect((await response.json()).version).toMatchObject({ revision: 0 });

    const invalid = await fetch(`${base}/api/dashboard/live?section=metadata`, {
      headers: { "X-Worktree-Control-Token": "test-access-token" },
    });
    expect(invalid.status).toBe(400);
  });

  it("validates and authorizes explicit metadata refresh", async () => {
    const { base, refreshProjectMetadata } = await fixture();
    expect((await fetch(`${base}/api/projects/project-1/metadata/refresh`, { method: "POST", body: "{}" })).status).toBe(401);
    const foreign = await fetch(`${base}/api/projects/project-1/metadata/refresh`, {
      method: "POST",
      headers: { Origin: "http://attacker.invalid", "Content-Type": "application/json", "X-Worktree-Control-Token": "test-access-token" },
      body: "{}",
    });
    expect(foreign.status).toBe(403);
    const response = await fetch(`${base}/api/projects/project-1/metadata/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Worktree-Control-Token": "test-access-token" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(refreshProjectMetadata).toHaveBeenCalledWith("project-1");
  });

  it("authorizes the configured HTTPS origin without trusting Host or forwarding headers", async () => {
    const { base, refreshProjectMetadata } = await fixture({ publicOrigin: "https://switcher.example.test" });
    const accepted = await fetch(`${base}/api/projects/project-1/metadata/refresh`, {
      method: "POST",
      headers: {
        Origin: "https://switcher.example.test",
        Host: "forged.example.test",
        "Forwarded": "host=forged.example.test;proto=https",
        "X-Forwarded-Host": "forged.example.test",
        "X-Forwarded-Proto": "https",
        "Content-Type": "application/json",
        "X-Worktree-Control-Token": "test-access-token",
      },
      body: "{}",
    });
    expect(accepted.status).toBe(200);
    expect(refreshProjectMetadata).toHaveBeenCalledOnce();

    const rejected = await fetch(`${base}/api/projects/project-1/metadata/refresh`, {
      method: "POST",
      headers: {
        Origin: "https://attacker.invalid",
        Host: "switcher.example.test",
        "X-Forwarded-Host": "switcher.example.test",
        "X-Forwarded-Proto": "https",
        "Content-Type": "application/json",
        "X-Worktree-Control-Token": "test-access-token",
      },
      body: "{}",
    });
    expect(rejected.status).toBe(403);
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
        "X-Worktree-Control-Token": "test-access-token",
      },
      body: JSON.stringify({ name: "App", repositoryPath: "/tmp/app", port: 3000 }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "The project is locked by agent:test." });
  });

  it("accepts an explicit Django launch preset", async () => {
    const { addProject, base } = await fixture();
    const response = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Worktree-Control-Token": "test-access-token" },
      body: JSON.stringify({ name: "API", repositoryPath: "/tmp/api", port: 8000, launchPreset: "django" }),
    });
    expect(response.status).toBe(201);
    expect(addProject).toHaveBeenCalledWith({ name: "API", repositoryPath: "/tmp/api", port: 8000, launchPreset: "django" });
  });

  it("removes a project through the authenticated controller API", async () => {
    const { base, removeProject } = await fixture();
    const response = await fetch(`${base}/api/projects/project-1`, {
      method: "DELETE",
      headers: { "X-Worktree-Control-Token": "test-access-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ project: { id: "project-1", name: "App" } });
    expect(removeProject).toHaveBeenCalledWith("project-1");
  });

  it("serves authenticated directory listings through the browser service", async () => {
    const { base, listDirectories } = await fixture();
    const response = await fetch(`${base}/api/directories?path=${encodeURIComponent("/home/test/code")}`, {
      headers: { "X-Worktree-Control-Token": "test-access-token" },
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
        "X-Worktree-Control-Token": "test-access-token",
      },
      body: JSON.stringify({ name: "App", repositoryPath: "/tmp/app", port: 3000 }),
    });
    expect(response.status).toBe(403);
  });

  it("accepts explicit Next.js TLS settings", async () => {
    const { base, setProjectTls } = await fixture();
    const response = await fetch(`${base}/api/projects/project-1/tls`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Worktree-Control-Token": "test-access-token" },
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
      headers: { "Content-Type": "application/json", "X-Worktree-Control-Token": "test-access-token" },
      body: JSON.stringify({ environment }),
    });
    expect(response.status).toBe(200);
    expect(setProjectEnvironment).toHaveBeenCalledWith("project-1", environment);
  });

  it("saves, selects, and deletes named environment profiles", async () => {
    const { base, deleteEnvironmentProfile, saveEnvironmentProfile, selectEnvironmentProfile } = await fixture();
    const headers = { "Content-Type": "application/json", "X-Worktree-Control-Token": "test-access-token" };
    expect((await fetch(`${base}/api/projects/project-1/environment-profiles`, {
      method: "POST", headers, body: JSON.stringify({ name: "e2e", environment: { PLAYWRIGHT_E2E: "1" }, restart: true }),
    })).status).toBe(200);
    expect(saveEnvironmentProfile).toHaveBeenCalledWith("project-1", "e2e", { PLAYWRIGHT_E2E: "1" }, { owner: "local-user" }, true);
    expect((await fetch(`${base}/api/projects/project-1/environment-profile-selection`, {
      method: "POST", headers, body: JSON.stringify({ name: "e2e", restart: false }),
    })).status).toBe(200);
    expect(selectEnvironmentProfile).toHaveBeenCalledWith("project-1", "e2e", { owner: "local-user" }, false);
    expect((await fetch(`${base}/api/projects/project-1/environment-profiles`, {
      method: "DELETE", headers, body: JSON.stringify({ name: "e2e" }),
    })).status).toBe(200);
    expect(deleteEnvironmentProfile).toHaveBeenCalledWith("project-1", "e2e");
  });

  it("updates the global server capacity", async () => {
    const { base, setServerCapacity } = await fixture();
    const response = await fetch(`${base}/api/settings/capacity`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Worktree-Control-Token": "test-access-token" },
      body: JSON.stringify({ enabled: true, limit: 2 }),
    });
    expect(response.status).toBe(200);
    expect(setServerCapacity).toHaveBeenCalledWith({ enabled: true, limit: 2 });
  });

  it("updates the test limit and controls test runs", async () => {
    const { base, cancelTest, enqueueTest, setTestQueueLimit, testRun } = await fixture();
    const headers = { "Content-Type": "application/json", "X-Worktree-Control-Token": "test-access-token" };
    expect((await fetch(`${base}/api/settings/test-queue`, {
      method: "POST", headers, body: JSON.stringify({ limit: 3 }),
    })).status).toBe(200);
    expect(setTestQueueLimit).toHaveBeenCalledWith(3);

    const queued = await fetch(`${base}/api/projects/project-1/tests`, {
      method: "POST", headers, body: JSON.stringify({ worktreePath: "/code/web", presetId: "node:test" }),
    });
    expect(queued.status).toBe(202);
    expect(enqueueTest).toHaveBeenCalledWith("project-1", "/code/web", "node:test");

    expect((await fetch(`${base}/api/test-runs/run-1`, { headers })).status).toBe(200);
    expect(testRun).toHaveBeenCalledWith("run-1");
    const cancelled = await fetch(`${base}/api/test-runs/run-1/cancel`, { method: "POST", headers, body: "{}" });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ run: { id: "run-1", phase: "cancelled" } });
    expect(cancelTest).toHaveBeenCalledWith("run-1");
  });

  it("manages test environment profiles and preset assignments", async () => {
    const { base, assignTestPresetProfile, saveTestEnvironmentProfile, testEnvironmentProfiles } = await fixture();
    const headers = { "Content-Type": "application/json", "X-Worktree-Control-Token": "test-access-token" };

    const listed = await fetch(`${base}/api/projects/project-1/test-environment-profiles`, { headers });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ profiles: [], presetProfiles: {}, systemVariableNames: ["PATH"] });
    expect(testEnvironmentProfiles).toHaveBeenCalledWith("project-1");

    const saved = await fetch(`${base}/api/projects/project-1/test-environment-profiles`, {
      method: "POST", headers, body: JSON.stringify({ name: "e2e", environment: { E2E_RESET_DB_CONFIRM: "yes" }, mode: "inherit-server-profile", serverProfile: "qa-shots", nodeEnv: null, requiredVariables: ["PLAYWRIGHT_E2E"] }),
    });
    expect(saved.status).toBe(200);
    expect(saveTestEnvironmentProfile).toHaveBeenCalledWith("project-1", {
      name: "e2e",
      environment: { E2E_RESET_DB_CONFIRM: "yes" },
      mode: "inherit-server-profile",
      serverProfile: "qa-shots",
      nodeEnv: null,
      requiredVariables: ["PLAYWRIGHT_E2E"],
    });

    const assigned = await fetch(`${base}/api/projects/project-1/test-preset-profiles`, {
      method: "POST", headers, body: JSON.stringify({ presetId: "node:test", name: "e2e" }),
    });
    expect(assigned.status).toBe(200);
    expect(assignTestPresetProfile).toHaveBeenCalledWith("project-1", "node:test", "e2e");

    const rejected = await fetch(`${base}/api/projects/project-1/test-environment-profiles`, {
      method: "POST", headers, body: JSON.stringify({ name: "e2e", environment: {}, mode: "wrong" }),
    });
    expect(rejected.status).toBe(400);
  });

  it("queues a storage refresh for an explicit worktree", async () => {
    const { base, refreshWorktreeStorage } = await fixture();
    const response = await fetch(`${base}/api/projects/project-1/storage/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Worktree-Control-Token": "test-access-token" },
      body: JSON.stringify({ worktreePath: "/code/web-feature" }),
    });
    expect(response.status).toBe(202);
    expect(refreshWorktreeStorage).toHaveBeenCalledWith("project-1", "/code/web-feature");
  });

  it("accepts only the allowlisted Next.js cache deletion", async () => {
    const { base, deleteWorktreeCache } = await fixture();
    const response = await fetch(`${base}/api/projects/project-1/storage/cache`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-Worktree-Control-Token": "test-access-token" },
      body: JSON.stringify({ worktreePath: "/code/web-feature", cache: "next" }),
    });
    expect(response.status).toBe(200);
    expect(deleteWorktreeCache).toHaveBeenCalledWith("project-1", "/code/web-feature", "next");

    const rejected = await fetch(`${base}/api/projects/project-1/storage/cache`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-Worktree-Control-Token": "test-access-token" },
      body: JSON.stringify({ worktreePath: "/code/web-feature", cache: "node_modules" }),
    });
    expect(rejected.status).toBe(400);
    expect(deleteWorktreeCache).toHaveBeenCalledOnce();
  });
});
