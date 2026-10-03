import { spawn } from "node:child_process";
import { writeFile, realpath, lstat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Shared production-prefix provisioning; callers own finite commands and cleanup. */
export async function productionInstallEnvironment(root, environment = process.env) {
  const forwarded = Object.fromEntries([
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "NODE_EXTRA_CA_CERTS", "npm_config_registry",
  ].flatMap(name => environment[name] ? [[name, environment[name]]] : []));
  const env = { PATH: environment.PATH, LANG: "C.UTF-8", ...forwarded,
    npm_config_cache: join(root, "npm-cache"), npm_config_userconfig: join(root, "empty-npmrc"), npm_config_globalconfig: join(root, "empty-global-npmrc") };
  await Promise.all([writeFile(env.npm_config_userconfig, ""), writeFile(env.npm_config_globalconfig, "")]);
  return env;
}
export async function installProductionPrefix(tarball, prefix, root, env, run) {
  await run("npm", ["install", "--global", "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund", tarball], { cwd: root, env, timeout: 300_000 });
  return join(prefix, "lib", "node_modules", "worktree-switcher");
}
export async function installedSqlite(packageRoot) {
  const sqliteRoot = join(packageRoot, "node_modules", "better-sqlite3");
  const sqlite = await import(pathToFileURL(join(sqliteRoot, "lib", "index.js")));
  const database = new sqlite.default(":memory:"); database.exec("select 1"); database.close();
  const binding = await import(pathToFileURL(join(sqliteRoot, "lib", "binding.js")));
  const prebuilt = binding.default.getPrebuildPath(), addon = prebuilt ?? join(sqliteRoot, "build", "Release", "better_sqlite3.node");
  return { Database: sqlite.default, binary: relative(packageRoot, await realpath(addon)), provisioning: prebuilt ? "packaged prebuilt" : "npm lifecycle source build" };
}

function check(value, message) { if (!value) throw new Error(message); }

// Trusted local operator argument only; never discover a driver from an artifact
// or remote metadata. A separate owned process group bounds all fixture children.
export async function verifyInstalledDriver(script, packageRoot, input = [], root) {
  if (!script) return null;
  check(process.platform !== "win32", "Explicit installed verification requires POSIX process groups.");
  const path = resolve(script);
  check((await lstat(path)).isFile(), "Verification script must be a local regular file.");
  const environment = { PATH: process.env.PATH, LANG: "C.UTF-8", TMPDIR: root, ...Object.fromEntries(["WORKTREE_SWITCHER_TEST_RESTIC", "WORKTREE_SWITCHER_TEST_REST_SERVER"].flatMap(name => process.env[name] ? [[name, process.env[name]]] : [])) };
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [path, packageRoot, ...input], { cwd: process.cwd(), env: environment, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "", forcedReason = null;
    const stop = signal => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch (error) { if (error.code !== "ESRCH") throw error; } };
    const timeout = setTimeout(() => { forcedReason = "deadline"; stop("SIGTERM"); }, 300_000);
    const force = setTimeout(() => { forcedReason = "deadline-kill"; stop("SIGKILL"); }, 305_000);
    let interruptedForce;
    const interrupt = () => { forcedReason = "interrupted"; stop("SIGTERM"); interruptedForce ??= setTimeout(() => stop("SIGKILL"), 5_000); };
    process.on("SIGTERM", interrupt); process.on("SIGINT", interrupt);
    child.stdout.on("data", value => { output += value.toString(); if (output.length > 1024 * 1024) { forcedReason = "stdout-limit"; stop("SIGKILL"); } });
    child.stderr.on("data", value => { errors += value.toString(); if (errors.length > 64 * 1024) { forcedReason = "stderr-limit"; stop("SIGKILL"); } });
    child.once("error", () => { forcedReason = "spawn-error"; });
    child.once("close", (code, signal) => {
      clearTimeout(timeout); clearTimeout(force);
      clearTimeout(interruptedForce); process.off("SIGTERM", interrupt); process.off("SIGINT", interrupt);
      // A driver is responsible for graceful cleanup; reject any surviving group.
      if (process.platform !== "win32" && child.pid) { try { process.kill(-child.pid, 0); forcedReason = "surviving-group"; stop("SIGKILL"); } catch (error) { if (error.code !== "ESRCH") forcedReason = "group-probe-error"; } }
      let report, outputKind = "invalid-json";
      try { report = JSON.parse(output.trim()); outputKind = report.errorCode === "fixture_failed" ? "fixture-error" : report.evidence ? "success-evidence" : "other-json"; } catch { /* Raw child output is private. */ }
      const label = value => typeof value === "string" && /^[a-z0-9-]{1,100}$/.test(value) ? value : null;
      if (forcedReason || code !== 0 || signal || outputKind !== "success-evidence") {
        const diagnostic = { exitCode: code, signal, outputKind, forcedReason, failureStep: label(report?.failureStep), lastCompletedStep: label(report?.steps?.at(-1)?.name), cleanup: report?.cleanup?.ok === true ? "clean" : report?.cleanup?.ok === false ? "failed" : "unknown", cleanupFailures: ["controllers", "remote", "files"].filter(key => report?.cleanup?.[key] === "failed") };
        reject(new Error(`Explicit installed verification failed: ${JSON.stringify(diagnostic)}`));
      } else accept({ driver: "explicit-local-repository-script", runtime: "installed-artifact", evidence: report });
    });
  });
}
