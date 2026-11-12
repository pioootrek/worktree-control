import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import type { SandboxDescriptor } from "../../src/cli/sandbox";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const cli = join(repositoryRoot, "dist/cli/index.js");
const running: ChildProcess[] = [];

afterEach(async () => {
  for (const child of running.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise(resolveExit => child.once("exit", resolveExit));
    }
  }
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Starts the built CLI the way an external suite does: stdin is a pipe it holds open. */
async function startSandbox(environment: Record<string, string> = {}) {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: "C.UTF-8", NODE_ENV: "production", ...environment } as NodeJS.ProcessEnv;
  const child: ChildProcess = spawn(process.execPath, [cli, "sandbox", "--project-name", "Integration"], {
    cwd: repositoryRoot, env, stdio: ["pipe", "pipe", "pipe"],
  });
  running.push(child);
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exit = new Promise<number | null>(resolveExit => child.once("exit", (code: number | null) => resolveExit(code)));
  const lines = createInterface({ input: child.stdout! });
  const first = await Promise.race([
    new Promise<string>(resolveLine => lines.once("line", resolveLine)),
    exit.then(code => { throw new Error(`sandbox exited (${code}) before its descriptor:\n${stderr}`); }),
  ]);
  return { child, exit, descriptor: JSON.parse(first) as SandboxDescriptor, stderr: () => stderr };
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
    }
  });
});
