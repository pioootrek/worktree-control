import { BackupOperations, backupPolicySchema } from "@/server/modules/backups";
import { BACKUP_LIMITS, parseManifest, readBoundedJson } from "@/server/infrastructure/sqlite";
import { randomUUID } from "node:crypto";
import { requestControllerRestore, executeControllerRestoreRequest } from "@/server/restore-requests";
import type { AppPaths } from "@/server/paths";
import { requestAdminSocket } from "@/server/admin-socket";
import { basename, resolve, join } from "node:path";
import { acquireControllerLock, ControllerAlreadyRunningError } from "@/server/controller-lock";
import { OwnedSqliteDatabase } from "@/server/infrastructure/sqlite";
import { SqliteStateStore } from "@/server/sqlite-store";
import { authenticateOfflineActor } from "./offline-actor";
import { cliCredential, OWNER_CREDENTIAL_REQUIRED, OWNER_CREDENTIAL_VARIABLES } from "./credentials";
import { exportKnowledgeProject, importKnowledgeProject } from "@/server/modules/knowledge";

export async function runBackupCommand(args: string[], paths: AppPaths, applicationVersion: string, write: (line:string)=>void=console.log, environment:Readonly<Record<string,string|undefined>>=process.env): Promise<void> {
  const keyIndex = args.indexOf("--idempotency-key");
  const key = keyIndex >= 0 ? args[keyIndex + 1] : randomUUID();
  if (!key || key.startsWith("--") || key.length > 256 || args.filter(value => value === "--idempotency-key").length > 1) throw new Error("Invalid backup idempotency key.");
  const values = keyIndex >= 0 ? args.filter((_, index) => index !== keyIndex && index !== keyIndex + 1) : args;
  const [operation,...input]=values;
  if (operation === "status" && keyIndex < 0) throw new Error("Backup status requires --idempotency-key.");
  const valid=(["now", "list"].includes(operation) && input.length === 0) || (operation === "status" && input.length <= 1) || (["create", "restore", "import-project"].includes(operation) && input.length === 1) || (operation === "export-project" && input.length === 2);
  if(!valid) throw new Error("Usage: backup create|restore <directory> [--idempotency-key key] | backup now|list | backup status [backup-id] --idempotency-key key | backup export-project <project-id> <directory> | backup import-project <directory>");
  let lock;
  try { lock = acquireControllerLock(paths.controllerLockPath); }
  catch (error) {
    if (!(error instanceof ControllerAlreadyRunningError) || !["create", "restore", "now", "list", "status"].includes(operation)) throw error;
    const result = await requestAdminSocket(paths.adminSocketPath, {
      command: "backup", operation, idempotencyKey: key,
      ...(operation === "create" ? { destination: resolve(input[0]!) } : {}),
      ...((operation === "restore" || (operation === "status" && input[0])) ? { backupId: basename(input[0]!) } : {}),
    });
    write(JSON.stringify(result, null, 2)); return;
  }
  try {
    if (["now", "list", "status"].includes(operation)) throw new Error("This backup command requires an active controller and its CLI startup policy.");
    if(operation==="create") {
      const [directory]=input;
      const store=new OwnedSqliteDatabase(paths.databasePath);
      let operations: BackupOperations | undefined;
      try {
        operations = new BackupOperations(backupPolicySchema.parse({ maxBytes: BACKUP_LIMITS.totalBytes }), { databasePath: paths.databasePath, attachmentDirectory: paths.knowledgeAttachmentDirectory, applicationVersion, source: store, estimateBytes: () => store.backupEstimateBytes(), authorize: () => false, maintenance: () => false, manageSchedule: false });
        operations.create("local-admin", key, resolve(directory)); await operations.drain();
        const status = operations.status("local-admin", key);
        if (status.state !== "succeeded") throw new Error(`Backup ${status.state}: ${status.error}`);
        write(JSON.stringify(parseManifest(readBoundedJson(join(directory, "manifest.json"), BACKUP_LIMITS.manifestBytes)), null, 2));
      } finally { await operations?.close(); store.close(); }
    } else if(operation==="restore") { const actor = { actorId: `local-uid:${process.getuid?.() ?? "unknown"}`, backupId: "offline-cli", idempotencyKey: key };
      // Offline local administration is explicit confirmation under singleton ownership.
      const policy = { authorize: () => {}, resolveBackup: () => input[0]! };
      requestControllerRestore(paths.databasePath, actor.actorId, { backupId: actor.backupId, idempotencyKey: actor.idempotencyKey, confirmation: "replace-entire-installation" }, policy);
      executeControllerRestoreRequest(paths.databasePath, paths.knowledgeAttachmentDirectory, actor, policy); write("Backup restored.");
    } else {
      const token=cliCredential(environment,OWNER_CREDENTIAL_VARIABLES);
      const store=new SqliteStateStore(paths.databasePath); try { const {identity,actor}=authenticateOfflineActor(store,token,OWNER_CREDENTIAL_REQUIRED);
        const result=operation==="export-project"?exportKnowledgeProject(store,identity,input[0]!,input[1]!,paths.knowledgeAttachmentDirectory,actor,{applicationVersion})
          :importKnowledgeProject(store,identity,input[0]!,paths.knowledgeAttachmentDirectory,actor); write(JSON.stringify(result,null,2));
      } finally {store.close();}
    }
  } finally { lock.release(); }
}
