import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ControlService } from "@/server/control-service";
import { createMcpControllerServer } from "@/server/mcp-http-server";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { execFileSync, fork } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "@/server/sqlite-store";
import { IdentityService } from "@/server/modules/identity";
import { ProjectLifecycle } from "@/server/modules/lifecycle";
import { GitCommandAdmission, SystemGitWorktreeReader } from "@/server/git-worktrees";
import { SystemRemoteVerificationWorkspacePreparer, SystemRemoteWorkerExecution } from "@/server/infrastructure/git";
import { ProcessManager } from "@/server/process-manager";
import { TestJobManager } from "@/server/test-job-manager";
import { nullLogWriter } from "@/server/log-writer";
import { NodeTestCommandAdapter, ProjectTestCommandResolver } from "@/server/test-command";
import { createRemoteVerificationServer, HttpRemoteWorkerTransport } from "@/server/transports/remote-verification-http";
import { RemoteVerificationController } from "./remote-verification-controller";
import { RemoteVerificationWorker } from "./remote-worker";
import { REMOTE_REPORT_MAX_ENVELOPE_BYTES } from "@/shared/contracts/remote-verification";
import type { RemoteWorkerReport } from "@/shared/contracts/remote-verification";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.unstubAllEnvs(); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
class FixtureNodeAdapter extends NodeTestCommandAdapter {
  override resolve(path: string, presetId: string) { const resolved = super.resolve(path, presetId); return { ...resolved, executable: process.execPath, args: ["check.cjs"] }; }
}

async function fixture(realCommands = false) {
  const root = mkdtempSync(join(tmpdir(), "wtc-connected-remote-"));
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git"), seed = join(root, "seed"), human = join(root, "human"), cache = join(root, "cache"), workspaces = join(root, "attempts");
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  git(seed, "config", "user.email", "fixture@example.invalid"); git(seed, "config", "user.name", "Fixture");
  writeFileSync(join(seed, "package.json"), JSON.stringify({ scripts: { test: "node check.cjs" } }));
  const commit = (script: string, message: string) => {
    writeFileSync(join(seed, "check.cjs"), script); git(seed, "add", "."); git(seed, "commit", "-qm", message); return git(seed, "rev-parse", "HEAD");
  };
  const failedSha = commit("console.log('FAIL:'+process.env.CONTROLLER_SECRET);process.exit(1)", "failing check");
  git(seed, "remote", "add", "origin", remote); git(seed, "push", "-q", "-u", "origin", "main");
  execFileSync("git", ["clone", "-q", remote, human]); execFileSync("git", ["clone", "-q", "--no-checkout", remote, cache]);
  const fixedSha = commit("for(let i=0;i<240;i++)console.log('x'.repeat(2100));console.log('PASS:'+process.env.CONTROLLER_SECRET);", "fixed check");
  git(seed, "push", "-q", "origin", "main");
  writeFileSync(join(human, "uncommitted.txt"), "preserve human work");
  const controllerStore = new SqliteStateStore(join(root, "controller.sqlite3"));
  const workerStore = new SqliteStateStore(join(root, "worker.sqlite3"));
  cleanup.push(async () => { workerStore.close(); controllerStore.close(); });
  const identity = new IdentityService(controllerStore);
  const ownerSession = identity.bootstrapOwnerSession();
  const owner = identity.authenticateBearer(ownerSession.token);
  const workerPrincipal = identity.createWorker(owner);
  const issued = identity.issueWorkerToken({ principalId: workerPrincipal.id, label: "fixture-only" }, owner);
  const workerActor = identity.authenticateBearer(issued.token);
  const local = workerStore.addProject({ name: "Worker fixture", repositoryPath: human, port: 3199, executable: "", args: [], launchPreset: "none" });
  const brokerLocal = controllerStore.addProject({ name: "Broker fixture identity", repositoryPath: seed, port: 3198, executable: "", args: [], launchPreset: "none" });
  for (const [store, localProjectId] of [[controllerStore, brokerLocal.id], [workerStore, local.id]] as const) {
    if (store === workerStore) store.saveRemotePrincipal(workerPrincipal, "fixture");
    store.saveRemoteProjectIdentity({ id: "remote-project", name: "Fixture", sourceRemote: "origin", status: "active" }, "fixture");
    store.saveRemoteWorker({ id: "worker", principalId: workerPrincipal.id, name: "Fixture", status: "active", lastContactAt: null }, "fixture");
    store.saveRemoteWorkerProjectGrant({ workerId: "worker", projectId: "remote-project", localProjectId, presetIds: ["node:test"], revokedAt: null }, "fixture");
  }
  controllerStore.saveRemotePrincipalProjectGrant({ principalId: owner.principalId, projectId: "remote-project", permissions: ["submit", "read"], revokedAt: null }, "fixture");
  const controller = new RemoteVerificationController(controllerStore, controllerStore.remoteConnection, identity);
  const server = createRemoteVerificationServer({ controller, identity, allowLoopbackHttpFixture: true });
  await new Promise<void>(resolve => server.server.listen(0, "127.0.0.1", resolve));
  cleanup.push(server.close);
  const origin = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
  const processes = new ProcessManager(() => undefined, nullLogWriter);
  const lifecycle = new ProjectLifecycle(workerStore, processes);
  const admission = new GitCommandAdmission();
  const reader = new SystemGitWorktreeReader(admission);
  const jobs = new TestJobManager(workerStore, nullLogWriter);
  let workerRetired = false;
  cleanup.push(async () => { if (!workerRetired) await jobs.shutdown(); reader.close(); });
  const mappings = [{ projectId: "remote-project", localProjectId: local.id, sourceCachePath: cache, sourceRemote: "origin", presetIds: ["node:test"] }];
  const execution = new SystemRemoteWorkerExecution("worker", mappings, workerStore, lifecycle, reader, new ProjectTestCommandResolver([realCommands ? new NodeTestCommandAdapter() : new FixtureNodeAdapter()]), new SystemRemoteVerificationWorkspacePreparer(workspaces, admission), workspaces);
  const httpTransport = new HttpRemoteWorkerTransport(origin, "worker", () => issued.token, true);
  let disconnected = false;
  let pollDisconnected = false;
  let loseAck = false;
  const transport = {
    poll: () => { if (pollDisconnected) return Promise.reject(new Error("fixture poll disconnected")); return httpTransport.poll(); },
    report: async (report: RemoteWorkerReport) => {
      if (disconnected) throw new Error("fixture upload disconnected");
      await httpTransport.report(report);
      if (loseAck) { loseAck = false; throw new Error("fixture ACK lost"); }
    },
  };
  const worker = new RemoteVerificationWorker("worker", workerStore.remoteConnection, jobs, id => workerStore.getTestRun(id), execution, transport);
  cleanup.push(() => worker.close());
  const submit = (sha: string, key = sha) => controller.submit({ projectId: "remote-project", workerId: "worker", commitSha: sha, presetId: "node:test", idempotencyKey: key }, owner);
  const finish = async (requestId: string) => {
    await vi.waitFor(async () => { await worker.tick(); expect(controller.status(requestId, owner).request.phase).toBe("completed"); }, { timeout: 15_000, interval: 40 });
    return controller.status(requestId, owner);
  };
  const retireWorker = async () => { await worker.close(); await jobs.shutdown(); workerStore.close(); workerRetired = true; };
  const connectMcp = async () => {
    const service = new ControlService(controllerStore, reader, processes, nullLogWriter, undefined, undefined, undefined, undefined, undefined, undefined, undefined, controller);
    const mcp = createMcpControllerServer({ service, port: 0, accessToken: "fixture-legacy-unused", identity });
    await new Promise<void>(resolve => mcp.server.listen(0, "127.0.0.1", resolve));
    cleanup.push(mcp.close);
    const endpoint = new URL(`http://127.0.0.1:${(mcp.server.address() as { port: number }).port}/mcp`);
    const client = new Client({ name: "remote-verification-fixture", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${ownerSession.token}` } } }));
    cleanup.push(() => client.close());
    return client;
  };
  return { root, seed, human, cache, workspaces, failedSha, fixedSha, connectMcp, retireWorker, controllerStore, workerStore, identity, owner, workerActor, issued, controller, server, origin, jobs, worker, transport, execution, mappings, submit, finish,
    disconnect: (value: boolean) => { disconnected = value; }, disconnectPoll: (value: boolean) => { pollDisconnected = value; }, loseAck: () => { loseAck = true; }, commit };
}

describe("connected remote verification (isolated fixtures, not real-worker acceptance)", () => {
  it("submits failing/fixed pushed commits and reads their results/logs through an actual MCP client and default command adapter", async () => {
    const f = await fixture(true);
    const client = await f.connectMcp();
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      "submit_remote_verification", "get_remote_verification", "get_remote_verification_logs", "cancel_remote_verification",
    ]));
    const call = async (name: string, args: Record<string, string>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      return JSON.parse(content[0].text);
    };
    const requests = [];
    for (const [sha, expected] of [[f.failedSha, "failed"], [f.fixedSha, "succeeded"]]) {
      const input = { projectId: "remote-project", workerId: "worker", commitSha: sha, presetId: "node:test", idempotencyKey: sha };
      const request = await call("submit_remote_verification", input);
      requests.push(request.id);
      expect((await call("submit_remote_verification", input)).id).toBe(request.id);
      await vi.waitFor(async () => {
        await f.worker.tick();
        const status = await call("get_remote_verification", { requestId: request.id });
        expect(status.attempt).toMatchObject({ phase: expected, executedCommitSha: sha });
      }, { timeout: 15_000, interval: 50 });
      const output = await call("get_remote_verification_logs", { requestId: request.id });
      expect(output.logs.join("\n")).toContain(expected === "failed" ? "FAIL:" : "PASS:");
    }
    expect(requests[0]).not.toBe(requests[1]);
    expect(f.workerStore.listTestRuns()).toHaveLength(2);
    const pending = await call("submit_remote_verification", { projectId: "remote-project", workerId: "worker", commitSha: f.fixedSha, presetId: "node:test", idempotencyKey: "cancel-before-delivery" });
    expect(await call("cancel_remote_verification", { requestId: pending.id })).toMatchObject({ cancellationRequested: true });
    await f.worker.tick();
    expect((await call("get_remote_verification", { requestId: pending.id })).request.phase).toBe("cancelled");
    expect(f.workerStore.listTestRuns()).toHaveLength(2);
  }, 40_000);

  it("quarantines real worker process death and restart without replaying the accepted command", async () => {
    const f = await fixture(true);
    const startedFile = join(f.root, "executions"), finishedFile = join(f.root, "process-finished");
    const sha = f.commit(`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(startedFile)},'run\\n');setTimeout(()=>fs.writeFileSync(${JSON.stringify(finishedFile)},'done'),3000);`, "crash fixture");
    git(f.seed, "push", "-q", "origin", "main");
    await f.retireWorker();
    const tokenFile = join(f.root, "private-worker-token"), configFile = join(f.root, "worker-config.json");
    writeFileSync(tokenFile, f.issued.token, { mode: 0o600 });
    writeFileSync(configFile, JSON.stringify({ version: 1, worker: { workerId: "worker", origin: f.origin, tokenFile, workspaceRoot: f.workspaces, allowLoopbackHttpFixture: true, mappings: f.mappings } }));
    const launch = async () => {
      const child = fork(fileURLToPath(new URL("./fixtures/remote-worker-process.ts", import.meta.url)), [join(f.root, "worker.sqlite3"), join(f.root, "worker.lock"), configFile], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
      const exited = once(child, "exit");
      let stderr = "";
      child.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
      cleanup.push(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.send("close");
        await exited;
      });
      const ready = await Promise.race([
        once(child, "message").then(([message]) => message as { ready: boolean; admissionBlockReason: string | null }),
        exited.then(() => { throw new Error(`Worker fixture exited before ready: ${stderr}`); }),
      ]);
      expect(ready.ready).toBe(true);
      return { child, exited, ready };
    };
    const request = f.submit(sha);
    const first = await launch();
    await vi.waitFor(() => expect(f.controller.status(request.id, f.owner).attempt?.phase).toBe("running"), { timeout: 10_000 });
    first.child.kill("SIGKILL"); await first.exited;
    // The test process deliberately ends itself; never signal an unknown PID after restart.
    await vi.waitFor(() => expect(existsSync(finishedFile)).toBe(true), { timeout: 10_000 });
    const second = await launch();
    expect(second.ready.admissionBlockReason).toBe("remote_execution_cleanup_unconfirmed");
    await vi.waitFor(() => expect(f.controller.status(request.id, f.owner).attempt?.phase).toBe("uncertain"), { timeout: 10_000 });
    const next = f.submit(f.fixedSha, "after-worker-crash");
    await vi.waitFor(() => expect(f.controller.status(next.id, f.owner).attempt).toMatchObject({ phase: "failed", failureKind: "setup" }), { timeout: 10_000 });
    expect(readFileSync(startedFile, "utf8")).toBe("run\n");
    second.child.send("close"); await second.exited;
  }, 35_000);

  it("executes distinct pushed failing/fixed SHAs through the finite queue, preserves human work, bounds output and replays submissions/delivery", async () => {
    const f = await fixture(); vi.stubEnv("CONTROLLER_SECRET", "must-not-inherit");
    const failed = f.submit(f.failedSha);
    expect(f.submit(f.failedSha).id).toBe(failed.id);
    const failedResult = await f.finish(failed.id);
    expect(failedResult.attempt).toMatchObject({ phase: "failed", executedCommitSha: f.failedSha, failureKind: "execution" });
    expect(failedResult.result?.logs.join("\n")).toContain("FAIL:undefined");
    const fixed = f.submit(f.fixedSha);
    const fixedResult = await f.finish(fixed.id);
    expect(fixedResult.attempt).toMatchObject({ phase: "succeeded", executedCommitSha: f.fixedSha });
    expect(fixedResult.attempt?.localRunId).not.toBe(failedResult.attempt?.localRunId);
    expect(fixedResult.result).toMatchObject({ presetFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), environmentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), exitCode: 0 });
    expect(fixedResult.result!.logs.length).toBeLessThanOrEqual(200);
    expect(fixedResult.result!.logs.every(line => line.length <= 2000)).toBe(true);
    expect(fixedResult.result!.logs.join("\n")).toContain("PASS:undefined");
    expect(git(f.human, "rev-parse", "HEAD")).toBe(f.failedSha);
    expect(readFileSync(join(f.human, "uncommitted.txt"), "utf8")).toBe("preserve human work");
    expect(existsSync(join(f.workspaces, fixedResult.attempt!.id))).toBe(false);
    expect(f.workerStore.listTestRuns()).toHaveLength(2);
    await f.worker.tick(); expect(f.workerStore.listTestRuns()).toHaveLength(2);
  }, 30_000);

  it("durably retries a disconnected result and lost ACK without another execution, rejects changed terminal reports", async () => {
    const f = await fixture(); const request = f.submit(f.fixedSha);
    f.disconnect(true); await expect(f.worker.tick()).rejects.toThrow("disconnected");
    await vi.waitFor(() => expect(f.workerStore.listTestRuns()[0]?.telemetry?.finalizedAt).toBeTruthy(), { timeout: 10_000 });
    await expect(f.worker.tick()).rejects.toThrow();
    const receipt = f.workerStore.remoteConnection.receipt(f.workerStore.remoteConnection.receipts()[0].assignment.attemptId)!;
    expect(receipt.reports.at(-1)?.phase).toBe("succeeded");
    f.disconnect(false); f.loseAck(); await expect(f.worker.tick()).rejects.toThrow("ACK lost");
    const result = await f.finish(request.id);
    expect(result.attempt?.phase).toBe("succeeded");
    expect(f.workerStore.listTestRuns()).toHaveLength(1);
    expect(f.controller.report("worker", result.result!, f.workerActor)).toEqual({ acceptedSequence: result.result!.sequence });
    expect(() => f.controller.report("worker", { ...result.result!, logs: ["changed"] }, f.workerActor)).toThrow("report_conflict");
  }, 30_000);

  it.each(["\0", "漢", "😀"])("bounds serialized envelopes for %j output before persistence and replays them over HTTP", async character => {
    const f = await fixture();
    const sha = f.commit(`for(let i=0;i<240;i++)console.log(${JSON.stringify(character)}.repeat(2100));`, "escaped or multibyte logs");
    git(f.seed, "push", "-q", "origin", "main");
    const request = f.submit(sha);
    f.disconnect(true);
    await expect(f.worker.tick()).rejects.toThrow("disconnected");
    await vi.waitFor(() => expect(f.workerStore.listTestRuns()[0]?.telemetry?.finalizedAt).toBeTruthy(), { timeout: 10_000 });
    await expect(f.worker.tick()).rejects.toThrow("disconnected");
    const assignment = f.workerStore.remoteConnection.receipts()[0].assignment;
    const terminal = f.workerStore.remoteConnection.receipt(assignment.attemptId)!.reports.at(-1)!;
    const envelope = (report: RemoteWorkerReport) => JSON.stringify({ version: 1, workerId: "worker", report });
    const originalTail = f.workerStore.listTestRuns()[0].logs.slice(-200).map(line => line.slice(0, 2000));
    expect(Buffer.byteLength(envelope({ ...terminal, logs: originalTail }))).toBeGreaterThan(REMOTE_REPORT_MAX_ENVELOPE_BYTES);
    if (character === "\0") expect(Buffer.byteLength(envelope({ ...terminal, logs: originalTail }))).toBeGreaterThan(2 * 1024 * 1024);
    expect(Buffer.byteLength(envelope(terminal))).toBeLessThanOrEqual(REMOTE_REPORT_MAX_ENVELOPE_BYTES);
    expect(terminal.logs.length).toBeGreaterThan(0);
    expect(terminal.logs).toEqual(originalTail.slice(-terminal.logs.length));
    const immutable = JSON.stringify(terminal);
    const upload = f.transport.report;
    const replayed: string[] = [];
    let loseTerminalAck = true;
    f.transport.report = async input => {
      await upload(input); // Actual authenticated HTTP listener and controller acceptance.
      if (input.sequence === terminal.sequence) {
        replayed.push(JSON.stringify(input));
        if (loseTerminalAck) { loseTerminalAck = false; throw new Error("terminal ACK lost"); }
      }
    };
    f.disconnect(false);
    await expect(f.worker.tick()).rejects.toThrow("terminal ACK lost");
    const result = await f.finish(request.id);
    expect(result.attempt?.phase).toBe("succeeded");
    expect(result.result).toEqual(terminal);
    expect(replayed).toEqual([immutable, immutable]);
    expect(JSON.stringify(f.workerStore.remoteConnection.receipt(assignment.attemptId)!.reports.at(-1))).toBe(immutable);
  }, 30_000);

  it("persists the resolved remote command and environment names before spawn and after reopening", async () => {
    const f = await fixture();
    const local = f.workerStore.listProjects()[0];
    f.workerStore.saveProjectTestEnvironmentProfile(local.id, { name: "node-test", policy: { mode: "clean", serverProfile: null }, environment: {}, nodeEnv: "test", requiredVariables: [] }, "fixture");
    f.workerStore.assignProjectTestPresetProfile(local.id, "node:test", "node-test", "fixture");
    const original = f.execution.resolve.bind(f.execution);
    let beforeSpawn: ReturnType<SqliteStateStore["getTestRun"]> = null;
    vi.spyOn(f.execution, "resolve").mockImplementation(async (assignment, receipt, running) => {
      const input = await original(assignment, receipt, running);
      const starting = input.preparation!.starting;
      input.preparation!.starting = () => {
        starting?.();
        // Preparation's preflight checkpoint must already contain the resolved command.
        beforeSpawn = f.workerStore.getTestRun(receipt.localRunId);
        expect(beforeSpawn).toMatchObject({ executable: process.execPath, args: ["check.cjs"], environmentVariableNames: expect.arrayContaining(["NODE_ENV"]) });
      };
      return input;
    });
    const result = await f.finish(f.submit(f.fixedSha).id);
    expect(result.attempt?.phase).toBe("succeeded");
    expect(beforeSpawn).not.toBeNull();
    const runId = f.workerStore.listTestRuns()[0].id;
    await f.retireWorker();
    const reopened = new SqliteStateStore(join(f.root, "worker.sqlite3"));
    try {
      expect(reopened.getTestRun(runId)).toMatchObject({ executable: process.execPath, args: ["check.cjs"],
        environmentVariableNames: ["CI", "HOME", "LANG", "NODE_ENV", "PATH", "TMPDIR"] });
    } finally { reopened.close(); }
  }, 30_000);

  it("rejects unpushed commits as setup failure without substituting branch HEAD", async () => {
    const f = await fixture(); const missing = f.commit("process.exit(0)", "not pushed");
    const result = await f.finish(f.submit(missing).id);
    expect(result.attempt).toMatchObject({ phase: "failed", failureKind: "setup", executedCommitSha: null });
    expect(f.workerStore.listTestRuns()[0].startedAt).toBeNull();
  }, 30_000);

  it("revalidates local presets/profiles and reservations, and never uses the human checkout as a source cache", async () => {
    const f = await fixture();
    const original = f.workerStore.getRemoteWorkerProjectGrant("worker", "remote-project")!;
    f.workerStore.saveRemoteWorkerProjectGrant({ ...original, presetIds: [] }, "fixture");
    const refused = await f.finish(f.submit(f.failedSha).id);
    expect(refused.attempt).toMatchObject({ phase: "failed", failureKind: "setup" });
    expect(f.workerStore.listTestRuns()).toHaveLength(0);
    f.workerStore.saveRemoteWorkerProjectGrant(original, "fixture");
    const local = f.workerStore.listProjects()[0];
    f.workerStore.acquireReservation({ projectId: local.id, worktreePath: f.human, kind: "human", owner: "human-fixture" });
    const reserved = await f.finish(f.submit(f.fixedSha).id);
    expect(reserved.attempt).toMatchObject({ phase: "failed", failureKind: "setup" });
    expect(f.workerStore.listTestRuns()[0].startedAt).toBeNull();
    f.workerStore.releaseReservation(local.id, "human-fixture");
    f.workerStore.saveProjectTestEnvironmentProfile(local.id, { name: "secret-profile", policy: { mode: "inherit-server-profile", serverProfile: "default" }, environment: {}, nodeEnv: null, requiredVariables: [] }, "fixture");
    f.workerStore.assignProjectTestPresetProfile(local.id, "node:test", "secret-profile", "fixture");
    const secretProfile = await f.finish(f.submit(f.fixedSha, "secret-profile").id);
    expect(secretProfile.attempt).toMatchObject({ phase: "failed", failureKind: "setup" });
    expect(f.workerStore.listTestRuns().every(run => run.startedAt === null)).toBe(true);
    f.workerStore.assignProjectTestPresetProfile(local.id, "node:test", null, "fixture");
    f.mappings[0].sourceCachePath = f.human;
    const humanCache = await f.finish(f.submit(f.fixedSha, "human-cache-forbidden").id);
    expect(humanCache.attempt).toMatchObject({ phase: "failed", failureKind: "setup" });
    expect(f.workerStore.listTestRuns().every(run => run.startedAt === null)).toBe(true);
    expect(git(f.human, "rev-parse", "HEAD")).toBe(f.failedSha);
  }, 30_000);

  it("retains offline cancellation through controller recovery and confirms descendant teardown", async () => {
    const f = await fixture();
    const sha = f.commit("const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('DESCENDANT:'+child.pid);setInterval(()=>{},1000);", "long check with descendant");
    git(f.seed, "push", "-q", "origin", "main");
    const request = f.submit(sha);
    await f.worker.tick();
    let descendant = 0;
    await vi.waitFor(() => {
      const run = f.workerStore.listTestRuns()[0];
      const line = run?.logs.find(line => line.startsWith("DESCENDANT:"));
      expect(line).toBeTruthy(); descendant = Number(line!.slice("DESCENDANT:".length));
    }, { timeout: 10_000 });
    f.disconnectPoll(true);
    f.controller.cancel(request.id, f.owner);
    expect(f.controller.status(request.id, f.owner)).toMatchObject({ cancellationRequested: true, request: { phase: "assigned" } });
    expect(() => process.kill(descendant, 0)).not.toThrow();
    const recovered = new RemoteVerificationController(f.controllerStore, f.controllerStore.remoteConnection, f.identity);
    recovered.recover();
    expect(recovered.status(request.id, f.owner).cancellationRequested).toBe(true);
    await expect(f.worker.tick()).rejects.toThrow("poll disconnected");
    f.disconnectPoll(false);
    await vi.waitFor(async () => { await f.worker.tick(); expect(recovered.status(request.id, f.owner).attempt?.phase).toBe("cancelled"); }, { timeout: 10_000 });
    expect(f.workerStore.listTestRuns()[0].telemetry?.cleanup).toBe("confirmed");
    await vi.waitFor(() => {
      try { process.kill(descendant, 0); }
      catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ESRCH"); return; }
      // Linux zombies cannot execute and are already excluded by the owned-tree verifier.
      expect(readFileSync(`/proc/${descendant}/stat`, "utf8").split(") ")[1]?.startsWith("Z ")).toBe(true);
    }, { timeout: 5000 });
    expect(f.workerStore.listTestRuns()).toHaveLength(1);
  }, 30_000);

  it("fails closed on protocol/authentication/assignment/grant/revocation, including output reads", async () => {
    const f = await fixture(); const request = f.submit(f.failedSha);
    const agent = f.identity.createAgent(f.owner);
    const token = f.identity.issueAgentToken({ principalId: agent.id, label: "no grant" }, f.owner);
    const actor = f.identity.authenticateBearer(token.token);
    expect(() => f.controller.status(request.id, actor)).toThrow("request_forbidden");
    expect(() => f.controller.submit({ projectId: "remote-project", workerId: "worker", commitSha: f.failedSha, presetId: "node:test", idempotencyKey: "forbidden" }, actor)).toThrow();
    const post = (bearer: string, version: number, workerId = "worker") => fetch(`${f.origin}/remote-verification/v1/poll`, { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ version, workerId }) });
    expect((await post(token.token, 1)).status).toBe(401);
    expect((await post(f.issued.token, 2)).status).toBe(400);
    expect((await post(f.issued.token, 1, "other-worker")).status).toBe(400);
    expect(() => f.controller.report("worker", { attemptId: "unassigned", sequence: 1, phase: "preparing", localRunId: "run" }, f.workerActor)).toThrow("assignment_forbidden");
    expect(() => f.controller.submit({ projectId: "remote-project", workerId: "worker", commitSha: f.failedSha, presetId: "node:build", idempotencyKey: "wrong-preset" }, f.owner)).toThrow();
    f.controllerStore.saveRemoteWorkerProjectGrant({ ...f.controllerStore.getRemoteWorkerProjectGrant("worker", "remote-project")!, revokedAt: new Date().toISOString() }, "fixture");
    expect(f.controller.poll("worker", f.workerActor).assignments).toEqual([]);
    f.identity.revokeCredential(f.issued.credential.id, f.owner);
    expect((await post(f.issued.token, 1)).status).toBe(401);
    expect(() => f.controller.poll("worker", f.workerActor)).toThrow();
    f.controllerStore.saveRemotePrincipalProjectGrant({ ...f.controllerStore.getRemotePrincipalProjectGrant(f.owner.principalId, "remote-project")!, revokedAt: new Date().toISOString() }, "fixture");
    expect(() => f.controller.status(request.id, f.owner)).toThrow("request_forbidden");
    expect(() => new HttpRemoteWorkerTransport("http://example.invalid", "worker", () => "secret", true)).toThrow("https_required");
  });
});
