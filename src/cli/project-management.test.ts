import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireControllerLock } from "../server/controller-lock";
import { resolveAppPaths } from "../server/paths";
import { findAvailablePort, openProjectGateway, runDoctorCommand, runProjectCommand } from "./project-management";
import { writeServiceAccess } from "./service-access";

const directories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function createNodeRepository(withDevScript = true): string {
  const repository = temporaryDirectory("worktree-switcher-cli-repo-");
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, "package.json"), JSON.stringify({
    name: "fixture-app",
    scripts: withDevScript ? { dev: "next dev" } : {},
    dependencies: { next: "16.3.3" },
  }));
  return repository;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("project management CLI", () => {
  it("adds, lists, and removes a project through the offline control service", async () => {
    const repository = createNodeRepository();
    const dataDirectory = temporaryDirectory("worktree-switcher-cli-data-");
    const stateDirectory = temporaryDirectory("worktree-switcher-cli-state-");
    const paths = resolveAppPaths(dataDirectory, stateDirectory);
    const output: string[] = [];
    const gateway = await openProjectGateway(paths, "en");
    try {
      await runProjectCommand(["add", repository], gateway, "en", {
        isPortAvailable: async (port) => port === 3001,
        write: (line) => output.push(line),
      });
      const dashboard = await gateway.dashboard();
      expect(dashboard.projects[0].project).toMatchObject({
        name: repository.split("/").at(-1),
        port: 3001,
        launchPreset: "node",
        executable: "npm",
        args: ["run", "dev"],
      });

      await runProjectCommand(["list", "--json"], gateway, "en", { write: (line) => output.push(line) });
      expect(JSON.parse(output.at(-1)!)).toMatchObject([{ port: 3001, runtimePhase: "stopped" }]);

      const projectId = dashboard.projects[0].project.id;
      await expect(runProjectCommand(["add", createNodeRepository(), "--port", "3001"], gateway, "en"))
        .rejects.toThrow(`Port 3001 is already assigned to project ${dashboard.projects[0].project.name}.`);
      await runProjectCommand(["remove", projectId], gateway, "en", { write: (line) => output.push(line) });
      expect((await gateway.dashboard()).projects).toEqual([]);
      expect(output.at(-1)).toContain("Removed project");
    } finally {
      await gateway.close();
    }
  });

  it("rejects invalid repositories and missing dev scripts without partial records", async () => {
    const dataDirectory = temporaryDirectory("worktree-switcher-cli-invalid-data-");
    const stateDirectory = temporaryDirectory("worktree-switcher-cli-invalid-state-");
    const gateway = await openProjectGateway(resolveAppPaths(dataDirectory, stateDirectory), "en");
    try {
      const plainDirectory = temporaryDirectory("worktree-switcher-cli-plain-");
      await expect(runProjectCommand(["add", plainDirectory, "--port", "3100"], gateway, "en"))
        .rejects.toThrow("repozytorium Git");
      await expect(runProjectCommand(["add", createNodeRepository(false), "--port", "3101"], gateway, "en"))
        .rejects.toThrow("skryptu dev");
      await expect(runProjectCommand(["add", plainDirectory, "--port"], gateway, "pl"))
        .rejects.toThrow("Brak wartości opcji --port.");
      expect((await gateway.dashboard()).projects).toEqual([]);
    } finally {
      await gateway.close();
    }
  });

  it("reports a healthy fresh installation", async () => {
    const dataDirectory = temporaryDirectory("worktree-switcher-cli-doctor-data-");
    const stateDirectory = temporaryDirectory("worktree-switcher-cli-doctor-state-");
    const gateway = await openProjectGateway(resolveAppPaths(dataDirectory, stateDirectory), "en");
    const output: string[] = [];
    try {
      expect(await runDoctorCommand(gateway, "en", (line) => output.push(line))).toBe(true);
      expect(output).toContain("Worktree Switcher is ready.");
      expect(output.some((line) => line.includes("registered projects: 0"))).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it("routes project commands through a running controller access record", async () => {
    const dataDirectory = temporaryDirectory("worktree-switcher-cli-online-data-");
    const stateDirectory = temporaryDirectory("worktree-switcher-cli-online-state-");
    const paths = resolveAppPaths(dataDirectory, stateDirectory);
    const requests: Array<{ method: string | undefined; url: string | undefined; token: string | undefined }> = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url, token: request.headers["x-worktree-switcher-token"] as string | undefined });
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET") {
        response.end(JSON.stringify({ projects: [], capacity: { enabled: false, limit: 2, used: 0, available: null, holders: [] } }));
      } else {
        response.end(JSON.stringify({ project: { id: "project-1", name: "Remote App" } }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const localEndpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const recordedEndpoint = `http://192.0.2.1:${(server.address() as AddressInfo).port}`;
    writeServiceAccess(paths.serviceAccessPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: "0.0.1",
      dashboardEndpoint: recordedEndpoint,
      localDashboardEndpoint: localEndpoint,
      publicDashboardEndpoint: "https://switcher.example.test",
      mcpEndpoint: null,
      accessUrl: "https://switcher.example.test/#token=controller-token",
      logDirectory: paths.logDirectory,
    });

    const gateway = await openProjectGateway(paths, "en");
    try {
      expect(gateway.mode).toBe("controller");
      await runProjectCommand(["list"], gateway, "en", { write: () => undefined });
      await runProjectCommand(["remove", "project-1"], gateway, "en", { write: () => undefined });
      expect(requests).toEqual([
        { method: "GET", url: "/api/dashboard", token: "controller-token" },
        { method: "DELETE", url: "/api/projects/project-1", token: "controller-token" },
      ]);
    } finally {
      await gateway.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("reports controller transport failures separately from invalid access records", async () => {
    const dataDirectory = temporaryDirectory("worktree-switcher-cli-transport-data-");
    const stateDirectory = temporaryDirectory("worktree-switcher-cli-transport-state-");
    const paths = resolveAppPaths(dataDirectory, stateDirectory);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    writeServiceAccess(paths.serviceAccessPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: "0.0.1",
      dashboardEndpoint: endpoint,
      mcpEndpoint: null,
      accessUrl: `${endpoint}/#token=controller-token`,
      logDirectory: paths.logDirectory,
    });

    const gateway = await openProjectGateway(paths, "en");
    try {
      const failure = await gateway.dashboard().then(() => null, (error: Error) => error);
      expect(failure?.message).toContain(`Could not connect to the controller at ${endpoint}`);
      expect(failure?.message).toContain("ECONNREFUSED");
      expect(failure?.message).not.toContain("access record");
    } finally {
      await gateway.close();
    }
  });

  it("asks for the installation token when a token-mode controller is running", async () => {
    const dataDirectory = temporaryDirectory("worktree-switcher-cli-token-data-");
    const stateDirectory = temporaryDirectory("worktree-switcher-cli-token-state-");
    const paths = resolveAppPaths(dataDirectory, stateDirectory);
    writeServiceAccess(paths.serviceAccessPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: "0.0.1",
      dashboardEndpoint: "http://127.0.0.1:1",
      mcpEndpoint: null,
      accessUrl: "http://127.0.0.1:1/",
      logDirectory: paths.logDirectory,
      authenticationMode: "token",
    });
    const previous = process.env.WORKTREE_SWITCHER_TOKEN;
    delete process.env.WORKTREE_SWITCHER_TOKEN;
    try {
      await expect(openProjectGateway(paths, "en")).rejects.toThrow("Set WORKTREE_SWITCHER_TOKEN");
    } finally {
      if (previous !== undefined) process.env.WORKTREE_SWITCHER_TOKEN = previous;
    }
  });

  it("refuses offline database access through a typed live-controller lock", async () => {
    const dataDirectory = temporaryDirectory("worktree-switcher-cli-lock-data-");
    const stateDirectory = temporaryDirectory("worktree-switcher-cli-lock-state-");
    const paths = resolveAppPaths(dataDirectory, stateDirectory);
    const lock = acquireControllerLock(paths.controllerLockPath);
    try {
      await expect(openProjectGateway(paths, "pl")).rejects.toThrow("brakuje prawidłowego rekordu dostępu");
    } finally {
      lock.release();
    }
  });

  it("selects the first free unconfigured port", async () => {
    const checked: number[] = [];
    const port = await findAvailablePort(new Set([3000]), async (candidate) => {
      checked.push(candidate);
      return candidate === 3002;
    });
    expect(port).toBe(3002);
    expect(checked).toEqual([3001, 3002]);
  });
});
