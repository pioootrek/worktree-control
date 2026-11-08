import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackupOverview, BackupOperation, RestoreOperation, RestorePreview } from "../../src/shared/contracts/backups";
import type { TestRun, ControllerDashboardResponse } from "../../src/shared/contracts";
import { startControllerFixture, waitFor, type ControllerFixture } from "../support/controller-fixture";

describe("operational backups in the packaged controller", () => {
  let fixture: ControllerFixture | undefined;
  afterEach(async () => { await fixture?.close(); fixture = undefined; });
  it("routes explicit data/state directories and environment paths to the same running backup owner", async () => {
    fixture = await startControllerFixture(0, [], { backups: true });
    const key = "explicit-paths";
    const created = JSON.parse(await fixture.cli(["backup", "now", "--idempotency-key", key], {}, "flags")) as BackupOperation;
    const replay = JSON.parse(await fixture.cli(["backup", "now", "--idempotency-key", key])) as BackupOperation;
    expect(created.operationId).toBe(replay.operationId);
    expect(created.backupId).toBe(replay.backupId);
    await waitFor(async () => {
      const status = JSON.parse(await fixture!.cli(["backup", "status", "--idempotency-key", key], {}, "flags")) as BackupOperation;
      return status.state === "succeeded" ? status : null;
    }, 10000, () => "Explicit-path backup did not finish through the controller.");
    expect(JSON.parse(await fixture.cli(["backup", "list"], {}, "flags"))).toEqual(JSON.parse(await fixture.cli(["backup", "list"])));
  });
  it("restores during a gated start without waiting for readiness timeout or leaving owned processes", async () => {
    fixture = await startControllerFixture(1, [], { backups: true });
    const f = fixture, project = f.projects[0]!;
    const copy = await f.request<BackupOperation>("/api/backups", { method: "POST", body: JSON.stringify({ action: "create", idempotencyKey: "before-start" }) });
    await waitFor(async () => {
      const status = await f.request<BackupOperation>("/api/backups", { method: "POST", body: JSON.stringify({ action: "status", idempotencyKey: "before-start" }) });
      return status.state === "succeeded" ? status : null;
    }, 10000, () => "Backup did not complete.");
    await f.setMode(project, "gate");
    const starting = f.requestResult(`/api/projects/${project.id}/operation`, { method: "POST", body: JSON.stringify({ operation: "start", worktreePath: project.main }) });
    const pids = await waitFor(async () => { const pids = await f.ownedPids(project); return pids.length ? pids : null; }, 10000, () => "Gated start did not spawn its owned fixture.");
    const input = { action: "restore", backupId: copy.backupId, idempotencyKey: "cancel-start", confirmation: "replace-entire-installation" };
    const accepted = await f.request<RestoreOperation>("/api/backups", { method: "POST", body: JSON.stringify(input) });
    await f.recoverRestore();
    const completed=JSON.parse(await readFile(join(f.paths.data,"state.sqlite3.backup-operations","handoff.json"),"utf8")).payload as RestoreOperation;
    expect(completed).toMatchObject({operationId:accepted.operationId,state:"verified"});
    expect((await starting).ok).toBe(false);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  });
  it("backs up live ownership via HTTP and CLI then performs one fenced whole-installation restore", async () => {
    fixture = await startControllerFixture(1, [], { backups: true });
    const f = fixture, project = f.projects[0]!;
    const admin = <T>(input: unknown) => f.request<T>("/api/identity/admin", { method: "POST", headers: { Authorization: `Bearer ${f.installationToken}` }, body: JSON.stringify(input) });
    const { principal } = await admin<{ principal: { id: string } }>({ action: "create-agent" });
    const scopedCredential = await admin<{ token: string }>({ action: "issue-agent-token", principalId: principal.id, label: "restore fixture" });
    expect((await f.requestResult("/api/identity", { headers: { Authorization: `Bearer ${scopedCredential.token}`, "x-worktree-control-token": scopedCredential.token } })).status).toBe(200);
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
    const previousToken=f.installationToken;
    await f.recoverRestore();
    const restored=JSON.parse(await readFile(join(f.paths.data,"state.sqlite3.backup-operations","handoff.json"),"utf8")).payload as RestoreOperation;
    expect(restored).toMatchObject({operationId:accepted.operationId,state:"verified"});
    expect((await f.requestResult("/api/identity",{headers:{Authorization:`Bearer ${previousToken}`,"x-worktree-control-token":previousToken}})).status).toBe(401);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    expect((await f.testEvents(project)).some(event => event.event === "cancel")).toBe(true);
    expect(run.id).toBeTruthy();
    const dashboard = await f.request<ControllerDashboardResponse>("/api/dashboard");
    expect(dashboard.capacity.enabled).toBe(false);
    expect(dashboard.projects[0]?.runtime.phase).toBe("stopped");
    const scoped = await f.requestResult("/api/identity", { headers: { Authorization: `Bearer ${scopedCredential.token}`, "x-worktree-control-token": scopedCredential.token } }); expect(scoped.status).toBe(401);
    const policy = await f.request<BackupOverview>("/api/backups"); expect(policy.policy.uiActions).toEqual(["create", "restore"]); expect(policy.policy.intervalSeconds).toBeNull();
    await f.request("/api/settings/capacity", { method: "POST", body: JSON.stringify({ enabled: true, limit: 2 }) });
    const repeated=await f.requestResult("/api/backups",{method:"POST",headers:{Authorization:`Bearer ${previousToken}`,"x-worktree-control-token":previousToken},body:JSON.stringify(input)});expect(repeated.status).toBe(403);expect(repeated.body).toMatchObject({code:"backup_forbidden"});
    expect((await f.request<ControllerDashboardResponse>("/api/dashboard")).capacity.enabled).toBe(true);
    await mcp.close();
  });
  it("fences an offline CLI restore before listeners and resumes only through protected CLI with a fresh token",async()=>{
    fixture=await startControllerFixture(0,[],{backups:true});const f=fixture,old=f.installationToken;
    const copy=JSON.parse(await f.cli(["backup","now","--idempotency-key","offline-copy"])) as BackupOperation;
    await waitFor(async()=>{const result=JSON.parse(await f.cli(["backup","status","--idempotency-key","offline-copy"])) as BackupOperation;return result.state==="succeeded"?true:null;},10000,()=>"Offline fixture backup did not finish.");
    await f.stop();
    await f.cli(["backup","restore",join(f.paths.base,"backups",copy.backupId),"--idempotency-key","offline-restore"]);
    await expect(f.restart()).rejects.toThrow(/security_fence_recovery_required/);
    await f.recoverRestore();
    expect((await f.requestResult("/api/identity",{headers:{Authorization:`Bearer ${old}`,"x-worktree-control-token":old}})).status).toBe(401);
    expect((await f.requestResult("/api/dashboard")).status).toBe(200);
  });
  it("defaults to disabled operations and refuses project authority and service-policy mutation", async () => {
    fixture = await startControllerFixture(0);
    const f = fixture;
    expect((await f.request<BackupOverview>("/api/backups")).policy).toMatchObject({ destinationConfigured: false, intervalSeconds: null, uiActions: [] });
    expect((await f.requestResult("/api/backups", { method: "POST", body: JSON.stringify({ action: "create", idempotencyKey: "denied" }) })).status).toBe(403);
    expect((await f.requestResult("/api/backups", { method: "PATCH", body: JSON.stringify({ intervalSeconds: 60 }) })).status).toBe(405);
    expect((await f.requestResult("/api/backups", { method: "POST", body: JSON.stringify({ action: "configure", uiActions: ["restore"] }) })).status).toBe(400);
  });
  it("resolves an active CLI relative backup in the operator cwd and returns safe missing restore status", async () => {
    fixture = await startControllerFixture(0, [], { backups: true });
    const f = fixture, cwd = await mkdtemp(join(tmpdir(), "backup-operator-cwd-"));
    try {
      const created = JSON.parse(await f.cli(["backup", "create", "./manual-copy", "--idempotency-key", "relative"], {}, "environment", cwd)) as BackupOperation;
      const completed = await waitFor(async () => {
        const status = JSON.parse(await f.cli(["backup", "status", "--idempotency-key", "relative"])) as BackupOperation;
        return ["succeeded", "failed", "interrupted"].includes(status.state) ? status : null;
      }, 10000, () => "Relative CLI backup did not finish.");
      expect(completed.state).toBe("succeeded");
      expect(JSON.parse(await readFile(join(cwd, "manual-copy", "manifest.json"), "utf8"))).toMatchObject({ formatVersion: 1 });
      await expect(f.cli(["backup", "status", created.backupId, "--idempotency-key", "missing-restore"])).rejects.toThrow("backup_invalid");
      const status = await f.requestResult("/api/backups", { method: "POST", body: JSON.stringify({ action: "status", backupId: created.backupId, idempotencyKey: "missing-restore" }) });
      expect(status.status).toBe(404);
      expect(status.body).toEqual({ code: "backup_invalid", error: "backup_invalid" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
