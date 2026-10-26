import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { waitFor } from "./controller-fixture";
import type { WorkerRecoveryProvenance } from "../../src/server/modules/remote-verification/recovery-contracts";

export const recoveryRepository = resolve(import.meta.dirname, "../..");
const cliEntry = join(recoveryRepository, "dist/cli/index.js");
const DEADLINE = 15_000;
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type OwnedChild = { child: ChildProcess; closed: Promise<Exit>; output: () => string; stdout: () => string };
export type ProcessIdentity = { pid: number; start: string };
export type CommandEvent = { role: "launcher" | "descendant"; event: "start" | "exit"; sha: string; boot: string; attemptId: string; process: ProcessIdentity; parent: ProcessIdentity; group: ProcessIdentity; reason?: string };
export type Inspection = { attemptId: string; localRunId: string; workerId: string; lastPhase: string; cleanup: string | null; blocked: boolean; code: string; recoverable: boolean; provenance: WorkerRecoveryProvenance; recovery: unknown };

// Only signal live handles created here. A timeout is a failure even if KILL works.
function owned(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): OwnedChild {
  const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", stdout = "";
  const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_000); };
  child.stdout!.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-16_000); capture(chunk); }); child.stderr!.on("data", capture);
  const closed = new Promise<Exit>(resolveExit => {
    child.once("error", () => { output += "\nfixture_spawn_failed"; });
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, closed, output: () => output, stdout: () => stdout };
}
async function drain(handle: OwnedChild, signal: NodeJS.Signals): Promise<Exit> {
  if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill(signal);
  const result = await boundedClose(handle, DEADLINE);
  if (result) return result;
  // Still use the original handle, never an identity read from disk/procfs.
  if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill("SIGKILL");
  if (!await boundedClose(handle, 5_000)) throw new Error("fixture_kill_unconfirmed_preserve_root");
  throw new Error("fixture_shutdown_deadline_preserve_root");
}
async function boundedClose(handle: OwnedChild, milliseconds: number): Promise<Exit | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([handle.closed, new Promise<null>(resolveTimeout => { timer = setTimeout(() => resolveTimeout(null), milliseconds); })]);
  } finally { clearTimeout(timer); }
}
export async function recoveryCommand(executable: string, args: string[], cwd = recoveryRepository, env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "production" }): Promise<{ stdout: string; code: number | null; sameBootRefused: boolean; privateOutput: string }> {
  const handle = owned(executable, args, cwd, env);
  const exit = await boundedClose(handle, DEADLINE);
  if (!exit) { await drain(handle, "SIGKILL"); throw new Error("fixture_command_deadline_preserve_root"); }
  if (exit.signal) throw new Error("fixture_command_signal_preserve_root");
  return { stdout: handle.stdout(), code: exit.code, sameBootRefused: handle.output().includes("recovery_same_boot_unconfirmed"), privateOutput: handle.output() };
}
export async function identityEnded(identity: ProcessIdentity): Promise<boolean> {
  try {
    const fields = (await readFile(`/proc/${identity.pid}/stat`, "utf8")).split(") ").at(-1)!.split(" ");
    return fields[0] === "Z" || fields[19] !== identity.start;
  } catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return true; throw error; }
}

export class RecoveryMcp {
  constructor(private readonly client: Client) {}
  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
    const content = response.content;
    if (!Array.isArray(content)) throw new Error("fixture_mcp_json_missing");
    const part = content.find((item: unknown): item is { type: "text"; text: string } =>
      typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string");
    if (!part) throw new Error("fixture_mcp_json_missing");
    if (response.isError) throw new Error("fixture_mcp_operation_refused");
    return JSON.parse(part.text) as T;
  }
  async refused(name: string, args: Record<string, unknown>, expectedCode: string): Promise<boolean> {
    const response = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
    return response.isError === true && JSON.stringify(response.content).includes(expectedCode);
  }
  close() { return this.client.close(); }
}

export class RecoveryInstallation {
  owner = "";
  ownerPrincipalId = "";
  installationToken = "";
  projectId = "";
  private current?: OwnedChild;
  private generation = 0;
  private failures = 0;
  private stopping?: Promise<void>;
  private clients: RecoveryMcp[] = [];
  constructor(readonly root: string, readonly httpPort: number, readonly mcpPort: number, private readonly fixture: RemoteCliRecoveryFixture) {}
  private environment(): NodeJS.ProcessEnv {
    return { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, NODE_ENV: "production", LANG: "C.UTF-8", HOME: join(this.root, "home"),
      WORKTREE_CONTROL_DATA_DIR: join(this.root, "data"), WORKTREE_CONTROL_STATE_DIR: join(this.root, "state"),
      WORKTREE_CONTROL_OWNER_TOKEN: this.owner || undefined, WORKTREE_CONTROL_TOKEN: this.installationToken || undefined };
  }
  async cli(args: string[], allowedFailure = false) {
    const result = await recoveryCommand(process.execPath, [cliEntry, ...args], recoveryRepository, this.environment());
    if (result.code !== 0 && !allowedFailure) {
      await this.fixture.save(join(this.root, `cli-failure-${++this.failures}.json`), { args, output: result.privateOutput, code: result.code });
      throw new Error(`fixture_cli_${args[0]}_${args[1] ?? "command"}_failed`);
    }
    return result;
  }
  async provision(principalId?: string) {
    await mkdir(this.root, { mode: 0o700 }); await mkdir(join(this.root, "home"), { mode: 0o700 });
    const owner = JSON.parse((await this.cli(["identity", "bootstrap-owner", "--label", "CLI recovery fixture", "--lifetime-seconds", "3600"])).stdout);
    this.owner = owner.token; this.ownerPrincipalId = owner.principalId;
    this.installationToken = JSON.parse((await this.cli(["auth", "token", "generate"])).stdout).token;
    await writeFile(join(this.root, "owner.token"), this.owner, { mode: 0o600, flag: "wx" });
    await this.cli(["auth", "mode", "set", "token"]);
    await this.cli(["project", "add", this.fixture.human, "--name", "Recovery fixture", "--preset", "none", "--port", String(this.httpPort)]);
    const projects = JSON.parse((await this.cli(["project", "list", "--json"])).stdout);
    if (projects.length !== 1 || projects[0].launchPreset !== "none") throw new Error("fixture_registration_mismatch");
    this.projectId = projects[0].id;
    const input = { project: { id: "recovery-project", name: "Recovery fixture", sourceRemote: "origin" },
      worker: { id: "recovery-worker", name: "Recovery worker", ...(principalId ? { principalId } : {}) }, localProjectId: this.projectId,
      presetIds: ["node:test"], callerPrincipalIds: principalId ? [] : [this.ownerPrincipalId],
      ...(!principalId ? { workerTokenFile: join(this.root, "worker.token") } : {}) };
    await this.fixture.save(join(this.root, "provision.json"), input);
    return JSON.parse((await this.cli(["remote-verification", "provision", "--file", join(this.root, "provision.json")])).stdout) as { workerPrincipalId: string };
  }
  async start(remote = true) {
    if (this.fixture.closing) throw new Error("fixture_closing");
    if (this.current) throw new Error("fixture_controller_already_started");
    await this.fixture.releasePorts([this.httpPort, this.mcpPort]);
    if (this === this.fixture.broker) await this.fixture.releasePorts([this.fixture.remotePort]);
    if (this.fixture.closing) throw new Error("fixture_closing");
    // Stale access files are not readiness. Wait for this new process to publish its PID.
    const handle = owned(process.execPath, [cliEntry, "start", "--service-mode", "--host", "127.0.0.1", "--port", String(this.httpPort),
      "--mcp-port", String(this.mcpPort), "--no-open", "--data-dir", join(this.root, "data"), "--state-dir", join(this.root, "state"),
      "--browse-root", this.fixture.root, "--web-root", join(recoveryRepository, "out"),
      ...(remote ? ["--remote-verification-config", join(this.root, "runtime.json")] : [])], recoveryRepository, this.environment());
    this.current = handle; this.generation++;
    try {
    await waitFor(async () => {
      if (this.fixture.closing) throw new Error("fixture_closing");
      if (handle.child.exitCode !== null || handle.child.signalCode !== null) throw new Error("fixture_controller_exited_before_ready");
      try {
        const access = JSON.parse(await readFile(join(this.root, "state/service-access.json"), "utf8"));
        return access.pid === handle.child.pid ? true : null;
      } catch { return null; }
    }, DEADLINE, () => "fixture_controller_readiness_deadline");
    // A real MCP handshake also proves the intended port is serving our credentials.
    await this.mcp();
    if (this.fixture.closing) throw new Error("fixture_closing");
    } catch (error) {
      if (this.fixture.closing) await this.stop();
      throw error;
    }
  }
  async mcp(installation = false) {
    const client = new Client({ name: "full-cli-recovery-fixture", version: "1" });
    const mcp = new RecoveryMcp(client); this.clients.push(mcp);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${this.mcpPort}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${installation ? this.installationToken : this.owner}` } },
    }), { timeout: 10_000 });
    const names = (await client.listTools(undefined, { timeout: 10_000 })).tools.map(tool => tool.name);
    if (!names.includes(installation ? "run_test" : "get_identity")) throw new Error("fixture_mcp_tools_missing");
    return mcp;
  }
  async stop(crash = false) {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopCurrent(crash);
    try { await this.stopping; } finally { this.stopping = undefined; }
  }
  private async stopCurrent(crash: boolean) {
    const clients = await Promise.allSettled(this.clients.splice(0).map(client => client.close()));
    const handle = this.current;
    if (!handle) return;
    const exit = await drain(handle, crash ? "SIGKILL" : "SIGTERM");
    this.current = undefined;
    // Raw output is private; never include it in assertion failures or console diagnostics.
    await this.fixture.save(join(this.root, `controller-${this.generation}.json`), { exit, output: handle.output() });
    if (crash ? exit.signal !== "SIGKILL" : exit.code !== 0 || exit.signal !== null) throw new Error("fixture_unexpected_controller_exit_preserve_root");
    if (clients.some(result => result.status === "rejected")) throw new Error("fixture_mcp_close_failed_preserve_root");
  }
}

export class RemoteCliRecoveryFixture {
  broker!: RecoveryInstallation;
  worker!: RecoveryInstallation;
  sha = "";
  remotePort = 0;
  preserve = false;
  closing = false;
  private leases = new Map<number, Server>();
  get human() { return join(this.root, "human"); }
  get cache() { return join(this.root, "cache"); }
  get workspaces() { return join(this.root, "workspaces"); }
  constructor(readonly root: string) {}
  async save(path: string, value: unknown) { await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
  async releasePorts(ports: number[]) {
    for (const port of ports) {
      const server = this.leases.get(port); if (!server) continue;
      await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); this.leases.delete(port);
    }
  }
  private async port() {
    const server = createServer();
    await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
    const port = (server.address() as { port: number }).port; this.leases.set(port, server); return port;
  }
  static async create(register?: (fixture: RemoteCliRecoveryFixture) => void) {
    const parent = process.env.WTC_RECOVERY_PARENT;
    if (parent) {
      if (!isAbsolute(parent) || resolve(parent) !== parent || await realpath(parent) !== parent) throw new Error("fixture_private_canonical_parent_required");
      for (let path = parent; ; path = dirname(path)) {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) && !(info.mode & 0o1000)
          || path === parent && (info.uid !== process.getuid?.() || (info.mode & 0o077))) throw new Error("fixture_private_canonical_parent_required");
        if (dirname(path) === path) break;
      }
    }
    const fixture = new RemoteCliRecoveryFixture(await mkdtemp(join(parent ?? tmpdir(), "wtc-full-cli-recovery-")));
    // Let teardown own partial setup too if Vitest times out during provisioning.
    register?.(fixture);
    try { await fixture.prepare(); return fixture; }
    catch (error) {
      fixture.preserve = true;
      await fixture.save(join(fixture.root, "setup-failure.json"), { error: error instanceof Error ? error.message : "unknown" });
      await fixture.close(); throw new Error("fixture_setup_failed_preserved");
    }
  }
  private async prepare() {
    const git = async (args: string[], cwd = this.root) => {
      const result = await recoveryCommand("git", args, cwd, { NODE_ENV: "production", PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: this.root, LANG: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
      if (result.code !== 0) throw new Error("fixture_git_failed"); return result.stdout.trim();
    };
    await mkdir(join(this.root, "seed"), { mode: 0o700 }); await mkdir(this.workspaces, { mode: 0o700 });
    await git(["init", "--bare", "--initial-branch=main", "remote.git"]);
    const seed = join(this.root, "seed");
    await git(["init", "-b", "main"], seed);
    await git(["config", "user.name", "Recovery Fixture"], seed); await git(["config", "user.email", "fixture@example.invalid"], seed);
    await writeFile(join(seed, "package.json"), JSON.stringify({ scripts: { test: "node check.cjs" } }));
    // Every command and descendant has both a release gate and a finite natural deadline.
    // External marker paths are committed, so replays cannot hide a second execution.
    const check = `const fs = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const root = ${JSON.stringify(this.root)};
const identity = pid => { const fields = fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ').at(-1).split(' '); return {pid,start:fields[19]}; };
const role = process.argv[2] === 'descendant' ? 'descendant' : 'launcher';
const sha = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',timeout:5000}).trim();
const group = identity(Number(fs.readFileSync('/proc/self/stat','utf8').split(') ').at(-1).split(' ')[2]));
const record = (event, reason) => fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify({role,event,reason,sha,boot:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),attemptId:path.basename(process.cwd()),process:identity(process.pid),parent:identity(process.ppid),group})+'\\n');
record('start');
let descendant;
if(role === 'launcher') descendant = spawn(process.execPath,[__filename,'descendant'],{stdio:'ignore'});
const started = Date.now();
const timer = setInterval(() => {
  const released = fs.existsSync(path.join(root,role+'.release'));
  const expired = Date.now()-started > 60000;
  if (released || expired) {
    if (!expired && descendant && descendant.exitCode === null && descendant.signalCode === null) return;
    clearInterval(timer); record('exit',expired?'deadline':'released'); process.exit(expired?2:0);
  }
},50);
`;
    await writeFile(join(seed, "check.cjs"), check);
    await git(["add", "."], seed); await git(["commit", "-m", "Bounded dependency-free CLI recovery fixture"], seed);
    this.sha = await git(["rev-parse", "HEAD"], seed);
    await git(["remote", "add", "origin", join(this.root, "remote.git")], seed); await git(["push", "-u", "origin", "main"], seed);
    await mkdir(this.cache, { mode: 0o700 });
    await git(["clone", join(this.root, "remote.git"), this.human]); await git(["clone", "--no-checkout", join(this.root, "remote.git"), this.cache]);
    await writeFile(join(this.human, "uncommitted.txt"), "preserve human work\n");
    this.broker = new RecoveryInstallation(join(this.root, "broker"), await this.port(), await this.port(), this);
    this.worker = new RecoveryInstallation(join(this.root, "worker"), await this.port(), await this.port(), this);
    this.remotePort = await this.port();
    const provisioned = await this.broker.provision(); await this.worker.provision(provisioned.workerPrincipalId);
    await writeFile(join(this.worker.root, "worker.token"), await readFile(join(this.broker.root, "worker.token")), { mode: 0o600, flag: "wx" });
    await this.save(join(this.broker.root, "runtime.json"), { version: 1, listener: { host: "127.0.0.1", port: this.remotePort, allowLoopbackHttpFixture: true } });
    await this.save(join(this.worker.root, "runtime.json"), { version: 1, worker: { workerId: "recovery-worker", origin: `http://127.0.0.1:${this.remotePort}`,
      tokenFile: join(this.worker.root, "worker.token"), workspaceRoot: this.workspaces, allowLoopbackHttpFixture: true,
      mappings: [{ projectId: "recovery-project", localProjectId: this.worker.projectId, sourceCachePath: this.cache, sourceRemote: "origin", presetIds: ["node:test"], preparationTimeoutMs: 15_000 }] } });
    await this.save(join(this.root, "source.json"), { fixtureOnly: true, cliEntry, cliSha256: createHash("sha256").update(await readFile(cliEntry)).digest("hex"),
      sourceFingerprint: (await readFile(join(recoveryRepository, "dist/build-source.sha256"), "utf8")).trim(),
      sourceHead: await git(["-C", recoveryRepository, "rev-parse", "HEAD"]), requestedSha: this.sha,
      boot: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() });
    await this.broker.start(); await this.worker.start();
  }
  async events(): Promise<CommandEvent[]> {
    let text: string;
    try { text = await readFile(join(this.root, "events.jsonl"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as CommandEvent);
  }
  async evidence(caseName: string, identities: Record<string, unknown>) {
    const source = JSON.parse(await readFile(join(this.root, "source.json"), "utf8"));
    console.info("full-cli-recovery-acceptance", JSON.stringify({ case: caseName, ...source, ...identities }));
  }
  async release() { for (const role of ["launcher", "descendant"]) await writeFile(join(this.root, `${role}.release`), "release", { mode: 0o600 }); }
  async waitNaturalExit() {
    await waitFor(async () => {
      const events = await this.events(), starts = events.filter(event => event.event === "start");
      if (!starts.length) return null;
      for (const event of starts) {
        if (!events.some(exit => exit.role === event.role && exit.event === "exit" && exit.process.start === event.process.start && exit.process.pid === event.process.pid)) return null;
        if (!await identityEnded(event.process) || !await identityEnded(event.parent) || !await identityEnded(event.group)) return null;
      }
      return true;
    }, 65_000, () => "fixture_finite_process_exit_unconfirmed_preserve_root");
  }
  async pathIdentity(path: string) {
    const metadata = await stat(path, { bigint: true }); return { path, device: String(metadata.dev), inode: String(metadata.ino), uid: Number(metadata.uid) };
  }
  async close() {
    this.closing = true;
    let failure: unknown;
    try {
      await this.release();
      // Release first, then drain the worker while it still owns its children.
      if ((await this.events()).length) await this.waitNaturalExit();
    } catch (error) { failure = error; this.preserve = true; }
    for (const installation of [this.worker, this.broker]) {
      try { await installation?.stop(); } catch (error) { failure ??= error; this.preserve = true; }
    }
    await this.releasePorts([...this.leases.keys()]);
    if (this.preserve) console.info(`Full CLI recovery fixture retained (private): ${this.root}`);
    else await rm(this.root, { recursive: true, force: true });
    if (failure) throw failure;
  }
}

export async function observeWorkerTicks() { await sleep(2_200); }
