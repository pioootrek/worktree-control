import { afterEach, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { UserExportResult, UserSchedule, UserScheduleOverview } from "../../src/shared/contracts/user-backups";
import type { BackupOperation, RestoreOperation } from "../../src/shared/contracts/backups";
import { startControllerFixture, waitFor, type ControllerFixture } from "../support/controller-fixture";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
describe("S4u in built controller", () => {
  let fixture: ControllerFixture | undefined;
  afterEach(async () => { await fixture?.close(); fixture = undefined; });
  it("defaults off and installation credentials cannot become a schedule owner", async () => {
    fixture = await startControllerFixture(0);
    const f = fixture;
    expect((await f.requestResult("/api/user-backups", { headers: { Authorization: `Bearer ${f.installationToken}` } })).status).toBe(403);
    const admin = <T>(body: unknown) => f.request<T>("/api/identity/admin", { method: "POST", headers: { Authorization: `Bearer ${f.installationToken}` }, body: JSON.stringify(body) });
    const { principal } = await admin<{ principal: { id: string } }>({ action: "create-agent" });
    const owner = await admin<{ token: string }>({ action: "issue-agent-token", principalId: principal.id, label: "default-off owner" });
    const overview = await f.request<UserScheduleOverview>("/api/user-backups", { headers: { Authorization: `Bearer ${owner.token}` } });
    expect(overview.policy.enabled).toBe(false); expect(overview.targets).toEqual([]);
  });
  it("exports through the shared executor across restart and revalidates after actual SQLite rollback", async () => {
    fixture = await startControllerFixture(0, [], { userBackups: true, backups: true });
    const f = fixture, projectId = f.userBackupProjectId!;
    const admin = <T>(body: unknown) => f.request<T>("/api/identity/admin", { method: "POST", headers: { Authorization: `Bearer ${f.installationToken}` }, body: JSON.stringify(body) });
    const { principal } = await admin<{ principal: { id: string } }>({ action: "create-agent" });
    const issued = await admin<{ token: string }>({ action: "issue-agent-token", principalId: principal.id, label: "schedule owner" });
    await admin({ action: "grant-knowledge", principalId: principal.id, projectId, permissions: ["knowledge:read", "knowledge:write", "knowledge:export"] });
    const api = <T>(input?: unknown, token = issued.token) => f.request<T>("/api/user-backups", { headers: { Authorization: `Bearer ${token}` }, ...(input ? { method: "POST", body: JSON.stringify(input) } : {}) });
    await f.request("/api/knowledge", { method: "POST", headers: { Authorization: `Bearer ${issued.token}` }, body: JSON.stringify({ operation: "create_thread", input: { projectId, title: "Exported discussion", body: "S4u content", idempotencyKey: "content" } }) });
    const copy = await f.request<BackupOperation>("/api/backups", { method: "POST", body: JSON.stringify({ action: "create", idempotencyKey: "before-schedule" }) });
    await waitFor(async () => (await f.request<BackupOperation>("/api/backups", { method: "POST", body: JSON.stringify({ action: "status", idempotencyKey: "before-schedule" }) })).state === "succeeded" ? true : null, 10000, () => "Service backup did not finish.");
    const input = { action: "save", id: randomUUID(), version: 0, idempotencyKey: "create-schedule", configuration: { projectId, scope: "knowledge-discussions", targetId: "local", enabled: true, intervalSeconds: 60, retainCount: 2, retainDays: 30 } };
    const saved = await api<UserSchedule>(input); expect(saved.ownerId).toBe(principal.id);
    expect((await api<UserSchedule>(input)).id).toBe(saved.id);
    // Controlled fixture deadline setup while the single controller is stopped.
    const databasePath = (await f.cli(["config", "path"])).trim();
    await f.stop();
    const path = `${databasePath}.backup-operations/user-schedules.json`;
    const ledger = JSON.parse(await readFile(path, "utf8")); ledger.payload.schedules[0].nextAt = Date.now() - 86400_000;
    ledger.sha256 = createHash("sha256").update(JSON.stringify(canonical(ledger.payload))).digest("hex"); await writeFile(path, JSON.stringify(ledger), { mode: 0o600 });
    await f.restart();
    const run = await waitFor(async () => { const data = await api<UserScheduleOverview>(); return data.artifacts[0]?.state === "succeeded" ? data.artifacts[0] : null; }, 10000, () => "User export did not finish.");
    expect((await api<UserScheduleOverview>()).artifacts).toHaveLength(1);
    expect(JSON.stringify(await api({ action: "artifact", executionId: run.executionId }))).toContain("S4u content");
    const restore = { action: "restore", backupId: copy.backupId, idempotencyKey: "rollback-before-schedule", confirmation: "replace-entire-installation" };
    await f.request("/api/backups", { method: "POST", body: JSON.stringify(restore) });
    await waitFor(async () => { try { const status = await f.request<RestoreOperation>("/api/backups", { method: "POST", body: JSON.stringify({ action: "status", backupId: copy.backupId, idempotencyKey: restore.idempotencyKey }) }); return status.state === "verified" ? true : null; } catch { return null; } }, 10000, () => "Restore did not finish.");
    expect((await f.requestResult("/api/user-backups", { headers: { Authorization: `Bearer ${issued.token}` } })).status).toBe(403);
    const fresh = await admin<{ token: string }>({ action: "issue-agent-token", principalId: principal.id, label: "post-restore" });
    const after = await api<UserScheduleOverview>(undefined, fresh.token);
    expect(after.schedules[0]).toMatchObject({ id: saved.id, version: 1, reason: "forbidden" });
    expect(after.artifacts).toHaveLength(1); expect(after.artifacts[0].executionId).toBe(run.executionId);
    const updated = await api<UserSchedule>({ ...input, version: 1, idempotencyKey: "revalidate" }, fresh.token);
    expect(updated.version).toBe(2); expect(updated.reason).toBeNull();
    const invalid = await f.requestResult("/api/user-backups", { method: "POST", headers: { Authorization: `Bearer ${fresh.token}` }, body: JSON.stringify({ ...input, ownerId: "foreign" }) });
    expect(invalid.status).toBe(400);
    const result: UserExportResult = (await api<UserScheduleOverview>(undefined, fresh.token)).artifacts[0]; expect(result.executionId).toBe(run.executionId);
    await f.stop();
    await f.cli(["backup", "restore", join(dirname(dirname(databasePath)), "backups", copy.backupId), "--idempotency-key", "offline-rollback"]);
    await f.restart();
    // Offline restore resurrects the old database credential, but S4u must refuse it.
    expect((await f.requestResult("/api/identity", { headers: { Authorization: `Bearer ${issued.token}` } })).status).toBe(200);
    expect((await f.requestResult("/api/user-backups", { headers: { Authorization: `Bearer ${issued.token}` } })).status).toBe(403);
    const postOffline = await admin<{ token: string }>({ action: "issue-agent-token", principalId: principal.id, label: "post-offline-restore" });
    const offlineOverview = await api<UserScheduleOverview>(undefined, postOffline.token);
    expect(offlineOverview.schedules[0]).toMatchObject({ id: saved.id, version: 2, reason: "forbidden" });
    expect(offlineOverview.artifacts[0].executionId).toBe(run.executionId);
    expect((await api<UserSchedule>({ ...input, version: 2, idempotencyKey: "revalidate-offline" }, postOffline.token)).version).toBe(3);
  });
});
