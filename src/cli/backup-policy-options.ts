import { resolve } from "node:path";
import { validatePrivateDirectory } from "@/server/private-storage";
import { backupPolicySchema, type BackupPolicy } from "@/server/modules/backups";
export const BACKUP_OPERATION_FLAGS = ["--backup-interval-seconds", "--backup-retain-count", "--backup-retain-days", "--backup-max-bytes", "--backup-timeout-seconds", "--backup-queue-limit", "--backup-ui-actions"] as const;
const numericFlags = { "--backup-interval-seconds": "intervalSeconds", "--backup-retain-count": "retainCount", "--backup-retain-days": "retainDays", "--backup-max-bytes": "maxBytes", "--backup-timeout-seconds": "timeoutSeconds", "--backup-queue-limit": "queueLimit" } as const;
export function parseBackupPolicyOptions(args: string[], allowed = true): BackupPolicy {
  const values: Record<string, unknown> = {}, seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!flag.startsWith("--backup") || flag === "--backup-before-migration" || flag.startsWith("--backup-remote")) continue;
    if (!allowed) throw new Error("Backup startup options apply only to start or service install.");
    if (flag !== "--backup-dir" && !BACKUP_OPERATION_FLAGS.includes(flag as typeof BACKUP_OPERATION_FLAGS[number])) throw new Error(`Unsupported backup option: ${flag.split("=")[0]}`);
    const value = args[++i];
    if (seen.has(flag) || !value?.trim() || value.startsWith("--") || value.includes("\0")) throw new Error(`${flag} requires one value and must occur once.`);
    seen.add(flag);
    if (flag === "--backup-dir") values.directory = resolve(value);
    else if (flag === "--backup-ui-actions") {
      if (!["none", "create", "restore", "create,restore", "restore,create"].includes(value)) throw new Error("--backup-ui-actions accepts none, create, restore or create,restore.");
      values.uiActions = value === "none" ? [] : value.split(",");
    } else {
      if (!/^[0-9]+$/.test(value)) throw new Error(`${flag} requires an integer.`);
      values[numericFlags[flag as keyof typeof numericFlags]] = Number(value);
    }
  }
  const result = backupPolicySchema.safeParse(values);
  if (!result.success) throw new Error(`Invalid backup startup policy: ${result.error.issues.map(issue => issue.message).join("; ")}`);
  return result.data;
}
export function backupPolicyArguments(policy: BackupPolicy): string[] {
  const result: string[] = [];
  if (policy.intervalSeconds !== null) result.push("--backup-interval-seconds", String(policy.intervalSeconds));
  for (const [flag, key] of Object.entries(numericFlags)) if (key !== "intervalSeconds") result.push(flag, String(policy[key]));
  if (policy.uiActions.length) result.push("--backup-ui-actions", policy.uiActions.join(","));
  return result;
}
export function validateBackupPolicyDestination(policy: BackupPolicy): void {
  if (policy.directory) validatePrivateDirectory(policy.directory);
}
