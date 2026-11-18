import { startWorkerProcess } from "@/server/bootstrap/worker-process";
import { resolveAppPaths } from "@/server/paths";
import { parseBackupPolicyOptions, validateBackupPolicyDestination } from "./backup-policy-options";
import { parseMigrationBackupOptions } from "./migration-backup-options";
import { loadWorkerProcessConfig, readWorkerCredential } from "./remote-worker-config";

export const WORKER_USAGE = "Usage: worker start --config FILE [--data-dir PATH] [--state-dir PATH] [--backup-dir PATH] [--backup-before-migration]";
const VALUE_OPTIONS = ["--config", "--data-dir", "--state-dir", "--backup-dir"];

export interface WorkerStartOptions {
  configPath: string;
  dataDirectory?: string;
  stateDirectory?: string;
  /** Only the migration-backup flags; schedules, web actions and remote transfer are controller options. */
  backupArgs: string[];
}

export function parseWorkerStartArgs(args: readonly string[]): WorkerStartOptions {
  if (args[0] !== "start") throw new Error(WORKER_USAGE);
  const values = new Map<string, string>();
  const backupArgs: string[] = [];
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--backup-before-migration") { backupArgs.push(flag); continue; }
    const value = args[index + 1];
    if (!VALUE_OPTIONS.includes(flag) || values.has(flag) || !value || value.startsWith("--")) throw new Error(WORKER_USAGE);
    values.set(flag, value);
    if (flag === "--backup-dir") backupArgs.push(flag, value);
    index++;
  }
  const configPath = values.get("--config");
  if (!configPath) throw new Error(WORKER_USAGE);
  return { configPath, dataDirectory: values.get("--data-dir"), stateDirectory: values.get("--state-dir"), backupArgs };
}

/** `worker start`: runs until SIGINT or SIGTERM, then exits 0 after a clean shutdown. */
export async function runWorkerCommand(args: readonly string[], dependencies: { version: string; write(line: string): void; error(line: string): void }): Promise<void> {
  const options = parseWorkerStartArgs(args);
  const migrationBackup = parseMigrationBackupOptions(options.backupArgs);
  const backupPolicy = parseBackupPolicyOptions(options.backupArgs);
  validateBackupPolicyDestination(backupPolicy);
  const config = loadWorkerProcessConfig(options.configPath);
  // Refuse an unsafe or malformed credential before taking the lock; requests reread the file.
  readWorkerCredential(config.credentialFile);
  const worker = await startWorkerProcess({
    paths: resolveAppPaths(options.dataDirectory, options.stateDirectory),
    settings: config, credential: () => readWorkerCredential(config.credentialFile),
    migrationBackup, backupPolicy, applicationVersion: dependencies.version,
  });
  dependencies.write(`Worktree Control worker ${config.workerId} polling ${new URL(config.origin).origin}`);
  if (worker.admissionBlockReason) dependencies.error(`Test admission is blocked: ${worker.admissionBlockReason}`);
  const handleSignal = () => void worker.shutdown(() => {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }).then(
    () => process.exit(0),
    (error: unknown) => {
      // Ownership stays retained: the lock is held and the process keeps running for operator recovery.
      dependencies.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
}
