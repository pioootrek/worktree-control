import type { KnowledgeTaskPage, KnowledgeReplyPage, KnowledgeRelationDestination } from "@/shared/contracts/knowledge";
import type { KnowledgeMemory, KnowledgeSearchHit, KnowledgeSearchOptions } from "@/shared/contracts/knowledge-memory";
import type { KnowledgeAttachment } from "@/shared/contracts/knowledge-attachments";
import type { KnowledgeFilters, KnowledgeProjectSummary } from "@/shared/contracts/knowledge";
import type { PendingTestRun, ProjectRegistration, ReservationRequest, StateStore, TestRunStatusRecord, WorktreeStorageSample } from "@/server/state-store";
import type { Project, Reservation, ServerCapacitySettings, TestEnvironmentProfile, TestQueueSettings, TestRun, TestRunPhase, WorktreeStorageSnapshot } from "@/shared/contracts";
import type {
  RemotePrincipal,
  RemotePrincipalProjectGrant,
  RemoteProjectIdentity,
  RemoteVerificationAttempt,
  RemoteVerificationAttemptStore,
  RemoteVerificationProvisioningStore,
  RemoteVerificationRequest,
  RemoteVerificationRequestPhase,
  RemoteVerificationStore,
  RemoteWorkerProjectGrant,
  RemoteWorkerRegistration,
} from "@/server/modules/remote-verification";
import type {
  AuthenticationMethod,
  CredentialAuthenticationRecord,
  IdentityStore,
  KnowledgeProject,
  KnowledgeProjectGrant,
  KnowledgeProjectRuntimeLink,
  Principal,
  PrincipalCredential,
} from "@/server/modules/identity";
import type { AuthenticationPolicy, AuthenticationStore } from "@/server/modules/authentication";
import type { HubImportBatch, HubImportExecutionStore, HubImportMapping, KnowledgeHistoryEntry, KnowledgeMutationContext, KnowledgeMutationResult, KnowledgePage, KnowledgeProjectSnapshot, KnowledgeRelation, KnowledgeReply, KnowledgeRuntimeLinkResult, KnowledgeStore, KnowledgeTask, KnowledgeThread } from "@/server/modules/knowledge";
import { KnowledgeError } from "@/server/modules/knowledge";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { initializeSchema } from "./migrations";
import { OwnedSqliteDatabase } from "./owned-database";
import { IdentityQueries } from "./identity-queries";
import { KnowledgeQueries } from "./knowledge-queries";
import { mapProject, type ProjectRow } from "./project-mapping";
import { equalHash, mapReservation, type ReservationRow } from "./reservation-mapping";
import { AuthenticationQueries } from "./authentication-queries";
import { RemoteVerificationQueries } from "./remote-verification-queries";
import { StorageQueries } from "./storage-queries";
import { TestRunQueries } from "./test-run-queries";

export class SqliteStateStore implements StateStore, AuthenticationStore, IdentityStore, KnowledgeStore, HubImportExecutionStore, RemoteVerificationStore, RemoteVerificationAttemptStore, RemoteVerificationProvisioningStore {
  private readonly database: Database.Database;
  private readonly testRuns: TestRunQueries;
  private readonly storage: StorageQueries;
  private readonly remoteVerification: RemoteVerificationQueries;
  private readonly identity: IdentityQueries;
  private readonly authentication: AuthenticationQueries;
  private readonly knowledge: KnowledgeQueries;

  private readonly ownedDatabase: OwnedSqliteDatabase;

  constructor(databasePath: string, inspected?: OwnedSqliteDatabase) {
    this.ownedDatabase = inspected ?? new OwnedSqliteDatabase(databasePath, true);
    try {
      this.database = this.ownedDatabase.enableWrites();
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("foreign_keys = ON");
      this.database.pragma("busy_timeout = 3000");
      initializeSchema(this.database);
      this.testRuns = new TestRunQueries(this.database);
      this.storage = new StorageQueries(this.database);
      this.remoteVerification = new RemoteVerificationQueries(this.database);
      this.identity = new IdentityQueries(this.database);
      this.authentication = new AuthenticationQueries(this.database);
      this.knowledge = new KnowledgeQueries(this.database);
    } catch (error) {
      this.ownedDatabase.close();
      throw error;
    }
  }

  backup(destination: string): Promise<void> { return this.database.backup(destination).then(() => undefined); }
  schemaVersion(): number { return (this.database.prepare("SELECT max(version) version FROM schema_migrations").get() as { version: number }).version; }

  private mapHubImportBatch(row: Record<string, unknown>): HubImportBatch {
    return {
      id: String(row.id), planId: String(row.plan_id), planHash: String(row.plan_hash), sourceId: String(row.source_id), sourceRepository: String(row.source_repository),
      sourceCommit: String(row.source_commit), targetProjectId: String(row.target_project_id), targetProjectName: String(row.target_project_name),
      expectedTargetRevision: row.expected_target_revision === null ? null : Number(row.expected_target_revision),
      actorPrincipalId: String(row.actor_principal_id), authenticationMethod: row.authentication_method as HubImportBatch["authenticationMethod"],
      status: row.status as HubImportBatch["status"], cursor: Number(row.cursor),
      totalItems: Number(row.total_items), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      publishedAt: row.published_at === null ? null : String(row.published_at), error: row.error === null ? null : String(row.error),
    };
  }

  beginHubImport(input: Omit<HubImportBatch, "status" | "cursor" | "createdAt" | "updatedAt" | "publishedAt" | "error" | "authenticationMethod"> & {authenticationMethod: AuthenticationMethod}, now: string): HubImportBatch {
    return this.database.transaction(() => {
      const existing = this.database.prepare("SELECT * FROM knowledge_import_batches WHERE id = ? OR (source_id = ? AND source_commit = ? AND plan_hash = ? AND target_project_id = ?)")
        .get(input.id, input.sourceId, input.sourceCommit, input.planHash, input.targetProjectId) as Record<string, unknown> | undefined;
      if (existing) return this.mapHubImportBatch(existing);
      const target=this.database.prepare("SELECT name,revision FROM knowledge_projects WHERE id = ?").get(input.targetProjectId) as {name:string;revision:number}|undefined;
      if(input.expectedTargetRevision===null ? Boolean(target) : !target||target.revision!==input.expectedTargetRevision||target.name!==input.targetProjectName) throw new KnowledgeError("revision_conflict", "Import target revision or identity changed.");
      this.database.prepare(`INSERT INTO knowledge_import_batches
        (id,plan_id,plan_hash,source_id,source_repository,source_commit,target_project_id,target_project_name,expected_target_revision,actor_principal_id,authentication_method,status,cursor,total_items,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, 'staging',0,?,?,?)`).run(input.id,input.planId,input.planHash,input.sourceId,input.sourceRepository,input.sourceCommit,input.targetProjectId,input.targetProjectName,input.expectedTargetRevision,input.actorPrincipalId,input.authenticationMethod,input.totalItems,now,now);
      return this.getHubImport(input.id)!;
    }).immediate();
  }

  getHubImport(batchId: string): HubImportBatch | null {
    const row = this.database.prepare("SELECT * FROM knowledge_import_batches WHERE id = ?").get(batchId) as Record<string, unknown> | undefined;
    return row ? this.mapHubImportBatch(row) : null;
  }

  resetHubImport(batchId: string, expectedTargetRevision: number | null, now: string): HubImportBatch {
    return this.database.transaction(()=>{
      const batch=this.getHubImport(batchId);if(!batch) throw new KnowledgeError("not_found","Import batch not found.");
      if(batch.status!=="failed") throw new KnowledgeError("revision_conflict","Only a failed import batch can be reset.");
      const target=this.database.prepare("SELECT name,revision FROM knowledge_projects WHERE id = ?").get(batch.targetProjectId) as {name:string;revision:number}|undefined;
      if(expectedTargetRevision===null ? Boolean(target) : !target||target.revision!==expectedTargetRevision||target.name!==batch.targetProjectName) throw new KnowledgeError("revision_conflict", "Import target revision or identity changed.");
      this.database.prepare("DELETE FROM knowledge_import_staging WHERE batch_id=?").run(batchId);
      this.database.prepare("UPDATE knowledge_import_batches SET expected_target_revision=?,status='staging',cursor=0,error=NULL,published_at=NULL,updated_at=? WHERE id=? AND status='failed'").run(expectedTargetRevision,now,batchId);
      return this.getHubImport(batchId)!;
    }).immediate();
  }

  stageHubImportChunk(batchId: string, expectedCursor: number, mappings: HubImportMapping[], now: string): HubImportBatch {
    return this.database.transaction(() => {
      const batch=this.getHubImport(batchId); if(!batch||batch.status!=="staging"||batch.cursor!==expectedCursor) throw new KnowledgeError("revision_conflict","Import cursor changed.");
      if(expectedCursor+mappings.length>batch.totalItems) throw new KnowledgeError("invalid_request","Import chunk exceeds its plan.");
      const statement=this.database.prepare("INSERT INTO knowledge_import_staging(batch_id,ordinal,mapping_json) VALUES (?,?,?)");
      mappings.forEach((mapping,index)=>statement.run(batchId,expectedCursor+index,JSON.stringify(mapping)));
      this.database.prepare("UPDATE knowledge_import_batches SET cursor = ?, updated_at = ? WHERE id = ?").run(expectedCursor+mappings.length,now,batchId);
      return this.getHubImport(batchId)!;
    }).immediate();
  }

  publishHubImport(batchId: string, now: string, attachmentDirectory?: string): HubImportBatch {
    const installed:string[]=[];
    try{return this.database.transaction(() => {
      const batch=this.getHubImport(batchId); if(!batch) throw new KnowledgeError("not_found","Import batch not found.");
      if(batch.status==="published") return batch;
      if(batch.status!=="staging"||batch.cursor!==batch.totalItems) throw new KnowledgeError("revision_conflict","Import batch is incomplete.");
      const target=this.database.prepare("SELECT name,revision FROM knowledge_projects WHERE id = ?").get(batch.targetProjectId) as {name:string;revision:number}|undefined;
      if(batch.expectedTargetRevision===null ? Boolean(target) : !target||target.revision!==batch.expectedTargetRevision||target.name!==batch.targetProjectName) throw new KnowledgeError("revision_conflict","Import target changed before publication.");
      const staged=this.database.prepare("SELECT mapping_json FROM knowledge_import_staging WHERE batch_id = ? AND ordinal = ?");
      const readMapping=(ordinal:number)=>{const row=staged.get(batchId,ordinal) as {mapping_json:string}|undefined;if(!row) throw new KnowledgeError("invalid_request","Import staging is incomplete.");return JSON.parse(row.mapping_json) as HubImportMapping;};
      const mappings:HubImportMapping[]=[];
      for(let ordinal=0;ordinal<batch.totalItems;ordinal++){const parsed=readMapping(ordinal);const {originalPayload,...metadata}=parsed;void originalPayload;mappings.push(metadata);}
      const stagedCount=(this.database.prepare("SELECT count(*) count FROM knowledge_import_staging WHERE batch_id=?").get(batchId) as {count:number}).count;
      if(stagedCount!==batch.totalItems) throw new KnowledgeError("invalid_request","Import staging is incomplete.");
      if(batch.expectedTargetRevision===null){this.database.prepare("INSERT INTO knowledge_projects(id,name,status,revision,created_at,updated_at) VALUES (?,?,'active',1,?,?)").run(batch.targetProjectId,batch.targetProjectName,now,now);
        this.database.prepare("INSERT INTO knowledge_project_grants(principal_id,project_id,permissions_json,revoked_at) VALUES (?,?,?,NULL)").run(batch.actorPrincipalId,batch.targetProjectId,JSON.stringify(["attachments:read","attachments:write","knowledge:approve","knowledge:export","knowledge:import","knowledge:read","knowledge:write"]));
      }else this.database.prepare("UPDATE knowledge_projects SET revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(now,batch.targetProjectId,batch.expectedTargetRevision);
      const stable=(kind:string,mapping:HubImportMapping)=>createHash("sha256").update(`${batch.targetProjectId}\0${batch.sourceId}\0${mapping.sourcePath}\0${kind}`).digest("hex").slice(0,32);
      const assertImportTargetUnmodified=(mapping:HubImportMapping,targetKind:"task"|"memory",targetId:string,provenanceKind:string=targetKind)=>{
        const sourceId=stable("source",mapping),table=targetKind==="task"?"knowledge_tasks":"knowledge_memories";
        const current=this.database.prepare(`SELECT revision FROM ${table} WHERE id = ? AND project_id = ?`).get(targetId,batch.targetProjectId) as {revision:number}|undefined;
        const previous=this.database.prepare("SELECT target_kind,target_id,target_revision FROM knowledge_import_sources WHERE id = ? AND project_id = ?").get(sourceId,batch.targetProjectId) as {target_kind:string|null;target_id:string|null;target_revision:number|null}|undefined;
        if(!current) return;
        if(!previous||previous.target_kind!==provenanceKind||previous.target_id!==targetId||previous.target_revision!==current.revision) throw new KnowledgeError("revision_conflict",`Locally changed imported ${targetKind} blocks publication: ${mapping.sourcePath}`);
      };
      const text=(value:unknown,fallback:string,max=65536,label="Imported text")=>{const result=typeof value==="string"&&value.trim()?value.trim():fallback;if(result.length>max) throw new KnowledgeError("limit_exceeded",`${label} exceeds ${max} characters.`);return result;};
      const list=(value:unknown)=>Array.isArray(value)?value.filter(item=>typeof item==="string").join("\n"):"";
      const completionSummary=(value:unknown,sourcePath:string)=>{
        let result:string;
        if(typeof value==="string") result=value.trim()||`[Imported completion summary is empty: ${sourcePath}]`;
        else if(Array.isArray(value)) result=value.length
          ? value.map((item,index)=>typeof item==="string"&&item.trim()?`- ${item.trim()}`:`- [Empty or unsupported summary item ${index+1}]`).join("\n")
          : `[Imported completion summary is an empty array: ${sourcePath}]`;
        else result=`[Imported completion summary has unsupported type ${value===null?"null":typeof value}: ${sourcePath}]`;
        if(result.length>65536) throw new KnowledgeError("limit_exceeded","Completion description exceeds 65536 characters.");
        return result;
      };
      const withoutPreviousCompletionSummary=(description:string,targetId:string)=>{
        const previous=this.database.prepare("SELECT source_path,original_payload_json FROM knowledge_import_sources WHERE project_id=? AND source_id=? AND target_kind='task_completion' AND target_id=? ORDER BY created_at DESC").all(batch.targetProjectId,batch.sourceId,targetId) as Array<{source_path:string;original_payload_json:string|null}>;
        const suffixes=previous.flatMap(row=>{if(!row.original_payload_json) return [];let payload:unknown;try{payload=JSON.parse(row.original_payload_json);}catch{return [];}if(!payload||typeof payload!=="object"||Array.isArray(payload)) return [];return [`\n\nCompletion summary\n${completionSummary((payload as Record<string,unknown>).summary,row.source_path)}`];});
        let result=description,matched=true;
        while(matched){matched=false;for(const suffix of suffixes) if(result.endsWith(suffix)){result=result.slice(0,-suffix.length);matched=true;break;}}
        return result;
      };
      const taskTargets=new Map<string,string>();
      for(const mapping of mappings) if(mapping.targetKind==="task"&&mapping.legacyId) taskTargets.set(mapping.legacyId,stable("task",mapping));
      const threadTargets=new Map<string,string>();
      for(let ordinal=0;ordinal<batch.totalItems;ordinal++){
        const mapping=readMapping(ordinal);
        const payload=(mapping.originalPayload&&typeof mapping.originalPayload==="object"&&!Array.isArray(mapping.originalPayload)?mapping.originalPayload:{}) as Record<string,unknown>;
        let targetId:string|null=null;
        if(mapping.targetKind==="task"){
          targetId=stable("task",mapping); const rawStatus=text(payload.status,"open").replace("-","_"); const status=["open","in_progress","blocked","done","archived"].includes(rawStatus)?rawStatus:"open";
          const priority=["now","next","later"].includes(text(payload.priority,"later"))?text(payload.priority,"later"):"later";
          const description=text([list(payload.problem),list(payload.scope),list(payload.validation)].filter(Boolean).join("\n\n"),`Imported from ${mapping.sourcePath}`,65536,"Task description");
          assertImportTargetUnmodified(mapping,"task",targetId);
          this.database.prepare("INSERT INTO knowledge_tasks(id,project_id,title,description,status,priority,revision,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,status=excluded.status,priority=excluded.priority,revision=knowledge_tasks.revision+1,updated_at=excluded.updated_at")
            .run(targetId,batch.targetProjectId,text(payload.title,mapping.legacyId??mapping.sourcePath,200,"Task title"),description,status,priority,batch.actorPrincipalId,now,now);
        } else if(mapping.targetKind==="memory"){
          targetId=stable("memory",mapping); const body=text(typeof payload.body==="string"?payload.body:JSON.stringify(payload.body??payload),"Imported empty note",65536,"Memory body");
          const memoryStatus=payload.status==="archived"?"archived":"active";
          const tags=Array.isArray(payload.tags)?payload.tags.filter((tag):tag is string=>typeof tag==="string"):[];
          if(tags.length>100||tags.some(tag=>tag.length>100)) throw new KnowledgeError("limit_exceeded","Memory tags exceed logical snapshot limits.");
          assertImportTargetUnmodified(mapping,"memory",targetId);
          this.database.prepare("INSERT INTO knowledge_memories(id,project_id,title,body,category,tags_json,legacy_id,sources_json,status,superseded_by_json,approval_json,revision,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,1,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,category=excluded.category,tags_json=excluded.tags_json,legacy_id=excluded.legacy_id,sources_json=excluded.sources_json,status=excluded.status,approval_json=NULL,revision=knowledge_memories.revision+1,updated_at=excluded.updated_at")
            .run(targetId,batch.targetProjectId,text(payload.title,mapping.legacyId??mapping.sourcePath,200,"Memory title"),body,"note",JSON.stringify(tags),mapping.legacyId,JSON.stringify([{kind:"repository",sourceId:batch.sourceId,repository:batch.sourceRepository,commit:batch.sourceCommit,path:mapping.sourcePath}]),memoryStatus,batch.actorPrincipalId,now,now);
        } else if(mapping.targetKind==="task_completion"){
          continue;
        } else if(mapping.targetKind==="historical_comment"){
          const parentLegacy=mapping.legacyId?.replace(/:note:\d+$/,"")??"",taskId=taskTargets.get(parentLegacy);
          if(!taskId) throw new KnowledgeError("invalid_request",`Historical comment has no imported task: ${mapping.sourcePath}`);
          let threadId=threadTargets.get(parentLegacy); if(!threadId){const parent=mappings.find(item=>item.targetKind==="task"&&item.legacyId===parentLegacy);if(!parent) throw new KnowledgeError("invalid_request","Historical comment parent is missing.");threadId=stable("thread",parent);threadTargets.set(parentLegacy,threadId);
            this.database.prepare("INSERT INTO knowledge_threads(id,project_id,title,body,revision,created_by,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,revision=knowledge_threads.revision+1,updated_at=excluded.updated_at").run(threadId,batch.targetProjectId,text(null,`Imported discussion: ${parentLegacy}`,200,"Thread title"),text(null,`Historical comments imported from ${parent.sourcePath}`,65536,"Thread body"),batch.actorPrincipalId,now,now);
            const relationId=stable("task-thread",parent);this.database.prepare("INSERT OR IGNORE INTO knowledge_relations(id,project_id,type,source_kind,source_id,target_kind,target_id,revision,created_by,created_at) VALUES (?,?,'derived_from','task',?,'thread',?,1,?,?)").run(relationId,batch.targetProjectId,taskId,threadId,batch.actorPrincipalId,now);
          }
          targetId=stable("reply",mapping);this.database.prepare("INSERT INTO knowledge_replies(id,project_id,thread_id,body,revision,created_by,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,revision=knowledge_replies.revision+1,updated_at=excluded.updated_at").run(targetId,batch.targetProjectId,threadId,text(payload.text,JSON.stringify(payload),65536,"Reply body"),batch.actorPrincipalId,now,now);
        } else if(mapping.targetKind==="attachment"){
          if(!attachmentDirectory) throw new KnowledgeError("invalid_request","Attachment directory is required.");
          const slash=mapping.sourcePath.lastIndexOf("/"),parent=mappings.filter(item=>item.targetKind==="memory"&&mapping.sourcePath.startsWith(`${dirname(item.sourcePath)}/`)).sort((a,b)=>b.sourcePath.length-a.sourcePath.length)[0];
          if(!parent) throw new KnowledgeError("invalid_request",`Attachment has no imported note: ${mapping.sourcePath}`); const memoryId=stable("memory",parent);
          const encoded=typeof payload.dataBase64==="string"?payload.dataBase64:"",bytes=Buffer.from(encoded,"base64"),hash=createHash("sha256").update(bytes).digest("hex");
          if(bytes.byteLength!==mapping.size||hash!==mapping.sourceSha256||bytes.toString("base64")!==encoded) throw new KnowledgeError("revision_conflict",`Staged attachment is invalid: ${mapping.sourcePath}`);
          const root=resolve(attachmentDirectory),shard=resolve(root,hash.slice(0,2)),file=resolve(shard,hash);if(!file.startsWith(root+sep)) throw new KnowledgeError("invalid_request","Attachment target is unsafe.");mkdirSync(root,{recursive:true});if(lstatSync(root).isSymbolicLink()||!lstatSync(root).isDirectory()) throw new KnowledgeError("invalid_request","Attachment storage is unsafe.");mkdirSync(shard,{recursive:true});if(lstatSync(shard).isSymbolicLink()||!lstatSync(shard).isDirectory()) throw new KnowledgeError("invalid_request","Attachment shard is unsafe.");
          if(existsSync(file)){if(lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile()) throw new KnowledgeError("invalid_request","Attachment object is unsafe.");const current=readFileSync(file);if(current.byteLength!==bytes.byteLength||createHash("sha256").update(current).digest("hex")!==hash) throw new KnowledgeError("invalid_request","Existing attachment object conflicts with the import.");}
          else{const fd=openSync(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);}finally{closeSync(fd);}chmodSync(file,0o600);installed.push(file);}
          targetId=stable("attachment",mapping);this.database.prepare("INSERT INTO knowledge_attachments(id,project_id,record_kind,record_id,filename,media_type,size,sha256,created_by,created_at) VALUES (?,?,'memory',?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET filename=excluded.filename,media_type=excluded.media_type,size=excluded.size,sha256=excluded.sha256")
            .run(targetId,batch.targetProjectId,memoryId,text(payload.fileName,mapping.sourcePath.slice(slash+1),255,"Attachment filename"),text(payload.mediaType,"application/octet-stream",255,"Attachment media type"),bytes.byteLength,hash,batch.actorPrincipalId,now);
        }
        const sourceId=stable("source",mapping);
        this.database.prepare(`INSERT INTO knowledge_import_sources
          (id,project_id,batch_id,source_id,source_repository,source_commit,source_path,legacy_id,source_sha256,mapping_version,target_kind,target_id,original_payload_json,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,2,?,?,?,?) ON CONFLICT(id) DO UPDATE SET batch_id=excluded.batch_id,source_repository=excluded.source_repository,source_commit=excluded.source_commit,source_sha256=excluded.source_sha256,mapping_version=excluded.mapping_version,target_kind=excluded.target_kind,target_id=excluded.target_id,original_payload_json=excluded.original_payload_json,created_at=excluded.created_at`).run(sourceId,batch.targetProjectId,batch.id,batch.sourceId,batch.sourceRepository,batch.sourceCommit,mapping.sourcePath,mapping.legacyId,mapping.sourceSha256,mapping.targetKind,targetId,mapping.targetKind==="attachment"||mapping.originalPayload===undefined?null:JSON.stringify(mapping.originalPayload),now);
      }
      for(let ordinal=0;ordinal<batch.totalItems;ordinal++){const mapping=readMapping(ordinal);if(mapping.targetKind!=="task_completion") continue;const payload=(mapping.originalPayload??{}) as Record<string,unknown>,itemId=typeof payload.item_id==="string"?payload.item_id:null;let targetId=itemId?taskTargets.get(itemId)??null:null;
        if(!targetId&&itemId){const previous=this.database.prepare("SELECT target_id,target_revision FROM knowledge_import_sources WHERE project_id=? AND source_id=? AND legacy_id=? AND target_kind='task'").get(batch.targetProjectId,batch.sourceId,itemId) as {target_id:string|null;target_revision:number|null}|undefined;if(previous?.target_id){const current=this.database.prepare("SELECT revision FROM knowledge_tasks WHERE id=? AND project_id=?").get(previous.target_id,batch.targetProjectId) as {revision:number}|undefined;if(!current||current.revision!==previous.target_revision) throw new KnowledgeError("revision_conflict",`Locally changed completion target blocks publication: ${mapping.sourcePath}`);targetId=previous.target_id;}}
        const summary=completionSummary(payload.summary,mapping.sourcePath);
        if(targetId){const current=this.database.prepare("SELECT description FROM knowledge_tasks WHERE id=? AND project_id=?").get(targetId,batch.targetProjectId) as {description:string}|undefined;if(!current) throw new KnowledgeError("revision_conflict",`Completion target is missing: ${mapping.sourcePath}`);const base=withoutPreviousCompletionSummary(current.description,targetId),description=`${base}\n\nCompletion summary\n${summary}`;if(description.length>65536) throw new KnowledgeError("limit_exceeded","Completion description exceeds 65536 characters.");this.database.prepare("UPDATE knowledge_tasks SET description=?, status='done', revision=revision+1, updated_at=? WHERE id=? AND project_id=?").run(description,now,targetId,batch.targetProjectId);}
        else{targetId=stable("task",mapping);assertImportTargetUnmodified(mapping,"task",targetId,"task_completion");this.database.prepare("INSERT INTO knowledge_tasks(id,project_id,title,description,status,priority,revision,created_by,created_at,updated_at) VALUES (?,?,?,?,'done','later',1,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,status='done',priority=excluded.priority,revision=knowledge_tasks.revision+1,updated_at=excluded.updated_at").run(targetId,batch.targetProjectId,text(payload.title,mapping.legacyId??mapping.sourcePath,200,"Completion title"),summary,batch.actorPrincipalId,now,now);}
        if(mapping.legacyId) taskTargets.set(mapping.legacyId,targetId);if(itemId) taskTargets.set(itemId,targetId);
        const sourceId=stable("source",mapping);this.database.prepare(`INSERT INTO knowledge_import_sources (id,project_id,batch_id,source_id,source_repository,source_commit,source_path,legacy_id,source_sha256,mapping_version,target_kind,target_id,original_payload_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,2,?,?,?,?) ON CONFLICT(id) DO UPDATE SET batch_id=excluded.batch_id,source_repository=excluded.source_repository,source_commit=excluded.source_commit,source_sha256=excluded.source_sha256,mapping_version=excluded.mapping_version,target_kind=excluded.target_kind,target_id=excluded.target_id,original_payload_json=excluded.original_payload_json,created_at=excluded.created_at`).run(sourceId,batch.targetProjectId,batch.id,batch.sourceId,batch.sourceRepository,batch.sourceCommit,mapping.sourcePath,mapping.legacyId,mapping.sourceSha256,mapping.targetKind,targetId,JSON.stringify(mapping.originalPayload??null),now);
      }
      const importedTaskIds=new Set((this.database.prepare("SELECT DISTINCT target_id FROM knowledge_import_sources WHERE project_id=? AND source_id=? AND target_kind IN ('task','task_completion') AND target_id IS NOT NULL").all(batch.targetProjectId,batch.sourceId) as Array<{target_id:string}>).map(row=>row.target_id));
      for(const targetId of taskTargets.values()) importedTaskIds.add(targetId);
      const relationId=(source:string,target:string)=>{const key=[source,target].sort().join("\0");return createHash("sha256").update(`${batch.targetProjectId}\0${batch.sourceId}\0relates_to\0${key}`).digest("hex").slice(0,32);};
      const followupRelationId=(followup:string,completed:string)=>createHash("sha256").update(`${batch.targetProjectId}\0${batch.sourceId}\0followup\0${followup}\0${completed}`).digest("hex").slice(0,32);
      const desiredRelationIds=new Set<string>();
      for(let ordinal=0;ordinal<batch.totalItems;ordinal++){const mapping=readMapping(ordinal);if(!mapping.legacyId) continue;const payload=(mapping.originalPayload??{}) as Record<string,unknown>;
        if(mapping.targetKind==="task"){const links=payload.links&&typeof payload.links==="object"&&!Array.isArray(payload.links)?payload.links as Record<string,unknown>:null,related=Array.isArray(links?.related_ids)?links.related_ids.filter((value):value is string=>typeof value==="string"):[];
          for(const legacy of related){const source=taskTargets.get(mapping.legacyId),target=taskTargets.get(legacy);if(!source||!target||source===target) continue;const id=relationId(source,target);desiredRelationIds.add(id);this.database.prepare("INSERT OR IGNORE INTO knowledge_relations(id,project_id,type,source_kind,source_id,target_kind,target_id,revision,created_by,created_at) VALUES (?,?,'relates_to','task',?,'task',?,1,?,?)").run(id,batch.targetProjectId,source,target,batch.actorPrincipalId,now);}}
        if(mapping.targetKind==="task_completion"){const completed=taskTargets.get(mapping.legacyId),followups=Array.isArray(payload.followup_ids)?payload.followup_ids.filter((value):value is string=>typeof value==="string"):[];
          for(const legacy of followups){const followup=taskTargets.get(legacy);if(!completed||!followup||completed===followup) continue;const id=followupRelationId(followup,completed);desiredRelationIds.add(id);this.database.prepare("INSERT OR IGNORE INTO knowledge_relations(id,project_id,type,source_kind,source_id,target_kind,target_id,revision,created_by,created_at) VALUES (?,?,'derived_from','task',?,'task',?,1,?,?)").run(id,batch.targetProjectId,followup,completed,batch.actorPrincipalId,now);}}
      }
      const existingRelations=this.database.prepare("SELECT id,type,source_id,target_id FROM knowledge_relations WHERE project_id=? AND type IN ('relates_to','derived_from') AND source_kind='task' AND target_kind='task'").all(batch.targetProjectId) as Array<{id:string;type:string;source_id:string;target_id:string}>;
      const deleteRelation=this.database.prepare("DELETE FROM knowledge_relations WHERE id=? AND project_id=?");
      for(const relation of existingRelations) if(importedTaskIds.has(relation.source_id)&&importedTaskIds.has(relation.target_id)&&(relation.id===relationId(relation.source_id,relation.target_id)||relation.id===followupRelationId(relation.source_id,relation.target_id))&&!desiredRelationIds.has(relation.id)) deleteRelation.run(relation.id,batch.targetProjectId);
      for(const mapping of mappings){
        const sourceId=stable("source",mapping),targetTable=mapping.targetKind==="task"||mapping.targetKind==="task_completion"?"knowledge_tasks":mapping.targetKind==="memory"?"knowledge_memories":mapping.targetKind==="historical_comment"?"knowledge_replies":null;
        if(!targetTable) continue;
        const source=this.database.prepare("SELECT target_id FROM knowledge_import_sources WHERE id = ?").get(sourceId) as {target_id:string|null}|undefined;
        if(!source?.target_id) continue;
        const target=this.database.prepare(`SELECT revision FROM ${targetTable} WHERE id = ? AND project_id = ?`).get(source.target_id,batch.targetProjectId) as {revision:number}|undefined;
        if(target){if(targetTable==="knowledge_tasks") this.database.prepare("UPDATE knowledge_import_sources SET target_revision=? WHERE project_id=? AND target_id=? AND target_kind IN ('task','task_completion')").run(target.revision,batch.targetProjectId,source.target_id);else this.database.prepare("UPDATE knowledge_import_sources SET target_revision = ? WHERE id = ?").run(target.revision,sourceId);}
      }
      this.database.prepare("DELETE FROM knowledge_import_staging WHERE batch_id=?").run(batchId);
      this.database.prepare("UPDATE knowledge_import_batches SET status='published', published_at=?, updated_at=? WHERE id=?").run(now,now,batchId);
      return this.getHubImport(batchId)!;
    }).immediate();}catch(error){for(const file of installed.reverse())rmSync(file,{force:true});this.database.transaction(()=>{this.database.prepare("DELETE FROM knowledge_import_staging WHERE batch_id=?").run(batchId);this.database.prepare("UPDATE knowledge_import_batches SET status='failed',error=?,updated_at=? WHERE id=? AND status='staging'").run(error instanceof Error?error.message.slice(0,2000):"Import publication failed.",now,batchId);}).immediate();throw error;}
  }

  exportKnowledgeProject(projectId: string): KnowledgeProjectSnapshot | null {
    const project = this.database.prepare("SELECT * FROM knowledge_projects WHERE id = ?").get(projectId) as Record<string, unknown> | undefined;
    if (!project) return null;
    const table = (name: string) => this.database.prepare(`SELECT * FROM ${name} WHERE project_id = ? ORDER BY id`).all(projectId) as Array<Record<string, unknown>>;
    const memories = table("knowledge_memories");
    const history:Array<Record<string,unknown>> = table("knowledge_history").map((value, index) => { const { id, ...row }=value; void id; return { ordinal: index + 1, ...row }; });
    const required = new Set<string>();
    for (const rows of [table("knowledge_threads"), table("knowledge_replies"), table("knowledge_tasks"), memories, table("knowledge_relations"), history, table("knowledge_attachments")]) {
      for (const row of rows) for (const key of ["created_by", "principal_id"]) if (typeof row[key] === "string") required.add(row[key] as string);
    }
    for (const row of memories) {
      if (typeof row.approval_json !== "string" || !row.approval_json) continue;
      const approval = JSON.parse(row.approval_json) as { principalId?: unknown };
      if (typeof approval.principalId === "string") required.add(approval.principalId);
    }
    const importSources=table("knowledge_import_sources").map(row=>{const result={...row};delete result.batch_id;return result;});
    return { project, threads: table("knowledge_threads"), replies: table("knowledge_replies"), tasks: table("knowledge_tasks"), memories,
      relations: table("knowledge_relations"), history, attachments: table("knowledge_attachments"), importSources, requiredPrincipals: [...required].sort() };
  }

  importKnowledgeProject(snapshot: KnowledgeProjectSnapshot): void {
    this.database.transaction(() => {
      const projectId = snapshot.project.id;
      if (typeof projectId !== "string" || this.database.prepare("SELECT 1 FROM knowledge_projects WHERE id = ?").get(projectId)) throw new KnowledgeError("invalid_request", "Knowledge project already exists or has an invalid ID.");
      for (const principalId of snapshot.requiredPrincipals) if (!this.database.prepare("SELECT 1 FROM remote_principals WHERE id = ?").get(principalId)) throw new KnowledgeError("invalid_request", `Required historical principal is missing: ${principalId}`);
      const columns:Record<string,string[]>={
        knowledge_projects:["id","name","status","revision","created_at","updated_at"],
        knowledge_threads:["id","project_id","title","body","revision","created_by","created_at","updated_at"],
        knowledge_replies:["id","project_id","thread_id","body","revision","created_by","created_at","updated_at"],
        knowledge_tasks:["id","project_id","title","description","status","priority","revision","created_by","created_at","updated_at"],
        knowledge_memories:["id","project_id","title","body","category","tags_json","legacy_id","sources_json","status","superseded_by_json","approval_json","revision","created_by","created_at","updated_at"],
        knowledge_relations:["id","project_id","type","source_kind","source_id","target_kind","target_id","revision","created_by","created_at"],
        knowledge_history:["ordinal","project_id","record_kind","record_id","operation","previous_json","principal_id","authentication_method","revision","created_at"],
        knowledge_attachments:["id","project_id","record_kind","record_id","filename","media_type","size","sha256","created_by","created_at"],
        knowledge_import_sources:["id","project_id","source_id","source_repository","source_commit","source_path","legacy_id","source_sha256","mapping_version","target_kind","target_id","original_payload_json","created_at","target_revision"],
      };
      const insert = (table: string, rows: Array<Record<string, unknown>>) => {
        const expected=columns[table]!;
        for (const row of rows) {
          if(Object.keys(row).sort().join("\0")!==[...expected].sort().join("\0")) throw new KnowledgeError("invalid_request", `Invalid ${table} record shape.`);
          if(table!=="knowledge_projects"&&row.project_id!==projectId) throw new KnowledgeError("invalid_request", `Foreign project record in ${table}.`);
          const inserted=table==="knowledge_history"?expected.filter(column=>column!=="ordinal"):expected;
          this.database.prepare(`INSERT INTO ${table} (${inserted.join(",")}) VALUES (${inserted.map(() => "?").join(",")})`).run(...inserted.map(key => row[key]));
        }
      };
      insert("knowledge_projects", [snapshot.project]);
      insert("knowledge_threads", snapshot.threads); insert("knowledge_tasks", snapshot.tasks); insert("knowledge_memories", snapshot.memories);
      insert("knowledge_replies", snapshot.replies); insert("knowledge_relations", snapshot.relations); insert("knowledge_history", snapshot.history); insert("knowledge_attachments", snapshot.attachments);
      insert("knowledge_import_sources", snapshot.importSources);
    }).immediate();
  }

  listProjects(): Project[] {
    const rows = this.database.prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE").all() as ProjectRow[];
    return rows.map(mapProject);
  }

  getProject(id: string): Project | null {
    const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
  }

  addProject(input: ProjectRegistration): Project {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO projects (
          id, name, repository_path, port, launch_preset, executable, args_json,
          healthcheck_path, startup_timeout_ms, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '/', 45000, ?, ?)
      `).run(id, input.name, input.repositoryPath, input.port, input.launchPreset ?? "auto", input.executable, JSON.stringify(input.args), now, now);
      this.audit(id, "project.created", "local-user", {
        repositoryPath: input.repositoryPath,
        port: input.port,
        launchPreset: input.launchPreset ?? "auto",
        executable: input.executable,
        args: input.args,
      });
    })();
    return this.getProject(id)!;
  }

  removeProject(projectId: string, actor: string): void {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Nie znaleziono projektu.");
    const now = new Date().toISOString();
    this.database.transaction(() => {
      const cancellationRequestedAttempts = this.database.prepare(`
        UPDATE remote_verification_attempts
        SET phase = 'cancel_requested', version = version + 1, last_reported_at = ?
        WHERE phase IN ('assigned', 'preparing', 'running', 'uncertain') AND EXISTS (
          SELECT 1 FROM remote_worker_project_grants grant
          JOIN remote_verification_requests request ON request.id = remote_verification_attempts.request_id
          WHERE grant.worker_id = remote_verification_attempts.worker_id
            AND grant.project_id = request.project_id
            AND grant.local_project_id = ?
        )
      `).run(now, projectId).changes;
      const cancelledRemoteRequests = this.database.prepare(`
        UPDATE remote_verification_requests
        SET phase = 'cancelled', updated_at = ?
        WHERE phase = 'pending' AND EXISTS (
          SELECT 1 FROM remote_worker_project_grants grant
          WHERE grant.worker_id = remote_verification_requests.worker_id
            AND grant.project_id = remote_verification_requests.project_id
            AND grant.local_project_id = ?
        )
      `).run(now, projectId).changes;
      this.database.prepare(`
        INSERT INTO controller_audit_events(event_type, actor, details_json, created_at)
        VALUES ('project.removed', ?, ?, ?)
      `).run(actor, JSON.stringify({
        projectId: project.id,
        name: project.name,
        repositoryPath: project.repositoryPath,
        port: project.port,
        cancelledRemoteRequests,
        cancellationRequestedAttempts,
      }), now);
      this.database.prepare(`
        UPDATE knowledge_project_runtime_links
        SET runtime_project_id = NULL, unlinked_at = ?
        WHERE runtime_project_id = ?
      `).run(now, projectId);
      const result = this.database.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
      if (result.changes === 0) throw new Error("Nie znaleziono projektu.");
    })();
  }

  updateProjectLaunch(projectId: string, input: {
    tlsMode: "off" | "generated" | "custom";
    tlsKeyPath: string | null;
    tlsCertPath: string | null;
    tlsCaPath: string | null;
    executable: string;
    args: string[];
  }): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE projects SET
          tls_mode = ?, tls_key_path = ?, tls_cert_path = ?, tls_ca_path = ?,
          executable = ?, args_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.tlsMode,
        input.tlsKeyPath,
        input.tlsCertPath,
        input.tlsCaPath,
        input.executable,
        JSON.stringify(input.args),
        now,
        projectId,
      );
      if (result.changes === 0) throw new Error("Nie znaleziono projektu.");
      this.audit(projectId, "project.launch_updated", "local-user", input);
    })();
  }

  updateProjectEnvironment(projectId: string, environment: Record<string, string>, actor: string): void {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Nie znaleziono projektu.");
    this.saveProjectEnvironmentProfile(projectId, { name: project.selectedEnvironmentProfile, environment }, actor);
  }

  saveProjectEnvironmentProfile(projectId: string, profile: Project["environmentProfiles"][number], actor: string): void {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Nie znaleziono projektu.");
    const profiles = [...project.environmentProfiles.filter(({ name }) => name !== profile.name), profile]
      .sort((left, right) => left.name.localeCompare(right.name));
    const environment = project.selectedEnvironmentProfile === profile.name ? profile.environment : project.environment;
    this.persistEnvironmentProfiles(projectId, profiles, project.selectedEnvironmentProfile, environment, actor, "project.environment_profile_saved", profile.name, Object.keys(profile.environment));
  }

  deleteProjectEnvironmentProfile(projectId: string, profileName: string, actor: string): void {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Nie znaleziono projektu.");
    const profiles = project.environmentProfiles.filter(({ name }) => name !== profileName);
    this.persistEnvironmentProfiles(projectId, profiles, project.selectedEnvironmentProfile, project.environment, actor, "project.environment_profile_deleted", profileName, []);
  }

  selectProjectEnvironmentProfile(projectId: string, profileName: string, actor: string): void {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Nie znaleziono projektu.");
    const profile = project.environmentProfiles.find(({ name }) => name === profileName);
    if (!profile) throw new Error("Nie znaleziono profilu środowiska.");
    this.persistEnvironmentProfiles(projectId, project.environmentProfiles, profileName, profile.environment, actor, "project.environment_profile_selected", profileName, Object.keys(profile.environment));
  }

  saveProjectTestEnvironmentProfile(projectId: string, profile: TestEnvironmentProfile, actor: string): void {
    const project = this.requireProjectRow(projectId);
    const profiles = [...project.testEnvironmentProfiles.filter(({ name }) => name !== profile.name), profile]
      .sort((left, right) => left.name.localeCompare(right.name));
    this.persistTestEnvironment(projectId, profiles, project.testPresetProfiles, actor, "project.test_profile_saved", {
      profileName: profile.name,
      mode: profile.policy.mode,
      serverProfile: profile.policy.serverProfile,
      nodeEnv: profile.nodeEnv,
      variableNames: Object.keys(profile.environment).sort(),
    });
  }

  deleteProjectTestEnvironmentProfile(projectId: string, profileName: string, actor: string): void {
    const project = this.requireProjectRow(projectId);
    const profiles = project.testEnvironmentProfiles.filter(({ name }) => name !== profileName);
    this.persistTestEnvironment(projectId, profiles, project.testPresetProfiles, actor, "project.test_profile_deleted", { profileName });
  }

  assignProjectTestPresetProfile(projectId: string, presetId: string, profileName: string | null, actor: string): void {
    const project = this.requireProjectRow(projectId);
    const assignments = { ...project.testPresetProfiles };
    if (profileName) assignments[presetId] = profileName;
    else delete assignments[presetId];
    this.persistTestEnvironment(projectId, project.testEnvironmentProfiles, assignments, actor, "project.test_preset_profile_assigned", { presetId, profileName });
  }

  private persistTestEnvironment(
    projectId: string,
    profiles: TestEnvironmentProfile[],
    presetProfiles: Record<string, string>,
    actor: string,
    eventType: string,
    details: Record<string, unknown>,
  ): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE projects SET test_environment_profiles_json = ?, test_preset_profiles_json = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(profiles), JSON.stringify(presetProfiles), now, projectId);
      if (result.changes === 0) throw new Error("Nie znaleziono projektu.");
      this.audit(projectId, eventType, actor, details);
    })();
  }

  private requireProjectRow(projectId: string): Project {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Nie znaleziono projektu.");
    return project;
  }

  private persistEnvironmentProfiles(
    projectId: string,
    profiles: Project["environmentProfiles"],
    selectedProfile: string,
    environment: Record<string, string>,
    actor: string,
    eventType: string,
    profileName: string,
    variableNames: string[],
  ): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE projects SET environment_profiles_json = ?, selected_environment_profile = ?,
          environment_json = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(profiles), selectedProfile, JSON.stringify(environment), now, projectId);
      if (result.changes === 0) throw new Error("Nie znaleziono projektu.");
      this.audit(projectId, eventType, actor, { profileName, variableNames: variableNames.sort() });
    })();
  }

  setSelectedWorktree(projectId: string, path: string): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      const result = this.database.prepare(
        "UPDATE projects SET selected_worktree_path = ?, updated_at = ? WHERE id = ?",
      ).run(path, now, projectId);
      if (result.changes === 0) throw new Error("Nie znaleziono projektu.");
      this.audit(projectId, "worktree.selected", "local-user", { path });
    })();
  }

  getAuthenticationPolicy(): AuthenticationPolicy {
    return this.authentication.getAuthenticationPolicy();
  }

  saveAuthenticationPolicy(policy: AuthenticationPolicy, event: string, actor: string): void {
    this.authentication.saveAuthenticationPolicy(policy, event, actor);
  }

  getServerCapacitySettings(): ServerCapacitySettings {
    const row = this.database.prepare("SELECT value_json FROM controller_settings WHERE key = 'server_capacity'")
      .get() as { value_json: string } | undefined;
    if (!row) return { enabled: false, limit: 2 };
    const value = JSON.parse(row.value_json) as Partial<ServerCapacitySettings>;
    return {
      enabled: value.enabled === true,
      limit: Number.isInteger(value.limit) && value.limit! >= 1 && value.limit! <= 64 ? value.limit! : 2,
    };
  }

  setServerCapacitySettings(settings: ServerCapacitySettings): void {
    this.database.transaction(() => {
      const now = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO controller_settings(key, value_json, updated_at)
        VALUES ('server_capacity', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(JSON.stringify(settings), now);
      this.database.prepare(`
        INSERT INTO controller_audit_events(event_type, actor, details_json, created_at)
        VALUES ('server_capacity.updated', 'local-user', ?, ?)
      `).run(JSON.stringify(settings), now);
    })();
  }

  getTestQueueSettings(): TestQueueSettings {
    const row = this.database.prepare("SELECT value_json FROM controller_settings WHERE key = 'test_queue'")
      .get() as { value_json: string } | undefined;
    if (!row) return { limit: 1 };
    const value = JSON.parse(row.value_json) as Partial<TestQueueSettings>;
    return { limit: Number.isInteger(value.limit) && value.limit! >= 1 && value.limit! <= 16 ? value.limit! : 1 };
  }

  setTestQueueSettings(settings: TestQueueSettings): void {
    this.database.transaction(() => {
      const now = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO controller_settings(key, value_json, updated_at)
        VALUES ('test_queue', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(JSON.stringify(settings), now);
      this.database.prepare(`
        INSERT INTO controller_audit_events(event_type, actor, details_json, created_at)
        VALUES ('test_queue.updated', 'local-user', ?, ?)
      `).run(JSON.stringify(settings), now);
    })();
  }

  countTestRuns(phases: TestRunPhase[], projectId?: string, worktreePath?: string): number {
    return this.testRuns.countTestRuns(phases, projectId, worktreePath);
  }

  listPendingTestRuns(): PendingTestRun[] {
    return this.testRuns.listPendingTestRuns();
  }

  listTestRuns(projectId?: string, limit = 50): TestRun[] {
    return this.testRuns.listTestRuns(projectId, limit);
  }

  hasTestRun(id: string): boolean {
    return this.testRuns.hasTestRun(id);
  }

  getTestRun(id: string): TestRun | null {
    return this.testRuns.getTestRun(id);
  }

  getTestRunStatus(id: string): TestRunStatusRecord | null {
    return this.testRuns.getTestRunStatus(id);
  }

  findTestRunByIdempotency(actor: string, idempotencyKey: string): TestRun | null {
    return this.testRuns.findTestRunByIdempotency(actor, idempotencyKey);
  }

  saveTestRun(run: TestRun, idempotencyKey?: string): void {
    return this.testRuns.saveTestRun(run, idempotencyKey);
  }

  markInterruptedTestRuns(): void {
    return this.testRuns.markInterruptedTestRuns();
  }

  getRemotePrincipal(id: string): RemotePrincipal | null {
    return this.identity.getPrincipal(id);
  }

  saveRemotePrincipal(principal: RemotePrincipal, actor: string): void {
    this.identity.savePrincipal(principal, actor);
  }

  getPrincipal(id: string): Principal | null {
    return this.identity.getPrincipal(id);
  }

  getOwnerPrincipal(): Principal | null {
    return this.identity.getOwnerPrincipal();
  }

  listPrincipals(kind?: Principal["kind"]): Principal[] {
    return this.identity.listPrincipals(kind);
  }

  savePrincipal(principal: Principal, actor: string): void {
    this.identity.savePrincipal(principal, actor);
  }

  getCredentialForAuthentication(id: string): CredentialAuthenticationRecord | null {
    return this.identity.getCredentialForAuthentication(id);
  }

  saveCredential(credential: CredentialAuthenticationRecord, actor: string): void {
    this.identity.saveCredential(credential, actor);
  }

  createFirstOwner(principal: Principal, credential: CredentialAuthenticationRecord, actor: string): boolean {
    return this.identity.createFirstOwner(principal, credential, actor);
  }

  listPrincipalCredentials(principalId: string): PrincipalCredential[] {
    return this.identity.listPrincipalCredentials(principalId);
  }

  revokeCredential(id: string, revokedAt: string, actor: string): boolean {
    return this.identity.revokeCredential(id, revokedAt, actor);
  }

  recordCredentialUsed(id: string, usedAt: string): void {
    this.identity.recordCredentialUsed(id, usedAt);
  }

  getKnowledgeProject(id: string): KnowledgeProject | null {
    return this.identity.getKnowledgeProject(id);
  }

  saveKnowledgeProject(project: KnowledgeProject, actor: string): void {
    this.identity.saveKnowledgeProject(project, actor);
  }

  getKnowledgeProjectGrant(principalId: string, projectId: string): KnowledgeProjectGrant | null {
    return this.identity.getKnowledgeProjectGrant(principalId, projectId);
  }

  listKnowledgeProjectGrants(principalId: string): KnowledgeProjectGrant[] {
    return this.identity.listKnowledgeProjectGrants(principalId);
  }

  saveKnowledgeProjectGrant(grant: KnowledgeProjectGrant, actor: string): void {
    this.identity.saveKnowledgeProjectGrant(grant, actor);
  }

  getKnowledgeProjectRuntimeLink(projectId: string): KnowledgeProjectRuntimeLink | null {
    return this.identity.getKnowledgeProjectRuntimeLink(projectId);
  }

  saveKnowledgeProjectRuntimeLink(link: KnowledgeProjectRuntimeLink, actor: string): void {
    this.identity.saveKnowledgeProjectRuntimeLink(link, actor);
  }

  findIdempotentResult<T>(operation: string, context: KnowledgeMutationContext): KnowledgeMutationResult<T> | null {
    return this.knowledge.findIdempotentResult<T>(operation, context);
  }

  hasRuntimeProject(id: string): boolean {
    return this.knowledge.hasRuntimeProject(id);
  }

  getRuntimeLinkOwner(runtimeProjectId: string): string | null {
    return this.knowledge.getRuntimeLinkOwner(runtimeProjectId);
  }


  getMemory(projectId: string, id: string): KnowledgeMemory | null { return this.knowledge.getMemory(projectId, id); }
  getReply(projectId: string, id: string): KnowledgeReply | null { return this.knowledge.getReply(projectId, id); }
  listMemories(projectId: string, limit: number, offset: number, query: string, includeInactive: boolean, taskId?: string): KnowledgePage<KnowledgeMemory> {
    return this.knowledge.listMemories(projectId, limit, offset, query, includeInactive, taskId);
  }
  saveMemory(memory: KnowledgeMemory, expectedRevision: number | null, operation: string, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeMemory> {
    return this.knowledge.saveMemory(memory, expectedRevision, operation, context);
  }
  searchKnowledge(projectId: string, limit: number, offset: number, options: KnowledgeSearchOptions): KnowledgePage<KnowledgeSearchHit> {
    return this.knowledge.searchKnowledge(projectId, limit, offset, options);
  }
  saveAttachment(value: KnowledgeAttachment, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeAttachment> { return this.knowledge.saveAttachment(value, context); }
  getAttachment(projectId: string, id: string): KnowledgeAttachment | null { return this.knowledge.getAttachment(projectId, id); }
  listAttachments(projectId: string, recordKind: KnowledgeAttachment["recordKind"], recordId: string, limit: number, offset: number): KnowledgePage<KnowledgeAttachment> { return this.knowledge.listAttachments(projectId, recordKind, recordId,limit,offset); }
  attachmentBytesForProject(projectId: string): number { return this.knowledge.attachmentBytesForProject(projectId); }
  attachmentCountForProject(projectId: string): number { return this.knowledge.attachmentCountForProject(projectId); }
  attachmentTargetExists(projectId: string, kind: KnowledgeAttachment["recordKind"], id: string): boolean { return this.knowledge.attachmentTargetExists(projectId,kind,id); }

  listKnowledgeProjects(principalId: string | null, limit: number, offset: number): KnowledgePage<KnowledgeProjectSummary> {
    return this.knowledge.listKnowledgeProjects(principalId, limit, offset);
  }

  createTask(task: KnowledgeTask, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeTask> {
    return this.knowledge.createTask(task, context);
  }

  listThreads(projectId: string, limit: number, offset: number, filters?: KnowledgeFilters): KnowledgePage<KnowledgeThread> {
    return this.knowledge.listThreads(projectId, limit, offset, filters);
  }

  getThread(projectId: string, id: string): KnowledgeThread | null {
    return this.knowledge.getThread(projectId, id);
  }

  listReplies(projectId: string, threadId: string, limit: number, offset: number, targetReplyId?: string): KnowledgeReplyPage {
    return this.knowledge.listReplies(projectId, threadId, limit, offset, targetReplyId);
  }

  listRelations(projectId: string, recordKind: KnowledgeRelation["sourceKind"], recordId: string, limit: number, offset: number): KnowledgePage<KnowledgeRelation> {
    return this.knowledge.listRelations(projectId, recordKind, recordId, limit, offset);
  }

  relationDestinations(projectId: string, endpoints: Array<{kind: KnowledgeRelation["sourceKind"]; id: string}>): Array<KnowledgeRelationDestination | null> {
    return this.knowledge.relationDestinations(projectId, endpoints);
  }

  getTask(projectId: string, id: string): KnowledgeTask | null {
    return this.knowledge.getTask(projectId, id);
  }

  listTasks(projectId: string, limit: number, offset: number, filters?: KnowledgeFilters): KnowledgeTaskPage<KnowledgeTask> {
    return this.knowledge.listTasks(projectId, limit, offset, filters);
  }

  listHistory(projectId: string, recordKind: KnowledgeHistoryEntry["recordKind"], recordId: string, limit: number, offset: number, includeComparison = false): KnowledgePage<KnowledgeHistoryEntry> {
    return this.knowledge.listHistory(projectId, recordKind, recordId, limit, offset, includeComparison);
  }

  createThread(thread: KnowledgeThread, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeThread> {
    return this.knowledge.createThread(thread, context);
  }

  createReply(reply: KnowledgeReply, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeReply> {
    return this.knowledge.createReply(reply, context);
  }

  createTaskFromThread(task: KnowledgeTask, relation: KnowledgeRelation, context: KnowledgeMutationContext): KnowledgeMutationResult<{ task: KnowledgeTask; relation: KnowledgeRelation }> {
    return this.knowledge.createTaskFromThread(task, relation, context);
  }

  updateTask(task: KnowledgeTask, expectedRevision: number, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeTask> {
    return this.knowledge.updateTask(task, expectedRevision, context);
  }

  updateKnowledgeProject(project: KnowledgeProject, expectedRevision: number, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeProject> {
    return this.knowledge.updateKnowledgeProject(project, expectedRevision, context);
  }

  setKnowledgeProjectRuntimeLink(link: KnowledgeProjectRuntimeLink, expectedRevision: number, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeRuntimeLinkResult> {
    return this.knowledge.setKnowledgeProjectRuntimeLink(link, expectedRevision, context);
  }

  getRemoteProjectIdentity(id: string): RemoteProjectIdentity | null {
    return this.remoteVerification.getRemoteProjectIdentity(id);
  }

  saveRemoteProjectIdentity(project: RemoteProjectIdentity, actor: string): void {
    this.remoteVerification.saveRemoteProjectIdentity(project, actor);
  }

  getRemoteWorker(id: string): RemoteWorkerRegistration | null {
    return this.remoteVerification.getRemoteWorker(id);
  }

  saveRemoteWorker(worker: RemoteWorkerRegistration, actor: string): void {
    this.remoteVerification.saveRemoteWorker(worker, actor);
  }

  getRemotePrincipalProjectGrant(principalId: string, projectId: string): RemotePrincipalProjectGrant | null {
    return this.remoteVerification.getRemotePrincipalProjectGrant(principalId, projectId);
  }

  saveRemotePrincipalProjectGrant(grant: RemotePrincipalProjectGrant, actor: string): void {
    this.remoteVerification.saveRemotePrincipalProjectGrant(grant, actor);
  }

  getRemoteWorkerProjectGrant(workerId: string, projectId: string): RemoteWorkerProjectGrant | null {
    return this.remoteVerification.getRemoteWorkerProjectGrant(workerId, projectId);
  }

  saveRemoteWorkerProjectGrant(grant: RemoteWorkerProjectGrant, actor: string): void {
    this.remoteVerification.saveRemoteWorkerProjectGrant(grant, actor);
  }

  findRemoteVerificationRequestByIdempotency(principalId: string, idempotencyKey: string): RemoteVerificationRequest | null {
    return this.remoteVerification.findRemoteVerificationRequestByIdempotency(principalId, idempotencyKey);
  }

  createOrReplayRemoteVerificationRequest(request: RemoteVerificationRequest): RemoteVerificationRequest {
    return this.remoteVerification.createOrReplayRemoteVerificationRequest(request);
  }

  getRemoteVerificationRequest(id: string): RemoteVerificationRequest | null {
    return this.remoteVerification.getRemoteVerificationRequest(id);
  }

  getRemoteVerificationAttempt(id: string): RemoteVerificationAttempt | null {
    return this.remoteVerification.getRemoteVerificationAttempt(id);
  }

  findRemoteVerificationAttemptForRequest(requestId: string): RemoteVerificationAttempt | null {
    return this.remoteVerification.findRemoteVerificationAttemptForRequest(requestId);
  }

  createOrReplayRemoteVerificationAttempt(attempt: RemoteVerificationAttempt): RemoteVerificationAttempt | null {
    return this.remoteVerification.createOrReplayRemoteVerificationAttempt(attempt);
  }

  updateRemoteVerificationAttempt(
    attempt: RemoteVerificationAttempt,
    expectedVersion: number,
    requestPhase: RemoteVerificationRequestPhase,
  ): boolean {
    return this.remoteVerification.updateRemoteVerificationAttempt(attempt, expectedVersion, requestPhase);
  }

  markRemoteVerificationAttemptsUncertain(observedAt: string): number {
    return this.remoteVerification.markRemoteVerificationAttemptsUncertain(observedAt);
  }

  getWorktreeStorage(projectId: string, worktreePath: string): WorktreeStorageSnapshot | null {
    return this.storage.getWorktreeStorage(projectId, worktreePath);
  }

  saveWorktreeStorage(sample: WorktreeStorageSample): void {
    return this.storage.saveWorktreeStorage(sample);
  }

  recordProjectEvent(projectId: string, eventType: string, actor: string, details: unknown): void {
    this.audit(projectId, eventType, actor, details);
  }

  listWorktreeLaunches(projectId: string): Record<string, string> {
    // Audit retention is bounded here; absent evidence is unknown, never "never run".
    const rows = this.database.prepare(`
      SELECT details_json, created_at FROM audit_events
      WHERE project_id = ? AND event_type = 'worktree.launched'
      ORDER BY id DESC LIMIT 2000
    `).all(projectId) as Array<{ details_json: string; created_at: string }>;
    const launches: Record<string, string> = Object.create(null);
    for (const row of rows) {
      const details = JSON.parse(row.details_json) as { worktreePath?: string };
      if (typeof details.worktreePath === "string" && !launches[details.worktreePath]) launches[details.worktreePath] = row.created_at;
    }
    return launches;
  }

  getActiveReservation(projectId: string): Reservation | null {
    this.expireReservations(projectId);
    const row = this.database.prepare(`
      SELECT id, project_id, worktree_path, kind, owner, reason, created_at, expires_at,
             maximum_expires_at, token_hash, idempotency_key, released_at
      FROM reservations WHERE project_id = ? AND released_at IS NULL
    `).get(projectId) as ReservationRow | undefined;
    return row ? mapReservation(row) : null;
  }

  getEffectiveReservation(projectId: string, observedAt: string): Reservation | null {
    const row = this.database.prepare(`
      SELECT id, project_id, worktree_path, kind, owner, reason, created_at, expires_at,
             maximum_expires_at, token_hash, idempotency_key, released_at
      FROM reservations
      WHERE project_id = ? AND released_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
    `).get(projectId, observedAt) as ReservationRow | undefined;
    return row ? mapReservation(row) : null;
  }

  acquireReservation(input: ReservationRequest): Reservation {
    return this.database.transaction(() => {
      this.expireReservations(input.projectId);
      if (input.kind === "agent") {
        if (!input.ttlSeconds || input.ttlSeconds < 30) {
          throw new Error("Dzierżawa agenta musi trwać co najmniej 30 sekund.");
        }
        if (!input.maximumLifetimeSeconds || input.maximumLifetimeSeconds < input.ttlSeconds) {
          throw new Error("Maksymalny czas dzierżawy nie może być krótszy od jej czasu początkowego.");
        }
        if (!input.leaseTokenHash || !input.idempotencyKey) {
          throw new Error("Dzierżawa agenta wymaga tokenu i klucza idempotencji.");
        }
        const repeated = this.database.prepare(`
          SELECT id, project_id, worktree_path, kind, owner, reason, created_at, expires_at,
                 maximum_expires_at, token_hash, idempotency_key, released_at
          FROM reservations
          WHERE owner = ? AND idempotency_key = ? AND kind = 'agent' AND released_at IS NULL
        `).get(input.owner, input.idempotencyKey) as ReservationRow | undefined;
        if (repeated) {
          if (
            repeated.project_id !== input.projectId
            || repeated.worktree_path !== input.worktreePath
            || !equalHash(repeated.token_hash, input.leaseTokenHash)
          ) {
            throw new Error("Klucz idempotencji jest już używany przez inną dzierżawę.");
          }
          return mapReservation(repeated);
        }
      }
      const active = this.getActiveReservation(input.projectId);
      if (active) throw new Error(`Projekt jest zablokowany przez ${active.owner}.`);
      const createdAt = new Date().toISOString();
      const expiresAt = input.kind === "agent"
        ? new Date(Date.now() + input.ttlSeconds! * 1000).toISOString()
        : null;
      const maximumExpiresAt = input.kind === "agent"
        ? new Date(Date.now() + input.maximumLifetimeSeconds! * 1000).toISOString()
        : null;
      const reservation: Reservation = {
        id: randomUUID(),
        projectId: input.projectId,
        worktreePath: input.worktreePath,
        kind: input.kind,
        owner: input.owner,
        reason: input.reason ?? null,
        createdAt,
        expiresAt,
        maximumExpiresAt,
      };
      this.database.prepare(`
        INSERT INTO reservations (
          id, project_id, worktree_path, kind, owner, reason, created_at, expires_at,
          maximum_expires_at, token_hash, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reservation.id,
        reservation.projectId,
        reservation.worktreePath,
        reservation.kind,
        reservation.owner,
        reservation.reason,
        reservation.createdAt,
        reservation.expiresAt,
        reservation.maximumExpiresAt,
        input.leaseTokenHash ?? null,
        input.idempotencyKey ?? null,
      );
      this.audit(input.projectId, "reservation.acquired", input.owner, reservation);
      return reservation;
    })();
  }

  authorizeReservation(projectId: string, owner: string, leaseTokenHash?: string): Reservation | null {
    const reservation = this.getActiveReservation(projectId);
    if (!reservation) return null;
    const row = this.activeReservationRow(projectId)!;
    if (reservation.owner !== owner) throw new Error(`Projekt jest zablokowany przez ${reservation.owner}.`);
    if (reservation.kind === "agent" && (!leaseTokenHash || !equalHash(row.token_hash, leaseTokenHash))) {
      throw new Error("Nieprawidłowy token dzierżawy agenta.");
    }
    return reservation;
  }

  renewAgentReservation(
    projectId: string,
    reservationId: string,
    owner: string,
    leaseTokenHash: string,
    ttlSeconds: number,
  ): Reservation {
    return this.database.transaction(() => {
      if (ttlSeconds < 30) throw new Error("Dzierżawa agenta musi trwać co najmniej 30 sekund.");
      this.expireReservations(projectId);
      const row = this.activeReservationRow(projectId);
      if (!row || row.id !== reservationId) throw new Error("Dzierżawa agenta wygasła lub nie istnieje.");
      if (row.kind !== "agent" || row.owner !== owner || !equalHash(row.token_hash, leaseTokenHash)) {
        throw new Error("Nieprawidłowy token dzierżawy agenta.");
      }
      const maximum = new Date(row.maximum_expires_at!).getTime();
      const expiresAt = new Date(Math.min(Date.now() + ttlSeconds * 1000, maximum)).toISOString();
      if (new Date(expiresAt).getTime() <= Date.now()) throw new Error("Dzierżawa agenta osiągnęła maksymalny czas życia.");
      this.database.prepare("UPDATE reservations SET expires_at = ? WHERE id = ?").run(expiresAt, row.id);
      this.audit(projectId, "reservation.renewed", owner, { id: row.id, expiresAt });
      return { ...mapReservation(row), expiresAt };
    })();
  }

  releaseAgentReservation(projectId: string, reservationId: string, owner: string, leaseTokenHash: string): void {
    this.database.transaction(() => {
      this.expireReservations(projectId);
      const row = this.activeReservationRow(projectId);
      if (!row || row.id !== reservationId) return;
      if (row.kind !== "agent" || row.owner !== owner || !equalHash(row.token_hash, leaseTokenHash)) {
        throw new Error("Nieprawidłowy token dzierżawy agenta.");
      }
      this.releaseRow(row, owner, false);
    })();
  }

  releaseReservation(projectId: string, owner: string, force = false): void {
    this.database.transaction(() => {
      this.expireReservations(projectId);
      const active = this.getActiveReservation(projectId);
      if (!active) return;
      if (!force && active.kind === "agent") throw new Error("Dzierżawę agenta może zdjąć tylko jej właściciel lub człowiek przez force release.");
      if (!force && active.owner !== owner) throw new Error("Tylko właściciel może zdjąć tę blokadę.");
      const row = this.activeReservationRow(projectId)!;
      this.releaseRow(row, owner, force);
    })();
  }

  close(): void {
    this.ownedDatabase.close();
  }

  private expireReservations(projectId: string): void {
    this.database.transaction(() => {
      const now = new Date().toISOString();
      const expired = this.database.prepare(`
        SELECT id, project_id, worktree_path, kind, owner, reason, created_at, expires_at,
               maximum_expires_at, token_hash, idempotency_key, released_at
        FROM reservations
        WHERE project_id = ? AND released_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?
      `).all(projectId, now) as ReservationRow[];
      for (const row of expired) {
        this.database.prepare(`
          UPDATE reservations SET released_at = ?, released_by = 'system:expiry' WHERE id = ?
        `).run(now, row.id);
        this.audit(projectId, "reservation.expired", "system:expiry", { id: row.id });
      }
    })();
  }

  private activeReservationRow(projectId: string): ReservationRow | undefined {
    return this.database.prepare(`
      SELECT id, project_id, worktree_path, kind, owner, reason, created_at, expires_at,
             maximum_expires_at, token_hash, idempotency_key, released_at
      FROM reservations WHERE project_id = ? AND released_at IS NULL
    `).get(projectId) as ReservationRow | undefined;
  }

  private releaseRow(row: ReservationRow, owner: string, force: boolean): void {
    this.database.prepare(`
      UPDATE reservations SET released_at = ?, released_by = ? WHERE id = ?
    `).run(new Date().toISOString(), owner, row.id);
    this.audit(row.project_id, force ? "reservation.force_released" : "reservation.released", owner, { id: row.id });
  }

  private audit(projectId: string, eventType: string, actor: string, details: unknown): void {
    this.database.prepare(`
      INSERT INTO audit_events(project_id, event_type, actor, details_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(projectId, eventType, actor, JSON.stringify(details), new Date().toISOString());
  }
}
