import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listenAdminSocket } from "@/server/admin-socket";
import type { BackupMonitorMetadata } from "@/server/modules/backups";
import { evaluateBackupMonitor, parseBackupMonitorOptions, probeBackupMonitor } from "./backup-monitor";

const now = Date.parse("2026-10-03T12:00:00Z"), date = (seconds = 0) => new Date(now - seconds * 1000).toISOString();
const enabled = parseBackupMonitorOptions(["--enabled"]);
function metadata(): BackupMonitorMetadata {
  return { format: 1, observedAt: date(), scheduleEnabled: true, maintenance: false,
    local: { dataAt: date(10), lastAttempt: { dataAt: date(10), state: "succeeded", error: null }, error: null },
    remote: { enabled: true, dataAt: date(10), confirmedAt: date(), pending: 0, error: null } };
}
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function socket() { const root = mkdtempSync(join(tmpdir(), "wts-monitor-")); cleanups.push(() => rmSync(root, { force: true, recursive: true })); return join(root, "admin.sock"); }

describe("finite backup monitor", () => {
  it("defaults off without even probing an absent controller", async () => {
    expect(await probeBackupMonitor("/does-not-exist", parseBackupMonitorOptions([]), () => now)).toMatchObject({ severity: "disabled", exitCode: 0, controller: "not-checked", alerts: [], metadata: null });
  });
  it("validates thresholds and rejects duplicate, unknown and service options", () => {
    for (const args of [["--enabled", "--enabled"], ["--warn-after-seconds", "3600"], ["--timeout-ms", "0"], ["--timeout-ms", "NaN"], ["--backup-dir", "/tmp"], ["--critical-after-seconds"], ["constructor", "1"]]) expect(() => parseBackupMonitorOptions(args)).toThrow();
  });
  it("reports missing controllers as unknown and never creates local state", async () => {
    expect(await probeBackupMonitor(socket(), enabled, () => now)).toMatchObject({ severity: "unknown", exitCode: 3, controller: "unavailable", alerts: ["controller_unavailable"] });
  });
  it("uses snapshot data age rather than a fresh upload completion", () => {
    const data = metadata(); data.remote.dataAt = date(3600);
    expect(evaluateBackupMonitor(data, enabled, now)).toMatchObject({ severity: "critical", exitCode: 2, ages: { localSeconds: 10, remoteSeconds: 3600 }, alerts: ["remote_critical"], remoteReachability: "not-checked", recovery: "not-measured" });
  });
  it("keeps warning and critical boundaries distinct", () => {
    const data = metadata(); data.local.dataAt = date(2700);
    expect(evaluateBackupMonitor(data, enabled, now)).toMatchObject({ severity: "warning", exitCode: 1, alerts: ["local_warning"] });
    data.local.dataAt = date(3600);
    expect(evaluateBackupMonitor(data, enabled, now)).toMatchObject({ severity: "critical", exitCode: 2, alerts: ["local_critical"] });
  });
  it("reports failed local and remote attempts even with fresh successful evidence", () => {
    const data = metadata(); data.local.lastAttempt = { dataAt: date(), state: "failed", error: "backup_failed" }; data.remote.error = "remote_failed";
    expect(evaluateBackupMonitor(data, enabled, now)).toMatchObject({ severity: "critical", alerts: ["local_failed", "remote_failed"] });
  });
  it("reports missing evidence and maintenance rather than certifying health", () => {
    const data = metadata(); data.local.dataAt = null; data.remote.dataAt = null; data.maintenance = true;
    expect(evaluateBackupMonitor(data, enabled, now)).toMatchObject({ severity: "critical", alerts: ["local_missing", "remote_missing", "maintenance"] });
  });
  it("does not raise remote alerts in local-only mode, or any stale alerts with scheduling off", () => {
    const data = metadata(); data.remote.enabled = false; data.remote.dataAt = null; data.remote.error = "remote_failed";
    expect(evaluateBackupMonitor(data, enabled, now)).toMatchObject({ severity: "healthy", alerts: [], ages: { remoteSeconds: null } });
    data.scheduleEnabled = false; data.local.dataAt = date(86400); data.local.error = "backup_failed";
    expect(evaluateBackupMonitor(data, enabled, now)).toMatchObject({ severity: "disabled", alerts: [], exitCode: 0 });
  });
  it("fails closed on clock anomalies and stale observations", () => {
    for (const value of [date(-60), date(60)]) { const data = metadata(); data.observedAt = value; expect(evaluateBackupMonitor(data, enabled, now)).toMatchObject({ severity: "unknown", alerts: ["clock_invalid"] }); }
    const data = metadata(); data.remote.dataAt = date(-60); expect(evaluateBackupMonitor(data, enabled, now).exitCode).toBe(3);
  });
  it("consumes only a strict safe projection via the local admin channel", async () => {
    const path = socket(), admin = await listenAdminSocket(path, body => { expect(body).toEqual({ command: "backup-monitor" }); return metadata(); }); cleanups.push(() => admin.close());
    expect(await probeBackupMonitor(path, enabled, () => now)).toMatchObject({ severity: "healthy", exitCode: 0, controller: "available" });
  });
  it("rejects incompatible or secret-bearing replies without echoing their content", async () => {
    const path = socket(), admin = await listenAdminSocket(path, () => ({ ...metadata(), token: "private-sentinel" })); cleanups.push(() => admin.close());
    const result = await probeBackupMonitor(path, enabled, () => now);
    expect(result).toMatchObject({ severity: "unknown", alerts: ["invalid_metadata"], metadata: null }); expect(JSON.stringify(result)).not.toContain("private-sentinel");
  });
  it.each(["oversized", "malformed", "trickle", "no-reply"])("bounds %s HTTP replies", async kind => {
    const path = socket(), timers: Array<ReturnType<typeof setInterval>> = [];
    const server = createServer((_, response) => {
      if (kind === "oversized") response.end("x".repeat(17 * 1024));
      else if (kind === "malformed") response.end("private-sentinel-invalid-json");
      else if (kind === "trickle") { response.writeHead(200); timers.push(setInterval(() => response.write(" "), 10)); }
    });
    await new Promise<void>(resolve => server.listen(path, resolve));
    cleanups.push(async () => { for (const timer of timers) clearInterval(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const started = Date.now(), result = await probeBackupMonitor(path, { ...enabled, timeoutMs: 100 }, () => now);
    expect(Date.now() - started).toBeLessThan(2000); expect(result).toMatchObject({ severity: "unknown", exitCode: 3, metadata: null });
    expect(result.alerts).toEqual([kind === "oversized" || kind === "malformed" ? "invalid_metadata" : "monitor_timeout"]);
    expect(JSON.stringify(result)).not.toContain("private-sentinel");
  });
});
