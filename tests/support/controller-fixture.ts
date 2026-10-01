import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const exec = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const WAIT_MS = 15_000;
export type ServerMode = "normal" | "gate" | "early-exit" | "timeout" | "stubborn-descendant";
export type FixtureProjectKind = "node" | "django";
export interface FixtureProject { id: string; name: string; port: number; main: string; alternate: string; kind: FixtureProjectKind }
export interface FixtureTestEvent { event: "start" | "finish" | "cancel"; identity: string; mode: string; pid: number; at: number }
export interface HttpResult<T> { status: number; ok: boolean; body: T & { error?: string } }
export interface FixtureMcpClient { call<T>(name: string, args?: Record<string, unknown>): Promise<T>; close(): Promise<void> }
export interface ControllerFixture {
  endpoint: string; accessUrl: string; projects: FixtureProject[];
  /** New installations run in token mode; this installation token authorizes every transport. */
  installationToken: string;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  requestResult<T>(path: string, init?: RequestInit): Promise<HttpResult<T>>;
  mcp(token?: string): Promise<FixtureMcpClient>;
  cli(args: string[], environment?: Record<string, string>, pathMode?: "environment" | "flags", currentDirectory?: string): Promise<string>;
  setMode(project: FixtureProject, mode: ServerMode, worktreePath?: string): Promise<void>;
  releaseGate(project: FixtureProject, worktreePath?: string): Promise<void>;
  releaseTestGate(project: FixtureProject, worktreePath?: string): Promise<void>;
  testEvents(project: FixtureProject): Promise<FixtureTestEvent[]>;
  ownedPids(project: FixtureProject, worktreePath?: string): Promise<number[]>;
  restart(): Promise<void>; stop(): Promise<void>; close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate fixture port."));
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}
async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } });
}
async function createRepository(base: string, name: string, kind: FixtureProjectKind): Promise<{ main: string; alternate: string }> {
  const main = join(base, name), alternate = join(base, `${name}-alternate`);
  const testControl = join(base, "test-control");
  await mkdir(testControl, { recursive: true });
  await mkdir(main); await git(main, "init", "-b", "main");
  await writeFile(join(main, "package.json"), JSON.stringify({
    packageManager: "npm@11.0.0",
    scripts: { dev: "node server.mjs", test: "node test-runner.mjs pass", "test:hold": "node test-runner.mjs hold", "test:fail": "node test-runner.mjs fail" },
  }));
  await writeFile(join(main, "identity.txt"), `${name}:main`); await writeFile(join(main, "mode.txt"), "normal");
  await writeFile(join(main, "server.mjs"), [
    'import { appendFileSync, existsSync, readFileSync } from "node:fs";', 'import { spawn } from "node:child_process";', 'import { createServer } from "node:http";', 'import { randomUUID } from "node:crypto";',
    'const identity = readFileSync(new URL("./identity.txt", import.meta.url), "utf8").trim();',
    'const mode = readFileSync(new URL("./mode.txt", import.meta.url), "utf8").trim();', 'const boot = randomUUID();',
    'appendFileSync(new URL("./process-evidence.log", import.meta.url), `parent ${process.pid}\n`);',
    'if (mode === "early-exit") process.exit(7);',
    'if (mode === "stubborn-descendant") { const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"], { detached: false, stdio: "ignore" }); appendFileSync(new URL("./process-evidence.log", import.meta.url), `descendant ${child.pid}\n`); }',
    'if (mode === "gate") while (!existsSync(new URL("./release.txt", import.meta.url))) await new Promise(r => setTimeout(r, 25));',
    'const server = createServer((request, response) => { if (mode === "timeout") { response.statusCode = 503; response.end("not ready"); return; } response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ identity, boot, pid: process.pid })); });',
    'if (mode === "timeout") process.on("SIGTERM", () => {});', 'server.listen(Number(process.env.PORT), "127.0.0.1");',
  ].join("\n"));
  await writeFile(join(main, "test-runner.mjs"), [
    'import { appendFileSync, existsSync, readFileSync } from "node:fs";',
    `const control = ${JSON.stringify(testControl)};`,
    `const evidence = ${JSON.stringify(join(testControl, `${name}.jsonl`))};`,
    'const identity = readFileSync(new URL("./identity.txt", import.meta.url), "utf8").trim();',
    'const mode = process.argv[2] ?? "pass";',
    'const record = (event) => appendFileSync(evidence, `${JSON.stringify({ event, identity, mode, pid: process.pid, at: Date.now() })}\\n`);',
    'record("start"); console.log(`verification ${identity} ${mode}`);',
    'process.on("SIGTERM", () => { record("cancel"); process.exit(0); });',
    'if (mode === "hold") { const release = `${control}/${identity}.release`; while (!existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 25)); }',
    'if (mode === "fail") { console.error(`verification failed ${identity}`); process.exitCode = 9; }',
    'record("finish");',
  ].join("\n"));
  if (kind === "django") {
    await writeFile(join(main, "manage.py"), [
      "import json", "import os", "import pathlib", "import sys", "import time",
      `evidence = pathlib.Path(${JSON.stringify(join(testControl, `${name}.jsonl`))})`,
      "identity = pathlib.Path(__file__).with_name('identity.txt').read_text().strip()",
      "if len(sys.argv) < 2 or sys.argv[1] != 'test': raise SystemExit(2)",
      "evidence.open('a').write(json.dumps({'event': 'start', 'identity': identity, 'mode': 'django', 'pid': os.getpid(), 'at': int(time.time() * 1000)}) + '\\n')",
      "print(f'django verification {identity}')",
      "evidence.open('a').write(json.dumps({'event': 'finish', 'identity': identity, 'mode': 'django', 'pid': os.getpid(), 'at': int(time.time() * 1000)}) + '\\n')",
    ].join("\n"));
  }
  await git(main, "add", "."); await git(main, "commit", "-m", "fixture main");
  await git(main, "worktree", "add", "-b", "alternate", alternate);
  await writeFile(join(alternate, "identity.txt"), `${name}:alternate`); await git(alternate, "add", "identity.txt"); await git(alternate, "commit", "-m", "fixture alternate");
  return { main, alternate };
}

export async function startControllerFixture(projectCount = 3, projectKinds: FixtureProjectKind[] = [], options: { backups?: boolean } = {}): Promise<ControllerFixture> {
  const base = await mkdtemp(join(tmpdir(), "worktree-switcher-integration-"));
  const data = join(base, "data"), state = join(base, "state"); await Promise.all([mkdir(data, { mode: 0o700 }), mkdir(state, { mode: 0o700 })]);
  const kinds = Array.from({ length: projectCount }, (_, index) => projectKinds[index] ?? "node");
  const repositories = await Promise.all(Array.from({ length: projectCount }, (_, index) => createRepository(base, `project-${String.fromCharCode(97 + index)}`, kinds[index]!)));
  const ports = await Promise.all(Array.from({ length: projectCount + 2 }, () => freePort()));
  const controllerPort = ports.pop()!, mcpPort = ports.pop()!;
  let child: ChildProcess | undefined, endpoint = `http://127.0.0.1:${controllerPort}`, accessUrl = "";
  const generated = await exec(process.execPath, [join(repositoryRoot, "dist/cli/index.js"), "auth", "token", "generate"], {
    cwd: repositoryRoot, env: { ...process.env, WORKTREE_SWITCHER_DATA_DIR: data, WORKTREE_SWITCHER_STATE_DIR: state }, timeout: 30000,
  });
  const token = (JSON.parse(generated.stdout) as { token: string }).token;
  const start = async () => {
    let output = "";
    child = spawn(process.execPath, [join(repositoryRoot, "dist/cli/index.js"), "start", "--service-mode", "--host", "127.0.0.1", "--port", String(controllerPort), "--mcp-port", String(mcpPort), "--no-open", "--data-dir", data, "--state-dir", state, "--browse-root", base, "--web-root", join(repositoryRoot, "out"), ...(options.backups ? ["--backup-dir", join(base, "backups"), "--backup-ui-actions", "create,restore"] : [])], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk) => { output += chunk.toString(); }); child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
    const access = await waitFor(async () => { try { return JSON.parse(await readFile(join(state, "service-access.json"), "utf8")) as { accessUrl: string }; } catch { return null; } }, WAIT_MS, () => `Controller did not publish service access.\n${output}`);
    // Token mode publishes no secret; the browser receives the installation token in the fragment.
    endpoint = new URL(access.accessUrl).origin; accessUrl = `${endpoint}/#token=${encodeURIComponent(token)}`;
  };
  const stop = async () => {
    if (!child) return;
    const current = child;
    try { await closeFixtureChild(current); }
    finally { child = undefined; }
  };
  const requestResult = async <T>(path: string, init: RequestInit = {}): Promise<HttpResult<T>> => {
    const response = await fetch(`${endpoint}${path}`, { ...init, headers: { "content-type": "application/json", origin: endpoint, "x-worktree-switcher-token": token, ...init.headers } });
    return { status: response.status, ok: response.ok, body: await response.json() as T & { error?: string } };
  };
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => { const result = await requestResult<T>(path, init); if (!result.ok) throw new Error(result.body.error ?? `HTTP ${result.status}`); return result.body; };
  try {
    await start(); const projects: FixtureProject[] = [];
    for (let index = 0; index < repositories.length; index += 1) {
      const name = `project-${String.fromCharCode(97 + index)}`;
      const result = await request<{ project: { id: string } }>("/api/projects", { method: "POST", body: JSON.stringify({ name, repositoryPath: repositories[index]!.main, port: ports[index], launchPreset: kinds[index] }) });
      projects.push({ id: result.project.id, name, port: ports[index]!, kind: kinds[index]!, ...repositories[index]! });
    }
    const fixture: ControllerFixture = { endpoint, accessUrl, projects, request, requestResult, installationToken: token,
      async mcp(scopedToken?: string) {
        const mcpToken = scopedToken ?? token; const client = new Client({ name: `capacity-${randomUUID()}`, version: "1" });
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } } }));
        return { async call<T>(name: string, args: Record<string, unknown> = {}) {
          const result = await client.callTool({ name, arguments: args });
          const content = (result as { content?: unknown }).content;
          if (!Array.isArray(content)) throw new Error(`${name} returned no content`);
          const part = content.find((item: unknown): item is { type: "text"; text: string } =>
            typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string");
          if (!part) throw new Error(`${name} returned no JSON`);
          if ((result as { isError?: boolean }).isError) {
            try {
              const value = JSON.parse(part.text) as { error?: string };
              throw new Error(value.error ?? `${name} failed`);
            } catch (error) {
              if (error instanceof SyntaxError) throw new Error(part.text);
              throw error;
            }
          }
          const value = JSON.parse(part.text) as T & { error?: string };
          return value;
        }, close: () => client.close() };
      },
      async cli(args, environment = {}, pathMode = "environment", currentDirectory = repositoryRoot) {
        const pathArgs = pathMode === "flags" ? ["--data-dir", data, "--state-dir", state] : [];
        const result = await exec(process.execPath, [join(repositoryRoot, "dist/cli/index.js"), ...args, ...pathArgs], {
          cwd: currentDirectory, env: { ...process.env, WORKTREE_SWITCHER_TOKEN: token, ...environment, WORKTREE_SWITCHER_DATA_DIR: pathMode === "flags" ? undefined : data, WORKTREE_SWITCHER_STATE_DIR: pathMode === "flags" ? undefined : state }, timeout: 30000,
        });
        return result.stdout;
      },
      async setMode(project, mode, worktreePath = project.main) { await writeFile(join(worktreePath, "mode.txt"), mode); await unlink(join(worktreePath, "release.txt")).catch(() => undefined); },
      async releaseGate(project, worktreePath = project.main) { await writeFile(join(worktreePath, "release.txt"), "go"); },
      async releaseTestGate(project, worktreePath = project.main) {
        const identity = (await readFile(join(worktreePath, "identity.txt"), "utf8")).trim();
        await writeFile(join(base, "test-control", `${identity}.release`), "go");
      },
      async testEvents(project) {
        const contents = await readFile(join(base, "test-control", `${project.name}.jsonl`), "utf8").catch(() => "");
        return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line) as FixtureTestEvent);
      },
      async ownedPids(project, worktreePath = project.main) {
        const evidence = await readFile(join(worktreePath, "process-evidence.log"), "utf8").catch(() => "");
        return evidence.split("\n").flatMap((line) => { const pid = Number(line.split(" ")[1]); return Number.isInteger(pid) && pid > 0 ? [pid] : []; });
      },
      async restart() { await stop(); await start(); fixture.endpoint = endpoint; fixture.accessUrl = accessUrl; }, stop,
      async close() { try { await stop(); } finally { await rm(base, { recursive: true, force: true }); } },
    }; return fixture;
  } catch (error) { await stop().catch(() => undefined); await rm(base, { recursive: true, force: true }); throw error; }
}

export async function endpointIdentity(project: FixtureProject, expectedIdentity?: string): Promise<{ identity: string; boot: string; pid: number }> {
  return waitFor(async () => { try { const response = await fetch(`http://127.0.0.1:${project.port}`); if (!response.ok) return null; const identity = await response.json() as { identity: string; boot: string; pid: number }; return expectedIdentity && identity.identity !== expectedIdentity ? null : identity; } catch { return null; } }, 10_000, () => `Project ${project.name} did not become ready${expectedIdentity ? ` as ${expectedIdentity}` : ""}.`);
}
export async function endpointUnavailable(project: FixtureProject, timeoutMs = 10_000): Promise<void> {
  await waitFor(() => connectionRefused(project.port), timeoutMs, () => `Project ${project.name} listener closure remained unconfirmed.`);
}
async function connectionRefused(port: number): Promise<true | null> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value: true | null) => { socket.destroy(); resolveProbe(value); };
    socket.setTimeout(500, () => finish(null));
    socket.once("connect", () => finish(null));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED" ? true : null));
  });
}
export async function closeFixtureChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode !== 0) throw new Error(`Fixture controller exited uncleanly (${child.exitCode ?? child.signalCode}).`);
    return;
  }
  child.kill("SIGTERM");
  try {
    await waitFor(() => child.exitCode !== null || child.signalCode !== null ? true : null, WAIT_MS, () => "Fixture controller did not shut down cleanly.");
  } catch (error) {
    child.kill("SIGKILL");
    await waitFor(() => child.exitCode !== null || child.signalCode !== null ? true : null, 5_000, () => "Fixture controller survived SIGKILL.");
    throw error;
  }
  if (child.exitCode !== 0) throw new Error(`Fixture controller exited uncleanly (${child.exitCode ?? child.signalCode}).`);
}
export async function waitFor<T>(read: () => T | null | Promise<T | null>, timeoutMs: number, error: () => string): Promise<T> { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const value = await read(); if (value !== null) return value; await new Promise((resolveWait) => setTimeout(resolveWait, 50)); } throw new Error(error()); }
