import { rewindHumanRuntime } from "./fixtures/schema-rewind";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { IdentityService } from "@/server/modules/identity";
import { legacySourceEvidence } from "@/server/test-source-attribution";
import type { TestRun } from "@/shared/contracts";
import { SqliteStateStore } from "./sqlite-state-store";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { testRunRequesterChecksum, testRunRequesterMigration } from "./test-run-requester-migration";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "test-requester-migration-")); roots.push(root);
  const path = join(root, "state.sqlite3");
  const store = new SqliteStateStore(path);
  const identity = new IdentityService(store, undefined, undefined, undefined, undefined, store);
  const owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
  const agent = identity.createAgent(owner);
  const project = store.addProject({ name: "Kept", repositoryPath: "/code/kept", port: 3700, executable: "pnpm", args: [] });
  identity.setRuntimeDelegation({ principalId: agent.id, projectId: project.id, actions: ["projects:read"], expectedRevision: 0 }, owner);
  const issued = identity.issueRuntimeCredential({ principalId: agent.id, label: "old", projects: [{ projectId: project.id, actions: ["projects:read"] }] }, owner);
  const run: TestRun = { id: "run", projectId: project.id, worktreePath: "/code/kept", worktreeHead: "a", worktreeBranch: "main", worktreeDirty: false,
    presetId: "node:test", presetName: "test", adapter: "node", actor: "agent:mcp:original", phase: "passed", queuePosition: null,
    executable: "pnpm", args: ["test"], cwd: "/code/kept", queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    exitCode: 0, signal: null, error: null, logs: [], environmentMode: "clean", environmentProfile: "unit", inheritedServerProfile: null,
    environmentVariableNames: [], source: legacySourceEvidence() };
  const requester = { principalId: agent.id, credentialId: issued.credential.id, projectId: project.id, sessionOwner: run.actor, reservationId: null, leaseTokenHash: null };
  return { root, path, store, identity, issued, run, requester };
}

describe("test requester migration 44", () => {
  it("adds only an empty table after schema 43, rolls back together, and never backfills old jobs or ceilings", () => {
    const f = fixture(); f.store.saveTestRun(f.run, "kept"); f.store.close();
    const db = new Database(f.path);
    try {
      rewindHumanRuntime(db);
      db.exec("DROP TABLE runtime_human_memberships; DELETE FROM schema_migrations WHERE version=45; DROP TABLE test_run_requesters; DELETE FROM schema_migrations WHERE version=44");
      expect(inspectSchema(db).version).toBe(43);
      const run = db.prepare("SELECT * FROM test_runs").all();
      const scopes = db.prepare("SELECT * FROM runtime_credential_scopes").all();
      const registry = db.prepare("SELECT * FROM schema_migrations").all();
      expect(() => initializeSchema(db, false, () => { throw new Error("rollback"); })).toThrow("rollback");
      expect(inspectSchema(db).version).toBe(43);
      initializeSchema(db, false, inspectSchema);
      expect(inspectSchema(db).version).toBe(47);
      expect(db.prepare("SELECT * FROM test_runs").all()).toEqual(run.map(row => ({ ...(row as object), provider_bound: 0 })));
      expect(db.prepare("SELECT * FROM runtime_credential_scopes").all()).toEqual(scopes);
      expect(db.prepare("SELECT * FROM schema_migrations WHERE version<=43").all()).toEqual(registry);
      expect(db.prepare("SELECT * FROM test_run_requesters").all()).toEqual([]);
      expect(db.prepare("SELECT name,checksum FROM schema_migrations WHERE version=44").get()).toEqual({ name: testRunRequesterMigration.name, checksum: testRunRequesterChecksum });
    } finally { db.close(); }
  });

  it("atomically persists immutable bindings, preserves them across updates, backup, restore and retention cascade", async () => {
    const f = fixture();
    expect(() => f.store.saveTestRun(f.run, "key", { ...f.requester, projectId: "missing" })).toThrow();
    expect(f.store.getTestRun(f.run.id)).toBeNull();
    f.store.saveTestRun(f.run, "key", f.requester);
    expect(() => f.store.saveTestRun(f.run, "key", f.requester)).toThrow(/immutable/);
    f.store.saveTestRun({ ...f.run, exitCode: 42 });
    expect(f.store.getTestRunRequester("run")).toEqual(f.requester);
    const backup = join(f.root, "backup");
    await createControllerBackup(f.store, backup, { applicationVersion: "test", attachmentDirectory: join(f.root, "attachments") }); f.store.close();
    const path = join(f.root, "restored.sqlite3"); restoreControllerBackup(backup, path);
    const restored = new SqliteStateStore(path);
    try { expect(restored.getTestRunRequester("run")).toEqual(f.requester); expect(restored.getTestRun("run")?.exitCode).toBe(42); }
    finally { restored.close(); }
    const db = new Database(path);
    try {
      db.pragma("foreign_keys=ON"); db.prepare("DELETE FROM test_runs WHERE id='run'").run();
      expect(db.prepare("SELECT * FROM test_run_requesters").all()).toEqual([]);
    } finally { db.close(); }
  });

  it.each(["checksum", "binding", "premature-table"])("strictly refuses malformed %s without migration writes", mode => {
    const f = fixture(); f.store.saveTestRun(f.run, "key", f.requester); f.store.close();
    const db = new Database(f.path);
    if (mode === "checksum") db.exec("UPDATE schema_migrations SET checksum='wrong' WHERE version=44");
    if (mode === "binding") db.exec("UPDATE test_run_requesters SET session_owner='agent:mcp:forged'");
    if (mode === "premature-table") db.exec("DELETE FROM schema_migrations WHERE version=44");
    db.close();
    const before = readFileSync(f.path);
    expect(() => new SqliteStateStore(f.path)).toThrow(/schema|test requester binding/);
    expect(readFileSync(f.path)).toEqual(before);
  });
});
