import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { acquireControllerLock } from "./controller-lock";
import { listenAdminSocket } from "./admin-socket";
import { resolveAppPaths } from "./paths";
import { SqliteStateStore } from "./sqlite-store";
import { BackupOperations, RestoreOperations, backupPolicySchema } from "./modules/backups";
import { backupAdminHandler } from "./backup-admin";
import { runBackupCommand } from "@/cli/backup-management";
import { probeBackupMonitor, parseBackupMonitorOptions } from "@/cli/backup-monitor";
it("routes active CLI backup through the private admin socket using the existing database owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "backup-admin-")), paths = resolveAppPaths(join(root, "data"), join(root, "state"));
  const lock = acquireControllerLock(paths.controllerLockPath), store = new SqliteStateStore(paths.databasePath);
  const operations = new BackupOperations(backupPolicySchema.parse({ directory: join(root, "copies") }), { databasePath: paths.databasePath, attachmentDirectory: paths.knowledgeAttachmentDirectory, applicationVersion: "test", source: store, estimateBytes: () => store.backupEstimateBytes(), authorize: () => false, maintenance: () => false });
  const restores = new RestoreOperations(operations, paths.databasePath, paths.knowledgeAttachmentDirectory, { authentication: () => store.getAuthenticationPolicy(), enterMaintenance: () => {}, restart: async () => {}, failure: () => {} });
  const admin = await listenAdminSocket(paths.adminSocketPath, backupAdminHandler(operations, restores));
  try {
    const output: string[] = [];
    await runBackupCommand(["now", "--idempotency-key", "active"], paths, "test", line => output.push(line));
    await operations.drain();
    await runBackupCommand(["now", "--idempotency-key", "active"], paths, "test", line => output.push(line));
    expect(JSON.parse(output[0]!).operationId).toBe(JSON.parse(output[1]!).operationId);
    expect(operations.overview("local-admin").copies).toHaveLength(1);
    expect(await probeBackupMonitor(paths.adminSocketPath, parseBackupMonitorOptions(["--enabled"]))).toMatchObject({ controller: "available", severity: "disabled", alerts: [], metadata: { local: { lastAttempt: { state: "succeeded" } } } });
    expect(() => new SqliteStateStore(paths.databasePath)).toThrow(/already running/);
    await admin.close();
    await expect(runBackupCommand(["now", "--idempotency-key", "no-channel"], paths, "test", () => {})).rejects.toThrow();
    expect(store.listProjects()).toEqual([]);
  } finally { await admin.close(); await operations.close(); store.close(); lock.release(); rmSync(root, { recursive: true, force: true }); }
});
