import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, openSync, closeSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { KnowledgeAttachment, KnowledgeAttachmentDownload, KnowledgeAttachmentRecordKind } from "@/shared/contracts/knowledge-attachments";
import type { AuthenticatedPrincipal, IdentityService } from "@/server/modules/identity";
import type { KnowledgeStore } from "./contracts";
import { KnowledgeError } from "./knowledge-error";
import { publishKnowledgeAttachment } from "./durable-attachments";

export interface AttachmentLimits { fileBytes: number; projectBytes: number; projectFiles?: number }
const DEFAULT_LIMITS: AttachmentLimits = { fileBytes: 10 * 1024 * 1024, projectBytes: 100 * 1024 * 1024, projectFiles: 1000 };

export class KnowledgeAttachmentService {
  constructor(private readonly store: KnowledgeStore, private readonly identity: Pick<IdentityService, "authorizeKnowledge">,
    private readonly objectDirectory: string, private readonly limits = DEFAULT_LIMITS,
    private readonly clock: () => string = () => new Date().toISOString(), private readonly id: () => string = randomUUID) {}

  upload(projectId: string, recordKind: KnowledgeAttachmentRecordKind, recordId: string,
    input: { filename: string; mediaType: string; data: Uint8Array; sha256?: string; idempotencyKey: string }, actor: AuthenticatedPrincipal) {
    this.identity.authorizeKnowledge(actor, projectId, "attachments:write");
    if (!input.filename || basename(input.filename) !== input.filename || input.filename === "." || input.filename === ".." || input.filename.includes("\\"))
      throw new KnowledgeError("invalid_request", "Invalid attachment filename.");
    const sha256 = createHash("sha256").update(input.data).digest("hex");
    if (input.sha256 && input.sha256 !== sha256) throw new KnowledgeError("invalid_request", "Attachment hash does not match its content.");
    const requestHash=createHash("sha256").update(JSON.stringify({recordKind,recordId,filename:input.filename,mediaType:input.mediaType,sha256})).digest("hex");
    const context={actor,projectId,idempotencyKey:input.idempotencyKey,requestHash}; const replay=this.store.findIdempotentResult<KnowledgeAttachment>("attachment.create",context); if(replay) return replay;
    if (!input.data.byteLength || input.data.byteLength > this.limits.fileBytes || this.store.attachmentBytesForProject(projectId) + input.data.byteLength > this.limits.projectBytes || this.store.attachmentCountForProject(projectId) >= (this.limits.projectFiles ?? 1000))
      throw new KnowledgeError("limit_exceeded", "Attachment storage limit exceeded.");
    if (!this.store.attachmentTargetExists(projectId,recordKind,recordId)) throw new KnowledgeError("not_found","Attachment target not found.");
    publishKnowledgeAttachment(this.objectDirectory, { sha256, size: input.data.byteLength }, input.data);
    const attachment: KnowledgeAttachment = { id: this.id(), projectId, recordKind, recordId, filename: input.filename,
      mediaType: input.mediaType || "application/octet-stream", size: input.data.byteLength, sha256, createdBy: actor.principalId, createdAt: this.clock() };
    return this.store.saveAttachment(attachment, context);
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
