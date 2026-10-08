import { resolve } from "node:path";
import { loadResticConfiguration, type LoadedResticConfiguration } from "@/server/infrastructure/backups";

const values = {
  "--backup-remote-restic": "executable", "--backup-remote-repository": "repository", "--backup-remote-repository-id": "repositoryId",
  "--backup-remote-password-file": "passwordFile", "--backup-remote-credentials-file": "credentialsFile", "--backup-remote-ca-file": "caFile",
  "--backup-remote-upload-kib-per-second": "uploadKiBPerSecond",
} as const;
const numbers = { "--backup-remote-pending-limit": "pendingLimit", "--backup-remote-attempt-limit": "attemptLimit", "--backup-remote-retry-seconds": "retrySeconds", "--backup-remote-timeout-seconds": "timeoutSeconds" } as const;
export const REMOTE_BACKUP_VALUE_FLAGS = [...Object.keys(values), ...Object.keys(numbers)];
export interface RemoteBackupOptions { loaded?: LoadedResticConfiguration }
/** Deployment argv is the only policy; files contain credentials, never mutable policy. */
export function parseRemoteBackupOptions(args: string[], allowed = true): RemoteBackupOptions {
  const configuration: Record<string, unknown> = {}, policy: Record<string, unknown> = {}, seen = new Set<string>();
  let enabled = false, disabled = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!flag.startsWith("--backup-remote")) continue;
    if (!allowed || seen.has(flag)) throw new Error("Remote backup options apply once, only to start or service install.");
    seen.add(flag);
    if (flag === "--backup-remote-enabled" || flag === "--backup-remote-disabled") {
      if (args[index + 1] && !args[index + 1].startsWith("--")) throw new Error("Remote backup enabled/disabled flags are boolean.");
      enabled ||= flag === "--backup-remote-enabled"; disabled ||= flag === "--backup-remote-disabled"; continue;
    }
    if (!REMOTE_BACKUP_VALUE_FLAGS.includes(flag)) throw new Error("Unsupported remote backup startup option.");
    const value = args[++index];
    if (!value?.trim() || value.startsWith("--") || value.includes("\0")) throw new Error("Remote backup startup option requires one value.");
    if (flag in numbers || flag === "--backup-remote-upload-kib-per-second") {
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Remote backup startup option requires an integer.");
      if (flag in numbers) policy[numbers[flag as keyof typeof numbers]] = Number(value);
      else configuration.uploadKiBPerSecond = Number(value);
    } else {
      const key = values[flag as keyof typeof values];
      configuration[key] = ["executable", "passwordFile", "credentialsFile", "caFile"].includes(key) ? resolve(value) : value;
    }
  }
  if (disabled && (enabled || seen.size !== 1)) throw new Error("--backup-remote-disabled cannot be combined with other remote options.");
  if (!enabled) { if (Object.keys(configuration).length || Object.keys(policy).length) throw new Error("Remote backup parameters require --backup-remote-enabled."); return {}; }
  return { loaded: loadResticConfiguration({ ...configuration, policy }) };
}
export function remoteBackupArguments(options: RemoteBackupOptions): string[] {
  if (!options.loaded) return [];
  const configuration = options.loaded.configuration, result = ["--backup-remote-enabled"];
  for (const [flag, key] of Object.entries(values)) { const value = configuration[key as keyof typeof configuration]; if (value !== undefined) result.push(flag, String(value)); }
  for (const [flag, key] of Object.entries(numbers)) result.push(flag, String(configuration.policy[key]));
  return result;
}
