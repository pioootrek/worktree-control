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
  backupBeforeMigration?: boolean;
  backupDirectory?: string;
}

export function buildServiceStartArguments(options: ServiceStartArgumentsOptions): string[] {
  if (options.backupBeforeMigration && !options.backupDirectory) throw new Error("--backup-before-migration requires --backup-dir.");
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
  if (options.backupDirectory) arguments_.push("--backup-dir", options.backupDirectory);
  if (options.backupBeforeMigration) arguments_.push("--backup-before-migration");
  return arguments_;
}
