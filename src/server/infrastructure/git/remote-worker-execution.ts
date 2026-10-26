import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitWorktreeReader } from "@/server/git-worktrees";
import type { ProjectLifecycle } from "@/server/modules/lifecycle";
import { testProfileFor } from "@/server/modules/environments";
import type { ResolvedTestEnvironment } from "@/server/modules/environments";
import { fingerprint, type RemoteControllerStore, type RemoteVerificationWorkspace, type RemoteVerificationWorkspacePreparer, type RemoteWorkerExecution, type WorkerRecoveryService, type WorkerReceipt, remoteDependencySetupSchema, remotePreparationTimeoutSchema, type RemoteDependencySetupPolicy } from "@/server/modules/remote-verification";
import type { StateStore } from "@/server/state-store";
import type { ProjectTestCommandResolver, TestCommand } from "@/server/test-command";
import type { RemoteAssignment, RemoteWorkerReport } from "@/shared/contracts/remote-verification";
import { PreparationError, PreparationSession, type VerificationPreparationContext, projectTestPreset, type EnqueueTestInput } from "@/server/modules/verification";

import { dependencyIdentity, preparePnpmDependencies } from "./remote-worker-dependencies";

export interface RemoteWorkerProjectMapping {
  projectId: string;
  localProjectId: string;
  sourceCachePath: string;
  sourceRemote: string;
  presetIds: string[];
  dependencySetup?: RemoteDependencySetupPolicy;
  preparationTimeoutMs?: number;
}

/** Privileged local adapter. No filesystem location or command comes from a delivery. */
export class SystemRemoteWorkerExecution implements RemoteWorkerExecution {
  constructor(
    private readonly workerId: string,
    private readonly mappings: RemoteWorkerProjectMapping[],
    private readonly store: Pick<StateStore, "listProjects"> & Pick<RemoteControllerStore, "getRemoteWorkerProjectGrant" | "getRemoteProjectIdentity" | "getRemoteWorker" | "getRemotePrincipal">,
    private readonly lifecycle: ProjectLifecycle,
    private readonly git: GitWorktreeReader,
    private readonly commands: ProjectTestCommandResolver,
    private readonly preparer: RemoteVerificationWorkspacePreparer,
    private readonly workspaceRoot: string,
    private readonly recovery: WorkerRecoveryService,
  ) {}
  async resolve(assignment: RemoteAssignment, receipt: WorkerReceipt, running: (evidence: Partial<RemoteWorkerReport>) => void): Promise<EnqueueTestInput> {
    const mapping = this.mapping(assignment);
    if (mapping.dependencySetup && !remoteDependencySetupSchema.safeParse(mapping.dependencySetup).success) throw new PreparationError("dependency_policy_invalid");
    const preparationTimeoutMs = remotePreparationTimeoutSchema.parse(mapping.preparationTimeoutMs ?? 10 * 60_000);
    const path = join(this.workspaceRoot, assignment.attemptId);
    const worktree = { path, head: assignment.commitSha, shortHead: assignment.commitSha.slice(0, 8), branch: null, detached: true, dirty: false, locked: false, prunable: false };
    // A user-local Node installation supplies the worker's trusted runtime and npm.
    // Do not inherit the controller's arbitrary PATH entries into verification.
    const environment: ResolvedTestEnvironment = {
      environment: { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, LANG: "C.UTF-8", CI: "1", HOME: join(this.workspaceRoot, `.home-${assignment.attemptId}`), TMPDIR: join(this.workspaceRoot, `.tmp-${assignment.attemptId}`) },
      mode: "clean" as const, profile: "remote-secret-free-v2", inheritedServerProfile: null, variableNames: ["PATH", "LANG", "CI", "HOME", "TMPDIR"],
    };
    const home = environment.environment.HOME;
    const temporary = environment.environment.TMPDIR;
    Object.assign(environment.environment, {
      XDG_CACHE_HOME: join(home, "cache"), XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_PROJECT_SPEC: "0",
      npm_config_userconfig: join(home, "user.npmrc"), npm_config_globalconfig: join(home, "global.npmrc"),
      pnpm_config_pm_on_fail: "error", pnpm_config_engine_strict: "true",
      PNPM_HOME: join(home, "pnpm"), npm_config_cache: join(home, "npm-cache"), TMP: temporary, TEMP: temporary,
    });
    let context: VerificationPreparationContext | null = null;
    let localSession: PreparationSession | null = null;
    let dependencyFingerprint: string | null = null;
    let definitionCommand: TestCommand | null = null;
    let releaseCache: (() => void) | null = null;
    let unsafeCleanup = false;
    let ownsHome = false, ownsTemporary = false;
    let workspace: RemoteVerificationWorkspace | null = null;
    let releaseWorkspace: (() => void) | null = null;
    let command: TestCommand | null = null;
    let presetFingerprint: string | null = null;
    const observeSource = async () => {
      try { return await this.observe(path, context!, environment.environment); }
      catch (error) { if (error instanceof PreparationError && error.cleanupUnconfirmed) unsafeCleanup = true; throw error; }
    };
    const preset = { id: assignment.presetId, name: assignment.presetId.split(":").slice(1).join(":"), adapter: assignment.presetId.split(":")[0] as "node", timeoutMs: 15 * 60_000 };
    return {
      projectId: mapping.localProjectId, worktree,
      command: { preset, executable: "", args: [], cwd: path }, environment, actor: `remote-worker:${this.workerId}`,
      preparation: {
        timeoutMs: preparationTimeoutMs,
        prepare: async supplied => {
          context = supplied ?? (localSession = new PreparationSession(preparationTimeoutMs));
          return this.serializedPreparation(context, mapping.localProjectId, async () => {
            context!.throwIfAborted();
            this.mapping(assignment);
            const project = this.lifecycle.requireProject(mapping.localProjectId);
            this.lifecycle.assertReservationAllows(project.id, path, { owner: `remote-worker:${this.workerId}` });
            const cache = await realpath(mapping.sourceCachePath);
            // A linked human worktree has a .git file. Only an independent worker-owned clone is allowed.
            if (!(await lstat(join(cache, ".git"))).isDirectory()) throw new Error("independent_source_cache_required");
            for (const candidate of this.store.listProjects()) {
              // Preserve lexical containment even if an unrelated registration has
              // disappeared. Existing paths must also pass canonical/symlink checks.
              this.assertIndependentCache(resolve(candidate.repositoryPath), resolve(mapping.sourceCachePath));
              this.assertIndependentCache(resolve(candidate.repositoryPath), cache);
              let repository: string;
              try { repository = await realpath(candidate.repositoryPath); }
              catch (error) {
                if (candidate.id !== project.id && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
                throw error;
              }
              this.assertIndependentCache(repository, cache);
            }
            await mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 });
            if (!(await lstat(this.workspaceRoot)).isDirectory() || (await lstat(this.workspaceRoot)).isSymbolicLink()) throw new PreparationError("workspace_root_invalid");
            // Commit boot/installation/path provenance before any Git/setup command
            // or execution can spawn, including the launcher-death crash window.
            this.recovery.recordStart(receipt, this.workspaceRoot, cache);
            await mkdir(home, { mode: 0o700 });
            ownsHome = true;
            await mkdir(temporary, { mode: 0o700 });
            ownsTemporary = true;
            context!.throwIfAborted();
            releaseWorkspace = this.lifecycle.acquireMaintenance(project.id, path);
            if (!releaseWorkspace) throw new Error("workspace_busy");
            releaseCache = this.lifecycle.acquireMaintenance(project.id, cache);
            if (!releaseCache) throw new Error("source_cache_busy");
            try {
              workspace = await this.preparer.prepare({ requestId: assignment.attemptId, repositoryPath: cache, sourceRemote: mapping.sourceRemote, commitSha: assignment.commitSha, preparation: context!, environment: environment.environment });
            } catch (error) {
              unsafeCleanup = error instanceof PreparationError && error.cleanupUnconfirmed;
              throw error;
            } finally { if (!unsafeCleanup) { releaseCache?.(); releaseCache = null; } }
            if (workspace.path !== path || workspace.executedCommitSha !== assignment.commitSha) throw new Error("source_mismatch");
            command = this.commands.resolve(path, assignment.presetId);
            const profile = testProfileFor(project, command.preset);
            if (profile.policy.mode !== "clean" || Object.keys(profile.environment).length || profile.requiredVariables.length) throw new Error("secret_free_profile_required");
            if (profile.nodeEnv) environment.environment.NODE_ENV = profile.nodeEnv;
            environment.variableNames = Object.keys(environment.environment).sort();
            const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown>; peerDependencies?: Record<string, unknown> };
            if (!mapping.dependencySetup && [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies].some(deps => Object.keys(deps ?? {}).length)) throw new PreparationError("dependency_setup_disabled");
            command = { ...command, preset: projectTestPreset(project, command.preset) };
            if (command.preset.adapter !== "node" || /(?:^|:)(?:ui|e2e|integration|watch|dev)(?::|$)/.test(command.preset.name)) throw new Error("remote_preset_not_supported");
            definitionCommand = command;
            if (mapping.dependencySetup) {
              try {
                const prepared = await preparePnpmDependencies({ path, policy: mapping.dependencySetup, context: context!, environment: environment.environment, toolDirectory: join(home, "bin") });
                dependencyFingerprint = prepared.fingerprint;
                command = { ...command, executable: prepared.executable, args: [...prepared.args, command.preset.name] };
              } catch (error) { unsafeCleanup = error instanceof PreparationError && error.cleanupUnconfirmed; throw error; }
            }
            presetFingerprint = await this.definitionFingerprint(path, definitionCommand);
            environment.variableNames = Object.keys(environment.environment).sort();
            const sourceObservation = await observeSource();
            if (!sourceObservation.complete || sourceObservation.head !== assignment.commitSha || sourceObservation.dirty) throw new PreparationError("source_mismatch");
            context!.throwIfAborted();
            return { worktree, command, environment, sourceObservation };
          });
        },
        observe: async (_run, stage) => this.serializedPreparation(context!, mapping.localProjectId, async () => {
          if (stage === "preflight") {
            this.mapping(assignment);
            const project = this.lifecycle.requireProject(mapping.localProjectId);
            this.lifecycle.assertReservationAllows(mapping.localProjectId, path, { owner: `remote-worker:${this.workerId}` });
            const resolved = this.commands.resolve(path, assignment.presetId);
            if (!command || !definitionCommand || presetFingerprint !== await this.definitionFingerprint(path, { ...resolved, preset: projectTestPreset(project, resolved.preset) })) throw new Error("preset_changed");
            const profile = testProfileFor(project, command.preset);
            if (profile.policy.mode !== "clean" || Object.keys(profile.environment).length || profile.requiredVariables.length || (profile.nodeEnv ?? undefined) !== environment.environment.NODE_ENV) throw new Error("secret_free_profile_required");
          }
          return observeSource();
        }),
        starting: () => {
          this.mapping(assignment);
          this.lifecycle.requireProject(mapping.localProjectId);
          this.lifecycle.assertReservationAllows(mapping.localProjectId, path, { owner: `remote-worker:${this.workerId}` });
          context?.throwIfAborted();
          if (!presetFingerprint || !workspace || receipt.cancellationRequested) throw new Error("execution_not_authorized");
        },
        started: () => {
          if (!presetFingerprint || !workspace) throw new Error("execution_evidence_unavailable");
          running({ executedCommitSha: workspace.executedCommitSha, presetFingerprint, environmentFingerprint: fingerprint({ policy: "remote-secret-free-v2", dependencySetup: dependencyFingerprint ?? "disabled", preparationTimeoutMs, controllerNode: process.version, platform: process.platform, arch: process.arch, environment: { ...Object.fromEntries(Object.entries(environment.environment).map(([key, value]) => [key, value.replaceAll(home, "fresh-home").replaceAll(temporary, "fresh-tmp")])) } }) });
        },
        dispose: async () => {
          localSession?.close();
          if (unsafeCleanup) throw new PreparationError("preparation_cleanup_unconfirmed", true);
          try {
            if (workspace) await this.preparer.cleanup(workspace);
            if (ownsHome) await rm(home, { recursive: true, force: true });
            if (ownsTemporary) await rm(temporary, { recursive: true, force: true });
          } catch { throw new PreparationError("workspace_cleanup_failed", true); }
          releaseWorkspace?.(); releaseWorkspace = null;
          releaseCache?.(); releaseCache = null;
        },
      },
    };
  }
  private async serializedPreparation<T>(context: VerificationPreparationContext, projectId: string, operation: () => Promise<T>): Promise<T> {
    let started = false;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { entered = resolve; });
    const pending = this.lifecycle.serialized(projectId, async () => {
      context.throwIfAborted();
      started = true; entered();
      return operation();
    });
    void pending.then(entered, entered);
    try { await context.wait(gate); }
    catch (error) { if (!started) throw error; }
    return pending;
  }
  private observe(path: string, context: VerificationPreparationContext, environment: Record<string, string>) {
    return this.git.observe(path, { signal: context.signal, execute: (args, signal) => context.command({ executable: "git", args, cwd: path,
      environment, signal, timeoutMs: 10_000, errorCode: "source_observation_failed" }) });
  }
  private assertIndependentCache(repository: string, cache: string): void {
    const within = relative(repository, cache);
    if (!within || (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`))) throw new Error("independent_source_cache_required");
  }
  private mapping(assignment: RemoteAssignment): RemoteWorkerProjectMapping {
    const mapping = this.mappings.find(x => x.projectId === assignment.projectId);
    const worker = this.store.getRemoteWorker(this.workerId);
    const principal = worker ? this.store.getRemotePrincipal(worker.principalId) : null;
    const project = this.store.getRemoteProjectIdentity(assignment.projectId);
    const grant = this.store.getRemoteWorkerProjectGrant(this.workerId, assignment.projectId);
    if (assignment.workerId !== this.workerId || worker?.status !== "active" || principal?.status !== "active" || principal.kind !== "worker" || !mapping || project?.status !== "active" || project.sourceRemote !== mapping.sourceRemote || !grant || grant.revokedAt || grant.localProjectId !== mapping.localProjectId || !grant.presetIds.includes(assignment.presetId) || !mapping.presetIds.includes(assignment.presetId)) throw new Error("local_mapping_forbidden");
    return mapping;
  }
  private async definitionFingerprint(path: string, command: TestCommand): Promise<string> {
    return fingerprint({ executable: command.executable, args: command.args, preset: command.preset, metadata: await dependencyIdentity(path) });
  }
}
