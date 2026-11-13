import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import type { SandboxDescriptor } from "../../src/cli/sandbox";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const cli = join(repositoryRoot, "dist/cli/index.js");
const running: ChildProcess[] = [];
const parents: string[] = [];

afterEach(async () => {
  for (const child of running.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise(resolveExit => child.once("exit", resolveExit));
    }
  }
  // A failed test must not leave a controller behind for the next one.
  for (const parent of parents.splice(0)) {
    for (const pid of processesMentioning(parent)) process.kill(pid, "SIGKILL");
    rmSync(parent, { recursive: true, force: true });
  }
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Processes whose command line contains `text`; every sandbox controller names its directory there. */
function processesMentioning(text: string): number[] {
  if (!existsSync("/proc/self/cmdline")) return [];
  return readdirSync("/proc").filter(entry => /^\d+$/.test(entry) && Number(entry) !== process.pid).filter(entry => {
    try { return readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(text); } catch { return false; }
  }).map(Number);
}

/** No controller runs from the sandbox parent directory and nothing is left inside it. */
function expectNoLeftovers(parent: string) {
  expect(processesMentioning(parent)).toEqual([]);
  expect(readdirSync(parent)).toEqual([]);
}

/** Starts the built CLI the way an external suite does: stdin is a pipe it holds open. */
function spawnSandbox(environment: Record<string, string> = {}) {
  // Each sandbox gets its own temporary parent, so a test sees exactly what that sandbox leaves.
  const parent = mkdtempSync(join(tmpdir(), "worktree-control-sandbox-integration-"));
  parents.push(parent);
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: "C.UTF-8", NODE_ENV: "production", TMPDIR: parent, ...environment } as NodeJS.ProcessEnv;
  const child: ChildProcess = spawn(process.execPath, [cli, "sandbox", "--project-name", "Integration"], {
    cwd: repositoryRoot, env, stdio: ["pipe", "pipe", "pipe"],
  });
  running.push(child);
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exit = new Promise<number | null>(resolveExit => child.once("exit", (code: number | null) => resolveExit(code)));
  return { child, exit, parent, stderr: () => stderr };
}

async function startSandbox(environment: Record<string, string> = {}) {
  const sandbox = spawnSandbox(environment);
  const lines = createInterface({ input: sandbox.child.stdout! });
  const first = await Promise.race([
    new Promise<string>(resolveLine => lines.once("line", resolveLine)),
    sandbox.exit.then(code => { throw new Error(`sandbox exited (${code}) before its descriptor:\n${sandbox.stderr()}`); }),
  ]);
  return { ...sandbox, descriptor: JSON.parse(first) as SandboxDescriptor };
}

describe("worktree-control sandbox", () => {
  it("serves Knowledge over HTTP and MCP, then removes everything when its input closes", async () => {
    const sandbox = await startSandbox({ WORKTREE_CONTROL_DATA_DIR: "/nonexistent/must-not-be-used" });
    const { descriptor } = sandbox;
    expect(descriptor.format).toBe("worktree-control-sandbox/1");
    expect(new URL(descriptor.url).hostname).toBe("127.0.0.1");
    expect(existsSync(descriptor.dataDirectory)).toBe(true);
    expect(alive(descriptor.pid)).toBe(true);

    const knowledge = async (token: string, operation: string, input: Record<string, unknown>) => fetch(`${descriptor.url}/api/knowledge`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ operation, input }),
    });
    const created = await knowledge(descriptor.agent.token, "create_task", { projectId: descriptor.project.id, idempotencyKey: "sandbox", title: "Sandbox task", description: "From the integration test" });
    expect(created.status).toBe(200);
    const task = (await created.json() as { value: { id: string; revision: number } }).value;
    // The installation token acts as the owner of every project.
    const read = await knowledge(descriptor.installationToken, "task", { projectId: descriptor.project.id, taskId: task.id });
    expect(read.status).toBe(200);
    expect(await knowledge("wrong", "task", { projectId: descriptor.project.id, taskId: task.id })).toHaveProperty("status", 401);

    const client = new Client({ name: "sandbox-integration", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(descriptor.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${descriptor.agent.token}` } } }));
    try {
      const result = await client.callTool({ name: "knowledge_task", arguments: { projectId: descriptor.project.id, taskId: task.id } });
      expect(JSON.stringify(result.content)).toContain("Sandbox task");
    } finally {
      await client.close();
    }

    sandbox.child.stdin!.end();
    expect(await sandbox.exit).toBe(0);
    expect(alive(descriptor.pid)).toBe(false);
    expect(existsSync(join(descriptor.dataDirectory, ".."))).toBe(false);
    expectNoLeftovers(sandbox.parent);
  });

  it("stops on SIGTERM and gives each sandbox its own installation", async () => {
    const [first, second] = [await startSandbox(), await startSandbox()];
    expect(first.descriptor.url).not.toBe(second.descriptor.url);
    expect(first.descriptor.project.id).not.toBe(second.descriptor.project.id);
    const crossed = await fetch(`${second.descriptor.url}/api/knowledge`, {
      method: "POST", headers: { Authorization: `Bearer ${first.descriptor.agent.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "project", input: { projectId: second.descriptor.project.id } }),
    });
    expect(crossed.status).toBe(401);
    for (const sandbox of [first, second]) {
      sandbox.child.kill("SIGTERM");
      expect(await sandbox.exit).toBe(0);
      expect(alive(sandbox.descriptor.pid)).toBe(false);
      expect(existsSync(join(sandbox.descriptor.dataDirectory, ".."))).toBe(false);
      expectNoLeftovers(sandbox.parent);
    }
  });

  it("finishes stopping when signals repeat", async () => {
    const sandbox = await startSandbox();
    sandbox.child.kill("SIGTERM");
    // Keep interrupting, like a repeated Ctrl-C, for as long as the sandbox is stopping.
    let sent = 0;
    const repeat = setInterval(() => sandbox.child.kill(sent++ % 2 ? "SIGHUP" : "SIGINT"), 25);
    try {
      expect(await sandbox.exit).toBe(0);
    } finally {
      clearInterval(repeat);
    }
    expect(alive(sandbox.descriptor.pid)).toBe(false);
    expectNoLeftovers(sandbox.parent);
  });

  it("stops and removes everything when its standard output is closed before the descriptor", async () => {
    const sandbox = spawnSandbox();
    sandbox.child.stdout!.destroy();
    expect(await sandbox.exit).toBe(1);
    expect(sandbox.stderr()).toContain("standard output was closed");
    expectNoLeftovers(sandbox.parent);
  });
});
