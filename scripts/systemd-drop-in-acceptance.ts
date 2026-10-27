/** Only for a marked disposable machine with its own systemd user manager. Never run on an application host. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSystemdUnit, UserServiceManager, type ServiceCommandRunner } from "../src/cli/service-manager";
import { inspectSystemdDropIns, parseSystemdPathList } from "../src/cli/systemd-drop-ins";

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--report"), "Usage: tsx scripts/systemd-drop-in-acceptance.ts [--report path]");
const reportPath = resolve(args[1] ?? "systemd-drop-in-acceptance-report.json");
const report = {
  sourceCommit: "unknown", systemdVersion: "unknown", startedAt: new Date().toISOString(),
  finishedAt: "", result: "failed", exitStatus: 1,
  unitPath: [] as string[], fixtureRoots: {} as Record<string, string>,
  checks: [] as Array<{ name: string; result: string; evidence?: unknown; error?: string }>,
  errors: [] as string[],
};
function check(name: string, run: () => unknown) {
  const entry: (typeof report.checks)[number] = { name, result: "failed" };
  report.checks.push(entry);
  try { entry.evidence = run(); entry.result = "passed"; }
  catch (error) { entry.error = String(error); throw error; }
}
function present(path: string) {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function acceptance() {
  assert.ok(process.platform === "linux"
    && process.env.WORKTREE_CONTROL_ISOLATED_SYSTEMD_ACCEPTANCE === "disposable"
    && present("/run/worktree-control-disposable-systemd")
    && readFileSync("/run/worktree-control-disposable-systemd", "utf8").trim() === "worktree-control test fixture only",
  "Requires an explicitly marked disposable systemd environment. Never run on an application host.");
  report.systemdVersion = execFileSync("systemctl", ["--version"], { encoding: "utf8" }).split("\n")[0];
  const calls: string[][] = [];
  let captureFailure = false;
  const failedExitStatuses: string[] = [];
  const runner: ServiceCommandRunner = { run(command, commandArgs) {
    calls.push([command, ...commandArgs]);
    if (captureFailure && command === "systemctl" && commandArgs[1] === "stop" && commandArgs[2] === "worktree-control.service") {
      const sample = runner.run("systemctl", ["--user", "show", "worktree-control.service", "--property=ExecMainStatus", "--value"]);
      assert.equal(sample.status, 0, sample.stderr); failedExitStatuses.push(sample.stdout.trim());
    }
    try {
      return { status: 0, stdout: execFileSync(command, commandArgs, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
    } catch (error) {
      const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
      return { status: failure.status ?? 1, stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? error) };
    }
  } };
  function systemctl(...commandArgs: string[]) {
    const result = runner.run("systemctl", ["--user", ...commandArgs]);
    assert.equal(result.status, 0, `${commandArgs.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  }
  function property(unit: string, name: string) {
    const result = runner.run("systemctl", ["--user", "show", unit, "--property=LoadState", `--property=${name}`]);
    const values = Object.fromEntries(result.stdout.trimEnd().split("\n").map(line => {
      const separator = line.indexOf("="); return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    // systemctl can return nonzero for a missing unit while still supplying its properties.
    assert.ok(result.status === 0 || (result.status === 1 && values.LoadState === "not-found"), result.stderr);
    assert.ok(Object.hasOwn(values, name), `Missing ${name} for ${unit}`);
    return values[name];
  }
  const current = "worktree-control.service", legacy = "worktree-switcher.service";
  const scopes = [current, legacy, "worktree-.service", "service"];
  const home = resolve(homedir());
  const configRoot = join(resolve(process.env.XDG_CONFIG_HOME ?? join(home, ".config")), "systemd/user");
  const runtimeRoot = join(resolve(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid!()}`), "systemd/user");
  const dataRoot = join(resolve(process.env.XDG_DATA_HOME ?? join(home, ".local/share")), "systemd/user");
  const parsedRoots = parseSystemdPathList(systemctl("show", "--property=UnitPath", "--value"));
  assert.ok(parsedRoots?.length, "Manager must advertise a parseable UnitPath");
  const roots: string[] = parsedRoots;
  report.unitPath = roots;
  report.fixtureRoots = { config: configRoot, runtime: runtimeRoot, data: dataRoot };
  const ownedRoots = [configRoot, runtimeRoot, dataRoot];
  check("fixture guards and actual manager lookup roots", () => {
    assert.equal(new Set(ownedRoots).size, 3);
    for (const root of ownedRoots) {
      assert.ok(roots.includes(root), `Required user-owned root missing from UnitPath: ${root}`);
      let ancestor: string = root;
      while (!present(ancestor)) ancestor = dirname(ancestor);
      assert.equal(lstatSync(ancestor).uid, process.getuid!(), `Not user-owned: ${ancestor}`);
      assert.equal(realpathSync(ancestor), ancestor, `Aliased fixture root: ${ancestor}`);
    }
    assert.ok(roots.indexOf(configRoot) < roots.indexOf(runtimeRoot) && roots.indexOf(runtimeRoot) < roots.indexOf(dataRoot),
      "Requires config > runtime > data lookup priority; unsupported topology must fail");
    for (const root of roots) {
      for (const unit of [current, legacy]) assert.equal(present(join(root, unit)), false, `Existing unit: ${root}/${unit}`);
      for (const scope of scopes) assert.equal(present(join(root, `${scope}.d`)), false, `Existing fixture scope: ${root}/${scope}.d`);
    }
    for (const unit of [current, legacy]) {
      assert.equal(property(unit, "LoadState"), "not-found", `Existing loaded unit: ${unit}`);
      assert.equal(property(unit, "MainPID"), "0");
      assert.notEqual(runner.run("systemctl", ["--user", "is-enabled", unit]).status, 0);
    }
    return report.fixtureRoots;
  });

  const manager = new UserServiceManager({ homeDirectory: home, runner, health: { stableMs: 1000, intervalMs: 100, timeoutMs: 8000 } });
  const temporary = mkdtempSync(join(tmpdir(), 'wtc systemd "acceptance"-'));
  const createdDirectories: string[] = [];
  const wantsDirectory = join(configRoot, "default.target.wants");
  const wantsExisted = present(wantsDirectory);
  const fixturePids = new Set<number>();
  function mkdir(path: string) {
    if (present(path)) return;
    mkdir(dirname(path)); mkdirSync(path, { mode: 0o700 }); createdDirectories.push(path);
  }
  function put(root: string, scope: string, name: string, contents: string | null) {
    assert.ok(ownedRoots.includes(root));
    const directory = join(root, `${scope}.d`); mkdir(directory);
    const path = join(directory, name);
    if (contents === null) symlinkSync("/dev/null", path);
    else writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
    return path;
  }
  const resource = (key: string, value: string) => `[Service]\n${key}=${value}\n`;
  const entrypoint = join(temporary, "fixture.cjs"), failingEntrypoint = join(temporary, "fail.cjs");
  writeFileSync(entrypoint, "setInterval(() => {}, 1000);\n");
  writeFileSync(failingEntrypoint, "process.exit(42);\n");
  const options = {
    nodePath: process.execPath, entrypointPath: entrypoint, workingDirectory: temporary, refresh: false,
    stateDirectory: join(temporary, "state"), startArguments: [
      "--service-mode", "--no-open", "--host", "127.0.0.1", "--port", "49151", "--mcp-port", "49152",
      "--browse-root", temporary, "--data-dir", join(temporary, "data"), "--state-dir", join(temporary, "state"), "--web-root", temporary,
    ],
  };
  const commonPaths: string[] = [];
  const specificName = '30-specific "quoted".conf';
  const migrationNames = ["73-migrated-mask.conf", "74-migrated-empty.conf"];
  function pid(unit: string) {
    assert.equal(property(unit, "ActiveState"), "active");
    const value = Number(property(unit, "MainPID")); assert.ok(value > 0);
    process.kill(value, 0); fixturePids.add(value); return value;
  }
  function assertLoaded(unit: string, migrated = false) {
    const expected = [...commonPaths, join(configRoot, `${unit}.d`, specificName),
      ...(migrated ? migrationNames.map(name => join(configRoot, `${unit}.d`, name)) : [])]
      .sort((a, b) => Buffer.compare(Buffer.from(a.slice(a.lastIndexOf("/") + 1)), Buffer.from(b.slice(b.lastIndexOf("/") + 1))));
    const inspected = inspectSystemdDropIns(roots, unit);
    const raw = property(unit, "DropInPaths"), loaded = parseSystemdPathList(raw);
    assert.deepEqual(inspected.files.map(file => file.path), expected, `${unit}: inspector winners`);
    // Include /dev/null and empty files. systemd's CONF_FILES flags do not filter masks here.
    assert.deepEqual(loaded, expected, `${unit}: actual loaded DropInPaths (${raw})`);
    const values = Object.fromEntries(["MemoryMax", "MemoryHigh", "MemoryLow", "MemorySwapMax", "TasksMax", "CPUWeight", "TasksAccounting"]
      .map(name => [name, property(unit, name)]));
    assert.deepEqual(values, { MemoryMax: "469762048", MemoryHigh: "100663296", MemoryLow: "0", MemorySwapMax: "infinity", TasksMax: "64", CPUWeight: "77", TasksAccounting: "yes" });
    assert.equal(property(unit, "FragmentPath"), join(configRoot, unit));
    assert.equal(property(unit, "NeedDaemonReload"), "no");
    return { unit, loadedPaths: loaded, effectiveProperties: values, pid: pid(unit) };
  }
  function assertRefusal(unit: string, installOptions = options) {
    const originalPid = pid(unit), definition = readFileSync(join(configRoot, unit), "utf8"), start = calls.length;
    assert.throws(() => manager.install(installOptions), /Inspect and reconcile/);
    const attempted = calls.slice(start);
    assert.deepEqual(attempted.filter(call => call[0] === "systemctl"
      && ["stop", "start", "restart", "try-restart", "reload", "reload-or-restart", "disable", "enable", "kill"].includes(call[2])), [], "Refusal must make no lifecycle calls");
    assert.equal(pid(unit), originalPid);
    assert.equal(readFileSync(join(configRoot, unit), "utf8"), definition);
    if (unit === legacy) {
      assert.equal(present(manager.definitionPath), false);
      for (const name of [specificName, ...migrationNames]) assert.equal(present(`${manager.definitionPath}.d/${name}`), false);
    }
    return { unit, unchangedPid: originalPid, lifecycleCalls: 0 };
  }
  function assertFailedStart(installOptions: typeof options) {
    const start = calls.length;
    const failuresBefore = failedExitStatuses.length;
    captureFailure = true;
    try { assert.throws(() => manager.install({ ...installOptions, entrypointPath: failingEntrypoint }), /failed|unhealthy|healthy/i); }
    finally { captureFailure = false; }
    assert.deepEqual(failedExitStatuses.slice(failuresBefore), ["42"], "Must observe the real failing fixture exit before rollback stops it");
    const attempted = calls.slice(start);
    assert.ok(attempted.some(call => call[2] === (installOptions.refresh ? "restart" : "start") && call[3] === current), "Must actually attempt the failing service");
    assert.ok(attempted.some(call => call[2] === "stop" && call[3] === current), "Rollback must stop the failed candidate");
    const reset = runner.run("systemctl", ["--user", "reset-failed", current]);
    assert.ok(reset.status === 0 || property(current, "LoadState") === "not-found", reset.stderr);
    return { attemptedStart: true, observedExitStatus: 42, rollbackStop: true };
  }
  try {
    // Distinct basenames exercise lookup selection separately from application order.
    commonPaths.push(put(dataRoot, "service", '10-type "resource".conf', resource("MemoryMax", "256M")));
    commonPaths.push(put(configRoot, "worktree-.service", "20-root.conf", resource("TasksMax", "64")));
    for (const unit of [current, legacy]) {
      put(runtimeRoot, unit, "20-root.conf", resource("TasksMax", "128"));
      put(dataRoot, unit, "20-root.conf", resource("TasksMax", "192"));
      put(configRoot, unit, specificName, resource("MemoryHigh", "96M"));
    }
    put(configRoot, "worktree-.service", specificName, resource("MemoryHigh", "128M"));
    commonPaths.push(put(dataRoot, "worktree-.service", "40-named.conf", resource("CPUWeight", "77")));
    put(configRoot, "service", "40-named.conf", resource("CPUWeight", "88"));
    commonPaths.push(put(configRoot, "worktree-.service", "50-same-scope.conf", resource("TasksAccounting", "yes")));
    put(runtimeRoot, "worktree-.service", "50-same-scope.conf", resource("TasksAccounting", "no"));
    put(dataRoot, "worktree-.service", "50-same-scope.conf", resource("TasksAccounting", "no"));
    commonPaths.push(put(runtimeRoot, "worktree-.service", "60-lexical.conf", resource("MemoryMax", "320M")));
    commonPaths.push(put(configRoot, "worktree-.service", "71-mask.conf", null));
    put(runtimeRoot, "worktree-.service", "71-mask.conf", resource("MemoryLow", "64M"));
    commonPaths.push(put(configRoot, "worktree-.service", "72-empty.conf", ""));
    put(dataRoot, "worktree-.service", "72-empty.conf", resource("MemorySwapMax", "32M"));
    // Insert lower-case first; the manager must still apply Z before a by byte order.
    commonPaths.push(put(configRoot, "worktree-.service", "80-a.conf", resource("MemoryMax", "448M")));
    commonPaths.push(put(runtimeRoot, "service", "80-Z.conf", resource("MemoryMax", "384M")));
    check("failed fresh start rolls back definition and enabled state", () => {
      const evidence = assertFailedStart(options);
      assert.equal(present(manager.definitionPath), false);
      assert.notEqual(runner.run("systemctl", ["--user", "is-enabled", current]).status, 0);
      return evidence;
    });
    check("fresh install: cross-root/scope precedence, lexical order, masks, empty and quoted paths", () => {
      manager.install(options); return assertLoaded(current);
    });
    check("failed refresh restores previous definition and running policy", () => {
      const definition = readFileSync(manager.definitionPath, "utf8");
      assertFailedStart({ ...options, refresh: true });
      assert.equal(readFileSync(manager.definitionPath, "utf8"), definition);
      assert.equal(systemctl("is-enabled", current), "enabled");
      return assertLoaded(current);
    });
    check("refresh preserves loaded paths and effective properties", () => {
      manager.install({ ...options, refresh: true, workingDirectory: dirname(temporary) });
      return assertLoaded(current);
    });
    manager.uninstall();
    rmSync(join(configRoot, `${current}.d`, specificName));
    rmdirSync(join(configRoot, `${current}.d`));
    mkdir(configRoot);
    writeFileSync(manager.legacyDefinitionPath, renderSystemdUnit(options), { flag: "wx" });
    put(configRoot, legacy, migrationNames[0], null);
    put(configRoot, legacy, migrationNames[1], "");
    put(runtimeRoot, "worktree-.service", migrationNames[0], resource("CPUWeight", "33"));
    put(dataRoot, "worktree-.service", migrationNames[1], resource("TasksMax", "4"));
    systemctl("daemon-reload"); systemctl("enable", "--now", legacy);
    check("legacy source includes local masks and empty suppression", () => assertLoaded(legacy, true));
    check("destination policy mismatch refuses without lifecycle calls or PID change", () => {
      const path = put(configRoot, current, "90-different.conf", resource("MemoryLow", "64M"));
      systemctl("daemon-reload");
      try { return assertRefusal(legacy); }
      finally { rmSync(path); systemctl("daemon-reload"); }
    });
    for (const scope of ["service", "worktree-.service"]) {
      check(`unsafe ${scope}.d refuses without lifecycle calls or PID change`, () => {
        const path = put(configRoot, scope, "91-unsafe.conf", "[Service]\nEnvironment=WTC_FIXTURE=1\n");
        systemctl("daemon-reload");
        try { return assertRefusal(legacy); }
        finally { rmSync(path); systemctl("daemon-reload"); }
      });
    }
    check("failed migration removes copies and restores active enabled legacy service", () => {
      const definition = readFileSync(manager.legacyDefinitionPath, "utf8");
      assertFailedStart(options);
      assert.equal(present(manager.definitionPath), false);
      for (const name of [specificName, ...migrationNames]) assert.equal(present(`${manager.definitionPath}.d/${name}`), false);
      assert.equal(readFileSync(manager.legacyDefinitionPath, "utf8"), definition);
      assert.equal(readlinkSync(`${manager.legacyDefinitionPath}.d/${migrationNames[0]}`), "/dev/null");
      assert.equal(readFileSync(`${manager.legacyDefinitionPath}.d/${migrationNames[1]}`, "utf8"), "");
      assert.equal(systemctl("is-enabled", legacy), "enabled");
      assert.notEqual(runner.run("systemctl", ["--user", "is-enabled", current]).status, 0);
      return assertLoaded(legacy, true);
    });
    check("legacy migration copies masks/empty files and preserves effective loaded policy", () => {
      manager.install(options);
      assert.equal(present(manager.legacyDefinitionPath), false);
      assert.equal(readlinkSync(`${manager.definitionPath}.d/${migrationNames[0]}`), "/dev/null");
      assert.equal(readFileSync(`${manager.definitionPath}.d/${migrationNames[1]}`, "utf8"), "");
      assert.equal(systemctl("is-enabled", current), "enabled");
      return assertLoaded(current, true);
    });
  } finally {
    check("cleanup removes owned units, policies, enablement and live fixture processes", () => {
      // Attempt every cleanup step even when an earlier assertion fails.
      const cleanupErrors: string[] = [];
      function clean(run: () => void) {
        try { run(); } catch (error) { cleanupErrors.push(String(error)); }
      }
      clean(() => { manager.uninstall(); });
      for (const unit of [current, legacy]) clean(() => {
        assert.equal(property(unit, "MainPID"), "0");
        assert.notEqual(property(unit, "ActiveState"), "active");
        assert.notEqual(runner.run("systemctl", ["--user", "is-enabled", unit]).status, 0);
        assert.equal(present(join(wantsDirectory, unit)), false);
        assert.equal(present(join(configRoot, unit)), false);
      });
      for (const root of ownedRoots) for (const scope of scopes) clean(() => {
        rmSync(join(root, `${scope}.d`), { recursive: true, force: true });
        assert.equal(present(join(root, `${scope}.d`)), false);
      });
      clean(() => { systemctl("daemon-reload"); });
      for (const unit of [current, legacy]) clean(() => {
        const reset = runner.run("systemctl", ["--user", "reset-failed", unit]);
        assert.ok(reset.status === 0 || property(unit, "LoadState") === "not-found", reset.stderr);
        assert.equal(property(unit, "LoadState"), "not-found");
        assert.equal(property(unit, "ActiveState"), "inactive");
        assert.equal(property(unit, "MainPID"), "0");
      });
      for (const value of fixturePids) clean(() => { assert.throws(() => process.kill(value, 0), { code: "ESRCH" }); });
      clean(() => { rmSync(temporary, { recursive: true, force: true }); assert.equal(present(temporary), false); });
      if (!wantsExisted && present(wantsDirectory)) clean(() => { rmdirSync(wantsDirectory); });
      for (const path of createdDirectories.reverse()) clean(() => {
        if (present(path)) rmdirSync(path);
      });
      assert.deepEqual(cleanupErrors, [], "Disposable fixture cleanup failed");
      return { unitsRemoved: [current, legacy], observedPidsStopped: [...fixturePids] };
    });
  }
}

try {
  report.sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirname(dirname(fileURLToPath(import.meta.url))), encoding: "utf8" }).trim();
  acceptance(); report.result = "passed"; report.exitStatus = 0;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ result: report.result, sourceCommit: report.sourceCommit, systemdVersion: report.systemdVersion, reportPath, exitStatus: report.exitStatus }));
  process.exitCode = report.exitStatus;
}
