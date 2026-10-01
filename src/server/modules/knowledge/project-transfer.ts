import { createHash } from "node:crypto";
import { constants, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { AuthenticatedPrincipal, IdentityService } from "@/server/modules/identity";
import type { KnowledgeProjectExportManifest, KnowledgeProjectSnapshot } from "./contracts";
import { KnowledgeError } from "./knowledge-error";
import { publishKnowledgeAttachment } from "./durable-attachments";
import { parseKnowledgeProjectExportManifest, parseKnowledgeProjectSnapshot } from "./project-transfer-schema";

interface TransferStore {
  schemaVersion(): number;
  exportKnowledgeProject(projectId: string): KnowledgeProjectSnapshot | null;
  importKnowledgeProject(snapshot: KnowledgeProjectSnapshot): void;
}
const MAX_FILES = 1000, MAX_FILE_BYTES = 10 * 1024 * 1024, MAX_BYTES = 100 * 1024 * 1024, MAX_DATA_BYTES = 64 * 1024 * 1024, MAX_MANIFEST_BYTES = 1024 * 1024;
const hashData = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
function safe(root: string, file: string): string {
  const target=resolve(root,file), base=resolve(root); if(!file||file.startsWith(sep)||target===base||!target.startsWith(base+sep)) throw new KnowledgeError("invalid_request","Export contains an unsafe path.");
  let current=base; for(const part of target.slice(base.length+1).split(sep).slice(0,-1)){current=join(current,part); if(existsSync(current)&&lstatSync(current).isSymbolicLink()) throw new KnowledgeError("invalid_request","Export path contains a symlink.");}
  if(existsSync(base)&&(lstatSync(base).isSymbolicLink()||!lstatSync(base).isDirectory())) throw new KnowledgeError("invalid_request","Export root is unsafe."); return target;
}
function readRegular(path: string, maximum=MAX_FILE_BYTES): Buffer { const info=lstatSync(path); if(info.isSymbolicLink()||!info.isFile()||info.size>maximum) throw new KnowledgeError("limit_exceeded","Export contains an unsafe or oversized file."); const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW); try{return readFileSync(fd);} finally{closeSync(fd);} }
function canonical(value: unknown): string { if(Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if(value&&typeof value==="object") return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
function validateRelations(snapshot: KnowledgeProjectSnapshot): void {
  const ids:Record<string,Set<unknown>>={thread:new Set(snapshot.threads.map(row=>row.id)),reply:new Set(snapshot.replies.map(row=>row.id)),task:new Set(snapshot.tasks.map(row=>row.id)),memory:new Set(snapshot.memories.map(row=>row.id))};
  const relationIds=new Set(snapshot.relations.map(row=>row.id));
  for(const reply of snapshot.replies) if(!ids.thread.has(reply.thread_id)) throw new KnowledgeError("invalid_request","Reply references a missing thread.");
  for(const relation of snapshot.relations){const source=ids[String(relation.source_kind)],target=ids[String(relation.target_kind)]; if(!source?.has(relation.source_id)||!target?.has(relation.target_id)) throw new KnowledgeError("invalid_request","Relation references a missing record.");}
  for(const attachment of snapshot.attachments) if(!ids[String(attachment.record_kind)]?.has(attachment.record_id)) throw new KnowledgeError("invalid_request","Attachment references a missing record.");
  for(const memory of snapshot.memories){
    const sources=JSON.parse(String(memory.sources_json)) as Array<{kind?:unknown;id?:unknown}>; if(!Array.isArray(sources)) throw new KnowledgeError("invalid_request","Memory sources are invalid.");
    for(const source of sources) if(source.kind!=="external"&&source.kind!=="repository"&&!ids[String(source.kind)]?.has(source.id)) throw new KnowledgeError("invalid_request","Memory references a missing source.");
    if(memory.superseded_by_json){const replacement=JSON.parse(String(memory.superseded_by_json)) as {id?:unknown}; if(!ids.memory.has(replacement.id)) throw new KnowledgeError("invalid_request","Memory replacement is missing.");}
  }
  for(const entry of snapshot.history){const kind=String(entry.record_kind); if(kind==="project"?entry.record_id!==snapshot.project.id:kind==="relation"?!relationIds.has(entry.record_id):!ids[kind]?.has(entry.record_id)) throw new KnowledgeError("invalid_request","History references a missing record.");}
  const required=new Set<string>(); for(const rows of [snapshot.threads,snapshot.replies,snapshot.tasks,snapshot.memories,snapshot.relations,snapshot.attachments]) for(const row of rows) if(typeof row.created_by==="string") required.add(row.created_by);
  for(const entry of snapshot.history) if(typeof entry.principal_id==="string") required.add(entry.principal_id);
  for(const memory of snapshot.memories) if(memory.approval_json){const approval=JSON.parse(String(memory.approval_json)) as {principalId:string}; required.add(approval.principalId);}
  if(canonical([...required].sort())!==canonical([...new Set(snapshot.requiredPrincipals)].sort())) throw new KnowledgeError("invalid_request","Required principals do not match project authorship.");
}

export function exportKnowledgeProject(store: TransferStore, identity: Pick<IdentityService,"authorizeKnowledge">, projectId: string, destination: string,
  attachmentDirectory: string, actor: AuthenticatedPrincipal, options: {applicationVersion:string;clock?:()=>string}): KnowledgeProjectExportManifest {
  identity.authorizeKnowledge(actor,projectId,"knowledge:export",{allowArchived:true}); identity.authorizeKnowledge(actor,projectId,"attachments:read",{allowArchived:true});
  if(existsSync(destination)) throw new KnowledgeError("invalid_request","Export destination already exists.");
  const snapshot=store.exportKnowledgeProject(projectId); if(!snapshot) throw new KnowledgeError("not_found","Knowledge project not found.");
  if(snapshot.attachments.length>MAX_FILES||snapshot.attachments.some(item=>Number(item.size)>MAX_FILE_BYTES)||snapshot.attachments.reduce((sum,item)=>sum+Number(item.size),0)>MAX_BYTES) throw new KnowledgeError("limit_exceeded","Knowledge project exceeds attachment limits.");
  mkdirSync(dirname(destination),{recursive:true}); const staging=mkdtempSync(join(dirname(destination),`.${basename(destination)}.partial-`));
  try {
    const serialized=Buffer.from(canonical(snapshot)); const data={file:"project.json" as const,size:serialized.byteLength,sha256:hashData(serialized)};
    writeFileSync(join(staging,data.file),serialized,{mode:0o600});
    const unique=new Map<string,number>(); for(const row of snapshot.attachments){if(typeof row.sha256!=="string"||typeof row.size!=="number") throw new KnowledgeError("invalid_request","Invalid attachment metadata."); const previous=unique.get(row.sha256); if(previous!==undefined&&previous!==row.size) throw new KnowledgeError("invalid_request","Conflicting attachment metadata."); unique.set(row.sha256,row.size);}
    if(unique.size>MAX_FILES||[...unique.values()].reduce((a,b)=>a+b,0)>MAX_BYTES) throw new KnowledgeError("limit_exceeded","Project export exceeds attachment limits.");
    const attachments=[...unique].sort(([a],[b])=>a.localeCompare(b)).map(([sha256,size])=>{const file=join(sha256.slice(0,2),sha256), source=safe(attachmentDirectory,file), target=safe(join(staging,"attachments"),file); const bytes=readRegular(source); if(bytes.byteLength!==size||hashData(bytes)!==sha256) throw new KnowledgeError("invalid_request","Attachment integrity check failed."); mkdirSync(dirname(target),{recursive:true}); copyFileSync(source,target); return {file,size,sha256};});
    const counts=Object.fromEntries((["threads","replies","tasks","memories","relations","history","attachments","importSources"] as const).map(key=>[key,snapshot[key].length]));
    const manifest:KnowledgeProjectExportManifest={formatVersion:1,applicationVersion:options.applicationVersion,schemaVersion:store.schemaVersion(),createdAt:(options.clock??(()=>new Date().toISOString()))(),projectId,data,attachments,counts};
    writeFileSync(join(staging,"manifest.json"),JSON.stringify(manifest,null,2),{mode:0o600}); renameSync(staging,destination); return manifest;
  } catch(error){rmSync(staging,{recursive:true,force:true}); throw error;}
}

export function importKnowledgeProject(store: TransferStore, identity: Pick<IdentityService,"requireOwnerSession">, source: string, attachmentDirectory: string, actor: AuthenticatedPrincipal): KnowledgeProjectExportManifest {
  identity.requireOwnerSession(actor);
  let manifest:KnowledgeProjectExportManifest; try { manifest=parseKnowledgeProjectExportManifest(JSON.parse(readRegular(safe(source,"manifest.json"),MAX_MANIFEST_BYTES).toString("utf8"))); } catch(error) { if(error instanceof KnowledgeError) throw error; throw new KnowledgeError("invalid_request","Invalid knowledge export manifest."); }
  if(manifest.formatVersion!==1||manifest.schemaVersion>store.schemaVersion()) throw new KnowledgeError("invalid_request","Unsupported knowledge export version.");
  if(!manifest.data||manifest.data.file!=="project.json"||!Number.isSafeInteger(manifest.data.size)||manifest.data.size<1||manifest.data.size>MAX_DATA_BYTES||!/^[a-f0-9]{64}$/.test(manifest.data.sha256)) throw new KnowledgeError("invalid_request","Invalid knowledge export data manifest.");
  const dataPath=safe(source,manifest.data.file); if(lstatSync(dataPath).size!==manifest.data.size) throw new KnowledgeError("invalid_request","Knowledge export size does not match its manifest.");
  const dataBytes=readRegular(dataPath,MAX_DATA_BYTES); if(hashData(dataBytes)!==manifest.data.sha256) throw new KnowledgeError("invalid_request","Knowledge export integrity check failed.");
  let snapshot:KnowledgeProjectSnapshot; try { snapshot=parseKnowledgeProjectSnapshot(JSON.parse(dataBytes.toString("utf8"))); } catch { throw new KnowledgeError("invalid_request","Knowledge project snapshot is invalid."); } if(snapshot.project.id!==manifest.projectId) throw new KnowledgeError("invalid_request","Manifest project ID does not match the snapshot.");
  if(snapshot.project.status!=="active") throw new KnowledgeError("invalid_request","Archived knowledge projects cannot be imported.");
  const arrays=["threads","replies","tasks","memories","relations","history","attachments","importSources"] as const; for(const key of arrays) if(!Array.isArray(snapshot[key])||snapshot[key].length!==(manifest.counts[key]??0)) throw new KnowledgeError("invalid_request",`Knowledge export count mismatch: ${key}`);
  if(!Array.isArray(snapshot.requiredPrincipals)||snapshot.requiredPrincipals.some(id=>typeof id!=="string")) throw new KnowledgeError("invalid_request","Required principals are invalid."); validateRelations(snapshot);
  if(snapshot.attachments.length>MAX_FILES||snapshot.attachments.some(item=>Number(item.size)>MAX_FILE_BYTES)||snapshot.attachments.reduce((sum,item)=>sum+Number(item.size),0)>MAX_BYTES) throw new KnowledgeError("limit_exceeded","Knowledge import exceeds attachment limits.");
  if(!Array.isArray(manifest.attachments)||manifest.attachments.length>MAX_FILES||manifest.attachments.some(item=>!Number.isSafeInteger(item.size)||item.size<1||item.size>MAX_FILE_BYTES)) throw new KnowledgeError("limit_exceeded","Knowledge import object manifest exceeds attachment limits.");
  const declared=new Map(manifest.attachments.map(item=>[item.sha256,item.size])); const referenced=new Map(snapshot.attachments.map(item=>[String(item.sha256),Number(item.size)])); if(canonical([...declared].sort())!==canonical([...referenced].sort())) throw new KnowledgeError("invalid_request","Attachment manifest does not match project metadata.");
  if (snapshot.attachments.some(item => declared.get(String(item.sha256)) !== Number(item.size)))
    throw new KnowledgeError("invalid_request", "Conflicting attachment metadata in project snapshot.");
  for (const item of manifest.attachments) {
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || item.file !== join(item.sha256.slice(0,2), item.sha256))
      throw new KnowledgeError("invalid_request", "Invalid attachment manifest entry.");
    const sourcePath = safe(join(source, "attachments"), item.file);
    publishKnowledgeAttachment(attachmentDirectory, item, { path: sourcePath });
  }
  store.importKnowledgeProject(snapshot);
  return manifest;
}
