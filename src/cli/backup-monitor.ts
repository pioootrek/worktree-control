import { z } from "zod";
import { requestAdminSocket } from "@/server/admin-socket";
import { resolveAppPaths } from "@/server/paths";
import { backupMonitorMetadataSchema, type BackupMonitorMetadata } from "@/server/modules/backups";

const optionsSchema = z.object({
  enabled: z.boolean().default(false), warnAfterSeconds: z.number().int().min(1).max(30 * 86400).default(2700),
  criticalAfterSeconds: z.number().int().min(1).max(30 * 86400).default(3600), timeoutMs: z.number().int().min(50).max(30_000).default(5000),
}).refine(value => value.warnAfterSeconds < value.criticalAfterSeconds, "Warning must precede critical age.");
export type BackupMonitorOptions = z.infer<typeof optionsSchema>;
export function parseBackupMonitorOptions(args: string[]): BackupMonitorOptions {
  const values: Record<string, unknown> = {}, seen = new Set<string>();
  const numeric = { "--warn-after-seconds": "warnAfterSeconds", "--critical-after-seconds": "criticalAfterSeconds", "--timeout-ms": "timeoutMs" } as const;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error("Duplicate monitor option.");
    seen.add(flag);
    if (flag === "--enabled") { values.enabled = true; continue; }
    if (!Object.hasOwn(numeric, flag)) throw new Error("Usage: backup monitor [--enabled] [--warn-after-seconds N] [--critical-after-seconds N] [--timeout-ms N]");
    const value = args[++index];
    if (!value || !/^[0-9]+$/.test(value)) throw new Error("Monitor thresholds require integers.");
    values[numeric[flag as keyof typeof numeric]] = Number(value);
  }
  const result = optionsSchema.safeParse(values);
  if (!result.success) throw new Error("Invalid backup monitor thresholds or timeout.");
  return result.data;
}
type Severity = "disabled" | "healthy" | "warning" | "critical" | "unknown";
type Alert = "invalid_options" | "controller_unavailable" | "monitor_timeout" | "invalid_metadata" | "local_missing" | "local_warning" | "local_critical" | "local_failed" | "remote_missing" | "remote_warning" | "remote_critical" | "remote_failed" | "clock_invalid" | "maintenance";
export interface BackupMonitorReport {
  format: 1; checkedAt: string; enabled: boolean; severity: Severity; exitCode: 0 | 1 | 2 | 3;
  controller: "not-checked" | "available" | "unavailable"; alerts: Alert[];
  evidence: "recorded-snapshot-and-transfer-metadata"; remoteReachability: "not-checked"; recovery: "not-measured";
  metadata: BackupMonitorMetadata | null; ages: { localSeconds: number | null; remoteSeconds: number | null };
}
function report(now: number, enabled: boolean): BackupMonitorReport {
  return { format: 1, checkedAt: new Date(now).toISOString(), enabled, severity: "disabled", exitCode: 0, controller: "not-checked", alerts: [], evidence: "recorded-snapshot-and-transfer-metadata", remoteReachability: "not-checked", recovery: "not-measured", metadata: null, ages: { localSeconds: null, remoteSeconds: null } };
}
/** Catch invocation errors before any other CLI parser or filesystem mutation. */
export async function runBackupMonitor(args: string[], clock: () => number = Date.now): Promise<BackupMonitorReport> {
  try {
    const options: string[] = [], paths: { dataDirectory?: string; stateDirectory?: string } = {};
    const seen = new Set<string>();
    for (let index = 0; index < args.length; index++) {
      const flag = args[index]!;
      if (flag !== "--data-dir" && flag !== "--state-dir") { options.push(flag); continue; }
      const value = args[++index];
      if (seen.has(flag) || !value?.trim() || value.startsWith("--") || value.includes("\0")) throw new Error("Invalid monitor path option.");
      seen.add(flag); paths[flag === "--data-dir" ? "dataDirectory" : "stateDirectory"] = value;
    }
    const policy = parseBackupMonitorOptions(options);
    const resolved = resolveAppPaths(paths.dataDirectory, paths.stateDirectory);
    return await probeBackupMonitor(resolved.adminSocketPath, policy, clock);
  } catch {
    const result = report(clock(), args.includes("--enabled"));
    result.severity = "unknown"; result.exitCode = 3; result.alerts = ["invalid_options"];
    return result;
  }
}
export function evaluateBackupMonitor(metadata: BackupMonitorMetadata, options: BackupMonitorOptions, now: number): BackupMonitorReport {
  const result = report(now, options.enabled);
  result.controller = "available"; result.metadata = metadata;
  const age = (value: string | null) => value === null ? null : Math.floor((now - Date.parse(value)) / 1000);
  result.ages = { localSeconds: age(metadata.local.dataAt), remoteSeconds: metadata.remote.enabled ? age(metadata.remote.dataAt) : null };
  if (!options.enabled || (!metadata.scheduleEnabled && !metadata.remote.enabled)) return result;
  result.severity = "healthy";
  // Future timestamps or a stale reply cannot certify healthy evidence.
  const dates = [metadata.observedAt, ...(metadata.scheduleEnabled ? [metadata.local.dataAt, metadata.local.lastAttempt?.dataAt] : []), ...(metadata.remote.enabled ? [metadata.remote.dataAt, metadata.remote.confirmedAt] : [])].filter((value): value is string => Boolean(value));
  if (dates.some(value => Date.parse(value) > now + 1000) || now - Date.parse(metadata.observedAt) > options.timeoutMs + 1000) {
    result.alerts.push("clock_invalid"); result.severity = "unknown"; result.exitCode = 3; return result;
  }
  for (const scope of [...(metadata.scheduleEnabled ? ["local"] : []), ...(metadata.remote.enabled ? ["remote"] : [])] as Array<"local" | "remote">) {
    const seconds = scope === "local" ? result.ages.localSeconds : result.ages.remoteSeconds;
    if (seconds === null) result.alerts.push(`${scope}_missing`);
    else if (seconds >= options.criticalAfterSeconds) result.alerts.push(`${scope}_critical`);
    else if (seconds >= options.warnAfterSeconds) result.alerts.push(`${scope}_warning`);
  }
  if (metadata.scheduleEnabled && (metadata.local.error || metadata.local.lastAttempt?.state === "failed" || metadata.local.lastAttempt?.state === "interrupted")) result.alerts.push("local_failed");
  if (metadata.remote.enabled && metadata.remote.error) result.alerts.push("remote_failed");
  if (metadata.maintenance) result.alerts.push("maintenance");
  if (result.alerts.some(value => !value.endsWith("_warning") && value !== "maintenance")) { result.severity = "critical"; result.exitCode = 2; }
  else if (result.alerts.length) { result.severity = "warning"; result.exitCode = 1; }
  return result;
}
/** One finite external probe. Never owns SQLite, starts a controller or sends notifications. */
export async function probeBackupMonitor(socketPath: string, options: BackupMonitorOptions, clock: () => number = Date.now): Promise<BackupMonitorReport> {
  if (!options.enabled) return report(clock(), false);
  let raw: unknown;
  try { raw = await requestAdminSocket(socketPath, { command: "backup-monitor" }, options.timeoutMs, 16 * 1024); }
  catch (error) {
    const result = report(clock(), true), code = (error as NodeJS.ErrnoException).code;
    result.controller = "unavailable"; result.severity = "unknown"; result.exitCode = 3;
    result.alerts = [code === "admin_timeout" ? "monitor_timeout" : error instanceof SyntaxError || code === "admin_response_limit" ? "invalid_metadata" : "controller_unavailable"];
    return result;
  }
  const parsed = backupMonitorMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    const result = report(clock(), true); result.controller = "available"; result.severity = "unknown"; result.exitCode = 3; result.alerts = ["invalid_metadata"]; return result;
  }
  return evaluateBackupMonitor(parsed.data, options, clock());
}
