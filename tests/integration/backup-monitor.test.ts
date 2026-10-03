import { afterEach, expect, it } from "vitest";
import { startControllerFixture, waitFor, type ControllerFixture } from "../support/controller-fixture";
import type { BackupOperation } from "../../src/shared/contracts/backups";
import type { BackupMonitorReport } from "../../src/cli/backup-monitor";

let fixture: ControllerFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
it("probes the built controller independently, respects local-only policy and detects its absence", async () => {
  fixture = await startControllerFixture(0, [], { backups: true, startupArguments: ["--backup-interval-seconds", "3600"] });
  const f = fixture;
  const disabled = JSON.parse(await f.cli(["backup", "monitor"])) as BackupMonitorReport;
  expect(disabled).toMatchObject({ controller: "not-checked", severity: "disabled", alerts: [] });
  await expect(f.cli(["backup", "monitor", "--enabled"])).rejects.toMatchObject({ code: 2, stdout: expect.stringContaining("local_missing") });
  const key = "monitor-proof";
  await f.cli(["backup", "now", "--idempotency-key", key]);
  await waitFor(async () => { const result = JSON.parse(await f.cli(["backup", "status", "--idempotency-key", key])) as BackupOperation; return result.state === "succeeded" ? result : null; }, 10_000, () => "Monitor fixture copy failed.");
  const healthy = JSON.parse(await f.cli(["backup", "monitor", "--enabled"])) as BackupMonitorReport;
  expect(healthy).toMatchObject({ controller: "available", severity: "healthy", exitCode: 0, alerts: [], ages: { remoteSeconds: null }, metadata: { remote: { enabled: false } }, remoteReachability: "not-checked", recovery: "not-measured" });
  expect(healthy.ages.localSeconds).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(healthy)).not.toContain(f.installationToken);
  expect((await f.requestResult("/api/backups", { method: "POST", body: JSON.stringify({ action: "backup-monitor", enabled: true }) })).status).toBe(400);
  await f.stop();
  await expect(f.cli(["backup", "monitor", "--enabled"])).rejects.toMatchObject({ code: 3, stdout: expect.stringContaining("controller_unavailable") });
  expect(JSON.parse(await f.cli(["backup", "monitor"]))).toMatchObject({ severity: "disabled", alerts: [] });
});
it("keeps live disabled backup scheduling free of stale or missing-copy alerts", async () => {
  fixture = await startControllerFixture(0);
  expect(JSON.parse(await fixture.cli(["backup", "monitor", "--enabled"]))).toMatchObject({ severity: "disabled", exitCode: 0, controller: "available", alerts: [], metadata: { scheduleEnabled: false, local: { dataAt: null }, remote: { enabled: false } } });
});
it("returns safe unknown JSON for invalid CLI invocations before service-policy parsing", async () => {
  fixture = await startControllerFixture(0);
  for (const args of [["--enabled", "--timeout-ms", "private-sentinel"], ["--enabled", "--enabled"], ["--warn-after-seconds", "3600"], ["--backup-remote-enabled"], ["--user-backup-enabled"], ["--backup-before-migration"], ["--state-dir"], ["--data-dir", "one", "--data-dir", "two"]]) {
    let failure: { code?: number; stdout?: string; stderr?: string } | undefined;
    try { await fixture.cli(["backup", "monitor", ...args]); } catch (error) { failure = error as typeof failure; }
    expect(failure?.code).toBe(3); expect(failure?.stderr).toBe("");
    const result = JSON.parse(failure!.stdout!) as BackupMonitorReport;
    expect(result).toMatchObject({ severity: "unknown", exitCode: 3, controller: "not-checked", alerts: ["invalid_options"], metadata: null });
    expect(failure!.stdout).not.toContain("private-sentinel");
  }
});
