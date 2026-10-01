import { afterEach, describe, expect, it } from "vitest";
import type { BackupOverview, BackupOperation, RestoreOperation, RestorePreview } from "../../src/shared/contracts/backups";
import type { TestRun, ControllerDashboardResponse } from "../../src/shared/contracts";
import { startControllerFixture, waitFor, type ControllerFixture } from "../support/controller-fixture";

describe("operational backups in the packaged controller", () => {
  let fixture: ControllerFixture | undefined;
  afterEach(async () => { await fixture?.close(); fixture = undefined; });
  it("backs up live ownership via HTTP and CLI then performs one fenced whole-installation restore", async () => {
    fixture = await startControllerFixture(1, [], { backups: true });
    const f = fixture, project = f.projects[0]!;
    const admin = <T>(input: unknown) => f.request<T>("/api/identity/admin", { method: "POST", headers: { Authorization: `Bearer ${f.installationToken}` }, body: JSON.stringify(input) });
    const { principal } = await admin<{ principal: { id: string } }>({ action: "create-agent" });
    const scopedCredential = await admin<{ token: string }>({ action: "issue-agent-token", principalId: principal.id, label: "restore fixture" });
    expect((await f.requestResult("/api/identity", { headers: { Authorization: `Bearer ${scopedCredential.token}` } })).status).toBe(200);
    const key = "live-copy";
    const copy = await f.request<BackupOperation>("/api/backups", { method: "POST", body: JSON.stringify({ action: "create", idempotencyKey: key }) });
    const complete = await waitFor(async () => {
      const status = await f.request<BackupOperation>("/api/backups", { method: "POST", body: JSON.stringify({ action: "status", idempotencyKey: key }) });
      return status.state === "succeeded" ? status : null;
    }, 10000, () => "Live backup did not finish.");
    expect(complete.operationId).toBe(copy.operationId);
    expect((await f.request<BackupOperation>("/api/backups", { method: "POST", body: JSON.stringify({ action: "create", idempotencyKey: key }) })).operationId).toBe(copy.operationId);
    const cli = JSON.parse(await f.cli(["backup", "now", "--idempotency-key", "local-active"])) as BackupOperation;
    expect(cli.backupId).toMatch(/^backup-/);
    expect((JSON.parse(await f.cli(["backup", "now", "--idempotency-key", "local-active"])) as BackupOperation).operationId).toBe(cli.operationId);
    const preview = await f.request<RestorePreview>("/api/backups", { method: "POST", body: JSON.stringify({ action: "preview", backupId: copy.backupId }) });
    expect(preview.scope).toBe("entire-installation");
    await f.request("/api/settings/capacity", { method: "POST", body: JSON.stringify({ enabled: true, limit: 1 }) });
    await f.request(`/api/projects/${project.id}/operation`, { method: "POST", body: JSON.stringify({ operation: "start", worktreePath: project.main }) });
    const pids = await f.ownedPids(project);
    expect(pids.length).toBeGreaterThan(0);
    const mcp = await f.mcp();
    const run = await mcp.call<TestRun>("run_test", { projectId: project.id, worktreePath: project.main, presetId: "node:test:hold", idempotencyKey: "cancel-on-restore" });
    await waitFor(async () => (await f.testEvents(project)).some(event => event.event === "start") || null, 10000, () => "Owned finite fixture did not start.");
    const input = { action: "restore", backupId: copy.backupId, idempotencyKey: "whole-installation", confirmation: "replace-entire-installation" };
    const accepted = await f.request<RestoreOperation>("/api/backups", { method: "POST", body: JSON.stringify(input) });
    const restored = await waitFor(async () => {
      try {
        const result = await f.request<RestoreOperation>("/api/backups", { method: "POST", body: JSON.stringify({ action: "status", backupId: copy.backupId, idempotencyKey: input.idempotencyKey }) });
        return result.state === "verified" ? result : null;
      } catch { return null; } // Explicit wait for this controlled listener restart, not a test retry.
    }, 20000, () => "Controller did not reconnect after restore.");
    expect(restored.operationId).toBe(accepted.operationId);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    expect((await f.testEvents(project)).some(event => event.event === "cancel")).toBe(true);
    expect(run.id).toBeTruthy();
    const dashboard = await f.request<ControllerDashboardResponse>("/api/dashboard");
    expect(dashboard.capacity.enabled).toBe(false);
    expect(dashboard.projects[0]?.runtime.phase).toBe("stopped");
    const scoped = await f.requestResult("/api/identity", { headers: { Authorization: `Bearer ${scopedCredential.token}` } }); expect(scoped.status).toBe(401);
    const policy = await f.request<BackupOverview>("/api/backups"); expect(policy.policy.uiActions).toEqual(["create", "restore"]); expect(policy.policy.intervalSeconds).toBeNull();
    await f.request("/api/settings/capacity", { method: "POST", body: JSON.stringify({ enabled: true, limit: 2 }) });
    const repeated = await f.request<RestoreOperation>("/api/backups", { method: "POST", body: JSON.stringify(input) }); expect(repeated.operationId).toBe(accepted.operationId);
    expect((await f.request<ControllerDashboardResponse>("/api/dashboard")).capacity.enabled).toBe(true);
    await mcp.close();
  });
  it("defaults to disabled operations and refuses project authority and service-policy mutation", async () => {
    fixture = await startControllerFixture(0);
    const f = fixture;
    expect((await f.request<BackupOverview>("/api/backups")).policy).toMatchObject({ destinationConfigured: false, intervalSeconds: null, uiActions: [] });
    expect((await f.requestResult("/api/backups", { method: "POST", body: JSON.stringify({ action: "create", idempotencyKey: "denied" }) })).status).toBe(403);
    expect((await f.requestResult("/api/backups", { method: "PATCH", body: JSON.stringify({ intervalSeconds: 60 }) })).status).toBe(405);
    expect((await f.requestResult("/api/backups", { method: "POST", body: JSON.stringify({ action: "configure", uiActions: ["restore"] }) })).status).toBe(400);
  });
});
