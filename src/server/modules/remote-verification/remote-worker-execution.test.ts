import * as fsPromises from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SystemRemoteWorkerExecution } from "@/server/infrastructure/git";
import { ProjectLifecycle } from "@/server/modules/lifecycle";
import { SqliteStateStore } from "@/server/sqlite-store";
import { ProjectTestCommandResolver } from "@/server/test-command";
import type { RemoteAssignment } from "@/shared/contracts/remote-verification";
import type { RemoteVerificationWorkspacePreparer, WorkerReceipt } from "./index";

vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) dispose(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wtc-worker-source-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const human = join(root, "human"), cache = join(root, "cache"), workspaces = join(root, "attempts");
  mkdirSync(join(human, ".git"), { recursive: true });
  mkdirSync(join(cache, ".git"), { recursive: true });
  const store = new SqliteStateStore(join(root, "worker.sqlite3"));
  cleanup.push(() => store.close());
  const local = store.addProject({ name: "A selected", repositoryPath: human, port: 3199, executable: "", args: [], launchPreset: "none" });
  store.saveRemotePrincipal({ id: "worker-principal", kind: "worker", status: "active" }, "fixture");
  store.saveRemoteProjectIdentity({ id: "remote-project", name: "Fixture", sourceRemote: "origin", status: "active" }, "fixture");
  store.saveRemoteWorker({ id: "worker", principalId: "worker-principal", name: "Fixture", status: "active", lastContactAt: null }, "fixture");
  store.saveRemoteWorkerProjectGrant({ workerId: "worker", projectId: "remote-project", localProjectId: local.id,
    presetIds: ["node:test"], revokedAt: null }, "fixture");
  const lifecycle = new ProjectLifecycle(store, { snapshot: vi.fn() });
  const preparer = { prepare: vi.fn<RemoteVerificationWorkspacePreparer["prepare"]>().mockRejectedValue(new Error("preparer_reached")), cleanup: vi.fn() };
  const mapping = { projectId: "remote-project", localProjectId: local.id, sourceCachePath: cache, sourceRemote: "origin", presetIds: ["node:test"] };
  const execution = new SystemRemoteWorkerExecution("worker", [mapping], store, lifecycle,
    { canonicalRepositoryPath: vi.fn(), list: vi.fn(), observe: vi.fn() }, new ProjectTestCommandResolver([]), preparer, workspaces);
  const assignment: RemoteAssignment = { requestId: "request", attemptId: "attempt", projectId: "remote-project",
    workerId: "worker", presetId: "node:test", commitSha: "a".repeat(40) };
  const receipt: WorkerReceipt = { assignment, localRunId: "run", cancellationRequested: false, reports: [], acknowledgedSequence: 0 };
  const prepare = async () => {
    const input = await execution.resolve(assignment, receipt, vi.fn());
    try { await input.preparation!.prepare(); }
    finally { await input.preparation!.dispose(); }
  };
  const register = (path: string) => store.addProject({ name: "Z unrelated", repositoryPath: path,
    port: 3198, executable: "", args: [], launchPreset: "none" });
  return { root, human, cache, workspaces, local, store, lifecycle, preparer, mapping, assignment, prepare, register };
}

it("reaches preparation with a valid selected project and an unrelated absent registration", async () => {
  const f = fixture();
  f.register(join(f.root, "absent"));
  await expect(f.prepare()).rejects.toThrow("preparer_reached");
  expect(f.preparer.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: f.assignment.attemptId,
    repositoryPath: f.cache, sourceRemote: "origin", commitSha: f.assignment.commitSha,
    preparation: expect.objectContaining({ signal: expect.any(AbortSignal) }),
    environment: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0", HOME: join(f.workspaces, ".home-attempt") }),
  }));
  // Failure still releases both lifecycle permits through queue disposal.
  const releaseWorkspace = f.lifecycle.acquireMaintenance(f.local.id, join(f.workspaces, f.assignment.attemptId));
  const releaseCache = f.lifecycle.acquireMaintenance(f.local.id, f.cache);
  expect(releaseWorkspace).not.toBeNull(); expect(releaseCache).not.toBeNull();
  releaseWorkspace?.(); releaseCache?.();
});

it.each(["real-checkout", "symlink-cache", "symlink-registration"] as const)("rejects %s containment even with an unrelated absent registration", async kind => {
  const f = fixture();
  if (kind === "real-checkout") f.mapping.sourceCachePath = f.human;
  else if (kind === "symlink-cache") {
    const alias = join(f.root, "human-alias"); symlinkSync(f.human, alias, "dir"); f.mapping.sourceCachePath = alias;
  } else {
    const alias = join(f.root, "registered-alias"); symlinkSync(f.cache, alias, "dir"); f.register(alias);
  }
  f.store.addProject({ name: "B absent", repositoryPath: join(f.root, "absent"), port: 3197,
    executable: "", args: [], launchPreset: "none" });
  await expect(f.prepare()).rejects.toThrow("independent_source_cache_required");
  expect(f.preparer.prepare).not.toHaveBeenCalled();
});

it("preserves lexical cache containment when a nested symlink points outside a registered checkout", async () => {
  const f = fixture();
  const alias = join(f.human, "worker-cache"); symlinkSync(f.cache, alias, "dir");
  f.mapping.sourceCachePath = alias;
  await expect(f.prepare()).rejects.toThrow("independent_source_cache_required");
  expect(f.preparer.prepare).not.toHaveBeenCalled();
});

it("rejects a linked human worktree as a source cache", async () => {
  const f = fixture();
  const linked = join(f.root, "linked"); mkdirSync(linked); writeFileSync(join(linked, ".git"), "gitdir: ../human/.git/worktrees/linked\n");
  f.mapping.sourceCachePath = linked;
  await expect(f.prepare()).rejects.toThrow("independent_source_cache_required");
  expect(f.preparer.prepare).not.toHaveBeenCalled();
});

it.each(["selected-repository", "selected-source-cache"] as const)("fails closed for a missing %s", async missing => {
  const f = fixture();
  f.register(join(f.root, "unrelated-absent"));
  rmSync(missing === "selected-repository" ? f.human : f.cache, { recursive: true });
  await expect(f.prepare()).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.preparer.prepare).not.toHaveBeenCalled();
});

it.each(["EACCES", "EIO", "ENOTDIR"])("does not swallow %s from an unrelated registered repository", async code => {
  const f = fixture();
  const unrelated = join(f.root, "unrelated"); mkdirSync(unrelated); f.register(unrelated);
  const error = Object.assign(new Error("unrelated_repository_unreadable"), { code });
  const paths = vi.spyOn(fsPromises, "realpath").mockResolvedValueOnce(f.cache).mockResolvedValueOnce(f.human).mockRejectedValueOnce(error);
  await expect(f.prepare()).rejects.toBe(error);
  expect(paths).toHaveBeenLastCalledWith(unrelated);
  expect(f.preparer.prepare).not.toHaveBeenCalled();
});
