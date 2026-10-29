import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticationService } from "@/server/modules/authentication";
import { BackupOperations, backupPolicySchema, RestoreOperations, UserSchedules, userBackupPolicySchema } from "@/server/modules/backups";
import { userScheduleMutationKey } from "@/shared/contracts/user-backups";
import type { ProofFaultInjection } from "../src/index";
import { cleanupStrictRoots, closeStrictProof, pauseProvisioning, sleep, strictProof } from "./strict-fixture";

afterEach(cleanupStrictRoots);
describe("strict scheduled export and restore callbacks", () => {
  it.each([false, true])("admits automatic schedule ticks after the provider and rechecks export authority (revoked=%s)", async revoked => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults);
    const project = await f.run(() => {
      const project = f.identity.createKnowledgeProject({ name: "schedule fixture" }, f.ownerActor);
      f.identity.setKnowledgeGrant({ principalId: f.owner.principalId, projectId: project.id, permissions: ["knowledge:read", "knowledge:export"] }, f.ownerActor);
      return project;
    });
    let now = Date.now();
    const backups = new BackupOperations(backupPolicySchema.parse({ directory: join(f.root, "copies") }), { source: f.store, databasePath: f.path, attachmentDirectory: join(f.root, "attachments"), applicationVersion: "test", estimateBytes: () => f.store.backupEstimateBytes(), authorize: () => true, maintenance: () => false, admission: f.store.admission });
    const exported = vi.fn((id: string, bytes: number) => f.store.exportUserDiscussions(id, bytes));
    const schedules = await f.run(() => new UserSchedules(userBackupPolicySchema.parse({ enabled: true, scopes: ["knowledge-discussions"], projects: [project.id], targets: [{ id: "local", directory: join(f.root, "exports") }], minIntervalSeconds: 60 }), backups, {
      authorize: (actor, id) => { f.identity.describeIdentity(actor); if (id) { f.identity.authorizeKnowledge(actor, id, "knowledge:read"); f.identity.authorizeKnowledge(actor, id, "knowledge:export"); } },
      projectName: id => f.store.getKnowledgeProject(id)?.name ?? null, exportDiscussions: exported, clock: () => now,
    }));
    const id = randomUUID();
    await f.run(() => schedules.command(f.ownerActor, { action: "save", id, version: 0,
      idempotencyKey: userScheduleMutationKey(schedules.overview(f.ownerActor).mutationGeneration, id, 0, randomUUID()),
      configuration: { projectId: project.id, scope: "knowledge-discussions", targetId: "local", enabled: true, intervalSeconds: 60, retainCount: 2, retainDays: 30 } }));
    now += 60_000;
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused;
      const revocation = revoked ? f.run(() => f.identity.revokeKnowledgeGrant(f.owner.principalId, project.id, f.ownerActor)) : Promise.resolve();
      schedules.start(); // Real timer entry supplies its own detached admission.
      await sleep(20); expect(exported).not.toHaveBeenCalled();
      hold.resume(); await hold.pending; await revocation;
      const ledgerPath = join(backups.recordDirectory, "user-schedules.json");
      await vi.waitFor(() => {
        const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")).payload;
        expect(ledger.executions[0]?.state).toBe(revoked ? "denied" : "succeeded");
      });
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")).payload;
      expect(ledger.executions).toHaveLength(1); expect(exported).toHaveBeenCalledTimes(revoked ? 0 : 1);
      expect(existsSync(ledger.executions[0].destination)).toBe(!revoked);
    } finally { hold.resume(); await hold.pending; schedules.close(); await backups.close(); await closeStrictProof(f); }
  });

  it.each(["revoked", "cleanup_unconfirmed"] as const)("reauthorizes a response-completion restore launch and preserves ownership on %s", async mode => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults);
    const authentication = new AuthenticationService(f.store);
    const actor = await f.run(() => authentication.authenticateInstallation(authentication.generateToken("fixture").token)!);
    const backups = new BackupOperations(backupPolicySchema.parse({ directory: join(f.root, "copies"), uiActions: ["create", "restore"] }), { source: f.store, databasePath: f.path, attachmentDirectory: join(f.root, "attachments"), applicationVersion: "test", estimateBytes: () => f.store.backupEstimateBytes(), authorize: actor => authentication.isCurrentInstallationActor(actor), maintenance: () => false, admission: f.store.admission });
    const copy = await f.run(() => backups.create(actor, "fixture-copy")); await backups.drain();
    const input = { action: "restore", backupId: copy.backupId, idempotencyKey: "restore-fixture", confirmation: "replace-entire-installation" };
    const failure = vi.fn(), restart = vi.fn(async (execute: () => void) => { void execute; throw new Error("cleanup_unconfirmed"); });
    const restores = new RestoreOperations(backups, f.path, join(f.root, "attachments"), { authentication: () => f.store.getAuthenticationPolicy(), enterMaintenance: () => undefined, restart, failure });
    await f.run(() => restores.admit(actor, input)); // Arrange the durable admission as the HTTP request would.
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused;
      const revoke = mode === "revoked" ? f.run(() => authentication.rotateToken("fixture")) : Promise.resolve();
      restores.launch(actor, input); // Actual response-completion entry, outside any core scope.
      await sleep(20); expect(restart).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled();
      hold.resume(); await hold.pending; await revoke;
      await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
      expect(restart).toHaveBeenCalledTimes(mode === "revoked" ? 0 : 1);
      expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
      const handoff = JSON.parse(readFileSync(join(backups.recordDirectory, "handoff.json"), "utf8")).payload;
      expect(handoff.state).toBe("failed");
      expect(await f.run(() => f.store.listProjects())).toEqual([]);
    } finally { hold.resume(); await hold.pending; await backups.close(); await closeStrictProof(f); }
  });
});
