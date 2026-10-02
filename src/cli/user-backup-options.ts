import { resolve } from "node:path";
import { validatePrivateDirectory } from "@/server/private-storage";
import { userBackupPolicySchema, type UserBackupPolicy } from "@/server/modules/backups";

const numeric = { "--user-backup-min-interval-seconds": "minIntervalSeconds", "--user-backup-max-schedules": "maxSchedules", "--user-backup-max-bytes": "maxBytes", "--user-backup-timeout-seconds": "timeoutSeconds", "--user-backup-queue-limit": "queueLimit", "--user-backup-retain-count": "retainCount", "--user-backup-retain-days": "retainDays" } as const;
export function parseUserBackupOptions(args: string[], allowed = true): UserBackupPolicy {
  const values: Record<string, unknown> = {}, seen = new Set<string>();
  const targets: Array<{ id: string; directory: string }> = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!; if (!flag.startsWith("--user-backup")) continue;
    if (!allowed) throw new Error("User backup options apply only to start or service install.");
    if (flag !== "--user-backup-target" && seen.has(flag)) throw new Error("Duplicate user backup option.");
    seen.add(flag);
    if (flag === "--user-backup-enabled") { values.enabled = true; continue; }
    if (!(flag in numeric) && flag !== "--user-backup-projects" && flag !== "--user-backup-target") throw new Error("Unsupported user backup option.");
    const value = args[++i]; if (!value || value.startsWith("--") || value.includes("\0")) throw new Error("User backup option requires a value.");
    if (flag === "--user-backup-target") {
      const split = value.indexOf("="); if (split < 1 || !value.slice(split + 1).trim()) throw new Error("User backup target requires ID=directory.");
      targets.push({ id: value.slice(0, split), directory: resolve(value.slice(split + 1)) });
    } else if (flag === "--user-backup-projects") values.projects = value.split(",");
    else { if (!/^[0-9]+$/.test(value)) throw new Error("User backup limit requires an integer."); values[numeric[flag as keyof typeof numeric]] = Number(value); }
  }
  values.targets = targets;
  const policy = userBackupPolicySchema.parse(values);
  for (const target of policy.targets) validatePrivateDirectory(target.directory);
  return policy;
}
export function userBackupArguments(policy: UserBackupPolicy): string[] {
  const parsed = userBackupPolicySchema.parse(policy), args: string[] = [];
  if (parsed.enabled) args.push("--user-backup-enabled");
  if (parsed.projects.length) args.push("--user-backup-projects", parsed.projects.join(","));
  for (const target of parsed.targets) args.push("--user-backup-target", `${target.id}=${target.directory}`);
  for (const [flag, key] of Object.entries(numeric)) args.push(flag, String(parsed[key]));
  return args;
}
