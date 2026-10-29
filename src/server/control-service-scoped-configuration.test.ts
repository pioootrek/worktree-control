import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSnapshot, TestPreset, Worktree } from "@/shared/contracts";
import type { RuntimeAction } from "@/shared/contracts/runtime-access";
import { ControlService } from "./control-service";
import type { GitWorktreeReader } from "./git-worktrees";
import type { ScopedConfigurationSession } from "./modules/environments";
import { IdentityService, type AuthenticatedPrincipal } from "./modules/identity";
import { RuntimeAccessDenied, ScopedRuntimeError } from "./modules/runtime";
import type { ProcessManager } from "./process-manager";
import { SqliteStateStore } from "./sqlite-store";
import type { ProjectTestCommandResolver } from "./test-command";

// Real ControlService, SQLite and IdentityService; Git, preset discovery and the
// managed process are fakes whose hooks change authority at exact await points.

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const SENTINEL = "SENTINEL-config-must-not-leak";
const all: RuntimeAction[] = ["projects:read", "claims:manage", "runtime:control", "profiles:select", "config:write"];
const MISSING = "00000000-0000-4000-8000-00000000dead";

type Database = { prepare(sql: string): { all(...args: unknown[]): Array<Record<string, unknown>>; run(...args: unknown[]): unknown } };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "worktree-control-scoped-config-"));
  directories.push(directory);
  const store = new SqliteStateStore(join(directory, "state.sqlite3"));
  const database = (store as unknown as { database: Database }).database;
  const identity = new IdentityService(store, undefined, undefined, undefined, undefined, store);
  const owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
  const project = store.addProject({ name: "Web", repositoryPath: "/code/web", port: 3620, executable: "pnpm", args: ["run", "dev"] });
  const tests = store.addProject({ name: "Tests", repositoryPath: "/code/tests", port: 3621, launchPreset: "none", executable: "", args: [] });
  const foreign = store.addProject({ name: `Foreign-${SENTINEL}`, repositoryPath: "/code/foreign", port: 3622, executable: "pnpm", args: ["run", "dev"] });
  store.updateProjectEnvironment(project.id, { API_KEY: SENTINEL }, "test");
  store.saveProjectEnvironmentProfile(project.id, { name: "staging", environment: { STAGING_SECRET: SENTINEL } }, "test");
  const worktree = (path: string): Worktree => ({ path, head: "abc", shortHead: "abc", branch: "main", detached: false, locked: false, prunable: false, dirty: false, statusError: SENTINEL });
  const trees: Record<string, Worktree[]> = {
    "/code/web": [worktree("/code/web"), worktree("/code/web-feature")],
    "/code/tests": [worktree("/code/tests")],
    "/code/foreign": [worktree("/code/foreign")],
  };
  const hooks: { beforeGitReturn?: () => void | Promise<void>; gitError?: Error; discoverError?: Error } = {};
  const list = vi.fn(async (repository: string) => {
    await hooks.beforeGitReturn?.();
    if (hooks.gitError) throw hooks.gitError;
    return trees[repository] ?? [];
  });
  const presets: TestPreset[] = [
    { id: "node:test", name: "test", adapter: "node", timeoutMs: 900_000 },
    { id: "node:check", name: "check", adapter: "node", timeoutMs: 900_000 },
  ];
  const discover = vi.fn((path: string) => {
    if (hooks.discoverError) throw hooks.discoverError;
    return path === "/code/web-feature" ? presets.slice(0, 1) : presets;
  });
  const testCommands = { discover, resolve: vi.fn() } as unknown as ProjectTestCommandResolver;
  const runtime: RuntimeSnapshot & { ownsProcess: boolean } = {
    phase: "stopped", pid: null, worktreePath: null, startedAt: null, error: SENTINEL, failure: null, logs: [SENTINEL], ownsProcess: false,
    resources: { status: "idle", currentRssBytes: null, peakRssBytes: null, cpuPercent: null, processCount: null, sampledAt: null, sampleAgeSeconds: null, warningThresholdBytes: null, history: [] },
  };
  const start = vi.fn();
  const stop = vi.fn();
  const processes = {
    snapshot: (id: string) => id === project.id ? { ...runtime } : { ...runtime, phase: "stopped", pid: null },
    statusSummary: (id: string) => ({ phase: runtime.phase, worktreePath: null, startedAt: null, failureCode: null, ownsProcess: id === project.id && runtime.ownsProcess }),
    start, stop,
  } as unknown as ProcessManager;
  const service = new ControlService(store, { list } as unknown as GitWorktreeReader, processes, undefined,
    { resolve: vi.fn() }, undefined, undefined, testCommands, undefined, undefined, undefined, undefined, identity);
  const agent = identity.createAgent(owner);
  const revision = new Map<string, number>();
  const grant = (actions: readonly RuntimeAction[], projectId = project.id, expiresAt?: string) => {
    const delegation = identity.setRuntimeDelegation({
      principalId: agent.id, projectId, actions: [...actions], expectedRevision: revision.get(projectId) ?? 0, ...(expiresAt ? { expiresAt } : {}),
    }, owner);
    revision.set(projectId, delegation.revision);
  };
  const revoke = (projectId = project.id) => {
    const delegation = identity.revokeRuntimeDelegation({ principalId: agent.id, projectId, expectedRevision: revision.get(projectId)! }, owner);
    revision.set(projectId, delegation.revision);
  };
  const issue = (actions: readonly RuntimeAction[], projectIds = [project.id, tests.id]) =>
    identity.issueRuntimeCredential({ principalId: agent.id, label: "scoped", projects: projectIds.map(projectId => ({ projectId, actions: [...actions] })) }, owner);
  const credential = (actions: readonly RuntimeAction[], projectIds?: string[]): AuthenticatedPrincipal => identity.authenticateBearer(issue(actions, projectIds).token);
  // The MCP session port: it resolves only lease secrets this session tracks.
  const sessionFor = (owner: string) => {
    const tokens = new Map<string, string>();
    const session: ScopedConfigurationSession = {
      owner,
      claimToken: (projectId, reservationId) => {
        const token = tokens.get(`${projectId}:${reservationId}`);
        if (!token) throw new ScopedRuntimeError("claim_not_owned", "This MCP session does not own the requested claim.");
        return token;
      },
    };
    const claim = async (actor: AuthenticatedPrincipal, projectId = project.id, worktreePath = "/code/web", ttlSeconds?: number) => {
      const { result, leaseToken } = await service.claimScopedProject(actor, { owner }, { projectId, worktreePath, reason: "config", idempotencyKey: `claim-${tokens.size}`, ttlSeconds });
      tokens.set(`${projectId}:${result.reservationId}`, leaseToken);
      return { reservationId: result.reservationId, leaseToken };
    };
    return { session, tokens, claim };
  };
  const current = (projectId = project.id) => store.getProjectConfigurationRevision(projectId)!;
  const audits = (projectId = project.id) => database.prepare("SELECT event_type, actor, details_json FROM audit_events WHERE project_id = ? AND event_type LIKE 'configuration.%' ORDER BY id").all(projectId);
  return { store, database, identity, owner, agent, project, tests, foreign, service, list, discover, hooks, runtime, start, stop, grant, revoke, issue, credential, sessionFor, current, audits };
}

const failure = (promise: Promise<unknown> | (() => unknown)) =>
  Promise.resolve().then(typeof promise === "function" ? promise : () => promise).then(() => null, (error: unknown) => error);

function expectNoLeak(value: unknown, extra: string[] = []): void {
  const text = JSON.stringify(value) + (value instanceof Error ? value.message : "");
  for (const forbidden of [SENTINEL, "API_KEY", "STAGING_SECRET", "PREVIEW", "pnpm", "variableNames", "agent:mcp:", ...extra]) expect(text).not.toContain(forbidden);
}

describe("scoped configuration actions", () => {
  it("invalidates warm dashboard presets after scoped timeout changes but not after no-ops or refusals", async () => {
    const f = fixture();
    f.grant(all);
    const actor = f.credential(["config:write"], [f.project.id]);
    const { session } = f.sessionFor("agent:mcp:dashboard");
    const snapshot = async () => (await f.service.dashboard()).projects.find(entry => entry.project.id === f.project.id)!;
    const before = await snapshot();
    expect(before.metadata?.status).toBe("fresh");
    expect(before.testPresets[0].presets.find(preset => preset.id === "node:test")?.timeoutMs).toBe(900_000);
    const input = { projectId: f.project.id, worktreePath: "/code/web", presetId: "node:test", timeoutMs: 1000, expectedRevision: f.current(), idempotencyKey: "dashboard-timeout" };
    await expect(f.service.setScopedTestPresetTimeout(actor, session, input)).resolves.toMatchObject({ outcome: "completed" });
    const invalidated = await snapshot();
    expect(invalidated.project.testPresetTimeouts["node:test"]).toBe(1000);
    expect(invalidated.metadata?.status).toBe("stale");
    const refreshed = await f.service.refreshProjectMetadata(f.project.id);
    expect(refreshed.testPresets[0].presets.find(preset => preset.id === "node:test")?.timeoutMs).toBe(1000);
    expect(refreshed.metadata?.status).toBe("fresh");
    await expect(f.service.setScopedTestPresetTimeout(actor, session, { ...input, expectedRevision: f.current() })).resolves.toMatchObject({ outcome: "noop" });
    await expect(f.service.setScopedTestPresetTimeout(actor, session, input)).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await snapshot()).metadata?.status).toBe("fresh");
    f.store.close();
  });

  it("requires each configuration action separately and never widens existing credentials", async () => {
    const f = fixture();
    const first: RuntimeAction[] = ["projects:read", "claims:manage", "runtime:control"];
    f.grant(first);
    f.grant(first, f.tests.id);
    const legacy = f.credential(first);
    f.grant(all);
    f.grant(all, f.tests.id);
    const { session } = f.sessionFor("agent:mcp:separation");
    const calls = (actor: AuthenticatedPrincipal) => ({
      list: () => f.service.scopedEnvironmentProfiles(actor, { projectId: f.project.id }),
      select: () => f.service.selectScopedEnvironmentProfile(actor, session, { projectId: f.project.id, name: "staging", expectedRevision: f.current(), idempotencyKey: "s" }),
      read: () => f.service.scopedProjectConfiguration(actor, { projectId: f.tests.id, worktreePath: "/code/tests" }),
      write: () => f.service.setScopedTestPresetTimeout(actor, session, { projectId: f.tests.id, worktreePath: "/code/tests", presetId: "node:test", timeoutMs: 60_000, expectedRevision: f.current(f.tests.id), idempotencyKey: "t" }),
    });
    // A credential issued before the widened delegation keeps its immutable ceiling.
    for (const call of Object.values(calls(legacy))) expect(await failure(call)).toBeInstanceOf(RuntimeAccessDenied);
    expect(f.identity.runtimeAccessFor(legacy).map(entry => entry.actions)).toEqual([["projects:read", "claims:manage", "runtime:control"], ["projects:read", "claims:manage", "runtime:control"]]);

    const select = calls(f.credential(["profiles:select"]));
    expect(await failure(select.read)).toBeInstanceOf(RuntimeAccessDenied);
    expect(await failure(select.write)).toBeInstanceOf(RuntimeAccessDenied);
    expect(f.service.scopedProjects(f.credential(["profiles:select"]), { owner: "agent:mcp:x" })).toEqual([]);
    expect(select.list()).toMatchObject({ selectedProfile: "default" });
    await expect(select.select()).resolves.toMatchObject({ outcome: "completed", selectedProfile: "staging" });

    const config = calls(f.credential(["config:write"]));
    expect(await failure(config.list)).toBeInstanceOf(RuntimeAccessDenied);
    expect(await failure(config.select)).toBeInstanceOf(RuntimeAccessDenied);
    await expect(config.read()).resolves.toMatchObject({ projectId: f.tests.id });
    await expect(config.write()).resolves.toMatchObject({ outcome: "completed", presetId: "node:test", timeoutMs: 60_000 });

    // Ceiling holds config:write but the current delegation no longer does.
    f.grant(["projects:read", "profiles:select"], f.tests.id);
    expect(await failure(config.read)).toBeInstanceOf(RuntimeAccessDenied);
    f.store.close();
  });

  it("lists literal profile names only and denies foreign and missing projects identically before discovery", async () => {
    const f = fixture();
    f.grant(all);
    const actor = f.credential(all, [f.project.id]);
    const { session } = f.sessionFor("agent:mcp:views");
    const listed = f.service.scopedEnvironmentProfiles(actor, { projectId: f.project.id });
    expect(listed).toEqual({ schemaVersion: 1, projectId: f.project.id, configurationRevision: f.current(), selectedProfile: "default", profiles: [{ name: "default" }, { name: "staging" }] });
    const configuration = await f.service.scopedProjectConfiguration(actor, { projectId: f.project.id, worktreePath: "/code/web" });
    expect(configuration).toEqual({ schemaVersion: 1, projectId: f.project.id, configurationRevision: f.current(), presets: [
      { id: "node:test", timeoutMs: 900_000, overrideTimeoutMs: null }, { id: "node:check", timeoutMs: 900_000, overrideTimeoutMs: null },
    ] });
    for (const view of [listed, configuration]) expectNoLeak(view, ["statusError", "tls", "args"]);

    f.list.mockClear();
    f.discover.mockClear();
    const messages = new Set<string>();
    for (const projectId of [f.foreign.id, MISSING]) {
      for (const call of [
        () => f.service.scopedEnvironmentProfiles(actor, { projectId }),
        () => f.service.selectScopedEnvironmentProfile(actor, session, { projectId, name: "default", expectedRevision: 0, idempotencyKey: "x" }),
        () => f.service.scopedProjectConfiguration(actor, { projectId, worktreePath: "/code/foreign" }),
        () => f.service.setScopedTestPresetTimeout(actor, session, { projectId, worktreePath: "/code/foreign", presetId: "node:test", timeoutMs: 1, expectedRevision: 0, idempotencyKey: "x" }),
      ]) {
        const error = await failure(call);
        expect(error).toBeInstanceOf(RuntimeAccessDenied);
        messages.add((error as Error).message);
      }
    }
    expect(messages.size).toBe(1);
    expectNoLeak([...messages]);
    expect(f.list).not.toHaveBeenCalled();
    expect(f.discover).not.toHaveBeenCalled();
    f.store.close();
  });
});

describe("scoped profile selection", () => {
  it("selects only existing profiles while nothing owned runs, with CAS, attributable audit and no restart", async () => {
    const f = fixture();
    f.grant(all);
    const actor = f.credential(["profiles:select"], [f.project.id]);
    const { session } = f.sessionFor("agent:mcp:select");
    const select = (name: string, expectedRevision = f.current(), extra: Record<string, unknown> = {}) =>
      f.service.selectScopedEnvironmentProfile(actor, session, { projectId: f.project.id, name, expectedRevision, idempotencyKey: "k", ...extra });

    for (const injected of [{ restart: true }, { environment: { X: "1" } }, { create: true }, { serverProfile: "default" }, { vault: "dev" }]) {
      expect(await failure(select("staging", f.current(), injected))).toMatchObject({ code: "invalid_request" });
    }
    for (const name of [" staging", "staging ", "new profile", "", "x".repeat(41)]) {
      expect(await failure(select(name))).toMatchObject({ code: "invalid_request" });
    }
    const before = f.current();
    expect(await failure(select("created-by-agent"))).toMatchObject({ code: "profile_not_found" });
    expect(f.store.getProject(f.project.id)!.environmentProfiles.map(({ name }) => name)).toEqual(["default", "staging"]);
    expect(await failure(select("staging", before - 1))).toMatchObject({ code: "revision_conflict" });

    // Running, or a failed process whose cleanup still owns its group, blocks a change.
    Object.assign(f.runtime, { phase: "running", pid: 41 });
    expect(await failure(select("staging"))).toMatchObject({ code: "runtime_active" });
    // An authorized unchanged selection is a no-op even while running.
    await expect(select("default")).resolves.toMatchObject({ outcome: "noop", configurationRevision: before, selectedProfile: "default" });
    Object.assign(f.runtime, { phase: "failed", pid: 41, ownsProcess: true });
    expect(await failure(select("staging"))).toMatchObject({ code: "runtime_active" });
    Object.assign(f.runtime, { phase: "failed", pid: null, ownsProcess: true });
    expect(await failure(select("staging"))).toMatchObject({ code: "runtime_active" });
    Object.assign(f.runtime, { phase: "stopped", pid: null, ownsProcess: false });
    expect(f.current()).toBe(before);
    expect(f.audits()).toEqual([]);

    const receipt = await select("staging");
    expect(Object.keys(receipt).sort()).toEqual(["configurationRevision", "observedAt", "operation", "operationId", "outcome", "projectId", "replayed", "schemaVersion", "selectedProfile"]);
    expect(receipt).toMatchObject({ schemaVersion: 1, operation: "select_environment_profile", outcome: "completed", configurationRevision: before + 1, replayed: false, selectedProfile: "staging" });
    expect(f.store.getProject(f.project.id)).toMatchObject({ selectedEnvironmentProfile: "staging", environment: { STAGING_SECRET: SENTINEL } });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
    const audit = f.audits();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ event_type: "configuration.environment_profile_selected", actor: `principal:${f.agent.id}` });
    expect(JSON.parse(String(audit[0]!.details_json))).toEqual({
      principalId: f.agent.id, credentialId: actor.credentialId, operationId: receipt.operationId, reservationId: null,
      previousRevision: before, revision: before + 1, outcome: "completed", selectedProfile: "staging",
    });
    // A no-op validates the revision but writes neither state nor audit.
    await expect(select("staging")).resolves.toMatchObject({ outcome: "noop", configurationRevision: before + 1 });
    expect(await failure(select("staging", before))).toMatchObject({ code: "revision_conflict" });
    expect(f.audits()).toHaveLength(1);
    expectNoLeak([receipt, audit]);
    f.store.close();
  });

  it("is invalidated by every compatibility configuration write", async () => {
    const f = fixture();
    f.grant(all);
    const actor = f.credential(all, [f.project.id]);
    const { session } = f.sessionFor("agent:mcp:compat");
    const writes: Array<() => unknown> = [
      () => f.service.saveEnvironmentProfile(f.project.id, "preview", { PREVIEW: "1" }),
      () => f.service.deleteEnvironmentProfile(f.project.id, "preview"),
      () => f.service.setProjectEnvironment(f.project.id, { API_KEY: SENTINEL }),
      () => f.service.selectEnvironmentProfile(f.project.id, "staging"),
      () => f.service.setTestPresetTimeout(f.project.id, "node:test", 1000),
      () => f.service.saveTestEnvironmentProfile(f.project.id, { name: "itest", environment: {} }),
      () => f.service.assignTestPresetProfile(f.project.id, "node:test", "itest"),
      () => f.store.updateProjectLaunch(f.project.id, { tlsMode: "off", tlsKeyPath: null, tlsCertPath: null, tlsCaPath: null, executable: "pnpm", args: ["run", "dev"] }),
    ];
    for (const write of writes) {
      const observed = f.service.scopedEnvironmentProfiles(actor, { projectId: f.project.id }).configurationRevision;
      await write();
      expect(f.current()).toBe(observed + 1);
      expect(await failure(f.service.selectScopedEnvironmentProfile(actor, session, { projectId: f.project.id, name: "default", expectedRevision: observed, idempotencyKey: "stale" })))
        .toMatchObject({ code: "revision_conflict" });
      expect(await failure(f.service.setScopedTestPresetTimeout(actor, session, { projectId: f.project.id, worktreePath: "/code/web", presetId: "node:check", timeoutMs: 5, expectedRevision: observed, idempotencyKey: "stale" })))
        .toMatchObject({ code: "revision_conflict" });
    }
    expect(f.store.getProject(f.project.id)!.testPresetTimeouts).toEqual({ "node:test": 1000 });
    expect(f.audits()).toEqual([]);
    f.store.close();
  });
});

describe("scoped preset timeouts", () => {
  it("sets only timeouts of presets discovered in an exact worktree on an unclaimed verification-only project", async () => {
    const f = fixture();
    f.grant(all, f.tests.id);
    const actor = f.credential(["config:write"], [f.tests.id]);
    const { session } = f.sessionFor("agent:mcp:timeouts");
    const set = (fields: Record<string, unknown>) => f.service.setScopedTestPresetTimeout(actor, session, {
      projectId: f.tests.id, worktreePath: "/code/tests", presetId: "node:test", timeoutMs: 60_000, expectedRevision: f.current(f.tests.id), idempotencyKey: "k", ...fields,
    });
    for (const injected of [{ environment: { A: "1" } }, { tlsMode: "off" }, { executable: "sh" }, { args: ["-c"] }, { role: "manager" }, { actions: ["config:write"] },
      { profile: "integration" }, { testProfile: "unit" }, { launchPreset: "node" }, { port: 1 }, { capacity: 9 }, { selectedWorktreePath: "/code/tests" }]) {
      expect(await failure(set(injected))).toMatchObject({ code: "invalid_request" });
    }
    for (const timeoutMs of [0, -1, 1.5, 86_400_001, "60000"]) expect(await failure(set({ timeoutMs }))).toMatchObject({ code: "invalid_request" });
    expect(await failure(set({ presetId: "bad id" }))).toMatchObject({ code: "invalid_request" });
    // Syntactically valid but not discovered in this worktree.
    expect(await failure(set({ presetId: "node:lint" }))).toMatchObject({ code: "preset_not_found" });
    expect(await failure(set({ worktreePath: "/code/web" }))).toMatchObject({ code: "worktree_unavailable" });
    f.hooks.gitError = new Error(`git failed in /secret/${SENTINEL}`);
    const gitFailure = await failure(set({}));
    expect(gitFailure).toMatchObject({ code: "worktree_unavailable" });
    f.hooks.gitError = undefined;
    f.hooks.discoverError = new Error(`package.json at /secret/${SENTINEL}`);
    const discoveryFailure = await failure(set({}));
    expect(discoveryFailure).toMatchObject({ code: "preset_discovery_unavailable" });
    expect(await failure(f.service.scopedProjectConfiguration(actor, { projectId: f.tests.id, worktreePath: "/code/tests" }))).toMatchObject({ code: "preset_discovery_unavailable" });
    f.hooks.discoverError = undefined;
    expectNoLeak([gitFailure, discoveryFailure, (gitFailure as Error).message, (discoveryFailure as Error).message], ["/secret"]);
    expect(f.current(f.tests.id)).toBe(0);

    const set1 = await set({});
    expect(Object.keys(set1).sort()).toEqual(["configurationRevision", "observedAt", "operation", "operationId", "outcome", "presetId", "projectId", "replayed", "schemaVersion", "timeoutMs"]);
    expect(set1).toMatchObject({ operation: "set_test_preset_timeout", outcome: "completed", configurationRevision: 1, presetId: "node:test", timeoutMs: 60_000 });
    expect(f.store.getProject(f.tests.id)!.testPresetTimeouts).toEqual({ "node:test": 60_000 });
    await expect(f.service.scopedProjectConfiguration(actor, { projectId: f.tests.id, worktreePath: "/code/tests" })).resolves.toMatchObject({
      configurationRevision: 1, presets: [{ id: "node:test", timeoutMs: 900_000, overrideTimeoutMs: 60_000 }, { id: "node:check", timeoutMs: 900_000, overrideTimeoutMs: null }],
    });
    await expect(set({})).resolves.toMatchObject({ outcome: "noop", configurationRevision: 1 });
    await expect(set({ timeoutMs: null })).resolves.toMatchObject({ outcome: "completed", configurationRevision: 2, timeoutMs: null });
    await expect(set({ timeoutMs: null })).resolves.toMatchObject({ outcome: "noop", configurationRevision: 2 });
    expect(f.store.getProject(f.tests.id)!.testPresetTimeouts).toEqual({});
    expect(f.audits(f.tests.id).map(row => JSON.parse(String(row.details_json)))).toEqual([
      expect.objectContaining({ presetId: "node:test", timeoutMs: 60_000, revision: 1, reservationId: null, credentialId: actor.credentialId }),
      expect.objectContaining({ presetId: "node:test", timeoutMs: null, revision: 2 }),
    ]);

    // The override map is bounded; replacing an existing override stays allowed.
    for (let index = 0; index < 256; index += 1) f.store.setProjectTestPresetTimeout(f.tests.id, `node:filler-${index}`, 1000, "test");
    expect(await failure(set({}))).toMatchObject({ code: "override_limit" });
    f.store.setProjectTestPresetTimeout(f.tests.id, "node:filler-0", null, "test");
    await expect(set({})).resolves.toMatchObject({ outcome: "completed" });
    f.store.close();
  });

  it("commits state, revision and audit atomically", async () => {
    const f = fixture();
    f.grant(all, f.tests.id);
    const actor = f.credential(["config:write"], [f.tests.id]);
    const { session } = f.sessionFor("agent:mcp:atomic");
    const audit = vi.spyOn(f.store as unknown as { audit: (...args: unknown[]) => void }, "audit").mockImplementationOnce(() => { throw new Error("audit failed"); });
    await expect(f.service.setScopedTestPresetTimeout(actor, session, { projectId: f.tests.id, worktreePath: "/code/tests", presetId: "node:test", timeoutMs: 5, expectedRevision: 0, idempotencyKey: "k" }))
      .rejects.toThrow("audit failed");
    audit.mockRestore();
    expect(f.current(f.tests.id)).toBe(0);
    expect(f.store.getProject(f.tests.id)!.testPresetTimeouts).toEqual({});
    expect(f.audits(f.tests.id)).toEqual([]);
    f.store.close();
  });
});

describe("scoped configuration ownership and current authority", () => {
  it("requires the caller's exact active claim when any reservation exists and uses the claim's worktree", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T08:00:00.000Z"));
    const f = fixture();
    f.grant(all);
    const actor = f.credential(all, [f.project.id]);
    const mine = f.sessionFor("agent:mcp:mine");
    const set = (session: ScopedConfigurationSession, fields: Record<string, unknown> = {}) => f.service.setScopedTestPresetTimeout(actor, session, {
      projectId: f.project.id, worktreePath: "/code/web-feature", presetId: "node:test", timeoutMs: 1000, expectedRevision: f.current(), idempotencyKey: "k", ...fields,
    });
    const claim = await mine.claim(actor, f.project.id, "/code/web-feature", 60);
    // start:false never selects the worktree; ownership follows the claim itself.
    expect(f.store.getProject(f.project.id)!.selectedWorktreePath).toBeNull();
    expect(await failure(set(mine.session))).toMatchObject({ code: "claim_required" });
    expect(await failure(set(mine.session, { worktreePath: "/code/web", reservationId: claim.reservationId }))).toMatchObject({ code: "claim_worktree_mismatch" });
    const owned = await set(mine.session, { reservationId: claim.reservationId });
    expect(owned).toMatchObject({ outcome: "completed" });
    expect(JSON.parse(String(f.audits().at(-1)!.details_json))).toMatchObject({ reservationId: claim.reservationId });
    await expect(f.service.selectScopedEnvironmentProfile(actor, mine.session, { projectId: f.project.id, name: "staging", expectedRevision: f.current(), idempotencyKey: "s", reservationId: claim.reservationId }))
      .resolves.toMatchObject({ outcome: "completed" });

    // Another session holding a copy of the secret, or an unknown reservation, is refused.
    const other = f.sessionFor("agent:mcp:other");
    other.tokens.set(`${f.project.id}:${claim.reservationId}`, claim.leaseToken);
    expect(await failure(set(other.session, { reservationId: claim.reservationId }))).toMatchObject({ code: "claim_stale" });
    expect(await failure(set(mine.session, { reservationId: MISSING }))).toMatchObject({ code: "claim_not_owned" });
    mine.tokens.set(`${f.project.id}:${MISSING}`, claim.leaseToken);
    expect(await failure(set(mine.session, { reservationId: MISSING }))).toMatchObject({ code: "claim_stale" });

    // A rotated credential cannot use the lease bound to its predecessor.
    const rotated = f.identity.authenticateBearer(f.identity.rotateRuntimeCredential({ credentialId: actor.credentialId }, f.owner).token);
    expect(await failure(f.service.setScopedTestPresetTimeout(rotated, mine.session, { projectId: f.project.id, worktreePath: "/code/web-feature", presetId: "node:test", timeoutMs: 7, expectedRevision: f.current(), idempotencyKey: "r", reservationId: claim.reservationId })))
      .toMatchObject({ code: "claim_stale" });
    expect(await failure(set(mine.session, { reservationId: claim.reservationId }))).toBeInstanceOf(RuntimeAccessDenied);

    // An expired lease is not silently downgraded: its stale ID is refused, unclaimed access then succeeds.
    const before = f.current();
    vi.setSystemTime(new Date("2026-10-29T08:02:00.000Z"));
    const recheck = (fields: Record<string, unknown>) => f.service.setScopedTestPresetTimeout(rotated, mine.session, {
      projectId: f.project.id, worktreePath: "/code/web", presetId: "node:check", timeoutMs: 9, expectedRevision: f.current(), idempotencyKey: "e", ...fields,
    });
    expect(await failure(recheck({ reservationId: claim.reservationId }))).toMatchObject({ code: "claim_stale" });
    expect(f.current()).toBe(before);
    await expect(recheck({})).resolves.toMatchObject({ outcome: "completed" });

    // Human and legacy unbound agent leases deny scoped configuration.
    for (const reservation of [
      { kind: "human" as const, owner: `human-${SENTINEL}` },
      { kind: "agent" as const, owner: "agent:mcp:legacy", ttlSeconds: 600, maximumLifetimeSeconds: 1200, leaseTokenHash: "a".repeat(64), idempotencyKey: "legacy" },
    ]) {
      const held = f.store.acquireReservation({ projectId: f.project.id, worktreePath: "/code/web", reason: SENTINEL, ...reservation });
      const refused = await failure(recheck({}));
      expect(refused).toMatchObject({ code: "claim_required" });
      expectNoLeak(refused, [held.owner]);
      mine.tokens.set(`${f.project.id}:${held.id}`, "guess");
      expect(await failure(recheck({ reservationId: held.id }))).toMatchObject({ code: "claim_stale" });
      f.store.releaseReservation(f.project.id, "admin", true);
    }
    expect(f.current()).toBe(before + 1);
    f.store.close();
  });

  it("re-reads authority after the shared project lock and Git discovery", async () => {
    const f = fixture();
    f.grant(all);
    const actor = f.credential(all, [f.project.id]);
    const { session } = f.sessionFor("agent:mcp:race");
    const timeout = (key: string) => f.service.setScopedTestPresetTimeout(actor, session, {
      projectId: f.project.id, worktreePath: "/code/web", presetId: "node:test", timeoutMs: 1000, expectedRevision: f.current(), idempotencyKey: key,
    });
    f.hooks.beforeGitReturn = () => { f.hooks.beforeGitReturn = undefined; f.revoke(); };
    expect(await failure(timeout("git"))).toBeInstanceOf(RuntimeAccessDenied);
    expect(f.discover).not.toHaveBeenCalled();
    expect(f.current()).toBe(2);

    // A selection queued behind the lock observes the revocation made while it waited.
    f.grant(all);
    let release!: () => void;
    f.hooks.beforeGitReturn = () => new Promise<void>(resolve => { release = resolve; });
    const holder = timeout("holder");
    await vi.waitFor(() => expect(release).toBeDefined());
    const queued = f.service.selectScopedEnvironmentProfile(actor, session, { projectId: f.project.id, name: "staging", expectedRevision: f.current(), idempotencyKey: "queued" });
    f.hooks.beforeGitReturn = undefined;
    f.grant(["config:write"]);
    release();
    await expect(holder).resolves.toMatchObject({ outcome: "completed" });
    expect(await failure(queued)).toBeInstanceOf(RuntimeAccessDenied);
    expect(f.store.getProject(f.project.id)!.selectedEnvironmentProfile).toBe("default");

    // A revoked credential is denied before any write.
    const revision = f.current();
    f.identity.revokeCredential(actor.credentialId, f.owner);
    expect(await failure(timeout("revoked"))).toBeInstanceOf(RuntimeAccessDenied);
    expect(f.current()).toBe(revision);
    expect(f.audits().map(row => JSON.parse(String(row.details_json)).operationId)).toHaveLength(1);
    f.store.close();
  });

  it("re-authorizes retained results against current authority and the original claim", async () => {
    const f = fixture();
    f.grant(all);
    const actor = f.credential(all, [f.project.id]);
    const mine = f.sessionFor("agent:mcp:replay");
    f.service.authorizeScopedConfigurationReplay(actor, mine.session, "set_test_preset_timeout", f.project.id);
    const claim = await mine.claim(actor);
    f.service.authorizeScopedConfigurationReplay(actor, mine.session, "select_environment_profile", f.project.id, claim.reservationId);
    f.grant(["projects:read", "claims:manage", "config:write"]);
    expect(await failure(() => f.service.authorizeScopedConfigurationReplay(actor, mine.session, "select_environment_profile", f.project.id, claim.reservationId))).toBeInstanceOf(RuntimeAccessDenied);
    f.service.authorizeScopedConfigurationReplay(actor, mine.session, "set_test_preset_timeout", f.project.id, claim.reservationId);
    await f.service.releaseScopedClaim(actor, { owner: mine.session.owner }, f.project.id, claim.reservationId, claim.leaseToken);
    expect(await failure(() => f.service.authorizeScopedConfigurationReplay(actor, mine.session, "set_test_preset_timeout", f.project.id, claim.reservationId)))
      .toMatchObject({ code: "claim_stale" });
    f.store.close();
  });
});
