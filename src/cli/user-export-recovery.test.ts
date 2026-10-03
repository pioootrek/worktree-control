import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { listenAdminSocket } from "@/server/admin-socket";
import { resolveAppPaths } from "@/server/paths";
import { acquireControllerLock } from "@/server/controller-lock";
import { backupAdminHandler } from "@/server/backup-admin";
import type { BackupOperations, RestoreOperations, UserSchedules } from "@/server/modules/backups";
import { runBackupCommand } from "./backup-management";

it("CLI recovery requires exact IDs, uses operator authority on the private socket and never opens offline SQLite", async () => {
  const root = mkdtempSync(join(tmpdir(), "cleanup-admin-")), paths = resolveAppPaths(join(root, "data"), join(root, "state")), lock = acquireControllerLock(paths.controllerLockPath);
  const recover = vi.fn(async () => ({ state: "completed" }));
  const admin = await listenAdminSocket(paths.adminSocketPath, backupAdminHandler({} as BackupOperations, {} as RestoreOperations, { recover } as unknown as UserSchedules));
  try {
    const output: string[] = [];
    await runBackupCommand(["user-cleanup", "cleanup", "execution-id", "confirmation-id"], paths, "test", line => output.push(line));
    expect(recover).toHaveBeenCalledWith("local-admin", { action: "cleanup", executionId: "execution-id", confirmation: "confirmation-id" });
    expect(JSON.parse(output[0]!)).toEqual({ state: "completed" });
    for (const args of [["list", "/arbitrary"], ["cleanup", "id"], ["preview", "id", "extra"], ["cleanup", "id", "confirmation", "/arbitrary"]]) await expect(runBackupCommand(["user-cleanup", ...args], paths, "test")).rejects.toThrow("Usage");
    expect(recover).toHaveBeenCalledTimes(1);
    await admin.close(); await expect(runBackupCommand(["user-cleanup", "list"], paths, "test")).rejects.toThrow();
  } finally { await admin.close(); lock.release(); rmSync(root, { recursive: true, force: true }); }
});
