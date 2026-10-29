import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSnapshot, Worktree } from "@/shared/contracts";
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
import { resolveAppPaths } from "./paths";
import type { ProcessManager } from "./process-manager";
import { SqliteStateStore } from "./sqlite-store";

const all: RuntimeAction[] = ["projects:read", "claims:manage", "runtime:control"];
const SENTINEL = "PRIVATE-ENV-LOG-ERROR-DETAIL";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.useRealTimers(); }
});

// Own loopback listeners and temporary SQLite. No installed service, real Git,
// managed process, or configuration from the host participates in this fixture.
async function fixture(clock?: ManualMcpClock) {
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
  const projects = ["Alpha", "Beta"].map((name, index) => store.addProject({ name, repositoryPath: `/code/${name}`, port: 3620 + index, executable: "pnpm", args: ["run", "dev"] }));
  for (const project of projects) store.updateProjectEnvironment(project.id, { PRIVATE_API_KEY: SENTINEL }, "test");
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
  const service = new ControlService(store, git as unknown as GitWorktreeReader, processes as unknown as ProcessManager, undefined,
    { resolve: () => ({ preset: "node", executable: "pnpm", args: ["run", "dev"], portMethod: "environment", tls: { mode: "off", keyPath: null, certPath: null, caPath: null } }) },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, identity);
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
    return { error: result.isError === true, output, value: result.isError ? undefined : JSON.parse(output) };
  };
  const claim = (client: Client, index = 0, extra: Record<string, unknown> = {}) => call(client, "claim_project", {
    projectId: projects[index].id, worktreePath: projects[index].repositoryPath, reason: "transport verification", idempotencyKey: randomUUID(), ttlSeconds: 120, ...extra,
  });
  return { paths, store, identity, owner, ownerSession, installationToken, authentication, projects, agents, issued, clients, processes, runtimes, git, issue, grant, connect, admin, call, claim, base, mcp };
}

describe("scoped runtime HTTP/MCP/CLI boundaries", () => {
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
    const input = { action: "set-runtime-delegation", principalId: f.agents[0].id, projectId: f.projects[0].id, actions: all, expectedRevision: 1 };
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
      await runIdentityCommand(["issue-runtime-credential", "--principal-id", f.agents[0].id, "--label", "online", "--projects-json", JSON.stringify([{ projectId: f.projects[0].id, actions: all }])], onlinePaths, cli);
      const issued = JSON.parse(lines.pop()!);
      await runIdentityCommand(["rotate-runtime-credential", "--credential-id", issued.credential.id], onlinePaths, cli);
      const rotated = JSON.parse(lines.pop()!);
      expect(rotated.replacedCredentialId).toBe(issued.credential.id);
      expect(rotated.credential.expiresAt).toBeNull();
      expect(rotated.scopes.map((scope: { actions: string[] }) => scope.actions)).toEqual([all]);
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
