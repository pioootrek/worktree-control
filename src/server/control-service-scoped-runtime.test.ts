import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSnapshot, Worktree } from "@/shared/contracts";
import { ControlService } from "./control-service";
import type { GitWorktreeReader } from "./git-worktrees";
import type { LaunchCommandResolver } from "./launch-command";
import { IdentityService, type AuthenticatedPrincipal } from "./modules/identity";
import { RuntimeAccessDenied, ScopedRuntimeError } from "./modules/runtime";
import type { ProcessManager } from "./process-manager";
import { SqliteStateStore } from "./sqlite-store";

// Real application service, SQLite and IdentityService; Git and the managed
// process are fakes whose hooks change authority at the exact await points.

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const SENTINEL = "SENTINEL-must-not-leak";
const all = ["projects:read", "claims:manage", "runtime:control"] as const;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "worktree-control-scoped-runtime-"));
  directories.push(directory);
  const store = new SqliteStateStore(join(directory, "state.sqlite3"));
  const identity = new IdentityService(store, undefined, undefined, undefined, undefined, store);
  const owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
  const project = store.addProject({ name: "Web", repositoryPath: "/code/web", port: 3610, executable: "pnpm", args: ["run", "dev"] });
  const foreign = store.addProject({ name: `Foreign-${SENTINEL}`, repositoryPath: "/code/foreign", port: 3611, executable: "pnpm", args: ["run", "dev"] });
  store.updateProjectEnvironment(project.id, { API_KEY: SENTINEL }, "test");
  const worktree = (path: string, branch: string): Worktree => ({ path, head: "abc", shortHead: "abc", branch, detached: false, locked: false, prunable: false, dirty: false, statusError: SENTINEL });
  const worktrees = [worktree("/code/web", "main"), worktree("/code/web-feature", "feature")];
  const runtimes = new Map<string, RuntimeSnapshot>();
  const runtime = (id: string) => {
    if (!runtimes.has(id)) runtimes.set(id, {
      phase: "stopped", pid: null, worktreePath: null, startedAt: null, error: SENTINEL, failure: null, logs: [`token=${SENTINEL}`],
      resources: { status: "idle", currentRssBytes: null, peakRssBytes: null, cpuPercent: null, processCount: null, sampledAt: null, sampleAgeSeconds: null, warningThresholdBytes: null, history: [] },
    });
    return runtimes.get(id)!;
  };
  const hooks: { beforeGitReturn?: () => void; duringStop?: () => void; beforeStartHook?: () => void; afterSpawn?: () => void } = {};
  let spawned = 0;
  let nextPid = 500;
  const list = vi.fn(async () => { hooks.beforeGitReturn?.(); return worktrees; });
  const git = { list } as unknown as GitWorktreeReader;
  const start = vi.fn(async (target: { id: string }, path: string, beforeSpawn?: () => void) => {
    hooks.beforeStartHook?.();
    beforeSpawn?.();
    spawned += 1;
    Object.assign(runtime(target.id), { phase: "running", pid: nextPid++, worktreePath: path, startedAt: new Date().toISOString() });
    hooks.afterSpawn?.();
  });
  const stop = vi.fn(async (id: string) => {
    hooks.duringStop?.();
    Object.assign(runtime(id), { phase: "stopped", pid: null, worktreePath: null, startedAt: null });
  });
  const processes = { snapshot: (id: string) => ({ ...runtime(id) }), start, stop } as unknown as ProcessManager;
  const resolve = vi.fn<LaunchCommandResolver["resolve"]>(() => ({ preset: "node", executable: "pnpm", args: ["run", "dev"], portMethod: "environment", tls: { mode: "off", keyPath: null, certPath: null, caPath: null } }));
  const service = new ControlService(store, git, processes, undefined,
    { resolve },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, identity);
  const agent = identity.createAgent(owner);
  const grant = (actions: readonly string[], projectId = project.id, expectedRevision = 0) =>
    identity.setRuntimeDelegation({ principalId: agent.id, projectId, actions: [...actions], expectedRevision }, owner);
  const credential = (actions: readonly string[]): AuthenticatedPrincipal => identity.authenticateBearer(
    identity.issueRuntimeCredential({ principalId: agent.id, label: "scoped", projects: [{ projectId: project.id, actions: [...actions] }] }, owner).token);
  const revoke = () => {
    const current = store.getRuntimeDelegation(agent.id, project.id)!;
    identity.revokeRuntimeDelegation({ principalId: agent.id, projectId: project.id, expectedRevision: current.revision }, owner);
  };
  const session = { owner: "agent:mcp:scoped-session" };
  const claim = (actor: AuthenticatedPrincipal, extra: { start?: boolean; worktreePath?: string; idempotencyKey?: string; ttlSeconds?: number } = {}) => service.claimScopedProject(actor, session, {
    projectId: project.id, worktreePath: extra.worktreePath ?? "/code/web", reason: "scoped test", idempotencyKey: extra.idempotencyKey ?? "claim", start: extra.start, ttlSeconds: extra.ttlSeconds,
  });
  return { store, identity, owner, project, foreign, service, git, list, start, stop, resolve, hooks, runtime, grant, credential, revoke, session, claim, agent, spawned: () => spawned };
}

describe("scoped agent runtime", () => {
  it("returns allowlisted views and denies foreign and missing projects identically before discovery", async () => {
    const f = fixture();
    f.grant(all);
    const actor = f.credential(all);
    f.store.acquireReservation({ projectId: f.foreign.id, worktreePath: "/code/foreign", kind: "human", owner: `owner-${SENTINEL}`, reason: `reason-${SENTINEL}` });
    const listed = f.service.scopedProjects(actor, f.session);
    expect(listed).toEqual([{ id: f.project.id, name: "Web", port: 3610, actions: [...all], phase: "stopped", worktreePath: null, claim: "none" }]);
    const status = f.service.scopedProjectStatus(actor, f.session, f.project.id);
    const trees = await f.service.scopedWorktrees(actor, f.project.id);
    expect(trees[0]).toEqual({ path: "/code/web", branch: "main", head: "abc", shortHead: "abc", detached: false, locked: false, prunable: false, dirty: false });
    const claimed = await f.claim(actor, { start: true });
    expect(claimed.result).toMatchObject({ startRequested: true, error: null, leaseHeld: true, status: { phase: "running", claim: "own", ownClaim: { reservationId: claimed.result.reservationId } } });
    for (const view of [listed, status, trees, claimed.result]) {
      const text = JSON.stringify(view);
      for (const forbidden of [SENTINEL, "API_KEY", "pnpm", "run\",\"dev", "tls", "logs", "capacity", "environment", "agent:mcp:", claimed.leaseToken]) {
        expect(text).not.toContain(forbidden);
      }
    }
    f.list.mockClear();
    const denials = [];
    for (const projectId of [f.foreign.id, "00000000-0000-4000-8000-00000000dead"]) {
      for (const call of <Array<() => unknown>>[
        () => f.service.scopedProjectStatus(actor, f.session, projectId),
        () => f.service.scopedWorktrees(actor, projectId),
        () => f.service.claimScopedProject(actor, f.session, { projectId, worktreePath: "/code/foreign", reason: "x", idempotencyKey: "x" }),
      ]) {
        const error = await Promise.resolve().then(call).then(() => null, (failure: unknown) => failure);
        expect(error).toBeInstanceOf(RuntimeAccessDenied);
        denials.push((error as Error).message);
      }
    }
    expect(new Set(denials).size).toBe(1);
    expect(denials[0]).not.toContain(SENTINEL);
    expect(f.list).not.toHaveBeenCalled();
    f.store.close();
  });

  it("never infers execution from a claim and reports foreign conflicts and capacity without foreign details", async () => {
    const f = fixture();
    f.grant(all);
    const claimOnly = f.credential(["projects:read", "claims:manage"]);
    await expect(f.claim(claimOnly, { start: true })).rejects.toBeInstanceOf(RuntimeAccessDenied);
    expect(f.list).not.toHaveBeenCalled();
    expect(f.store.getActiveReservation(f.project.id)).toBeNull();
    const held = await f.claim(claimOnly);
    expect(held.result).toMatchObject({ startRequested: false, error: null, status: { phase: "stopped", claim: "own" } });
    expect(f.start).not.toHaveBeenCalled();
    await expect(f.service.operateScopedRuntime(claimOnly, f.session, held.leaseToken, f.project.id, held.result.reservationId, "start"))
      .rejects.toBeInstanceOf(RuntimeAccessDenied);
    await f.service.releaseScopedClaim(claimOnly, f.session, f.project.id, held.result.reservationId, held.leaseToken);

    const full = f.credential(all);
    f.store.acquireReservation({ projectId: f.project.id, worktreePath: "/code/web", kind: "human", owner: `owner-${SENTINEL}`, reason: SENTINEL });
    const conflict = await f.claim(full, { idempotencyKey: "second" }).catch((error: unknown) => error);
    expect(conflict).toMatchObject({ code: "claim_conflict" });
    expect(String((conflict as Error).message)).not.toContain(SENTINEL);
    f.store.releaseReservation(f.project.id, "local-user", true);
    f.store.setServerCapacitySettings({ enabled: true, limit: 1 });
    Object.assign(f.runtime(f.foreign.id), { phase: "running", pid: 1, worktreePath: "/code/foreign" });
    const exhausted = await f.claim(full, { start: true, idempotencyKey: "third" });
    expect(exhausted.result.error).toEqual({ code: "capacity_exhausted", message: "Managed server capacity is exhausted." });
    expect(JSON.stringify(exhausted.result)).not.toContain(SENTINEL);
    f.store.close();
  });

  it("rechecks authority after async Git and after an awaited stop, leaving the lease to its TTL", async () => {
    const f = fixture();
    f.grant(all);
    const actor = f.credential(all);
    f.hooks.beforeGitReturn = () => { f.hooks.beforeGitReturn = undefined; f.revoke(); };
    await expect(f.claim(actor, { start: true })).rejects.toBeInstanceOf(RuntimeAccessDenied);
    expect(f.store.getActiveReservation(f.project.id)).toBeNull();

    f.grant(all, f.project.id, 2);
    Object.assign(f.runtime(f.project.id), { phase: "running", pid: 42, worktreePath: "/code/web" });
    f.hooks.duringStop = () => { f.hooks.duringStop = undefined; f.revoke(); };
    await expect(f.claim(actor, { start: true, worktreePath: "/code/web-feature", idempotencyKey: "move" })).rejects.toBeInstanceOf(RuntimeAccessDenied);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
    const lease = f.store.getActiveReservation(f.project.id)!;
    expect(lease).toMatchObject({ worktreePath: "/code/web-feature", kind: "agent" });
    expect(Date.parse(lease.expiresAt!)).toBeGreaterThan(Date.now());
    f.store.close();
  });

  it("rechecks claimed operations before stop, after stop and immediately before spawn, without a failed receipt", async () => {
    const f = fixture();
    f.grant(all);
    const actor = f.credential(all);
    const { result, leaseToken } = await f.claim(actor, { start: true });
    expect(f.spawned()).toBe(1);
    const operate = (action: "start" | "restart" | "stop", key?: string) =>
      f.service.operateScopedRuntime(actor, f.session, leaseToken, f.project.id, result.reservationId, action, undefined, () => key === "closed");
    const restarted = await operate("restart");
    expect(restarted).toMatchObject({ outcome: "completed", leaseHeld: true, runtime: { phase: "running" } });
    expect(Object.keys(restarted).sort()).toEqual(["action", "claimedWorktreePath", "error", "leaseHeld", "observedAt", "operationId", "outcome", "port", "projectId", "replayed", "reservationId", "runtime", "schemaVersion"]);

    f.hooks.duringStop = () => { f.hooks.duringStop = undefined; f.revoke(); };
    await expect(operate("restart")).rejects.toBeInstanceOf(RuntimeAccessDenied);
    expect(f.spawned()).toBe(2);
    const events = (f.store as unknown as { database: { prepare(sql: string): { all(...args: unknown[]): Array<{ event_type: string }> } } })
      .database.prepare("SELECT event_type FROM audit_events WHERE project_id = ? ORDER BY id").all(f.project.id).map(row => row.event_type);
    expect(events).toContain("agent.runtime_denied");
    expect(events.filter(event => event === "agent.runtime_failed")).toEqual([]);

    f.grant(all, f.project.id, 2);
    f.hooks.beforeStartHook = () => { f.hooks.beforeStartHook = undefined; f.revoke(); };
    await expect(operate("start")).rejects.toBeInstanceOf(RuntimeAccessDenied);
    expect(f.spawned()).toBe(2);
    expect(f.store.getActiveReservation(f.project.id)?.id).toBe(result.reservationId);
    expect(() => f.service.renewScopedClaim(actor, f.session, f.project.id, result.reservationId, leaseToken)).toThrow(RuntimeAccessDenied);
    await expect(f.service.releaseScopedClaim(actor, f.session, f.project.id, result.reservationId, leaseToken)).rejects.toBeInstanceOf(RuntimeAccessDenied);
    expect(f.store.getActiveReservation(f.project.id)?.id).toBe(result.reservationId);
    f.store.close();
  });

  it("binds the durable lease to its principal and credential without adoption", async () => {
    const f = fixture();
    f.grant(all);
    const actor = f.credential(all);
    const sibling = f.credential(all);
    const { result, leaseToken } = await f.claim(actor);
    // Same session owner and lease secret, different credential: stale, not adopted.
    await expect(f.service.operateScopedRuntime(sibling, f.session, leaseToken, f.project.id, result.reservationId, "start"))
      .rejects.toMatchObject({ code: "claim_stale" });
    expect(() => f.service.renewScopedClaim(sibling, f.session, f.project.id, result.reservationId, leaseToken)).toThrow(ScopedRuntimeError);
    // The compatibility path carries no binding and cannot operate a bound lease either.
    await expect(f.service.operateClaimedRuntime(f.project.id, result.reservationId, "start", { owner: f.session.owner, leaseToken })).rejects.toThrow();
    expect(() => f.service.renewAgentClaim(f.project.id, result.reservationId, f.session.owner, leaseToken)).toThrow();
    // Idempotent retry by the same credential returns the same lease; another credential cannot replay it.
    expect((await f.service.claimScopedProject(actor, f.session, { projectId: f.project.id, worktreePath: "/code/web", reason: "scoped test", idempotencyKey: "claim" }, leaseToken)).result.reservationId)
      .toBe(result.reservationId);
    await expect(f.service.claimScopedProject(sibling, f.session, { projectId: f.project.id, worktreePath: "/code/web", reason: "again", idempotencyKey: "claim" }, leaseToken))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(f.service.renewScopedClaim(actor, f.session, f.project.id, result.reservationId, leaseToken, 600).reservationId).toBe(result.reservationId);
    await f.service.releaseScopedClaim(actor, f.session, f.project.id, result.reservationId, leaseToken);
    expect(f.store.getActiveReservation(f.project.id)).toBeNull();
    f.store.close();
  });

  it("does not rewrite unchanged launch configuration on claim starts or their retries", async () => {
    const f = fixture();
    f.grant(all);
    const actor = f.credential(all);
    const launchWrites = vi.spyOn(f.store, "updateProjectLaunch");
    const revision = f.store.getProjectConfigurationRevision(f.project.id);
    const held = await f.claim(actor, { start: true });
    expect(held.result.error).toBeNull();
    expect(launchWrites).not.toHaveBeenCalled();
    await f.service.operateScopedRuntime(actor, f.session, held.leaseToken, f.project.id, held.result.reservationId, "stop");
    await f.service.claimScopedProject(actor, f.session, {
      projectId: f.project.id, worktreePath: "/code/web", reason: "scoped test", idempotencyKey: "claim", start: true,
    }, held.leaseToken);
    expect(launchWrites).not.toHaveBeenCalled();
    expect(f.store.getProjectConfigurationRevision(f.project.id)).toBe(revision);
    f.store.close();
  });

  it("persists the placement when a reservation-only claim is started, including later ordinary starts", async () => {
    const f = fixture();
    f.grant(all);
    const actor = f.credential(all);
    f.store.setSelectedWorktree(f.project.id, "/code/web");
    const held = await f.claim(actor, { worktreePath: "/code/web-feature" });
    expect(f.store.getProject(f.project.id)?.selectedWorktreePath).toBe("/code/web");
    const result = await f.service.operateScopedRuntime(actor, f.session, held.leaseToken, f.project.id, held.result.reservationId, "start");
    expect(result.outcome).toBe("completed");
    expect(f.store.getProject(f.project.id)?.selectedWorktreePath).toBe("/code/web-feature");
    await f.service.operateScopedRuntime(actor, f.session, held.leaseToken, f.project.id, held.result.reservationId, "stop");
    await f.service.releaseScopedClaim(actor, f.session, f.project.id, held.result.reservationId, held.leaseToken);
    await f.service.operate(f.project.id, "start");
    expect(f.runtime(f.project.id).worktreePath).toBe("/code/web-feature");
    f.store.close();
  });

  it("keeps storage failures distinct from claim conflicts and stale claims without exposing messages", async () => {
    const f = fixture();
    f.grant(all);
    const actor = f.credential(all);
    const acquire = vi.spyOn(f.store, "acquireReservation");
    acquire.mockImplementationOnce(() => { throw new Error(`idempotency cancelled ${SENTINEL}`); });
    await expect(f.claim(actor)).rejects.toMatchObject({ code: "runtime_operation_failed", message: "The scoped runtime operation failed." });
    const held = await f.claim(actor);
    await expect(f.claim(actor, { worktreePath: "/code/web-feature", idempotencyKey: "other-path" }))
      .rejects.toMatchObject({ code: "claim_conflict", message: expect.stringContaining("Reuse or release your own claim") });
    const operate = () => f.service.operateScopedRuntime(actor, f.session, held.leaseToken, f.project.id, held.result.reservationId, "start");
    const authorize = vi.spyOn(f.store, "authorizeReservation");
    authorize.mockImplementationOnce(() => { throw new Error(`cancelled ${SENTINEL}`); });
    await expect(operate()).rejects.toMatchObject({ code: "runtime_operation_failed", message: "The scoped runtime operation failed." });
    const audit = vi.spyOn(f.store, "recordProjectEvent");
    audit.mockImplementationOnce(() => { throw new Error(SENTINEL); });
    await expect(operate()).rejects.toMatchObject({ code: "runtime_operation_failed", message: "The scoped runtime operation failed." });
    expect(f.store.getActiveReservation(f.project.id)?.id).toBe(held.result.reservationId);
    expect(f.start).not.toHaveBeenCalled();
    f.store.releaseReservation(f.project.id, "local-user", true);
    await expect(operate()).rejects.toMatchObject({ code: "claim_stale" });
    f.store.close();
  });

  it("resolves the target worktree launch command before a claim moves the runtime", async () => {
    const f = fixture();
    f.grant(all);
    const actor = f.credential(all);
    const first = await f.claim(actor, { start: true });
    await f.service.releaseScopedClaim(actor, f.session, f.project.id, first.result.reservationId, first.leaseToken);
    f.resolve.mockImplementation(path => ({
      preset: "node", executable: path === "/code/web-feature" ? "npm" : "pnpm", args: ["run", "dev", "--", "--port", "3610"],
      portMethod: "environment", tls: { mode: "off", keyPath: null, certPath: null, caPath: null },
    }));
    const launchWrites = vi.spyOn(f.store, "updateProjectLaunch");
    const moved = await f.claim(actor, { start: true, worktreePath: "/code/web-feature", idempotencyKey: "move" });
    expect(moved.result.error).toBeNull();
    expect(f.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ executable: "npm", args: ["run", "dev", "--", "--port", "3610"] }),
      "/code/web-feature", expect.any(Function),
    );
    expect(f.store.getProject(f.project.id)).toMatchObject({ executable: "npm", selectedWorktreePath: "/code/web-feature" });
    expect(launchWrites).toHaveBeenCalledWith(f.project.id, expect.objectContaining({ executable: "npm" }), expect.stringMatching(/^mcp:/));
    f.store.close();
  });

  it("binds claim retries to normalized mutation options in the shared service", async () => {
    const f = fixture();
    f.grant(all);
    const actor = f.credential(all);
    const original = { projectId: f.project.id, worktreePath: "/code/web", reason: "scoped test", idempotencyKey: "claim" };
    const held = await f.service.claimScopedProject(actor, f.session, original);
    const before = f.store.getActiveReservation(f.project.id);
    const retry = await f.service.claimScopedProject(actor, f.session, { ...original, reason: " scoped test ", start: false, ttlSeconds: 1800 }, held.leaseToken);
    expect(retry.result.reservationId).toBe(held.result.reservationId);
    for (const change of [{ ttlSeconds: 30 }, { start: true }, { reason: "different" }, { worktreePath: "/code/web-feature" }]) {
      await expect(f.service.claimScopedProject(actor, f.session, { ...original, ...change }, held.leaseToken))
        .rejects.toMatchObject({ code: "idempotency_conflict" });
    }
    expect(f.store.getActiveReservation(f.project.id)).toEqual(before);
    expect(f.start).not.toHaveBeenCalled();
    f.store.close();
  });

  it.each(["expired", "released", "revoked-control"] as const)("refuses a successful claim receipt when startup finishes with %s authority", async (change) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    f.grant(all);
    const actor = f.credential(all);
    f.hooks.afterSpawn = () => {
      if (change === "expired") vi.setSystemTime(Date.now() + 35_000);
      else if (change === "released") f.store.releaseReservation(f.project.id, "local-user", true);
      else f.grant(["projects:read", "claims:manage"], f.project.id, 1);
    };
    await expect(f.claim(actor, { start: true, ttlSeconds: 30 })).rejects.toMatchObject({
      code: change === "revoked-control" ? "project_access_denied" : "claim_stale",
    });
    expect(f.spawned()).toBe(1);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.runtime(f.project.id).phase).toBe("running");
    if (change !== "revoked-control") expect(f.store.getActiveReservation(f.project.id)).toBeNull();
    f.store.close();
  });

  it("does not spawn the compatibility claim after its lease is lost during the awaited stop", async () => {
    const f = fixture();
    Object.assign(f.runtime(f.project.id), { phase: "running", pid: 7, worktreePath: "/code/web" });
    f.hooks.duringStop = () => { f.store.releaseReservation(f.project.id, "local-user", true); };
    const claim = await f.service.claimProject({ projectId: f.project.id, worktreePath: "/code/web-feature", owner: "agent:mcp:compat", reason: "move", idempotencyKey: "compat" }, undefined, false);
    expect(claim.operationError).toMatch(/stale|expired|no longer active/);
    expect(f.start).not.toHaveBeenCalled();
    f.store.close();
  });
});
