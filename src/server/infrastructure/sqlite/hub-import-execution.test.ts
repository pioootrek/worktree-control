import { stripMigrationProvenance } from "./fixtures/legacy-registry";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { afterEach, describe, expect, it } from "vitest";

import { IdentityService } from "@/server/modules/identity";
import { AuthenticationService } from "@/server/modules/authentication";
import { calculateHubImportPlanHash, executeHubImport, exportKnowledgeProject, importKnowledgeProject, KnowledgeService, type HubImportMapping, type HubImportPlan } from "@/server/modules/knowledge";
import { SqliteStateStore } from "./sqlite-state-store";
import { KnowledgeQueries, replyReadSql } from "./knowledge-queries";
import { importedRecordId, importedTaskTopic, verifiedThreadSourceSql } from "./knowledge-thread-presentation";

const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
const NOW="2026-09-15T10:00:00.000Z";
function mapping(path:string,kind:HubImportMapping["sourceKind"],target:HubImportMapping["targetKind"],payload:Record<string,unknown>):HubImportMapping {
  return {sourcePath:path,sourceKind:kind,targetKind:target,legacyId:String(payload.id??path),disposition:"mapped",sourceSha256:"a".repeat(64),size:10,mappedFields:Object.keys(payload),sourceOnlyFields:[],originalPayload:payload};
}
function plan(mappings:HubImportMapping[]):HubImportPlan{const value:HubImportPlan={formatVersion:1,mappingVersion:2,planId:"",planHash:"",source:{sourceId:"fixture",repository:"/source",commit:"d".repeat(40),backlogPath:"docs/backlog"},validator:{repository:"/validator",commit:"e".repeat(40),command:["validate"],valid:true,diagnostics:[]},counts:{files:mappings.length,bytes:20,tasks:1,embeddedNotes:0,done:0,notes:1,attachments:0,documents:0,configurations:0,schemas:0,derived:0,unclassified:0,mapped:mappings.length,sourceOnly:0,skipped:0,missing:0,conflicts:0,unresolvedRelations:0},mappings,missing:[],conflicts:[],unresolvedRelations:[],guarantees:{dataWritten:false,sourceReadFromCommit:true,importedRepositoryScriptsExecuted:false}};value.planHash=calculateHubImportPlanHash(value);value.planId=`hub:fixture:${"d".repeat(40)}:${value.planHash.slice(0,16)}`;return value;}
function atCommit(value:HubImportPlan,commit:string):HubImportPlan{const result={...value,source:{...value.source,commit},planId:"",planHash:""};result.planHash=calculateHubImportPlanHash(result);result.planId=`hub:fixture:${commit}:${result.planHash.slice(0,16)}`;return result;}
function fixture(){const root=mkdtempSync(join(tmpdir(),"hub-import-execution-"));roots.push(root);let n=0;const ids=["00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002","00000000-0000-4000-8000-000000000003"];const store=new SqliteStateStore(join(root,"state.sqlite3")),identity=new IdentityService(store,()=>NOW,()=>ids[n++]!,()=>"a".repeat(64)),owner=identity.authenticateBearer(identity.bootstrapOwnerSession().token);return {root,store,identity,owner};}
const execute=(store:SqliteStateStore,identity:IdentityService,owner:ReturnType<IdentityService["authenticateBearer"]>,input:Parameters<typeof executeHubImport>[3])=>executeHubImport(store,identity,owner,input,()=>NOW,plan=>plan);

describe("K6b Hub import execution",()=>{
  it("shares attachment admission with upload/export and rechecks accumulated usage at publication", () => {
    const f = fixture(), directory = join(f.root, "attachments"), bytes = Buffer.from("proof");
    const note = mapping("docs/backlog/notes/N/note.json", "note", "memory", { id: "N", title: "Proof", body: "Proof" });
    const attachment = mapping("docs/backlog/notes/N/proof.txt", "attachment", "attachment", {});
    attachment.size = bytes.byteLength; attachment.sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    const source = plan([note, attachment]), limits = { fileBytes: 5, projectBytes: 5, projectFiles: 1 };
    const run = (value: HubImportPlan, expectedTargetRevision?: number, policy = limits) => executeHubImport(f.store, f.identity, f.owner,
      { plan: value, targetProjectId: "quota", targetProjectName: "Quota", attachmentDirectory: directory, expectedTargetRevision, limits: policy }, () => NOW, value => value, () => bytes);
    expect(() => run(source, undefined, { fileBytes: 4, projectBytes: 4, projectFiles: 1 })).toThrowError(expect.objectContaining({ code: "limit_exceeded" }));
    expect(run(source).status).toBe("published"); expect(run(source).status).toBe("published");
    const secondAttachment = { ...attachment, sourcePath: "docs/backlog/notes/N/second.txt" }, second = atCommit(plan([note, attachment, secondAttachment]), "f".repeat(40));
    expect(() => run(second, 1)).toThrowError(expect.objectContaining({ details: expect.objectContaining({ violations: expect.arrayContaining([expect.objectContaining({ constraint: "projectBytes" }), expect.objectContaining({ constraint: "projectFiles" })]) }) }));
    // A source which fits by itself must also include attachments retained from older imports.
    const third = atCommit(plan([note, secondAttachment]), "b".repeat(40));
    expect(() => run(third, 1)).toThrowError(expect.objectContaining({ code: "limit_exceeded" }));
    expect(f.store.attachmentBytesForProject("quota")).toBe(5); expect(f.store.getKnowledgeProject("quota")?.revision).toBe(1);
    expect(run(atCommit(source, "c".repeat(40)), 1).status).toBe("published");
    expect(f.store.attachmentCountForProject("quota")).toBe(1); f.store.close();
  });
  it("upgrades schema 26 preserving the target provenance index",()=>{
    const f=fixture(),path=join(f.root,"state.sqlite3");f.store.close();
    const legacy=new Database(path);stripMigrationProvenance(legacy); legacy.exec("DROP INDEX knowledge_import_sources_target; DELETE FROM schema_migrations WHERE version >= 27");legacy.close();
    const reopened=new SqliteStateStore(path),db=new Database(path);
    expect(reopened.schemaVersion()).toBe(28);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='knowledge_import_sources_target'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM schema_migrations WHERE version=27").get()).toBeTruthy();
    db.close();reopened.close();
  });
  it("presents a verified historical topic without changing raw records, and searches it before paging",()=>{
    const f=fixture(),sourcePath="docs/backlog/feature/A.json";
    const task=mapping(sourcePath,"task","task",{id:"A",title:"ŁÓDŹ storage decision",problem:["Compare SQLite and PostgreSQL for the controller."]});
    const comment=mapping(`${sourcePath}#notes/0`,"task_note","historical_comment",{id:"A:note:0",text:"Use one SQLite owner."});comment.legacyId="A:note:0";
    execute(f.store,f.identity,f.owner,{plan:plan([task,comment]),targetProjectId:"topics",targetProjectName:"Topics"});
    const imported=f.store.listThreads("topics",25,0).items[0]!;
    expect(imported).toMatchObject({title:"Imported discussion: A",body:`Historical comments imported from ${sourcePath}`,
      presentation:{displayTitle:"ŁÓDŹ storage decision",preview:"Compare SQLite and PostgreSQL for the controller.",imported:true,replyCount:1}});
    expect(f.store.getThread("topics",imported.id)?.presentation).toEqual(imported.presentation);
    const original=f.store.exportKnowledgeProject("topics")!;
    expect(original.threads[0]).toMatchObject({title:"Imported discussion: A",body:`Historical comments imported from ${sourcePath}`});
    expect(original.threads[0]).not.toHaveProperty("presentation");
    const db=new Database(join(f.root,"state.sqlite3"));
    const queries=new KnowledgeQueries(db);
    let topicCalls=0, hashCalls=0;
    db.function("knowledge_import_topic",{deterministic:true},(value:unknown,legacyId:unknown,sourcePath:unknown)=>{
      topicCalls+=1;return importedTaskTopic(value,legacyId,sourcePath);
    });
    db.function("knowledge_import_record_id",{deterministic:true},(projectId:unknown,sourceId:unknown,sourcePath:unknown,kind:unknown)=>{
      hashCalls+=1;return importedRecordId(projectId,sourceId,sourcePath,kind);
    });
    expect(queries.searchKnowledge("topics",25,0,{kind:"thread",query:"storage"}).items.map(item=>item.id)).toContain(imported.id);
    expect(topicCalls).toBeGreaterThan(0);
    expect(hashCalls).toBeGreaterThan(0);
    topicCalls=0;hashCalls=0;
    topicCalls=0;hashCalls=0;
    expect(queries.searchKnowledge("topics",25,0,{kind:"task",query:"storage"}).items).toHaveLength(1);
    expect(topicCalls).toBe(0);
    expect(hashCalls).toBe(0);
    expect(queries.searchKnowledge("topics",25,0,{kind:"memory",query:"storage"}).items).toHaveLength(0);
    expect(topicCalls).toBe(0);
    expect(hashCalls).toBe(0);
    const queryPlan=db.prepare(`EXPLAIN QUERY PLAN WITH verified AS (${verifiedThreadSourceSql(true)}) SELECT * FROM verified`)
      .all({projectId:"topics",id:imported.id}) as Array<{detail:string}>;
    expect(queryPlan.some(step=>step.detail.includes("sqlite_autoindex_knowledge_threads_1") && step.detail.includes("id=?"))).toBe(true);
    expect(queryPlan.some(step=>step.detail.includes("knowledge_import_sources_project") && step.detail.includes("source_path=?"))).toBe(true);
    expect(queryPlan.some(step=>step.detail.includes("knowledge_import_sources_project") && step.detail.includes("source_path>?") && step.detail.includes("source_path<?"))).toBe(true);
    const native={id:"native-lookalike",projectId:"topics",title:"Imported discussion: A",body:`Historical comments imported from ${sourcePath}`,
      revision:1,createdBy:"installation",createdAt:NOW,updatedAt:NOW};
    f.store.createThread(native,{actor:f.owner,projectId:"topics",idempotencyKey:"native",requestHash:"a".repeat(64)});
    expect(f.store.getThread("topics",native.id)?.presentation).toMatchObject({displayTitle:native.title,preview:native.body,imported:false,replyCount:0});
    for(let index=0;index<30;index++) db.prepare("INSERT INTO knowledge_threads VALUES (?,?,?,?,1,?,?,?)")
      .run(`extra-${index}`,"topics",`Other ${index}`,"Body","installation",NOW,"2026-09-16T10:00:00.000Z");
    expect(f.store.listThreads("topics",25,0).items.map(thread=>thread.id)).not.toContain(imported.id);
    const matching=(query:string)=>f.store.listThreads("topics",1,0,{query}).items.map(thread=>thread.id);
    expect(matching("ło\u0301dz\u0301 STORAGE")).toEqual([imported.id]);
    expect(matching(imported.id)).toEqual([imported.id]);
    expect(f.store.listThreads("topics",25,0,{query:"Imported discussion: A"}).items.map(thread=>thread.id)).toContain(imported.id);
    expect(matching("%_missing")).toEqual([]);
    expect(f.store.listThreads("topics",25,0,{query:"controller"}).items).toEqual([]);
    const searchThread=f.store.searchKnowledge("topics",1,0,{kind:"thread",query:"ło\u0301dz\u0301 STORAGE"});
    expect(searchThread.items[0]).toMatchObject({id:imported.id,title:"ŁÓDŹ storage decision",matchSource:"title"});
    const searchReply=f.store.searchKnowledge("topics",25,0,{kind:"reply",query:"łódź storage"});
    expect(searchReply.items[0]).toMatchObject({kind:"reply",title:"ŁÓDŹ storage decision",threadId:imported.id,matchSource:"title"});
    db.prepare("INSERT INTO knowledge_replies VALUES (?,?,?,?,1,?,?,?)").run("late-hit","topics",imported.id,`${"Start ".repeat(110)}A [literal] %_ near the end`,"installation",NOW,NOW);
    const lateHit=f.store.searchKnowledge("topics",25,0,{kind:"reply",query:"[literal] %_"}).items[0]!;
    expect(lateHit.excerpt).toContain("[literal] %_");expect(lateHit.excerpt.startsWith("…")).toBe(true);
    for(let index=1;index<=26;index++) db.prepare("INSERT INTO knowledge_replies VALUES (?,?,?,?,1,?,?,?)")
      .run(`native-reply-${index}`,"topics",imported.id,`Reply ${index}`,"installation",NOW,NOW);
    expect(f.store.getThread("topics",imported.id)?.presentation?.replyCount).toBe(28);
    expect(f.store.listReplies("topics",imported.id,25,0).items).toHaveLength(25);
    expect(f.store.getThread("other-project",imported.id)).toBeNull();
    expect(f.store.listThreads("other-project",25,0,{query:"storage"}).items).toEqual([]);
    db.close();f.store.close();
  });

  it("falls back when historical topic evidence is missing, stale, conflicting or edited",()=>{
    const f=fixture(),sourcePath="docs/backlog/feature/A.json";
    const task=mapping(sourcePath,"task","task",{id:"A",title:"Original decision",problem:["Compare storage choices."]});
    const comment=mapping(`${sourcePath}#notes/0`,"task_note","historical_comment",{id:"A:note:0",text:"Historical context"});comment.legacyId="A:note:0";
    execute(f.store,f.identity,f.owner,{plan:plan([task,comment]),targetProjectId:"fallback",targetProjectName:"Fallback"});
    const thread=f.store.listThreads("fallback",25,0).items[0]!;
    const db=new Database(join(f.root,"state.sqlite3"));
    const expectRaw=()=>{const actual=f.store.getThread("fallback",thread.id)!;expect(actual.presentation).toMatchObject({displayTitle:actual.title,imported:false});};
    const source=db.prepare("SELECT id FROM knowledge_import_sources WHERE project_id='fallback' AND target_kind='task'").get() as {id:string};
    db.prepare("UPDATE knowledge_import_sources SET target_revision=NULL WHERE id=?").run(source.id);expectRaw();
    db.prepare("UPDATE knowledge_import_sources SET target_revision=1 WHERE id=?").run(source.id);
    db.prepare("UPDATE knowledge_import_sources SET original_payload_json='{' WHERE id=?").run(source.id);expectRaw();
    db.prepare("UPDATE knowledge_import_sources SET original_payload_json=? WHERE id=?").run(JSON.stringify(task.originalPayload),source.id);
    db.prepare("UPDATE knowledge_tasks SET revision=2,status='in_progress',description='Work has started' WHERE project_id='fallback'").run();
    expect(f.store.getThread("fallback",thread.id)?.presentation).toMatchObject({displayTitle:"Original decision",imported:true});
    db.prepare("UPDATE knowledge_tasks SET title='Changed decision',revision=3 WHERE project_id='fallback'").run();expectRaw();
    db.prepare("UPDATE knowledge_tasks SET title='Original decision' WHERE project_id='fallback'").run();
    db.prepare("UPDATE knowledge_import_sources SET source_commit=? WHERE project_id='fallback' AND target_kind='historical_comment'").run("e".repeat(40));expectRaw();
    db.prepare("UPDATE knowledge_import_sources SET source_commit=? WHERE project_id='fallback' AND target_kind='historical_comment'").run("d".repeat(40));
    db.prepare("UPDATE knowledge_import_sources SET source_path=? WHERE project_id='fallback' AND target_kind='historical_comment'").run(`${sourcePath}#notes/1`);expectRaw();
    db.prepare("UPDATE knowledge_import_sources SET source_path=? WHERE project_id='fallback' AND target_kind='historical_comment'").run(`${sourcePath}#notes/0`);
    db.prepare("UPDATE knowledge_relations SET type='relates_to' WHERE project_id='fallback'").run();expectRaw();
    db.prepare("UPDATE knowledge_relations SET type='derived_from' WHERE project_id='fallback'").run();
    db.prepare("UPDATE knowledge_threads SET title='Edited discussion' WHERE id=?").run(thread.id);expectRaw();
    db.prepare("UPDATE knowledge_threads SET title=? ,body='Edited body' WHERE id=?").run(thread.title,thread.id);expectRaw();
    db.close();f.store.close();
  });

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
    expect(reply.historicalImport).toEqual({sourceAttribution:"verified",sourceAuthor:"Ada",sourceDate:"2026-09-13",sourceDateStatus:"valid",sourceOrder:"verified"});
    expect(f.store.getReply("foreign-project",reply.id)).toBeNull();
    const snapshot=f.store.exportKnowledgeProject("fidelity")!;expect(snapshot.importSources.every(row=>row.mapping_version===2)).toBe(true);
    f.store.close();
  });

  it("reports invalid or missing historical dates without inventing an import time",()=>{
    const f=fixture(),task=mapping("docs/backlog/feature/A.json","task","task",{id:"A",title:"Active"}),invalid=mapping("docs/backlog/feature/A.json#notes/0","task_note","historical_comment",{id:"A:note:0",text:"Invalid date",author:"Ada",date:"2026-02-31"}),missing=mapping("docs/backlog/feature/A.json#notes/1","task_note","historical_comment",{id:"A:note:1",text:"Missing date"});invalid.legacyId="A:note:0";missing.legacyId="A:note:1";
    execute(f.store,f.identity,f.owner,{plan:plan([task,invalid,missing]),targetProjectId:"dates",targetProjectName:"Dates"});
    const thread=f.store.listThreads("dates",25,0).items[0]!,replies=f.store.listReplies("dates",thread.id,25,0).items;
    expect(replies.map(reply=>reply.historicalImport)).toEqual(expect.arrayContaining([
      {sourceAttribution:"verified",sourceAuthor:"Ada",sourceDate:"2026-02-31",sourceDateStatus:"invalid",sourceOrder:"verified"},
      {sourceAttribution:"verified",sourceAuthor:null,sourceDate:null,sourceDateStatus:"missing",sourceOrder:"verified"},
    ]));f.store.close();
  });

  it("orders imported replies by proven numeric note position before native continuation across SQL pages",()=>{
    const f=fixture(),path="docs/backlog/feature/A.json",task=mapping(path,"task","task",{id:"A",title:"Timeline"});
    const comments=Array.from({length:31},(_,index)=>{
      const date=index===2?"2026-02-31":index===10?undefined:index%2?"2026-09-05":"2026-09-27";
      const item=mapping(`${path}#notes/${index}`,"task_note","historical_comment",{id:`A:note:${index}`,text:`Source ${index}`,author:`Author ${index}`,...(date?{date}:{})});
      item.legacyId=`A:note:${index}`;return item;
    });
    const report=plan([task,...comments.reverse()]);
    execute(f.store,f.identity,f.owner,{plan:report,targetProjectId:"timeline",targetProjectName:"Timeline"});
    const thread=f.store.listThreads("timeline",25,0).items[0]!;
    const native={id:"native-continuation",projectId:"timeline",threadId:thread.id,body:"New answer",revision:1,createdBy:f.owner.principalId,createdAt:"2020-01-01T00:00:00.000Z",updatedAt:"2020-01-01T00:00:00.000Z"};
    f.store.createReply(native,{actor:f.owner,projectId:"timeline",idempotencyKey:"native",requestHash:"a".repeat(64)});
    const before=f.store.exportKnowledgeProject("timeline")!;
    const first=f.store.listReplies("timeline",thread.id,25,0),second=f.store.listReplies("timeline",thread.id,25,first.nextOffset!);
    expect(first.nextOffset).toBe(25);expect(second.nextOffset).toBeNull();
    expect([...first.items,...second.items].map(reply=>reply.body)).toEqual([...Array.from({length:31},(_,index)=>`Source ${index}`),"New answer"]);
    const targeted=f.store.listReplies("timeline",thread.id,25,0,second.items[4]!.id);
    expect(targeted).toMatchObject({offset:25,targetFound:true});
    expect(targeted.items[4]?.body).toBe("Source 29");
    expect(f.store.listReplies("timeline",thread.id,25,0,native.id)).toMatchObject({offset:25,targetFound:true});
    expect(f.store.listReplies("timeline",thread.id,25,0,"missing")).toMatchObject({offset:0,targetFound:false});
    expect(first.items[2]?.historicalImport).toMatchObject({sourceAttribution:"verified",sourceAuthor:"Author 2",sourceDate:"2026-02-31",sourceDateStatus:"invalid",sourceOrder:"verified"});
    expect(first.items[10]?.historicalImport).toMatchObject({sourceAttribution:"verified",sourceDate:null,sourceDateStatus:"missing",sourceOrder:"verified"});
    expect(second.items.at(-1)?.historicalImport).toBeUndefined();
    expect(f.store.getReply("timeline",first.items[10]!.id)?.historicalImport).toEqual(first.items[10]?.historicalImport);
    expect(f.store.exportKnowledgeProject("timeline")).toEqual(before);
    execute(f.store,f.identity,f.owner,{plan:atCommit(report,"f".repeat(40)),targetProjectId:"timeline",targetProjectName:"Timeline",expectedTargetRevision:f.store.getKnowledgeProject("timeline")!.revision});
    const afterRepeat=f.store.listReplies("timeline",thread.id,40,0).items;
    expect(afterRepeat.map(reply=>reply.body)).toEqual([...Array.from({length:31},(_,index)=>`Source ${index}`),"New answer"]);
    expect(afterRepeat[10]).toMatchObject({id:first.items[10]!.id,revision:2,createdAt:first.items[10]!.createdAt});
    const db=new Database(join(f.root,"state.sqlite3"));new KnowledgeQueries(db);
    const queryPlan=db.prepare(`EXPLAIN QUERY PLAN ${replyReadSql(false)}`).all({projectId:"timeline",threadId:thread.id,limit:26,offset:0}) as Array<{detail:string}>;
    expect(queryPlan.some(step=>step.detail.includes("knowledge_replies_thread"))).toBe(true);
    expect(queryPlan.some(step=>step.detail.includes("knowledge_import_sources_target"))).toBe(true);
    expect(queryPlan.some(step=>step.detail.includes("knowledge_import_sources_project"))).toBe(true);
    const targetPlan=db.prepare(`EXPLAIN QUERY PLAN ${replyReadSql(false,true)}`).all({projectId:"timeline",threadId:thread.id,targetReplyId:second.items[4]!.id}) as Array<{detail:string}>;
    expect(targetPlan.some(step=>step.detail.includes("knowledge_replies_thread"))).toBe(true);
    db.prepare("UPDATE knowledge_tasks SET title='Edited topic' WHERE project_id='timeline'").run();
    db.prepare("UPDATE knowledge_threads SET title='Edited discussion',body='Edited context' WHERE id=?").run(thread.id);
    expect(f.store.listReplies("timeline",thread.id,40,0).items.map(reply=>reply.body)).toEqual([...Array.from({length:31},(_,index)=>`Source ${index}`),"New answer"]);
    db.close();f.store.close();
  });

  it("falls back stably for ambiguous or broken provenance while preserving old ordinal evidence",()=>{
    const f=fixture(),path="docs/backlog/feature/A.json",task=mapping(path,"task","task",{id:"A",title:"Timeline"});
    const comments=[0,1,2,3].map(index=>{const item=mapping(`${path}#notes/${index}`,"task_note","historical_comment",{id:`A:note:${index}`,text:index===0?"\u00a0Source 0\u00a0":`Source ${index}`,author:`Author ${index}`});item.legacyId=`A:note:${index}`;return item;});
    execute(f.store,f.identity,f.owner,{plan:plan([task,...comments]),targetProjectId:"uncertain",targetProjectName:"Uncertain"});
    const thread=f.store.listThreads("uncertain",25,0).items[0]!,original=f.store.listReplies("uncertain",thread.id,25,0).items;
    const db=new Database(join(f.root,"state.sqlite3"));
    db.prepare("UPDATE knowledge_import_sources SET mapping_version=1,target_revision=NULL WHERE project_id='uncertain' AND target_kind='historical_comment' AND target_id=?").run(original[0]!.id);
    db.prepare("UPDATE knowledge_import_sources SET source_path='wrong#notes/1' WHERE project_id='uncertain' AND target_kind='historical_comment' AND target_id=?").run(original[1]!.id);
    db.prepare("UPDATE knowledge_import_sources SET original_payload_json='{broken' WHERE project_id='uncertain' AND target_kind='historical_comment' AND target_id=?").run(original[2]!.id);
    db.prepare("INSERT INTO knowledge_projects(id,name,status,revision,created_at,updated_at) VALUES ('other-project','Other','active',1,?,?)").run(NOW,NOW);
    db.prepare(`INSERT INTO knowledge_import_sources(id,project_id,source_id,source_repository,source_commit,source_path,legacy_id,source_sha256,mapping_version,target_kind,target_id,original_payload_json,created_at,target_revision)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("foreign-provenance","other-project","other","/source","d".repeat(40),"foreign/path#notes/0","other:note:0","a".repeat(64),2,"historical_comment",original[0]!.id,"{}",NOW,1);
    db.prepare(`INSERT INTO knowledge_import_sources(id,project_id,source_id,source_repository,source_commit,source_path,legacy_id,source_sha256,mapping_version,target_kind,target_id,original_payload_json,created_at,target_revision)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("extra-provenance","uncertain","other","/source","d".repeat(40),"unrelated/path#notes/3","other:note:3","a".repeat(64),2,"historical_comment",original[3]!.id,"{}",NOW,1);
    const rows=f.store.listReplies("uncertain",thread.id,25,0).items;
    expect(rows).toHaveLength(4);expect(new Set(rows.map(row=>row.id)).size).toBe(4);
    expect(rows.find(row=>row.id===original[0]!.id)?.historicalImport).toMatchObject({sourceAttribution:"verified",sourceOrder:"verified",sourceAuthor:"Author 0"});
    expect(rows.find(row=>row.id===original[1]!.id)?.historicalImport).toMatchObject({sourceAttribution:"unverified",sourceOrder:"unverified",sourceAuthor:null,sourceDateStatus:"unverified"});
    expect(rows.find(row=>row.id===original[2]!.id)?.historicalImport).toMatchObject({sourceAttribution:"unverified",sourceOrder:"verified",sourceDateStatus:"unverified",sourceAuthor:null});
    expect(rows.find(row=>row.id===original[3]!.id)?.historicalImport).toMatchObject({sourceAttribution:"unverified",sourceOrder:"unverified",sourceAuthor:null,sourceDateStatus:"unverified"});
    expect(f.store.getReply("uncertain",original[3]!.id)?.historicalImport?.sourceOrder).toBe("unverified");
    db.prepare("UPDATE knowledge_replies SET body='Edited after import',revision=revision+1 WHERE id=?").run(original[0]!.id);
    expect(f.store.getReply("uncertain",original[0]!.id)?.historicalImport).toMatchObject({sourceAttribution:"unverified",sourceOrder:"verified",sourceAuthor:null,sourceDateStatus:"unverified"});
    db.prepare("UPDATE knowledge_import_sources SET mapping_version=99 WHERE project_id='uncertain' AND target_kind='task'").run();
    expect(f.store.listReplies("uncertain",thread.id,25,0).items.every(row=>row.historicalImport?.sourceOrder==="unverified")).toBe(true);
    expect(f.store.getReply("other-project",original[0]!.id)).toBeNull();
    db.close();f.store.close();
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
    stripMigrationProvenance(old); old.exec("ALTER TABLE knowledge_import_batches DROP COLUMN authentication_method; DELETE FROM schema_migrations WHERE version >= 26");
    expect((old.prepare("SELECT count(*) AS count FROM knowledge_import_batches").get() as {count:number}).count).toBe(2);
    old.close();
    const store=new SqliteStateStore(path),identity=new IdentityService(store,()=>NOW);
    expect(store.schemaVersion()).toBe(28);
    expect(store.getHubImport(publishedInput.batchId)).toMatchObject({status:"published",authenticationMethod:"legacy_unknown"});
    expect(store.getHubImport(stagedInput.batchId)).toMatchObject({status:"staging",cursor:1,authenticationMethod:"legacy_unknown"});
    expect(execute(store,identity,f.owner,publishedInput).authenticationMethod).toBe("legacy_unknown");
    expect(execute(store,identity,f.owner,stagedInput)).toMatchObject({status:"published",authenticationMethod:"legacy_unknown"});
    store.close();
  });

  it("repairs a missing migration record without replacing stored batch methods",()=>{
    const f=fixture(),path=join(f.root,"state.sqlite3"),source=plan([mapping("docs/backlog/feature/one.json","task","task",{id:"one",title:"One"})]);
    const current=execute(f.store,f.identity,f.owner,{plan:source,targetProjectId:"current",targetProjectName:"Current",batchId:"current-batch"});
    execute(f.store,f.identity,f.owner,{plan:source,targetProjectId:"legacy",targetProjectName:"Legacy",batchId:"legacy-batch"});
    expect(current.authenticationMethod).toBe("owner_session");
    f.store.close();
    const damaged=new Database(path);
    stripMigrationProvenance(damaged); damaged.exec("UPDATE knowledge_import_batches SET authentication_method = 'legacy_unknown' WHERE id = 'legacy-batch'; DELETE FROM schema_migrations WHERE version >= 26");
    damaged.close();

    const repaired=new SqliteStateStore(path);
    expect(repaired.schemaVersion()).toBe(28);
    expect(repaired.getHubImport("current-batch")).toEqual(current);
    expect(repaired.getHubImport("legacy-batch")).toMatchObject({actorPrincipalId:f.owner.principalId,authenticationMethod:"legacy_unknown"});
    repaired.close();
    const reopened=new SqliteStateStore(path);
    expect(reopened.getHubImport("current-batch")).toEqual(current);
    expect(reopened.getHubImport("legacy-batch")?.authenticationMethod).toBe("legacy_unknown");
    reopened.close();
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
    const thread=target.store.listThreads("portable",25,0).items[0]!;expect(target.store.listReplies("portable",thread.id,25,0).items[0]?.historicalImport).toEqual({sourceAttribution:"verified",sourceAuthor:"Ada",sourceDate:"2026-09-13",sourceDateStatus:"valid",sourceOrder:"verified"}); target.store.close();
  });

  it("projects only proven current imported note bodies across detail, list and search",()=>{
    const f=fixture(),report=plan([
      mapping("docs/backlog/notes/NOTE-text/note.json","note","memory",{id:"NOTE-text",title:"Text",body:"  Plain note  "}),
      mapping("docs/backlog/notes/NOTE-metadata/note.json","note","memory",{id:"NOTE-metadata",title:"Metadata",body:{summary:"Actual summary",description:"Other text",flag:true}}),
      mapping("docs/backlog/notes/NOTE-manifest/note.json","note","memory",{id:"NOTE-manifest",title:"Manifest",description:"Manifest summary"}),
    ]);
    execute(f.store,f.identity,f.owner,{plan:report,targetProjectId:"reading",targetProjectName:"Reading"});
    const listed=f.store.listMemories("reading",2,0,"",true);
    expect(listed.items).toHaveLength(2);expect(listed.nextOffset).toBe(2);
    const memories=f.store.listMemories("reading",10,0,"",true).items;
    const text=memories.find(item=>item.title==="Text")!,metadata=memories.find(item=>item.title==="Metadata")!,manifest=memories.find(item=>item.title==="Manifest")!;
    expect(text).toMatchObject({body:"Plain note",reading:{kind:"imported-note",bodyFormat:"text",summary:null}});
    expect(metadata).toMatchObject({body:'{"summary":"Actual summary","description":"Other text","flag":true}',reading:{kind:"imported-note",bodyFormat:"metadata",summary:"Actual summary"}});
    expect(manifest.reading).toEqual({kind:"imported-note",bodyFormat:"manifest",summary:"Manifest summary"});
    expect(f.store.getMemory("reading",metadata.id)?.reading).toEqual(metadata.reading);
    const hits=f.store.searchKnowledge("reading",2,0,{kind:"memory"});
    expect(hits.items).toHaveLength(2);expect(hits.nextOffset).toBe(2);
    expect(hits.items.every(item=>item.reading?.kind==="imported-note")).toBe(true);
    expect(f.store.searchKnowledge("reading",10,0,{query:"Actual summary"}).items[0]).toMatchObject({id:metadata.id,reading:metadata.reading});
    const service=new KnowledgeService(f.store,f.identity,()=>NOW,()=>"native-json");
    const native=service.execute({operation:"create_memory",input:{projectId:"reading",title:"Native",body:'{"summary":"Native JSON"}',category:"note",tags:[],legacyId:"NOTE-native",sources:metadata.sources,idempotencyKey:"native"}},f.owner) as {value:{id:string}};
    expect(f.store.getMemory("reading",native.value.id)?.reading).toBeUndefined();
    const changed=service.execute({operation:"update_memory",input:{projectId:"reading",memoryId:metadata.id,expectedRevision:metadata.revision,title:metadata.title,body:"Locally revised",category:metadata.category,tags:metadata.tags,legacyId:metadata.legacyId,sources:metadata.sources,idempotencyKey:"changed"}},f.owner) as {value:{reading?:unknown}};
    expect(changed.value.reading).toBeUndefined();
    expect(f.store.getMemory("reading",metadata.id)?.reading).toBeUndefined();
    expect(JSON.parse(f.store.listHistory("reading","memory",metadata.id,10,0).items[0]!.previousJson!)).not.toHaveProperty("reading");
    const approved=service.execute({operation:"approve_memory",input:{projectId:"reading",memoryId:text.id,expectedRevision:text.revision,idempotencyKey:"approved"}},f.owner) as {value:{reading?:unknown}};
    expect(approved.value.reading).toBeUndefined();
    expect(f.store.getMemory("reading",text.id)?.reading?.bodyFormat).toBe("text");
    const snapshot=f.store.exportKnowledgeProject("reading")!;
    expect(snapshot.memories.every(row=>!Object.hasOwn(row,"reading"))).toBe(true);
    expect(snapshot.memories.find(row=>row.id===text.id)?.body).toBe("Plain note");
    f.store.close();
  });

  it("fails closed for malformed, ambiguous and foreign-project provenance",()=>{
    const f=fixture(),report=plan([mapping("docs/backlog/notes/NOTE-one/note.json","note","memory",{id:"NOTE-one",title:"One",body:{description:"Proven"}})]);
    execute(f.store,f.identity,f.owner,{plan:report,targetProjectId:"source",targetProjectName:"Source"});
    const memory=f.store.listMemories("source",10,0,"",true).items[0]!;
    const db=new Database(join(f.root,"state.sqlite3"));
    db.prepare("UPDATE knowledge_import_sources SET original_payload_json=? WHERE project_id=? AND target_id=?").run("{bad", "source",memory.id);
    expect(f.store.getMemory("source",memory.id)?.reading).toBeUndefined();
    db.prepare("UPDATE knowledge_import_sources SET original_payload_json=? WHERE project_id=? AND target_id=?").run(JSON.stringify({body:{description:"Proven"}}),"source",memory.id);
    expect(f.store.getMemory("source",memory.id)?.reading?.bodyFormat).toBe("metadata");
    const source=db.prepare("SELECT * FROM knowledge_import_sources WHERE project_id='source' AND target_id=?").get(memory.id) as {
      source_id:string;source_repository:string;source_commit:string;source_sha256:string;mapping_version:number;
      original_payload_json:string;created_at:string;target_revision:number|null;
    };
    db.prepare(`INSERT INTO knowledge_import_sources (id,project_id,source_id,source_repository,source_commit,source_path,legacy_id,source_sha256,mapping_version,target_kind,target_id,original_payload_json,created_at,target_revision)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("duplicate","source",source.source_id,source.source_repository,source.source_commit,"docs/backlog/notes/NOTE-other/note.json","NOTE-other",source.source_sha256,source.mapping_version,"memory",memory.id,source.original_payload_json,source.created_at,source.target_revision);
    expect(f.store.getMemory("source",memory.id)?.reading).toBeUndefined();
    db.prepare("DELETE FROM knowledge_import_sources WHERE id='duplicate'").run();
    const foreign=f.identity.createKnowledgeProject({name:"Foreign"},f.owner);
    db.prepare("UPDATE knowledge_import_sources SET project_id=? WHERE project_id='source' AND target_id=?").run(foreign.id,memory.id);
    expect(f.store.getMemory("source",memory.id)?.reading).toBeUndefined();
    db.close();f.store.close();
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

  it("derives attachment paths only from matching note and byte provenance",()=>{
    const f=fixture(),notes=["NOTE-one","NOTE-two"].map(id=>mapping(`docs/backlog/notes/${id}/note.json`,"note","memory",{id,title:id,body:"Note"}));
    const files=["NOTE-one/assets/proof.txt","NOTE-one/evidence/proof.txt","NOTE-one/Assets/Plan_V1.md","NOTE-two/assets/proof.txt"];
    const contents=new Map(files.map((path,index)=>[`docs/backlog/notes/${path}`,Buffer.from(`proof-${index}`)]));
    const attachments:HubImportMapping[]=Array.from(contents,([sourcePath,bytes])=>({sourcePath,sourceKind:"attachment",targetKind:"attachment",legacyId:null,disposition:"mapped",sourceSha256:createHash("sha256").update(bytes).digest("hex"),size:bytes.byteLength,mappedFields:[],sourceOnlyFields:[]}));
    executeHubImport(f.store,f.identity,f.owner,{plan:plan([...notes,...attachments]),targetProjectId:"paths",targetProjectName:"Paths",attachmentDirectory:join(f.root,"path-attachments")},()=>NOW,value=>value,(_plan,path)=>contents.get(path)!);
    const memories=f.store.listMemories("paths",10,0,"",true).items;
    const one=memories.find(item=>item.title==="NOTE-one")!,two=memories.find(item=>item.title==="NOTE-two")!;
    const oneFiles=f.store.listAttachments("paths","memory",one.id,10,0).items,twoFiles=f.store.listAttachments("paths","memory",two.id,10,0).items;
    expect(oneFiles.map(item=>item.relativePath).sort()).toEqual(["Assets/Plan_V1.md","assets/proof.txt","evidence/proof.txt"]);
    const planFile=oneFiles.find(item=>item.relativePath==="Assets/Plan_V1.md")!;
    expect(f.store.getAttachment("paths",planFile.id)?.relativePath).toBe("Assets/Plan_V1.md");
    expect(twoFiles.map(item=>item.relativePath)).toEqual(["assets/proof.txt"]);
    expect(f.store.getAttachment("paths",oneFiles[0]!.id)?.relativePath).toBe(oneFiles[0]!.relativePath);
    const db=new Database(join(f.root,"state.sqlite3"));
    db.prepare("UPDATE knowledge_import_sources SET source_commit=? WHERE project_id=? AND target_kind='attachment' AND target_id=?").run("f".repeat(40),"paths",oneFiles[0]!.id);
    expect(f.store.getAttachment("paths",oneFiles[0]!.id)?.relativePath).toBeUndefined();
    db.prepare("UPDATE knowledge_import_sources SET source_sha256=? WHERE project_id=? AND target_kind='attachment' AND target_id=?").run("b".repeat(64),"paths",oneFiles[1]!.id);
    expect(f.store.getAttachment("paths",oneFiles[1]!.id)?.relativePath).toBeUndefined();
    db.prepare("UPDATE knowledge_import_sources SET source_path=? WHERE project_id=? AND target_kind='attachment' AND target_id=?")
      .run("docs/backlog/notes/NOTE-two/assets/../proof.txt","paths",twoFiles[0]!.id);
    expect(f.store.getAttachment("paths",twoFiles[0]!.id)?.relativePath).toBeUndefined();
    const native={...twoFiles[0]!,id:"native-attachment"};delete native.relativePath;
    f.store.saveAttachment(native,{actor:f.owner,projectId:"paths",idempotencyKey:"native-attachment",requestHash:"c".repeat(64)});
    expect(f.store.getAttachment("paths",native.id)?.relativePath).toBeUndefined();
    expect(f.store.listAttachments("paths","memory",two.id,1,0).items).toHaveLength(1);
    expect(f.store.exportKnowledgeProject("paths")!.attachments.every(row=>!Object.hasOwn(row,"relativePath"))).toBe(true);
    db.close();f.store.close();
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

  it("retains durable attachment objects when database publication rolls back",()=>{
    const f=fixture(),bytes=Buffer.from("rollback proof"),hash=createHash("sha256").update(bytes).digest("hex"),note=mapping("docs/backlog/notes/NOTE-one/note.json","note","memory",{id:"NOTE-one",title:"Note",body:"Body"});
    const attachment:HubImportMapping={sourcePath:"docs/backlog/notes/NOTE-one/proof.txt",sourceKind:"attachment",targetKind:"attachment",legacyId:null,disposition:"mapped",sourceSha256:hash,size:bytes.byteLength,mappedFields:[],sourceOnlyFields:[]},orphan=mapping("docs/backlog/feature/missing.json#notes/0","task_note","historical_comment",{id:"missing:note:0",text:"Orphan"});orphan.legacyId="missing:note:0";
    const report=plan([note,attachment,orphan]),directory=join(f.root,"attachments");expect(()=>executeHubImport(f.store,f.identity,f.owner,{plan:report,targetProjectId:"rollback-files",targetProjectName:"Rollback",attachmentDirectory:directory},()=>NOW,value=>value,()=>bytes)).toThrow();
    expect(f.store.getKnowledgeProject("rollback-files")).toBeNull();expect(existsSync(join(directory,hash.slice(0,2),hash))).toBe(true);f.store.close();
  });
});
