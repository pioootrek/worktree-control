import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitCommandAdmission, SystemGitWorktreeReader, type GitCommandPriority } from "@/server/git-worktrees";
import { LinuxWorkerRecoveryHost, SystemRemoteVerificationWorkspacePreparer, SystemRemoteWorkerExecution } from "@/server/infrastructure/git";
import { ProjectLifecycle } from "@/server/modules/lifecycle";
import { OwnedProcessGroup } from "@/server/owned-process-group";
import { SqliteStateStore } from "@/server/sqlite-store";
import { TestJobManager } from "@/server/test-job-manager";
import { nullLogWriter } from "@/server/log-writer";
import { ProjectTestCommandResolver } from "@/server/test-command";
import type { RemoteAssignment, RemoteWorkerReport } from "@/shared/contracts/remote-verification";
import { WorkerRecoveryService, RemoteVerificationWorker, hasUnconfirmedRemoteExecution, type RemoteDependencySetupPolicy } from "./index";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
class FixtureGitAdmission extends GitCommandAdmission {
  remoteRequests = 0;
  override run<T>(priority: GitCommandPriority, operation: (signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    if (priority === "remote") this.remoteRequests++;
    return super.run(priority, operation, options);
  }
}

function pnpmDistribution(directory: string, expectedEntry?: string): { path: string; version: string } | undefined {
  try {
    const root = realpathSync(directory);
    const manifest: { name?: unknown; version?: unknown; bin?: { pnpm?: unknown } | null } | null =
      JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const entry = manifest?.bin?.pnpm;
    if (manifest?.name !== "pnpm" || typeof manifest.version !== "string" || !/^11\.[1-9][0-9]*\.\d+$/.test(manifest.version)
      || typeof entry !== "string" || !["bin/pnpm.cjs", "bin/pnpm.mjs"].includes(entry)) return;
    const path = realpathSync(join(root, entry));
    if (path !== join(root, entry) || (expectedEntry && path !== expectedEntry) || !statSync(path).isFile()) return;
    accessSync(path, constants.X_OK);
    return { path, version: manifest.version };
  } catch { /* Missing or unsupported distributions are not executable candidates. */ }
}

/** Resolve the installed pnpm distribution, never Corepack or a command which could download tooling. */
function installedPnpm(searchPath = process.env.PATH ?? ""): { path: string; version: string } {
  for (const bin of searchPath.split(delimiter)) {
    let candidate: string;
    try { candidate = realpathSync(join(bin, "pnpm")); } catch { continue; }
    const directory = dirname(candidate);
    const direct = pnpmDistribution(join(directory, ".."), candidate);
    if (direct) return direct;
    // pnpm/action-setup v4.1.0 installs a local dependency, exposing a regular
    // node_modules/.bin/pnpm wrapper. Resolve only its adjacent pnpm package;
    // never parse/execute the wrapper or search for tooling outside this layout.
    // https://github.com/pnpm/action-setup/blob/a7487c7e89a18df4991f7f222e4898a00d66ddda/src/install-pnpm/run.ts
    if (basename(directory) === ".bin" && basename(dirname(directory)) === "node_modules") {
      const adjacent = pnpmDistribution(join(directory, "..", "pnpm"));
      if (adjacent) return adjacent;
    }
  }
  throw new Error("Fixture requires the preinstalled pnpm 11 distribution (not a Corepack shim) in PATH.");
}

describe("preinstalled pnpm discovery", () => {
  function layout() {
    const root = mkdtempSync(join(tmpdir(), "wtc-pnpm-discovery-"));
    cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
    const distribution = join(root, "node_modules", ".pnpm", "pnpm@11.22.0", "node_modules", "pnpm");
    const bin = join(root, "node_modules", ".bin");
    mkdirSync(join(distribution, "bin"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    symlinkSync(distribution, join(root, "node_modules", "pnpm"));
    const manifestPath = join(distribution, "package.json");
    const manifest = { name: "pnpm", version: "11.22.0", bin: { pnpm: "bin/pnpm.mjs" } };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const entry = join(distribution, manifest.bin.pnpm);
    writeFileSync(entry, "#!/usr/bin/env node\nthrow new Error('Discovery must not execute fixture tooling');\n", { mode: 0o755 });
    // The action installs pnpm as a dependency and cmd-shim writes a regular
    // .bin/pnpm shell wrapper targeting ../pnpm/bin/pnpm.mjs, not a symlink.
    const marker = join(root, "wrapper-executed");
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh\ntouch '${marker}'\nexec node "$(dirname "$0")/../pnpm/bin/pnpm.mjs" "$@"\n`, { mode: 0o755 });
    return { root, distribution, bin, manifestPath, manifest, entry, marker };
  }

  it.each(["pnpm.cjs", "pnpm.mjs"])("resolves a PATH symlink to the declared %s distribution entrypoint", name => {
    const f = layout();
    const entry = join(f.distribution, "bin", name);
    f.manifest.bin.pnpm = `bin/${name}`;
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
    if (entry !== f.entry) writeFileSync(entry, readFileSync(f.entry), { mode: 0o755 });
    const bin = join(f.root, "global-bin");
    mkdirSync(bin); symlinkSync(entry, join(bin, "pnpm"));
    expect(installedPnpm(bin)).toEqual({ path: entry, version: "11.22.0" });
  });

  it("resolves the action's adjacent package through its virtual-store symlink without running the wrapper", () => {
    const f = layout();
    expect(realpathSync(join(f.bin, "pnpm"))).toBe(join(f.bin, "pnpm"));
    expect(existsSync(join(f.bin, "..", "package.json"))).toBe(false);
    expect(installedPnpm(f.bin)).toEqual({ path: f.entry, version: "11.22.0" });
    expect(existsSync(f.marker)).toBe(false);
  });

  it.each([
    { name: "corepack" }, { version: "10.22.0" }, { version: "11.0.0" }, { version: "12.0.0" },
    { version: "11.22.0-rc.1" }, { version: 11 }, { bin: null }, { bin: "bin/pnpm.mjs" },
    { bin: { pnpm: "../download.mjs" } }, { bin: { pnpm: "/tools/pnpm.mjs" } }, { bin: { pnpm: "bin/corepack.cjs" } },
  ])("rejects an unsupported adjacent manifest %j", override => {
    const f = layout();
    writeFileSync(f.manifestPath, JSON.stringify({ ...f.manifest, ...override }));
    expect(() => installedPnpm(f.bin)).toThrow("preinstalled pnpm 11 distribution");
    expect(existsSync(f.marker)).toBe(false);
  });

  it.each(["malformed-manifest", "null-manifest", "missing-package", "missing-entry", "directory-entry", "non-executable-entry", "redirected-entry"])("rejects %s without invoking the wrapper", kind => {
    const f = layout();
    if (kind === "malformed-manifest") writeFileSync(f.manifestPath, "{");
    if (kind === "null-manifest") writeFileSync(f.manifestPath, "null");
    if (kind === "missing-package") rmSync(f.distribution, { recursive: true });
    if (kind === "missing-entry") rmSync(f.entry);
    if (kind === "directory-entry") { rmSync(f.entry); mkdirSync(f.entry); }
    if (kind === "non-executable-entry") chmodSync(f.entry, 0o644);
    if (kind === "redirected-entry") {
      const outside = join(f.root, "download.mjs");
      writeFileSync(outside, readFileSync(f.entry), { mode: 0o755 });
      rmSync(f.entry); symlinkSync(outside, f.entry);
    }
    expect(() => installedPnpm(f.bin)).toThrow("preinstalled pnpm 11 distribution");
    expect(existsSync(f.marker)).toBe(false);
  });

  it("rejects a PATH target that is not the manifest's declared entrypoint", () => {
    const f = layout();
    const shim = join(f.distribution, "bin", "corepack.cjs");
    writeFileSync(shim, readFileSync(f.entry), { mode: 0o755 });
    rmSync(join(f.bin, "pnpm")); symlinkSync(shim, join(f.bin, "pnpm"));
    expect(() => installedPnpm(f.bin)).toThrow("preinstalled pnpm 11 distribution");
  });

  it("does not search for a distribution beside arbitrary PATH wrappers", () => {
    const f = layout();
    const bin = join(f.root, "node_modules", "other-bin");
    mkdirSync(bin); writeFileSync(join(bin, "pnpm"), readFileSync(join(f.bin, "pnpm")), { mode: 0o755 });
    expect(() => installedPnpm(bin)).toThrow("preinstalled pnpm 11 distribution");
    expect(existsSync(f.marker)).toBe(false);
  });

  it("continues past missing PATH entries and Corepack to a real installed distribution", () => {
    const f = layout();
    const corepack = join(f.root, "corepack");
    mkdirSync(join(corepack, "bin"), { recursive: true });
    writeFileSync(join(corepack, "package.json"), JSON.stringify({ ...f.manifest, name: "corepack" }));
    writeFileSync(join(corepack, "bin", "pnpm"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    expect(installedPnpm([join(f.root, "missing"), join(corepack, "bin"), f.bin].join(delimiter)))
      .toEqual({ path: f.entry, version: "11.22.0" });
  });
});

function fixture(realPnpm = false) {
  const root = mkdtempSync(join(tmpdir(), "wtc-locked-preparation-"));
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  const seed = join(root, "seed"), remote = join(root, "remote.git"), human = join(root, "human"), cache = join(root, "cache"), workspaces = join(root, "attempts");
  const pnpm = realPnpm ? installedPnpm() : { path: join(root, "pnpm.cjs"), version: "11.22.0" };
  if (!realPnpm) {
    writeFileSync(pnpm.path, `#!${process.execPath}
      const fs=require('node:fs'), cp=require('node:child_process'), path=require('node:path');
      const args=process.argv.slice(2);
      if(args.includes('--version')){console.log('${pnpm.version}');process.exit(0)}
      if(args.includes('config')&&args.includes('get')&&args.includes('configDependencies'))process.exit(0);
      if(args.includes('install')){
        if(!args.includes('--frozen-lockfile')||!args.includes('--pm-on-fail=error')||!args.includes('--no-runtime'))process.exit(89);
        require(path.resolve('setup.cjs'));
      } else if(args.includes('run')) require(path.resolve('check.cjs'));
      else process.exit(88);
    `);
    chmodSync(pnpm.path, 0o755);
  }
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  git(seed, "config", "user.email", "fixture@example.invalid"); git(seed, "config", "user.name", "Fixture");
  writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "remote-preparation-fixture", version: "1.0.0", packageManager: `pnpm@${pnpm.version}`,
    engines: { node: `>=${process.versions.node.split(".")[0]}` }, scripts: { test: "node check.cjs", postinstall: "node postinstall.cjs" }, dependencies: { "fixture-dep": "file:./fixture-dep" } }));
  writeFileSync(join(seed, ".gitignore"), "node_modules/\ninstalled.txt\n");
  writeFileSync(join(seed, "setup.cjs"), "require('node:fs').writeFileSync('installed.txt','fixture-install');");
  writeFileSync(join(seed, "postinstall.cjs"), "require('node:fs').writeFileSync('installed.txt','real-pnpm-postinstall');");
  mkdirSync(join(seed, "fixture-dep"));
  writeFileSync(join(seed, "fixture-dep", "package.json"), JSON.stringify({ name: "fixture-dep", version: "1.0.0", main: "index.js" }));
  writeFileSync(join(seed, "fixture-dep", "index.js"), "module.exports='installed-from-committed-source';");
  writeFileSync(join(seed, "pnpm-lock.yaml"), `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .:
    dependencies:
      fixture-dep:
        specifier: file:./fixture-dep
        version: file:fixture-dep
packages:
  fixture-dep@file:fixture-dep:
    resolution: {directory: fixture-dep, type: directory}
snapshots:
  fixture-dep@file:fixture-dep: {}
`);
  const commit = (script = "console.log('EXECUTED');", message = "fixture revision") => {
    writeFileSync(join(seed, "check.cjs"), script); git(seed, "add", "."); git(seed, "commit", "-qm", message);
    git(seed, "push", "-q", "origin", "main"); return git(seed, "rev-parse", "HEAD");
  };
  git(seed, "add", "."); git(seed, "commit", "-qm", "locked source"); git(seed, "remote", "add", "origin", remote); git(seed, "push", "-q", "-u", "origin", "main");
  execFileSync("git", ["clone", "-q", remote, human]); execFileSync("git", ["clone", "-q", "--no-checkout", remote, cache]);
  writeFileSync(join(human, "local.txt"), "preserve");
  mkdirSync(workspaces); writeFileSync(join(workspaces, "unrelated.txt"), "preserve");
  const store = new SqliteStateStore(join(root, "worker.sqlite3"));
  cleanup.push(async () => store.close());
  const local = store.addProject({ name: "Fixture", repositoryPath: human, port: 3199, executable: "", args: [], launchPreset: "none" });
  store.saveRemotePrincipal({ id: "principal", kind: "worker", status: "active" }, "fixture");
  store.saveRemoteWorker({ id: "worker", name: "Fixture", principalId: "principal", status: "active", lastContactAt: null }, "fixture");
  store.saveRemoteProjectIdentity({ id: "project", name: "Fixture", sourceRemote: "origin", status: "active" }, "fixture");
  store.saveRemoteWorkerProjectGrant({ workerId: "worker", projectId: "project", localProjectId: local.id, presetIds: ["node:test"], revokedAt: null }, "fixture");
  const policy: RemoteDependencySetupPolicy = { kind: "pnpm", nodeExecutable: process.execPath, nodeVersion: process.versions.node,
    pnpmEntryPoint: pnpm.path, pnpmVersion: pnpm.version, scripts: "trusted-repository" };
  const mapping = { projectId: "project", localProjectId: local.id, sourceCachePath: cache, sourceRemote: "origin", presetIds: ["node:test"], dependencySetup: policy as RemoteDependencySetupPolicy | undefined, preparationTimeoutMs: 15_000 };
  const lifecycle = new ProjectLifecycle(store, { snapshot: vi.fn() });
  const admission = new FixtureGitAdmission();
  const reader = new SystemGitWorktreeReader(admission);
  const jobs = new TestJobManager(store, nullLogWriter);
  let unknownCleanup = false;
  cleanup.push(async () => { if (unknownCleanup) await expect(jobs.shutdown()).rejects.toThrow(); else await jobs.shutdown(); reader.close(); });
  const preparer = new SystemRemoteVerificationWorkspacePreparer(workspaces, admission);
  const execution = new SystemRemoteWorkerExecution("worker", [mapping], store, lifecycle, reader, new ProjectTestCommandResolver(), preparer, workspaces, new WorkerRecoveryService(store.remoteConnection, new LinuxWorkerRecoveryHost(join(root, "worker.sqlite3"))));
  let counter = 0;
  const reports: RemoteWorkerReport[] = [];
  let assignment: RemoteAssignment | null = null;
  let cancelAttempt: string | null = null;
  const worker = new RemoteVerificationWorker("worker", store.remoteConnection, jobs, id => store.getTestRun(id), execution, {
    poll: async () => ({ version: 1, assignments: assignment ? [assignment] : [], cancellations: cancelAttempt ? [cancelAttempt] : [] }),
    report: async report => { reports.push(report); },
  });
  cleanup.push(() => worker.close());
  const submit = async (sha: string) => {
    assignment = { projectId: "project", workerId: "worker", presetId: "node:test", commitSha: sha, requestId: `request-${++counter}`, attemptId: `attempt-${counter}` };
    await worker.tick(); return assignment;
  };
  const terminal = async (attempt: RemoteAssignment, timeout = 20_000) => {
    await vi.waitFor(async () => { await worker.tick(); expect(reports.some(report => report.attemptId === attempt.attemptId && ["succeeded", "failed", "cancelled", "uncertain"].includes(report.phase))).toBe(true); }, { timeout, interval: 30 });
    return reports.filter(report => report.attemptId === attempt.attemptId).at(-1)!;
  };
  const receipt = (attempt: RemoteAssignment) => store.remoteConnection.receipt(attempt.attemptId)!;
  const enqueueFollowing = () => jobs.enqueue({ projectId: local.id, actor: "local-user",
    worktree: { path: root, head: "a".repeat(40), shortHead: "aaaaaaaa", branch: null, detached: true, dirty: false, locked: false, prunable: false },
    command: { executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: root, preset: { id: "node:test", name: "test", adapter: "node", timeoutMs: 5_000 } },
    environment: { environment: {}, mode: "clean", profile: "fixture", inheritedServerProfile: null, variableNames: [] },
  });
  return { root, seed, cache, human, workspaces, store, local, lifecycle, jobs, mapping, admission, preparer, worker, reports, commit, submit, terminal, receipt,
    enqueueFollowing,
    cancel: async (attempt: RemoteAssignment) => { cancelAttempt = attempt.attemptId; await worker.tick(); },
    expectUnknownCleanup: () => { unknownCleanup = true; } };
}

it("installs committed local dependencies with real preinstalled pnpm and retains distinct failed/fixed exact-SHA evidence", async () => {
  const f = fixture(true);
  vi.stubEnv("CONTROLLER_SECRET", "do-not-inherit-this-fixture-value");
  const script = `const fs=require('node:fs');if(require('fixture-dep')!=='installed-from-committed-source'||fs.readFileSync('installed.txt','utf8')!=='real-pnpm-postinstall'||process.env.CONTROLLER_SECRET)process.exit(91);console.log('locked-dependency-executed');`;
  const failed = await f.submit(f.commit(script + "process.exit(1)", "failing fixture"));
  const first = await f.terminal(failed);
  const fixed = await f.submit(f.commit(script, "fixed fixture"));
  const second = await f.terminal(fixed);
  expect(first).toMatchObject({ phase: "failed", failureKind: "execution", executedCommitSha: failed.commitSha, exitCode: 1, execution: { cleanup: "confirmed" } });
  expect(second).toMatchObject({ phase: "succeeded", executedCommitSha: fixed.commitSha, exitCode: 0, source: { attribution: "observed_match" } });
  expect(failed.commitSha).not.toBe(fixed.commitSha);
  for (const result of [first, second]) {
    expect(result.environmentFingerprint).toMatch(/^[a-f0-9]{64}$/); expect(result.presetFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.logs.join("\n")).toContain("locked-dependency-executed"); expect(JSON.stringify(result)).not.toContain("do-not-inherit");
  }
  expect(readFileSync(join(f.human, "local.txt"), "utf8")).toBe("preserve");
  expect(readFileSync(join(f.workspaces, "unrelated.txt"), "utf8")).toBe("preserve");
  expect(existsSync(join(f.workspaces, fixed.attemptId))).toBe(false);
  expect(existsSync(join(f.workspaces, `.home-${fixed.attemptId}`))).toBe(false);
}, 45_000);

it.each([
  ["disabled", "dependency_setup_disabled"], ["missing-lock", "dependency_lockfile_required"], ["wrong-lock", "lockfile_version_unsupported"],
  ["package-manager", "package_manager_mismatch"], ["node", "worker_node_mismatch"], ["pnpm", "worker_pnpm_mismatch"], ["missing-tool", "worker_toolchain_unavailable"],
  ["failed-install", "dependency_install_failed"], ["mutated-lock", "dependency_metadata_changed"], ["mutated-source", "source_mismatch"],
] as const)("refuses %s preparation durably without starting the test", async (scenario, errorCode) => {
  const f = fixture();
  if (scenario === "disabled") f.mapping.dependencySetup = undefined;
  if (scenario === "missing-lock") rmSync(join(f.seed, "pnpm-lock.yaml"));
  if (scenario === "wrong-lock") writeFileSync(join(f.seed, "pnpm-lock.yaml"), "lockfileVersion: '6.0'\n");
  if (scenario === "package-manager") f.mapping.dependencySetup!.pnpmVersion = "11.5.2";
  if (scenario === "node") f.mapping.dependencySetup!.nodeVersion = "24.0.0";
  if (scenario === "pnpm") writeFileSync(f.mapping.dependencySetup!.pnpmEntryPoint, "#!/usr/bin/env node\nconsole.log('11.5.2')\n");
  if (scenario === "missing-tool") f.mapping.dependencySetup!.pnpmEntryPoint = join(f.root, "missing.cjs");
  if (scenario === "failed-install") writeFileSync(join(f.seed, "setup.cjs"), "console.log('private-setup-output');process.exit(37)");
  if (scenario === "mutated-lock") writeFileSync(join(f.seed, "setup.cjs"), "require('node:fs').appendFileSync('pnpm-lock.yaml','\\n# mutation\\n')");
  if (scenario === "mutated-source") writeFileSync(join(f.seed, "setup.cjs"), "require('node:fs').appendFileSync('postinstall.cjs','\\n// mutation\\n')");
  const attempt = await f.submit(f.commit());
  const result = await f.terminal(attempt);
  expect(result).toMatchObject({ phase: "failed", failureKind: "setup", errorCode, execution: { startedAt: null, cleanup: "confirmed" } });
  expect(result.logs.join("\n")).not.toContain("EXECUTED"); expect(result.logs.join("\n")).not.toContain("private-setup-output");
  expect(f.jobs.status().running).toBe(0);
  // Saved terminal evidence, not just the transport array, supports a restart/retry.
  expect(f.receipt(attempt).reports.at(-1)).toMatchObject({ phase: "failed", errorCode });
}, 20_000);

it("reports a real frozen-lock mismatch as setup failure", async () => {
  const f = fixture(true);
  const manifest = JSON.parse(readFileSync(join(f.seed, "package.json"), "utf8"));
  manifest.dependencies["fixture-dep"] = "file:./different-dependency";
  writeFileSync(join(f.seed, "package.json"), JSON.stringify(manifest));
  const result = await f.terminal(await f.submit(f.commit()));
  expect(result).toMatchObject({ phase: "failed", failureKind: "setup", errorCode: "dependency_install_failed", execution: { startedAt: null } });
}, 30_000);

it("refuses pnpm config plugins before installation without starting verification", async () => {
  const f = fixture(true);
  writeFileSync(join(f.seed, "pnpm-workspace.yaml"), "configDependencies:\n  fixture-must-not-download: 999.0.0\n");
  const result = await f.terminal(await f.submit(f.commit()));
  expect(result).toMatchObject({ phase: "failed", failureKind: "setup", errorCode: "dependency_config_plugins_unsupported", execution: { startedAt: null, cleanup: "confirmed" } });
  expect(result.logs.join("\n")).not.toContain("EXECUTED");
}, 30_000);

it("honors the ignore-script policy with real pnpm and fingerprints that policy separately", async () => {
  const f = fixture(true);
  writeFileSync(join(f.seed, ".gitignore"), "node_modules/\ninstalled.txt\ninstall-count.txt\n");
  writeFileSync(join(f.seed, "postinstall.cjs"), "require('node:fs').appendFileSync('install-count.txt','install\\n');require('node:fs').writeFileSync('installed.txt','real-pnpm-postinstall');console.log('setup-only-output');");
  f.mapping.dependencySetup!.scripts = "ignore";
  const sha = f.commit(`const fs=require('node:fs'),assert=require('node:assert/strict');require('fixture-dep');
    const count=fs.existsSync('install-count.txt')?fs.readFileSync('install-count.txt','utf8'):'';
    assert.equal(count,process.env.pnpm_config_ignore_scripts==='true'?'':'install\\n');
    console.log(fs.existsSync('installed.txt')?'scripts-trusted':'scripts-ignored');`);
  const result = await f.terminal(await f.submit(sha));
  expect(result).toMatchObject({ phase: "succeeded", exitCode: 0 });
  expect(result.logs.join("\n")).toContain("scripts-ignored");
  f.mapping.dependencySetup!.scripts = "trusted-repository";
  const trusted = await f.terminal(await f.submit(sha));
  expect(trusted).toMatchObject({ phase: "succeeded", presetFingerprint: result.presetFingerprint });
  expect(trusted.logs.join("\n")).toContain("scripts-trusted");
  expect(trusted.environmentFingerprint).not.toBe(result.environmentFingerprint);
  for (const report of [result, trusted]) expect(report.logs.join("\n")).not.toMatch(/Recreating |Lockfile is up to date|setup-only-output|Done in .*pnpm/);
}, 30_000);

it.each(["ignore", "trusted-repository"] as const)("preserves %s policy, private cache and prepared modules across genuine nested pnpm calls", async scripts => {
  const f = fixture(true);
  f.mapping.dependencySetup!.scripts = scripts;
  const manifest = JSON.parse(readFileSync(join(f.seed, "package.json"), "utf8"));
  manifest.scripts["test:unit"] = "node nested.cjs";
  manifest.scripts["pretest:unit"] = "node pretest.cjs";
  writeFileSync(join(f.seed, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(f.seed, ".gitignore"), "node_modules/\ninstalled.txt\ninstall-count.txt\nhook-count.txt\npretest-count.txt\n");
  writeFileSync(join(f.seed, "postinstall.cjs"), "require('node:fs').appendFileSync('install-count.txt','install\\n');console.log('setup-only-output');");
  writeFileSync(join(f.seed, "pretest.cjs"), "require('node:fs').appendFileSync('pretest-count.txt','pretest\\n');");
  if (scripts === "ignore") writeFileSync(join(f.seed, ".pnpmfile.cjs"), "require('node:fs').appendFileSync('hook-count.txt','hook\\n');module.exports={hooks:{readPackage:pkg=>pkg}};");
  // These repository settings must not override the worker's script, cache,
  // automatic-install or runtime-download policy in a nested invocation.
  writeFileSync(join(f.seed, "pnpm-workspace.yaml"), `packages: ['.']
verifyDepsBeforeRun: install
ignoreScripts: false
ignorePnpmfile: false
enablePrePostScripts: true
pmOnFail: download
runtimeOnFail: download
cacheDir: ${JSON.stringify(join(f.root, "escaped-cache"))}
`);
  const assertPolicy = `const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path'),cp=require('node:child_process');
    const ignored=${scripts === "ignore"};
    const count=()=>fs.existsSync('install-count.txt')?fs.readFileSync('install-count.txt','utf8'):'';
    const check=()=>{assert.equal(require('fixture-dep'),'installed-from-committed-source');assert.equal(count(),ignored?'':'install\\n');
      if(ignored){assert(!fs.existsSync('hook-count.txt'));assert(!fs.existsSync('pretest-count.txt'));}};
    const run=(executable,args)=>{const result=cp.spawnSync(executable,args,{encoding:'utf8',timeout:15000});
      assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout.trim();};
    check();
    assert.equal(run('pnpm',['--version']),${JSON.stringify(f.mapping.dependencySetup!.pnpmVersion)});
    for(const [key,directory] of [['store-dir','pnpm-store'],['cache-dir','pnpm-cache']]){
      const expected=path.join(process.env.HOME,directory);
      assert.equal(run('pnpm',['config','get',key]),expected);
      assert.equal(process.env['pnpm_config_'+key.replaceAll('-','_')],expected);
    }
    assert(run('pnpm',['store','path']).startsWith(path.join(process.env.HOME,'pnpm-store')+path.sep));
    assert(fs.readFileSync('node_modules/.modules.yaml','utf8').includes(path.join(process.env.HOME,'pnpm-store')));
    for(const [key,value] of [['verify-deps-before-run','false'],['pm-on-fail','error'],['runtime-on-fail','error'],['ignore-scripts',String(ignored)],['ignore-pnpmfile',String(ignored)],['configDependencies','null']]){
      assert.equal(run('pnpm',['config','get',key]),value);
    }
    check();`;
  writeFileSync(join(f.seed, "nested.cjs"), `${assertPolicy}
    assert.equal(fs.readFileSync('node_modules/install-sentinel','utf8'),'prepared-modules');
    assert(!fs.existsSync('node_modules/.pnpm-workspace-state-v1.json'));
    console.log('nested-explicit-test-executed');`);
  const sha = f.commit(`${assertPolicy}
    fs.writeFileSync('node_modules/install-sentinel','prepared-modules');
    // Force pnpm's freshness check to fail while retaining installed dependencies.
    // Both the PATH shorthand and npm_execpath route must still run the test,
    // without silently reinstalling or restoring pnpm's removed state file.
    fs.rmSync('node_modules/.pnpm-workspace-state-v1.json',{force:true});
    console.log(run('pnpm',['test:unit']));
    console.log(run(process.execPath,[process.env.npm_execpath,'run','test:unit']));
    check();assert(!fs.existsSync('node_modules/.pnpm-workspace-state-v1.json'));
    assert.equal(fs.readFileSync('node_modules/install-sentinel','utf8'),'prepared-modules');
    if(!ignored)assert.equal(fs.readFileSync('pretest-count.txt','utf8'),'pretest\\npretest\\n');
    console.log('outer-explicit-test-executed');`);
  const result = await f.terminal(await f.submit(sha), 45_000);
  expect(result, result.logs.join("\n")).toMatchObject({ phase: "succeeded", exitCode: 0, source: { attribution: "observed_match" } });
  const output = result.logs.join("\n");
  expect(output.match(/nested-explicit-test-executed/g)).toHaveLength(2);
  expect(output).toContain("outer-explicit-test-executed");
  expect(output).not.toMatch(/Recreating |Lockfile is up to date|setup-only-output|Done in .*pnpm/);
  expect(existsSync(join(f.root, "escaped-cache"))).toBe(false);
}, 60_000);

it.each(["package-manager", "runtime", "config-plugin"] as const)("prevents nested %s downloads with genuine pnpm", async kind => {
  const f = fixture(true);
  const sha = f.commit(`const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process');
    const target=path.join(process.env.TMPDIR,'nested-toolchain');fs.mkdirSync(target);
    fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({name:'nested-toolchain',version:'1.0.0',
      ${kind === "package-manager" ? "devEngines:{packageManager:{name:'pnpm',version:'999.0.0',onFail:'download'}}," : kind === "runtime" ? "devEngines:{runtime:{name:'node',version:'999.0.0',onFail:'download'}}," : ""}
      scripts:{probe:'node -e "process.exit(${kind === "config-plugin" ? 0 : 99})"'}}));
    fs.writeFileSync(path.join(target,'pnpm-workspace.yaml'),'pmOnFail: download\\nruntimeOnFail: download\\nverifyDepsBeforeRun: install\\n${kind === "config-plugin" ? "configDependencies:\\n  fixture-must-not-download: 999.0.0\\n" : ""}');
    // A broken download policy must fail against loopback/offline inputs rather
    // than contact the public package registry or Node distribution service.
    const proxy='http://127.0.0.1:9';
    const result=cp.spawnSync('pnpm',['--config.offline=true','--dir',target,'run','probe'],{encoding:'utf8',timeout:5000,
      env:{...process.env,pnpm_config_registry:proxy,pnpm_config_fetch_retries:'0',http_proxy:proxy,https_proxy:proxy}});
    assert.ifError(result.error);assert.equal(result.status,${kind === "config-plugin" ? 0 : 1},result.stdout+result.stderr);
    ${kind === "config-plugin" ? "" : `assert((result.stdout+result.stderr).includes(${JSON.stringify(kind === "package-manager" ? "This project is configured to use 999.0.0 of pnpm" : "This project requires Node.js 999.0.0")}),result.stdout+result.stderr);`}
    assert(!fs.existsSync(path.join(target,'node_modules')));console.log('nested-toolchain-download-refused');`);
  const result = await f.terminal(await f.submit(sha));
  expect(result, result.logs.join("\n")).toMatchObject({ phase: "succeeded", exitCode: 0, source: { attribution: "observed_match" } });
  expect(result.logs.join("\n")).toContain("nested-toolchain-download-refused");
}, 30_000);

it.each(["fetch", "install"] as const)("cancels during %s and waits for owned descendants before releasing capacity", async stage => {
  const f = fixture(), marker = join(f.root, "preparation-pid");
  const script = `const child=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(child.pid));setInterval(()=>{},1000);`;
  if (stage === "install") writeFileSync(join(f.seed, "setup.cjs"), script);
  else {
    const helper = join(f.root, "upload-pack.cjs"); writeFileSync(helper, `#!${process.execPath}\n${script}`); chmodSync(helper, 0o755);
    git(f.cache, "config", "remote.origin.uploadpack", helper);
  }
  const attempt = await f.submit(f.commit());
  await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000 });
  f.jobs.setLimit(1);
  const following = f.enqueueFollowing();
  let releaseStop!: () => void;
  const gate = new Promise<void>(resolve => { releaseStop = resolve; });
  const original = OwnedProcessGroup.prototype.stop;
  const stop = vi.spyOn(OwnedProcessGroup.prototype, "stop").mockImplementationOnce(async function (this: OwnedProcessGroup) { await gate; return original.call(this); });
  try {
    await f.cancel(attempt);
    expect(f.jobs.status().running).toBe(1);
    expect(f.store.getTestRun(following.id)?.phase).toBe("queued");
    expect(f.store.getTestRun(f.receipt(attempt).localRunId)?.telemetry?.finalizedAt).toBeNull();
    const permit = f.lifecycle.acquireMaintenance(f.local.id, join(f.workspaces, attempt.attemptId));
    expect(permit).toBeNull(); permit?.();
  } finally { releaseStop(); }
  const result = await f.terminal(attempt); stop.mockRestore();
  expect(result).toMatchObject({ phase: "cancelled", errorCode: "preparation_cancelled", execution: { startedAt: null, cleanup: "confirmed", termination: "cancel" } });
  await vi.waitFor(() => expect(f.store.getTestRun(following.id)?.phase).toBe("passed"));
  expect(f.jobs.status().running).toBe(0);
  const pid = readFileSync(marker, "utf8");
  let state = "";
  try { state = execFileSync("ps", ["-o", "stat=", "-p", pid], { encoding: "utf8" }).trim(); }
  catch (error) { expect((error as { status: number }).status).toBe(1); }
  expect(!state || state.startsWith("Z")).toBe(true);
  expect(existsSync(join(f.workspaces, attempt.attemptId))).toBe(false);
}, 25_000);

it.each(["fetch", "install"] as const)("times out stalled %s under the overall preparation budget without starting execution", async stage => {
  const f = fixture(); f.mapping.preparationTimeoutMs = 1_500;
  if (stage === "install") writeFileSync(join(f.seed, "setup.cjs"), "setInterval(()=>{},1000)");
  else {
    const helper = join(f.root, "upload-pack.cjs"); writeFileSync(helper, `#!${process.execPath}\nsetInterval(()=>{},1000)`); chmodSync(helper, 0o755);
    git(f.cache, "config", "remote.origin.uploadpack", helper);
  }
  const result = await f.terminal(await f.submit(f.commit()));
  expect(result).toMatchObject({ phase: "failed", errorCode: "preparation_timeout", failureKind: "setup", execution: { startedAt: null, termination: "timeout", cleanup: "confirmed" } });
}, 20_000);

it("retains workspace and capacity and reports durable uncertainty if cleanup cannot be confirmed", async () => {
  const f = fixture(), marker = join(f.root, "install-pid");
  writeFileSync(join(f.seed, "setup.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`);
  const attempt = await f.submit(f.commit());
  await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000 });
  const original = OwnedProcessGroup.prototype.stop;
  let stopOwned: (() => Promise<void>) | undefined;
  vi.spyOn(OwnedProcessGroup.prototype, "stop").mockImplementationOnce(function (this: OwnedProcessGroup) { stopOwned = original.bind(this); return Promise.reject(new Error("fixture cleanup unavailable")); });
  f.expectUnknownCleanup();
  try {
    await f.cancel(attempt);
    const result = await f.terminal(attempt);
    expect(result).toMatchObject({ phase: "uncertain", errorCode: "preparation_cleanup_unconfirmed", execution: { cleanup: "failed" } });
    expect(f.jobs.status()).toMatchObject({ running: 1, admissionBlockReason: "remote_execution_cleanup_unconfirmed" });
    expect(existsSync(join(f.workspaces, attempt.attemptId))).toBe(true);
    expect(f.lifecycle.acquireMaintenance(f.local.id, join(f.workspaces, attempt.attemptId))).toBeNull();
    expect(f.receipt(attempt).reports.at(-1)?.phase).toBe("uncertain");
    expect(hasUnconfirmedRemoteExecution(f.store.remoteConnection.receipts(), () => null)).toBe(true);
  } finally { vi.restoreAllMocks(); await stopOwned?.(); }
}, 20_000);

it("cancels while waiting for the existing Git admission slot and never starts the queued operation", async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const blocking = f.admission.run("remote", async () => { entered(); await gate; });
  await ready;
  try {
    const attempt = await f.submit(f.commit());
    await vi.waitFor(() => expect(f.admission.remoteRequests).toBe(2));
    await f.cancel(attempt);
    expect(await f.terminal(attempt)).toMatchObject({ phase: "cancelled", execution: { startedAt: null } });
    expect(f.jobs.status().running).toBe(0);
  } finally { release(); await blocking; }
}, 20_000);

it("cancels inert lifecycle waiting without a late workspace or install after the lock is released", async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const blocking = f.lifecycle.serialized(f.local.id, async () => { entered(); await gate; });
  await ready;
  let attempt: RemoteAssignment;
  try {
    attempt = await f.submit(f.commit());
    await vi.waitFor(() => expect(f.jobs.status().running).toBe(1));
    await f.cancel(attempt);
    expect(await f.terminal(attempt)).toMatchObject({ phase: "cancelled", execution: { startedAt: null, cleanup: "confirmed" } });
    expect(existsSync(join(f.workspaces, `.home-${attempt.attemptId}`))).toBe(false);
  } finally { release(); await blocking; }
  // The old serialized callback must pass its aborted-context check before any effects.
  await f.lifecycle.serialized(f.local.id, async () => undefined);
  expect(existsSync(join(f.workspaces, attempt!.attemptId))).toBe(false);
}, 20_000);

it("preserves an existing attempt HOME instead of borrowing or deleting it", async () => {
  const f = fixture(), existing = join(f.workspaces, ".home-attempt-1");
  mkdirSync(existing); writeFileSync(join(existing, "unrelated.txt"), "preserve");
  const result = await f.terminal(await f.submit(f.commit()));
  expect(result).toMatchObject({ phase: "failed", failureKind: "setup", execution: { startedAt: null } });
  expect(readFileSync(join(existing, "unrelated.txt"), "utf8")).toBe("preserve");
}, 20_000);

it("reports workspace disposal failure as uncertainty without releasing the owned exclusion", async () => {
  const f = fixture();
  const remove = vi.spyOn(f.preparer, "cleanup").mockRejectedValue(new Error("fixture filesystem busy"));
  try {
    const attempt = await f.submit(f.commit());
    const result = await f.terminal(attempt);
    expect(result).toMatchObject({ phase: "uncertain", errorCode: "workspace_cleanup_failed", execution: { cleanup: "failed" } });
    expect(f.jobs.status().admissionBlockReason).toBe("remote_execution_cleanup_unconfirmed");
    expect(f.lifecycle.acquireMaintenance(f.local.id, join(f.workspaces, attempt.attemptId))).toBeNull();
  } finally { remove.mockRestore(); }
}, 20_000);
