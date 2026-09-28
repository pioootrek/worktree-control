import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { afterEach, describe, expect, it } from "vitest";

import { IdentityService } from "@/server/modules/identity";
import { AuthenticationService } from "@/server/modules/authentication";
import { calculateHubImportPlanHash, executeHubImport, exportKnowledgeProject, importKnowledgeProject, type HubImportMapping, type HubImportPlan } from "@/server/modules/knowledge";
import { SqliteStateStore } from "./sqlite-state-store";

const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
const NOW="2026-09-15T10:00:00.000Z";
function mapping(path:string,kind:HubImportMapping["sourceKind"],target:HubImportMapping["targetKind"],payload:Record<string,unknown>):HubImportMapping {
  return {sourcePath:path,sourceKind:kind,targetKind:target,legacyId:String(payload.id??path),disposition:"mapped",sourceSha256:"a".repeat(64),size:10,mappedFields:Object.keys(payload),sourceOnlyFields:[],originalPayload:payload};
}
function plan(mappings:HubImportMapping[]):HubImportPlan{const value:HubImportPlan={formatVersion:1,mappingVersion:2,planId:"",planHash:"",source:{sourceId:"fixture",repository:"/source",commit:"d".repeat(40),backlogPath:"docs/backlog"},validator:{repository:"/validator",commit:"e".repeat(40),command:["validate"],valid:true,diagnostics:[]},counts:{files:mappings.length,bytes:20,tasks:1,embeddedNotes:0,done:0,notes:1,attachments:0,documents:0,configurations:0,schemas:0,derived:0,unclassified:0,mapped:mappings.length,sourceOnly:0,skipped:0,missing:0,conflicts:0,unresolvedRelations:0},mappings,missing:[],conflicts:[],unresolvedRelations:[],guarantees:{dataWritten:false,sourceReadFromCommit:true,importedRepositoryScriptsExecuted:false}};value.planHash=calculateHubImportPlanHash(value);value.planId=`hub:fixture:${"d".repeat(40)}:${value.planHash.slice(0,16)}`;return value;}
function atCommit(value:HubImportPlan,commit:string):HubImportPlan{const result={...value,source:{...value.source,commit},planId:"",planHash:""};result.planHash=calculateHubImportPlanHash(result);result.planId=`hub:fixture:${commit}:${result.planHash.slice(0,16)}`;return result;}
function fixture(){const root=mkdtempSync(join(tmpdir(),"hub-import-execution-"));roots.push(root);let n=0;const ids=["00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002"];const store=new SqliteStateStore(join(root,"state.sqlite3")),identity=new IdentityService(store,()=>NOW,()=>ids[n++]!,()=>"a".repeat(64)),owner=identity.authenticateBearer(identity.bootstrapOwnerSession().token);return {root,store,identity,owner};}
const execute=(store:SqliteStateStore,identity:IdentityService,owner:ReturnType<IdentityService["authenticateBearer"]>,input:Parameters<typeof executeHubImport>[3])=>executeHubImport(store,identity,owner,input,()=>NOW,plan=>plan);

describe("K6b Hub import execution",()=>{
  it("preserves archived aliases, ordered completion summaries, follow-ups, and historical comment attribution",()=>{
    const f=fixture();
    const historical=mapping("docs/backlog/feature/A.json#notes/0","task_note","historical_comment",{id:"A:note:0",text:"Historical context",author:"Ada",date:"2026-09-13"});historical.legacyId="A:note:0";
    const source=plan([
      mapping("docs/backlog/feature/A.json","task","task",{id:"A",title:"Active",problem:["Problem"],links:{related_ids:["DONE-B"]}}),
      historical,
      mapping("docs/backlog/done/B.json","done","task_completion",{id:"DONE-B",item_id:"B",title:"Completed",summary:["First","middle phrase","Last"],followup_ids:["C"]}),
      mapping("docs/backlog/feature/C.json","task","task",{id:"C",title:"Follow-up"}),
    ]);
    execute(f.store,f.identity,f.owner,{plan:source,targetProjectId:"fidelity",targetProjectName:"Fidelity"});
    const tasks=f.store.listTasks("fidelity",25,0).items,active=tasks.find(task=>task.title==="Active")!,completed=tasks.find(task=>task.title==="Completed")!,followup=tasks.find(task=>task.title==="Follow-up")!;
    expect(completed.description).toBe("- First\n- middle phrase\n- Last");
    expect(f.store.searchKnowledge("fidelity",25,0,{query:"middle phrase"}).items).toEqual(expect.arrayContaining([expect.objectContaining({id:completed.id,kind:"task"})]));
    expect(f.store.listRelations("fidelity","task",active.id,25,0).items).toEqual(expect.arrayContaining([expect.objectContaining({type:"relates_to",sourceId:active.id,targetId:completed.id})]));
    expect(f.store.listRelations("fidelity","task",followup.id,25,0).items).toEqual(expect.arrayContaining([expect.objectContaining({type:"derived_from",sourceId:followup.id,targetId:completed.id})]));
    const thread=f.store.listThreads("fidelity",25,0).items[0]!,reply=f.store.listReplies("fidelity",thread.id,25,0).items[0]!;
    expect(reply.historicalImport).toEqual({sourceAuthor:"Ada",sourceDate:"2026-09-13",sourceDateStatus:"valid"});
    expect(f.store.getReply("foreign-project",reply.id)).toBeNull();
    const snapshot=f.store.exportKnowledgeProject("fidelity")!;expect(snapshot.importSources.every(row=>row.mapping_version===2)).toBe(true);
    f.store.close();
  });

  it("reports invalid or missing historical dates without inventing an import time",()=>{
    const f=fixture(),task=mapping("docs/backlog/feature/A.json","task","task",{id:"A",title:"Active"}),invalid=mapping("docs/backlog/feature/A.json#notes/0","task_note","historical_comment",{id:"A:note:0",text:"Invalid date",author:"Ada",date:"2026-02-31"}),missing=mapping("docs/backlog/feature/A.json#notes/1","task_note","historical_comment",{id:"A:note:1",text:"Missing date"});invalid.legacyId="A:note:0";missing.legacyId="A:note:1";
    execute(f.store,f.identity,f.owner,{plan:plan([task,invalid,missing]),targetProjectId:"dates",targetProjectName:"Dates"});
    const thread=f.store.listThreads("dates",25,0).items[0]!,replies=f.store.listReplies("dates",thread.id,25,0).items;
    expect(replies.map(reply=>reply.historicalImport)).toEqual(expect.arrayContaining([
      {sourceAuthor:"Ada",sourceDate:"2026-02-31",sourceDateStatus:"invalid"},
      {sourceAuthor:null,sourceDate:null,sourceDateStatus:"missing"},
    ]));f.store.close();
  });

  it("keeps chunks invisible, resumes from its durable cursor, and publishes once",()=>{
    const f=fixture(),source=plan([
      mapping("docs/backlog/feature/one.json","task","task",{id:"FEAT-one",title:"One",problem:["Do it"],status:"in-progress",priority:"now"}),
      mapping("docs/backlog/notes/NOTE-one/note.json","note","memory",{id:"NOTE-one",title:"Decision",body:{answer:42},tags:["import"]}),
    ]),input={plan:source,targetProjectId:"imported",targetProjectName:"Imported",chunkSize:1};
    const first=execute(f.store,f.identity,f.owner,input);
    expect(first).toMatchObject({status:"staging",cursor:1,totalItems:2,authenticationMethod:"owner_session"});
    expect(f.store.getKnowledgeProject("imported")).toBeNull();
    const published=execute(f.store,f.identity,f.owner,input);
    expect(published).toMatchObject({status:"published",cursor:2,authenticationMethod:"owner_session"});
    expect(f.store.listTasks("imported",25,0).items).toMatchObject([{title:"One",status:"in_progress",priority:"now"}]);
    expect(f.store.listMemories("imported",25,0,"",true).items).toMatchObject([{title:"Decision",status:"active",legacyId:"NOTE-one",approval:null}]);
    expect(execute(f.store,f.identity,f.owner,input)).toEqual(published);
    expect(f.store.listTasks("imported",25,0).items).toHaveLength(1); f.store.close();
  });

  it("keeps the creation method across a reopen, different authorized method, no-op and failed reset",()=>{
    const root=mkdtempSync(join(tmpdir(),"hub-import-method-"));roots.push(root);
    const path=join(root,"state.sqlite3");let store=new SqliteStateStore(path);
    let auth=new AuthenticationService(store),identity=new IdentityService(store,()=>NOW,undefined,undefined,auth);
    const token=auth.generateToken("test").token,tokenActor=auth.authenticateInstallation(token)!;
    const source=plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"One"}),mapping("docs/backlog/feature/two.json","task","task",{id:"two",title:"Two"})]);
    const input={plan:source,targetProjectId:"method",targetProjectName:"Method",chunkSize:1,batchId:"method-batch"};
    expect(execute(store,identity,tokenActor,input)).toMatchObject({status:"staging",authenticationMethod:"installation_token"});
    store.close();store=new SqliteStateStore(path);auth=new AuthenticationService(store);identity=new IdentityService(store,()=>NOW,undefined,undefined,auth);
    auth.setMode("open","test");const openActor=auth.anonymousInstallation()!;
    const published=execute(store,identity,openActor,input);
    expect(published).toMatchObject({status:"published",authenticationMethod:"installation_token",actorPrincipalId:"installation"});
    expect(execute(store,identity,openActor,input)).toEqual(published);

    const orphan=mapping("docs/backlog/feature/missing.json#notes/0","task_note","historical_comment",{id:"missing:note:0",text:"Orphan"});
    const failedInput={plan:plan([orphan]),targetProjectId:"failed-method",targetProjectName:"Failed method",batchId:"failed-method-batch"};
    expect(()=>execute(store,identity,openActor,failedInput)).toThrow();
    expect(store.getHubImport(failedInput.batchId)).toMatchObject({status:"failed",authenticationMethod:"none"});
    auth.setMode("token","test");
    expect(()=>execute(store,identity,auth.authenticateInstallation(token)!,failedInput)).toThrow();
    expect(store.getHubImport(failedInput.batchId)).toMatchObject({status:"failed",authenticationMethod:"none"});
    store.close();
  });

  it("marks populated pre-migration batches unknown and preserves that on resume and no-op",()=>{
    const f=fixture(),path=join(f.root,"state.sqlite3");
    const publishedInput={plan:plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"One"})]),targetProjectId:"old-published",targetProjectName:"Old published",batchId:"old-published-batch"};
    const stagedInput={plan:plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"One"}),mapping("docs/backlog/feature/two.json","task","task",{id:"two",title:"Two"})]),targetProjectId:"old-staged",targetProjectName:"Old staged",batchId:"old-staged-batch",chunkSize:1};
    expect(execute(f.store,f.identity,f.owner,publishedInput).status).toBe("published");
    expect(execute(f.store,f.identity,f.owner,stagedInput).status).toBe("staging");
    f.store.close();
    const old=new Database(path);
    old.exec("ALTER TABLE knowledge_import_batches DROP COLUMN authentication_method; DELETE FROM schema_migrations WHERE version = 26");
    expect((old.prepare("SELECT count(*) AS count FROM knowledge_import_batches").get() as {count:number}).count).toBe(2);
    old.close();
    const store=new SqliteStateStore(path),identity=new IdentityService(store,()=>NOW);
    expect(store.schemaVersion()).toBe(26);
    expect(store.getHubImport(publishedInput.batchId)).toMatchObject({status:"published",authenticationMethod:"legacy_unknown"});
    expect(store.getHubImport(stagedInput.batchId)).toMatchObject({status:"staging",cursor:1,authenticationMethod:"legacy_unknown"});
    expect(execute(store,identity,f.owner,publishedInput).authenticationMethod).toBe("legacy_unknown");
    expect(execute(store,identity,f.owner,stagedInput)).toMatchObject({status:"published",authenticationMethod:"legacy_unknown"});
    store.close();
  });

  it("rolls the entire publication back if a staged mapping cannot be linked",()=>{
    const f=fixture(),item=mapping("docs/backlog/feature/missing.json#notes/0","task_note","historical_comment",{id:"missing:note:0",text:"Orphan"});item.legacyId="missing:note:0";const source=plan([item]),input={plan:source,targetProjectId:"failed-import",targetProjectName:"Failed"};
    expect(()=>execute(f.store,f.identity,f.owner,input)).toThrow();
    expect(f.store.getKnowledgeProject("failed-import")).toBeNull();
    expect(f.store.getHubImport("hub-import:"+"irrelevant")).toBeNull(); f.store.close();
  });

  it("rejects a changed plan when resuming an existing batch",()=>{
    const f=fixture(),original=plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"One"}),mapping("docs/backlog/feature/two.json","task","task",{id:"two",title:"Two"})]);
    const input={plan:original,targetProjectId:"target",targetProjectName:"Target",chunkSize:1,batchId:"batch"}; execute(f.store,f.identity,f.owner,input);
    const changed={...original,planHash:"f".repeat(64)};
    expect(()=>execute(f.store,f.identity,f.owner,{...input,plan:changed})).toThrowError(expect.objectContaining({code:"revision_conflict"})); f.store.close();
  });

  it("rejects a changed target when resuming instead of publishing the stored target",()=>{
    const f=fixture(),source=plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"One"}),mapping("docs/backlog/feature/two.json","task","task",{id:"two",title:"Two"})]);
    execute(f.store,f.identity,f.owner,{plan:source,targetProjectId:"A",targetProjectName:"A",batchId:"same",chunkSize:1});
    expect(()=>execute(f.store,f.identity,f.owner,{plan:source,targetProjectId:"B",targetProjectName:"B",batchId:"same",chunkSize:1})).toThrowError(expect.objectContaining({code:"revision_conflict"}));
    expect(f.store.getKnowledgeProject("A")).toBeNull(); expect(f.store.getKnowledgeProject("B")).toBeNull(); f.store.close();
  });

  it("revalidates the exact source instead of trusting a self-consistent report",()=>{
    const f=fixture(),source=plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"One"})]);
    expect(()=>executeHubImport(f.store,f.identity,f.owner,{plan:source,targetProjectId:"target",targetProjectName:"Target"},()=>NOW)).toThrowError(expect.objectContaining({code:"invalid_request"}));
    expect(f.store.getKnowledgeProject("target")).toBeNull(); f.store.close();
  });

  it("requires a fresh v2 plan instead of treating an old published mapping as fixed",()=>{
    const f=fixture(),current=plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"One"})]),legacy={...current,mappingVersion:1} as unknown as HubImportPlan;legacy.planHash=calculateHubImportPlanHash(legacy);legacy.planId=`hub:fixture:${legacy.source.commit}:${legacy.planHash.slice(0,16)}`;
    expect(()=>execute(f.store,f.identity,f.owner,{plan:legacy,targetProjectId:"legacy",targetProjectName:"Legacy"})).toThrowError(expect.objectContaining({code:"invalid_request"}));expect(f.store.getKnowledgeProject("legacy")).toBeNull();f.store.close();
  });

  it("round-trips imported memories and their original provenance",()=>{
    const source=fixture(),comment=mapping("docs/backlog/feature/one.json#notes/0","task_note","historical_comment",{id:"one:note:0",text:"History",author:"Ada",date:"2026-09-13"});comment.legacyId="one:note:0";const report=plan([mapping("docs/backlog/notes/NOTE-one/note.json","note","memory",{id:"NOTE-one",title:"Decision",body:"Keep source",status:"archived",custom:{answer:42}}),mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"One"}),comment]);
    execute(source.store,source.identity,source.owner,{plan:report,targetProjectId:"portable",targetProjectName:"Portable"});
    const before=source.store.exportKnowledgeProject("portable")!,directory=join(source.root,"export");
    exportKnowledgeProject(source.store,source.identity,"portable",directory,join(source.root,"attachments"),source.owner,{applicationVersion:"test",clock:()=>NOW}); source.store.close();
    const target=fixture(); importKnowledgeProject(target.store,target.identity,directory,join(target.root,"attachments"),target.owner);
    expect(target.store.exportKnowledgeProject("portable")?.importSources).toEqual(before.importSources);
    expect(target.store.listMemories("portable",25,0,"",true).items[0]).toMatchObject({status:"archived",sources:[{kind:"repository",sourceId:"fixture",repository:"/source",commit:"d".repeat(40),path:"docs/backlog/notes/NOTE-one/note.json"}]});
    const thread=target.store.listThreads("portable",25,0).items[0]!;expect(target.store.listReplies("portable",thread.id,25,0).items[0]?.historicalImport).toEqual({sourceAuthor:"Ada",sourceDate:"2026-09-13",sourceDateStatus:"valid"}); target.store.close();
  });

  it.each([["attachment","attachment"]] as const)("blocks unsupported %s mappings",(sourceKind,targetKind)=>{
    const f=fixture(),source=plan([mapping(`docs/backlog/${sourceKind}.json`,sourceKind,targetKind,{id:sourceKind,title:sourceKind})]);
    expect(()=>execute(f.store,f.identity,f.owner,{plan:source,targetProjectId:"target",targetProjectName:"Target"})).toThrowError(expect.objectContaining({code:"invalid_request"}));
    expect(f.store.getKnowledgeProject("target")).toBeNull(); f.store.close();
  });

  it("publishes historical comments, completions, and resolved task relations",()=>{
    const f=fixture(),first=mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"One",links:{related_ids:["two"]}}),second=mapping("docs/backlog/feature/two.json","task","task",{id:"two",title:"Two"});
    const comment=mapping("docs/backlog/feature/one.json#notes/0","task_note","historical_comment",{id:"one:note:0",text:"Historical context",author:"human:reviewer"});comment.legacyId="one:note:0";
    const done=mapping("docs/backlog/done/DONE-one.json","done","task_completion",{id:"DONE-one",item_id:"one",title:"One completed",summary:"Shipped"});
    const report=plan([done,first,comment,second]);execute(f.store,f.identity,f.owner,{plan:report,targetProjectId:"complete",targetProjectName:"Complete"});
    const tasks=f.store.listTasks("complete",25,0).items;expect(tasks.find(task=>task.title==="One")?.status).toBe("done");expect(tasks).toHaveLength(2);
    const thread=f.store.listThreads("complete",25,0).items[0]!;expect(f.store.listReplies("complete",thread.id,25,0).items[0]?.body).toBe("Historical context");
    expect(f.store.listRelations("complete","task",tasks.find(task=>task.title==="One")!.id,25,0).items.some(relation=>relation.type==="relates_to")).toBe(true);f.store.close();
  });

  it("reimports changed source into an existing project only at its expected revision",()=>{
    const f=fixture(),initial=plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"Before",problem:["Initial"]})]);
    execute(f.store,f.identity,f.owner,{plan:initial,targetProjectId:"incremental",targetProjectName:"Incremental"});
    const changed=atCommit(plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"After",problem:["Changed"]})]),"f".repeat(40));
    execute(f.store,f.identity,f.owner,{plan:changed,targetProjectId:"incremental",targetProjectName:"Incremental",expectedTargetRevision:1});
    expect(f.store.getKnowledgeProject("incremental")?.revision).toBe(2);expect(f.store.listTasks("incremental",25,0).items).toMatchObject([{title:"After",description:"Changed",revision:2}]);
    const stale=atCommit(changed,"a".repeat(40));expect(()=>execute(f.store,f.identity,f.owner,{plan:stale,targetProjectId:"incremental",targetProjectName:"Incremental",expectedTargetRevision:1})).toThrowError(expect.objectContaining({code:"revision_conflict"}));f.store.close();
  });

  it.each(["task","memory"] as const)("blocks reimport when an imported %s was changed locally",kind=>{
    const f=fixture(),item=kind==="task"
      ? mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"Before",problem:["Initial"]})
      : mapping("docs/backlog/notes/NOTE-one/note.json","note","memory",{id:"NOTE-one",title:"Before",body:"Initial"});
    execute(f.store,f.identity,f.owner,{plan:plan([item]),targetProjectId:"protected",targetProjectName:"Protected"});
    const context={actor:f.owner,projectId:"protected",idempotencyKey:`local-${kind}`,requestHash:"b".repeat(64)};
    if(kind==="task"){
      const task=f.store.listTasks("protected",25,0).items[0]!;
      f.store.updateTask({...task,description:"Local task change",revision:task.revision+1,updatedAt:NOW},task.revision,context);
    }else{
      const memory=f.store.listMemories("protected",25,0,"",true).items[0]!;
      f.store.saveMemory({...memory,body:"Local memory change",revision:memory.revision+1,updatedAt:NOW},memory.revision,"updated",context);
    }
    const changed=atCommit(plan([kind==="task"
      ? mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"From source",problem:["Changed"]})
      : mapping("docs/backlog/notes/NOTE-one/note.json","note","memory",{id:"NOTE-one",title:"From source",body:"Changed"})]),"f".repeat(40));
    expect(()=>execute(f.store,f.identity,f.owner,{plan:changed,targetProjectId:"protected",targetProjectName:"Protected",expectedTargetRevision:1})).toThrowError(expect.objectContaining({code:"revision_conflict"}));
    expect(f.store.getKnowledgeProject("protected")?.revision).toBe(1);
    if(kind==="task") expect(f.store.listTasks("protected",25,0).items[0]?.description).toBe("Local task change");
    else expect(f.store.listMemories("protected",25,0,"",true).items[0]?.body).toBe("Local memory change");
    f.store.close();
  });

  it("reimports an orphan completion and updates its stable task",()=>{
    const f=fixture(),first=plan([mapping("docs/backlog/done/DONE-one.json","done","task_completion",{id:"DONE-one",item_id:"missing",title:"Done",summary:"Before"})]);
    execute(f.store,f.identity,f.owner,{plan:first,targetProjectId:"done-only",targetProjectName:"Done only"});
    const changed=atCommit(plan([mapping("docs/backlog/done/DONE-one.json","done","task_completion",{id:"DONE-one",item_id:"missing",title:"Done",summary:"After"})]),"f".repeat(40));
    execute(f.store,f.identity,f.owner,{plan:changed,targetProjectId:"done-only",targetProjectName:"Done only",expectedTargetRevision:1});
    expect(f.store.listTasks("done-only",25,0).items).toMatchObject([{description:"After",status:"done",revision:2}]);f.store.close();
  });

  it("completes a task imported by an earlier batch without duplicating it",()=>{
    const f=fixture(),open=plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"One",problem:["Work"]})]);
    execute(f.store,f.identity,f.owner,{plan:open,targetProjectId:"lifecycle",targetProjectName:"Lifecycle"});
    const completed=atCommit(plan([mapping("docs/backlog/done/DONE-one.json","done","task_completion",{id:"DONE-one",item_id:"one",title:"One",summary:"Shipped"})]),"f".repeat(40));
    execute(f.store,f.identity,f.owner,{plan:completed,targetProjectId:"lifecycle",targetProjectName:"Lifecycle",expectedTargetRevision:1});
    expect(f.store.listTasks("lifecycle",25,0).items).toMatchObject([{title:"One",status:"done",revision:2}]);expect(f.store.listTasks("lifecycle",25,0).items).toHaveLength(1);f.store.close();
  });

  it("updates a v1-mapped completion to v2 and replaces its prior summary on later imports",()=>{
    const source=fixture(),open=mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"One",problem:["Work"]}),done=mapping("docs/backlog/done/DONE-one.json","done","task_completion",{id:"DONE-one",item_id:"one",title:"One",summary:"Before"});
    execute(source.store,source.identity,source.owner,{plan:plan([open,done]),targetProjectId:"legacy-copy",targetProjectName:"Legacy copy"});
    const snapshot=source.store.exportKnowledgeProject("legacy-copy")!;
    snapshot.importSources.forEach(row=>{row.mapping_version=1;});
    snapshot.tasks[0]!.description="Work";
    source.store.close();

    const target=fixture();target.store.importKnowledgeProject(snapshot);
    const updated=atCommit(plan([mapping("docs/backlog/done/DONE-one.json","done","task_completion",{id:"DONE-one",item_id:"one",title:"One",summary:"After"})]),"f".repeat(40));
    execute(target.store,target.identity,target.owner,{plan:updated,targetProjectId:"legacy-copy",targetProjectName:"Legacy copy",expectedTargetRevision:1});
    expect(target.store.exportKnowledgeProject("legacy-copy")!.importSources.find(row=>row.target_kind==="task_completion")?.mapping_version).toBe(2);
    expect(target.store.listTasks("legacy-copy",25,0).items[0]?.description).toBe("Work\n\nCompletion summary\nAfter");

    const corrected=atCommit(plan([mapping("docs/backlog/done/archive/DONE-one.json","done","task_completion",{id:"DONE-one",item_id:"one",title:"One",summary:"Corrected"})]),"b".repeat(40));
    execute(target.store,target.identity,target.owner,{plan:corrected,targetProjectId:"legacy-copy",targetProjectName:"Legacy copy",expectedTargetRevision:2});
    expect(target.store.listTasks("legacy-copy",25,0).items[0]?.description).toBe("Work\n\nCompletion summary\nCorrected");
    target.store.close();
  });

  it("removes an imported relation that disappeared from a later source commit",()=>{
    const f=fixture(),linked=plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"One",links:{related_ids:["two"]}}),mapping("docs/backlog/feature/two.json","task","task",{id:"two",title:"Two"})]);
    execute(f.store,f.identity,f.owner,{plan:linked,targetProjectId:"relations",targetProjectName:"Relations"});
    const one=f.store.listTasks("relations",25,0).items.find(task=>task.title==="One")!;expect(f.store.listRelations("relations","task",one.id,25,0).items).toHaveLength(1);
    const unlinked=atCommit(plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"One"}),mapping("docs/backlog/feature/two.json","task","task",{id:"two",title:"Two"})]),"f".repeat(40));
    execute(f.store,f.identity,f.owner,{plan:unlinked,targetProjectId:"relations",targetProjectName:"Relations",expectedTargetRevision:1});
    expect(f.store.listRelations("relations","task",one.id,25,0).items).toHaveLength(0);f.store.close();
  });

  it("imports the same Hub source into two projects",()=>{
    const f=fixture(),source=plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"One"})]);
    execute(f.store,f.identity,f.owner,{plan:source,targetProjectId:"first-target",targetProjectName:"First"});
    execute(f.store,f.identity,f.owner,{plan:source,targetProjectId:"second-target",targetProjectName:"Second"});
    expect(f.store.listTasks("first-target",25,0).items).toHaveLength(1);expect(f.store.listTasks("second-target",25,0).items).toHaveLength(1);f.store.close();
  });

  it("rejects target identities that cannot be logically restored",()=>{
    const f=fixture(),source=plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"One"})]);
    expect(()=>execute(f.store,f.identity,f.owner,{plan:source,targetProjectId:"x".repeat(161),targetProjectName:"Target"})).toThrowError(expect.objectContaining({code:"invalid_request"}));
    expect(()=>execute(f.store,f.identity,f.owner,{plan:source,targetProjectId:"target",targetProjectName:"x".repeat(121)})).toThrowError(expect.objectContaining({code:"invalid_request"}));
    const padded=` ${"x".repeat(160)} `;execute(f.store,f.identity,f.owner,{plan:source,targetProjectId:padded,targetProjectName:"Padded"});expect(f.store.getKnowledgeProject(padded)).toBeNull();expect(f.store.getKnowledgeProject(padded.trim())?.id).toBe(padded.trim());f.store.close();
  });

  it.each([
    ["task title",mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"x".repeat(201)})],
    ["memory body",mapping("docs/backlog/notes/NOTE-one/note.json","note","memory",{id:"NOTE-one",title:"Note",body:"x".repeat(65537)})],
  ])("rejects an oversized imported %s before publishing",(_label,item)=>{
    const f=fixture();
    expect(()=>execute(f.store,f.identity,f.owner,{plan:plan([item]),targetProjectId:"bounded",targetProjectName:"Bounded"})).toThrowError(expect.objectContaining({code:"limit_exceeded"}));
    expect(f.store.getKnowledgeProject("bounded")).toBeNull();f.store.close();
  });

  it("rejects source and legacy IDs that cannot be logically restored",()=>{
    const f=fixture(),longSource=plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"One"})]);longSource.source.sourceId="x".repeat(161);longSource.planHash=calculateHubImportPlanHash(longSource);longSource.planId=`hub:${longSource.source.sourceId}:${longSource.source.commit}:${longSource.planHash.slice(0,16)}`;
    expect(()=>execute(f.store,f.identity,f.owner,{plan:longSource,targetProjectId:"long-source",targetProjectName:"Long source"})).toThrowError(expect.objectContaining({code:"invalid_request"}));
    const longLegacy=plan([mapping("docs/backlog/notes/NOTE-one/note.json","note","memory",{id:"x".repeat(161),title:"Note",body:"Body"})]);
    expect(()=>execute(f.store,f.identity,f.owner,{plan:longLegacy,targetProjectId:"long-legacy",targetProjectName:"Long legacy"})).toThrowError(expect.objectContaining({code:"invalid_request"}));f.store.close();
  });

  it("verifies and installs attachment bytes for their imported note",()=>{
    const f=fixture(),bytes=Buffer.from("attachment proof"),hash=createHash("sha256").update(bytes).digest("hex"),note=mapping("docs/backlog/notes/NOTE-one/note.json","note","memory",{id:"NOTE-one",title:"Note",body:"Body"});
    const attachment:HubImportMapping={sourcePath:"docs/backlog/notes/NOTE-one/proof.txt",sourceKind:"attachment",targetKind:"attachment",legacyId:null,disposition:"mapped",sourceSha256:hash,size:bytes.byteLength,mappedFields:[],sourceOnlyFields:[]},report=plan([note,attachment]),directory=join(f.root,"attachments");
    executeHubImport(f.store,f.identity,f.owner,{plan:report,targetProjectId:"files",targetProjectName:"Files",attachmentDirectory:directory},()=>NOW,value=>value,()=>bytes);
    const memory=f.store.listMemories("files",25,0,"",true).items[0]!;expect(f.store.listAttachments("files","memory",memory.id,25,0).items).toMatchObject([{filename:"proof.txt",sha256:hash,size:bytes.byteLength}]);
    expect(readFileSync(join(directory,hash.slice(0,2),hash))).toEqual(bytes);f.store.close();
  });

  it("links nested attachments to the note directory and rejects symlink shards",()=>{
    const f=fixture(),bytes=Buffer.from("nested proof"),hash=createHash("sha256").update(bytes).digest("hex"),note=mapping("docs/backlog/notes/NOTE-one/note.json","note","memory",{id:"NOTE-one",title:"Note",body:"Body"});
    const attachment:HubImportMapping={sourcePath:"docs/backlog/notes/NOTE-one/assets/proof.txt",sourceKind:"attachment",targetKind:"attachment",legacyId:null,disposition:"mapped",sourceSha256:hash,size:bytes.byteLength,mappedFields:[],sourceOnlyFields:[]},report=plan([note,attachment]),directory=join(f.root,"nested-attachments");
    executeHubImport(f.store,f.identity,f.owner,{plan:report,targetProjectId:"nested",targetProjectName:"Nested",attachmentDirectory:directory},()=>NOW,value=>value,()=>bytes);
    expect(f.store.listAttachments("nested","memory",f.store.listMemories("nested",25,0,"",true).items[0]!.id,25,0).items).toHaveLength(1);f.store.close();
    const unsafe=fixture(),unsafeDirectory=join(unsafe.root,"unsafe-attachments"),outside=join(unsafe.root,"outside");mkdirSync(unsafeDirectory);mkdirSync(outside);symlinkSync(outside,join(unsafeDirectory,hash.slice(0,2)));
    expect(()=>executeHubImport(unsafe.store,unsafe.identity,unsafe.owner,{plan:report,targetProjectId:"unsafe",targetProjectName:"Unsafe",attachmentDirectory:unsafeDirectory,batchId:"unsafe-batch"},()=>NOW,value=>value,()=>bytes)).toThrowError(expect.objectContaining({code:"invalid_request"}));
    expect(existsSync(join(outside,hash))).toBe(false);expect(unsafe.store.getHubImport("unsafe-batch")).toMatchObject({status:"failed"});unsafe.store.close();
  });

  it("resets and resumes a failed publication after its external cause is removed",()=>{
    const f=fixture(),bytes=Buffer.from("retry proof"),hash=createHash("sha256").update(bytes).digest("hex"),note=mapping("docs/backlog/notes/NOTE-one/note.json","note","memory",{id:"NOTE-one",title:"Note",body:"Body"}),attachment:HubImportMapping={sourcePath:"docs/backlog/notes/NOTE-one/proof.txt",sourceKind:"attachment",targetKind:"attachment",legacyId:null,disposition:"mapped",sourceSha256:hash,size:bytes.byteLength,mappedFields:[],sourceOnlyFields:[]},report=plan([note,attachment]),directory=join(f.root,"retry-attachments"),outside=join(f.root,"retry-outside");mkdirSync(directory);mkdirSync(outside);symlinkSync(outside,join(directory,hash.slice(0,2)));
    const input={plan:report,targetProjectId:"retry",targetProjectName:"Retry",attachmentDirectory:directory,batchId:"retry-batch"};expect(()=>executeHubImport(f.store,f.identity,f.owner,input,()=>NOW,value=>value,()=>bytes)).toThrow();expect(f.store.getHubImport("retry-batch")).toMatchObject({status:"failed",cursor:2});
    rmSync(join(directory,hash.slice(0,2)));const published=executeHubImport(f.store,f.identity,f.owner,input,()=>NOW,value=>value,()=>bytes);expect(published).toMatchObject({status:"published",cursor:2,error:null});expect(existsSync(join(directory,hash.slice(0,2),hash))).toBe(true);f.store.close();
  });

  it("resets a failed batch with the newly accepted target revision",()=>{
    const f=fixture(),initial=plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"Before"})]);
    execute(f.store,f.identity,f.owner,{plan:initial,targetProjectId:"revision-retry",targetProjectName:"Revision retry"});
    const changed=atCommit(plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"After"}),mapping("docs/backlog/feature/two.json","task","task",{id:"two",title:"Two"})]),"f".repeat(40));
    const input={plan:changed,targetProjectId:"revision-retry",targetProjectName:"Revision retry",expectedTargetRevision:1,chunkSize:1,batchId:"revision-retry-batch"};
    expect(execute(f.store,f.identity,f.owner,input)).toMatchObject({status:"staging",cursor:1});
    let project=f.store.getKnowledgeProject("revision-retry")!;
    f.store.updateKnowledgeProject({...project,status:"archived",revision:2,updatedAt:NOW},1,{actor:f.owner,projectId:project.id,idempotencyKey:"archive-for-retry",requestHash:"c".repeat(64)});
    project=f.store.getKnowledgeProject("revision-retry")!;
    f.store.updateKnowledgeProject({...project,status:"active",revision:3,updatedAt:NOW},2,{actor:f.owner,projectId:project.id,idempotencyKey:"restore-for-retry",requestHash:"d".repeat(64)});
    expect(()=>execute(f.store,f.identity,f.owner,input)).toThrowError(expect.objectContaining({code:"revision_conflict"}));
    expect(f.store.getHubImport("revision-retry-batch")).toMatchObject({status:"failed",expectedTargetRevision:1});
    expect(()=>execute(f.store,f.identity,f.owner,{...input,expectedTargetRevision:2})).toThrowError(expect.objectContaining({code:"revision_conflict"}));
    expect(f.store.getHubImport("revision-retry-batch")).toMatchObject({status:"failed",expectedTargetRevision:1});
    const retry={...input,expectedTargetRevision:3,chunkSize:2};
    expect(execute(f.store,f.identity,f.owner,retry)).toMatchObject({status:"published",expectedTargetRevision:3});
    expect(f.store.getKnowledgeProject("revision-retry")?.revision).toBe(4);expect(f.store.listTasks("revision-retry",25,0).items).toHaveLength(2);f.store.close();
  });

  it("removes newly installed attachment objects when database publication rolls back",()=>{
    const f=fixture(),bytes=Buffer.from("rollback proof"),hash=createHash("sha256").update(bytes).digest("hex"),note=mapping("docs/backlog/notes/NOTE-one/note.json","note","memory",{id:"NOTE-one",title:"Note",body:"Body"});
    const attachment:HubImportMapping={sourcePath:"docs/backlog/notes/NOTE-one/proof.txt",sourceKind:"attachment",targetKind:"attachment",legacyId:null,disposition:"mapped",sourceSha256:hash,size:bytes.byteLength,mappedFields:[],sourceOnlyFields:[]},orphan=mapping("docs/backlog/feature/missing.json#notes/0","task_note","historical_comment",{id:"missing:note:0",text:"Orphan"});orphan.legacyId="missing:note:0";
    const report=plan([note,attachment,orphan]),directory=join(f.root,"attachments");expect(()=>executeHubImport(f.store,f.identity,f.owner,{plan:report,targetProjectId:"rollback-files",targetProjectName:"Rollback",attachmentDirectory:directory},()=>NOW,value=>value,()=>bytes)).toThrow();
    expect(f.store.getKnowledgeProject("rollback-files")).toBeNull();expect(existsSync(join(directory,hash.slice(0,2),hash))).toBe(false);f.store.close();
  });
});
