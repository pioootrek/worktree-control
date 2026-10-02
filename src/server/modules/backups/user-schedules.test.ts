import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import { IdentityService } from "@/server/modules/identity";
import { KnowledgeService } from "@/server/modules/knowledge";
import type { UserSchedule, UserScheduleCommand } from "@/shared/contracts/user-backups";
import { BackupOperations, backupPolicySchema, UserSchedules, userBackupPolicySchema } from "./index";
import { readRecord, recordHash, writeRecord } from "./records";
import { z } from "zod";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(userOptions: Record<string, unknown> = {}, serviceOptions: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "user-schedules-"));
  const store = new SqliteStateStore(join(root, "state.sqlite3")), identity = new IdentityService(store);
  const credential = identity.bootstrapOwnerSession(), owner = identity.authenticateBearer(credential.token);
  const project = identity.createKnowledgeProject({ name: "Allowed discussions" }, owner);
  identity.setKnowledgeGrant({ projectId: project.id, principalId: owner.principalId, permissions: ["knowledge:read", "knowledge:write", "knowledge:export"] }, owner);
  const agent = identity.createAgent(owner), token = identity.issueAgentToken({ principalId: agent.id, label: "other user" }, owner), other = identity.authenticateBearer(token.token);
  identity.setKnowledgeGrant({ projectId: project.id, principalId: agent.id, permissions: ["knowledge:read", "knowledge:export"] }, owner);
  const knowledge = new KnowledgeService(store, identity);
  const thread = knowledge.createThread(project.id, { title: "Visible topic", body: "Visible content" }, { idempotencyKey: "thread" }, owner);
  let now = Date.now(), maintenance = false, failExport = false;
  const backups = new BackupOperations(backupPolicySchema.parse({ directory: join(root, "service"), ...serviceOptions }), { source: store, databasePath: join(root, "state.sqlite3"), attachmentDirectory: join(root, "attachments"), applicationVersion: "test", estimateBytes: () => store.backupEstimateBytes(), authorize: () => true, maintenance: () => maintenance, clock: () => now });
  const policy = userBackupPolicySchema.parse({ enabled: true, scopes: ["knowledge-discussions"], projects: [project.id], targets: [{ id: "local", directory: join(root, "exports") }], minIntervalSeconds: 60, ...userOptions });
  const deps = { authorize: (actor: typeof owner, id?: string) => { identity.describeIdentity(actor); if (id) { identity.authorizeKnowledge(actor, id, "knowledge:read"); identity.authorizeKnowledge(actor, id, "knowledge:export"); } }, projectName: (id: string) => store.getKnowledgeProject(id)?.name ?? null, exportDiscussions: (id: string, budget: number) => { if (failExport) throw new Error("injected failure"); return store.exportUserDiscussions(id, budget); }, clock: () => now };
  const schedules = new UserSchedules(policy, backups, deps);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }), () => store.close(), () => backups.close(), () => schedules.close());
  const input = (id = randomUUID(), version = 0): Extract<UserScheduleCommand, { action: "save" }> => ({ action: "save", id, version, idempotencyKey: randomUUID(), configuration: { projectId: project.id, scope: "knowledge-discussions", targetId: "local", enabled: true, intervalSeconds: 60, retainCount: 2, retainDays: 30 } });
  const save = (command = input(), actor = owner) => schedules.command(actor, command) as UserSchedule;
  return { root, store, identity, owner, other, project, thread, knowledge, backups, schedules, policy, deps, input, save, advance: (ms = 60_000) => { now += ms; }, maintain: () => { maintenance = true; }, fail: () => { failExport = true; } };
}
describe("independent user export schedules", () => {
  it("defaults off without enabling service automation", async () => {
    const f = fixture({ enabled: false }); expect(f.schedules.overview(f.owner).policy.enabled).toBe(false);
    expect(() => f.save()).toThrow("policy"); f.advance(); f.schedules.tick(); await f.backups.drain();
    expect(f.schedules.overview(f.owner).artifacts).toEqual([]);
    expect(f.backups.overview("local-admin").schedule.nextAt).toBeNull();
  });
  it("runs user exports with the service schedule disabled and disabling users leaves service deadlines alone", async () => {
    const f = fixture({}, { intervalSeconds: 60 }); const before = f.backups.overview("local-admin").schedule.nextAt;
    const command = f.input(); f.save(command); f.save({ ...command, version: 1, idempotencyKey: "disable", configuration: { ...command.configuration, enabled: false } });
    expect(f.backups.overview("local-admin").schedule.nextAt).toBe(before);
    const g = fixture(); g.save(); g.advance(); g.schedules.tick(); await g.backups.drain();
    expect(g.schedules.overview(g.owner).artifacts[0].state).toBe("succeeded");
    expect(g.backups.overview("local-admin").schedule.lastOperation).toBeNull();
  });
  it("derives ownership, rejects foreign IDs, unknown projects/targets and injected policy fields", async () => {
    const f = fixture(); const command = f.input(), saved = f.save(command);
    expect(saved.ownerId).toBe(f.owner.principalId); expect(f.schedules.overview(f.other).schedules).toEqual([]);
    expect(() => f.save({ ...command, version: 1, idempotencyKey: "steal" }, f.other)).toThrow("forbidden");
    for (const patch of [{ projectId: "foreign" }, { targetId: "foreign" }, { intervalSeconds: 59 }, { retainCount: 11 }]) expect(() => f.save({ ...f.input(), configuration: { ...command.configuration, ...patch } })).toThrow();
    expect(() => f.schedules.command(f.owner, { ...f.input(), ownerId: "foreign" } as UserScheduleCommand)).toThrow("invalid");
    expect(() => f.schedules.command(f.owner, { ...f.input(), maxBytes: 1 } as UserScheduleCommand)).toThrow("invalid");
    f.advance(); f.schedules.tick(); await f.backups.drain();
    const run = f.schedules.overview(f.owner).artifacts[0];
    expect(() => f.schedules.command(f.other, { action: "artifact", executionId: run.executionId })).toThrow("forbidden");
    expect(() => f.schedules.command(f.other, { action: "status", idempotencyKey: command.idempotencyKey })).toThrow("invalid");
  });
  it("exports only allowlisted discussion fields, excluding raw history, identities, secrets and another project", async () => {
    const f = fixture(); const otherProject = f.identity.createKnowledgeProject({ name: "OTHER TENANT" }, f.owner);
    f.identity.setKnowledgeGrant({ projectId: otherProject.id, principalId: f.owner.principalId, permissions: ["knowledge:write"] }, f.owner);
    f.knowledge.createThread(otherProject.id, { title: "OTHER SECRET", body: "OTHER CONTENT" }, { idempotencyKey: "other" }, f.owner);
    f.save(); f.advance(); f.schedules.tick(); await f.backups.drain();
    const run = f.schedules.overview(f.owner).artifacts[0], artifact = f.schedules.command(f.owner, { action: "artifact", executionId: run.executionId });
    const serialized = JSON.stringify(artifact);
    expect(serialized).toContain("Visible content");
    for (const forbidden of ["OTHER TENANT", "OTHER CONTENT", "verifierHash", "created_by", "importSources", "history", "requiredPrincipals", "attachments", "actor", "credentialId"]) expect(serialized).not.toContain(forbidden);
    expect(Object.keys((artifact as { data: Record<string, unknown> }).data).sort()).toEqual(["project", "replies", "threads"]);
  });
  it("requires both export/read grants and blocks revoked principals and installation identities", () => {
    const f = fixture(); f.identity.setKnowledgeGrant({ projectId: f.project.id, principalId: f.other.principalId, permissions: ["knowledge:export"] }, f.owner);
    expect(() => f.save(f.input(), f.other)).toThrow("forbidden");
    expect(() => f.schedules.overview({ ...f.owner, principalKind: "installation", authenticationMethod: "installation_token" })).toThrow("forbidden");
    f.identity.revokeAgent(f.other.principalId, f.owner); expect(() => f.schedules.overview(f.other)).toThrow("forbidden");
  });
  it("rechecks grants after queuing and prevents artifact reads after grant removal", async () => {
    const f = fixture(); let release!: () => void;
    f.backups.enqueueExport("blocking", 1, () => new Promise<void>(resolve => { release = resolve; }), () => {});
    await Promise.resolve(); f.save(); f.advance(); f.schedules.tick();
    f.identity.revokeKnowledgeGrant(f.owner.principalId, f.project.id, f.owner);
    release(); await f.backups.drain();
    expect(f.schedules.overview(f.owner).schedules[0].reason).toBe("forbidden");
    const ledger = JSON.parse(readFileSync(join(f.backups.recordDirectory, "user-schedules.json"), "utf8")).payload;
    expect(ledger.executions[0]).toMatchObject({ state: "failed", reason: "forbidden" }); expect(existsSync(ledger.executions[0].destination)).toBe(false);
  });
  it("chooses a queued service backup before user work, preserves active work and enforces per-user capacity", async () => {
    const f = fixture({ queueLimit: 1 }, { intervalSeconds: 60, queueLimit: 4 }); const order: string[] = []; let release!: () => void;
    f.backups.enqueueExport("blocking", 1, () => { order.push("active"); return new Promise<void>(resolve => { release = resolve; }); }, () => {});
    await Promise.resolve(); f.save(); f.save(); f.advance(); f.schedules.tick(); f.backups.tick();
    const original = f.deps.exportDiscussions; f.deps.exportDiscussions = (...args) => { order.push("user"); expect(f.backups.overview("local-admin").schedule.lastOperation?.state).toBe("succeeded"); return original(...args); };
    release(); await f.backups.drain();
    expect(order).toEqual(["active", "user"]);
    expect(f.schedules.overview(f.owner).schedules.map(value => value.lastResult?.state).sort()).toEqual(["denied", "succeeded"]);
  });
  it("retains mutation keys across restart, rejects conflicting payloads and advances one overdue slot", async () => {
    const f = fixture(); const command = f.input(); const before = f.save(command); expect(f.save(command).version).toBe(before.version);
    expect(() => f.save({ ...command, configuration: { ...command.configuration, retainCount: 1 } })).toThrow("changed");
    f.advance(86400_000); f.schedules.tick(); await f.backups.drain(); f.schedules.close();
    const restarted = new UserSchedules(f.policy, f.backups, f.deps); cleanup.push(() => restarted.close());
    expect((restarted.command(f.owner, command) as UserSchedule).version).toBe(1); restarted.tick(); await f.backups.drain();
    expect(restarted.overview(f.owner).artifacts).toHaveLength(1);
    f.advance(86400_000); restarted.tick(); await f.backups.drain(); expect(restarted.overview(f.owner).artifacts).toHaveLength(2);
  });
  it("configuration edits invalidate queued versions and reset the future deadline", async () => {
    const f = fixture(); let release!: () => void;
    f.backups.enqueueExport("block", 1, () => new Promise<void>(resolve => { release = resolve; }), () => {}); await Promise.resolve();
    const command = f.input(); f.save(command); f.advance(); f.schedules.tick();
    const changed = f.save({ ...command, version: 1, idempotencyKey: "edit", configuration: { ...command.configuration, intervalSeconds: 120 } });
    release(); await f.backups.drain(); expect(changed.nextAt).toBe(new Date(f.deps.clock() + 120_000).toISOString());
    expect(f.schedules.overview(f.owner).artifacts[0]).toMatchObject({ state: "failed", reason: "changed" });
  });
  it("retention deletes only matching schedule artifacts and disabling retains every copy", async () => {
    const f = fixture(); const a = f.input(), b = f.input(); a.configuration.retainCount = 1; f.save(a); f.save(b, f.other);
    f.advance(); f.schedules.tick(); await f.backups.drain();
    const first = f.schedules.overview(f.owner).artifacts[0]; const other = f.schedules.overview(f.other).artifacts[0];
    const unknown = join(f.root, "exports", "pre-migration-v1-protected.json"); writeFileSync(unknown, "protected", { mode: 0o600 });
    f.advance(); f.schedules.tick(); await f.backups.drain();
    expect(existsSync(join(f.root, "exports", `user-export-${first.executionId}.json`))).toBe(false);
    expect(existsSync(join(f.root, "exports", `user-export-${other.executionId}.json`))).toBe(true); expect(readFileSync(unknown, "utf8")).toBe("protected");
    f.save({ ...a, version: 1, idempotencyKey: "off", configuration: { ...a.configuration, enabled: false } });
    const latest = f.schedules.overview(f.owner).artifacts.find(value => value.artifactAvailable)!;
    f.advance(86400_000 * 60); f.schedules.tick(); await f.backups.drain(); expect(existsSync(join(f.root, "exports", `user-export-${latest.executionId}.json`))).toBe(true);
  });
  it("restore-era credential invalidation requires reactivation without replaying prior deadlines", async () => {
    const f = fixture(); const command = f.input(); f.save(command); f.advance(); f.schedules.tick(); await f.backups.drain();
    f.identity.revokeCredential(f.owner.credentialId, f.owner); f.advance(); f.schedules.tick(); await f.backups.drain();
    const fresh = f.identity.authenticateBearer(f.identity.recoverOwnerSession().token);
    expect(f.schedules.overview(fresh).schedules[0].reason).toBe("forbidden");
    const reactivated = f.save({ ...command, version: 1, idempotencyKey: "revalidate" }, fresh);
    expect(reactivated.version).toBe(2); expect(reactivated.nextAt).toBe(new Date(f.deps.clock() + 60_000).toISOString());
    expect(f.schedules.overview(fresh).artifacts.filter(value => value.state === "succeeded")).toHaveLength(1);
  });
  it("records export failure and maintenance denial without a complete artifact", async () => {
    const f = fixture(); f.save(); f.fail(); f.advance(); f.schedules.tick(); await f.backups.drain();
    expect(f.schedules.overview(f.owner).artifacts[0]).toMatchObject({ state: "failed", artifactAvailable: false });
    f.maintain(); expect(() => f.save()).toThrow("busy"); f.advance(); f.schedules.tick(); expect(f.schedules.overview(f.owner).artifacts).toHaveLength(1);
  });
  it("restart interrupts queued receipts and does not reconstruct the queue", async () => {
    const f = fixture(); const command = f.input(); f.save(command);
    const path = join(f.backups.recordDirectory, "user-schedules.json");
    const ledger = readRecord(path, z.any())!; const schedule = ledger.schedules[0];
    ledger.executions.push({ executionId: randomUUID(), configuration: schedule, dueAt: schedule.nextAt, state: "queued", reason: null, finishedAt: null, destination: join(f.root, "exports", "missing.json"), hash: null, bytes: 0 });
    writeRecord(path, ledger); f.schedules.close();
    const restarted = new UserSchedules(f.policy, f.backups, f.deps); cleanup.push(() => restarted.close());
    expect(restarted.overview(f.owner).artifacts[0]).toMatchObject({ state: "interrupted", reason: "interrupted" });
    expect(recordHash(ledger)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("refuses an offline restore generation even if old credentials are active again", async () => {
    const f = fixture(); f.save(); f.schedules.close();
    const restored = new UserSchedules(f.policy, f.backups, { ...f.deps, restoreGeneration: () => "restored" }); cleanup.push(() => restored.close());
    expect(restored.overview(f.owner).schedules[0].reason).toBe("forbidden");
    f.advance(); restored.tick(); await f.backups.drain();
    expect(restored.overview(f.owner).artifacts[0]).toMatchObject({ state: "denied", reason: "forbidden" });
    const input = f.input(); input.id = restored.overview(f.owner).schedules[0].id; input.version = 1;
    expect((restored.command(f.owner, input) as UserSchedule).reason).toBeNull();
  });
  it("checks storage and cooperative time limits before publication", async () => {
    for (const failure of ["bytes", "time"] as const) {
      const f = fixture({ maxBytes: 1024 ** 2 }); f.save();
      f.deps.exportDiscussions = () => { if (failure === "time") f.advance(31_000); return { body: "x".repeat(failure === "bytes" ? 1024 ** 2 : 1) }; };
      f.advance(); f.schedules.tick(); await f.backups.drain();
      expect(f.schedules.overview(f.owner).artifacts[0]).toMatchObject({ state: "failed", reason: "limit", artifactAvailable: false });
    }
  });
  it("preserves foreign/corrupt publication material and refuses overwrite or download", async () => {
    const f = fixture(); let release!: () => void;
    f.backups.enqueueExport("block", 1, () => new Promise<void>(resolve => { release = resolve; }), () => {}); await Promise.resolve();
    f.save(); f.advance(); f.schedules.tick();
    const ledger = JSON.parse(readFileSync(join(f.backups.recordDirectory, "user-schedules.json"), "utf8")).payload;
    const destination = ledger.executions[0].destination;
    // Create the exact path as operator fixture material before the queued export runs.
    const { mkdirSync } = await import("node:fs"); mkdirSync(join(f.root, "exports"), { mode: 0o700 }); writeFileSync(destination, "foreign evidence", { mode: 0o600 });
    release(); await f.backups.drain();
    expect(readFileSync(destination, "utf8")).toBe("foreign evidence");
    expect(f.schedules.overview(f.owner).artifacts[0]).toMatchObject({ state: "failed", artifactAvailable: false });
    expect(() => f.schedules.command(f.owner, { action: "artifact", executionId: ledger.executions[0].executionId })).toThrow("forbidden");
  });
  it("reconciles an interrupted receipt only for its complete exact artifact", async () => {
    const f = fixture(); f.save(); f.advance(); f.schedules.tick(); await f.backups.drain(); f.schedules.close();
    const path = join(f.backups.recordDirectory, "user-schedules.json"), ledger = readRecord(path, z.any())!;
    ledger.executions[0].state = "running"; ledger.executions[0].finishedAt = null; writeRecord(path, ledger);
    const restarted = new UserSchedules(f.policy, f.backups, f.deps); cleanup.push(() => restarted.close());
    expect(restarted.overview(f.owner).artifacts[0]).toMatchObject({ state: "succeeded", artifactAvailable: true });
    writeFileSync(ledger.executions[0].destination, "corrupt", { mode: 0o600 });
    expect(() => restarted.command(f.owner, { action: "artifact", executionId: ledger.executions[0].executionId })).toThrow();
  });
  it("enforces per-principal schedule limits and refuses oversize discussion sets without truncation", () => {
    const f = fixture({ maxSchedules: 1 }); f.save(); expect(() => f.save()).toThrow("limit"); f.save(f.input(), f.other);
    expect(() => f.store.exportUserDiscussions(f.project.id, 1)).toThrow("limits");
  });
});
