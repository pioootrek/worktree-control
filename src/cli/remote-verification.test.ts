import { AuthenticationService } from "@/server/modules/authentication";
import { acquireControllerLock } from "@/server/controller-lock";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteStateStore } from "@/server/sqlite-store";
import { IdentityService } from "@/server/modules/identity";
import { resolveAppPaths } from "@/server/paths";
import { loadRemoteVerificationConfig, readRemoteWorkerToken, remoteVerificationConfigSchema, runRemoteVerificationCommand } from "./remote-verification";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory() { const root = mkdtempSync(join(tmpdir(), "wtc-remote-cli-")); roots.push(root); return root; }

it("validates worker-local pinned setup and preparation bounds while leaving older mappings disabled", () => {
  const mapping = { projectId: "project", localProjectId: "local", sourceCachePath: "/fixture/cache", sourceRemote: "origin", presetIds: ["node:test"] };
  const config = { version: 1, worker: { workerId: "worker", origin: "https://worker.invalid", tokenFile: "/fixture/token", workspaceRoot: "/fixture/attempts", mappings: [mapping] } };
  expect(remoteVerificationConfigSchema.parse(config).worker!.mappings[0].dependencySetup).toBeUndefined();
  const policy = { kind: "pnpm", nodeExecutable: "/tools/node", nodeVersion: "24.15.0", pnpmEntryPoint: "/tools/pnpm.cjs", pnpmVersion: "11.5.2", scripts: "trusted-repository" };
  const parse = (extra: object) => remoteVerificationConfigSchema.safeParse({ ...config, worker: { ...config.worker, mappings: [{ ...mapping, ...extra }] } }).success;
  expect(parse({ dependencySetup: policy, preparationTimeoutMs: 600_000 })).toBe(true);
  for (const override of [{ scripts: undefined }, { scripts: "automatic" }, { nodeExecutable: "node" }, { pnpmEntryPoint: "https://example.invalid/pnpm" }, { pnpmVersion: "latest" }, { pnpmVersion: "10.0.0" }, { nodeVersion: ">=24" }, { command: "pnpm install" }]) {
    expect(parse({ dependencySetup: { ...policy, ...override } })).toBe(false);
  }
  for (const preparationTimeoutMs of [0, 999, 1_800_001]) expect(parse({ preparationTimeoutMs })).toBe(false);
});

it("requires production TLS or an explicit numeric loopback fixture and rejects unknown configuration", () => {
  expect(remoteVerificationConfigSchema.safeParse({ version: 1, listener: { host: "0.0.0.0", port: 443, allowLoopbackHttpFixture: true } }).success).toBe(false);
  expect(remoteVerificationConfigSchema.safeParse({ version: 1, listener: { host: "127.0.0.1", port: 18000 } }).success).toBe(false);
  expect(remoteVerificationConfigSchema.safeParse({ version: 1, listener: { host: "127.0.0.1", port: 18000, allowLoopbackHttpFixture: true } }).success).toBe(true);
  expect(remoteVerificationConfigSchema.safeParse({ version: 2, listener: { host: "127.0.0.1", port: 18000, allowLoopbackHttpFixture: true } }).success).toBe(false);
  expect(loadRemoteVerificationConfig(undefined)).toBeNull();
});

it("provisions a worker-only revocable token into a private file and never returns the secret", async () => {
  const root = directory(), paths = resolveAppPaths(root), tokenFile = join(root, "worker-token");
  const store = new SqliteStateStore(paths.databasePath);
  const identity = new IdentityService(store);
  const session = identity.bootstrapOwnerSession();
  const local = store.addProject({ name: "Fixture", repositoryPath: root, port: 3199, executable: "", args: [], launchPreset: "none" });
  store.close();
  vi.stubEnv("WORKTREE_CONTROL_OWNER_TOKEN", session.token);
  const file = join(root, "provision.json");
  writeFileSync(file, JSON.stringify({ project: { id: "project", name: "Fixture", sourceRemote: "origin" }, worker: { id: "worker", name: "Fixture" }, localProjectId: local.id, presetIds: ["node:test"], callerPrincipalIds: [session.principalId], workerTokenFile: tokenFile }));
  const lines: string[] = [];
  await runRemoteVerificationCommand(["provision", "--file", file], paths, line => lines.push(line));
  const token = readRemoteWorkerToken(tokenFile);
  expect(lines.join("\n")).not.toContain(token);
  expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  const provisioned = JSON.parse(lines[0]) as { credentialId: string; workerPrincipalId: string };
  const reopened = new SqliteStateStore(paths.databasePath);
  const currentIdentity = new IdentityService(reopened);
  expect(currentIdentity.authenticateBearer(token)).toMatchObject({ principalId: provisioned.workerPrincipalId, authenticationMethod: "worker_token" });
  expect(reopened.getRemoteWorkerProjectGrant("worker", "project")?.presetIds).toEqual(["node:test"]);
  reopened.close();
  await runRemoteVerificationCommand(["revoke-token", "--credential-id", provisioned.credentialId], paths, () => undefined);
  const revoked = new SqliteStateStore(paths.databasePath);
  try { expect(() => new IdentityService(revoked).authenticateBearer(token)).toThrow(); }
  finally { revoked.close(); }
  expect(readFileSync(file, "utf8")).not.toContain(token);
  chmodSync(tokenFile, 0o644); expect(() => readRemoteWorkerToken(tokenFile)).toThrow("owner-only");
  chmodSync(tokenFile, 0o600); symlinkSync(tokenFile, join(root, "token-link")); expect(() => readRemoteWorkerToken(join(root, "token-link"))).toThrow();
});

it("inspects offline with a real owner session without creating evidence, updating credentials or changing SQLite bytes", async () => {
  const root = directory(), paths = resolveAppPaths(root);
  const store = new SqliteStateStore(paths.databasePath), identity = new IdentityService(store);
  const session = identity.bootstrapOwnerSession();
  store.remoteConnection.accept({ assignment: { attemptId: "legacy-attempt", requestId: "request", projectId: "project", workerId: "worker", presetId: "node:test", commitSha: "a".repeat(40) },
    localRunId: "missing-run", reports: [], acknowledgedSequence: 0, cancellationRequested: false });
  store.close(); vi.stubEnv("WORKTREE_CONTROL_OWNER_TOKEN", session.token);
  const before = readFileSync(paths.databasePath), lines: string[] = [];
  await runRemoteVerificationCommand(["inspect"], paths, line => lines.push(line));
  expect(JSON.parse(lines[0])).toEqual([expect.objectContaining({ attemptId: "legacy-attempt", blocked: true, recoverable: false, code: "recovery_provenance_missing" })]);
  expect(readFileSync(paths.databasePath)).toEqual(before);
  expect(lines.join("\n")).not.toContain(session.token);
  expect(existsSync(`${paths.databasePath}.worker-recovery-key`)).toBe(false);
  await expect(runRemoteVerificationCommand(["reconcile", "--attempt-id", "legacy-attempt", "--operation-id", "operation"], paths, () => undefined)).rejects.toThrow("recovery_provenance_missing");
});

it("rejects inspect and reconcile while the controller singleton lock is live", async () => {
  const root = directory(), paths = resolveAppPaths(root);
  const store = new SqliteStateStore(paths.databasePath), session = new IdentityService(store).bootstrapOwnerSession();
  store.close(); vi.stubEnv("WORKTREE_CONTROL_OWNER_TOKEN", session.token);
  const lock = acquireControllerLock(paths.controllerLockPath);
  try {
    await expect(runRemoteVerificationCommand(["inspect"], paths)).rejects.toThrow();
    await expect(runRemoteVerificationCommand(["reconcile", "--attempt-id", "attempt", "--operation-id", "operation"], paths)).rejects.toThrow();
  } finally { lock.release(); }
});

it("rejects agent, worker and install-wide credentials at the CLI boundary", async () => {
  const root = directory(), paths = resolveAppPaths(root), store = new SqliteStateStore(paths.databasePath);
  const identity = new IdentityService(store), owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
  const agent = identity.createAgent(owner), worker = identity.createWorker(owner);
  const tokens = [identity.issueAgentToken({ principalId: agent.id, label: "fixture" }, owner).token,
    identity.issueWorkerToken({ principalId: worker.id, label: "fixture" }, owner).token, new AuthenticationService(store).generateToken("fixture").token];
  store.close();
  for (const token of tokens) {
    vi.stubEnv("WORKTREE_CONTROL_OWNER_TOKEN", token);
    await expect(runRemoteVerificationCommand(["inspect"], paths)).rejects.toThrow();
    await expect(runRemoteVerificationCommand(["reconcile", "--attempt-id", "attempt", "--operation-id", "operation"], paths)).rejects.toThrow();
  }
  vi.stubEnv("WORKTREE_CONTROL_OWNER_TOKEN", "");
  await expect(runRemoteVerificationCommand(["inspect"], paths)).rejects.toThrow();
  await expect(runRemoteVerificationCommand(["reconcile", "--attempt-id", "attempt", "--operation-id", "operation", "--yes"], paths)).rejects.toThrow("invalid_recovery_arguments");
});
