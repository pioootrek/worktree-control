import { BackupError, BackupOperations, backupPolicySchema, rebindRemoteBackup } from "@/server/modules/backups";
import { loadResticConfiguration, ResticBackupTransport } from "@/server/infrastructure/backups";
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
import { exportKnowledgeProject, importKnowledgeProject, loadAttachmentLimits } from "@/server/modules/knowledge";

export async function runBackupCommand(args: string[], paths: AppPaths, applicationVersion: string, write: (line:string)=>void=console.log, environment:Readonly<Record<string,string|undefined>>=process.env): Promise<void> {
  if (args[0] === "remote") {
    if (args[1] === "rebind") {
      if (args.length !== 8 || args[2] !== "--from" || args[4] !== "--target-config" || args[6] !== "--generation" || !/^[0-9]+$/.test(args[7])) throw new Error("Usage: backup remote rebind --from <destination-id> --target-config <private-json> --generation <next-generation>");
      let transport: ResticBackupTransport | undefined;
      try {
        transport = new ResticBackupTransport(loadResticConfiguration(readBoundedJson(resolve(args[5]), 16 * 1024, true)));
        const result = await rebindRemoteBackup({ controllerLockPath: paths.controllerLockPath, databasePath: paths.databasePath, from: args[3], destinationId: transport.destinationId, generation: Number(args[7]) }, directory => transport!.verifyRepository(directory));
        write(JSON.stringify(result, null, 2));
      } catch (error) {
        if (error instanceof BackupError && error.code === "backup_limit") throw new Error("Remote rebind archive/evidence limit reached (maximum 4 archives); preserve existing records and pins for operator review.");
        throw new Error("Remote rebind refused: verify singleton ownership, completed restore, private target configuration and generation.");
      }
      finally { await transport?.close(); }
      return;
    }
    const [, action, backupId, flag, generation, ...extra] = args;
    if (!((action === "status" && args.length === 2) || (action === "reupload" && backupId && args.length === 3) || (action === "retry" && backupId && flag === "--generation" && generation && /^[0-9]+$/.test(generation) && Number.isSafeInteger(Number(generation)) && Number(generation) > 0)) || extra.length) throw new Error("Usage: backup remote status | reupload <backup-id> | retry <backup-id> --generation <next-generation>");
    // Never open a second SQLite owner or infer a remote target from recovered DB data.
    const result = await requestAdminSocket(paths.adminSocketPath, { command: "backup-remote", action, ...(backupId ? { backupId } : {}), ...(action === "retry" ? { generation: Number(generation) } : {}) });
    write(JSON.stringify(result, null, 2)); return;
  }
  if (args[0] === "user-cleanup") {
    const [, action, executionId, confirmation, ...extra] = args;
    const valid = (action === "list" && !executionId) || (action === "preview" && executionId && !confirmation) || (action === "cleanup" && executionId && confirmation);
    if (!valid || extra.length) throw new Error("Usage: backup user-cleanup list | preview <execution-id> | cleanup <execution-id> <confirmation-id>");
    // Recovery requires the running controller's target policy and existing singleton owner.
    const result = await requestAdminSocket(paths.adminSocketPath, { command: "user-export-recovery", action, ...(executionId ? { executionId } : {}), ...(confirmation ? { confirmation } : {}) });
    write(JSON.stringify(result, null, 2)); return;
  }
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
        const result=operation==="export-project"?exportKnowledgeProject(store,identity,input[0]!,input[1]!,paths.knowledgeAttachmentDirectory,actor,{applicationVersion,limits:loadAttachmentLimits(paths.dataDirectory)})
          :importKnowledgeProject(store,identity,input[0]!,paths.knowledgeAttachmentDirectory,actor,loadAttachmentLimits(paths.dataDirectory)); write(JSON.stringify(result,null,2));
      } finally {store.close();}
    }
  } finally { lock.release(); }
}
