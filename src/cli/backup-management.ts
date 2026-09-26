import type { AppPaths } from "@/server/paths";
import { acquireControllerLock } from "@/server/controller-lock";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { SqliteStateStore } from "@/server/sqlite-store";
import { authenticateOfflineActor } from "./offline-actor";
import { exportKnowledgeProject, importKnowledgeProject } from "@/server/modules/knowledge";

export async function runBackupCommand(args: string[], paths: AppPaths, applicationVersion: string, write: (line:string)=>void=console.log, environment:Readonly<Record<string,string|undefined>>=process.env): Promise<void> {
  const [operation,...input]=args;
  const valid=(operation==="create"||operation==="restore"||operation==="import-project")?input.length===1:operation==="export-project"&&input.length===2;
  if(!valid) throw new Error("Usage: backup <create|restore|import-project> <directory> | backup export-project <project-id> <directory>");
  const lock=acquireControllerLock(paths.controllerLockPath);
  try {
    if(operation==="create") {
      const [directory]=input;
      const store=new SqliteStateStore(paths.databasePath);
      try { const result=await createControllerBackup(store,directory,{applicationVersion,attachmentDirectory:paths.knowledgeAttachmentDirectory}); write(JSON.stringify(result,null,2)); }
      finally { store.close(); }
    } else if(operation==="restore") { restoreControllerBackup(input[0]!,paths.databasePath,paths.knowledgeAttachmentDirectory); write("Backup restored.");
    } else {
      const token=environment.WORKTREE_SWITCHER_OWNER_TOKEN; if(!token) throw new Error("Set WORKTREE_SWITCHER_OWNER_TOKEN to an active owner session.");
      const store=new SqliteStateStore(paths.databasePath); try { const {identity,actor}=authenticateOfflineActor(store,token);
        const result=operation==="export-project"?exportKnowledgeProject(store,identity,input[0]!,input[1]!,paths.knowledgeAttachmentDirectory,actor,{applicationVersion})
          :importKnowledgeProject(store,identity,input[0]!,paths.knowledgeAttachmentDirectory,actor); write(JSON.stringify(result,null,2));
      } finally {store.close();}
    }
  } finally { lock.release(); }
}
