import { z } from "zod";
import { BackupError, type BackupOperations, type RestoreOperations } from "./modules/backups";
import { backupCommandSchema } from "@/shared/contracts/backups";

const inputSchema = z.object({ command: z.literal("backup"), operation: z.enum(["create", "now", "restore", "status", "list"]), destination: z.string().min(1).max(4096).optional(), idempotencyKey: z.string().min(1).max(256).optional(), backupId: z.string().optional() }).strict();
export function backupAdminHandler(backups: BackupOperations, restores: RestoreOperations): (body: unknown) => unknown {
  return body => {
    const input = inputSchema.parse(body);
    if (input.operation === "list") return backups.overview("local-admin");
    if (input.operation === "status") {
      if (!input.idempotencyKey) throw new BackupError("backup_invalid");
      return input.backupId ? restores.status("local-admin", input.backupId, input.idempotencyKey) : backups.status("local-admin", input.idempotencyKey);
    }
    if (!input.idempotencyKey) throw new BackupError("backup_invalid");
    if (input.operation === "create" || input.operation === "now") return backups.create("local-admin", input.idempotencyKey, input.destination);
    // A running restore selects only a configured catalog ID, never a web path.
    const id = input.backupId;
    const request = backupCommandSchema.parse({ action: "restore", backupId: id, idempotencyKey: input.idempotencyKey, confirmation: "replace-entire-installation" });
    const status = restores.admit("local-admin", request);
    setImmediate(() => restores.launch("local-admin", { backupId: id!, idempotencyKey: input.idempotencyKey! }));
    return status;
  };
}
