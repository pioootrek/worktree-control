import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { acquireControllerLock } from "@/server/controller-lock";
import { AuthenticationService } from "@/server/modules/authentication";
import { IdentityService } from "@/server/modules/identity";
import { KnowledgeService } from "@/server/modules/knowledge";
import { resolveAppPaths } from "@/server/paths";
import { SqliteStateStore } from "@/server/sqlite-store";
import { runAuthCommand } from "./auth-management";
import { runBackupCommand } from "./backup-management";
const roots:string[]=[]; afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
it("creates and restores a controller backup through the offline owner CLI seam",async()=>{
  const root=mkdtempSync(join(tmpdir(),"backup-cli-")); roots.push(root); const paths=resolveAppPaths(join(root,"data"),join(root,"state"));
  const store=new SqliteStateStore(paths.databasePath); store.addProject({name:"Kept",repositoryPath:join(root,"repo"),port:4567,executable:"pnpm",args:["dev"]}); store.close();
  const backup=join(root,"backup"); await runBackupCommand(["create",backup],paths,"test",()=>{});
  const changed=new SqliteStateStore(paths.databasePath); changed.removeProject(changed.listProjects()[0]!.id,"test"); changed.close();
  await runBackupCommand(["restore",backup],paths,"test",()=>{});
  const restored=new SqliteStateStore(paths.databasePath); expect(restored.listProjects()[0]?.name).toBe("Kept"); restored.close();
});
it("exports and imports a logical project in open mode without token variables and requires a credential in token mode",async()=>{
  const root=mkdtempSync(join(tmpdir(),"backup-cli-open-")); roots.push(root);
  const source=resolveAppPaths(join(root,"source"),join(root,"source-state")),target=resolveAppPaths(join(root,"target"),join(root,"target-state"));
  let token="";
  for(const paths of [source,target]){ const lines:string[]=[]; await runAuthCommand(["token","generate"],paths,{write:line=>lines.push(line)}); if(paths===source) token=(JSON.parse(lines[0]!) as {token:string}).token; await runAuthCommand(["mode","set","open"],paths,{write:()=>{}}); }
  const store=new SqliteStateStore(source.databasePath); let projectId:string;
  try { const authentication=new AuthenticationService(store),identity=new IdentityService(store,undefined,undefined,undefined,authentication),anonymous=authentication.anonymousInstallation()!;
    projectId=identity.createKnowledgeProject({name:"Open project"},anonymous).id;
    new KnowledgeService(store,identity).execute({operation:"create_task",input:{projectId,title:"Anonymous",description:"Open mode",idempotencyKey:"open"}},anonymous);
  } finally { store.close(); }
  const exported=join(root,"export"),lines:string[]=[];
  const lock=acquireControllerLock(source.controllerLockPath);
  try { await expect(runBackupCommand(["export-project",projectId,exported],source,"test",()=>{},{})).rejects.toThrow("already running"); } finally { lock.release(); }
  await runBackupCommand(["export-project",projectId,exported],source,"test",line=>lines.push(line),{});
  expect(JSON.parse(lines[0]!)).toMatchObject({projectId});
  await runBackupCommand(["import-project",exported],target,"test",()=>{},{});
  const database=new Database(target.databasePath,{readonly:true});
  expect(database.prepare("SELECT principal_id, authentication_method FROM knowledge_history WHERE project_id = ? AND record_kind = 'task'").all(projectId))
    .toEqual([{principal_id:"installation",authentication_method:"none"}]);
  database.close();

  await runAuthCommand(["mode","set","token"],source,{write:()=>{}});
  await expect(runBackupCommand(["export-project",projectId,join(root,"missing")],source,"test",()=>{},{})).rejects.toThrow("WORKTREE_SWITCHER_OWNER_TOKEN");
  await expect(runBackupCommand(["export-project",projectId,join(root,"invalid")],source,"test",()=>{},{WORKTREE_SWITCHER_TOKEN:`${token}0`})).rejects.toThrow("Nieprawidłowe lub nieaktywne");
  await runBackupCommand(["export-project",projectId,join(root,"token")],source,"test",()=>{},{WORKTREE_SWITCHER_TOKEN:token});
});
