import { access, lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { remoteDependencySetupSchema, fingerprint, type RemoteDependencySetupPolicy } from "@/server/modules/remote-verification";
import { PreparationError, type VerificationPreparationContext } from "@/server/modules/verification";

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
async function toolDigest(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

export async function dependencyIdentity(path: string): Promise<string> {
  const files: Record<string, string | null> = {};
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".pnpmfile.cjs", "pnpmfile.cjs"]) {
    try {
      const metadata = await lstat(join(path, name));
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 * 1024) throw new PreparationError("dependency_metadata_invalid");
      files[name] = digest(await readFile(join(path, name)));
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") files[name] = null; else throw new PreparationError("dependency_metadata_invalid"); }
  }
  return fingerprint(files);
}

/** No toolchain installation or environment inheritance. Repository code is explicitly trusted, not sandboxed. */
export async function preparePnpmDependencies(input: {
  path: string; policy: RemoteDependencySetupPolicy; context: VerificationPreparationContext;
  environment: Record<string, string>; toolDirectory: string;
}): Promise<{ fingerprint: string; executable: string; args: string[] }> {
  const { path, context, environment, toolDirectory } = input;
  const parsed = remoteDependencySetupSchema.safeParse(input.policy);
  if (!parsed.success) throw new PreparationError("dependency_policy_invalid");
  const policy = parsed.data;
  if (process.platform !== "linux") throw new PreparationError("worker_platform_unsupported");
  let manifest: { packageManager?: string; devEngines?: { runtime?: unknown }; engines?: { runtime?: unknown } };
  let lock: string;
  try {
    for (const name of ["package.json", "pnpm-lock.yaml"]) {
      const metadata = await lstat(join(path, name));
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 * 1024) throw new Error();
    }
    manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    lock = await readFile(join(path, "pnpm-lock.yaml"), "utf8");
  } catch { throw new PreparationError("dependency_lockfile_required"); }
  if (typeof manifest?.packageManager !== "string" || manifest.packageManager.split("+", 1)[0] !== `pnpm@${policy.pnpmVersion}`) throw new PreparationError("package_manager_mismatch");
  if (manifest.devEngines?.runtime || manifest.engines?.runtime) throw new PreparationError("repository_runtime_install_forbidden");
  if (!/^lockfileVersion:\s*['"]?9\.0['"]?\s*$/m.test(lock)) throw new PreparationError("lockfile_version_unsupported");
  const before = await dependencyIdentity(path);
  // Inline credentials are not an acceptable secret source for this worker contract.
  try {
    const npmrc = await readFile(join(path, ".npmrc"), "utf8");
    if (/^\s*[^#;\r\n]*(?:_auth|password|token)\s*=/im.test(npmrc)) throw new PreparationError("repository_credentials_forbidden");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { await lstat(join(path, "node_modules")); throw new PreparationError("fresh_dependencies_required"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let node: string, pnpm: string, nodeHash: string, pnpmHash: string;
  try {
    node = await realpath(policy.nodeExecutable); pnpm = await realpath(policy.pnpmEntryPoint);
    for (const file of [node, pnpm]) {
      if (!(await lstat(file)).isFile()) throw new Error();
      await access(file, constants.X_OK);
    }
    nodeHash = await toolDigest(node, context.signal); pnpmHash = await toolDigest(pnpm, context.signal);
  } catch { throw new PreparationError("worker_toolchain_unavailable"); }
  await mkdir(toolDirectory, { mode: 0o700 });
  await symlink(node, join(toolDirectory, "node"));
  environment.PATH = `${toolDirectory}:/usr/local/bin:/usr/bin:/bin`;
  const settings: Record<string, string> = {
    store_dir: join(environment.HOME, "pnpm-store"), cache_dir: join(environment.HOME, "pnpm-cache"),
    node_version: policy.nodeVersion, engine_strict: "true", pm_on_fail: "error", runtime_on_fail: "error",
    ignore_scripts: String(policy.scripts === "ignore"), ignore_pnpmfile: String(policy.scripts === "ignore"),
    verify_deps_before_run: "false",
    ...(policy.scripts === "ignore" ? { enable_pre_post_scripts: "false" } : {}),
  };
  for (const [key, value] of Object.entries(settings)) environment[`pnpm_config_${key}`] = value;
  const policyArgs = Object.entries(settings).map(([key, value]) => `--config.${key.replaceAll("_", "-")}=${value}`);
  const launcherArgs = [...policyArgs, "--config.config-dependencies=null", "--pm-on-fail=error"];
  // pnpm 11 defaults verifyDepsBeforeRun to "install". Its spawned install does
  // not retain install-only CLI options. Environment alone is also insufficient:
  // repository YAML can override it. Keep CLI policy on ordinary nested pnpm
  // calls and npm_execpath calls without spawning a second process/owned tree.
  const launcher = join(toolDirectory, "pnpm.cjs");
  const launcherSource = `#!/usr/bin/env node\nif (process.argv.length === 3 && ["--version", "-v", "--help", "-h"].includes(process.argv[2])) process.chdir(__dirname);\nprocess.argv.splice(2, 0, ...${JSON.stringify(launcherArgs)});\nimport(${JSON.stringify(pathToFileURL(pnpm).href)}).catch(error => { console.error(error); process.exitCode = 1; });\n`;
  await writeFile(launcher, launcherSource, { mode: 0o700, flag: "wx" });
  await symlink(launcher, join(toolDirectory, "pnpm"));
  const common = { cwd: path, environment, maxOutputBytes: 4096 };
  if ((await context.command({ ...common, executable: node, args: ["--version"], errorCode: "worker_node_unavailable" })).trim() !== `v${policy.nodeVersion}`) throw new PreparationError("worker_node_mismatch");
  // pnpm's --version parser drops non-global CLI options. Probe outside the
  // repository so version discovery cannot load its hooks or configuration.
  if ((await context.command({ ...common, cwd: toolDirectory, executable: node, args: [pnpm, "--version"], errorCode: "worker_pnpm_unavailable" })).trim() !== policy.pnpmVersion) throw new PreparationError("worker_pnpm_mismatch");
  // pnpm bootstraps configDependencies before command dispatch, independently of
  // verifyDepsBeforeRun. Refuse that unsupported plugin contract, using pnpm's
  // own config parser without repository hooks, network or lockfile writes.
  // The launcher also disables bootstrap for nested calls in other directories.
  const configDeps = (await context.command({ ...common, executable: node,
    args: [pnpm, ...policyArgs.map(arg => arg.startsWith("--config.ignore-pnpmfile=") ? "--config.ignore-pnpmfile=true" : arg),
      "--config.offline=true", "--config.frozen-lockfile=true", "config", "get", "configDependencies", "--json"],
    errorCode: "dependency_config_plugins_unsupported" })).trim();
  if (configDeps) {
    let value: unknown;
    try { value = JSON.parse(configDeps); } catch { throw new PreparationError("dependency_config_plugins_unsupported"); }
    if (value !== null && (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length)) throw new PreparationError("dependency_config_plugins_unsupported");
  }
  const args = [launcher, "install", "--frozen-lockfile", "--no-runtime", "--prod=false", "--pm-on-fail=error"];
  // Setup output is intentionally not published. Even trusted scripts can print credentials/URLs.
  await context.command({ ...common, executable: node, args, maxOutputBytes: 0, errorCode: "dependency_install_failed" });
  if (before !== await dependencyIdentity(path)) throw new PreparationError("dependency_metadata_changed");
  const normalize = (value: string) => value.replaceAll(environment.HOME, "fresh-home");
  return { fingerprint: fingerprint({ policy, nodeHash, pnpmHash, metadata: before, launcher: normalize(launcherSource),
    installArgs: args.map(normalize), executionArgs: ["run"] }), executable: node, args: [launcher, "run"] };
}
