import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, openSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeAttachment, KnowledgeAttachmentDownload, KnowledgeAttachmentRecordKind, KnowledgeAttachmentLimits, KnowledgeAttachmentPolicy, KnowledgeAttachmentManifestEntry, KnowledgeAttachmentPreflight, KnowledgeEvidence } from "@/shared/contracts/knowledge-attachments";
import type { AuthenticatedPrincipal, IdentityService } from "@/server/modules/identity";
import type { KnowledgeStore } from "./contracts";
import { KnowledgeError } from "./knowledge-error";
import { publishKnowledgeAttachment } from "./durable-attachments";

import { attachmentLimits, DEFAULT_ATTACHMENT_LIMITS, attachmentViolations, assertAttachmentCapacity, validateAttachmentFilename, attachmentRequestHashInput } from "./attachment-policy";

export interface AttachmentLimits { fileBytes: number; projectBytes: number; projectFiles?: number }

export class KnowledgeAttachmentService {
  private readonly limits: KnowledgeAttachmentLimits;
  constructor(private readonly store: KnowledgeStore, private readonly identity: Pick<IdentityService, "authorizeKnowledge">,
    private readonly objectDirectory: string, limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
    private readonly clock: () => string = () => new Date().toISOString(), private readonly id: () => string = randomUUID) { this.limits = attachmentLimits(limits); }

  upload(projectId: string, recordKind: KnowledgeAttachmentRecordKind, recordId: string,
    input: { filename: string; mediaType: string; data: Uint8Array; sha256?: string; idempotencyKey: string }, actor: AuthenticatedPrincipal) {
    this.identity.authorizeKnowledge(actor, projectId, "attachments:write");
    validateAttachmentFilename(input.filename);
    if (!input.data.byteLength) throw new KnowledgeError("invalid_request", "Attachment payload must not be empty.");
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw new KnowledgeError("invalid_request", "A stable idempotencyKey is required.");
    const sha256 = createHash("sha256").update(input.data).digest("hex");
    if (input.sha256 && input.sha256 !== sha256) throw new KnowledgeError("invalid_request", "Attachment hash does not match its content.");
    const requestHash=createHash("sha256").update(attachmentRequestHashInput(recordKind,recordId,input.filename,input.mediaType,sha256)).digest("hex");
    const context={actor,projectId,idempotencyKey:input.idempotencyKey,requestHash}; const replay=this.store.findIdempotentResult<KnowledgeAttachment>("attachment.create",context); if(replay) return replay;
    assertAttachmentCapacity(this.limits, this.usage(projectId), { bytes: input.data.byteLength, files: 1 }, [{ filename: input.filename, size: input.data.byteLength }]);
    if (!this.store.attachmentTargetExists(projectId,recordKind,recordId)) throw new KnowledgeError("not_found","Attachment target not found.");
    publishKnowledgeAttachment(this.objectDirectory, { sha256, size: input.data.byteLength }, input.data);
    const attachment: KnowledgeAttachment = { id: this.id(), projectId, recordKind, recordId, filename: input.filename,
      mediaType: input.mediaType || "application/octet-stream", size: input.data.byteLength, sha256, createdBy: actor.principalId, createdAt: this.clock() };
    return this.store.saveAttachment(attachment, context, () => {
      this.identity.authorizeKnowledge(actor, projectId, "attachments:write");
      assertAttachmentCapacity(this.limits, this.usage(projectId), { bytes: attachment.size, files: 1 }, [attachment]);
    });
  }

  private usage(projectId: string) {
    return { bytes: this.store.attachmentBytesForProject(projectId), files: this.store.attachmentCountForProject(projectId) };
  }

  policy(projectId: string, actor: AuthenticatedPrincipal): KnowledgeAttachmentPolicy {
    this.identity.authorizeKnowledge(actor, projectId, "attachments:read", { allowArchived: true });
    const used = this.usage(projectId), largestFileBytes = this.store.attachmentLargestFileForProject(projectId);
    return { projectId, limits: { ...this.limits }, used, largestFileBytes,
      remaining: { bytes: Math.max(0, this.limits.projectBytes - used.bytes), files: Math.max(0, this.limits.projectFiles - used.files) },
      exceeded: [...attachmentViolations(this.limits, used, { bytes: 0, files: 0 }), ...(largestFileBytes > this.limits.fileBytes ? [{ constraint: "fileBytes" as const, unit: "bytes" as const, used: largestFileBytes, limit: this.limits.fileBytes, incoming: 0, remaining: 0 }] : [])],
      accounting: "logical_attachment_records", physicalDiskUsage: null };
  }

  checkBatch(projectId: string, recordKind: KnowledgeAttachmentRecordKind, recordId: string,
    files: KnowledgeAttachmentManifestEntry[], actor: AuthenticatedPrincipal, evidence?: KnowledgeEvidence): KnowledgeAttachmentPreflight {
    this.identity.authorizeKnowledge(actor, projectId, "attachments:write");
    this.identity.authorizeKnowledge(actor, projectId, "attachments:read");
    if (!this.store.attachmentTargetExists(projectId, recordKind, recordId)) throw new KnowledgeError("not_found", "Attachment target not found.");
    if (!files.length || files.length > 10000) throw new KnowledgeError("invalid_request", "Manifest must contain 1–10000 files.");
    if (evidence && (recordKind !== "task" || evidence.taskId !== recordId)) throw new KnowledgeError("invalid_request", "Evidence must target its declared task.");
    const incoming = { bytes: 0, files: 0 }, replayedFiles: string[] = [], pending: KnowledgeAttachmentManifestEntry[] = [];
    const names = new Set<string>(), keys = new Set<string>();
    for (const file of files) {
      validateAttachmentFilename(file.filename);
      if (names.has(file.filename) || !Number.isSafeInteger(file.size) || file.size < 1 || !/^[a-f0-9]{64}$/.test(file.sha256))
        throw new KnowledgeError("invalid_request", "Manifest needs unique filenames, positive decoded byte sizes and lowercase SHA-256 hashes.");
      names.add(file.filename);
      if (file.idempotencyKey) {
        if (!file.mediaType || keys.has(file.idempotencyKey)) throw new KnowledgeError("invalid_request", "Retry manifest keys must be unique and include mediaType.");
        keys.add(file.idempotencyKey);
        const requestHash = createHash("sha256").update(attachmentRequestHashInput(recordKind, recordId, file.filename, file.mediaType, file.sha256)).digest("hex");
        const replay = this.store.findIdempotentResult<KnowledgeAttachment>("attachment.create", { actor, projectId, idempotencyKey: file.idempotencyKey, requestHash });
        if (replay) {
          if (replay.value.size !== file.size) throw new KnowledgeError("invalid_request", "Retry manifest size does not match committed content.");
          replayedFiles.push(file.filename); continue;
        }
      }
      incoming.bytes += file.size; incoming.files++; pending.push(file);
      if (!Number.isSafeInteger(incoming.bytes)) throw new KnowledgeError("invalid_request", "Manifest byte total is not a safe integer.");
    }
    const policy = this.policy(projectId, actor), violations = attachmentViolations(this.limits, policy.used, incoming, pending);
    return { policy, incoming, violations, accepted: violations.length === 0, replayedFiles, reservesCapacity: false, atomicUpload: false, ...(evidence ? { evidence } : {}) };
  }

  list(projectId: string, recordKind: KnowledgeAttachmentRecordKind, recordId: string, actor: AuthenticatedPrincipal, limit=25, offset=0) {
    this.identity.authorizeKnowledge(actor, projectId, "attachments:read", { allowArchived: true });
    return this.store.listAttachments(projectId, recordKind, recordId,Math.min(Math.max(limit,1),100),Math.max(offset,0));
  }

  download(projectId: string, attachmentId: string, actor: AuthenticatedPrincipal): KnowledgeAttachmentDownload {
    this.identity.authorizeKnowledge(actor, projectId, "attachments:read", { allowArchived: true });
    const attachment = this.store.getAttachment(projectId, attachmentId);
    if (!attachment) throw new KnowledgeError("not_found", "Attachment not found.");
    const shard=join(this.objectDirectory,attachment.sha256.slice(0,2)), path=join(shard,attachment.sha256);
    if(lstatSync(this.objectDirectory).isSymbolicLink()||lstatSync(shard).isSymbolicLink()||lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile()) throw new KnowledgeError("invalid_request","Unsafe attachment object path.");
    const descriptor=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW); let data:Buffer; try { data=readFileSync(descriptor); } finally { closeSync(descriptor); }
    if (data.byteLength !== attachment.size || createHash("sha256").update(data).digest("hex") !== attachment.sha256)
      throw new KnowledgeError("invalid_request", "Attachment integrity check failed.");
    return { attachment, data, disposition: "attachment" };
  }
}
