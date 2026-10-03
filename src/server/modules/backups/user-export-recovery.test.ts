import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { BackupOperations, backupPolicySchema, UserSchedules, userBackupPolicySchema } from "./index";
import { readRecord, writeRecord } from "./records";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "user-recovery-"));
  let now = Date.now();
  const backups = new BackupOperations(backupPolicySchema.parse({}), { databasePath: join(root, "state.sqlite3"), attachmentDirectory: join(root, "attachments"), applicationVersion: "test", source: { backup: async () => {} }, estimateBytes: () => 1, authorize: () => true, maintenance: () => false, clock: () => now });
  const policy = userBackupPolicySchema.parse({ enabled: true, scopes: ["knowledge-discussions"], projects: ["project"], targets: [{ id: "local", directory: join(root, "exports") }], minIntervalSeconds: 60, maxBytes: 1024 ** 2 });
  const deps = { authorize: () => {}, projectName: () => "Fixture", exportDiscussions: () => ({ body: "x".repeat(700_000) }), clock: () => now };
  let schedules = new UserSchedules(policy, backups, deps);
  const actor = (principalId = "owner") => ({ principalId, principalKind: "owner" as const, credentialId: "fixture", authenticationMethod: "owner_session" as const });
  const save = (owner = "owner") => schedules.command(actor(owner), { action: "save", id: randomUUID(), version: 0, idempotencyKey: randomUUID(), configuration: { projectId: "project", scope: "knowledge-discussions", targetId: "local", enabled: true, intervalSeconds: 60, retainCount: 1, retainDays: 1 } });
  const path = join(backups.recordDirectory, "user-schedules.json");
  const ledger = () => readRecord(path, z.any())!;
  const restart = () => { schedules.close(); schedules = new UserSchedules(policy, backups, deps); };
  cleanup.push(() => rmSync(root, { recursive: true, force: true }), () => backups.close(), () => schedules.close());
  return { root, backups, deps, policy, actor, save, path, ledger, restart, advance: (ms = 60_000) => { now += ms; }, get schedules() { return schedules; } };
}

it("operator reclaims expired interrupted publication, frees owner quota and preserves other user and outcome", async () => {
  const f = fixture(); f.save(); f.advance(); f.schedules.tick(); await f.backups.drain();
  const ledger = f.ledger(), execution = ledger.executions[0], original = readFileSync(execution.destination);
  execution.state = "running"; execution.hash = null; execution.bytes = 0; execution.finishedAt = null;
  writeRecord(f.path, ledger); f.advance(600_000); f.restart();
  expect(f.schedules.overview(f.actor()).artifacts[0].state).toBe("interrupted");
  f.schedules.tick(); await f.backups.drain();
  expect(f.schedules.overview(f.actor()).artifacts[0]).toMatchObject({ state: "failed", reason: "limit" });
  f.save("other"); f.advance(); f.schedules.tick(); await f.backups.drain();
  const other = f.ledger().executions.find((value: typeof execution) => value.configuration.ownerId === "other");
  const otherBytes = readFileSync(other.destination);
  expect(readFileSync(execution.destination)).toEqual(original);
  // The operator confirms the exact preview, retaining the original execution outcome.
  const recovery = f.schedules as unknown as { recover(actor: string, input: unknown): Promise<{ confirmation: string; state: string }> };
  const preview = await recovery.recover("local-admin", { action: "preview", executionId: execution.executionId });
  const done = await recovery.recover("local-admin", { action: "cleanup", executionId: execution.executionId, confirmation: preview.confirmation });
  expect(done.state).toBe("completed"); expect(existsSync(execution.destination)).toBe(false);
  expect(readFileSync(other.destination)).toEqual(otherBytes);
  expect(f.ledger().executions.find((value: typeof execution) => value.executionId === execution.executionId).state).toBe("interrupted");
  f.advance(); f.schedules.tick(); await f.backups.drain();
  expect(f.schedules.overview(f.actor()).artifacts[0].state).toBe("succeeded");
});
