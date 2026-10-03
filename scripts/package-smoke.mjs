#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { productionInstallEnvironment, installProductionPrefix, installedSqlite, verifyInstalledDriver } from "./package-install.mjs";

const exec = promisify(execFile);
const STEP_TIMEOUT = 45_000;
const SENTINEL = "portable-smoke-secret-must-not-leak";
const startedAt = Date.now();
const steps = [];
let root;
let controller;
let client;
let forcedCleanup = false;
let failureMessage;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function check(value, message) {
  if (!value) throw new Error(message);
  return value;
}

async function step(name, task) {
  const start = Date.now();
  try {
    const result = await task();
    steps.push({ name, ok: true, durationMs: Date.now() - start });
    return result;
  } catch (error) {
    steps.push({ name, ok: false, durationMs: Date.now() - start, error: redact(error instanceof Error ? error.message : String(error)) });
    throw error;
  }
}

function redact(value) {
  return value
    .replaceAll(SENTINEL, "[REDACTED]")
    .replace(/wsi_[A-Za-z0-9_-]+/g, "wsi_[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/(https?:\/\/)[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/(_authToken\s*=\s*)\S+/gi, "$1[REDACTED]");
}

async function run(file, args, options = {}) {
  const env = options.env ?? process.env;
  try {
    return await exec(file, args, { cwd: options.cwd, env, encoding: "utf8", timeout: options.timeout ?? STEP_TIMEOUT, maxBuffer: 2_000_000 });
  } catch (error) {
    throw new Error(`${basename(file)} ${args[0] ?? ""} failed: ${redact(error.stderr || error.message)}`);
  }
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

async function waitFor(task, description, timeout = STEP_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { return await task(); } catch (error) { last = error; }
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error(`${description}: ${last instanceof Error ? last.message : "timed out"}`);
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? await filesUnder(path) : [path];
  }))).flat();
}

async function verifyReadmeLinks(packageRoot) {
  const readme = await readFile(join(packageRoot, "README.md"), "utf8");
  const links = [...readme.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
  for (const link of links) {
    if (/^(?:https?:|mailto:|#)/.test(link)) continue;
    const localPath = decodeURIComponent(link.split(/[?#]/, 1)[0]);
    const target = resolve(packageRoot, localPath);
    check(localPath && target.startsWith(`${packageRoot}${sep}`) && existsSync(target), `Packaged README has a broken or escaping local link: ${link}`);
  }
}

function resolvedDependencies(tree) {
  const resolved = [];
  const visit = (dependencies = {}, parents = []) => {
    for (const [name, value] of Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right))) {
      const version = value?.version ?? null;
      const segment = `${name}@${version ?? "unknown"}`;
      if (version) resolved.push({ path: [...parents, segment].join(" > "), name, version });
      visit(value?.dependencies, [...parents, segment]);
    }
  };
  visit(tree.dependencies);
  return resolved;
}

async function stopController() {
  if (!controller || controller.exitCode !== null) return;
  controller.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((accept) => controller.once("exit", (code, signal) => accept({ code, signal }))),
    new Promise((accept) => setTimeout(() => accept(null), 15_000)),
  ]);
  if (!exited) {
    forcedCleanup = true;
    controller.kill("SIGKILL");
    await new Promise((accept) => controller.once("exit", accept));
  }
  controller = undefined;
}

async function main() {
  root = await mkdtemp(join(tmpdir(), "worktree-switcher-package-smoke-"));
  const artifacts = join(root, "artifacts");
  const prefix = join(root, "user prefix");
  const fixture = join(root, "fixture");
  const data = join(root, "data");
  const state = join(root, "state");
  await Promise.all([mkdir(artifacts), mkdir(prefix), mkdir(fixture), mkdir(data, { mode: 0o700 }), mkdir(state, { mode: 0o700 })]);

  let tarball = argument("--tarball");
  if (!tarball) {
    check(existsSync(resolve("dist/cli/index.js")) && existsSync(resolve("out/index.html")), "Build artifacts are missing; run pnpm build first.");
    tarball = await step("pack", async () => {
      const result = await run("npm", ["pack", "--json", "--pack-destination", artifacts], { cwd: process.cwd() });
      const packed = JSON.parse(result.stdout);
      check(Array.isArray(packed) && packed.length === 1 && packed[0].filename, "npm pack did not return exactly one artifact.");
      return join(artifacts, packed[0].filename);
    });
  }
  tarball = resolve(tarball);
  check(existsSync(tarball), `Tarball does not exist: ${tarball}`);
  const checksum = await sha256(tarball);
  const expectedChecksum = argument("--sha256");
  check(!expectedChecksum || expectedChecksum === checksum, "Tarball checksum mismatch.");

  const archiveFiles = await step("archive-manifest", async () => {
    const { stdout } = await run("tar", ["-tzf", tarball]);
    const files = stdout.trim().split("\n");
    for (const required of [
      "package/dist/cli/index.js",
      "package/dist/cli/backup-verifier.js",
      "package/out/index.html",
      "package/skills/worktree-switcher/SKILL.md",
      "package/docs/authentication.md",
      "package/docs/package-trial.md",
      "package/docs/user-service.md",
      "package/LICENSE",
      "package/README.md",
      "package/THIRD_PARTY_NOTICES.md",
    ]) {
      check(files.includes(required), `Packed artifact is missing ${required}.`);
    }
    const forbidden = /(^|\/)(?:\.git|node_modules|\.env(?:\.[^/]*)?|\.npmrc|id_(?:rsa|ed25519)|state\.sqlite3(?:-(?:wal|shm))?|mcp-token|service-access\.json|controller\.lock)(?:\/|$)/;
    check(!files.some((file) => file.startsWith("/") || file.split("/").includes("..") || forbidden.test(file)), "Packed artifact contains forbidden or escaping paths.");
    return files;
  });

  await step("archive-content-audit", async () => {
    const extracted = join(artifacts, "extracted");
    await mkdir(extracted);
    await run("tar", ["-xzf", tarball, "-C", extracted]);
    const extractedPackage = join(extracted, "package");
    for (const path of await filesUnder(extractedPackage)) {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await realpath(path);
        check(target === extractedPackage || target.startsWith(`${extractedPackage}${sep}`), `Packed symlink escapes the package: ${relative(extractedPackage, path)}`);
      }
      if (!/\.(?:css|html|js|json|md|ya?ml)$/i.test(path)) continue;
      const text = await readFile(path, "utf8");
      check(!text.includes(SENTINEL) && !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:ghp|github_pat|npm)_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}/.test(text), `Packed text contains secret material: ${relative(extractedPackage, path)}`);
      if (/^(?:dist|out)(?:\/|$)/.test(relative(extractedPackage, path))) {
        check(!/(?:\/home\/runner\/work\/|\/home\/pioootrek\/|\/Users\/[^/]+\/)/.test(text), `Packed runtime contains a builder-specific path: ${relative(extractedPackage, path)}`);
      }
    }
    await verifyReadmeLinks(extractedPackage);
  });

  const installEnv = await productionInstallEnvironment(root);
  const packageRoot = await step("production-install", () => installProductionPrefix(tarball, prefix, root, installEnv, run));
  const cli = join(prefix, "bin", "worktree-switcher");
  check((await stat(cli)).isFile(), "Installed CLI is missing.");
  check((await realpath(cli)).startsWith(`${packageRoot}${sep}`), "Installed CLI does not resolve into the trial prefix.");
  check((await stat(join(packageRoot, "docs", "controller-https.md"))).isFile(), "Installed HTTPS guide is missing.");
  check((await stat(join(packageRoot, "skills", "worktree-switcher", "SKILL.md"))).isFile(), "Installed agent skill is missing.");
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  check(metadata.private === true && /^0\./.test(metadata.version), "Trial package lost its private pre-1.0 identity.");
  const runtimeEnv = { PATH: `${join(prefix, "bin")}:${process.env.PATH}`, LANG: "C.UTF-8" };
  const cliCommand = "worktree-switcher";
  let nativeAddon;
  let nativeProvisioning;
  await step("native-sqlite", async () => {
    const native = await installedSqlite(packageRoot);
    nativeAddon = native.binary; nativeProvisioning = native.provisioning;
  });

  await step("damaged-asset-rejected", async () => {
    const index = join(packageRoot, "out", "index.html");
    const damaged = `${index}.damaged`;
    const negativeData = join(root, "negative-data");
    const negativeState = join(root, "negative-state");
    await Promise.all([mkdir(negativeData, { mode: 0o700 }), mkdir(negativeState, { mode: 0o700 }), rename(index, damaged)]);
    // New installations refuse to start without an installation token.
    await run(cliCommand, ["auth", "token", "generate", "--data-dir", negativeData, "--state-dir", negativeState], { cwd: root, env: runtimeEnv });
    const port = await freePort();
    const mcp = await freePort();
    const child = spawn(cliCommand, ["start", "--service-mode", "--no-open", "--host", "127.0.0.1", "--port", String(port), "--mcp-port", String(mcp), "--data-dir", negativeData, "--state-dir", negativeState], {
      cwd: root, env: runtimeEnv, stdio: "ignore",
    });
    try {
      await waitFor(async () => {
        check(child.exitCode === null, "Damaged controller exited before its HTTP behavior could be checked.");
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
        check(response.status >= 400, "Damaged package served an index from outside the installed artifact.");
        return true;
      }, "Damaged asset scenario did not become observable");
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([new Promise((accept) => child.once("exit", accept)), new Promise((accept) => setTimeout(accept, 15_000))]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        forcedCleanup = true;
      }
      await rename(damaged, index);
    }
  });

  const fixturePort = await freePort();
  const dashboardPort = await freePort();
  const mcpPort = await freePort();
  const marker = `portable-${randomUUID()}`;
  await writeFile(join(fixture, "package.json"), JSON.stringify({ name: "portable-fixture", private: true, scripts: { dev: "node server.mjs" } }, null, 2));
  await writeFile(join(fixture, "server.mjs"), `import {createServer} from "node:http";\nconst marker=${JSON.stringify(marker)};\ncreateServer((_,r)=>{r.setHeader("content-type","application/json");r.end(JSON.stringify({marker,pid:process.pid}))}).listen(Number(process.env.PORT),"127.0.0.1");\n`);
  await run("git", ["init", "-q"], { cwd: fixture });
  await run("git", ["-c", "user.name=Portable Smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "add", "."], { cwd: fixture });
  await run("git", ["-c", "user.name=Portable Smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: fixture });
  const common = ["--data-dir", data, "--state-dir", state];
  await step("doctor", () => run(cliCommand, ["doctor", ...common], { cwd: root, env: runtimeEnv }));
  await step("offline-cli", async () => {
    await run(cliCommand, ["project", "add", fixture, "--name", "Portable fixture", "--port", String(fixturePort), "--preset", "node", ...common], { cwd: root, env: runtimeEnv });
    const listed = JSON.parse((await run(cliCommand, ["project", "list", "--json", ...common], { cwd: root, env: runtimeEnv })).stdout);
    check(listed.length === 1 && listed[0].repositoryPath === fixture && listed[0].port === fixturePort, "Offline CLI registration mismatch.");
  });
  const project = JSON.parse((await run(cliCommand, ["project", "list", "--json", ...common], { cwd: root, env: runtimeEnv })).stdout)[0];
  // New installations run in token mode; the installation token authorizes every transport.
  const token = await step("installation-token", async () => {
    const generated = JSON.parse((await run(cliCommand, ["auth", "token", "generate", ...common], { cwd: root, env: runtimeEnv })).stdout);
    check(typeof generated.token === "string" && generated.token.startsWith("wsi_"), "Installation token was not generated.");
    return generated.token;
  });

  let stdout = "";
  let stderr = "";
  const publicOrigin = "https://switcher.example.test";
  controller = spawn(cliCommand, ["start", "--service-mode", "--no-open", "--host", "127.0.0.1", "--port", String(dashboardPort), "--public-url", publicOrigin, "--mcp-port", String(mcpPort), "--browse-root", fixture, "--backup-dir", join(root, "backups"), "--backup-ui-actions", "create,restore", ...common], {
    cwd: root, env: runtimeEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  controller.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  controller.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const access = await step("controller-readiness", () => waitFor(async () => {
    check(controller.exitCode === null, `Controller exited early: ${redact(stderr)}`);
    const value = JSON.parse(await readFile(join(state, "service-access.json"), "utf8"));
    const response = await fetch(`http://127.0.0.1:${dashboardPort}/`, { signal: AbortSignal.timeout(1_000) });
    check(response.ok, `Dashboard returned ${response.status}.`);
    return value;
  }, "Controller did not become ready"));
  check(!stdout.includes("#token=") && !stdout.includes(token) && !stdout.includes(SENTINEL), "Controller output exposed a secret.");

  const accessUrl = new URL(access.accessUrl);
  check(access.version === metadata.version, "Controller access record version does not match the installed package.");
  await step("remote-backup-default-off", async () => {
    const status = JSON.parse((await run(cliCommand, ["backup", "remote", "status", ...common], { cwd: root, env: runtimeEnv })).stdout);
    check(status.enabled === false && status.pending === 0 && status.error === null && status.lastConfirmed === null && status.recovery === "not-measured", "Installed package unexpectedly enables remote backups.");
  });
  await step("backup-monitor-live", async () => {
    const disabled = JSON.parse((await run(cliCommand, ["backup", "monitor", ...common], { cwd: root, env: runtimeEnv })).stdout);
    check(disabled.severity === "disabled" && disabled.controller === "not-checked" && disabled.alerts.length === 0, "Monitor did not default off.");
    const live = JSON.parse((await run(cliCommand, ["backup", "monitor", "--enabled", ...common], { cwd: root, env: runtimeEnv })).stdout);
    check(live.controller === "available" && live.severity === "disabled" && live.metadata.scheduleEnabled === false && live.metadata.remote.enabled === false && live.alerts.length === 0, "Monitor did not respect disabled service scheduling.");
  });
  await step("backup-monitor-invalid-options", async () => {
    for (const options of [["--enabled", "--timeout-ms", SENTINEL], ["--backup-remote-enabled"]]) {
      let invalid;
      try { await exec(cliCommand, ["backup", "monitor", ...options, ...common], { cwd: root, env: runtimeEnv, encoding: "utf8", timeout: STEP_TIMEOUT, maxBuffer: 16 * 1024 }); }
      catch (error) { check(error.code === 3 && error.stderr === "", "Invalid monitor invocation returned a warning or raw error."); invalid = JSON.parse(error.stdout); }
      check(invalid?.severity === "unknown" && invalid.controller === "not-checked" && invalid.alerts[0] === "invalid_options" && invalid.metadata === null && !JSON.stringify(invalid).includes(SENTINEL), "Invalid monitor options leaked or failed to return safe JSON.");
    }
  });
  check(accessUrl.origin === publicOrigin, "Packaged controller did not advertise the configured public origin.");
  check(access.publicDashboardEndpoint === publicOrigin, "Packaged controller did not record its public endpoint.");
  check(access.localDashboardEndpoint === `http://127.0.0.1:${dashboardPort}`, "Packaged controller did not record its local CLI endpoint.");
  check(access.authenticationMode === "token" && accessUrl.hash === "", "Token-mode access record exposed a secret or the wrong mode.");
  await step("packaged-assets", async () => {
    const htmlResponse = await fetch(`http://127.0.0.1:${dashboardPort}/`);
    const html = await htmlResponse.text();
    check(htmlResponse.ok && html.length > 100, "Packaged index was not served.");
    const paths = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]);
    check(paths.length > 0, "No packaged JS/CSS assets found in index.");
    for (const path of paths) {
      const response = await fetch(new URL(path, `http://127.0.0.1:${dashboardPort}/`));
      const body = await response.text();
      check(response.ok && body.length > 0 && !response.headers.get("content-type")?.includes("text/html"), `Invalid packaged asset: ${path}`);
    }
    const denied = await fetch(`http://127.0.0.1:${dashboardPort}/api/dashboard`);
    check(denied.status === 401, "Dashboard API accepted a missing token.");
    const allowed = await fetch(`http://127.0.0.1:${dashboardPort}/api/dashboard`, { headers: { "X-Worktree-Switcher-Token": token } });
    check(allowed.ok && (await allowed.json()).projects.length === 1, "Authenticated dashboard API failed.");
  });

  await step("live-cli-forwarding", async () => {
    const listed = JSON.parse((await run(cliCommand, ["project", "list", "--json", ...common], { cwd: root, env: { ...runtimeEnv, WORKTREE_SWITCHER_TOKEN: token } })).stdout);
    check(listed[0].id === project.id, "Live CLI did not forward to the singleton controller.");
  });

  await step("installation-backup-verifier", async () => {
    const accepted = JSON.parse((await run(cliCommand, ["backup", "now", "--idempotency-key", "package-copy", ...common], { cwd: root, env: runtimeEnv })).stdout);
    const terminal = await waitFor(async () => {
      const status = JSON.parse((await run(cliCommand, ["backup", "status", "--idempotency-key", "package-copy", ...common], { cwd: root, env: runtimeEnv })).stdout);
      if (status.state === "queued" || status.state === "running") throw new Error("Backup is still executing.");
      return status;
    }, "Installed backup did not reach a terminal state");
    check(terminal.state === "succeeded" && terminal.operationId === accepted.operationId, "Installed backup failed.");
    const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/backups`, { method: "POST", headers: { "Content-Type": "application/json", Origin: publicOrigin, "X-Worktree-Switcher-Token": token }, body: JSON.stringify({ action: "preview", backupId: accepted.backupId }), signal: AbortSignal.timeout(STEP_TIMEOUT) });
    const preview = await response.json();
    check(response.ok && preview.scope === "entire-installation" && preview.backup?.verification === "verified", "Installed verifier could not validate its backup clone.");
  });

  const unauthorized = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check(unauthorized.status === 401, "MCP accepted an unauthorized request.");
  const { Client } = await import(pathToFileURL(join(packageRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "index.js")));
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(join(packageRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "streamableHttp.js")));
  client = new Client({ name: "portable-package-smoke", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  check(client.getServerVersion()?.version === metadata.version, "MCP server version does not match the installed package.");
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    check(!result.isError, `${name} returned an MCP error.`);
    return JSON.parse(result.content.find((part) => part.type === "text").text);
  };
  await step("mcp-runtime", async () => {
    const tools = (await client.listTools()).tools.map(({ name }) => name);
    for (const name of ["list_projects", "list_worktrees", "claim_project", "start_project", "restart_project", "stop_project", "release_project_claim"]) check(tools.includes(name), `MCP tool missing: ${name}`);
    const projects = await call("list_projects");
    check(projects[0].id === project.id, "MCP project identity mismatch.");
    const worktrees = await call("list_worktrees", { projectId: project.id });
    const worktreePath = check(worktrees.find((item) => item.path === fixture)?.path, "Fixture worktree was not discovered.");
    const claim = await call("claim_project", { projectId: project.id, worktreePath, reason: "Portable package verification", idempotencyKey: "claim-1", responseMode: "compact" });
    const reservationId = claim.reservationId;
    const health = async () => {
      const response = await fetch(`http://127.0.0.1:${fixturePort}/`, { signal: AbortSignal.timeout(1_000) });
      const value = await response.json();
      check(value.marker === marker, "Wrong fixture health identity.");
      return value;
    };
    const first = await waitFor(health, "Fixture did not start");
    await call("stop_project", { projectId: project.id, reservationId, idempotencyKey: "stop-1" });
    await waitFor(async () => { try { await health(); } catch { return true; } throw new Error("fixture still running"); }, "Fixture did not stop");
    await call("start_project", { projectId: project.id, reservationId, idempotencyKey: "start-1" });
    const second = await waitFor(health, "Fixture did not restart after start");
    await call("start_project", { projectId: project.id, reservationId, idempotencyKey: "start-noop" });
    await call("restart_project", { projectId: project.id, reservationId, idempotencyKey: "restart-1" });
    const replay = await call("restart_project", { projectId: project.id, reservationId, idempotencyKey: "restart-1" });
    const third = await waitFor(async () => { const value = await health(); check(value.pid !== second.pid, "Restart retained the old PID."); return value; }, "Fixture restart did not replace process");
    check(replay.replayed === true && first.pid !== second.pid && third.pid !== second.pid, "Runtime idempotency/PID assertions failed.");
    await call("stop_project", { projectId: project.id, reservationId, idempotencyKey: "stop-2" });
    await call("release_project_claim", { projectId: project.id, reservationId });
    const status = await call("get_project_status_compact", { projectId: project.id });
    check(status.status.reservation === null, "Claim remained after release.");
  });

  await client.close();
  client = undefined;
  await stopController();
  await step("backup-monitor-controller-absent", async () => {
    let stopped;
    // The normal run helper deliberately redacts and discards failure payloads.
    // This expected nonzero probe needs its structured stdout and exact exit code.
    try { await exec(cliCommand, ["backup", "monitor", "--enabled", ...common], { cwd: root, env: runtimeEnv, encoding: "utf8", timeout: STEP_TIMEOUT, maxBuffer: 16 * 1024 }); }
    catch (error) { check(error.code === 3, "Stopped monitor returned the wrong exit code."); stopped = JSON.parse(error.stdout); }
    check(stopped?.severity === "unknown" && stopped.controller === "unavailable" && stopped.alerts[0] === "controller_unavailable", "Monitor certified an absent controller.");
  });
  check(!existsSync(join(state, "service-access.json")), "Service access record survived graceful shutdown.");
  check(!existsSync(join(state, "controller.lock")), "Controller lock survived graceful shutdown.");
  check(!forcedCleanup, "Forced cleanup was required.");
  await step("project-removal", async () => {
    await run(cliCommand, ["project", "remove", project.id, ...common], { cwd: root, env: runtimeEnv });
    const listed = JSON.parse((await run(cliCommand, ["project", "list", "--json", ...common], { cwd: root, env: runtimeEnv })).stdout);
    check(listed.length === 0, "Installed CLI did not remove the fixture project.");
  });

  const oldArtifact = argument("--verification-old-artifact"), oldProvenance = argument("--verification-old-provenance");
  check((!oldArtifact && !oldProvenance) || (oldArtifact && oldProvenance && argument("--verification-script")), "Historical inputs require an explicit driver and both artifact/provenance arguments.");
  const additionalVerification = argument("--verification-script") ? await step("explicit-installed-verification", () => verifyInstalledDriver(argument("--verification-script"), packageRoot, oldArtifact ? [resolve(oldArtifact), resolve(oldProvenance)] : [], root)) : null;

  const dependencyTree = JSON.parse((await run("npm", ["ls", "--global", "--prefix", prefix, "--omit=dev", "--json", "--all"], { cwd: root, env: installEnv })).stdout);
  const dependencies = resolvedDependencies(dependencyTree);
  const report = {
    ok: true, package: `${metadata.name}@${metadata.version}`, tarball: basename(tarball), sha256: checksum,
    bytes: (await stat(tarball)).size, archiveEntries: archiveFiles.length, node: process.version,
    npm: (await run("npm", ["--version"])).stdout.trim(), platform: `${process.platform}-${process.arch}`,
    install: { mode: "global-prefix", prefixContainsSpaces: prefix.includes(" ") },
    nativeSqlite: { load: "success", binary: nativeAddon, provisioning: nativeProvisioning },
    dependencies, additionalVerification,
    steps, cleanup: "graceful", durationMs: Date.now() - startedAt,
  };
  const reportPath = argument("--report");
  if (reportPath) await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
  const summary = {
    ...report,
    dependencies: {
      copies: dependencies.length,
      uniquePackageVersions: new Set(dependencies.map(({ name, version }) => `${name}@${version}`)).size,
      report: reportPath ? resolve(reportPath) : null,
    },
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  failureMessage = redact(error instanceof Error ? error.message : String(error));
  process.stderr.write(`Portable package smoke failed: ${failureMessage}\n`);
  process.exitCode = 1;
} finally {
  try { await client?.close(); } catch {}
  try { await stopController(); } catch { forcedCleanup = true; }
  if (root) await rm(root, { recursive: true, force: true });
  const reportPath = argument("--report");
  if (failureMessage && reportPath) {
    try {
      await writeFile(resolve(reportPath), `${JSON.stringify({
        ok: false,
        error: failureMessage,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        steps,
        cleanup: forcedCleanup ? "forced" : "graceful",
        durationMs: Date.now() - startedAt,
      }, null, 2)}\n`);
    } catch (reportError) {
      process.stderr.write(`Could not write failure report: ${redact(reportError instanceof Error ? reportError.message : String(reportError))}\n`);
    }
  }
  if (forcedCleanup) process.exitCode = 1;
}
