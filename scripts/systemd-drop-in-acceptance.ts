/** Run only in a disposable VM/container with its own systemd user manager. See docs/user-service.md. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { renderSystemdUnit, UserServiceManager, type ServiceCommandRunner } from "../src/cli/service-manager";

if (process.platform !== "linux" || process.env.WORKTREE_CONTROL_ISOLATED_SYSTEMD_ACCEPTANCE !== "disposable"
  || !existsSync("/run/worktree-control-disposable-systemd")
  || readFileSync("/run/worktree-control-disposable-systemd", "utf8").trim() !== "worktree-control test fixture only") {
  throw new Error("Requires an explicitly marked disposable systemd environment. Never run on an application host.");
}
const home = resolve(homedir());
const config = resolve(process.env.XDG_CONFIG_HOME ?? join(home, ".config"));
const unitRoot = join(config, "systemd/user");
// This fixture owns these scopes exclusively. Never reuse an existing installation or policy.
for (const name of ["worktree-control.service", "worktree-switcher.service", "worktree-control.service.d", "worktree-switcher.service.d", "service.d", "worktree-.service.d"]) {
  assert.equal(existsSync(join(unitRoot, name)), false, `Existing fixture target: ${name}`);
}
const calls: string[][] = [];
const runner: ServiceCommandRunner = { run(command, args) {
  calls.push([command, ...args]);
  try { return { status: 0, stdout: execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" }; }
  catch (error) { const failure = error as { status?: number; stderr?: Buffer }; return { status: failure.status ?? 1, stdout: "", stderr: String(failure.stderr ?? "") }; }
} };
function systemctl(...args: string[]) {
  const result = runner.run("systemctl", ["--user", ...args]); assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
const manager = new UserServiceManager({ homeDirectory: home, runner, health: { stableMs: 1000 } });
const temporary = mkdtempSync(join(tmpdir(), "wtc-systemd-acceptance-"));
const files: string[] = [];
function put(scope: string, name: string, contents: string) {
  const directory = join(unitRoot, `${scope}.d`); mkdirSync(directory, { recursive: true });
  const path = join(directory, name); writeFileSync(path, contents, { flag: "wx" }); files.push(path); return path;
}
const entrypoint = join(temporary, "fixture.cjs");
writeFileSync(entrypoint, "setInterval(() => {}, 1000);\n");
const options = {
  nodePath: process.execPath, entrypointPath: entrypoint, workingDirectory: temporary, refresh: false,
  stateDirectory: join(temporary, "state"), startArguments: [
    "--service-mode", "--no-open", "--host", "127.0.0.1", "--port", "49151", "--mcp-port", "49152",
    "--browse-root", temporary, "--data-dir", join(temporary, "data"), "--state-dir", join(temporary, "state"), "--web-root", temporary,
  ],
};
function assertRefusalKeepsLegacy() {
  const pid = systemctl("show", "worktree-switcher.service", "--property=MainPID", "--value");
  assert.notEqual(pid, "0"); const start = calls.length;
  assert.throws(() => manager.install(options), /Inspect and reconcile/);
  assert.equal(calls.slice(start).some(call => ["stop", "start", "restart", "disable", "enable"].includes(call[2])), false);
  assert.equal(systemctl("show", "worktree-switcher.service", "--property=MainPID", "--value"), pid);
  process.kill(Number(pid), 0);
}
try {
  put("service", '10-type "resource".conf', "[Service]\nMemoryMax=256M\n");
  put("worktree-.service", "20-prefix.conf", "[Service]\nTasksMax=64\n");
  manager.install(options);
  assert.equal(systemctl("show", "worktree-control.service", "--property=MemoryMax", "--value"), "268435456");
  manager.install({ ...options, refresh: true, workingDirectory: dirname(temporary) });
  manager.uninstall();
  writeFileSync(manager.legacyDefinitionPath, renderSystemdUnit(options), { flag: "wx" });
  systemctl("daemon-reload"); systemctl("start", "worktree-switcher.service");
  const differing = put("worktree-control.service", "30-different.conf", "[Service]\nMemoryHigh=128M\n");
  systemctl("daemon-reload"); assertRefusalKeepsLegacy(); rmSync(differing);
  const unsafe = put("service", "40-unsafe.conf", "[Service]\nEnvironment=WTC_FIXTURE=1\n");
  systemctl("daemon-reload"); assertRefusalKeepsLegacy(); rmSync(unsafe);
  systemctl("daemon-reload"); manager.install(options);
  assert.equal(existsSync(manager.legacyDefinitionPath), false);
  assert.equal(systemctl("show", "worktree-control.service", "--property=TasksMax", "--value"), "64");
  console.log(JSON.stringify({ result: "passed", systemd: execFileSync("systemctl", ["--version"], { encoding: "utf8" }).split("\n")[0], checks: ["fresh", "refresh", "legacy", "quoted type-wide resources", "prefix resources", "effective values", "mismatch/unsafe refusal preserves legacy PID"] }));
} finally {
  // Both names and every removed file were reserved by the checks above before any service action.
  manager.uninstall();
  for (const file of files) rmSync(file, { force: true });
  for (const scope of ["service", "worktree-.service", "worktree-control.service", "worktree-switcher.service"]) rmSync(join(unitRoot, `${scope}.d`), { recursive: true, force: true });
  systemctl("daemon-reload"); rmSync(temporary, { recursive: true, force: true });
}
