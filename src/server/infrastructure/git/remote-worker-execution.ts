import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { GitWorktreeReader } from "@/server/git-worktrees";
import type { ProjectLifecycle } from "@/server/modules/lifecycle";
import { testProfileFor } from "@/server/modules/environments";
import type { ResolvedTestEnvironment } from "@/server/modules/environments";
import { fingerprint, type RemoteControllerStore, type RemoteVerificationWorkspace, type RemoteVerificationWorkspacePreparer, type RemoteWorkerExecution, type WorkerReceipt } from "@/server/modules/remote-verification";
import type { StateStore } from "@/server/state-store";
import type { ProjectTestCommandResolver, TestCommand } from "@/server/test-command";
import type { RemoteAssignment, RemoteWorkerReport } from "@/shared/contracts/remote-verification";
import { projectTestPreset, type EnqueueTestInput } from "@/server/modules/verification";

export interface RemoteWorkerProjectMapping {
  projectId: string;
  localProjectId: string;
  sourceCachePath: string;
  sourceRemote: string;
  presetIds: string[];
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
  ) {}
  async resolve(assignment: RemoteAssignment, receipt: WorkerReceipt, running: (evidence: Partial<RemoteWorkerReport>) => void): Promise<EnqueueTestInput> {
    const mapping = this.mapping(assignment);
    const path = join(this.workspaceRoot, assignment.attemptId);
    const worktree = { path, head: assignment.commitSha, shortHead: assignment.commitSha.slice(0, 8), branch: null, detached: true, dirty: false, locked: false, prunable: false };
    // A user-local Node installation supplies the worker's trusted runtime and npm.
    // Do not inherit the controller's arbitrary PATH entries into verification.
    const environment: ResolvedTestEnvironment = {
      environment: { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, LANG: "C.UTF-8", CI: "1", HOME: join(this.workspaceRoot, `.home-${assignment.attemptId}`), TMPDIR: join(this.workspaceRoot, `.tmp-${assignment.attemptId}`) },
      mode: "clean" as const, profile: "remote-secret-free-v1", inheritedServerProfile: null, variableNames: ["PATH", "LANG", "CI", "HOME", "TMPDIR"],
    };
    let workspace: RemoteVerificationWorkspace | null = null;
    let releaseWorkspace: (() => void) | null = null;
    let command: TestCommand | null = null;
    let presetFingerprint: string | null = null;
    const preset = { id: assignment.presetId, name: assignment.presetId.split(":").slice(1).join(":"), adapter: assignment.presetId.split(":")[0] as "node", timeoutMs: 15 * 60_000 };
    return {
      projectId: mapping.localProjectId, worktree,
      command: { preset, executable: "", args: [], cwd: path }, environment, actor: `remote-worker:${this.workerId}`,
      preparation: {
        prepare: () => this.lifecycle.serialized(mapping.localProjectId, async () => {
          this.mapping(assignment);
          const project = this.lifecycle.requireProject(mapping.localProjectId);
          this.lifecycle.assertReservationAllows(project.id, path, { owner: `remote-worker:${this.workerId}` });
          const cache = await realpath(mapping.sourceCachePath);
          // A linked human worktree has a .git file. Only an independent worker-owned clone is allowed.
          if (!(await lstat(join(cache, ".git"))).isDirectory()) throw new Error("independent_source_cache_required");
          for (const candidate of this.store.listProjects()) {
            const repository = await realpath(candidate.repositoryPath);
            const within = relative(repository, cache);
            if (!within || !within.startsWith("..") && !isAbsolute(within)) throw new Error("independent_source_cache_required");
          }
          releaseWorkspace = this.lifecycle.acquireMaintenance(project.id, path);
          if (!releaseWorkspace) throw new Error("workspace_busy");
          const releaseCache = this.lifecycle.acquireMaintenance(project.id, cache);
          if (!releaseCache) throw new Error("source_cache_busy");
          try {
            workspace = await this.preparer.prepare({ requestId: assignment.attemptId, repositoryPath: cache, sourceRemote: mapping.sourceRemote, commitSha: assignment.commitSha });
          } finally { releaseCache(); }
          if (workspace.path !== path || workspace.executedCommitSha !== assignment.commitSha) throw new Error("source_mismatch");
          command = this.commands.resolve(path, assignment.presetId);
          const profile = testProfileFor(project, command.preset);
          if (profile.policy.mode !== "clean" || Object.keys(profile.environment).length || profile.requiredVariables.length) throw new Error("secret_free_profile_required");
          if (profile.nodeEnv) environment.environment.NODE_ENV = profile.nodeEnv;
          environment.variableNames = Object.keys(environment.environment).sort();
          const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
          // Dependency installation needs its own owned-process setup stage. This first slice
          // deliberately accepts dependency-free Node checks only, never borrowing node_modules.
          if (Object.keys(manifest.dependencies ?? {}).length || Object.keys(manifest.devDependencies ?? {}).length) throw new Error("dependency_setup_not_supported");
          command = { ...command, preset: projectTestPreset(project, command.preset) };
          if (command.preset.adapter !== "node" || /(?:^|:)(?:ui|e2e|integration|watch|dev)(?::|$)/.test(command.preset.name)) throw new Error("remote_preset_not_supported");
          presetFingerprint = await this.definitionFingerprint(path, command);
          await mkdir(environment.environment.HOME, { recursive: true, mode: 0o700 });
          await mkdir(environment.environment.TMPDIR, { recursive: true, mode: 0o700 });
          const sourceObservation = await this.git.observe(path);
          if (!sourceObservation.complete || sourceObservation.head !== assignment.commitSha || sourceObservation.dirty) throw new Error("source_mismatch");
          return { worktree, command, environment, sourceObservation };
        }),
        observe: async (_run, stage) => this.lifecycle.serialized(mapping.localProjectId, async () => {
          if (stage === "preflight") {
            this.mapping(assignment);
            const project = this.lifecycle.requireProject(mapping.localProjectId);
            this.lifecycle.assertReservationAllows(mapping.localProjectId, path, { owner: `remote-worker:${this.workerId}` });
            const resolved = this.commands.resolve(path, assignment.presetId);
            if (!command || presetFingerprint !== await this.definitionFingerprint(path, { ...resolved, preset: projectTestPreset(project, resolved.preset) })) throw new Error("preset_changed");
            const profile = testProfileFor(project, command.preset);
            if (profile.policy.mode !== "clean" || Object.keys(profile.environment).length || profile.requiredVariables.length || (profile.nodeEnv ?? undefined) !== environment.environment.NODE_ENV) throw new Error("secret_free_profile_required");
          }
          return this.git.observe(path);
        }),
        starting: () => {
          this.mapping(assignment);
          this.lifecycle.requireProject(mapping.localProjectId);
          this.lifecycle.assertReservationAllows(mapping.localProjectId, path, { owner: `remote-worker:${this.workerId}` });
          if (!presetFingerprint || !workspace || receipt.cancellationRequested) throw new Error("execution_not_authorized");
        },
        started: () => {
          if (!presetFingerprint || !workspace) throw new Error("execution_evidence_unavailable");
          running({ executedCommitSha: workspace.executedCommitSha, presetFingerprint, environmentFingerprint: fingerprint({ policy: "remote-secret-free-v1", controllerNode: process.version, platform: process.platform, arch: process.arch, environment: { ...environment.environment, HOME: "fresh-per-attempt", TMPDIR: "fresh-per-attempt" } }) });
        },
        dispose: async () => {
          try {
            if (workspace) await this.preparer.cleanup(workspace);
            await rm(environment.environment.HOME, { recursive: true, force: true });
            await rm(environment.environment.TMPDIR, { recursive: true, force: true });
          } finally { releaseWorkspace?.(); releaseWorkspace = null; }
        },
      },
    };
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
    return fingerprint({ executable: command.executable, args: command.args, preset: command.preset, manifest: await readFile(join(path, "package.json"), "utf8") });
  }
}
