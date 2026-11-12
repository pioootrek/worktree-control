import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAppPaths } from "../server/paths";
import { SqliteStateStore } from "../server/sqlite-store";
import { authenticateOfflineActor } from "./offline-actor";
import { parseSandboxArgs, prepareSandboxInstallation, runSandbox, SANDBOX_FORMAT, sandboxEnvironment, type SandboxDescriptor } from "./sandbox";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** Stands in for `start`: publishes the service record after "listening", per FAKE_MODE. */
const FAKE_CONTROLLER = `
import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
const option = name => process.argv[process.argv.indexOf(name) + 1];
const mode = process.env.FAKE_MODE ?? "normal";
console.log("fake controller", process.argv.slice(2).join(" "));
if (mode === "exit") { console.error("listen EADDRINUSE"); process.exit(3); }
const record = { pid: process.pid, startedAt: new Date().toISOString(), version: "fake", dashboardEndpoint: "http://127.0.0.1:" + option("--port"),
  localDashboardEndpoint: "http://127.0.0.1:" + option("--port"), mcpEndpoint: "http://127.0.0.1:" + option("--mcp-port") + "/mcp",
  accessUrl: "http://127.0.0.1:" + option("--port") + "/", logDirectory: join(option("--state-dir"), "logs"), authenticationMode: "token" };
if (mode !== "never-ready") {
  writeFileSync(join(option("--state-dir"), "service-access.json.tmp"), JSON.stringify(record));
  renameSync(join(option("--state-dir"), "service-access.json.tmp"), join(option("--state-dir"), "service-access.json"));
}
if (mode === "crash-after-ready") setTimeout(() => process.exit(4), 200);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sandboxHarness(mode: string, readyTimeoutMs = 10_000) {
  const scripts = temporary("worktree-control-sandbox-script-");
  const script = join(scripts, "fake-controller.mjs");
  writeFileSync(script, FAKE_CONTROLLER);
  const parent = temporary("worktree-control-sandbox-parent-");
  const stop = new AbortController();
  const lines: string[] = [];
  let log = "";
  let resolveDescriptor!: (value: SandboxDescriptor) => void;
  const descriptor = new Promise<SandboxDescriptor>(resolve => { resolveDescriptor = resolve; });
  const run = runSandbox({ projectName: "Unit", permissions: ["knowledge:read", "knowledge:write"], readyTimeoutMs }, {
    entry: { command: process.execPath, args: [script] },
    version: "9.9.9",
    temporaryDirectory: parent,
    environment: { PATH: process.env.PATH, FAKE_MODE: mode, WORKTREE_CONTROL_DATA_DIR: "/must/not/leak" },
    write: line => { lines.push(line); resolveDescriptor(JSON.parse(line) as SandboxDescriptor); },
    log: chunk => { log += chunk.toString(); },
    stop: stop.signal,
  });
  return { run, descriptor, stop, parent, lines, output: () => log };
}

describe("sandbox options", () => {
  it("defaults to read and write in a project named Sandbox", () => {
    expect(parseSandboxArgs([])).toEqual({ projectName: "Sandbox", permissions: ["knowledge:read", "knowledge:write"], readyTimeoutMs: 30_000 });
    expect(parseSandboxArgs(["--project-name", "E09a", "--permissions", "knowledge:read,knowledge:approve", "--ready-timeout-seconds", "5"]))
      .toEqual({ projectName: "E09a", permissions: ["knowledge:read", "knowledge:approve"], readyTimeoutMs: 5_000 });
  });

  it.each([
    [["--data-dir", "/tmp/x"]], [["--state-dir", "/tmp/x"]], [["--port", "4000"]], [["--project-name"]],
    [["--project-name", "a", "--project-name", "b"]], [["--permissions", "knowledge:admin"]], [["--permissions", "knowledge:read,knowledge:read"]],
    [["--ready-timeout-seconds", "0"]], [["--ready-timeout-seconds", "1.5"]], [["--project-name", "--permissions"]],
  ])("rejects %j", args => {
    expect(() => parseSandboxArgs(args)).toThrow();
  });

  it("removes every product variable from the controller environment", () => {
    expect(sandboxEnvironment({ PATH: "/bin", WORKTREE_CONTROL_TOKEN: "secret", WORKTREE_SWITCHER_DATA_DIR: "/data", WORKTREE_CONTROL_STATE_DIR: "/state", OTHER: undefined }))
      .toEqual({ PATH: "/bin" });
  });
});

describe("sandbox installation", () => {
  it("issues an installation token and a scoped agent token offline", () => {
    const root = temporary("worktree-control-sandbox-prepare-");
    mkdirSync(join(root, "data"), { mode: 0o700 });
    mkdirSync(join(root, "state"), { mode: 0o700 });
    const paths = resolveAppPaths(join(root, "data"), join(root, "state"), { environment: {} });
    const installation = prepareSandboxInstallation(paths, { projectName: "Prepared", permissions: ["knowledge:read"] });
    expect(installation.project.name).toBe("Prepared");
    expect(installation.agent.permissions).toEqual(["knowledge:read"]);
    const store = new SqliteStateStore(paths.databasePath);
    try {
      const owner = authenticateOfflineActor(store, installation.installationToken);
      expect(owner.actor.principalKind).toBe("installation");
      const grants = owner.identity.listKnowledgeGrants(installation.agent.principalId, owner.actor);
      expect(grants.map(grant => [grant.projectId, grant.permissions])).toEqual([[installation.project.id, ["knowledge:read"]]]);
      expect(authenticateOfflineActor(store, installation.agent.token).actor.principalId).toBe(installation.agent.principalId);
    } finally {
      store.close();
    }
  });
});

describe("sandbox lifecycle", () => {
  it("prints one descriptor, then stops the controller and removes its files", async () => {
    const harness = sandboxHarness("normal");
    const descriptor = await harness.descriptor;
    expect(descriptor).toMatchObject({ format: SANDBOX_FORMAT, version: "9.9.9", project: { name: "Unit" } });
    expect(descriptor.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(descriptor.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(descriptor.dataDirectory.startsWith(harness.parent)).toBe(true);
    expect(harness.output()).toContain("--host 127.0.0.1");
    expect(harness.output()).toContain(`--browse-root ${join(descriptor.dataDirectory, "..")}`);
    expect(alive(descriptor.pid)).toBe(true);
    harness.stop.abort();
    await harness.run;
    expect(harness.lines).toHaveLength(1);
    expect(alive(descriptor.pid)).toBe(false);
    expect(readdirSync(harness.parent)).toEqual([]);
  }, 30_000);

  it("reports a controller that exits during startup and removes its files", async () => {
    const harness = sandboxHarness("exit");
    await expect(harness.run).rejects.toThrow(/exited during startup \(3\)[\s\S]*EADDRINUSE/);
    expect(harness.lines).toEqual([]);
    expect(readdirSync(harness.parent)).toEqual([]);
  }, 30_000);

  it("stops a controller that never becomes ready", async () => {
    const harness = sandboxHarness("never-ready", 1_000);
    await expect(harness.run).rejects.toThrow(/not ready within 1 seconds/);
    expect(harness.lines).toEqual([]);
    expect(readdirSync(harness.parent)).toEqual([]);
  }, 30_000);

  it("fails when the controller exits after it was ready", async () => {
    const harness = sandboxHarness("crash-after-ready");
    await harness.descriptor;
    await expect(harness.run).rejects.toThrow(/exited unexpectedly \(4\)/);
    expect(readdirSync(harness.parent)).toEqual([]);
  }, 30_000);

  it("stops cleanly when asked to stop before the controller is ready", async () => {
    const harness = sandboxHarness("never-ready");
    setTimeout(() => harness.stop.abort(), 300);
    await harness.run;
    expect(harness.lines).toEqual([]);
    expect(readdirSync(harness.parent)).toEqual([]);
  }, 30_000);
});
