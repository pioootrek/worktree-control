import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSnapshot, TestPreset, TestRun, Worktree } from "@/shared/contracts";
import type { RuntimeAction } from "@/shared/contracts/runtime-access";
import { runIdentityCommand } from "../cli/identity-management";
import { writeServiceAccess } from "../cli/service-access";
import { ControlService } from "./control-service";
import { acquireControllerLock } from "./controller-lock";
import type { DirectoryBrowser } from "./directory-browser";
import { EventStream } from "./events";
import type { GitWorktreeReader } from "./git-worktrees";
import { createControllerServer } from "./http-server";
import { createMcpControllerServer } from "./mcp-http-server";
import { AuthenticationService } from "./modules/authentication";
import { IdentityService } from "./modules/identity";
import { ManualMcpClock } from "./modules/mcp-sessions/manual-clock";
import type { EnqueueTestInput, VerificationJobs } from "./modules/verification";
import { resolveAppPaths } from "./paths";
import type { ProcessManager } from "./process-manager";
import { SqliteStateStore } from "./sqlite-store";
import type { ProjectTestCommandResolver } from "./test-command";
import type { TestJobManager } from "./test-job-manager";

const all: RuntimeAction[] = ["projects:read", "claims:manage", "runtime:control"];
const configurationActions: RuntimeAction[] = [...all, "profiles:select", "config:write"];
const SENTINEL = "PRIVATE-ENV-LOG-ERROR-DETAIL";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.useRealTimers(); }
});

// Own loopback listeners and temporary SQLite. No installed service, real Git,
// managed process, or configuration from the host participates in this fixture.
async function fixture(clock?: ManualMcpClock, verificationOnly = false) {
  const directory = mkdtempSync(join(tmpdir(), "scoped-runtime-transports-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const paths = resolveAppPaths(join(directory, "data"), join(directory, "state"));
  const store = new SqliteStateStore(paths.databasePath);
  cleanups.push(() => store.close());
  const authentication = new AuthenticationService(store);
  const installationToken = authentication.generateToken("test").token;
  authentication.setMode("token", "test");
  const identity = new IdentityService(store, undefined, undefined, undefined, authentication, store);
  const ownerSession = identity.bootstrapOwnerSession({ sessionLifetimeSeconds: 300 });
  const owner = identity.authenticateBearer(ownerSession.token);
  const projects = ["Alpha", "Beta"].map((name, index) => store.addProject({ name, repositoryPath: `/code/${name}`, port: 3620 + index,
    ...(verificationOnly && index === 0 ? { launchPreset: "none" as const, executable: "", args: [] } : { executable: "pnpm", args: ["run", "dev"] }),
  }));
  for (const project of projects) {
    store.updateProjectEnvironment(project.id, { PRIVATE_API_KEY: SENTINEL }, "test");
    store.saveProjectEnvironmentProfile(project.id, { name: "staging", environment: { PRIVATE_STAGE_KEY: SENTINEL } }, "test");
  }
  const worktrees = new Map(projects.map(project => [project.repositoryPath, [{ path: project.repositoryPath, head: "a".repeat(40), shortHead: "aaaaaaa", branch: "main", detached: false, locked: false, prunable: false, dirty: false, statusError: SENTINEL } satisfies Worktree]]));
  const git = { list: vi.fn(async (path: string) => worktrees.get(path) ?? []) };
  const runtimes = new Map<string, RuntimeSnapshot>(projects.map(project => [project.id, {
    phase: "stopped", pid: null, worktreePath: null, startedAt: null, error: SENTINEL, failure: null, logs: [SENTINEL],
    resources: { status: "idle", currentRssBytes: null, peakRssBytes: null, cpuPercent: null, processCount: null, sampledAt: null, sampleAgeSeconds: null, warningThresholdBytes: null, history: [] },
  }]));
  const processes = {
    snapshot: (id: string) => ({ ...runtimes.get(id)! }),
    start: vi.fn(async (project: { id: string }, path: string, beforeSpawn?: () => void) => {
      beforeSpawn?.();
      Object.assign(runtimes.get(project.id)!, { phase: "running", pid: 500, worktreePath: path, startedAt: new Date().toISOString() });
    }),
    stop: vi.fn(async (id: string) => { Object.assign(runtimes.get(id)!, { phase: "stopped", pid: null, worktreePath: null, startedAt: null }); }),
  };
  const presets: TestPreset[] = [{ id: "node:test", name: "test", adapter: "node", timeoutMs: 900_000 }];
  // Capture the external queue admission boundary without spawning finite jobs.
  const enqueue = vi.fn((input: EnqueueTestInput) => ({ id: randomUUID(), ...input }) as unknown as TestRun);
  const queueStatus = () => ({ limit: 1, running: 0, queued: 0 });
  const jobs: VerificationJobs = { enqueue, status: queueStatus, setLimit: queueStatus, cancel: vi.fn() };
  const service = new ControlService(store, git as unknown as GitWorktreeReader, processes as unknown as ProcessManager, undefined,
    { resolve: () => ({ preset: "node", executable: "pnpm", args: ["run", "dev"], portMethod: "environment", tls: { mode: "off", keyPath: null, certPath: null, caPath: null } }) },
    undefined, undefined, {
      discover: () => presets,
      resolve: (path: string) => ({ preset: presets[0], executable: "pnpm", args: ["run", "test"], cwd: path }),
    } as unknown as ProjectTestCommandResolver,
    jobs as unknown as TestJobManager, undefined, undefined, undefined, identity);
  const agents = projects.map(() => identity.createAgent(owner));
  const grant = (index: number, actions = all, expiresAt?: string, expectedRevision = 0) => identity.setRuntimeDelegation({ principalId: agents[index].id, projectId: projects[index].id, actions, expiresAt, expectedRevision }, owner);
  for (const index of [0, 1]) grant(index);
  const issue = (index: number, actions = all, expiresAt?: string) => identity.issueRuntimeCredential({ principalId: agents[index].id, label: `client-${index}`, projects: [{ projectId: projects[index].id, actions }], expiresAt }, owner);
  const issued = [issue(0), issue(1)];
  const events = new EventStream();
  cleanups.push(() => events.close());
  const web = createControllerServer({ service, identity, authentication, events, directoryBrowser: {} as DirectoryBrowser, webRoot: directory, host: "127.0.0.1", port: 0, accessToken: "pairing", mcpStatus: () => ({ phase: "disabled", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "bearer", activeSessions: 0 }) });
  const mcp = createMcpControllerServer({ service, identity, authentication, port: 0, accessToken: "legacy", sessionClock: clock });
  for (const controller of [web, mcp]) {
    await new Promise<void>((resolve, reject) => { controller.server.once("error", reject); controller.server.listen(0, "127.0.0.1", resolve); });
    cleanups.push(() => controller.close());
  }
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  const endpoint = new URL(`http://127.0.0.1:${(mcp.server.address() as AddressInfo).port}/mcp`);
  const connect = async (token: string) => {
    const client = new Client({ name: "scoped-fixture", version: "1" });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };
  const clients = [await connect(issued[0].token), await connect(issued[1].token)];
  const admin = (body: unknown, token: string | null = ownerSession.token) => fetch(`${base}/api/identity/admin`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  const call = async (client: Client, name: string, input: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: input });
    const output = (result.content as Array<{ text: string }>)[0].text;
    for (const secret of [SENTINEL, "PRIVATE_API_KEY", "PRIVATE_STAGE_KEY", "agent:mcp:", ...issued.map(entry => entry.token)]) expect(output).not.toContain(secret);
    return { error: result.isError === true, output, value: result.isError ? undefined : JSON.parse(output) };
  };
  const claim = (client: Client, index = 0, extra: Record<string, unknown> = {}) => call(client, "claim_project", {
    projectId: projects[index].id, worktreePath: projects[index].repositoryPath, reason: "transport verification", idempotencyKey: randomUUID(), ttlSeconds: 120, ...extra,
  });
  const configurationClient = async (index = 0, actions = configurationActions, expiresAt?: string) => {
    grant(index, configurationActions, undefined, 1);
    const credential = issue(index, actions, expiresAt);
    return { client: await connect(credential.token), credential };
  };
  const audits = () => {
    const db = new Database(paths.databasePath, { readonly: true });
    try { return db.prepare("SELECT actor, event_type, details_json FROM audit_events WHERE event_type LIKE 'configuration.%' ORDER BY id").all() as Array<{ actor: string; event_type: string; details_json: string }>; }
    finally { db.close(); }
  };
  return { paths, store, service, identity, owner, ownerSession, installationToken, authentication, projects, agents, issued, clients, processes, runtimes, git, worktrees, presets, enqueue, issue, grant, connect, admin, call, claim, base, mcp, configurationClient, audits };
}

describe("scoped runtime HTTP/MCP/CLI boundaries", () => {
  it("does not let denied configuration requests consume the shared runtime retry ledger", async () => {
    const f = await fixture();
    const readonly = f.issue(1, ["projects:read"]);
    const projectId = f.projects[0].id;
    // Eight sessions with 64 distinct denied keys used to fill all 512 global entries.
    for (let index = 0; index < 8; index += 1) {
      const client = await f.connect(readonly.token);
      for (let key = 0; key < 64; key += 1) {
        const input = { projectId, expectedRevision: 2, idempotencyKey: `denied-${key}` };
        const denied = key % 2 === 0
          ? await f.call(client, "select_environment_profile", { ...input, name: "staging" })
          : await f.call(client, "set_test_preset_timeout", { ...input, worktreePath: f.projects[0].repositoryPath, presetId: "node:test", timeoutMs: 1000 });
        expect(denied.error).toBe(true);
        expect(denied.output).toMatch(/^project_access_denied:/);
      }
    }
    const { client } = await f.configurationClient();
    expect((await f.call(client, "select_environment_profile", {
      projectId, name: "staging", expectedRevision: 2, idempotencyKey: "authorized-config",
    })).value).toMatchObject({ outcome: "completed" });
    const held = (await f.claim(client)).value;
    expect((await f.call(client, "stop_project", {
      projectId, reservationId: held.reservationId, idempotencyKey: "authorized-runtime",
    })).value).toMatchObject({ outcome: "noop" });
  }, 20_000);

  it("filters two credentials across discovery/status/worktrees and exposes no privileged runtime capabilities", async () => {
    const f = await fixture();
    for (const index of [0, 1]) {
      const client = f.clients[index], project = f.projects[index], foreign = f.projects[1 - index];
      const listed = await f.call(client, "list_projects");
      expect(listed.value).toEqual([{ id: project.id, name: project.name, port: project.port, actions: all, phase: "stopped", worktreePath: null, claim: "none" }]);
      const status = await f.call(client, "get_project_status", { projectId: project.id });
      const trees = await f.call(client, "list_worktrees", { projectId: project.id });
      expect(status.value).toMatchObject({ id: project.id, phase: "stopped", ownClaim: null });
      expect(trees.value).toEqual([{ path: project.repositoryPath, head: "a".repeat(40), shortHead: "aaaaaaa", branch: "main", detached: false, locked: false, prunable: false, dirty: false }]);
      for (const result of [listed, status, trees]) {
        for (const forbidden of [foreign.id, foreign.name, SENTINEL, "PRIVATE_API_KEY", "pnpm", "environment", "logs", "capacity", "tls", f.issued[index].token]) expect(result.output).not.toContain(forbidden);
      }
      f.git.list.mockClear();
      for (const name of ["get_project_status", "list_worktrees"]) {
        const denied = await f.call(client, name, { projectId: foreign.id });
        const missing = await f.call(client, name, { projectId: randomUUID() });
        expect(denied).toEqual(missing);
        expect(denied.error).toBe(true);
      }
      expect(f.git.list).not.toHaveBeenCalled();
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining(["get_identity", "claim_project", "start_project", "restart_project", "stop_project"]));
      for (const name of ["get_project_status_compact", "wait_for_status_change", "get_runtime_logs", "get_server_capacity", "run_test", "list_test_presets", "set_project_environment", "save_environment_profile", "issue_runtime_credential", "set_runtime_delegation"]) expect(names).not.toContain(name);
      await expect(client.listResources()).rejects.toThrow();
      await expect(client.readResource({ uri: "worktree-switcher://projects" })).rejects.toThrow();
      for (const path of ["/api/projects", `/api/projects/${project.id}/worktrees`, `/api/projects/${project.id}/start`]) {
        const response = await fetch(`${f.base}${path}`, { headers: { Authorization: `Bearer ${f.issued[index].token}` } });
        expect(response.status).toBe(401);
        expect(await response.text()).not.toContain(project.id);
      }
      expect((await f.call(client, "get_identity")).value.runtimeAccess).toEqual([{ projectId: project.id, actions: all, expiresAt: null }]);
    }
    expect(f.processes.start).not.toHaveBeenCalled();
  });

  it("requires a real owner online, validates strict admin schemas, and routes online CLI without opening SQLite", async () => {
    const f = await fixture();
    const input = { action: "set-runtime-delegation", principalId: f.agents[0].id, projectId: f.projects[0].id, actions: configurationActions, expectedRevision: 1 };
    const worker = f.identity.createWorker(f.owner);
    const workerToken = f.identity.issueWorkerToken({ principalId: worker.id, label: "worker" }, f.owner).token;
    for (const token of [f.installationToken, f.issued[0].token, workerToken]) expect((await f.admin(input, token)).status).toBe(403);
    expect((await f.admin(input, null)).status).toBe(401);
    for (const body of [{ ...input, sponsorId: f.owner.principalId }, { ...input, actions: ["logs:read"] }, { ...input, actions: ["env:read"] }, { ...input, actions: ["tests:run"] }]) expect((await f.admin(body)).status).toBe(400);
    expect((await f.admin(input)).status).toBe(200);
    expect((await f.admin(input)).status).toBe(409);
    const badIssue = { action: "issue-runtime-credential", principalId: f.agents[0].id, label: "duplicate", projects: Array(2).fill({ projectId: f.projects[0].id, actions: all }) };
    expect((await f.admin(badIssue)).status).toBe(400);
    const badExpiry = { ...input, expectedRevision: 2, expiresAt: "not-a-date" };
    expect((await f.admin(badExpiry)).status).toBe(400);
    // Deliberately unusable offline DB: success must come through HTTP despite the lock.
    const onlinePaths = { ...f.paths, databasePath: join(f.paths.dataDirectory, "must-not-open.sqlite3") };
    writeServiceAccess(f.paths.serviceAccessPath, { pid: process.pid, startedAt: new Date().toISOString(), version: "test", dashboardEndpoint: f.base, localDashboardEndpoint: f.base, mcpEndpoint: null, accessUrl: f.base, logDirectory: f.paths.logDirectory });
    const lock = acquireControllerLock(f.paths.controllerLockPath);
    const lines: string[] = [];
    const cli = { environment: { WORKTREE_CONTROL_OWNER_TOKEN: f.ownerSession.token }, write: (line: string) => lines.push(line) };
    try {
      await runIdentityCommand(["list-runtime-access", "--principal-id", f.agents[0].id], onlinePaths, cli);
      expect(JSON.parse(lines.pop()!).delegations[0].revision).toBe(2);
      await runIdentityCommand(["issue-runtime-credential", "--principal-id", f.agents[0].id, "--label", "online", "--projects-json", JSON.stringify([{ projectId: f.projects[0].id, actions: configurationActions }])], onlinePaths, cli);
      const issued = JSON.parse(lines.pop()!);
      await runIdentityCommand(["rotate-runtime-credential", "--credential-id", issued.credential.id], onlinePaths, cli);
      const rotated = JSON.parse(lines.pop()!);
      expect(rotated.replacedCredentialId).toBe(issued.credential.id);
      expect(rotated.credential.expiresAt).toBeNull();
      expect(rotated.scopes.map((scope: { actions: string[] }) => scope.actions)).toEqual([configurationActions]);
      expect(() => f.identity.authenticateBearer(issued.token)).toThrow();
      await runIdentityCommand(["set-runtime-delegation", "--principal-id", f.agents[0].id, "--project-id", f.projects[0].id, "--actions", "projects:read", "--expected-revision", "2", "--expires-at", "none"], onlinePaths, cli);
      await runIdentityCommand(["revoke-runtime-delegation", "--principal-id", f.agents[0].id, "--project-id", f.projects[0].id, "--expected-revision", "3"], onlinePaths, cli);
      expect(JSON.parse(lines.pop()!).delegation.revokedAt).toEqual(expect.any(String));
      expect(existsSync(onlinePaths.databasePath)).toBe(false);
      const db = new Database(f.paths.databasePath, { readonly: true });
      try {
        const persisted = JSON.stringify(db.prepare("SELECT * FROM principal_credentials").all()) + JSON.stringify(db.prepare("SELECT * FROM controller_audit_events").all());
        expect(persisted).not.toContain(issued.token);
        expect(persisted).not.toContain(rotated.token);
      } finally { db.close(); }
    } finally { lock.release(); }
  });

  it("separates read, claim and control rights and binds a lease to its session and credential", async () => {
    const f = await fixture();
    const reader = await f.connect(f.issue(0, ["projects:read"]).token);
    expect((await f.claim(reader)).error).toBe(true);
    expect(f.store.getActiveReservation(f.projects[0].id)).toBeNull();
    const blindClaimant = await f.connect(f.issue(0, ["claims:manage"]).token);
    expect((await f.call(blindClaimant, "list_projects")).value).toEqual([]);
    expect((await f.call(blindClaimant, "get_project_status", { projectId: f.projects[0].id })).error).toBe(true);
    const blindClaim = await f.claim(blindClaimant);
    expect(blindClaim.value).toMatchObject({ startRequested: false, leaseHeld: true, status: null });
    expect((await f.call(blindClaimant, "release_project_claim", { projectId: f.projects[0].id, reservationId: blindClaim.value.reservationId })).error).toBe(false);
    const claimCredential = f.issue(0, ["projects:read", "claims:manage"]);
    const claimOnly = await f.connect(claimCredential.token);
    expect((await f.claim(claimOnly, 0, { start: true })).error).toBe(true);
    expect(f.processes.start).not.toHaveBeenCalled();
    const held = await f.claim(claimOnly);
    expect(held.value).toMatchObject({ startRequested: false, leaseHeld: true, status: { phase: "stopped", claim: "own" } });
    const target = { projectId: f.projects[0].id, reservationId: held.value.reservationId };
    expect((await f.call(claimOnly, "start_project", { ...target, idempotencyKey: "denied-start" })).error).toBe(true);
    const otherSession = await f.connect(claimCredential.token);
    for (const client of [f.clients[0], otherSession]) {
      for (const name of ["renew_project_claim", "release_project_claim", "start_project"]) expect((await f.call(client, name, { ...target, ...(name === "start_project" ? { idempotencyKey: "stolen" } : {}) })).error).toBe(true);
      const status = (await f.call(client, "get_project_status", { projectId: target.projectId })).value;
      expect(status).toMatchObject({ claim: "other", ownClaim: null });
      expect(JSON.stringify(status)).not.toContain(target.reservationId);
    }
    expect(f.store.getActiveReservation(target.projectId)?.id).toBe(target.reservationId);
    expect((await f.call(claimOnly, "release_project_claim", target)).value).toMatchObject({ released: true });
    const full = await f.claim(f.clients[0], 0, { start: true, idempotencyKey: "explicit-start" });
    expect(full.value).toMatchObject({ startRequested: true, status: { phase: "running" } });
    expect(f.processes.start).toHaveBeenCalledOnce();
    expect((await f.claim(f.clients[0], 0, { start: true, idempotencyKey: "explicit-start" })).value.reservationId).toBe(full.value.reservationId);
    const operation = { projectId: target.projectId, reservationId: full.value.reservationId, idempotencyKey: "restart" };
    const restarted = await f.call(f.clients[0], "restart_project", operation);
    expect(restarted.value).toMatchObject({ outcome: "completed", replayed: false, leaseHeld: true });
    expect((await f.call(f.clients[0], "restart_project", operation)).value).toMatchObject({ replayed: true, operationId: restarted.value.operationId });
    expect(f.processes.start).toHaveBeenCalledTimes(2);
    const stopped = await f.call(f.clients[0], "stop_project", { ...operation, idempotencyKey: "stop" });
    expect(stopped.value).toMatchObject({ outcome: "completed", leaseHeld: true, runtime: { phase: "stopped" } });
    expect((await f.call(f.clients[0], "renew_project_claim", { projectId: target.projectId, reservationId: full.value.reservationId, ttlSeconds: 90 })).error).toBe(false);
    expect((await f.call(f.clients[0], "release_project_claim", { projectId: target.projectId, reservationId: full.value.reservationId })).error).toBe(false);
  });

  it("rejects changed claim retries and preserves the original renewal deadline on identical retries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const clock = new ManualMcpClock(Date.now(), now => vi.setSystemTime(now));
    const f = await fixture(clock), client = f.clients[0];
    const input = { idempotencyKey: "short-claim", ttlSeconds: 30, start: false };
    const acquired = await f.claim(client, 0, input);
    const projectId = f.projects[0].id;
    const original = f.store.getActiveReservation(projectId)!;
    clock.advance(9_000);
    for (const changed of [{ ttlSeconds: 1800 }, { start: true }]) {
      const result = await f.claim(client, 0, { ...input, ...changed });
      expect(result.error).toBe(true);
      expect(result.output).toContain("idempotency_conflict");
    }
    expect((await f.claim(client, 0, input)).value.reservationId).toBe(acquired.value.reservationId);
    expect(f.store.getActiveReservation(projectId)?.expiresAt).toBe(original.expiresAt);
    expect(f.processes.start).not.toHaveBeenCalled();
    clock.advance(2_000);
    const renewed = f.store.getActiveReservation(projectId)!;
    expect(renewed.id).toBe(original.id);
    expect(Date.parse(renewed.expiresAt!)).toBeGreaterThan(Date.parse(original.expiresAt!));
  });

  it.each(["released", "expired"] as const)("refuses retained runtime successes and failures after the original claim is %s", async mode => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const clock = new ManualMcpClock(Date.now(), now => vi.setSystemTime(now));
    const f = await fixture(clock), client = f.clients[0], projectId = f.projects[0].id;
    const acquired = await f.claim(client, 0, { start: true });
    const target = { projectId, reservationId: acquired.value.reservationId };
    const success = { ...target, idempotencyKey: "retained-success" };
    expect((await f.call(client, "start_project", success)).value).toMatchObject({ outcome: "noop", leaseHeld: true });
    f.processes.start.mockRejectedValueOnce(new Error(SENTINEL));
    const failure = { ...target, idempotencyKey: "retained-failure" };
    expect((await f.call(client, "restart_project", failure)).value).toMatchObject({ outcome: "failed", leaseHeld: true });
    for (const [tool, input] of [["start_project", success], ["restart_project", failure]] as const) {
      expect((await f.call(client, tool, input)).value).toMatchObject({ replayed: true });
    }
    const starts = f.processes.start.mock.calls.length, stops = f.processes.stop.mock.calls.length;
    if (mode === "released") f.store.releaseReservation(projectId, "local-user", true);
    // Advance wall time without running renewal timers: the session still holds its old handle.
    else vi.setSystemTime(Date.now() + 121_000);
    expect(f.store.getActiveReservation(projectId)).toBeNull();
    for (const [tool, input] of [["start_project", success], ["restart_project", failure]] as const) {
      const denied = await f.call(client, tool, input);
      expect(denied.error).toBe(true);
      expect(denied.output).toMatch(/^claim_stale:/);
      expect(denied.output).not.toContain("leaseHeld");
    }
    expect(f.processes.start).toHaveBeenCalledTimes(starts);
    expect(f.processes.stop).toHaveBeenCalledTimes(stops);
  });

  it("reauthorizes receipt/claim replays after delegation revocation and stops automatic renewal without releasing or stopping", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const clock = new ManualMcpClock(Date.now(), now => vi.setSystemTime(now));
    const f = await fixture(clock), client = f.clients[0];
    const acquired = await f.claim(client, 0, { start: true, idempotencyKey: "claim-replay" });
    const reservationId = acquired.value.reservationId, projectId = f.projects[0].id;
    const input = { projectId, reservationId, idempotencyKey: "runtime-replay" };
    expect((await f.call(client, "start_project", input)).value.outcome).toBe("noop");
    const lease = f.store.getActiveReservation(projectId)!;
    expect((await f.admin({ action: "revoke-runtime-delegation", principalId: f.agents[0].id, projectId, expectedRevision: 1 })).status).toBe(200);
    expect((await f.call(client, "start_project", input)).error).toBe(true);
    expect((await f.claim(client, 0, { start: true, idempotencyKey: "claim-replay" })).error).toBe(true);
    expect((await f.call(client, "list_projects")).value).toEqual([]);
    expect((await f.call(client, "get_identity")).value.runtimeAccess).toEqual([]);
    for (const name of ["renew_project_claim", "release_project_claim"]) expect((await f.call(client, name, { projectId, reservationId })).error).toBe(true);
    clock.advance(45_000);
    expect(f.store.getActiveReservation(projectId)).toMatchObject({ id: reservationId, expiresAt: lease.expiresAt });
    expect(f.runtimes.get(projectId)?.phase).toBe("running");
    expect(f.processes.stop).not.toHaveBeenCalled();
    clock.advance(80_000);
    expect(f.store.getActiveReservation(projectId)).toBeNull();
    expect(f.runtimes.get(projectId)?.phase).toBe("running");
  });

  it("revokes a rotated credential on the next MCP call and prevents a replacement session adopting its lease", async () => {
    const f = await fixture(), client = f.clients[0], projectId = f.projects[0].id;
    const held = await f.claim(client);
    const rotatedResponse = await f.admin({ action: "rotate-runtime-credential", credentialId: f.issued[0].credential.id, projects: [{ projectId, actions: ["projects:read", "claims:manage"] }] });
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json();
    await expect(f.call(client, "list_projects")).rejects.toMatchObject({ code: 401 });
    const replacement = await f.connect(rotated.token);
    const status = (await f.call(replacement, "get_project_status", { projectId })).value;
    expect(status).toMatchObject({ claim: "other", ownClaim: null });
    expect((await f.call(replacement, "renew_project_claim", { projectId, reservationId: held.value.reservationId })).error).toBe(true);
    expect(f.store.getActiveReservation(projectId)?.id).toBe(held.value.reservationId);
    expect((await f.admin({ action: "revoke-token", credentialId: rotated.credential.id })).status).toBe(200);
    await expect(f.call(replacement, "get_identity")).rejects.toMatchObject({ code: 401 });
  });

  it("applies credential/delegation expiry and sponsor revocation while owner-session expiry alone keeps sponsorship", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const clock = new ManualMcpClock(Date.now(), now => vi.setSystemTime(now));
    const f = await fixture(clock);
    const expiring = await f.connect(f.issue(0, all, new Date(Date.now() + 60_000).toISOString()).token);
    f.grant(0, all, new Date(Date.now() + 60_000).toISOString(), 1);
    clock.advance(61_000);
    await expect(f.call(expiring, "get_identity")).rejects.toMatchObject({ code: 401 });
    expect((await f.call(f.clients[0], "list_projects")).value).toEqual([]);
    // The second delegation has no expiry and the agent credential is durable.
    clock.advance(240_000);
    expect((await f.call(f.clients[1], "list_projects")).value).toHaveLength(1);
    expect(() => f.identity.authenticateBearer(f.ownerSession.token)).toThrow();
    f.store.savePrincipal({ ...f.store.getOwnerPrincipal()!, status: "revoked" }, "test");
    expect((await f.call(f.clients[1], "list_projects")).value).toEqual([]);
    expect((await f.call(f.clients[1], "get_project_status", { projectId: f.projects[1].id })).error).toBe(true);
  });
});

describe("independent scoped configuration transport boundaries", () => {
  it("isolates two principals/projects and preserves old credentials when delegations gain actions", async () => {
    const f = await fixture();
    for (const index of [0, 1]) {
      const { client } = await f.configurationClient(index);
      const projectId = f.projects[index].id, worktreePath = f.projects[index].repositoryPath;
      f.git.list.mockClear();
      const requests: Array<[string, Record<string, unknown>]> = [
        ["list_environment_profiles", {}],
        ["get_project_configuration", { worktreePath }],
        ["select_environment_profile", { name: "staging", expectedRevision: 2, idempotencyKey: "select" }],
        ["set_test_preset_timeout", { worktreePath, presetId: "node:test", timeoutMs: 1000, expectedRevision: 2, idempotencyKey: "timeout" }],
      ];
      for (const [name, args] of requests) {
        // Existing credentials retain the three-action ceiling, even in their existing session.
        expect((await f.call(f.clients[index], name, { ...args, projectId })).output).toMatch(/^project_access_denied:/);
        const denied = await f.call(client, name, { ...args, projectId: f.projects[1 - index].id });
        const missing = await f.call(client, name, { ...args, projectId: randomUUID(), ...(args.idempotencyKey ? { idempotencyKey: `${args.idempotencyKey}-missing` } : {}) });
        expect(denied).toEqual(missing);
        expect(denied.error).toBe(true);
      }
      expect(f.git.list).not.toHaveBeenCalled();
      const profiles = await f.call(client, "list_environment_profiles", { projectId });
      expect(profiles.value).toEqual({ schemaVersion: 1, projectId, configurationRevision: 2, selectedProfile: "default", profiles: [{ name: "default" }, { name: "staging" }] });
      const config = await f.call(client, "get_project_configuration", { projectId, worktreePath });
      expect(config.value).toEqual({ schemaVersion: 1, projectId, configurationRevision: 2, presets: [{ id: "node:test", timeoutMs: 900_000, overrideTimeoutMs: null }] });
      for (const result of [profiles, config]) expect(result.output).not.toContain(f.projects[1 - index].id);
      // A different session using the same credential has the same ceiling.
      const oldSession = await f.connect(f.issued[index].token);
      expect((await f.call(oldSession, "list_environment_profiles", { projectId })).error).toBe(true);
    }
    expect(f.audits()).toEqual([]);
  });

  it("separates profile and timeout metadata/mutations without requiring discovery or claim rights", async () => {
    const f = await fixture();
    const { client: profiles } = await f.configurationClient(0, ["profiles:select"]);
    const config = await f.connect(f.issue(0, ["config:write"]).token);
    const projectId = f.projects[0].id, worktreePath = f.projects[0].repositoryPath;
    const select = { projectId, name: "staging", expectedRevision: 2, idempotencyKey: "select" };
    const timeout = { projectId, worktreePath, presetId: "node:test", timeoutMs: 1000, expectedRevision: 3, idempotencyKey: "timeout" };
    expect((await f.call(config, "list_environment_profiles", { projectId })).error).toBe(true);
    expect((await f.call(config, "select_environment_profile", select)).error).toBe(true);
    expect((await f.call(profiles, "get_project_configuration", { projectId, worktreePath })).error).toBe(true);
    expect((await f.call(profiles, "set_test_preset_timeout", timeout)).error).toBe(true);
    for (const client of [profiles, config]) {
      expect((await f.call(client, "list_projects")).value).toEqual([]);
      expect((await f.claim(client)).error).toBe(true);
    }
    expect((await f.call(profiles, "select_environment_profile", { ...select, idempotencyKey: "permitted-select" })).value).toMatchObject({ outcome: "completed", configurationRevision: 3 });
    expect((await f.call(config, "set_test_preset_timeout", { ...timeout, idempotencyKey: "permitted-timeout" })).value).toMatchObject({ outcome: "completed", configurationRevision: 4 });
    expect(f.store.getActiveReservation(projectId)).toBeNull();
    expect(f.processes.start).not.toHaveBeenCalled();
    expect(f.processes.stop).not.toHaveBeenCalled();
  });

  it("rejects field injection, HTTP config bypasses, privileged tools and resources", async () => {
    const f = await fixture(), { client, credential } = await f.configurationClient();
    const projectId = f.projects[0].id, worktreePath = f.projects[0].repositoryPath;
    const select = { projectId, name: "staging", expectedRevision: 2, idempotencyKey: "select" };
    const timeout = { projectId, worktreePath, presetId: "node:test", timeoutMs: 1000, expectedRevision: 2, idempotencyKey: "timeout" };
    for (const extra of [{ environment: { INJECTED: SENTINEL } }, { tls: { keyPath: SENTINEL } }, { executable: "sh" }, { args: ["-c", SENTINEL] },
      { role: "manager" }, { actions: ["config:write"] }, { restart: true }, { create: true }, { testProfile: "unit" }, { serverProfile: "default" }, { vault: "dev" }]) {
      for (const [name, input] of [["select_environment_profile", select], ["set_test_preset_timeout", timeout]] as const) {
        expect((await f.call(client, name, { ...input, ...extra })).error).toBe(true);
      }
    }
    for (const timeoutMs of [0, -1, 1.5, 86_400_001, "1000"]) expect((await f.call(client, "set_test_preset_timeout", { ...timeout, timeoutMs })).error).toBe(true);
    expect((await f.call(client, "set_test_preset_timeout", { ...timeout, presetId: "node:undiscovered" })).output).toMatch(/^preset_not_found:/);
    expect((await f.call(client, "get_project_configuration", { projectId, worktreePath: `${worktreePath}/../Alpha` })).output).toMatch(/^worktree_unavailable:/);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ["set_project_environment", "save_environment_profile", "delete_environment_profile", "save_test_environment_profile", "assign_test_preset_profile", "run_test", "get_test_run", "get_project_status_compact", "wait_for_status_change", "set_runtime_delegation"]) {
      expect(names).not.toContain(name);
      expect((await f.call(client, name, { projectId })).error).toBe(true);
    }
    await expect(client.listResources()).rejects.toThrow();
    await expect(client.readResource({ uri: `worktree-switcher://projects/${projectId}/status` })).rejects.toThrow();
    for (const [suffix, body] of [
      ["environment", { environment: { INJECTED: SENTINEL } }],
      ["environment-profiles", { name: "new", environment: {} }],
      ["environment-profile-selection", { name: "staging" }],
      ["test-environment-profiles", { name: "new", environment: {} }],
      ["test-preset-timeouts", { presetId: "node:test", timeoutMs: 1000 }],
    ] as const) {
      const response = await fetch(`${f.base}/api/projects/${projectId}/${suffix}`, { method: "POST", headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(SENTINEL);
    }
    expect(f.store.getProjectConfigurationRevision(projectId)).toBe(2);
    expect(f.audits()).toEqual([]);
  });

  it("changes only future queue admissions project-wide on a verification-only project and bounds metadata", async () => {
    const f = await fixture(undefined, true), { client } = await f.configurationClient(0, ["config:write"]);
    const projectId = f.projects[0].id, worktreePath = f.projects[0].repositoryPath, feature = `${worktreePath}-feature`;
    f.worktrees.get(worktreePath)!.push({ ...f.worktrees.get(worktreePath)![0], path: feature });
    await f.service.enqueueTest(projectId, worktreePath, "node:test");
    const admitted = f.enqueue.mock.lastCall![0];
    expect(admitted.command.preset.timeoutMs).toBe(900_000);
    const request = { projectId, worktreePath: feature, presetId: "node:test", timeoutMs: 1, expectedRevision: 2, idempotencyKey: "future" };
    expect((await f.call(client, "set_test_preset_timeout", request)).value).toMatchObject({ outcome: "completed", configurationRevision: 3 });
    await f.service.enqueueTest(projectId, worktreePath, "node:test");
    const overridden = f.enqueue.mock.lastCall![0];
    expect(overridden.command.preset.timeoutMs).toBe(1);
    expect(admitted.command.preset.timeoutMs).toBe(900_000);
    expect((await f.call(client, "set_test_preset_timeout", { ...request, timeoutMs: null, expectedRevision: 3, idempotencyKey: "restore" })).value).toMatchObject({ outcome: "completed", configurationRevision: 4 });
    await f.service.enqueueTest(projectId, feature, "node:test");
    expect(f.enqueue.mock.lastCall![0].command.preset.timeoutMs).toBe(900_000);
    expect(overridden.command.preset.timeoutMs).toBe(1);
    for (let index = 0; index < 256; index++) f.presets.push({ id: `node:test-${index}`, name: SENTINEL, adapter: "node", timeoutMs: 900_000 });
    const listed = await f.call(client, "get_project_configuration", { projectId, worktreePath });
    expect(listed.value.presets).toHaveLength(256);
    expect(f.store.getActiveReservation(projectId)).toBeNull();
    expect(f.processes.start).not.toHaveBeenCalled();
  });

  it("keeps profile and timeout receipts, retries, no-ops and audit attributable and secret-free", async () => {
    const f = await fixture(), { client, credential } = await f.configurationClient();
    const projectId = f.projects[0].id;
    const select = { projectId, name: "staging", expectedRevision: 2, idempotencyKey: "select" };
    const selected = (await f.call(client, "select_environment_profile", select)).value;
    expect(selected).toMatchObject({ schemaVersion: 1, projectId, operation: "select_environment_profile", outcome: "completed", replayed: false, configurationRevision: 3, selectedProfile: "staging" });
    expect((await f.call(client, "select_environment_profile", select)).value).toEqual({ ...selected, replayed: true });
    expect((await f.call(client, "select_environment_profile", { ...select, name: "default" })).output).toMatch(/^idempotency_conflict:/);
    // Configuration and runtime operations share one key namespace.
    const runtimeClaim = (await f.claim(client, 0, { idempotencyKey: "runtime-claim" })).value;
    expect((await f.call(client, "stop_project", { projectId, reservationId: runtimeClaim.reservationId, idempotencyKey: "select" })).output).toMatch(/^idempotency_conflict:/);
    await f.call(client, "release_project_claim", { projectId, reservationId: runtimeClaim.reservationId });
    const noOp = (await f.call(client, "select_environment_profile", { ...select, expectedRevision: 3, idempotencyKey: "noop" })).value;
    expect(noOp).toMatchObject({ outcome: "noop", configurationRevision: 3 });
    const stale = { ...select, idempotencyKey: "stale" };
    expect((await f.call(client, "select_environment_profile", stale)).output).toMatch(/^revision_conflict:/);
    expect((await f.call(client, "select_environment_profile", { ...stale, expectedRevision: 3 })).output).toMatch(/^idempotency_conflict:/);
    const timeout = { projectId, worktreePath: f.projects[0].repositoryPath, presetId: "node:test", timeoutMs: 86_400_000, expectedRevision: 3, idempotencyKey: "timeout" };
    const changed = (await f.call(client, "set_test_preset_timeout", timeout)).value;
    expect(changed).toMatchObject({ operation: "set_test_preset_timeout", outcome: "completed", configurationRevision: 4, timeoutMs: 86_400_000 });
    expect((await f.call(client, "set_test_preset_timeout", timeout)).value).toEqual({ ...changed, replayed: true });
    const audits = f.audits();
    expect(audits).toHaveLength(2);
    expect(audits.map(row => row.actor)).toEqual(Array(2).fill(`principal:${f.agents[0].id}`));
    expect(audits.map(row => JSON.parse(row.details_json))).toEqual([
      expect.objectContaining({ credentialId: credential.credential.id, operationId: selected.operationId, previousRevision: 2, revision: 3, reservationId: null }),
      expect.objectContaining({ credentialId: credential.credential.id, operationId: changed.operationId, previousRevision: 3, revision: 4, presetId: "node:test", timeoutMs: 86_400_000 }),
    ]);
    for (const secret of [SENTINEL, "PRIVATE_API_KEY", "PRIVATE_STAGE_KEY", "agent:mcp:", credential.token, f.ownerSession.token]) expect(JSON.stringify([selected, noOp, changed, audits])).not.toContain(secret);
    // Compatibility writes invalidate fresh requests; retained results stay historical.
    await f.service.setProjectEnvironment(projectId, { PRIVATE_API_KEY: SENTINEL });
    expect((await f.call(client, "set_test_preset_timeout", { ...timeout, expectedRevision: 4, idempotencyKey: "after-compatibility" })).output).toMatch(/^revision_conflict:/);
    expect((await f.call(client, "set_test_preset_timeout", timeout)).value).toEqual({ ...changed, replayed: true });
    const other = await f.connect(credential.token);
    expect((await f.call(other, "set_test_preset_timeout", timeout)).output).toMatch(/^revision_conflict:/);
    expect(f.audits()).toHaveLength(2);
  });

  it("uses the own claim's worktree and refuses foreign, human, rotated and stale ownership", async () => {
    const f = await fixture(), { client, credential } = await f.configurationClient();
    const projectId = f.projects[0].id, main = f.projects[0].repositoryPath, feature = `${main}-feature`;
    f.worktrees.get(main)!.push({ ...f.worktrees.get(main)![0], path: feature });
    f.store.setSelectedWorktree(projectId, main);
    const claim = (await f.claim(client, 0, { worktreePath: feature })).value;
    expect(f.store.getProject(projectId)!.selectedWorktreePath).toBe(main);
    const input = { projectId, worktreePath: feature, presetId: "node:test", timeoutMs: 1000, expectedRevision: 2, idempotencyKey: "own", reservationId: claim.reservationId };
    expect((await f.call(client, "set_test_preset_timeout", { ...input, worktreePath: main, idempotencyKey: "wrong-path" })).output).toMatch(/^claim_worktree_mismatch:/);
    const sameCredential = await f.connect(credential.token);
    f.identity.setRuntimeDelegation({ principalId: f.agents[1].id, projectId, actions: configurationActions, expectedRevision: 0 }, f.owner);
    const foreign = f.identity.issueRuntimeCredential({ principalId: f.agents[1].id, label: "foreign", projects: [{ projectId, actions: configurationActions }] }, f.owner);
    for (const other of [sameCredential, await f.connect(foreign.token)]) {
      expect((await f.call(other, "set_test_preset_timeout", input)).output).toMatch(/^claim_not_owned:/);
      expect((await f.call(other, "set_test_preset_timeout", { projectId, worktreePath: feature, presetId: "node:test", timeoutMs: 1000, expectedRevision: 2, idempotencyKey: "no-claim" })).output).toMatch(/^claim_required:/);
    }
    expect((await f.call(client, "set_test_preset_timeout", input)).value).toMatchObject({ outcome: "completed", configurationRevision: 3 });
    const select = { projectId, name: "staging", expectedRevision: 3, idempotencyKey: "profile", reservationId: claim.reservationId };
    f.runtimes.get(projectId)!.phase = "running";
    expect((await f.call(client, "select_environment_profile", select)).output).toMatch(/^runtime_active:/);
    f.runtimes.get(projectId)!.phase = "stopped";
    expect((await f.call(client, "select_environment_profile", { ...select, idempotencyKey: "stopped" })).value).toMatchObject({ outcome: "completed", configurationRevision: 4 });
    const rotated = f.identity.rotateRuntimeCredential({ credentialId: credential.credential.id }, f.owner);
    const replacement = await f.connect(rotated.token);
    await expect(f.call(client, "set_test_preset_timeout", input)).rejects.toMatchObject({ code: 401 });
    expect((await f.call(replacement, "set_test_preset_timeout", input)).output).toMatch(/^claim_not_owned:/);
    f.store.releaseReservation(projectId, "test", true);
    expect((await f.call(replacement, "set_test_preset_timeout", { ...input, expectedRevision: 4, idempotencyKey: "stale" })).output).toMatch(/^claim_not_owned:/);
    const held = f.store.acquireReservation({ projectId, worktreePath: main, kind: "human", owner: SENTINEL, reason: SENTINEL });
    expect((await f.call(replacement, "select_environment_profile", { projectId, name: "default", expectedRevision: 4, idempotencyKey: "human" })).output).toMatch(/^claim_required:/);
    expect(f.store.getActiveReservation(projectId)?.id).toBe(held.id);
    expect(f.store.getProjectConfigurationRevision(projectId)).toBe(4);
    expect(f.audits()).toHaveLength(2);
    expect(f.processes.start).not.toHaveBeenCalled();
    expect(f.processes.stop).not.toHaveBeenCalled();
  });

  it.each(["delegation-revoked", "delegation-expired", "sponsor-disabled", "credential-expired", "credential-revoked"] as const)("reauthorizes both successful and failed cached configuration requests after %s", async mode => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const clock = new ManualMcpClock(Date.now(), now => vi.setSystemTime(now));
    const f = await fixture(clock);
    const expiry = new Date(Date.now() + 60_000).toISOString();
    const { client, credential } = await f.configurationClient(0, configurationActions, mode === "credential-expired" ? expiry : undefined);
    const projectId = f.projects[0].id;
    const success = { projectId, name: "staging", expectedRevision: 2, idempotencyKey: "success" };
    const failed = { ...success, idempotencyKey: "failure" };
    expect((await f.call(client, "select_environment_profile", success)).value.outcome).toBe("completed");
    expect((await f.call(client, "select_environment_profile", failed)).output).toMatch(/^revision_conflict:/);
    if (mode === "delegation-revoked") f.identity.revokeRuntimeDelegation({ principalId: f.agents[0].id, projectId, expectedRevision: 2 }, f.owner);
    if (mode === "delegation-expired") { f.grant(0, configurationActions, expiry, 2); clock.advance(61_000); }
    if (mode === "sponsor-disabled") f.store.savePrincipal({ ...f.store.getOwnerPrincipal()!, status: "revoked" }, "test");
    if (mode === "credential-expired") clock.advance(61_000);
    if (mode === "credential-revoked") f.identity.revokeCredential(credential.credential.id, f.owner);
    for (const input of [success, failed]) {
      if (mode.startsWith("credential-")) await expect(f.call(client, "select_environment_profile", input)).rejects.toMatchObject({ code: 401 });
      else expect((await f.call(client, "select_environment_profile", input)).output).toMatch(/^project_access_denied:/);
    }
    expect(f.audits()).toHaveLength(1);
    expect(f.store.getProjectConfigurationRevision(projectId)).toBe(3);
  });
});
