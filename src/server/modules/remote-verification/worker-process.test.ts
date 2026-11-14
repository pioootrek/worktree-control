// Spawns the real `worktree-control worker start` entry against an in-process fixture server.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireControllerLock } from "@/server/controller-lock";
import { IdentityService, type AuthenticatedPrincipal } from "@/server/modules/identity";
import { resolveAppPaths } from "@/server/paths";
import { SqliteStateStore } from "@/server/sqlite-store";
import { createRemoteVerificationServer } from "@/server/transports/remote-verification-http";
import { RemoteVerificationController } from "./index";

const exec = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const cliEntry = join(repositoryRoot, "src/cli/index.ts");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const terminal = new Set(["succeeded", "failed", "cancelled", "uncertain"]);

/** Inodes of sockets this process holds, from its file descriptor table. */
function socketInodes(pid: number): Set<string> {
  const inodes = new Set<string>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try { const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`)); if (match) inodes.add(match[1]!); }
    catch { /* Descriptor closed while listing. */ }
  }
  return inodes;
}
/** Listening TCP (state 0A) and unix sockets (flag __SO_ACCEPTCON) owned by `pid`. */
function listeningSockets(pid: number): string[] {
  const owned = socketInodes(pid);
  const found: string[] = [];
  for (const table of ["tcp", "tcp6"]) {
    for (const line of readFileSync(`/proc/net/${table}`, "utf8").trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === "0A" && owned.has(fields[9]!)) found.push(`${table} ${fields[1]}`);
    }
  }
  for (const line of readFileSync("/proc/net/unix", "utf8").trim().split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if ((Number.parseInt(fields[3]!, 16) & 0x10000) && owned.has(fields[6]!)) found.push(`unix ${fields[7] ?? "(anonymous)"}`);
  }
  return found;
}

describe.skipIf(process.platform !== "linux")("worker-only process (real CLI entry, isolated fixtures)", () => {
  const root = mkdtempSync(join(tmpdir(), "wtc-worker-process-"));
  const roots = [root, realpathSync(root)].map(path => `${path}${sep}`);
  const dataDirectory = join(root, "worker-data"), stateDirectory = join(root, "worker-state");
  const paths = resolveAppPaths(dataDirectory, stateDirectory);
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: join(root, "home"), XDG_DATA_HOME: join(root, "xdg-data"), XDG_STATE_HOME: join(root, "xdg-state"), XDG_CONFIG_HOME: join(root, "xdg-config"), LANG: "C.UTF-8",
  };
  const started = join(root, "started-pids");
  const children = new Set<ChildProcess>();
  let brokerStore: SqliteStateStore;
  let controller: RemoteVerificationController;
  let owner: AuthenticatedPrincipal;
  let closeServer: () => Promise<void>;
  let origin = "";
  let configFile = "";
  let credential = "";
  let installationToken = "";
  let serverRequests = 0;
  /** Every verification request this suite submits; each one leaves a worker receipt. */
  const submitted: string[] = [];
  let passingSha = "", longSha = "";
  let worker: { child: ChildProcess; stdout: string[]; stderr: string[] } | null = null;

  const cli = (args: string[], extra: Record<string, string> = {}) => exec(process.execPath, ["--import", "tsx", cliEntry, ...args, "--data-dir", dataDirectory, "--state-dir", stateDirectory], {
    cwd: repositoryRoot, env: { ...environment, ...extra }, encoding: "utf8", timeout: 60_000,
  });
  const spawnWorker = () => {
    const child = spawn(process.execPath, ["--import", "tsx", cliEntry, "worker", "start", "--config", configFile, "--data-dir", dataDirectory, "--state-dir", stateDirectory], {
      cwd: repositoryRoot, env: environment, stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    child.once("exit", () => children.delete(child));
    const stdout: string[] = [], stderr: string[] = [];
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => stdout.push(chunk));
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
    return { child, stdout, stderr };
  };
  const startWorker = async () => {
    const spawned = spawnWorker();
    await vi.waitFor(() => {
      expect(spawned.child.exitCode, spawned.stderr.join("")).toBeNull();
      expect(spawned.stdout.join("")).toContain("\n");
    }, { timeout: 60_000, interval: 100 });
    return spawned;
  };
  const stop = async (spawned: { child: ChildProcess }) => {
    const exited = once(spawned.child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    spawned.child.kill("SIGTERM");
    return exited;
  };
  const lastContact = () => brokerStore.getRemoteWorker("worker")?.lastContactAt ?? null;
  const waitForPoll = async () => {
    const before = lastContact();
    await vi.waitFor(() => expect(lastContact()).not.toBe(before), { timeout: 30_000, interval: 100 });
  };
  const attemptPhase = (requestId: string) => controller.status(requestId, owner).attempt?.phase ?? null;
  const startedPids = () => existsSync(started) ? readFileSync(started, "utf8").trim().split("\n").filter(Boolean).map(Number) : [];
  const gone = (pid: number) => {
    try { process.kill(pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z ") ?? false; }
    catch { return true; }
  };
  /** This suite's `check.cjs` under its temporary directory; a recycled pid is never signalled. */
  const isFixtureJob = (pid: number) => {
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, "");
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
        .some(arg => { const path = resolve(cwd, arg); return path.endsWith(`${sep}check.cjs`) && roots.some(prefix => path.startsWith(prefix)); });
    } catch { return false; }
  };
  const waitUntil = async (condition: () => boolean, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() >= deadline) return false;
      await delay(100);
    }
    return true;
  };
  /** SIGTERM first, so the worker's own shutdown stops its job's process group; SIGKILL only after a bounded wait. */
  const terminateWorker = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit").then(() => true);
    child.kill("SIGTERM");
    if (await Promise.race([exited, delay(30_000).then(() => false)])) return;
    child.kill("SIGKILL");
    await exited;
  };
  /** Jobs run in their own detached process groups and can outlive a killed worker. */
  const terminateFixtureJob = async (pid: number) => {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (gone(pid) || !isFixtureJob(pid)) return;
      try { process.kill(pid, signal); } catch { /* Exited after the identity check. */ }
      if (await waitUntil(() => gone(pid), 5_000)) return;
    }
    if (!gone(pid) && isFixtureJob(pid)) throw new Error(`Fixture job ${pid} survived SIGKILL.`);
  };

  beforeAll(async () => {
    mkdirSync(environment.HOME!, { recursive: true });
    const remote = join(root, "remote.git"), seed = join(root, "seed"), human = join(root, "human"), cache = join(root, "cache");
    execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", remote]);
    execFileSync("git", ["init", "-q", "-b", "main", seed]);
    git(seed, "config", "user.email", "fixture@example.invalid"); git(seed, "config", "user.name", "Fixture");
    writeFileSync(join(seed, "package.json"), JSON.stringify({ scripts: { test: "node check.cjs" } }));
    const commit = (script: string, message: string) => {
      writeFileSync(join(seed, "check.cjs"), script); git(seed, "add", "."); git(seed, "commit", "-qm", message); return git(seed, "rev-parse", "HEAD");
    };
    passingSha = commit("console.log('PASS')", "passing check");
    longSha = commit(`require('node:fs').appendFileSync(${JSON.stringify(started)},process.pid+'\\n');console.log('STARTED');setInterval(()=>{},1000);`, "long check");
    git(seed, "remote", "add", "origin", remote); git(seed, "push", "-q", "-u", "origin", "main");
    execFileSync("git", ["clone", "-q", remote, human]); execFileSync("git", ["clone", "-q", "--no-checkout", remote, cache]);

    // Broker side: the existing controller, identity and listener pieces, in this test process.
    brokerStore = new SqliteStateStore(join(root, "broker.sqlite3"));
    const identity = new IdentityService(brokerStore);
    owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
    const workerPrincipal = identity.createWorker(owner);
    credential = identity.issueWorkerToken({ principalId: workerPrincipal.id, label: "fixture-only" }, owner).token;
    const brokerLocal = brokerStore.addProject({ name: "Broker fixture identity", repositoryPath: seed, port: 3198, executable: "", args: [], launchPreset: "none" });
    brokerStore.saveRemoteProjectIdentity({ id: "remote-project", name: "Fixture", sourceRemote: "origin", status: "active" }, "fixture");
    brokerStore.saveRemoteWorker({ id: "worker", principalId: workerPrincipal.id, name: "Fixture", status: "active", lastContactAt: null }, "fixture");
    brokerStore.saveRemoteWorkerProjectGrant({ workerId: "worker", projectId: "remote-project", localProjectId: brokerLocal.id, presetIds: ["node:test"], revokedAt: null }, "fixture");
    brokerStore.saveRemotePrincipalProjectGrant({ principalId: owner.principalId, projectId: "remote-project", permissions: ["submit", "read"], revokedAt: null }, "fixture");
    controller = new RemoteVerificationController(brokerStore, brokerStore.remoteConnection, identity);
    const server = createRemoteVerificationServer({ controller, identity, allowLoopbackHttpFixture: true });
    server.server.on("request", () => { serverRequests++; });
    await new Promise<void>(done => server.server.listen(0, "127.0.0.1", done));
    closeServer = server.close;
    origin = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;

    // Worker side: a fresh data directory, registered through the public offline CLI only.
    await cli(["project", "add", human, "--name", "Worker fixture", "--preset", "none"]);
    const projects = JSON.parse((await cli(["project", "list", "--json"])).stdout) as Array<{ id: string; repositoryPath: string }>;
    expect(projects).toHaveLength(1);
    installationToken = (JSON.parse((await cli(["auth", "token", "generate"])).stdout) as { token: string }).token;
    const provision = join(root, "provision.json");
    writeFileSync(provision, JSON.stringify({ project: { id: "remote-project", name: "Fixture", sourceRemote: "origin" }, worker: { id: "worker", name: "Fixture", principalId: workerPrincipal.id },
      localProjectId: projects[0]!.id, presetIds: ["node:test"], callerPrincipalIds: [] }));
    await cli(["remote-verification", "provision", "--file", provision], { WORKTREE_CONTROL_TOKEN: installationToken });

    const credentialFile = join(root, "worker-credential");
    writeFileSync(credentialFile, `${credential}\n`, { mode: 0o600 }); chmodSync(credentialFile, 0o600);
    configFile = join(root, "worker.json");
    writeFileSync(configFile, JSON.stringify({ version: 1, workerId: "worker", origin, credentialFile, workspaceRoot: join(root, "attempts"), allowLoopbackHttpFixture: true,
      mappings: [{ projectId: "remote-project", localProjectId: projects[0]!.id, sourceCachePath: cache, sourceRemote: "origin", presetIds: ["node:test"] }] }));
  }, 240_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const settled of await Promise.allSettled([...children].map(terminateWorker))) if (settled.status === "rejected") failures.push(settled.reason);
    for (const pid of startedPids()) await terminateFixtureJob(pid).catch((error: unknown) => failures.push(error));
    await closeServer?.();
    brokerStore?.close();
    // Last, and only once nothing recorded by the fixture still runs from it.
    if (!failures.length) rmSync(root, { recursive: true, force: true });
    if (failures.length) throw new AggregateError(failures, `Worker process fixtures did not stop; ${root} was kept for inspection.`);
  }, 120_000);

  it("starts from a fresh data directory, holds no listening socket and reports its idle memory", async () => {
    worker = await startWorker();
    const line = worker.stdout.join("");
    expect(line).toBe(`Worktree Control worker worker polling ${origin}\n`);
    expect(line).not.toContain(credential);
    await waitForPoll();
    await waitForPoll();
    const pid = worker.child.pid!;
    // Positive control: the same method sees this test process's fixture listener.
    expect(listeningSockets(process.pid).some(entry => entry.startsWith("tcp "))).toBe(true);
    expect(listeningSockets(pid)).toEqual([]);
    const rss = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
    console.info("worker-process-idle-memory", JSON.stringify({ pid, vmRssKiB: Number(rss), measuredAfter: "two completed polls", entry: "src/cli/index.ts via tsx" }));
    expect(existsSync(paths.adminSocketPath)).toBe(false);
  }, 120_000);

  it("refuses a second instance on the same data directory", async () => {
    const second = spawnWorker();
    const [code] = await once(second.child, "exit") as [number | null];
    expect(code).toBe(1);
    expect(second.stderr.join("")).toContain(`already running (PID ${worker!.child.pid})`);
    expect(second.stdout.join("")).toBe("");
    expect(worker!.child.exitCode).toBeNull();
  }, 120_000);

  it("completes a verification that succeeds", async () => {
    const request = controller.submit({ projectId: "remote-project", workerId: "worker", commitSha: passingSha, presetId: "node:test", idempotencyKey: "passing" }, owner);
    submitted.push(request.id);
    await vi.waitFor(() => expect(attemptPhase(request.id)).toBe("succeeded"), { timeout: 60_000, interval: 100 });
    const status = controller.status(request.id, owner);
    expect(status.request.phase).toBe("completed");
    expect(status.result).toMatchObject({ executedCommitSha: passingSha, exitCode: 0 });
  }, 120_000);

  it("cancels a verification while it runs and stops its process", async () => {
    const request = controller.submit({ projectId: "remote-project", workerId: "worker", commitSha: longSha, presetId: "node:test", idempotencyKey: "cancelled" }, owner);
    submitted.push(request.id);
    await vi.waitFor(() => expect(startedPids()).toHaveLength(1), { timeout: 60_000, interval: 100 });
    await vi.waitFor(() => expect(attemptPhase(request.id)).toBe("running"), { timeout: 30_000, interval: 100 });
    controller.cancel(request.id, owner);
    await vi.waitFor(() => expect(attemptPhase(request.id)).toBe("cancelled"), { timeout: 30_000, interval: 100 });
    await vi.waitFor(() => expect(gone(startedPids()[0]!)).toBe(true), { timeout: 10_000 });
  }, 120_000);

  it("exits 0 on SIGTERM while idle and releases the lock", async () => {
    const [code, signal] = await stop(worker!);
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    acquireControllerLock(paths.controllerLockPath).release();
  }, 60_000);

  it("fails a startup that breaks after the store opens, releasing the lock without polling", async () => {
    // An owned write through the store's fenced connection; no public operation stores malformed JSON.
    const testQueueSetting = (replacement?: string) => {
      const local = new SqliteStateStore(paths.databasePath);
      try {
        const database = (local as unknown as { database: { prepare(sql: string): { get(): { value_json: string } | undefined; run(value: string): { changes: number } } } }).database;
        if (replacement === undefined) return database.prepare("SELECT value_json FROM controller_settings WHERE key = 'test_queue'").get()?.value_json;
        expect(database.prepare("UPDATE controller_settings SET value_json = ? WHERE key = 'test_queue'").run(replacement).changes).toBe(1);
        return replacement;
      } finally { local.close(); }
    };
    const original = testQueueSetting();
    expect(original).toEqual(expect.any(String));
    testQueueSetting("{");
    try {
      const requests = serverRequests, contact = lastContact();
      const failing = spawnWorker();
      const [code] = await once(failing.child, "exit") as [number | null];
      expect(code).toBe(1);
      expect(failing.stdout.join("")).toBe("");
      expect(failing.stderr.join("")).toMatch(/JSON/);
      expect(failing.stderr.join("")).not.toContain(credential);
      acquireControllerLock(paths.controllerLockPath).release();
      expect({ requests: serverRequests, contact: lastContact() }).toEqual({ requests, contact });
    } finally {
      testQueueSetting(original!);
    }
  }, 120_000);

  it("stops a job in flight on SIGTERM and reports it as uncertain after the next start", async () => {
    worker = await startWorker();
    const request = controller.submit({ projectId: "remote-project", workerId: "worker", commitSha: longSha, presetId: "node:test", idempotencyKey: "in-flight" }, owner);
    submitted.push(request.id);
    await vi.waitFor(() => expect(startedPids()).toHaveLength(2), { timeout: 60_000, interval: 100 });
    await vi.waitFor(() => expect(attemptPhase(request.id)).toBe("running"), { timeout: 30_000, interval: 100 });
    const pid = startedPids()[1]!;
    const stopping = Date.now();
    const [code, signal] = await stop(worker);
    const shutdownMs = Date.now() - stopping;
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(gone(pid)).toBe(true);
    const whileStopped = attemptPhase(request.id);
    const local = new SqliteStateStore(paths.databasePath);
    const runs = local.listTestRuns().map(run => ({ phase: run.phase, cleanup: run.telemetry?.cleanup ?? null }));
    local.close();
    worker = await startWorker();
    await vi.waitFor(() => expect(terminal.has(attemptPhase(request.id) ?? "")).toBe(true), { timeout: 30_000, interval: 100 });
    const afterRestart = controller.status(request.id, owner);
    console.info("worker-process-in-flight-shutdown", JSON.stringify({ shutdownMs, exitCode: code, brokerPhaseWhileStopped: whileStopped, localRuns: runs,
      brokerPhaseAfterRestart: afterRestart.attempt?.phase, cleanup: afterRestart.result?.execution?.cleanup ?? null, termination: afterRestart.result?.execution?.termination ?? null }));
    expect(whileStopped).toBe("running");
    // Passing run, remotely cancelled run and the run stopped by shutdown; nothing left running.
    expect(runs.map(run => run.phase).sort()).toEqual(["cancelled", "cancelled", "passed"]);
    expect(runs.every(run => run.cleanup === "confirmed" || run.phase === "passed")).toBe(true);
    expect(afterRestart.attempt?.phase).toBe("uncertain");
    expect(await stop(worker)).toEqual([0, null]);
  }, 180_000);

  it("inspects recovery receipts only with an owner session from the public CLI while stopped", async () => {
    const refused = (error: unknown) => (error as { code?: number; stderr?: string });
    // The installation token authorizes provisioning but neither recovery command.
    const inspectWithToken = await cli(["remote-verification", "inspect"], { WORKTREE_CONTROL_TOKEN: installationToken }).then(() => null, refused);
    expect(inspectWithToken?.code).toBe(1);
    const reconcileWithToken = await cli(["remote-verification", "reconcile", "--attempt-id", "fixture-attempt", "--operation-id", "fixture-operation"],
      { WORKTREE_CONTROL_TOKEN: installationToken }).then(() => null, refused);
    expect(reconcileWithToken?.stderr).toContain("owner_session_required");
    // A fresh worker data directory has no owner; the offline bootstrap creates the first one.
    const ownerToken = (JSON.parse((await cli(["identity", "bootstrap-owner", "--label", "Worker recovery"])).stdout) as { token: string }).token;
    const receipts = JSON.parse((await cli(["remote-verification", "inspect"], { WORKTREE_CONTROL_OWNER_TOKEN: ownerToken })).stdout) as Array<{ attemptId: string; workerId: string }>;
    const attempts = submitted.map(id => controller.status(id, owner).attempt?.id);
    expect(attempts).toHaveLength(3);
    expect(receipts.map(receipt => receipt.attemptId).sort()).toEqual([...attempts].sort());
    expect(receipts.every(receipt => receipt.workerId === "worker")).toBe(true);
    acquireControllerLock(paths.controllerLockPath).release();
  }, 120_000);
});
