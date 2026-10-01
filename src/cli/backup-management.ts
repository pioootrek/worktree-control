import { randomUUID } from "node:crypto";
import { requestControllerRestore, executeControllerRestoreRequest } from "@/server/restore-requests";
import type { AppPaths } from "@/server/paths";
import { acquireControllerLock } from "@/server/controller-lock";
import { createControllerBackup } from "@/server/controller-backup";
import { OwnedSqliteDatabase } from "@/server/infrastructure/sqlite";
import { SqliteStateStore } from "@/server/sqlite-store";
import { authenticateOfflineActor } from "./offline-actor";
import { cliCredential, OWNER_CREDENTIAL_REQUIRED, OWNER_CREDENTIAL_VARIABLES } from "./credentials";
import { exportKnowledgeProject, importKnowledgeProject } from "@/server/modules/knowledge";

export async function runBackupCommand(args: string[], paths: AppPaths, applicationVersion: string, write: (line:string)=>void=console.log, environment:Readonly<Record<string,string|undefined>>=process.env): Promise<void> {
  const [operation,...input]=args;
  const valid=(operation==="create"||operation==="restore"||operation==="import-project")?input.length===1:operation==="export-project"&&input.length===2;
  if(!valid) throw new Error("Usage: backup <create|restore|import-project> <directory> | backup export-project <project-id> <directory>");
  const lock=acquireControllerLock(paths.controllerLockPath);
  try {
    if(operation==="create") {
      const [directory]=input;
      const store=new OwnedSqliteDatabase(paths.databasePath);
      try { const result=await createControllerBackup(store,directory,{applicationVersion,attachmentDirectory:paths.knowledgeAttachmentDirectory}); write(JSON.stringify(result,null,2)); }
      finally { store.close(); }
    } else if(operation==="restore") { const actor = { actorId: `local-uid:${process.getuid?.() ?? "unknown"}`, backupId: "offline-cli", idempotencyKey: randomUUID() };
      // Local administrative invocation is the explicit confirmation. Future web
      // adapters provide their own operator policy and ID-to-catalog resolver.
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
