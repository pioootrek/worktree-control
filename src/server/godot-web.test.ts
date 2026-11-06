import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGodotWebRuntime } from "@/cli/godot-web-runtime";
import { webWorktreeKey } from "./launch-command";
import { ControlService } from "./control-service";
import { DirectoryBrowser } from "./directory-browser";
import { EventStream } from "./events";
import { SystemGitWorktreeReader } from "./git-worktrees";
import { createControllerServer } from "./http-server";
import { nullLogWriter } from "./log-writer";
import { ProjectLifecycle } from "./modules/lifecycle";
import { ProcessManager } from "./process-manager";
import { SqliteStateStore } from "./sqlite-store";
import { TestJobManager } from "./test-job-manager";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function git(repository: string, ...args: string[]) {
  execFileSync("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args]);
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wtc-godot-web-app-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repo");
  mkdirSync(join(repository, "game"), { recursive: true });
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, "project.godot"), "config_version=5\n");
  writeFileSync(join(repository, ".gitignore"), "/exports/\n/.godot/\n");
  writeFileSync(join(repository, "game/main.gd"), "v1");
  // Project-owned exporter: writes a flat Web export into a Git-ignored directory.
  writeFileSync(join(repository, "export.mjs"), `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
mkdirSync("exports/web", { recursive: true });
writeFileSync("exports/web/index.html", "<html><head></head><body>" + readFileSync("game/main.gd", "utf8") + "</body></html>");
writeFileSync("exports/web/index.wasm", "wasm");
writeFileSync("exports/web/index.pck", "pck");
`);
  git(repository, "add", ".");
  git(repository, "commit", "--quiet", "-m", "fixture");
  const state = join(root, "state");
  const store = new SqliteStateStore(join(root, "state.sqlite3")); cleanup.push(() => store.close());
  const events = new EventStream();
  let runtimeChanged: (projectId: string) => void = () => undefined;
  const processes = new ProcessManager((projectId) => runtimeChanged(projectId), nullLogWriter);
  const gitReader = new SystemGitWorktreeReader();
  const lifecycle = new ProjectLifecycle(store, processes);
  const tests = new TestJobManager(store, nullLogWriter);
  const { commands, godotWeb } = createGodotWebRuntime(state, { store, git: gitReader, processes, jobs: tests, lifecycle, logs: nullLogWriter, notify: () => undefined });
  runtimeChanged = (projectId) => godotWeb.runtimeChanged(projectId);
  const service = new ControlService(store, gitReader, processes, nullLogWriter, commands, undefined, undefined, undefined, tests, lifecycle, undefined, undefined, godotWeb);
  cleanup.push(() => service.shutdown().catch(() => undefined));
  const http = createControllerServer({ service, directoryBrowser: new DirectoryBrowser(root), events, webRoot: root, host: "127.0.0.1", port: 0, accessToken: "fixture-token",
    mcpStatus: () => ({ phase: "running", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "bearer", activeSessions: 0 }) });
  cleanup.push(() => http.close());
  await new Promise<void>((resolve) => http.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", "X-Worktree-Control-Token": "fixture-token" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { root, repository, store, service, processes, call, port: await freePort() };
}

describe("godot-web application workflow", () => {
  it("registers explicitly, serves the owned static runtime, exports through the queue and live-publishes edits", async () => {
    const f = await fixture();
    const config = { exporter: { kind: "command", command: ["node", "export.mjs"], outputDirectory: "exports/web" }, watch: { paths: ["game"], debounceMs: 100 } };
    const refused = await f.call("/api/projects", { name: "Game", repositoryPath: f.repository, port: f.port, launchPreset: "none", godotWeb: config });
    expect(refused.status).toBe(400);
    const added = await f.call("/api/projects", { name: "Game", repositoryPath: f.repository, port: f.port, launchPreset: "godot-web", godotWeb: config });
    expect(added.status).toBe(201);
    const projectId = (added.body.project as { id: string }).id;
    await expect(f.service.setProjectTls(projectId, { mode: "generated", keyPath: null, certPath: null, caPath: null })).rejects.toThrow("not supported for the godot-web preset");

    await f.service.operate(projectId, "start", f.repository);
    const preview = `http://127.0.0.1:${f.port}`;
    expect(await (await fetch(`${preview}/`)).text()).toContain("Waiting for the first complete Web export");
    await vi.waitFor(async () => expect((await f.call(`/api/projects/${projectId}/godot-web`)).body.webExport).toMatchObject({ state: "ready" }), { timeout: 20_000, interval: 200 });
    // The separate server observes the atomic pointer through fs.watch or its bounded poll.
    let entry!: Response;
    await vi.waitFor(async () => { entry = await fetch(`${preview}/`, { redirect: "manual" }); expect(entry.status).toBe(302); }, { timeout: 5_000, interval: 100 });
    const page = await fetch(new URL(entry.headers.get("location")!, preview));
    expect(await page.text()).toContain("<body>v1</body>");
    // Clean committed source: the export passes with observed-match attribution.
    const firstRun = f.store.listTestRuns(projectId)[0];
    expect(firstRun).toMatchObject({ presetId: "godot:web-export", phase: "passed", source: { attribution: "observed_match" } });

    writeFileSync(join(f.repository, "game/main.gd"), "v2");
    await vi.waitFor(async () => {
      const response = await fetch(`${preview}/`, { redirect: "manual" });
      const location = response.headers.get("location");
      expect(location && await (await fetch(new URL(location, preview))).text()).toContain("<body>v2</body>");
    }, { timeout: 20_000, interval: 200 });
    // Dirty dev source is served but not certified.
    expect(f.store.listTestRuns(projectId)[0]).toMatchObject({ phase: "failed", source: { processOutcome: "passed", attribution: "uncertain" } });

    const rebuild = await f.call(`/api/projects/${projectId}/godot-web/rebuild`, {});
    expect(rebuild.status).toBe(202);
    const snapshot = await f.service.projectSnapshot(projectId);
    expect(snapshot.webExport).toMatchObject({ worktreePath: f.repository, watcher: "watching" });
    expect((await f.call(`/api/projects/${projectId}/godot-web`, { config: null })).status).toBe(400); // running server

    await f.service.operate(projectId, "stop");
    await vi.waitFor(() => expect(f.store.countTestRuns(["queued", "running"], projectId)).toBe(0), { timeout: 20_000 });
    expect(f.service.webExportStatus(projectId)).toMatchObject({ state: "stopped", watcher: "stopped" });
    await expect(fetch(`${preview}/`)).rejects.toThrow();
    const disabled = await f.call(`/api/projects/${projectId}/godot-web`, { config: null });
    expect(disabled.body.project).toMatchObject({ launchPreset: "none", godotWeb: null });
    await f.service.removeProject(projectId);
  }, 60_000);

  it("binds a claimed switch to the claimed worktree and never serves the previous worktree's build", async () => {
    const f = await fixture();
    const linked = join(f.root, "linked");
    git(f.repository, "worktree", "add", "--quiet", "-b", "feature", linked);
    writeFileSync(join(linked, "game/main.gd"), "feature");
    const config = { exporter: { kind: "command", command: ["node", "export.mjs"], outputDirectory: "exports/web" }, watch: { paths: ["game"], debounceMs: 100 } };
    const project = await f.service.addProject({ name: "Game", repositoryPath: f.repository, port: f.port, launchPreset: "godot-web", godotWeb: config as never });
    await f.service.operate(project.id, "start", f.repository);
    await vi.waitFor(() => expect(f.service.webExportStatus(project.id)?.state).toBe("ready"), { timeout: 20_000, interval: 200 });
    const claim = await f.service.claimProject({ projectId: project.id, worktreePath: linked, owner: "agent:mcp:fixture", reason: "preview", idempotencyKey: "claim-1" }, undefined, false);
    expect(claim.operationError).toBeNull();
    const args = f.store.getProject(project.id)!.args;
    expect(args[args.indexOf("--worktree-key") + 1]).toBe(webWorktreeKey(linked));
    const preview = `http://127.0.0.1:${f.port}`;
    // Until the claimed worktree exports, the old generation is not served for it.
    const first = await fetch(`${preview}/`, { redirect: "manual" });
    if (first.status === 302) expect(await (await fetch(new URL(first.headers.get("location")!, preview))).text()).toContain("feature");
    await vi.waitFor(async () => {
      const response = await fetch(`${preview}/`, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(await (await fetch(new URL(response.headers.get("location")!, preview))).text()).toContain("<body>feature</body>");
    }, { timeout: 20_000, interval: 200 });
    expect(f.service.webExportStatus(project.id)).toMatchObject({ worktreePath: linked, state: "ready" });
    await f.service.releaseAgentClaim(project.id, claim.reservation.id, "agent:mcp:fixture", claim.leaseToken);
    await f.service.operate(project.id, "stop");
  }, 60_000);
});
