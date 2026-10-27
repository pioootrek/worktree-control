import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderSystemdUnit } from "../../src/cli/service-manager";

const exec = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");
const cli = join(repository, "dist/cli/index.js");

describe.skipIf(process.platform !== "linux")("packaged service command safety", () => {
  let root: string, legacy: string, marker: string, environment: NodeJS.ProcessEnv, original: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "service-safety-"));
    const config = join(root, "config"), bin = join(root, "bin");
    legacy = join(config, "systemd/user/worktree-switcher.service");
    marker = join(root, "service-manager-called");
    await mkdir(join(config, "systemd/user"), { recursive: true });
    await mkdir(bin);
    // Never invoke the host's systemctl, including when testing a broken CLI.
    await writeFile(join(bin, "systemctl"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called'); process.exit(90);\n`, { mode: 0o700 });
    environment = {
      ...process.env, HOME: root, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_STATE_HOME: join(root, "xdg-state"), PATH: bin,
      WORKTREE_CONTROL_DATA_DIR: join(root, "environment-data"), WORKTREE_CONTROL_STATE_DIR: join(root, "environment-state"),
    };
    original = renderSystemdUnit({
      nodePath: process.execPath, entrypointPath: "/old/dist/cli/index.js", workingDirectory: "/old", refresh: false,
      stateDirectory: join(root, "installed-state"),
      startArguments: [
        "--service-mode", "--no-open", "--host", "127.0.0.1", "--port", "49151", "--mcp-port", "49153",
        "--data-dir", join(root, "installed-data"), "--state-dir", join(root, "installed-state"),
        "--browse-root", join(root, "repos"), "--web-root", "/old/out", "--public-url", "https://control.example.test",
        "--backup-dir", join(root, "backups"), "--backup-interval-seconds", "86400", "--backup-retain-count", "7",
        "--backup-retain-days", "14", "--backup-max-bytes", "6442450944", "--mcp-max-sessions", "48",
      ],
    });
    await writeFile(legacy, original);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const run = (args: string[]) => exec(process.execPath, [cli, "service", ...args], { env: environment, cwd: repository, timeout: 10000 });
  async function unchanged() {
    expect(await readFile(legacy, "utf8")).toBe(original);
    for (const path of [marker, legacy.replace("worktree-switcher", "worktree-control"), join(root, "installed-state/logs"), join(root, "environment-state/logs")]) {
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }

  it("refuses help, unknown options and missing values before any service effect", async () => {
    for (const action of ["install", "status", "start", "stop", "restart", "url", "open", "uninstall"]) {
      for (const flag of ["--help", "-h", "--typo"]) await expect(run([action, flag])).rejects.toThrow("Usage: service");
    }
    await expect(run(["install", "--host"])).rejects.toThrow("requires one value");
    await unchanged();
  });

  it("prints the migrated definition with inherited policy without writing or calling systemctl", async () => {
    const { stdout } = await run(["install", "--print"]);
    for (const pair of ['"--host" "127.0.0.1"', '"--port" "49151"', '"--backup-interval-seconds" "86400"',
      '"--backup-retain-count" "7"', '"--backup-retain-days" "14"', '"--backup-max-bytes" "6442450944"',
      '"--public-url" "https://control.example.test"', '"--mcp-max-sessions" "48"']) expect(stdout).toContain(pair);
    expect(stdout).toContain(`"--data-dir" "${join(root, "installed-data")}"`);
    expect(stdout).toContain(`"--state-dir" "${join(root, "installed-state")}"`);
    expect(stdout).toContain(`"--web-root" "${join(repository, "out")}"`);
    expect(stdout).not.toContain('"0.0.0.0"');
    await unchanged();
  });

  it("requires explicit acceptance of a changed legacy setting and allows its read-only preview", async () => {
    await expect(run(["install", "--port", "49152"])).rejects.toThrow("--yes");
    await unchanged();
    const { stdout } = await run(["install", "--port", "49152", "--print"]);
    expect(stdout).toContain('--port: ["49151"] -> ["49152"]');
    expect(stdout).toContain('"--port" "49152"');
    await unchanged();
  });

  it("does not request legacy acceptance for backup UI actions that serialize to the installed default", async () => {
    const { stdout } = await run(["install", "--backup-ui-actions", "none", "--print"]);
    expect(stdout).not.toContain("Service setting change:");
    expect(stdout).not.toContain("--backup-ui-actions");
    await unchanged();

    // The no-op passes acceptance and reaches the deliberately failing, isolated manager preflight.
    await expect(run(["install", "--backup-ui-actions", "none"])).rejects.toThrow("Installed service manager configuration differs");
    expect(await readFile(marker, "utf8")).toBe("called");
    await rm(marker);
    await unchanged();
  });

  it("refuses ambiguous current and legacy definitions without choosing one policy", async () => {
    const current = legacy.replace("worktree-switcher", "worktree-control");
    await writeFile(current, original.replace('"--port" "49151"', '"--port" "49154"'));
    await expect(run(["install", "--refresh", "--yes"])).rejects.toThrow("Both current and legacy");
    expect(await readFile(legacy, "utf8")).toBe(original);
    expect(await readFile(current, "utf8")).toContain('"--port" "49154"');
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("previews resetting an inherited setting to its actual default", async () => {
    const { stdout } = await run(["install", "--unset", "--backup-retain-count", "--print"]);
    expect(stdout).toContain('--backup-retain-count: ["7"] -> ["30"]');
    expect(stdout).toContain('"--backup-retain-count" "30"');
    await unchanged();
  });
  async function isolatedManager() {
    const calls = join(root, "manager-calls.jsonl");
    const fixture = join(root, "manager-fixture.json");
    const configRoot = dirname(legacy), vendorRoot = join(root, 'vendor "policy"');
    await mkdir(vendorRoot);
    await writeFile(fixture, JSON.stringify({ roots: [configRoot, vendorRoot], calls, pid: process.pid }));
    await writeFile(join(root, "bin/systemctl"), String.raw`#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8'));
const args = process.argv.slice(2); fs.appendFileSync(fixture.calls, JSON.stringify(args) + '\n');
const quote = JSON.stringify;
if (args.includes('--property=UnitPath')) console.log('UnitPath=' + fixture.roots.map(quote).join(' '));
else if (args.includes('--property=FragmentPath')) {
 const unit = args[2], winners = new Map();
 const dirs = fixture.roots.flatMap(root => [path.join(root, unit + '.d'), path.join(root, 'worktree-.service.d')]).concat(fixture.roots.map(root => path.join(root, 'service.d')));
 for (const dir of dirs) if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) if (name.endsWith('.conf') && !winners.has(name)) winners.set(name, path.join(dir, name));
 const paths = [...winners].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([, file]) => quote(file));
 console.log('FragmentPath=' + path.join(fixture.roots[0], unit) + '\nDropInPaths=' + paths.join(' ') + '\nNeedDaemonReload=no');
} else if (args.includes('--property=MainPID')) console.log('ActiveState=active\nSubState=running\nMainPID=' + fixture.pid + '\nNRestarts=0');
`, { mode: 0o700 });
    return { vendorRoot, fixture, calls, readCalls: async () => (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]) };
  }

  it.each(["service", "worktree-.service"])("previews local %s resources without contacting systemctl", async scope => {
    const directory = join(dirname(legacy), `${scope}.d`); await mkdir(directory);
    await writeFile(join(directory, 'resource "limits".conf'), "[Service]\nMemoryHigh=80%\nMemorySwapMax=0\n");
    expect((await run(["install", "--print"])).stdout).toContain("ExecStart=");
    await unchanged();
  });

  it.each(["service", "worktree-.service"])("refuses unsafe vendor %s before any lifecycle call", async scope => {
    const manager = await isolatedManager();
    const directory = join(manager.vendorRoot, `${scope}.d`); await mkdir(directory);
    await writeFile(join(directory, "unsafe.conf"), "[Service]\nEnvironment=BAD=1\n");
    await expect(run(["install"])).rejects.toThrow("Inspect and reconcile");
    expect((await manager.readCalls()).every(args => args[1] === "show")).toBe(true);
    await unchanged();
  });

  it("loads safe vendor type-wide/prefix policy and rolls back a differing destination without interrupting the fixture PID", async () => {
    const manager = await isolatedManager();
    // Model an existing installation, so first-run token bootstrap does not stop the CLI
    // before the destination drop-in preflight. The ephemeral token is never logged.
    await exec(process.execPath, [cli, "auth", "token", "generate",
      "--data-dir", join(root, "installed-data"), "--state-dir", join(root, "installed-state")],
    { env: environment, cwd: repository, timeout: 10000 });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      expect(child.pid).toBeGreaterThan(0);
      const state = JSON.parse(await readFile(manager.fixture, "utf8"));
      await writeFile(manager.fixture, JSON.stringify({ ...state, pid: child.pid }));
      for (const [scope, name, content] of [
        ["service", '10-vendor "limits".conf', "MemoryHigh=80%"],
        ["worktree-.service", "20-prefix.conf", "TasksMax=64"],
        ["worktree-control.service", "30-target-only.conf", "MemoryMax=512M"],
      ]) {
        const directory = join(manager.vendorRoot, `${scope}.d`); await mkdir(directory);
        await writeFile(join(directory, name), `[Service]\n${content}\n`);
      }
      await expect(run(["install"])).rejects.toThrow("Inspect and reconcile");
      const calls = await manager.readCalls();
      expect(calls).toContainEqual(["--user", "daemon-reload"]);
      expect(calls.some(args => args[2] === "worktree-control.service" && args.includes("--property=FragmentPath"))).toBe(true);
      expect(calls.some(args => ["start", "stop", "restart", "enable", "disable"].includes(args[1]))).toBe(false);
      expect(process.kill(child.pid!, 0)).toBe(true);
      expect(JSON.parse(await readFile(manager.fixture, "utf8")).pid).toBe(child.pid);
      expect(await readFile(legacy, "utf8")).toBe(original);
      await expect(readFile(legacy.replace("worktree-switcher", "worktree-control"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { child.kill(); await new Promise<void>(resolve => child.once("exit", () => resolve())); }
  });

});
