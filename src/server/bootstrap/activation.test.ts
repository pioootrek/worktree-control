import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAppPaths, type AppPaths } from "../paths";
import { createControllerBackup, restoreControllerBackup } from "../controller-backup";
import { AuthenticationService } from "../modules/authentication";
import { IdentityService } from "../modules/identity";
import { leaseTokenHash } from "../modules/lifecycle";
import { SqliteStateStore } from "../infrastructure/sqlite";
import { createFencedAt49, openStoreAt49 } from "../infrastructure/sqlite/fixtures/released-schema";
import { upgradeFixture } from "../infrastructure/sqlite/fixtures/protected-security";
import { maintainSecurityFence } from "./security-maintenance";
import { applyUpgrade, inspectUpgrade } from "./upgrade-maintenance";

/*
 * The activation seen through the product, at the default (supported) target
 * and ceilings: a schema-49 backup restored into an existing and an empty
 * installation (restore, resume, inspect, apply), the authority reset as the
 * application's services see it, and the structure of an upgraded database
 * against a fresh one. Every test runs full maintenance cycles: explicit 30 s
 * timeouts, since the hosted runner is about twice as slow as a workstation.
 */
const CYCLE = 30_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const installation = (name = "data"): AppPaths => { const root = mkdtempSync(join(tmpdir(), "activation-")); roots.push(root); return resolveAppPaths(join(root, name)); };
const raw = <T,>(paths: AppPaths, read: (database: Database.Database) => T): T => {
  const database = new Database(paths.databasePath, { readonly: true, fileMustExist: true });
  try { return read(database); } finally { database.close(); }
};
const version = (paths: AppPaths) => raw(paths, database => database.prepare("SELECT max(version) FROM schema_migrations").pluck().get() as number);
const marker = (paths: AppPaths) => raw(paths, database => database.prepare("SELECT state, plan_hash FROM upgrade_marker").get());
const code = (operation: () => unknown) => { try { operation(); } catch (error) { return (error as { code?: string }).code; } return "opened"; };
const open = (paths: AppPaths) => code(() => new SqliteStateStore(paths.databasePath).close());

describe("a schema-49 backup restored at the default ceilings", () => {
  it.each(["existing", "empty"])("is restored into an %s installation as 49, resumed to 53 pending, refused until the upgrade, then current", async destination => {
    const source = installation(), backup = join(source.dataDirectory, "..", "backup");
    const store = openStoreAt49(source.databasePath);
    try {
      store.addProject({ name: "Restored runtime", repositoryPath: "/code/restored", port: 3701, executable: "node", args: [] });
      await createControllerBackup(store, backup, { applicationVersion: "test", attachmentDirectory: source.knowledgeAttachmentDirectory });
    } finally { store.close(); }
    const target = installation();
    if (destination === "existing") new SqliteStateStore(target.databasePath).close();
    else mkdirSync(target.dataDirectory, { recursive: true, mode: 0o700 });
    // The real verified backup and the restore journal.
    restoreControllerBackup(backup, target.databasePath, target.knowledgeAttachmentDirectory);
    expect(version(target)).toBe(49);
    expect(open(target)).toBe("security_fence_recovery_required");
    const status = maintainSecurityFence(target, { action: "inspect" });
    expect(status).toMatchObject({ trusted: false, establishmentAllowed: false, schemaVersion: 49 });
    expect(maintainSecurityFence(target, { action: "resume", expect: status.preflight, mode: "token" })).toMatchObject({ trusted: true, quarantined: true, schemaVersion: 53 });
    expect(version(target)).toBe(53);
    expect(marker(target)).toEqual({ state: "pending", plan_hash: null });
    expect(open(target)).toBe("upgrade_required");
    const inspection = inspectUpgrade(target);
    expect(inspection).toMatchObject({ state: "upgrade_needed", schemaVersion: 53, target: 53, marker: "pending" });
    const result = await applyUpgrade(target, { expect: inspection.planHash! }, { directory: join(target.dataDirectory, "..", "maintenance"), applicationVersion: "test" });
    expect(result).toMatchObject({ state: "current", planHash: inspection.planHash, schemaVersion: 53 });
    expect(marker(target)).toEqual({ state: "complete", plan_hash: inspection.planHash });
    const restored = new SqliteStateStore(target.databasePath);
    try { expect(restored.listProjects().map(project => project.name)).toEqual(["Restored runtime"]); } finally { restored.close(); }
  }, CYCLE);
});

describe("the authority reset as the product sees it", () => {
  it("rejects every old credential, leaves old grants and scopes conferring nothing, releases claims, and keeps the installation token, policy, accounts, passwords and factors", async () => {
    const paths = installation(), store = openStoreAt49(paths.databasePath);
    let seeded: { installationToken: string; ownerToken: string; agentToken: string; scopedToken: string; workerToken: string; agentId: string; projectId: string; runtimeId: string; ownerId: string };
    try {
      const authentication = new AuthenticationService(store), installationToken = authentication.generateToken("local-cli").token;
      const identity = new IdentityService(store, undefined, undefined, undefined, undefined, store);
      const ownerToken = identity.bootstrapOwnerSession().token, owner = identity.authenticateBearer(ownerToken);
      const project = identity.createKnowledgeProject({ name: "Kept knowledge" }, owner), agent = identity.createAgent(owner);
      identity.setKnowledgeGrant({ principalId: agent.id, projectId: project.id, permissions: ["knowledge:read"] }, owner);
      const agentToken = identity.issueAgentToken({ principalId: agent.id, label: "old" }, owner).token;
      const runtime = store.addProject({ name: "Kept runtime", repositoryPath: "/code/kept-runtime", port: 3702, executable: "node", args: [] });
      identity.setRuntimeDelegation({ principalId: agent.id, projectId: runtime.id, actions: ["projects:read"], expectedRevision: 0 }, owner);
      const scopedToken = identity.issueRuntimeCredential({ principalId: agent.id, label: "scoped", projects: [{ projectId: runtime.id, actions: ["projects:read"] }] }, owner).token;
      const worker = identity.createWorker(owner), workerToken = identity.issueWorkerToken({ principalId: worker.id, label: "worker" }, owner).token;
      store.acquireReservation({ projectId: runtime.id, worktreePath: "/code/kept-runtime", kind: "agent", owner: "agent:mcp:old", reason: "old claim",
        ttlSeconds: 600, maximumLifetimeSeconds: 1200, leaseTokenHash: leaseTokenHash("old-claim"), idempotencyKey: "old-claim" });
      // A provider account with a password and a TOTP factor, written on the store's own guarded handle.
      (store as unknown as { database: Database.Database }).database.exec(`
        INSERT INTO authentication_ba_user(id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled) VALUES('subject','Owner','owner@fixture.invalid',0,'now','now',1);
        INSERT INTO authentication_ba_account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES('account','subject','credential','subject','password-hash','now','now');
        INSERT INTO authentication_provider_subjects(provider_id,subject,principal_id,status,linked_at,revoked_at) VALUES('better-auth','subject','${owner.principalId}','active','2026-11-01T00:00:00.000Z',NULL);
        INSERT INTO authentication_account_policies VALUES('better-auth','subject',1,1,1,0,'2026-11-01T00:00:00.000Z');
        INSERT INTO authentication_ba_two_factor(id,secret,backupCodes,userId,verified) VALUES('factor','ciphertext','codes','subject',1);`);
      seeded = { installationToken, ownerToken, agentToken, scopedToken, workerToken, agentId: agent.id, projectId: project.id, runtimeId: runtime.id, ownerId: owner.principalId };
    } finally { store.close(); }
    const kept = () => raw(paths, database => Object.fromEntries(["authentication_ba_user", "authentication_ba_account", "authentication_ba_two_factor", "authentication_provider_subjects", "authentication_account_policies", "knowledge_history"]
      .map(table => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
    const before = kept(), policy = raw(paths, database => database.prepare("SELECT value_json FROM controller_settings WHERE key='authentication'").pluck().get());
    expect(await upgradeFixture(paths.databasePath)).toMatch(/^[0-9a-f]{64}$/);
    expect(kept()).toEqual(before);
    expect(raw(paths, database => database.prepare("SELECT value_json FROM controller_settings WHERE key='authentication'").pluck().get())).toBe(policy);
    // The six old grant tables: every row is revoked; claims are released.
    raw(paths, database => {
      for (const table of ["knowledge_project_grants", "knowledge_role_bindings", "runtime_delegations", "runtime_human_memberships", "remote_principal_project_grants", "remote_worker_project_grants"]) {
        expect(database.prepare(`SELECT count(*) FROM ${table} WHERE revoked_at IS NULL`).pluck().get(), table).toBe(0);
      }
      expect(database.prepare("SELECT count(*) FROM knowledge_project_grants").pluck().get()).toBe(1);
      expect(database.prepare("SELECT count(*) FROM runtime_credential_scopes").pluck().get()).toBe(1);
      expect(database.prepare("SELECT count(*) FROM reservations WHERE released_at IS NULL").pluck().get()).toBe(0);
      expect(database.prepare("SELECT count(*) FROM principal_credentials WHERE status='active'").pluck().get()).toBe(0);
    });
    const store2 = new SqliteStateStore(paths.databasePath);
    try {
      const identity = new IdentityService(store2, undefined, undefined, undefined, undefined, store2), authentication = new AuthenticationService(store2);
      for (const token of [seeded.ownerToken, seeded.agentToken, seeded.scopedToken, seeded.workerToken]) expect(() => identity.authenticateBearer(token)).toThrow();
      // The installation token and the mode are kept.
      expect(authentication.verifyInstallationToken(seeded.installationToken)).toBe(true);
      expect(store2.getAuthenticationPolicy().mode).toBe("token");
      // A new owner session, then a new agent credential without a new grant: still denied (the grant reset is separate from the token reset).
      const owner = identity.authenticateBearer(identity.recoverOwnerSession().token);
      const fresh = identity.authenticateBearer(identity.issueAgentToken({ principalId: seeded.agentId, label: "new" }, owner).token);
      expect(() => identity.authorizeKnowledge(fresh, seeded.projectId, "knowledge:read")).toThrow();
      expect(() => identity.authorizeRuntime(fresh, seeded.runtimeId, "projects:read")).toThrow();
      // An explicit new grant gives access again.
      identity.setKnowledgeGrant({ principalId: seeded.agentId, projectId: seeded.projectId, permissions: ["knowledge:read"] }, owner);
      expect(() => identity.authorizeKnowledge(fresh, seeded.projectId, "knowledge:read")).not.toThrow();
    } finally { store2.close(); }
  }, CYCLE);
});

describe("a fresh and an upgraded database", () => {
  it("have the same tables, indexes, triggers and migration checksums; only the marker's plan hash tells them apart", async () => {
    const fresh = installation(), upgraded = installation();
    new SqliteStateStore(fresh.databasePath).close();
    createFencedAt49(upgraded.databasePath);
    const planHash = await upgradeFixture(upgraded.databasePath);
    const structure = (paths: AppPaths) => raw(paths, database => ({
      catalogue: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      migrations: database.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all(),
    }));
    expect(structure(upgraded)).toEqual(structure(fresh));
    expect(marker(fresh)).toEqual({ state: "complete", plan_hash: null });
    expect(marker(upgraded)).toEqual({ state: "complete", plan_hash: planHash });
    for (const paths of [fresh, upgraded]) expect(open(paths)).toBe("opened");
  }, CYCLE);
});
