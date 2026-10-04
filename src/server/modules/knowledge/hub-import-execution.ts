import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import type { AuthenticatedPrincipal, AuthenticationMethod, IdentityService } from "@/server/modules/identity";
import { calculateHubImportPlanHash, planHubImport, type HubImportMapping, type HubImportPlan } from "./hub-import-plan";
import type { KnowledgeAttachmentLimits } from "@/shared/contracts/knowledge-attachments";
import { DEFAULT_ATTACHMENT_LIMITS, attachmentLimits, assertAttachmentCapacity } from "./attachment-policy";
import { KnowledgeError } from "./knowledge-error";

export type HubImportBatchStatus = "staging" | "published" | "failed";
/** Existing batches predate method attribution; their method cannot be inferred from the principal. */
export type HubImportAuthenticationMethod = AuthenticationMethod | "legacy_unknown";

export interface HubImportBatch {
  id: string;
  planId: string;
  planHash: string;
  sourceId: string;
  sourceRepository: string;
  sourceCommit: string;
  targetProjectId: string;
  targetProjectName: string;
  expectedTargetRevision: number | null;
  actorPrincipalId: string;
  authenticationMethod: HubImportAuthenticationMethod;
  status: HubImportBatchStatus;
  cursor: number;
  totalItems: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  error: string | null;
}

type NewHubImportBatch = Omit<HubImportBatch, "status" | "cursor" | "createdAt" | "updatedAt" | "publishedAt" | "error" | "authenticationMethod"> & {
  authenticationMethod: AuthenticationMethod;
};

export interface HubImportExecutionStore {
  beginHubImport(input: NewHubImportBatch, now: string): HubImportBatch;
  getHubImport(batchId: string): HubImportBatch | null;
  resetHubImport(batchId: string, expectedTargetRevision: number | null, now: string): HubImportBatch;
  stageHubImportChunk(batchId: string, expectedCursor: number, mappings: HubImportMapping[], now: string): HubImportBatch;
  publishHubImport(batchId: string, now: string, attachmentDirectory?: string, limits?: KnowledgeAttachmentLimits): HubImportBatch;
}

export interface ExecuteHubImportInput {
  plan: HubImportPlan;
  targetProjectId: string;
  targetProjectName: string;
  batchId?: string;
  chunkSize?: number;
  expectedTargetRevision?: number | null;
  attachmentDirectory?: string;
  limits?: KnowledgeAttachmentLimits;
}

function validate(input: ExecuteHubImportInput): void {
  if (input.plan.mappingVersion !== 2) throw new KnowledgeError("invalid_request", "Hub import plan uses an unsupported mapping version; create a fresh plan before reimporting.");
  if (!input.targetProjectId.trim() || input.targetProjectId.trim().length > 160) throw new KnowledgeError("invalid_request", "Target project ID is required and must not exceed 160 characters.");
  if (!input.targetProjectName.trim() || input.targetProjectName.trim().length > 120) throw new KnowledgeError("invalid_request", "Target project name is required and must not exceed 120 characters.");
  if (input.expectedTargetRevision !== undefined && input.expectedTargetRevision !== null && (!Number.isInteger(input.expectedTargetRevision) || input.expectedTargetRevision < 1)) throw new KnowledgeError("invalid_request", "Expected target revision must be positive.");
  if(!input.plan.source.sourceId.trim()||input.plan.source.sourceId!==input.plan.source.sourceId.trim()||input.plan.source.sourceId.length>160) throw new KnowledgeError("invalid_request","Import source ID must be normalized and must not exceed 160 characters.");
  if(input.plan.source.repository.length>4096||input.plan.mappings.some(mapping=>mapping.sourcePath.length>4096)) throw new KnowledgeError("invalid_request","Hub import source location exceeds logical snapshot limits.");
  if(input.plan.mappings.some(mapping=>mapping.legacyId!==null&&mapping.legacyId.length>160)) throw new KnowledgeError("invalid_request","Hub mapping legacy ID must not exceed 160 characters.");
  if (input.plan.guarantees.dataWritten !== false || !input.plan.validator.valid) throw new KnowledgeError("invalid_request", "Only a valid read-only Hub import plan can be executed.");
  if (calculateHubImportPlanHash(input.plan) !== input.plan.planHash || !input.plan.planId.endsWith(input.plan.planHash.slice(0, 16))) throw new KnowledgeError("revision_conflict", "Hub import plan hash does not match its contents.");
  const unsupported = input.plan.mappings.find(mapping => mapping.disposition === "mapped" && !["task", "memory", "historical_comment", "task_completion", "attachment"].includes(mapping.targetKind ?? ""));
  if (unsupported) throw new KnowledgeError("invalid_request", `Hub mapping is not executable yet: ${unsupported.targetKind ?? unsupported.sourceKind}.`);
  if(input.plan.mappings.some(mapping=>mapping.targetKind==="attachment")&&!input.attachmentDirectory) throw new KnowledgeError("invalid_request","Attachment directory is required for this Hub import.");
  if (input.plan.missing.some(item => item.blocking) || input.plan.conflicts.some(item => item.blocking) || input.plan.unresolvedRelations.some(item => item.blocking)) {
    throw new KnowledgeError("invalid_request", "Hub import plan contains blocking findings.");
  }
}

/** Durable K6b coordinator. Every call is resumable and stages at most chunkSize mappings. */
export function executeHubImport(
  store: HubImportExecutionStore,
  identity: Pick<IdentityService, "requireOwnerSession">,
  actor: AuthenticatedPrincipal,
  input: ExecuteHubImportInput,
  clock: () => string = () => new Date().toISOString(),
  verifyPlan: (plan: HubImportPlan) => HubImportPlan = plan => planHubImport({
    repository: plan.source.repository,
    commit: plan.source.commit,
    sourceId: plan.source.sourceId,
    validatorRepository: plan.validator.repository,
    limits: input.limits,
  }),
  readSourceFile: (plan: HubImportPlan, path: string) => Buffer = (plan,path) => {
    try{return execFileSync("git",["-C",plan.source.repository,"show",`${plan.source.commit}:${path}`],{encoding:null,maxBuffer:11*1024*1024});}
    catch{throw new KnowledgeError("invalid_request",`Unable to read approved import object: ${path}`);}
  },
): HubImportBatch {
  identity.requireOwnerSession(actor);
  validate(input);
  const limits = attachmentLimits(input.limits ?? DEFAULT_ATTACHMENT_LIMITS);
  const files = input.plan.mappings.filter(item => item.targetKind === "attachment");
  assertAttachmentCapacity(limits, { bytes: 0, files: 0 }, { bytes: files.reduce((sum, file) => sum + file.size, 0), files: files.length }, files.map(file => ({ filename: file.sourcePath, size: file.size })));
  const targetProjectId=input.targetProjectId.trim();
  const verified = verifyPlan(input.plan);
  if (verified.planId !== input.plan.planId || verified.planHash !== input.plan.planHash) throw new KnowledgeError("revision_conflict", "Import source no longer matches the approved plan.");
  const now = clock();
  const stableId = `hub-import:${createHash("sha256").update(`${input.plan.planId}\0${targetProjectId}`).digest("hex").slice(0, 24)}`;
  let batch = store.beginHubImport({
    id: input.batchId ?? stableId,
    planId: input.plan.planId,
    planHash: input.plan.planHash,
    sourceId: input.plan.source.sourceId,
    sourceRepository: input.plan.source.repository,
    sourceCommit: input.plan.source.commit,
    targetProjectId,
    targetProjectName: input.targetProjectName.trim(),
    expectedTargetRevision: input.expectedTargetRevision ?? null,
    actorPrincipalId: actor.principalId,
    authenticationMethod: actor.authenticationMethod,
    totalItems: input.plan.mappings.length,
  }, now);
  // A retry can use a different current credential; the batch keeps its creation method.
  if (batch.planId !== input.plan.planId || batch.planHash !== input.plan.planHash || batch.sourceId !== input.plan.source.sourceId || batch.sourceRepository !== input.plan.source.repository || batch.sourceCommit !== input.plan.source.commit
    || batch.targetProjectId !== targetProjectId || batch.targetProjectName !== input.targetProjectName.trim() || batch.actorPrincipalId !== actor.principalId || batch.totalItems !== input.plan.mappings.length) {
    throw new KnowledgeError("revision_conflict", "Stored import batch does not match the supplied plan.");
  }
  const expectedTargetRevision=input.expectedTargetRevision ?? null;
  if (batch.status === "published") {
    if(batch.expectedTargetRevision!==expectedTargetRevision) throw new KnowledgeError("revision_conflict", "Stored import batch does not match the supplied plan.");
    return batch;
  }
  if (batch.status === "failed") batch=store.resetHubImport(batch.id,expectedTargetRevision,clock());
  else if(batch.expectedTargetRevision!==expectedTargetRevision) throw new KnowledgeError("revision_conflict", "Stored import batch does not match the supplied plan.");
  if (batch.status !== "staging") throw new KnowledgeError("invalid_request", "Import batch cannot be resumed.");
  const size = Math.max(1, Math.min(input.chunkSize ?? 100, 500));
  const mappings = input.plan.mappings.slice(batch.cursor, batch.cursor + size).map(mapping=>{
    if(mapping.targetKind!=="attachment") return mapping; const bytes=readSourceFile(input.plan,mapping.sourcePath);
    if(bytes.byteLength!==mapping.size||createHash("sha256").update(bytes).digest("hex")!==mapping.sourceSha256) throw new KnowledgeError("revision_conflict",`Import attachment no longer matches the approved plan: ${mapping.sourcePath}`);
    return {...mapping,originalPayload:{fileName:mapping.sourcePath.split("/").at(-1),mediaType:"application/octet-stream",dataBase64:bytes.toString("base64")}};
  });
  if (mappings.length) batch = store.stageHubImportChunk(batch.id, batch.cursor, mappings, clock());
  if (batch.cursor === batch.totalItems) batch = store.publishHubImport(batch.id, clock(),input.attachmentDirectory,limits);
  return batch;
}

export function newImportTargetId(): string { return randomUUID(); }
