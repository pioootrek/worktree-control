import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { finishBackupHandoff } from "@/server/modules/backups";
import { IdentityService } from "@/server/modules/identity";
import { leaseTokenHash } from "@/server/modules/lifecycle";
import { SqliteStateStore } from "./sqlite-state-store";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { runtimeAccessChecksum, runtimeAccessMigration } from "./runtime-access-migration";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "runtime-access-migration-")); roots.push(root);
  const path = join(root, "state.sqlite3");
  const store = new SqliteStateStore(path);
  const identity = new IdentityService(store, undefined, undefined, undefined, undefined, store);
  const ownerToken = identity.bootstrapOwnerSession().token;
  const owner = identity.authenticateBearer(ownerToken);
  const project = store.addProject({ name: "Kept", repositoryPath: "/code/kept", port: 3501, executable: "pnpm", args: ["run", "dev"] });
  const agent = identity.createAgent(owner);
  const generic = identity.issueAgentToken({ principalId: agent.id, label: "generic" }, owner).token;
  const lease = store.acquireReservation({
    projectId: project.id, worktreePath: "/code/kept", kind: "agent", owner: "agent:mcp:legacy", reason: "legacy",
    ttlSeconds: 600, maximumLifetimeSeconds: 1200, leaseTokenHash: leaseTokenHash("legacy-secret"), idempotencyKey: "legacy",
  });
  return { root, path, store, identity, owner, ownerToken, project, agent, generic, lease };
}

/** Recreates the exact version-35 shape: no runtime tables and no lease binding columns. */
function downgradeTo35(path: string): void {
  const db = new Database(path);
  try {
    db.pragma("foreign_keys = OFF");
    db.transaction(() => {
      db.exec("DROP TABLE runtime_credential_scopes; DROP TABLE runtime_delegations; DELETE FROM schema_migrations WHERE version=36");
      const table = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='reservations'").get() as { sql: string }).sql;
      const indexes = (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='reservations' AND sql IS NOT NULL").all() as Array<{ sql: string }>).map(x => x.sql);
      const original = table.replace(/,\s*principal_id TEXT REFERENCES remote_principals\(id\),\s*credential_id TEXT REFERENCES principal_credentials\(id\),\s*request_fingerprint TEXT/, "");
      if (original === table) throw new Error("Unexpected reservations DDL.");
      const columns = (db.prepare("PRAGMA table_info(reservations)").all() as Array<{ name: string }>).map(x => x.name)
        .filter(name => name !== "principal_id" && name !== "credential_id" && name !== "request_fingerprint").join(", ");
      db.exec(`ALTER TABLE reservations RENAME TO reservations_v36; ${original};
        INSERT INTO reservations(${columns}) SELECT ${columns} FROM reservations_v36; DROP TABLE reservations_v36;`);
      for (const index of indexes) db.exec(index);
    })();
  } finally { db.close(); }
}

describe("runtime access migration 36", () => {
  it("upgrades 35 atomically, backfills no grants and keeps existing leases unbound", () => {
    const f = fixture(); f.store.close();
    downgradeTo35(f.path);
    const db = new Database(f.path);
    try {
      expect(inspectSchema(db).version).toBe(35);
      const before = db.prepare("SELECT id, owner, token_hash, released_at FROM reservations").all();
      expect(() => initializeSchema(db, false, () => { throw new Error("late failure"); })).toThrow("late failure");
      expect(inspectSchema(db).version).toBe(35);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'runtime_%'").all()).toEqual([]);
      initializeSchema(db, false);
      expect(inspectSchema(db).version).toBe(36);
      expect(db.prepare("SELECT id, owner, token_hash, released_at FROM reservations").all()).toEqual(before);
      expect(db.prepare("SELECT principal_id, credential_id, request_fingerprint FROM reservations").all())
        .toEqual([{ principal_id: null, credential_id: null, request_fingerprint: null }]);
      expect(db.prepare("SELECT count(*) n FROM runtime_delegations").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) n FROM runtime_credential_scopes").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT name, checksum FROM schema_migrations WHERE version=36").get())
        .toEqual({ name: runtimeAccessMigration.name, checksum: runtimeAccessChecksum });
    } finally { db.close(); }
    const reopened = new SqliteStateStore(f.path);
    try {
      const identity = new IdentityService(reopened, undefined, undefined, undefined, undefined, reopened);
      const actor = identity.authenticateBearer(f.generic);
      expect(() => identity.authorizeRuntime(actor, f.project.id, "projects:read")).toThrow();
      // The compatibility lease is still usable by its unbound session, never by a credential-bound caller.
      expect(reopened.authorizeReservation(f.project.id, "agent:mcp:legacy", leaseTokenHash("legacy-secret"))?.id).toBe(f.lease.id);
      expect(() => reopened.authorizeReservation(f.project.id, "agent:mcp:legacy", leaseTokenHash("legacy-secret"),
        { principalId: f.agent.id, credentialId: actor.credentialId })).toThrow();
    } finally { reopened.close(); }
  });

  it("rejects tampered provenance and half-bound leases before writes", () => {
    const f = fixture(); f.store.close();
    const db = new Database(f.path);
    db.exec("UPDATE schema_migrations SET checksum='wrong' WHERE version=36"); db.close();
    const before = readFileSync(f.path);
    expect(() => new SqliteStateStore(f.path)).toThrow(/migration checksum/);
    expect(readFileSync(f.path)).toEqual(before);
    const repaired = new Database(f.path);
    repaired.prepare("UPDATE schema_migrations SET checksum=? WHERE version=36").run(runtimeAccessChecksum);
    repaired.prepare("UPDATE reservations SET principal_id=?").run(f.agent.id);
    repaired.close();
    expect(() => new SqliteStateStore(f.path)).toThrow(/lease binding/);
  });

  it("restores scope rows without reviving the credentials a full restore revokes", async () => {
    const f = fixture();
    const backup = join(f.root, "backup");
    let scopedToken = "";
    try {
      f.identity.setRuntimeDelegation({ principalId: f.agent.id, projectId: f.project.id, actions: ["projects:read"], expectedRevision: 0 }, f.owner);
      scopedToken = f.identity.issueRuntimeCredential({ principalId: f.agent.id, label: "scoped", projects: [{ projectId: f.project.id, actions: ["projects:read"] }] }, f.owner).token;
      await createControllerBackup(f.store, backup, { applicationVersion: "test", attachmentDirectory: join(f.root, "attachments") });
    } finally { f.store.close(); }
    const path = join(f.root, "restored.sqlite3");
    restoreControllerBackup(backup, path);
    const restored = new SqliteStateStore(path);
    try {
      finishBackupHandoff(path, { authentication: restored.getAuthenticationPolicy() } as unknown as Parameters<typeof finishBackupHandoff>[1], restored);
      const identity = new IdentityService(restored, undefined, undefined, undefined, undefined, restored);
      expect(restored.getRuntimeDelegation(f.agent.id, f.project.id)?.actions).toEqual(["projects:read"]);
      expect(() => identity.authenticateBearer(scopedToken)).toThrow();
      // Even a forged actor for the surviving scope row is denied: its credential is revoked.
      const credentialId = scopedToken.split("_")[1]!;
      expect(restored.listRuntimeCredentialScopes(credentialId)).toHaveLength(1);
      expect(() => identity.authorizeRuntime({ principalId: f.agent.id, principalKind: "agent", credentialId, authenticationMethod: "agent_token" },
        f.project.id, "projects:read")).toThrow();
    } finally { restored.close(); }
  });
});
