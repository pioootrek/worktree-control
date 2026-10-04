import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IdentityService } from "@/server/modules/identity";
import { exportKnowledgeProject, importKnowledgeProject, KnowledgeAttachmentService, KnowledgeService } from "@/server/modules/knowledge";
import { SqliteStateStore } from "./sqlite-state-store";
import { runBackupCommand } from "@/cli/backup-management";
import { resolveAppPaths } from "@/server/paths";

const roots:string[]=[]; afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
type MutableSnapshot={memories:Array<Record<string,unknown>>;attachments:Array<Record<string,unknown>>;requiredPrincipals:string[]};
function rewriteSnapshot(directory:string,change:(snapshot:MutableSnapshot)=>void){const dataPath=join(directory,"project.json"),manifestPath=join(directory,"manifest.json"),snapshot=JSON.parse(readFileSync(dataPath,"utf8")) as MutableSnapshot,manifest=JSON.parse(readFileSync(manifestPath,"utf8")); change(snapshot); const data=Buffer.from(JSON.stringify(snapshot)); writeFileSync(dataPath,data); manifest.data.size=data.byteLength; manifest.data.sha256=createHash("sha256").update(data).digest("hex"); writeFileSync(manifestPath,JSON.stringify(manifest));}
function fixture(root:string){
  const ids=["00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002","project-1","thread-1","reply-1","task-1","relation-1","memory-1","attachment-1","temporary-1"];
  let next=0; const id=()=>ids[next++]!; const store=new SqliteStateStore(join(root,"state.sqlite3")); const identity=new IdentityService(store,()=>"2026-09-14T10:00:00.000Z",id,()=>"a".repeat(64));
  const token=identity.bootstrapOwnerSession().token,owner=identity.authenticateBearer(token); const project=identity.createKnowledgeProject({name:"Portable"},owner);
  identity.setKnowledgeGrant({principalId:owner.principalId,projectId:project.id,permissions:["knowledge:read","knowledge:write","knowledge:approve","knowledge:export","knowledge:import","attachments:read","attachments:write"]},owner);
  const knowledge=new KnowledgeService(store,identity,()=>"2026-09-14T10:00:00.000Z",id); const thread=knowledge.createThread(project.id,{title:"Decision","body":"Keep knowledge separate."},{idempotencyKey:"thread"},owner).value;
  knowledge.createReply(project.id,thread.id,{body:"Agreed."},{idempotencyKey:"reply"},owner); const task=knowledge.createTaskFromThread(project.id,thread.id,{title:"Implement","description":"Round trip","priority":"now"},{idempotencyKey:"task"},owner).value.task;
  knowledge.execute({operation:"create_memory",input:{projectId:project.id,idempotencyKey:"memory",title:"Boundary",body:"No runtime state",category:"decision",tags:["k5"],legacyId:null,sources:[{kind:"task",id:task.id,revision:task.revision}]}},owner);
  const attachmentDirectory=join(root,"knowledge-attachments"); new KnowledgeAttachmentService(store,identity,attachmentDirectory,undefined,()=>"2026-09-14T10:00:00.000Z",id).upload(project.id,"task",task.id,{filename:"proof.txt",mediaType:"text/plain",data:Buffer.from("evidence"),idempotencyKey:"attachment"},owner);
  return {store,identity,owner,token,project,attachmentDirectory};
}

describe("logical knowledge project transfer",()=>{
  it("round-trips one project without runtime state, grants or credentials",()=>{
    const sourceRoot=mkdtempSync(join(tmpdir(),"knowledge-export-source-")),targetRoot=mkdtempSync(join(tmpdir(),"knowledge-export-target-")); roots.push(sourceRoot,targetRoot);
    const source=fixture(sourceRoot), destination=join(sourceRoot,"portable-project"); const manifest=exportKnowledgeProject(source.store,source.identity,source.project.id,destination,source.attachmentDirectory,source.owner,{applicationVersion:"test"});
    expect(manifest.counts).toMatchObject({threads:1,replies:1,tasks:1,memories:1,relations:1,attachments:1});
    const sourceSnapshot=source.store.exportKnowledgeProject(source.project.id); source.store.close();
    let n=0; const ids=["00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002"]; const targetStore=new SqliteStateStore(join(targetRoot,"state.sqlite3")); const targetIdentity=new IdentityService(targetStore,undefined,()=>ids[n++]!,()=>"a".repeat(64)); const targetOwner=targetIdentity.authenticateBearer(targetIdentity.bootstrapOwnerSession().token);
    targetStore.saveKnowledgeProject({id:"existing-project",name:"Existing",status:"active",revision:1,createdAt:"2026-09-14T09:00:00.000Z",updatedAt:"2026-09-14T09:00:00.000Z"},targetOwner.principalId);
    targetStore.createThread({id:"existing-thread",projectId:"existing-project",title:"Keep",body:"Untouched",revision:1,createdBy:targetOwner.principalId,createdAt:"2026-09-14T09:00:00.000Z",updatedAt:"2026-09-14T09:00:00.000Z"},{actor:targetOwner,projectId:"existing-project",idempotencyKey:"existing",requestHash:"0".repeat(64)});
    const existing=targetStore.exportKnowledgeProject("existing-project"); importKnowledgeProject(targetStore,targetIdentity,destination,join(targetRoot,"knowledge-attachments"),targetOwner);
    expect(targetStore.exportKnowledgeProject(source.project.id)).toEqual(sourceSnapshot); expect(targetStore.exportKnowledgeProject("existing-project")).toEqual(existing);
    expect(targetStore.listProjects()).toEqual([]); expect(targetStore.listKnowledgeProjectGrants(targetOwner.principalId)).toEqual([]);
    const importedObject=join(targetRoot,"knowledge-attachments",createHash("sha256").update("evidence").digest("hex").slice(0,2),createHash("sha256").update("evidence").digest("hex"));
    expect(readFileSync(importedObject,"utf8")).toBe("evidence"); expect(statSync(importedObject).mode&0o777).toBe(0o600);
    targetStore.close();
  });

  it("rejects tampering and a project collision without changing existing knowledge",()=>{
    const root=mkdtempSync(join(tmpdir(),"knowledge-export-invalid-")); roots.push(root); const f=fixture(root), destination=join(root,"export"); exportKnowledgeProject(f.store,f.identity,f.project.id,destination,f.attachmentDirectory,f.owner,{applicationVersion:"test"});
    const data=join(destination,"project.json"), original=readFileSync(data); writeFileSync(data,Buffer.concat([original,Buffer.from(" ")]));
    expect(()=>importKnowledgeProject(f.store,f.identity,destination,f.attachmentDirectory,f.owner)).toThrowError(expect.objectContaining({code:"invalid_request"}));
    writeFileSync(data,original); expect(()=>importKnowledgeProject(f.store,f.identity,destination,f.attachmentDirectory,f.owner)).toThrowError(expect.objectContaining({code:"invalid_request"})); expect(f.store.listThreads(f.project.id,25,0).items).toHaveLength(1); f.store.close();
    expect(existsSync(destination)).toBe(true);
  });

  it("rejects archived project snapshots instead of importing an inaccessible project",()=>{
    const root=mkdtempSync(join(tmpdir(),"knowledge-import-archived-")); roots.push(root); const f=fixture(root),destination=join(root,"export"); exportKnowledgeProject(f.store,f.identity,f.project.id,destination,f.attachmentDirectory,f.owner,{applicationVersion:"test"});
    rewriteSnapshot(destination,snapshot=>{(snapshot as MutableSnapshot&{project:{status:string}}).project.status="archived";});
    expect(()=>importKnowledgeProject(f.store,f.identity,destination,join(root,"imported-attachments"),f.owner)).toThrowError(expect.objectContaining({code:"invalid_request",message:"Archived knowledge projects cannot be imported."})); f.store.close();
  });

  it("exports a project through the offline owner CLI command",async()=>{
    const root=mkdtempSync(join(tmpdir(),"knowledge-export-cli-")); roots.push(root); const f=fixture(root),destination=join(root,"cli-export"),lines:string[]=[]; f.store.close();
    await runBackupCommand(["export-project",f.project.id,destination],resolveAppPaths(root,join(root,"state")),"test",line=>lines.push(line),{WORKTREE_SWITCHER_OWNER_TOKEN:f.token});
    expect(existsSync(join(destination,"manifest.json"))).toBe(true); expect(JSON.parse(lines[0]!)).toMatchObject({projectId:f.project.id,formatVersion:1});
  });

  it("rejects revoked and expired owner sessions before reading the package",()=>{
    const root=mkdtempSync(join(tmpdir(),"knowledge-import-auth-")); roots.push(root); let now="2026-09-14T10:00:00.000Z",next=0; const ids=["10000000-0000-4000-8000-000000000001","10000000-0000-4000-8000-000000000002"];
    const store=new SqliteStateStore(join(root,"state.sqlite3")),identity=new IdentityService(store,()=>now,()=>ids[next++]!,()=>"b".repeat(64)),issued=identity.bootstrapOwnerSession({sessionLifetimeSeconds:60}),actor=identity.authenticateBearer(issued.token);
    store.revokeCredential(actor.credentialId,now,actor.principalId); expect(()=>importKnowledgeProject(store,identity,join(root,"missing"),join(root,"attachments"),actor)).toThrowError(expect.objectContaining({code:"invalid_credential"})); store.close();
    const expiryRoot=mkdtempSync(join(tmpdir(),"knowledge-import-expiry-")); roots.push(expiryRoot); next=0; now="2026-09-14T10:00:00.000Z"; const expiringStore=new SqliteStateStore(join(expiryRoot,"state.sqlite3")),expiringIdentity=new IdentityService(expiringStore,()=>now,()=>ids[next++]!,()=>"c".repeat(64)),expiring=expiringIdentity.bootstrapOwnerSession({sessionLifetimeSeconds:60}),expiringActor=expiringIdentity.authenticateBearer(expiring.token); now="2026-09-14T10:02:00.000Z";
    expect(()=>importKnowledgeProject(expiringStore,expiringIdentity,join(expiryRoot,"missing"),join(expiryRoot,"attachments"),expiringActor)).toThrowError(expect.objectContaining({code:"invalid_credential"})); expiringStore.close();
  });

  it("validates nested JSON and attachment record limits",()=>{
    const root=mkdtempSync(join(tmpdir(),"knowledge-import-schema-")); roots.push(root); const f=fixture(root),destination=join(root,"export"); exportKnowledgeProject(f.store,f.identity,f.project.id,destination,f.attachmentDirectory,f.owner,{applicationVersion:"test"});
    rewriteSnapshot(destination,snapshot=>{snapshot.memories[0].tags_json="not json";}); expect(()=>importKnowledgeProject(f.store,f.identity,destination,f.attachmentDirectory,f.owner)).toThrowError(expect.objectContaining({code:"invalid_request"}));
    rmSync(destination,{recursive:true}); exportKnowledgeProject(f.store,f.identity,f.project.id,destination,f.attachmentDirectory,f.owner,{applicationVersion:"test"}); rewriteSnapshot(destination,snapshot=>{const attachment=snapshot.attachments[0]; snapshot.attachments=Array.from({length:5001},(_,index)=>({...attachment,id:`attachment-${index}`})); snapshot.requiredPrincipals=[f.owner.principalId];});
    const manifestPath=join(destination,"manifest.json"),manifest=JSON.parse(readFileSync(manifestPath,"utf8")); manifest.counts.attachments=5001; writeFileSync(manifestPath,JSON.stringify(manifest)); expect(()=>importKnowledgeProject(f.store,f.identity,destination,f.attachmentDirectory,f.owner)).toThrowError(expect.objectContaining({code:"limit_exceeded"})); f.store.close();
  });

  it("rejects conflicting sizes on references sharing one declared hash", () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-import-conflict-")); roots.push(root);
    const f = fixture(root), destination = join(root, "export");
    try {
      exportKnowledgeProject(f.store, f.identity, f.project.id, destination, f.attachmentDirectory, f.owner, { applicationVersion: "test" });
      rewriteSnapshot(destination, snapshot => { snapshot.attachments.unshift({ ...snapshot.attachments[0], id: "conflicting-reference", size: 1 }); });
      const manifestPath = join(destination, "manifest.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.counts.attachments = 2; writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(() => importKnowledgeProject(f.store, f.identity, destination, f.attachmentDirectory, f.owner)).toThrowError(expect.objectContaining({ code: "invalid_request", message: "Conflicting attachment metadata in project snapshot." }));
      expect(f.store.exportKnowledgeProject(f.project.id)!.attachments).toHaveLength(1);
    } finally { f.store.close(); }
  });

  it("retains durable objects when database publication fails",()=>{
    const sourceRoot=mkdtempSync(join(tmpdir(),"knowledge-import-rollback-source-")),targetRoot=mkdtempSync(join(tmpdir(),"knowledge-import-rollback-target-")); roots.push(sourceRoot,targetRoot); const source=fixture(sourceRoot),destination=join(sourceRoot,"export"); exportKnowledgeProject(source.store,source.identity,source.project.id,destination,source.attachmentDirectory,source.owner,{applicationVersion:"test"}); source.store.close();
    let next=0; const ids=["20000000-0000-4000-8000-000000000001","20000000-0000-4000-8000-000000000002"],store=new SqliteStateStore(join(targetRoot,"state.sqlite3")),identity=new IdentityService(store,undefined,()=>ids[next++]!,()=>"d".repeat(64)),actor=identity.authenticateBearer(identity.bootstrapOwnerSession().token),attachments=join(targetRoot,"knowledge-attachments"),sha=createHash("sha256").update("evidence").digest("hex");
    expect(()=>importKnowledgeProject(store,identity,destination,attachments,actor)).toThrowError(expect.objectContaining({code:"invalid_request"})); expect(existsSync(join(attachments,sha.slice(0,2),sha))).toBe(true); expect(store.getKnowledgeProject(source.project.id)).toBeNull(); store.close();
  });
});
