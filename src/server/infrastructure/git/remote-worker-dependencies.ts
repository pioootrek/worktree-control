import { access, lstat, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
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
  await symlink(pnpm, join(toolDirectory, "pnpm"));
  environment.PATH = `${toolDirectory}:/usr/local/bin:/usr/bin:/bin`;
  environment.pnpm_config_node_version = policy.nodeVersion;
  environment.pnpm_config_ignore_pnpmfile = String(policy.scripts === "ignore");
  const common = { cwd: path, environment, maxOutputBytes: 4096 };
  if ((await context.command({ ...common, executable: node, args: ["--version"], errorCode: "worker_node_unavailable" })).trim() !== `v${policy.nodeVersion}`) throw new PreparationError("worker_node_mismatch");
  if ((await context.command({ ...common, executable: node, args: [pnpm, "--version"], errorCode: "worker_pnpm_unavailable" })).trim() !== policy.pnpmVersion) throw new PreparationError("worker_pnpm_mismatch");
  const args = [pnpm, "install", "--frozen-lockfile", "--no-runtime", "--prod=false", "--pm-on-fail=error",
    `--ignore-scripts=${policy.scripts === "ignore"}`, "--config.engine-strict=true",
    `--config.node-version=${policy.nodeVersion}`,
    ...(policy.scripts === "ignore" ? ["--ignore-pnpmfile"] : []),
    "--store-dir", join(environment.HOME, "pnpm-store"), "--cache-dir", join(environment.HOME, "pnpm-cache")];
  // Setup output is intentionally not published. Even trusted scripts can print credentials/URLs.
  await context.command({ ...common, executable: node, args, maxOutputBytes: 0, errorCode: "dependency_install_failed" });
  if (before !== await dependencyIdentity(path)) throw new PreparationError("dependency_metadata_changed");
  return { fingerprint: fingerprint({ policy, nodeHash, pnpmHash, metadata: before, installArgs: args.map(arg => arg.startsWith(environment.HOME) ? arg.replace(environment.HOME, "fresh-home") : arg) }), executable: node, args: [pnpm, "--pm-on-fail=error", "run"] };
}
