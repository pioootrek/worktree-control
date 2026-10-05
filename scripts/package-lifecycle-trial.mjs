#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const INSTALL_TIMEOUT = 300_000;
const STEP_TIMEOUT = 45_000;
const SESSION_TIMEOUT = 90_000;
const UNIT_NAME = "worktree-control.service";
/** Pre-rename unit. `service install` would migrate it away, so the trial refuses to run beside it. */
const LEGACY_UNIT_NAME = "worktree-switcher.service";
const SECRET_MARKER = "package-lifecycle-secret-must-not-leak";

export function redact(value) {
  return String(value)
    .replaceAll(SECRET_MARKER, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/wsi_[A-Za-z0-9_-]+/g, "wsi_[REDACTED]")
    .replace(/([#?&](?:token|access_token)=)[^\s&#]+/gi, "$1[REDACTED]")
    .replace(/(_authToken\s*=\s*)\S+/gi, "$1[REDACTED]");
}

export function parseArguments(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };
  const required = (name) => {
    const result = value(name);
    if (!result) throw new Error(`Missing required argument: ${name}`);
    return result;
  };
  const expectedUid = Number(required("--expected-uid"));
  if (!Number.isSafeInteger(expectedUid) || expectedUid <= 0) throw new Error("--expected-uid must be a positive integer.");
  const candidateSha256 = required("--candidate-sha256");
  if (!/^[a-f0-9]{64}$/.test(candidateSha256)) throw new Error("--candidate-sha256 must be a lowercase SHA-256 digest.");
  const sessionReady = value("--session-ready") ? resolve(value("--session-ready")) : null;
  const sessionContinue = value("--session-continue") ? resolve(value("--session-continue")) : null;
  if (Boolean(sessionReady) !== Boolean(sessionContinue)) {
    throw new Error("--session-ready and --session-continue must be provided together.");
  }
  const result = {
    candidate: resolve(required("--candidate")),
    candidateSha256,
    provenance: resolve(required("--provenance")),
    prefix: resolve(required("--prefix")),
    dataDirectory: resolve(required("--data-dir")),
    stateDirectory: resolve(required("--state-dir")),
    browseRoot: resolve(required("--browse-root")),
    report: resolve(required("--report")),
    expectedUid,
    sessionReady,
    sessionContinue,
  };
  if (!result.prefix.includes(" ")) throw new Error("--prefix must contain a space for the packaged-path trial.");
  const ownedPaths = [result.prefix, result.dataDirectory, result.stateDirectory, result.browseRoot];
  if (new Set(ownedPaths).size !== ownedPaths.length) throw new Error("Prefix, data, state, and browse-root paths must be distinct.");
  return result;
}

export function inspectSystemdDefinition(definition, expected) {
  const required = [
    `"${expected.nodePath}"`,
    `"${expected.entrypointPath}"`,
    `"--data-dir" "${expected.dataDirectory}"`,
    `"--state-dir" "${expected.stateDirectory}"`,
    `"--web-root" "${expected.webRoot}"`,
    "WantedBy=default.target",
    "KillMode=control-group",
  ];
  for (const fragment of required) {
    if (!definition.includes(fragment)) throw new Error(`Service definition is missing the installed value: ${fragment}`);
  }
  const workingDirectory = expected.packageRoot.replaceAll("%", "%%");
  if (!definition.includes(`WorkingDirectory=${workingDirectory}`)) {
    throw new Error("Service definition does not use the installed package as its working directory.");
  }
  for (const forbidden of expected.forbiddenPaths) {
    if (forbidden && definition.includes(forbidden)) throw new Error(`Service definition contains a builder path: ${forbidden}`);
  }
  return { requiredFragments: required.length + 1, builderPathsAbsent: true };
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function runResult(file, args, options = {}) {
  try {
    const result = await exec(file, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      timeout: options.timeout ?? STEP_TIMEOUT,
      maxBuffer: 2_000_000,
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      status: typeof error.code === "number" ? error.code : 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? ""),
    };
  }
}

async function run(file, args, options = {}) {
  const result = await runResult(file, args, options);
  if (result.status !== 0) {
    throw new Error(`${basename(file)} ${args[0] ?? ""} failed: ${redact(result.stderr || result.stdout || `exit code ${result.status}`)}`);
  }
  return result;
}

function check(value, message) {
  if (!value) throw new Error(message);
  return value;
}

async function waitFor(task, description, timeout = STEP_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      await new Promise((accept) => setTimeout(accept, 150));
    }
  }
  throw new Error(`${description}: ${redact(lastError instanceof Error ? lastError.message : "timed out")}`);
}

async function requireEmptyDirectory(path, label) {
  check((await stat(path)).isDirectory(), `${label} is not a directory: ${path}`);
  check((await readdir(path)).length === 0, `${label} must be empty: ${path}`);
}

async function freePort() {
  return await new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : accept(address.port));
    });
  });
}

async function systemdProperties(environment, unit = UNIT_NAME) {
  const result = await runResult("systemctl", [
    "--user", "show", unit,
    "--property=LoadState", "--property=ActiveState", "--property=SubState",
    "--property=MainPID", "--property=NRestarts", "--property=ExecMainCode",
    "--property=ExecMainStatus", "--property=Result",
  ], { env: environment });
  const values = Object.fromEntries(result.stdout.split(/\r?\n/).map((line) => line.split("=", 2)).filter(([key]) => key));
  return { ...values, status: result.status };
}

async function serviceDiagnostic(environment) {
  const properties = await systemdProperties(environment);
  const journal = await runResult("journalctl", ["--user", "--unit", UNIT_NAME, "--no-pager", "--lines", "20", "--output", "cat"], { env: environment });
  const journalText = redact(journal.stdout || journal.stderr).trim().slice(-4_000);
  return `properties: ${JSON.stringify(properties)}${journalText ? `; journal: ${journalText}` : ""}`;
}

async function waitForActive(environment, previousPid = null) {
  try {
    return await waitFor(async () => {
      const properties = await systemdProperties(environment);
      const pid = Number(properties.MainPID);
      check(properties.ActiveState === "active" && properties.SubState === "running" && pid > 0, `service is not active/running (${JSON.stringify(properties)})`);
      check(previousPid === null || pid !== previousPid, "service PID did not change");
      return { pid, restarts: Number(properties.NRestarts || 0) };
    }, "service did not become active");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; ${await serviceDiagnostic(environment)}`);
  }
}

async function waitForInactive(environment) {
  await waitFor(async () => {
    const properties = await systemdProperties(environment);
    check(properties.ActiveState !== "active", "service is still active");
  }, "service did not stop");
}

async function readCurrentAccess(stateDirectory) {
  const accessPath = join(stateDirectory, "service-access.json");
  return JSON.parse(await readFile(accessPath, "utf8"));
}

async function verifyDashboard(stateDirectory, expectedVersion, environment, token) {
  let access;
  try {
    access = await waitFor(() => readCurrentAccess(stateDirectory), "service access record was not created");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; ${await serviceDiagnostic(environment)}`);
  }
  check(access.version === expectedVersion, "running service version does not match candidate provenance");
  // New installations run in token mode: the access record carries no secret.
  check(access.authenticationMode === "token", "service does not run in token mode");
  check(new URL(access.accessUrl).hash === "", "service access record exposes a browser token");
  const response = await fetch(`${access.localDashboardEndpoint}/api/dashboard`, {
    headers: { "X-Worktree-Control-Token": token },
    signal: AbortSignal.timeout(2_000),
  });
  check(response.ok, `dashboard returned HTTP ${response.status}`);
  const dashboard = await response.json();
  check(dashboard.mcp?.phase === "running", "packaged MCP endpoint is not running");
  const accessRecordMode = (await stat(join(stateDirectory, "service-access.json"))).mode & 0o777;
  check(accessRecordMode === 0o600, "service access record is not owner-only");
  return { version: access.version, dashboardReachable: true, mcpRunning: true, accessRecordMode: "0600" };
}

async function waitForRestartFailure(environment, initialRestarts) {
  return await waitFor(async () => {
    const properties = await systemdProperties(environment);
    const restarts = Number(properties.NRestarts || 0);
    check(restarts > initialRestarts || Number(properties.ExecMainStatus) !== 0, "service failure has not been recorded");
    return { activeState: properties.ActiveState, subState: properties.SubState, restarts };
  }, "systemd did not record the expected startup failure", 20_000);
}

async function stopKnownProcess(child) {
  if (!child || child.exitCode !== null) return true;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((accept) => child.once("exit", () => accept(true))),
    new Promise((accept) => setTimeout(() => accept(false), 15_000)),
  ]);
  if (!exited) child.kill("SIGKILL");
  return exited;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const definitionPath = join(homedir(), ".config", "systemd", "user", UNIT_NAME);
  const startedAt = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    candidate: null,
    oldFixture: null,
    environment: null,
    preflight: [],
    phases: [],
    negativeScenarios: [],
    faults: [],
    retainedState: null,
    cleanup: { graceful: false, serviceAbsent: false, dataPreserved: false },
    manualSteps: [],
    startedAt,
    completedAt: null,
    outcome: "failed",
  };
  let cli;
  let serviceEnvironment;
  let foreground;
  let occupiedServer;
  let serviceMayExist = false;
  let browserRecord;
  let firstServicePid;
  let installationToken;

  const record = async (collection, name, task) => {
    const phase = { name, startedAt: new Date().toISOString(), completedAt: null, outcome: "failed", evidence: null };
    report[collection].push(phase);
    try {
      phase.evidence = await task();
      phase.outcome = "passed";
      return phase.evidence;
    } catch (error) {
      phase.diagnostic = redact(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      phase.completedAt = new Date().toISOString();
    }
  };

  try {
    await record("preflight", "isolated-environment", async () => {
      check(process.platform === "linux", "packaged service lifecycle requires Linux");
      check(process.getuid?.() === options.expectedUid, "current UID does not match --expected-uid");
      check(options.expectedUid !== 0, "packaged service lifecycle must not run as root");
      check(resolve(process.env.HOME ?? "") === resolve(homedir()), "HOME does not match the dedicated account");
      check(process.env.XDG_RUNTIME_DIR === `/run/user/${options.expectedUid}`, "XDG_RUNTIME_DIR does not identify the dedicated user manager");
      const manager = await runResult("systemctl", ["--user", "is-system-running"], { env: process.env });
      check(["running", "degraded"].includes(manager.stdout.trim()), `systemd user manager is unavailable: ${manager.stderr || manager.stdout}`);
      const linger = await runResult("loginctl", ["show-user", String(options.expectedUid), "--property=Linger", "--value"], { env: process.env });
      return { uid: options.expectedUid, userManager: manager.stdout.trim(), linger: linger.status === 0 ? linger.stdout.trim() : "unavailable" };
    });

    const provenance = await record("preflight", "artifact-identity", async () => {
      check(existsSync(options.candidate), `candidate does not exist: ${options.candidate}`);
      check(existsSync(options.provenance), `provenance does not exist: ${options.provenance}`);
      check(await sha256(options.candidate) === options.candidateSha256, "candidate checksum mismatch");
      const parsed = JSON.parse(await readFile(options.provenance, "utf8"));
      check(parsed.artifact?.sha256 === options.candidateSha256, "provenance checksum does not match candidate");
      check(basename(options.candidate) === parsed.artifact?.filename, "provenance filename does not match candidate");
      check((await stat(options.candidate)).size === parsed.artifact?.bytes, "provenance size does not match candidate");
      check(/^[a-f0-9]{40}$/.test(parsed.source?.commit), "provenance does not contain a full source commit");
      check(!process.env.GITHUB_SHA || parsed.source.commit === process.env.GITHUB_SHA, "provenance source commit does not match the CI commit");
      check(parsed.package?.private === true && /^0\.\d+\.\d+-/.test(parsed.package?.version), "candidate is not a private pre-1.0 trial package");
      return parsed;
    });
    report.candidate = {
      name: provenance.package.name,
      version: provenance.package.version,
      sourceCommit: provenance.source.commit,
      sha256: provenance.artifact.sha256,
      bytes: provenance.artifact.bytes,
    };

    await record("preflight", "empty-owned-paths", async () => {
      for (const [path, label] of [
        [options.prefix, "prefix"], [options.dataDirectory, "data directory"],
        [options.stateDirectory, "state directory"], [options.browseRoot, "browse root"],
      ]) await requireEmptyDirectory(path, label);
      check(!existsSync(definitionPath), `service definition already exists: ${definitionPath}`);
      const loaded = await systemdProperties(process.env);
      check(loaded.LoadState === "not-found", `${UNIT_NAME} is already loaded by this user manager`);
      check(!existsSync(join(dirname(definitionPath), LEGACY_UNIT_NAME)), `legacy service definition exists; the trial would migrate it: ${LEGACY_UNIT_NAME}`);
      const legacy = await systemdProperties(process.env, LEGACY_UNIT_NAME);
      check(legacy.LoadState === "not-found", `${LEGACY_UNIT_NAME} is loaded by this user manager; the trial would migrate it`);
      return { emptyDirectories: 4, definitionAbsent: true, singletonAbsent: true, legacyAbsent: true };
    });

    let dashboardPort = await freePort();
    let mcpPort = await freePort();
    while (mcpPort === dashboardPort) mcpPort = await freePort();
    const fakeBin = join(options.prefix, "fake-browser-bin");
    browserRecord = join(options.stateDirectory, "browser-opened");
    await mkdir(fakeBin, { recursive: true });
    const fakeBrowser = join(fakeBin, "xdg-open");
    await writeFile(fakeBrowser, "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.WORKTREE_CONTROL_BROWSER_RECORD, process.argv[2]);\n", { mode: 0o700 });
    await chmod(fakeBrowser, 0o700);
    const forwardedNetwork = Object.fromEntries([
      "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
      "NODE_EXTRA_CA_CERTS", "npm_config_registry",
    ].flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
    serviceEnvironment = {
      PATH: `${fakeBin}:${options.prefix}/bin:${process.env.PATH}`,
      HOME: homedir(),
      LANG: "C.UTF-8",
      ...forwardedNetwork,
      DISPLAY: ":package-lifecycle-trial",
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      WORKTREE_CONTROL_BROWSER_RECORD: browserRecord,
      npm_config_cache: join(options.prefix, "npm-cache"),
      npm_config_userconfig: join(options.prefix, "empty-npmrc"),
      npm_config_globalconfig: join(options.prefix, "empty-global-npmrc"),
    };
    await Promise.all([
      writeFile(serviceEnvironment.npm_config_userconfig, ""),
      writeFile(serviceEnvironment.npm_config_globalconfig, ""),
    ]);
    report.environment = {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      npm: (await run("npm", ["--version"], { env: serviceEnvironment })).stdout.trim(),
      uid: options.expectedUid,
      serviceManager: (await run("systemctl", ["--version"], { env: serviceEnvironment })).stdout.split("\n", 1)[0],
      dashboardPort,
      mcpPort,
    };

    const installArguments = [
      "service", "install", "--host", "127.0.0.1", "--port", String(dashboardPort),
      "--mcp-port", String(mcpPort), "--browse-root", options.browseRoot,
      "--data-dir", options.dataDirectory, "--state-dir", options.stateDirectory,
    ];
    await record("phases", "install-candidate", async () => {
      await run("npm", ["install", "--global", "--prefix", options.prefix, "--omit=dev", "--no-audit", "--no-fund", options.candidate], {
        env: serviceEnvironment,
        timeout: INSTALL_TIMEOUT,
      });
      cli = join(options.prefix, "bin", "worktree-control");
      check((await stat(cli)).isFile(), "installed CLI is missing");
      const packageRoot = await realpath(join(options.prefix, "lib", "node_modules", "worktree-control"));
      const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
      check(metadata.version === provenance.package.version, "installed package version does not match provenance");
      await run(process.execPath, ["-e", "require('better-sqlite3')"], { cwd: packageRoot, env: serviceEnvironment });
      const generated = await run(cli, ["auth", "token", "generate", "--data-dir", options.dataDirectory, "--state-dir", options.stateDirectory], { env: serviceEnvironment });
      installationToken = JSON.parse(generated.stdout).token;
      check(/^wsi_/.test(installationToken ?? ""), "installation token was not generated");
      serviceMayExist = true;
      await run(cli, installArguments, { env: serviceEnvironment });
      const active = await waitForActive(serviceEnvironment);
      firstServicePid = active.pid;
      const dashboard = await verifyDashboard(options.stateDirectory, provenance.package.version, serviceEnvironment, installationToken);
      const definition = await readFile(definitionPath, "utf8");
      const definitionEvidence = inspectSystemdDefinition(definition, {
        nodePath: resolve(process.execPath),
        entrypointPath: await realpath(join(packageRoot, "dist", "cli", "index.js")),
        packageRoot,
        dataDirectory: options.dataDirectory,
        stateDirectory: options.stateDirectory,
        webRoot: join(packageRoot, "out"),
        forbiddenPaths: [process.env.GITHUB_WORKSPACE, dirname(options.candidate)],
      });
      check(((await stat(definitionPath)).mode & 0o777) === 0o600, "service definition is not owner-only");
      check(!/[#?&](?:token|access_token)=|Bearer\s+|wsi_/i.test(definition), "service definition contains credential material");
      await run("systemd-analyze", ["--user", "verify", definitionPath], { env: serviceEnvironment });
      const enabled = await run("systemctl", ["--user", "is-enabled", UNIT_NAME], { env: serviceEnvironment });
      check(enabled.stdout.trim() === "enabled", "service is not enabled for the user session");
      return { pid: active.pid, installedVersion: metadata.version, nativeSqlite: "loaded", dashboard, definition: definitionEvidence, definitionMode: "0600", enabled: true };
    });

    await record("phases", "status-and-idempotent-install", async () => {
      const status = await run(cli, ["service", "status", "--state-dir", options.stateDirectory], { env: serviceEnvironment });
      check(status.stdout.includes("Service: active/running"), "CLI status did not report active/running");
      check(status.stdout.includes(`Version: ${provenance.package.version}`), "CLI status did not report the candidate version");
      check(!/[#?&](?:token|access_token)=/i.test(status.stdout), "CLI status leaked a private access token");
      const reinstall = await run(cli, installArguments, { env: serviceEnvironment });
      check(reinstall.stdout.includes("Service already up to date"), "repeated install was not reported as idempotent");
      const unchanged = await waitForActive(serviceEnvironment);
      check(unchanged.pid === firstServicePid, "idempotent install restarted the controller");
      return { pidUnchanged: true, statusSafe: true, dashboard: await verifyDashboard(options.stateDirectory, provenance.package.version, serviceEnvironment, installationToken) };
    });

    await record("phases", "open-and-restart", async () => {
      await rm(browserRecord, { force: true });
      await run(cli, ["service", "open", "--state-dir", options.stateDirectory], { env: serviceEnvironment });
      const recorded = await waitFor(() => readFile(browserRecord, "utf8"), "fake browser did not receive the access URL");
      const opened = new URL(recorded);
      check(opened.hostname === "127.0.0.1" && opened.hash === "", "service open did not pass the local sign-in URL without a secret");
      await rm(browserRecord, { force: true });
      await run(cli, ["service", "restart", "--state-dir", options.stateDirectory], { env: serviceEnvironment });
      const restarted = await waitForActive(serviceEnvironment, firstServicePid);
      await verifyDashboard(options.stateDirectory, provenance.package.version, serviceEnvironment, installationToken);
      return { fakeBrowserUsed: true, pidChanged: true, pid: restarted.pid };
    });

    if (options.sessionReady && options.sessionContinue) {
      await record("phases", "new-user-session", async () => {
        const before = await waitForActive(serviceEnvironment);
        await writeFile(options.sessionReady, `${before.pid}\n`, { mode: 0o600 });
        await waitFor(() => stat(options.sessionContinue), "session restart coordinator did not continue", SESSION_TIMEOUT);
        await waitForActive(serviceEnvironment, before.pid);
        await verifyDashboard(options.stateDirectory, provenance.package.version, serviceEnvironment, installationToken);
        return { managerRestarted: true, enabledServiceStarted: true, pidChanged: true };
      });
    } else {
      report.manualSteps.push("Restart the disposable user's systemd manager and verify the enabled service starts with a new login session.");
    }

    await record("phases", "stop-and-repeated-install", async () => {
      await run(cli, ["service", "stop", "--state-dir", options.stateDirectory], { env: serviceEnvironment });
      await waitForInactive(serviceEnvironment);
      check(!existsSync(join(options.stateDirectory, "service-access.json")), "clean stop left a service access record");
      await run(cli, installArguments, { env: serviceEnvironment });
      await waitForActive(serviceEnvironment);
      await verifyDashboard(options.stateDirectory, provenance.package.version, serviceEnvironment, installationToken);
      await run(cli, ["service", "stop", "--state-dir", options.stateDirectory], { env: serviceEnvironment });
      await waitForInactive(serviceEnvironment);
      return { stopClean: true, repeatedInstallStartedService: true };
    });

    await record("negativeScenarios", "foreground-singleton-owner", async () => {
      const foregroundArguments = [
        "start", "--no-open", "--host", "127.0.0.1", "--port", String(dashboardPort),
        "--mcp-port", String(mcpPort), "--browse-root", options.browseRoot,
        "--data-dir", options.dataDirectory, "--state-dir", options.stateDirectory,
      ];
      foreground = spawn(cli, foregroundArguments, { env: serviceEnvironment, stdio: "ignore" });
      await waitFor(async () => {
        check(foreground.exitCode === null, "foreground controller exited unexpectedly");
        const response = await fetch(`http://127.0.0.1:${dashboardPort}/`, { signal: AbortSignal.timeout(1_000) });
        check(response.ok, "foreground dashboard is not reachable");
      }, "foreground controller did not start");
      const before = await systemdProperties(serviceEnvironment);
      await runResult(cli, ["service", "start", "--state-dir", options.stateDirectory], { env: serviceEnvironment });
      const failed = await waitForRestartFailure(serviceEnvironment, Number(before.NRestarts || 0));
      check(foreground.exitCode === null, "service startup interfered with foreground owner");
      const response = await fetch(`http://127.0.0.1:${dashboardPort}/`, { signal: AbortSignal.timeout(1_000) });
      check(response.ok, "foreground owner stopped responding after service conflict");
      await run(cli, ["service", "stop", "--state-dir", options.stateDirectory], { env: serviceEnvironment });
      await waitForInactive(serviceEnvironment);
      await run("systemctl", ["--user", "reset-failed", UNIT_NAME], { env: serviceEnvironment });
      check(await stopKnownProcess(foreground), "foreground controller required forced cleanup");
      foreground = null;
      return { ownerPreserved: true, serviceFailureRecorded: true, restarts: failed.restarts };
    });

    await record("negativeScenarios", "occupied-dashboard-port", async () => {
      occupiedServer = createServer((socket) => socket.end("unrelated\n"));
      await new Promise((accept, reject) => {
        occupiedServer.once("error", reject);
        occupiedServer.listen(dashboardPort, "127.0.0.1", accept);
      });
      const before = await systemdProperties(serviceEnvironment);
      await runResult(cli, ["service", "start", "--state-dir", options.stateDirectory], { env: serviceEnvironment });
      const failed = await waitForRestartFailure(serviceEnvironment, Number(before.NRestarts || 0));
      check(occupiedServer.listening, "service startup stopped the unrelated port owner");
      await run(cli, ["service", "stop", "--state-dir", options.stateDirectory], { env: serviceEnvironment });
      await waitForInactive(serviceEnvironment);
      await run("systemctl", ["--user", "reset-failed", UNIT_NAME], { env: serviceEnvironment });
      await new Promise((accept, reject) => occupiedServer.close((error) => error ? reject(error) : accept()));
      occupiedServer = null;
      return { unrelatedListenerPreserved: true, serviceFailureRecorded: true, restarts: failed.restarts };
    });

    await record("phases", "uninstall-idempotently", async () => {
      await run(cli, ["service", "start", "--state-dir", options.stateDirectory], { env: serviceEnvironment });
      await waitForActive(serviceEnvironment);
      const first = await run(cli, ["service", "uninstall", "--state-dir", options.stateDirectory], { env: serviceEnvironment });
      check(first.stdout.includes("Removed:"), "first uninstall did not remove the service definition");
      const second = await run(cli, ["service", "uninstall", "--state-dir", options.stateDirectory], { env: serviceEnvironment });
      check(second.stdout.includes("Service was not installed"), "second uninstall was not idempotent");
      const properties = await systemdProperties(serviceEnvironment);
      check(properties.LoadState === "not-found" && !existsSync(definitionPath), "service remains loaded or installed after uninstall");
      check(existsSync(join(options.dataDirectory, "state.sqlite3")), "uninstall removed application data");
      check(existsSync(join(options.dataDirectory, "mcp-token")), "uninstall removed MCP credentials");
      check(((await stat(join(options.dataDirectory, "mcp-token"))).mode & 0o777) === 0o600, "preserved MCP credential is not owner-only");
      serviceMayExist = false;
      report.retainedState = { database: true, mcpCredential: true, logs: existsSync(join(options.stateDirectory, "logs")) };
      report.cleanup = { graceful: true, serviceAbsent: true, dataPreserved: true };
      return { repeatedUninstallSafe: true, definitionAbsent: true, dataPreserved: true };
    });

    report.outcome = "passed";
  } catch (error) {
    report.error = redact(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (occupiedServer?.listening) await new Promise((accept) => occupiedServer.close(accept));
    if (browserRecord) await rm(browserRecord, { force: true });
    if (foreground) {
      const graceful = await stopKnownProcess(foreground);
      if (!graceful) report.cleanup.graceful = false;
    }
    const loadedService = serviceEnvironment ? await systemdProperties(serviceEnvironment) : null;
    const cleanupNeeded = serviceMayExist || existsSync(definitionPath) || (loadedService && loadedService.LoadState !== "not-found");
    if (cleanupNeeded && cli && serviceEnvironment) {
      const cleanup = await runResult(cli, ["service", "uninstall", "--state-dir", options.stateDirectory], { env: serviceEnvironment });
      if (cleanup.status !== 0) report.cleanup.diagnostic = redact(cleanup.stderr || cleanup.stdout);
      else report.cleanup.serviceAbsent = true;
    }
    report.completedAt = new Date().toISOString();
    await mkdir(dirname(options.report), { recursive: true });
    await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ outcome: report.outcome, report: options.report, phases: report.phases.length, negativeScenarios: report.negativeScenarios.length })}\n`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
