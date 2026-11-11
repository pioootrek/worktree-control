import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { listenAdminSocket } from "../server/admin-socket";
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
  const repository = temporaryDirectory("worktree-control-cli-repo-");
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
    const dataDirectory = temporaryDirectory("worktree-control-cli-data-");
    const stateDirectory = temporaryDirectory("worktree-control-cli-state-");
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
    const dataDirectory = temporaryDirectory("worktree-control-cli-invalid-data-");
    const stateDirectory = temporaryDirectory("worktree-control-cli-invalid-state-");
    const gateway = await openProjectGateway(resolveAppPaths(dataDirectory, stateDirectory), "en");
    try {
      const plainDirectory = temporaryDirectory("worktree-control-cli-plain-");
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
    const dataDirectory = temporaryDirectory("worktree-control-cli-doctor-data-");
    const stateDirectory = temporaryDirectory("worktree-control-cli-doctor-state-");
    const gateway = await openProjectGateway(resolveAppPaths(dataDirectory, stateDirectory), "en");
    const output: string[] = [];
    try {
      expect(await runDoctorCommand(gateway, "en", (line) => output.push(line))).toBe(true);
      expect(output).toContain("Worktree Control is ready.");
      expect(output.some((line) => line.includes("registered projects: 0"))).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it("routes project commands through a running controller access record", async () => {
    const dataDirectory = temporaryDirectory("worktree-control-cli-online-data-");
    const stateDirectory = temporaryDirectory("worktree-control-cli-online-state-");
    const paths = resolveAppPaths(dataDirectory, stateDirectory);
    const requests: Array<{ method: string | undefined; url: string | undefined; token: string | undefined }> = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url, token: request.headers["x-worktree-control-token"] as string | undefined });
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
    const dataDirectory = temporaryDirectory("worktree-control-cli-transport-data-");
    const stateDirectory = temporaryDirectory("worktree-control-cli-transport-state-");
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

  it("reaches an open-mode controller without any credential", async () => {
    const dataDirectory = temporaryDirectory("worktree-control-cli-open-data-");
    const stateDirectory = temporaryDirectory("worktree-control-cli-open-state-");
    const paths = resolveAppPaths(dataDirectory, stateDirectory);
    const seen: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      seen.push(request.headers["x-worktree-control-token"] as string | undefined);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ projects: [] }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeServiceAccess(paths.serviceAccessPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: "0.0.1",
      dashboardEndpoint: endpoint,
      mcpEndpoint: null,
      accessUrl: `${endpoint}/`,
      logDirectory: paths.logDirectory,
      authenticationMode: "open",
    });
    const previous = process.env.WORKTREE_CONTROL_TOKEN;
    delete process.env.WORKTREE_CONTROL_TOKEN;
    const gateway = await openProjectGateway(paths, "en");
    try {
      expect((await gateway.dashboard()).projects).toEqual([]);
      expect(seen).toEqual([undefined]);
    } finally {
      await gateway.close();
      if (previous !== undefined) process.env.WORKTREE_CONTROL_TOKEN = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("asks for the installation token when a token-mode controller is running", async () => {
    const dataDirectory = temporaryDirectory("worktree-control-cli-token-data-");
    const stateDirectory = temporaryDirectory("worktree-control-cli-token-state-");
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
    const previous = process.env.WORKTREE_CONTROL_TOKEN;
    delete process.env.WORKTREE_CONTROL_TOKEN;
    try {
      await expect(openProjectGateway(paths, "en")).rejects.toThrow("Set WORKTREE_CONTROL_TOKEN");
    } finally {
      if (previous !== undefined) process.env.WORKTREE_CONTROL_TOKEN = previous;
    }
  });

  it("manages projects of a better-auth controller through its admin socket", async () => {
    const dataDirectory = temporaryDirectory("worktree-control-cli-account-data-");
    const stateDirectory = temporaryDirectory("worktree-control-cli-account-state-");
    const paths = resolveAppPaths(dataDirectory, stateDirectory);
    const requests: unknown[] = [];
    const socket = await listenAdminSocket(paths.adminSocketPath, (body) => {
      requests.push(body);
      const action = (body as { action?: string }).action;
      if (action === "dashboard") return { projects: [] };
      if (action === "remove") return { project: { id: "project-1", name: "Fixture" } };
      throw new Error("Unexpected request.");
    });
    writeServiceAccess(paths.serviceAccessPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: "0.0.1",
      dashboardEndpoint: "http://127.0.0.1:1",
      mcpEndpoint: null,
      accessUrl: "http://127.0.0.1:1/",
      logDirectory: paths.logDirectory,
      authenticationMode: "better-auth",
    });
    const previous = process.env.WORKTREE_CONTROL_TOKEN;
    delete process.env.WORKTREE_CONTROL_TOKEN;
    const gateway = await openProjectGateway(paths, "en");
    try {
      expect(gateway.mode).toBe("controller");
      await runProjectCommand(["list"], gateway, "en", { write: () => undefined });
      await runProjectCommand(["remove", "project-1"], gateway, "en", { write: () => undefined });
      expect(requests).toEqual([
        { command: "project", action: "dashboard" },
        { command: "project", action: "remove", projectId: "project-1" },
      ]);
    } finally {
      await gateway.close();
      await socket.close();
      if (previous !== undefined) process.env.WORKTREE_CONTROL_TOKEN = previous;
    }
  });

  it("explains a missing admin socket instead of an invalid access record", async () => {
    const dataDirectory = temporaryDirectory("worktree-control-cli-nosocket-data-");
    const stateDirectory = temporaryDirectory("worktree-control-cli-nosocket-state-");
    const paths = resolveAppPaths(dataDirectory, stateDirectory);
    writeServiceAccess(paths.serviceAccessPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: "0.0.1",
      dashboardEndpoint: "http://127.0.0.1:1",
      mcpEndpoint: null,
      accessUrl: "http://127.0.0.1:1/",
      logDirectory: paths.logDirectory,
      authenticationMode: "better-auth",
    });
    const previous = process.env.WORKTREE_CONTROL_TOKEN;
    delete process.env.WORKTREE_CONTROL_TOKEN;
    const gateway = await openProjectGateway(paths, "en");
    try {
      const failure = await gateway.dashboard().then(() => null, (error: Error) => error);
      expect(failure?.message).toContain(`without an admin socket at ${paths.adminSocketPath}`);
      expect(failure?.message).not.toContain("access record");
    } finally {
      await gateway.close();
      if (previous !== undefined) process.env.WORKTREE_CONTROL_TOKEN = previous;
    }
  });

  it("refuses offline database access through a typed live-controller lock", async () => {
    const dataDirectory = temporaryDirectory("worktree-control-cli-lock-data-");
    const stateDirectory = temporaryDirectory("worktree-control-cli-lock-state-");
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

describe("verification-only CLI registration", () => {
  it.each([undefined, "auto", "none"])("selects an unassigned configured port without live probes for preset %s", async preset => {
    const repository = temporaryDirectory("wtc-cli-no-server-");
    execFileSync("git", ["init", "--quiet", repository]);
    if (preset !== "none") writeFileSync(join(repository, "project.godot"), "config_version=5\n");
    const paths = resolveAppPaths(temporaryDirectory("wtc-cli-data-"), temporaryDirectory("wtc-cli-state-"));
    const gateway = await openProjectGateway(paths, "en");
    const isPortAvailable = vi.fn(async () => false);
    const dependencies = { isPortAvailable, write: () => undefined };
    const presetArgs = preset ? ["--preset", preset] : [];
    try {
      await runProjectCommand(["add", createNodeRepository(), "--preset", "none", "--port", "3000", "--name", "Existing"], gateway, "en", dependencies);
      await runProjectCommand(["add", repository, ...presetArgs], gateway, "en", dependencies);
      expect((await gateway.dashboard()).projects.map(({ project }) => ({ port: project.port, preset: project.launchPreset })).sort((a, b) => a.port - b.port))
        .toEqual([{ port: 3000, preset: "none" }, { port: 3001, preset: "none" }]);
      await expect(runProjectCommand(["add", repository, ...presetArgs, "--port", "3000"], gateway, "en", dependencies))
        .rejects.toThrow("Port 3000 is already assigned to project Existing.");
      for (const port of ["1023", "65536", "3.5", "invalid"]) {
        await expect(runProjectCommand(["add", repository, ...presetArgs, "--port", port], gateway, "en", dependencies))
          .rejects.toThrow("Project port must be an integer between 1024 and 65535.");
      }
      expect((await gateway.dashboard()).projects).toHaveLength(2);
      expect(isPortAvailable).not.toHaveBeenCalled();
    } finally { await gateway.close(); }
  });

  it.each([
    ["node", false], ["django", false], ["node", true], ["django", true],
  ] as const)("keeps live-port checks for auto %s with Godot=%s", async (preset, godot) => {
    const repository = preset === "node" ? createNodeRepository() : temporaryDirectory("wtc-cli-django-");
    if (preset === "django") {
      execFileSync("git", ["init", "--quiet", repository]);
      writeFileSync(join(repository, "manage.py"), "");
    }
    if (godot) writeFileSync(join(repository, "project.godot"), "config_version=5\n");
    const paths = resolveAppPaths(temporaryDirectory("wtc-cli-data-"), temporaryDirectory("wtc-cli-state-"));
    const gateway = await openProjectGateway(paths, "en");
    const isPortAvailable = vi.fn(async (port: number) => port === 3002);
    const dependencies = { isPortAvailable, write: () => undefined };
    try {
      await runProjectCommand(["add", createNodeRepository(), "--preset", "none", "--port", "3000"], gateway, "en", dependencies);
      await runProjectCommand(["add", repository, "--preset", "auto"], gateway, "en", dependencies);
      expect(isPortAvailable.mock.calls).toEqual([[3001], [3002]]);
      expect((await gateway.dashboard()).projects.find(({ project }) => project.port === 3002)?.project).toMatchObject({ port: 3002, launchPreset: preset });
      isPortAvailable.mockClear();
      isPortAvailable.mockResolvedValue(false);
      await expect(runProjectCommand(["add", repository], gateway, "en", dependencies))
        .rejects.toThrow("No free project port was found between 3000 and 3999.");
      expect(isPortAvailable).toHaveBeenCalledTimes(998);
      expect((await gateway.dashboard()).projects).toHaveLength(2);
    } finally { await gateway.close(); }
  });

  it("preserves the ambiguous Node/Django error when Godot is also present", async () => {
    const repository = createNodeRepository();
    writeFileSync(join(repository, "manage.py"), "");
    writeFileSync(join(repository, "project.godot"), "config_version=5\n");
    const paths = resolveAppPaths(temporaryDirectory("wtc-cli-data-"), temporaryDirectory("wtc-cli-state-"));
    const gateway = await openProjectGateway(paths, "en");
    try {
      await expect(runProjectCommand(["add", repository], gateway, "en", { isPortAvailable: async () => true, write: () => undefined }))
        .rejects.toThrow("Wybierz preset Node.js albo Django.");
      expect((await gateway.dashboard()).projects).toEqual([]);
    } finally { await gateway.close(); }
  });

  it.each(["none", "auto"])("registers Godot with --preset %s and lists no_server", async preset => {
    const repository = temporaryDirectory("wtc-cli-godot-");
    execFileSync("git", ["init", "--quiet", repository]);
    writeFileSync(join(repository, "project.godot"), "config_version=5\n");
    const paths = resolveAppPaths(temporaryDirectory("wtc-cli-data-"), temporaryDirectory("wtc-cli-state-"));
    const gateway = await openProjectGateway(paths, "en"); const output: string[] = [];
    try {
      await runProjectCommand(["add", repository, "--preset", preset, "--port", "3210"], gateway, "en", { write: line => output.push(line) });
      await runProjectCommand(["list", "--json"], gateway, "en", { write: line => output.push(line) });
      expect(JSON.parse(output.at(-1)!)).toMatchObject([{ launchPreset: "none", runtimePhase: "no_server", port: 3210 }]);
    } finally { await gateway.close(); }
  });
});

describe("Godot Web project CLI", () => {
  it("registers explicit godot-web with a config file, disables and re-enables it offline", async () => {
    const repository = temporaryDirectory("wtc-cli-godot-web-");
    execFileSync("git", ["init", "--quiet", repository]);
    writeFileSync(join(repository, "project.godot"), "config_version=5\n");
    const config = join(temporaryDirectory("wtc-cli-godot-config-"), "godot-web.json");
    writeFileSync(config, JSON.stringify({ exporter: { kind: "command", command: ["bash", "scripts/project.sh", "export-web"], outputDirectory: "exports/web" }, liveReload: false }));
    const paths = resolveAppPaths(temporaryDirectory("wtc-cli-data-"), temporaryDirectory("wtc-cli-state-"));
    const gateway = await openProjectGateway(paths, "en"); const output: string[] = [];
    try {
      await expect(runProjectCommand(["add", repository, "--preset", "none", "--godot-web-config", config, "--port", "3211"], gateway, "en", { write: () => undefined }))
        .rejects.toThrow("--godot-web-config requires --preset godot-web.");
      await runProjectCommand(["add", repository, "--preset", "godot-web", "--godot-web-config", config, "--port", "3211"], gateway, "en", { write: line => output.push(line) });
      const [snapshot] = (await gateway.dashboard()).projects;
      expect(snapshot.project).toMatchObject({ launchPreset: "godot-web", godotWeb: { exporter: { kind: "command", outputDirectory: "exports/web" }, liveReload: false } });
      expect(snapshot.project.args).toEqual(expect.arrayContaining(["--root", "--worktree-key", "--live-reload", "0"]));
      expect(snapshot.project.args.join(" ")).toContain(join(paths.stateDirectory, "godot-web", snapshot.project.id, "public"));
      expect(snapshot.webExport).toBeNull();
      await runProjectCommand(["godot-web", snapshot.project.id, "--disable"], gateway, "en", { write: line => output.push(line) });
      expect((await gateway.dashboard()).projects[0].project).toMatchObject({ launchPreset: "none", godotWeb: null, executable: "", args: [] });
      await runProjectCommand(["godot-web", snapshot.project.id, "--config", config], gateway, "en", { write: line => output.push(line) });
      expect((await gateway.dashboard()).projects[0].project.launchPreset).toBe("godot-web");
      await expect(runProjectCommand(["godot-web", snapshot.project.id], gateway, "en", { write: () => undefined })).rejects.toThrow(/Usage: worktree-control project godot-web/);
      await expect(runProjectCommand(["rebuild-web", snapshot.project.id], gateway, "en", { write: () => undefined })).rejects.toThrow(/Start the Godot Web server/);
      expect(output.filter(line => line.includes("preset: "))).toEqual([
        "Saved the Godot Web configuration of " + snapshot.project.name + "; preset: none.",
        "Saved the Godot Web configuration of " + snapshot.project.name + "; preset: godot-web.",
      ]);
    } finally { await gateway.close(); }
  });

  it("refuses godot-web when the worktree has no project.godot", async () => {
    const repository = createNodeRepository();
    const paths = resolveAppPaths(temporaryDirectory("wtc-cli-data-"), temporaryDirectory("wtc-cli-state-"));
    const gateway = await openProjectGateway(paths, "en");
    try {
      await expect(runProjectCommand(["add", repository, "--preset", "godot-web", "--port", "3212"], gateway, "en", { write: () => undefined }))
        .rejects.toThrow(/project.godot/);
      expect((await gateway.dashboard()).projects).toEqual([]);
    } finally { await gateway.close(); }
  });
});
