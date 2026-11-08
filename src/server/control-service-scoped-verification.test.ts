import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSnapshot, TestSourceObservation, Worktree } from "@/shared/contracts";
import { runtimeActions, type RuntimeAction } from "@/shared/contracts/runtime-access";
import { ControlService } from "./control-service";
import type { GitWorktreeReader } from "./git-worktrees";
import { nullLogWriter } from "./log-writer";
import { IdentityService } from "./modules/identity";
import { RuntimeAccessDenied } from "./modules/runtime";
import type { ProcessManager } from "./process-manager";
import { SqliteStateStore } from "./sqlite-store";
import type { ProjectTestCommandResolver } from "./test-command";
import { TestJobManager } from "./test-job-manager";
import { OwnedProcessGroup } from "./owned-process-group";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const SENTINEL = "SECRET-LOG-COMMAND-ENV";
const modes = ["credential-revoked", "credential-expired", "delegation-revoked", "delegation-expired", "sponsor-disabled"] as const;
type Mode = typeof modes[number];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "scoped-tests-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStateStore(join(root, "state.sqlite3"));
  cleanup.push(() => store.close());
  let now = Date.now();
  const clock = () => new Date(now).toISOString();
  const identity = new IdentityService(store, clock, undefined, undefined, undefined, store);
  const owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
  const projects = [0, 1].map(index => store.addProject({ name: `P${index}`, repositoryPath: index ? join(root, "foreign") : root,
    port: 3700 + index, launchPreset: "none", executable: "", args: [] }));
  const agents = projects.map(() => identity.createAgent(owner));
  const grant = (index: number, actions: readonly RuntimeAction[] = ["tests:run"]) => {
    const current = store.getRuntimeDelegation(agents[index].id, projects[index].id);
    return identity.setRuntimeDelegation({ principalId: agents[index].id, projectId: projects[index].id, actions: [...actions], expectedRevision: current?.revision ?? 0 }, owner);
  };
  grant(0); grant(1);
  const issue = (index = 0, actions: readonly RuntimeAction[] = ["tests:run"]) => {
    const issued = identity.issueRuntimeCredential({ principalId: agents[index].id, label: "test", expiresAt: new Date(now + 60_000).toISOString(),
      projects: [{ projectId: projects[index].id, actions: [...actions] }] }, owner);
    return { actor: identity.authenticateBearer(issued.token), issued };
  };
  const { actor, issued } = issue();
  const invalidate = (mode: Mode) => {
    if (mode === "credential-revoked") identity.revokeCredential(issued.credential.id, owner);
    if (mode === "credential-expired") now += 60_001;
    if (mode === "sponsor-disabled") store.savePrincipal({ id: owner.principalId, kind: "owner", status: "revoked" }, "test");
    if (mode === "delegation-revoked") identity.revokeRuntimeDelegation({ principalId: agents[0].id, projectId: projects[0].id,
      expectedRevision: store.getRuntimeDelegation(agents[0].id, projects[0].id)!.revision }, owner);
    if (mode === "delegation-expired") {
      identity.setRuntimeDelegation({ principalId: agents[0].id, projectId: projects[0].id, actions: ["tests:run"],
        expectedRevision: store.getRuntimeDelegation(agents[0].id, projects[0].id)!.revision, expiresAt: new Date(now + 1).toISOString() }, owner);
      now += 2;
    }
  };
  const hooks: { list?: () => void | Promise<void>; observe?: () => void | Promise<void>; resolve?: () => void } = {};
  const worktree = (path = root): Worktree => ({ path, head: "a".repeat(40), shortHead: "aaaaaaa", branch: "main", detached: false,
    locked: false, prunable: false, dirty: false, statusError: SENTINEL });
  const observation = (): TestSourceObservation => ({ observedAt: clock(), head: "a".repeat(40), branch: "main", dirty: false,
    statusDigest: "empty", statusEntries: 0, complete: true, errorCode: null });
  const git = {
    list: vi.fn(async (path: string) => { await hooks.list?.(); return [worktree(path)]; }),
    observe: vi.fn(async () => { await hooks.observe?.(); return observation(); }),
  };
  const marker = join(root, "spawned");
  const preset = { id: "node:test", name: "test", adapter: "node" as const, timeoutMs: 5000 };
  let delay = 0;
  const command = () => ({ preset, executable: process.execPath, cwd: root,
    args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'started'); console.log('${SENTINEL}'); setTimeout(()=>{},${delay})`] });
  const resolver = { discover: vi.fn(() => [preset]), resolve: vi.fn(() => { hooks.resolve?.(); return command(); }) };
  const snapshot: RuntimeSnapshot = { phase: "stopped", pid: null, worktreePath: null, startedAt: null,
    logs: [SENTINEL], error: SENTINEL, failure: null,
    resources: { status: "idle", currentRssBytes: null, peakRssBytes: null, cpuPercent: null, processCount: null,
      sampledAt: null, sampleAgeSeconds: null, warningThresholdBytes: null, history: [] } };
  const processes = { snapshot: vi.fn(() => snapshot), statusSummary: vi.fn(() => ({ phase: "stopped", worktreePath: null,
    startedAt: null, ownsProcess: false, failureCode: null })), start: vi.fn(), stop: vi.fn() };
  const manager = new TestJobManager(store, nullLogWriter);
  cleanup.push(() => manager.shutdown());
  const service = new ControlService(store, git as unknown as GitWorktreeReader, processes as unknown as ProcessManager,
    undefined, undefined, undefined, undefined, resolver as unknown as ProjectTestCommandResolver,
    manager, undefined, undefined, undefined, identity);
  cleanup.push(() => service.cancelStatusWaits(session.owner));
  const session = { owner: "agent:mcp:tests", claimToken: vi.fn(() => "lease-secret") };
  const input = { projectId: projects[0].id, worktreePath: root, presetId: "node:test", idempotencyKey: "enqueue" };
  const enqueue = (value: unknown = input, subject = actor) => service.enqueueScopedTest(subject, session, value);
  const terminal = async (id: string) => { await vi.waitFor(() => expect(store.getTestRun(id)?.telemetry?.finalizedAt).toBeTruthy()); return store.getTestRun(id)!; };
  const block = async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const run = manager.enqueue({ projectId: projects[0].id, worktree: worktree(join(root, "blocking")), command: command(),
      environment: { environment: {}, mode: "clean", profile: "unit", inheritedServerProfile: null, variableNames: [] }, actor: "local-user",
      sourceObservation: observation(), observe: async () => { await barrier; return observation(); } });
    cleanup.push(release);
    await vi.waitFor(() => expect(manager.status().running).toBe(1));
    return { release, run };
  };
  return { root, store, identity, owner, projects, agents, grant, issue, actor, issued, invalidate, hooks, git, resolver, manager,
    service, session, input, enqueue, terminal, block, processes, marker, setDelay: (value: number) => { delay = value; }, exists: () => existsSync(marker) };
}

function safe(value: unknown) {
  const output = JSON.stringify(value);
  expect(output).not.toMatch(/SECRET|agent:mcp:|queuePosition|capacity|environment|variableNames|logs|executable|args|profile|credentialId|principalId|sessionOwner|leaseToken/);
}

describe("scoped finite verification", () => {
  it("discovers only exact project presets and isolates two principals, two credentials, projects and legacy runs", async () => {
    const f = fixture();
    const discovery = await f.service.scopedTestPresets(f.actor, { projectId: f.projects[0].id });
    expect(discovery).toEqual([{ worktreePath: f.root, presets: [{ id: "node:test", timeoutMs: 5000 }] }]); safe(discovery);
    const queued = await f.enqueue(); safe(queued);
    const completed = await f.terminal(queued.runId);
    expect(completed.source).toMatchObject({ processOutcome: "passed", attribution: "observed_match" });
    const status = f.service.scopedTestRun(f.actor, f.session, { runId: queued.runId }); safe(status);
    const reconnect = { owner: "agent:mcp:reconnected" };
    expect(f.service.scopedTestRun(f.actor, reconnect, { runId: queued.runId }).status).toEqual(status.status);
    expect(f.service.scopedTestRun(f.actor, reconnect, { runId: queued.runId }).cursor).not.toBe(status.cursor);
    const foreign = f.issue(1).actor;
    const replacement = f.issue().actor;
    for (const subject of [foreign, replacement]) {
      for (const runId of [queued.runId, randomUUID()]) expect(() => f.service.scopedTestRun(subject, f.session, { runId })).toThrow(RuntimeAccessDenied);
      await expect(f.service.cancelScopedTest(subject, f.session, { runId: queued.runId })).rejects.toThrow(RuntimeAccessDenied);
      await expect(f.enqueue(f.input, subject)).rejects.toThrow(RuntimeAccessDenied);
    }
    await expect(f.service.cancelScopedTest(f.actor, reconnect, { runId: queued.runId })).rejects.toThrow(RuntimeAccessDenied);
    for (const projectId of [f.projects[1].id, randomUUID()]) {
      await expect(f.service.scopedTestPresets(f.actor, { projectId })).rejects.toThrow(RuntimeAccessDenied);
      expect(() => f.service.scopedTestRun(f.actor, f.session, { runId: queued.runId, projectId })).toThrow(RuntimeAccessDenied);
    }
    const blocker = await f.block();
    expect(() => f.service.scopedTestRun(f.actor, f.session, { runId: blocker.run.id })).toThrow(RuntimeAccessDenied);
    blocker.release();
    expect(f.processes.start).not.toHaveBeenCalled(); expect(f.processes.stop).not.toHaveBeenCalled();
  });

  it("has no action implication and never widens an old ceiling when the delegation gains tests:run", async () => {
    const f = fixture();
    f.grant(0, runtimeActions);
    for (const action of runtimeActions.filter(action => action !== "tests:run")) {
      const narrow = f.issue(0, [action]).actor;
      await expect(f.enqueue(f.input, narrow)).rejects.toThrow(RuntimeAccessDenied);
    }
    for (const action of runtimeActions.filter(action => action !== "tests:run")) expect(() => f.identity.authorizeRuntime(f.actor, f.projects[0].id, action)).toThrow();
    expect(() => f.identity.issueRuntimeCredential({ principalId: f.agents[0].id, label: "elevate", projects: [{ projectId: f.projects[0].id, actions: ["tests:run"] }] }, f.actor)).toThrow();
    expect(() => f.identity.rotateRuntimeCredential({ credentialId: f.issued.credential.id, projects: [{ projectId: f.projects[0].id, actions: runtimeActions }] }, f.owner)).toThrow();
  });

  it.each(["actor", "requester", "principalId", "credentialId", "environment", "command", "profile", "args", "leaseToken"])("rejects injected %s in the shared application", async field => {
    const f = fixture();
    await expect(f.enqueue({ ...f.input, [field]: SENTINEL })).rejects.toThrow(/Invalid or unsupported/);
    expect(f.store.listTestRuns()).toEqual([]);
  });

  it("rejects undiscovered paths/presets and inherited-server environments without executing", async () => {
    const f = fixture();
    await expect(f.enqueue({ ...f.input, worktreePath: "/foreign" })).rejects.toThrow();
    await expect(f.enqueue({ ...f.input, presetId: "node:arbitrary" })).rejects.toThrow(/could not be queued/);
    f.store.saveProjectTestEnvironmentProfile(f.projects[0].id, { name: "inherited", policy: { mode: "inherit-server-profile", serverProfile: "default" }, environment: {}, nodeEnv: null, requiredVariables: [] }, "test");
    f.store.assignProjectTestPresetProfile(f.projects[0].id, "node:test", "inherited", "test");
    await expect(f.enqueue()).rejects.toThrow(/separate environment authority/);
    expect(f.exists()).toBe(false); expect(f.store.listTestRuns()).toEqual([]);
  });

  for (const stage of ["enqueue", "discovery", "resolution", "source", "dispatch", "pre-spawn", "retained-retry", "status", "wait"] as const) {
    it.each(modes)(`denies %s at ${stage}`, async mode => {
      const f = fixture();
      if (stage === "enqueue") f.invalidate(mode);
      if (stage === "discovery") f.hooks.list = () => f.invalidate(mode);
      if (stage === "resolution") f.hooks.resolve = () => f.invalidate(mode);
      if (stage === "source") f.hooks.observe = () => f.invalidate(mode);
      if (["enqueue", "discovery", "resolution", "source"].includes(stage)) {
        await expect(f.enqueue()).rejects.toThrow(); expect(f.exists()).toBe(false); expect(f.store.listTestRuns()).toHaveLength(0); return;
      }
      const blocker = stage === "dispatch" ? await f.block() : null;
      if (stage === "pre-spawn") {
        let observations = 0;
        f.hooks.observe = () => { if (++observations === 2) f.invalidate(mode); };
      }
      const run = await f.enqueue();
      if (stage === "dispatch") { f.invalidate(mode); blocker!.release(); }
      if (stage === "dispatch" || stage === "pre-spawn") {
        const ended = await f.terminal(run.runId);
        expect(ended.startedAt).toBeNull(); expect(ended.source.processOutcome).toBeNull();
        expect(ended.telemetry?.termination).toBe("rejected"); return;
      }
      await f.terminal(run.runId);
      if (stage === "wait") {
        const current = f.service.scopedTestRun(f.actor, f.session, { runId: run.runId });
        const waiting = f.service.waitForScopedTestChange(f.actor, f.session, { runId: run.runId, cursor: current.cursor, timeoutMs: 25 });
        const rejected = expect(waiting).rejects.toThrow(RuntimeAccessDenied);
        await vi.waitFor(() => expect(f.service.statusWaitDiagnostics().waiters).toBe(1));
        f.invalidate(mode); await rejected;
        expect(f.service.statusWaitDiagnostics().waiters).toBe(0); return;
      }
      f.invalidate(mode);
      if (stage === "retained-retry") await expect(f.enqueue()).rejects.toThrow(RuntimeAccessDenied);
      else expect(() => f.service.scopedTestRun(f.actor, f.session, { runId: run.runId })).toThrow(RuntimeAccessDenied);
      expect(f.store.listTestRuns()).toHaveLength(1);
    });
  }

  it("rechecks sampled run status after real SQLite provider admission and queued revocation", async () => {
    const f = fixture(); const run = await f.enqueue(); await f.terminal(run.runId);
    f.store.requireAdmission();
    const current = await f.store.admission.run(() => f.service.scopedTestRun(f.actor, f.session, { runId: run.runId }));
    const waiting = f.store.admission.run(() => f.service.waitForScopedTestChange(f.actor, f.session, { runId: run.runId, cursor: current.cursor, timeoutMs: 5000 }));
    const rejected = expect(waiting).rejects.toThrow(RuntimeAccessDenied);
    await vi.waitFor(() => expect(f.service.statusWaitDiagnostics().waiters).toBe(1));
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let borrowed: Promise<unknown> | undefined, revoked: Promise<unknown> | undefined;
    const read = f.store.getTestRunStatus.bind(f.store);
    vi.spyOn(f.store, "getTestRunStatus").mockImplementationOnce(id => {
      borrowed = f.store.admission.outside(() => f.store.authenticationProviderStorage().borrow(async () => { entered(); await barrier; }));
      revoked = f.store.admission.detached(() => f.invalidate("credential-revoked"));
      return { ...read(id)!, exitCode: 42 };
    });
    try {
      await started; expect(f.store.admissionSnapshot().providerActive).toBe(true);
      expect(f.store.admissionSnapshot().queuedCore).toBeGreaterThanOrEqual(1);
      release(); await borrowed; await revoked; await rejected;
      expect(f.service.statusWaitDiagnostics().waiters).toBe(0);
    } finally { release(); await borrowed; await revoked; }
  });

  it("uses shared wait limits, abort/session cleanup and credential/session/target-local cursors", async () => {
    const f = fixture(); const run = await f.enqueue(); await f.terminal(run.runId);
    const current = f.service.scopedTestRun(f.actor, f.session, { runId: run.runId });
    const waits = Array.from({ length: 4 }, () => f.service.waitForScopedTestChange(f.actor, f.session, { runId: run.runId, cursor: current.cursor, timeoutMs: 5000 }));
    const stopped = waits.map(wait => expect(wait).rejects.toThrow(/CANCELLED/));
    await vi.waitFor(() => expect(f.service.statusWaitDiagnostics().waiters).toBe(4));
    expect(await f.service.waitForScopedTestChange(f.actor, f.session, { runId: run.runId, cursor: current.cursor })).toMatchObject({ errorCode: "status_wait_busy" });
    f.service.cancelStatusWaits(f.session.owner); await Promise.all(stopped);
    expect(f.service.statusWaitDiagnostics().waiters).toBe(0);
    const controller = new AbortController();
    const aborted = f.service.waitForScopedTestChange(f.actor, f.session, { runId: run.runId, cursor: current.cursor }, controller.signal);
    const denial = expect(aborted).rejects.toThrow(/CANCELLED/); controller.abort(); await denial;
    const other = await f.enqueue({ ...f.input, idempotencyKey: "other" }); await f.terminal(other.runId);
    const crossed = await f.service.waitForScopedTestChange(f.actor, f.session, { runId: other.runId, cursor: current.cursor });
    expect(crossed.changed).toBe(true); safe(crossed);
    expect(f.service.statusWaitDiagnostics()).toMatchObject({ waiters: 0, targets: 0, samplerTimers: 0 });
  });

  it("retains session-only idempotency and truthful cancellation until owned process cleanup", async () => {
    const f = fixture(); f.setDelay(10_000);
    const run = await f.enqueue();
    await vi.waitFor(() => expect(f.exists()).toBe(true));
    expect(readFileSync(f.marker, "utf8")).toBe("started");
    expect((await f.enqueue()).runId).toBe(run.runId);
    await expect(f.enqueue({ ...f.input, presetId: "node:build" })).rejects.toThrow();
    const original = OwnedProcessGroup.prototype.stop;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(OwnedProcessGroup.prototype, "stop").mockImplementation(async function (this: OwnedProcessGroup) { await barrier; return original.call(this); });
    try {
      const receipt = await f.service.cancelScopedTest(f.actor, f.session, { runId: run.runId }); safe(receipt);
      expect(receipt.status.phase).toBe("running");
      expect(f.store.getTestRun(run.runId)?.telemetry?.cleanup).toBe("pending");
    } finally { release(); }
    const final = await f.terminal(run.runId);
    expect(final.phase).toBe("cancelled"); expect(final.telemetry?.cleanup).toBe("confirmed");
  });

  it("revalidates reservation binding at enqueue, retained retry and dispatch without claim side effects", async () => {
    const f = fixture();
    f.store.acquireReservation({ projectId: f.projects[0].id, worktreePath: f.root, kind: "human", owner: "other", reason: SENTINEL });
    await expect(f.enqueue()).rejects.toThrow(/reservation/);
    f.store.releaseReservation(f.projects[0].id, "local-user", true);
    f.grant(0, ["tests:run", "claims:manage"]);
    const claimedActor = f.issue(0, ["tests:run", "claims:manage"]).actor;
    // Verification-only projects cannot claim a server; use the established lease adapter to exercise the existing policy.
    const { leaseTokenHash } = await import("./modules/lifecycle");
    const reservation = f.store.acquireReservation({ projectId: f.projects[0].id, worktreePath: f.root, kind: "agent", owner: f.session.owner,
      ttlSeconds: 120, maximumLifetimeSeconds: 1800, leaseTokenHash: leaseTokenHash("lease-secret"), idempotencyKey: "claim",
      binding: { principalId: claimedActor.principalId, credentialId: claimedActor.credentialId! } });
    await expect(f.enqueue(f.input, claimedActor)).rejects.toThrow(/reservation/);
    const blocker = await f.block();
    const run = await f.enqueue({ ...f.input, reservationId: reservation.id }, claimedActor);
    f.store.releaseAgentReservation(f.projects[0].id, reservation.id, f.session.owner, leaseTokenHash("lease-secret"),
      { principalId: claimedActor.principalId, credentialId: claimedActor.credentialId! });
    await expect(f.enqueue({ ...f.input, reservationId: reservation.id }, claimedActor)).rejects.toThrow(/reservation/);
    blocker.release();
    expect((await f.terminal(run.runId)).startedAt).toBeNull();
  });
});
