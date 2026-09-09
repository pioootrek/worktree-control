import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ControllerDashboardResponse } from "../../src/shared/contracts";

const exec = promisify(execFile);
const TIMEOUT = 30_000;

export interface FixtureProject {
  id: string;
  name: string;
  port: number;
  repositoryPath: string;
  worktrees: string[];
}

export interface ControllerFixture {
  baseUrl: string;
  pairedUrl: string;
  projects: FixtureProject[];
  request(path: string, init?: RequestInit): Promise<Response>;
  dashboard(): Promise<ControllerDashboardResponse>;
  identity(project: FixtureProject): Promise<{ marker: string; pid: number; boot: string }>;
  operate(project: FixtureProject, operation: "start" | "stop" | "restart" | "switch", worktreePath?: string): Promise<Response>;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No TCP port"));
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function run(file: string, args: string[], cwd: string): Promise<string> {
  return (await exec(file, args, { cwd, encoding: "utf8", timeout: TIMEOUT })).stdout;
}

async function waitFor<T>(read: () => Promise<T>, label: string): Promise<T> {
  const deadline = Date.now() + TIMEOUT;
  let last: unknown;
  while (Date.now() < deadline) {
    try { return await read(); } catch (error) { last = error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`${label}: ${last instanceof Error ? last.message : "timed out"}`);
}

async function makeRepository(root: string, name: string, port: number, alternate: boolean): Promise<Omit<FixtureProject, "id">> {
  const repositoryPath = join(root, name);
  await mkdir(repositoryPath);
  await writeFile(join(repositoryPath, "package.json"), JSON.stringify({ private: true, scripts: { dev: "node server.mjs" } }));
  const writeServer = (marker: string) => writeFile(join(repositoryPath, "server.mjs"), `
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
const identity = { marker: ${JSON.stringify(marker)}, pid: process.pid, boot: randomUUID() };
createServer((_, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(identity)); })
  .listen(Number(process.env.PORT), "127.0.0.1");
`);
  await writeServer(`${name}:main`);
  await run("git", ["init", "-q", "-b", "main"], repositoryPath);
  await run("git", ["-c", "user.name=Integration", "-c", "user.email=integration@example.invalid", "add", "."], repositoryPath);
  await run("git", ["-c", "user.name=Integration", "-c", "user.email=integration@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "main"], repositoryPath);
  const worktrees = [repositoryPath];
  if (alternate) {
    const alternatePath = join(root, `${name}-feature`);
    await run("git", ["worktree", "add", "-qb", "feature", alternatePath], repositoryPath);
    await writeFile(join(alternatePath, "server.mjs"), (await readFile(join(alternatePath, "server.mjs"), "utf8")).replace(`${name}:main`, `${name}:feature`));
    await run("git", ["-c", "user.name=Integration", "-c", "user.email=integration@example.invalid", "add", "server.mjs"], alternatePath);
    await run("git", ["-c", "user.name=Integration", "-c", "user.email=integration@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "feature"], alternatePath);
    worktrees.push(alternatePath);
  }
  return { name, port, repositoryPath, worktrees };
}

export async function startControllerFixture(): Promise<ControllerFixture> {
  const cli = resolve("dist/cli/index.js");
  const webRoot = resolve("out");
  if (!existsSync(cli) || !existsSync(join(webRoot, "index.html"))) throw new Error("Build artifacts are missing; run pnpm build first.");
  const root = await mkdtemp(join(tmpdir(), "worktree-switcher-integration-"));
  const data = join(root, "data");
  const state = join(root, "state");
  await Promise.all([mkdir(data), mkdir(state)]);
  const projectPorts = await Promise.all([freePort(), freePort(), freePort()]);
  const definitions = await Promise.all([
    makeRepository(root, "alpha", projectPorts[0], true),
    makeRepository(root, "beta", projectPorts[1], false),
    makeRepository(root, "gamma", projectPorts[2], false),
  ]);
  const common = ["--data-dir", data, "--state-dir", state];
  for (const definition of definitions) {
    await run(process.execPath, [cli, "project", "add", definition.repositoryPath, "--name", definition.name, "--port", String(definition.port), "--preset", "node", ...common], root);
  }
  const listed = JSON.parse(await run(process.execPath, [cli, "project", "list", "--json", ...common], root)) as Array<{ id: string; name: string }>;
  const projects = definitions.map((definition) => ({ ...definition, id: listed.find(({ name }) => name === definition.name)!.id }));
  const dashboardPort = await freePort();
  const mcpPort = await freePort();
  let stderr = "";
  const controller = spawn(process.execPath, [cli, "start", "--service-mode", "--no-open", "--host", "127.0.0.1", "--port", String(dashboardPort), "--mcp-port", String(mcpPort), "--browse-root", root, "--web-root", webRoot, ...common], {
    cwd: root, env: { ...process.env, LANG: "C.UTF-8" }, stdio: ["ignore", "ignore", "pipe"],
  });
  controller.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  const access = await waitFor(async () => {
    if (controller.exitCode !== null) throw new Error(`controller exited: ${stderr}`);
    return JSON.parse(await readFile(join(state, "service-access.json"), "utf8")) as { accessUrl: string };
  }, "controller readiness");
  const paired = new URL(access.accessUrl);
  const token = new URLSearchParams(paired.hash.slice(1)).get("token");
  if (!token) throw new Error("Pairing token missing");
  const baseUrl = `http://127.0.0.1:${dashboardPort}`;
  const request = (path: string, init: RequestInit = {}) => fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-Worktree-Switcher-Token": token, ...init.headers },
  });
  const dashboard = async () => {
    const response = await request("/api/dashboard");
    if (!response.ok) throw new Error(`dashboard returned ${response.status}`);
    return response.json() as Promise<ControllerDashboardResponse>;
  };
  const identity = (project: FixtureProject) => waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${project.port}/`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  }, `${project.name} health`);
  const operate = (project: FixtureProject, operation: "start" | "stop" | "restart" | "switch", worktreePath?: string) => request(`/api/projects/${project.id}/operation`, {
    method: "POST", body: JSON.stringify({ operation, ...(worktreePath ? { worktreePath } : {}) }),
  });
  const stopController = async (child: ChildProcess) => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const result = await Promise.race([new Promise<boolean>((resolveExit) => child.once("exit", () => resolveExit(true))), new Promise<boolean>((resolveExit) => setTimeout(() => resolveExit(false), 15_000))]);
    if (!result) throw new Error("Controller failed graceful shutdown");
  };
  return {
    baseUrl, pairedUrl: access.accessUrl, projects, request, dashboard, identity, operate,
    async close() {
      try { await stopController(controller); } finally { await rm(root, { recursive: true, force: true }); }
    },
  };
}

export async function expectUnavailable(project: FixtureProject): Promise<void> {
  await waitFor(async () => {
    try { await fetch(`http://127.0.0.1:${project.port}/`, { signal: AbortSignal.timeout(300) }); } catch { return; }
    throw new Error("listener remains available");
  }, `${project.name} shutdown`);
}
