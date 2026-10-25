import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
