import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import type { UserSchedule, UserScheduleOverview } from "../../src/shared/contracts/user-backups";
import { startControllerFixture, waitFor, type ControllerFixture } from "../support/controller-fixture";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
let fixture: ControllerFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
it("built CLI reclaims an expired publication through the active private admin channel and preserves replay after restart", async () => {
  fixture = await startControllerFixture(0, [], { userBackups: true });
  const f = fixture, projectId = f.userBackupProjectId!;
  const admin = <T>(body: unknown) => f.request<T>("/api/identity/admin", { method: "POST", headers: { Authorization: `Bearer ${f.installationToken}` }, body: JSON.stringify(body) });
  const { principal } = await admin<{ principal: { id: string } }>({ action: "create-agent" });
  const { token } = await admin<{ token: string }>({ action: "issue-agent-token", principalId: principal.id, label: "cleanup fixture" });
  await admin({ action: "grant-knowledge", principalId: principal.id, projectId, permissions: ["knowledge:read", "knowledge:write", "knowledge:export"] });
  const api = <T>(input?: unknown) => f.request<T>("/api/user-backups", { headers: { Authorization: `Bearer ${token}` }, ...(input ? { method: "POST", body: JSON.stringify(input) } : {}) });
  const command = { action: "save", id: randomUUID(), version: 0, idempotencyKey: "cleanup-schedule", configuration: { projectId, scope: "knowledge-discussions", targetId: "local", enabled: true, intervalSeconds: 60, retainCount: 2, retainDays: 30 } };
  await api<UserSchedule>(command);
  const databasePath = (await f.cli(["config", "path"])).trim(), path = `${databasePath}.backup-operations/user-schedules.json`;
  const rewrite = async (mutate: (payload: { schedules: Array<{ nextAt: number }>; executions: Array<{ executionId: string; state: string; reason: string | null; finishedAt: string | null; destination: string; hash: string | null; bytes: number }> }) => void) => {
    const envelope = JSON.parse(await readFile(path, "utf8")); mutate(envelope.payload);
    envelope.sha256 = createHash("sha256").update(JSON.stringify(canonical(envelope.payload))).digest("hex"); await writeFile(path, JSON.stringify(envelope), { mode: 0o600 });
  };
  await f.stop(); await rewrite(payload => { payload.schedules[0]!.nextAt = Date.now() - 86400_000; }); await f.restart();
  const exported = await waitFor(async () => { const data = await api<UserScheduleOverview>(); return data.artifacts[0]?.state === "succeeded" ? data.artifacts[0] : null; }, 10000, () => "Fixture export did not finish.");
  await f.stop();
  // Use an already-durable real publication and retain its elapsed persisted deadline.
  await rewrite(payload => { const execution = payload.executions[0]!; execution.state = "interrupted"; execution.reason = "interrupted"; execution.hash = null; execution.bytes = 0; });
  await expect(f.cli(["backup", "user-cleanup", "list"])).rejects.toThrow(); // No offline owner fallback.
  await f.restart();
  const candidates = JSON.parse(await f.cli(["backup", "user-cleanup", "list"])) as Array<{ executionId: string; eligible: boolean }>;
  expect(candidates.filter(value => value.eligible).map(value => value.executionId)).toEqual([exported.executionId]);
  const view = JSON.parse(await f.cli(["backup", "user-cleanup", "preview", exported.executionId])) as { confirmation: string };
  const envelope = JSON.parse(await readFile(path, "utf8")), execution = envelope.payload.executions[0];
  for (const credential of [token, f.installationToken]) expect((await f.requestResult("/api/user-backups", { method: "POST", headers: { Authorization: `Bearer ${credential}` }, body: JSON.stringify({ action: "cleanup", executionId: exported.executionId, confirmation: view.confirmation }) })).ok).toBe(false);
  await expect(f.cli(["backup", "user-cleanup", "cleanup", exported.executionId, "0".repeat(64)])).rejects.toThrow("changed");
  const args = ["backup", "user-cleanup", "cleanup", exported.executionId, view.confirmation];
  const done = JSON.parse(await f.cli(args)); expect(done).toMatchObject({ state: "completed", executionState: "interrupted" });
  await expect(stat(execution.destination)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await f.cli(args))).toEqual(done); await f.restart(); expect(JSON.parse(await f.cli(args))).toEqual(done);
  const after = JSON.parse(await readFile(path, "utf8")); expect(after.payload.executions[0]).toEqual(execution); expect(after.payload.mutations).toEqual(envelope.payload.mutations);
});
