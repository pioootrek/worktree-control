import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAppPaths } from "../server/paths";
import { openProjectGateway, type ProjectGateway, runProjectCommand } from "./project-management";
import { writeServiceAccess } from "./service-access";

const directories: string[] = [];
type Kind = "node" | "django" | "godot";
const presetOptions = [undefined, "auto", "none"] as const;
const presetArgs = (preset: typeof presetOptions[number]) => preset ? ["--preset", preset] : [];

function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "wtc-cli-discovery-"));
  directories.push(path);
  return path;
}

function writeManifest(path: string, kind: Kind) {
  const filename = kind === "node" ? "package.json" : kind === "django" ? "manage.py" : "project.godot";
  writeFileSync(join(path, filename), kind === "node" ? JSON.stringify({ scripts: { dev: "next dev" } }) : "");
}

function repository(kind: Kind) {
  const path = temporaryDirectory();
  execFileSync("git", ["init", "--quiet", path]);
  writeManifest(path, kind);
  mkdirSync(join(path, "src"));
  writeFileSync(join(path, "src", "fixture.txt"), "fixture\n");
  return path;
}

function linkedRepository(primary: string, kind: Kind) {
  execFileSync("git", ["-C", primary, "add", "."]);
  execFileSync("git", ["-C", primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture"]);
  const linked = join(temporaryDirectory(), "linked");
  execFileSync("git", ["-C", primary, "worktree", "add", "--quiet", "-b", "linked", linked]);
  for (const filename of ["package.json", "manage.py", "project.godot"]) rmSync(join(linked, filename), { force: true });
  writeManifest(linked, kind);
  return linked;
}

// Both modes use the real offline service, Git reader and isolated SQLite owner.
// The controller fixture adds the production CLI HTTP gateway and records its wire input.
async function gatewayFixture(mode: "offline" | "controller") {
  const paths = resolveAppPaths(temporaryDirectory(), temporaryDirectory());
  const offline = await openProjectGateway(paths, "en");
  const submissions: Array<Parameters<ProjectGateway["addProject"]>[0]> = [];
  if (mode === "offline") return { gateway: offline, submissions, close: () => offline.close() };
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.headers["x-worktree-control-token"] !== "fixture-token") {
      response.writeHead(401).end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    try {
      if (request.method === "GET" && request.url === "/api/dashboard") {
        response.end(JSON.stringify(await offline.dashboard()));
      } else if (request.method === "POST" && request.url === "/api/projects") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body) as Parameters<ProjectGateway["addProject"]>[0];
        submissions.push(input);
        response.end(JSON.stringify({ project: await offline.addProject(input) }));
      } else response.writeHead(404).end(JSON.stringify({ error: "Unknown fixture route" }));
    } catch (error) {
      response.writeHead(400).end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  writeServiceAccess(paths.serviceAccessPath, {
    pid: process.pid, startedAt: new Date().toISOString(), version: "fixture",
    dashboardEndpoint: endpoint, mcpEndpoint: null,
    accessUrl: `${endpoint}/#token=fixture-token`, logDirectory: paths.logDirectory,
  });
  const gateway = await openProjectGateway(paths, "en");
  return { gateway, submissions, close: async () => {
    await gateway.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await offline.close();
  } };
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe.each(["offline", "controller"] as const)("CLI registration discovery through %s gateway", mode => {
  const subdirectoryCases = (["node", "django", "godot"] as const).flatMap(kind =>
    presetOptions.map(preset => ({ kind, preset })));

  it.each(subdirectoryCases)("registers a manifest-free $kind subdirectory with preset $preset", async ({ kind, preset }) => {
    const root = repository(kind);
    const fixture = await gatewayFixture(mode);
    const { gateway } = fixture;
    const isPortAvailable = vi.fn(async (port: number) => port === 3002);
    const dependencies = { isPortAvailable, write: () => undefined };
    const input = join(root, "src");
    const noServer = kind === "godot" || preset === "none";
    try {
      await runProjectCommand(["add", repository("node"), "--preset", "none", "--port", "3000"], gateway, "en", dependencies);
      await runProjectCommand(["add", input, ...presetArgs(preset)], gateway, "en", dependencies);
      expect((await gateway.dashboard()).projects.find(({ project }) => project.repositoryPath === root)?.project)
        .toMatchObject({ repositoryPath: root, selectedWorktreePath: root, launchPreset: noServer ? "none" : kind, port: noServer ? 3001 : 3002, name: "src" });
      expect(isPortAvailable.mock.calls).toEqual(noServer ? [] : [[3001], [3002]]);
      if (mode === "controller") expect(fixture.submissions.at(-1)).toMatchObject({ repositoryPath: input, launchPreset: preset ?? "auto" });
      if (!noServer) {
        isPortAvailable.mockClear();
        isPortAvailable.mockResolvedValue(false);
        await expect(runProjectCommand(["add", input, ...presetArgs(preset)], gateway, "en", dependencies))
          .rejects.toThrow("No free project port was found between 3000 and 3999.");
        expect(isPortAvailable).toHaveBeenCalledTimes(998);
        expect((await gateway.dashboard()).projects).toHaveLength(2);
      }
    } finally { await fixture.close(); }
  });

  const linkedCases = (["node", "godot"] as const).flatMap(primaryKind =>
    presetOptions.map(preset => ({ primaryKind, preset })));
  it.each(linkedCases)("uses $primaryKind primary manifests for an opposite linked worktree, preset $preset", async ({ primaryKind, preset }) => {
    const primary = repository(primaryKind);
    const linked = linkedRepository(primary, primaryKind === "node" ? "godot" : "node");
    const fixture = await gatewayFixture(mode);
    const { gateway } = fixture;
    const isPortAvailable = vi.fn(async () => false);
    const dependencies = { isPortAvailable, write: () => undefined };
    const noServer = primaryKind === "godot" || preset === "none";
    try {
      await runProjectCommand(["add", repository("node"), "--preset", "none", "--port", "3000"], gateway, "en", dependencies);
      if (!noServer) {
        await expect(runProjectCommand(["add", linked, ...presetArgs(preset)], gateway, "en", dependencies))
          .rejects.toThrow("No free project port was found between 3000 and 3999.");
        expect(isPortAvailable).toHaveBeenCalledTimes(999);
        expect((await gateway.dashboard()).projects).toHaveLength(1);
        isPortAvailable.mockClear();
        isPortAvailable.mockResolvedValue(true);
      }
      await runProjectCommand(["add", linked, ...presetArgs(preset)], gateway, "en", dependencies);
      expect((await gateway.dashboard()).projects.find(({ project }) => project.repositoryPath === linked)?.project)
        .toMatchObject({ repositoryPath: linked, selectedWorktreePath: primary, launchPreset: noServer ? "none" : "node", port: 3001 });
      expect(isPortAvailable.mock.calls).toEqual(noServer ? [] : [[3001]]);
      if (mode === "controller") expect(fixture.submissions.at(-1)).toMatchObject({ repositoryPath: linked, launchPreset: preset ?? "auto" });
    } finally { await fixture.close(); }
  });

  it.each(presetOptions)("keeps root Godot and symlinked subdirectory registration probe-free, preset %s", async preset => {
    const fixture = await gatewayFixture(mode);
    const isPortAvailable = vi.fn(async () => false);
    const dependencies = { isPortAvailable, write: () => undefined };
    try {
      for (const symlink of [false, true]) {
        const root = repository("godot");
        const alias = join(temporaryDirectory(), "alias");
        symlinkSync(root, alias, "dir");
        await runProjectCommand(["add", symlink ? join(alias, "src") : root, ...presetArgs(preset)], fixture.gateway, "en", dependencies);
        expect((await fixture.gateway.dashboard()).projects.find(({ project }) => project.repositoryPath === root)?.project)
          .toMatchObject({ repositoryPath: root, selectedWorktreePath: root, launchPreset: "none", port: symlink ? 3001 : 3000 });
      }
      expect(isPortAvailable).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it.each(["node", "django", "godot"] as const)("keeps the explicit-port branch for a $kind subdirectory", async kind => {
    const root = repository(kind);
    const fixture = await gatewayFixture(mode);
    const isPortAvailable = vi.fn(async () => false);
    try {
      await runProjectCommand(["add", join(root, "src"), "--port", "3210"], fixture.gateway, "en", { isPortAvailable, write: () => undefined });
      expect((await fixture.gateway.dashboard()).projects[0].project)
        .toMatchObject({ repositoryPath: root, selectedWorktreePath: root, launchPreset: kind === "godot" ? "none" : kind, port: 3210 });
      expect(isPortAvailable).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it("preserves ambiguity and invalid-path errors without partial registration", async () => {
    const root = repository("node");
    writeManifest(root, "django");
    writeManifest(root, "godot");
    const plain = temporaryDirectory();
    const missing = join(plain, "missing");
    const fixture = await gatewayFixture(mode);
    const isPortAvailable = vi.fn(async () => true);
    const dependencies = { isPortAvailable, write: () => undefined };
    try {
      for (const preset of [undefined, "auto"] as const) {
        await expect(runProjectCommand(["add", join(root, "src"), ...presetArgs(preset)], fixture.gateway, "en", dependencies))
          .rejects.toThrow("Wybierz preset Node.js albo Django.");
        await expect(runProjectCommand(["add", plain, ...presetArgs(preset)], fixture.gateway, "en", dependencies))
          .rejects.toThrow("repozytorium Git");
        await expect(runProjectCommand(["add", missing, ...presetArgs(preset)], fixture.gateway, "en", dependencies))
          .rejects.toThrow("ENOENT");
      }
      expect(isPortAvailable).not.toHaveBeenCalled();
      expect((await fixture.gateway.dashboard()).projects).toEqual([]);
      await runProjectCommand(["add", join(root, "src"), "--preset", "node"], fixture.gateway, "en", dependencies);
      expect((await fixture.gateway.dashboard()).projects[0].project.launchPreset).toBe("node");
    } finally { await fixture.close(); }
  });

  it("leaves invalid Node command validation to the application", async () => {
    const root = repository("node");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {} }));
    const fixture = await gatewayFixture(mode);
    try {
      await expect(runProjectCommand(["add", join(root, "src")], fixture.gateway, "en", { isPortAvailable: async () => true, write: () => undefined }))
        .rejects.toThrow("skryptu dev");
      expect((await fixture.gateway.dashboard()).projects).toEqual([]);
    } finally { await fixture.close(); }
  });
});
