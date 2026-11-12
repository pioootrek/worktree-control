import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Worktree } from "@/shared/contracts";
import { listenAdminSocket, requestAdminSocket } from "../server/admin-socket";
import { parseTestRunAdminRequest, testRunAdminHandler } from "../server/bootstrap/test-run-administration";
import { admissionOf } from "../server/database-admission";
import { nullLogWriter } from "../server/log-writer";
import { TestRunAdministration } from "../server/modules/verification";
import { SqliteStateStore } from "../server/sqlite-store";
import { TestJobManager } from "../server/test-job-manager";
import { parseTestRunArgs, runTestRunCommand } from "./test-run-administration";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** The real CLI → owner socket → application → finite-job owner path, with a managed fixture process. */
async function controller(options: { maintenance?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wtc-cli-run-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStateStore(join(root, "state.sqlite3"));
  const project = store.addProject({ name: "App", repositoryPath: root, port: 3292, executable: "node", args: [] });
  const manager = new TestJobManager(store, { ...nullLogWriter });
  cleanups.push(async () => { await manager.shutdown().catch(() => undefined); store.close(); });
  const handler = testRunAdminHandler({
    administration: new TestRunAdministration({ jobs: manager, audit: store, admission: admissionOf(store),
      operator: () => ({ kind: "local-admin-socket", uid: process.getuid?.() ?? null, user: "cli-test" }) }),
    maintenance: () => options.maintenance ?? false,
  });
  const socketPath = join(root, "state", "admin.sock");
  const admin = await listenAdminSocket(socketPath, body => handler(body));
  cleanups.push(() => admin.close());
  const worktree: Worktree = { path: join(root, "wt"), head: "abcdef1", shortHead: "abcdef1", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
  const run = manager.enqueue({
    projectId: project.id, worktree, actor: "agent:mcp:lost-session",
    environment: { environment: { SECRET_TOKEN: "do-not-print" }, mode: "clean", profile: "unit", inheritedServerProfile: null, variableNames: ["SECRET_TOKEN"] },
    command: { preset: { id: "node:test", name: "test", adapter: "node", timeoutMs: 60_000 }, executable: process.execPath,
      args: ["-e", "console.log('pid:' + process.pid); setInterval(() => {}, 1000)"], cwd: root },
  });
  let pid = 0;
  await vi.waitFor(() => {
    const line = store.getTestRun(run.id)?.logs.find(value => value.startsWith("pid:"));
    expect(line).toBeTruthy();
    pid = Number(line!.slice(4));
  }, { timeout: 5_000 });
  return { root, store, project, manager, socketPath, run, pid };
}

function capture() {
  const lines: string[] = [];
  return { lines, write: (line: string) => { lines.push(line); }, json: () => JSON.parse(lines.join("\n")) as Record<string, unknown> };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("test-run CLI", () => {
  it("inspects and stops one run through the owner socket and the managed process owner", async () => {
    const { socketPath, run, pid, project, store } = await controller();
    const inspected = capture();
    expect(await runTestRunCommand(["inspect", run.id, "--project", project.id], socketPath, inspected)).toBe(0);
    expect(inspected.json()).toMatchObject({ found: true, resolution: { state: "pending", reason: "running", stopEffect: "cancel" },
      ownership: { processGroup: "owned_live" }, run: { phase: "running", requesterKind: "agent" } });

    const stopped = capture();
    const code = await runTestRunCommand(["stop", run.id, "--reason", "credential rotated", "--wait-seconds", "20", "--request-id", "cli-request-0001"], socketPath, stopped);

    expect(code).toBe(0);
    expect(stopped.json()).toMatchObject({ requestId: "cli-request-0001", action: "cancel", outcome: "confirmed", reason: "finalized", run: { phase: "cancelled" } });
    expect(alive(pid)).toBe(false);
    const printed = inspected.lines.join("\n") + stopped.lines.join("\n");
    expect(printed).not.toContain("do-not-print");
    expect(printed).not.toContain("lost-session");
    expect(store.listTestRunAdministration(run.id, 10).map(record => record.requestId)).toEqual(["cli-request-0001", "cli-request-0001"]);

    const repeated = capture();
    expect(await runTestRunCommand(["stop", run.id, "--reason", "credential rotated", "--request-id", "cli-request-0001"], socketPath, repeated)).toBe(0);
    expect(repeated.json()).toMatchObject({ action: "none", outcome: "confirmed" });
  });

  it("maps pending and unresolved outcomes to distinct exit codes", async () => {
    const { socketPath } = await controller();
    const missing = capture();
    expect(await runTestRunCommand(["stop", "00000000-0000-4000-8000-000000000000", "--reason", "cleanup"], socketPath, missing)).toBe(3);
    expect(missing.json()).toMatchObject({ outcome: "unresolved", reason: "run_not_found" });
    expect(await runTestRunCommand(["inspect", "00000000-0000-4000-8000-000000000000"], socketPath, capture())).toBe(3);
    const pending = vi.fn(async () => ({ outcome: "pending" }));
    expect(await runTestRunCommand(["stop", "run-1", "--reason", "cleanup", "--wait-seconds", "0"], "/unused", { write: () => undefined, request: pending })).toBe(2);
    expect(pending).toHaveBeenCalledWith("/unused", expect.objectContaining({ waitMs: 0, requestId: expect.stringMatching(/^cli-/) }), 20_000, 128 * 1024);
  });

  it("fails closed without a running controller and never opens the database", async () => {
    const root = mkdtempSync(join(tmpdir(), "wtc-cli-run-missing-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    await expect(runTestRunCommand(["inspect", "run-1"], join(root, "admin.sock"), capture())).rejects.toMatchObject({ code: "controller_unavailable" });
    // The CLI module only talks to the socket: no store, lock or process-signalling dependency.
    const source = readFileSync(resolve(import.meta.dirname, "test-run-administration.ts"), "utf8");
    expect(source).not.toMatch(/sqlite|controller-lock|controller-storage|process\.kill|test-job-manager/);
  });

  it("rejects actor, credential and malformed fields at the socket and refuses during maintenance", async () => {
    const { socketPath, run, pid } = await controller();
    const stop = { command: "test-run-admin", action: "stop", runId: run.id, reason: "cleanup", waitMs: 0, requestId: "request-0001" };
    for (const body of [
      { ...stop, actor: "local-user" },
      { ...stop, token: "wtc_secret" },
      { ...stop, sessionId: "original" },
      { ...stop, reason: "x" },
      { ...stop, reason: "line\nbreak" },
      { ...stop, waitMs: 120_001 },
      { ...stop, requestId: "short" },
      { ...stop, runId: "../escape" },
      { command: "test-run-admin", action: "inspect", runId: run.id, extra: true },
      { command: "test-run-admin", action: "kill", runId: run.id },
    ]) {
      await expect(requestAdminSocket(socketPath, body)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(alive(pid)).toBe(true);
    expect(() => parseTestRunAdminRequest({ ...stop, projectId: "p1" })).not.toThrow();

    const maintenance = await controller({ maintenance: true });
    await expect(requestAdminSocket(maintenance.socketPath, { command: "test-run-admin", action: "inspect", runId: maintenance.run.id }))
      .rejects.toMatchObject({ code: "maintenance" });
    expect(alive(maintenance.pid)).toBe(true);
  });

  it("parses a narrow argument set", () => {
    expect(parseTestRunArgs(["stop", "run-1", "--reason", "orphan", "--wait-seconds", "5"])).toEqual({ action: "stop", runId: "run-1", reason: "orphan", waitSeconds: 5 });
    expect(() => parseTestRunArgs(["stop", "run-1"])).toThrow("--reason");
    expect(() => parseTestRunArgs(["stop", "run-1", "--reason", "x", "--wait-seconds", "121"])).toThrow("--wait-seconds");
    expect(() => parseTestRunArgs(["inspect", "run-1", "--reason", "x"])).toThrow("Usage");
    expect(() => parseTestRunArgs(["kill", "run-1"])).toThrow("Usage");
    expect(() => parseTestRunArgs(["stop", "run-1", "--reason", "a", "--reason", "b"])).toThrow("Usage");
  });

  it("is not reachable through the public HTTP or MCP transports", () => {
    for (const file of ["../server/http-server.ts", "../server/mcp-http-server.ts"]) {
      const source = readFileSync(resolve(import.meta.dirname, file), "utf8");
      expect(source).not.toMatch(/test-run-admin|TestRunAdministration|administrativeStop/);
    }
  });
});
