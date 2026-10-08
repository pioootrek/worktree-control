import { backupPolicyArguments } from "./backup-policy-options";
import { userBackupArguments } from "./user-backup-options";
import { remoteBackupArguments, type RemoteBackupOptions } from "./remote-backup-options";
import { userBackupPolicySchema, type UserBackupPolicy } from "@/server/modules/backups";
import { backupPolicySchema, type BackupPolicy } from "@/server/modules/backups";
import { resolve } from "node:path";
import { mcpSessionArguments, type McpSessionOptions } from "./mcp-session-options";
export interface ServiceStartArgumentsOptions {
  host: string;
  port: number;
  mcpPort: number;
  browseRoot: string;
  dataDirectory: string;
  stateDirectory: string;
  webRoot: string;
  noMcp: boolean;
  memoryWarningMiB: number | null;
  publicOrigin?: string;
  mcpSessionOptions?: McpSessionOptions;
  backupBeforeMigration?: boolean;
  backupDirectory?: string;
  backupPolicy?: BackupPolicy;
  userBackupPolicy?: UserBackupPolicy;
  remoteBackupOptions?: RemoteBackupOptions;
}

export function buildServiceStartArguments(options: ServiceStartArgumentsOptions): string[] {
  if (options.backupBeforeMigration && !options.backupDirectory) throw new Error("--backup-before-migration requires --backup-dir.");
  const policy = options.backupPolicy ? backupPolicySchema.parse(options.backupPolicy) : undefined;
  const userPolicy = options.userBackupPolicy ? userBackupPolicySchema.parse(options.userBackupPolicy) : undefined;
  if (policy?.directory && (!options.backupDirectory || resolve(options.backupDirectory) !== resolve(policy.directory))) throw new Error("Service backup destination does not match its startup policy.");
  const arguments_ = [
    "--service-mode", "--no-open",
    "--host", options.host,
    "--port", String(options.port),
    "--mcp-port", String(options.mcpPort),
    "--browse-root", options.browseRoot,
    "--data-dir", options.dataDirectory,
    "--state-dir", options.stateDirectory,
    "--web-root", options.webRoot,
  ];
  if (options.noMcp) arguments_.push("--no-mcp");
  if (options.memoryWarningMiB !== null) arguments_.push("--memory-warning-mib", String(options.memoryWarningMiB));
  if (options.publicOrigin) arguments_.push("--public-url", options.publicOrigin);
  if (options.mcpSessionOptions) arguments_.push(...mcpSessionArguments(options.mcpSessionOptions));
  if (options.backupDirectory) arguments_.push("--backup-dir", options.backupDirectory);
  if (options.backupBeforeMigration) arguments_.push("--backup-before-migration");
  if (policy) arguments_.push(...backupPolicyArguments(policy));
  if (userPolicy) arguments_.push(...userBackupArguments(userPolicy));
  if (options.remoteBackupOptions) arguments_.push(...remoteBackupArguments(options.remoteBackupOptions));
  return arguments_;
}
