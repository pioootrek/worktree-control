import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "@/server/sqlite-store";
import { AuthenticationService } from "@/server/modules/authentication";
import { IdentityService } from "@/server/modules/identity";
import { BackupOperations } from "./backup-operations";
import { backupPolicySchema } from "./policy";
import { RestoreOperations, recoverBackupHandoff, finishBackupHandoff, assertBackupHandoffCompleted } from "./restore-operations";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(restartFailure?: string) {
  const root = mkdtempSync(join(dirname(process.cwd()), ".s4a-restore-")), database = join(root, "state.sqlite3"), attachments = join(root, "attachments");
  const store = new SqliteStateStore(database), authentication = new AuthenticationService(store);
  const oldToken = authentication.generateToken("fixture").token;
  const identity = new IdentityService(store, undefined, undefined, undefined, authentication);
  const owner = identity.bootstrapOwnerSession();
  const actor = authentication.authenticateInstallation(oldToken)!;
  store.addProject({ name: "Before", repositoryPath: root, port: 4400, executable: "node", args: [] });
  const policy = backupPolicySchema.parse({ directory: join(root, "copies"), uiActions: ["create", "restore"] });
  let maintenance = false;
  const backups = new BackupOperations(policy, { databasePath: database, attachmentDirectory: attachments, applicationVersion: "fixture", source: store, estimateBytes: () => store.backupEstimateBytes(), authorize: actor => authentication.isCurrentInstallationActor(actor), maintenance: () => maintenance });
  const backup = backups.create(actor, "copy"); await backups.drain();
  const newToken = authentication.rotateToken("fixture").token;
  const current = authentication.authenticateInstallation(newToken)!;
  store.addProject({ name: "After", repositoryPath: join(root, "second"), port: 4401, executable: "node", args: [] });
  const failure = vi.fn();
  let work: (() => void) | null = null;
  const restores = new RestoreOperations(backups, database, attachments, { authentication: () => store.getAuthenticationPolicy(), enterMaintenance: () => { maintenance = true; }, restart: async execute => { if (restartFailure) throw new Error(restartFailure); work = execute; }, failure });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => store.close(), () => backups.close());
  const input = { action: "restore", backupId: backup.backupId, idempotencyKey: "restore-one", confirmation: "replace-entire-installation" };
  return { root, database, attachments, store, policy, backups, restores, current, input, authentication, oldToken, newToken, owner, failure, execute: () => { if (!work) throw new Error("No handoff"); work(); } };
}
describe("operator restore orchestration", () => {
  it("coalesces simultaneous admission, bounds previews and reauthorizes after validation", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const verify = f.backups.catalog.verifyAsync.bind(f.backups.catalog);
    const validation = vi.spyOn(f.backups.catalog, "verifyAsync").mockImplementation(async id => { await gate; return verify(id); });
    const first = f.restores.admit(f.current, f.input), duplicate = f.restores.admit(f.current, f.input);
    await expect(f.restores.admit(f.current, { ...f.input, idempotencyKey: "other" })).rejects.toThrow("backup_busy");
    await expect(f.restores.preview(f.current, f.input.backupId)).rejects.toThrow("backup_busy");
    expect(validation).toHaveBeenCalledOnce();
    expect(f.store.listProjects()).toHaveLength(2);
    release();
    expect(await duplicate).toEqual(await first);
  });
  it.each(["preview", "admit"] as const)("refuses revoked access after asynchronous %s validation", async action => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const verify = f.backups.catalog.verifyAsync.bind(f.backups.catalog);
    vi.spyOn(f.backups.catalog, "verifyAsync").mockImplementation(async id => { await gate; return verify(id); });
    const pending = action === "preview" ? f.restores.preview(f.current, f.input.backupId) : f.restores.admit(f.current, f.input);
    const rejection = expect(pending).rejects.toThrow("backup_forbidden");
    f.authentication.rotateToken("fixture"); release(); await rejection;
    expect(existsSync(join(`${f.database}.backup-operations`, "handoff.json"))).toBe(false);
    expect(f.store.listProjects()).toHaveLength(2);
  });
  it("previews entire-installation effects and persists admission before entering maintenance", async () => {
    const f = await fixture();
    expect(await f.restores.preview(f.current, f.input.backupId)).toMatchObject({ scope: "entire-installation", invalidatesScopedCredentials: true, stopsManagedProcessesAndTests: true });
    const accepted = await f.restores.admit(f.current, f.input);
    expect(existsSync(`${f.database}.restore-requests`)).toBe(true);
    expect(f.store.listProjects()).toHaveLength(2);
    expect(await f.restores.admit(f.current, f.input)).toEqual(accepted);
    expect(() => f.backups.create(f.current, "during-maintenance")).toThrow("backup_busy");
    await expect(f.restores.admit(f.current, { ...f.input, idempotencyKey: "overlap" })).rejects.toThrow("backup_busy");
  });
  it("refuses replacement with an open owner then repairs the same request under handoff ownership", async () => {
    const f = await fixture(); const accepted = await f.restores.admit(f.current, f.input);
    f.restores.launch(f.current, f.input);
    expect(() => f.execute()).toThrow(/already running/);
    expect(() => assertBackupHandoffCompleted(f.database)).toThrow("complete restore authentication recovery");
    expect(f.store.listProjects()).toHaveLength(2);
    await f.backups.close(); f.store.close();
    const handoff = recoverBackupHandoff(f.database, f.attachments, f.policy)!;
    expect(handoff.operationId).toBe(accepted.operationId);
    const restored = new SqliteStateStore(f.database);
    try {
      finishBackupHandoff(f.database, handoff, restored);
      expect(() => assertBackupHandoffCompleted(f.database)).not.toThrow();
      const auth = new AuthenticationService(restored), identity = new IdentityService(restored, undefined, undefined, undefined, auth);
      expect(auth.authenticateInstallation(f.oldToken)).toBeNull();
      expect(auth.authenticateInstallation(f.newToken)).not.toBeNull();
      expect(() => identity.authenticateBearer(f.owner.token)).toThrow();
      expect(restored.listProjects().map(p => p.name)).toEqual(["Before"]);
      restored.addProject({ name: "Post-restore", repositoryPath: join(f.root, "post"), port: 4402, executable: "node", args: [] });
    } finally { restored.close(); }
    expect(recoverBackupHandoff(f.database, f.attachments, f.policy)).toBeNull();
    const reopened = new SqliteStateStore(f.database);
    try { expect(reopened.listProjects()).toHaveLength(2); }
    finally { reopened.close(); }
  });
  it("accounts for a crash before maintenance/handoff without replacing the old database", async () => {
    const f = await fixture(); const accepted = await f.restores.admit(f.current, f.input);
    await f.backups.close(); f.store.close();
    expect(recoverBackupHandoff(f.database, f.attachments, f.policy)).toBeNull();
    const reopened = new SqliteStateStore(f.database);
    try { expect(reopened.listProjects()).toHaveLength(2); }
    finally { reopened.close(); }
    expect(accepted.state).toBe("requested");
  });
  it("rechecks revoked operator authority and never hands off using historical grants", async () => {
    const f = await fixture(); await f.restores.admit(f.current, f.input);
    f.authentication.rotateToken("fixture");
    f.restores.launch(f.current, f.input);
    expect(f.failure).toHaveBeenCalledOnce();
    expect(() => f.execute()).toThrow("No handoff");
    expect(() => f.restores.status(f.current, f.input.backupId, f.input.idempotencyKey)).toThrow("backup_forbidden");
    expect(f.store.listProjects()).toHaveLength(2);
  });
  it("refuses an executing handoff when restart CLI disables restore", async () => {
    const f = await fixture(); await f.restores.admit(f.current, f.input); f.restores.launch(f.current, f.input);
    await f.backups.close(); f.store.close(); f.execute();
    expect(() => recoverBackupHandoff(f.database, f.attachments, { ...f.policy, uiActions: [] })).toThrow("backup_forbidden");
  });
  it("preserves live data and a failed receipt when maintenance cleanup cannot be verified", async () => {
    const f = await fixture("fixture: owned process stop unconfirmed");
    await f.restores.admit(f.current, f.input); f.restores.launch(f.current, f.input);
    await vi.waitFor(() => expect(f.failure).toHaveBeenCalledOnce());
    expect(() => f.execute()).toThrow("No handoff");
    expect(f.restores.status(f.current, f.input.backupId, f.input.idempotencyKey).state).toBe("failed");
    expect(f.store.listProjects()).toHaveLength(2);
  });
});
