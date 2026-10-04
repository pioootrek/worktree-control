import type { KnowledgeAttachmentLimits, KnowledgeLimitViolation, KnowledgeQuotaUsage } from "@/shared/contracts/knowledge-attachments";
import { KnowledgeError } from "./knowledge-error";

export const DEFAULT_ATTACHMENT_LIMITS: Readonly<KnowledgeAttachmentLimits> = Object.freeze({
  fileBytes: 10 * 1024 * 1024, projectBytes: 512 * 1024 * 1024, projectFiles: 5000,
});

/** Upper bounds match the bounded upload transports and logical-transfer envelope. */
export function attachmentLimits(input: { fileBytes: number; projectBytes: number; projectFiles?: number }): KnowledgeAttachmentLimits {
  const limits = { ...input, projectFiles: input.projectFiles ?? DEFAULT_ATTACHMENT_LIMITS.projectFiles };
  for (const [key, maximum] of Object.entries({ fileBytes: 10 * 1024 * 1024, projectBytes: 1024 * 1024 * 1024, projectFiles: 10000 })) {
    const value = limits[key as keyof KnowledgeAttachmentLimits];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new KnowledgeError("invalid_request", `Attachment policy ${key} must be an integer between 1 and ${maximum}.`);
  }
  if (limits.fileBytes > limits.projectBytes) throw new KnowledgeError("invalid_request", "Attachment file limit must not exceed the project byte limit.");
  return limits;
}

export const ATTACHMENT_CAPACITY_RECOVERY = "Reduce the incoming evidence size or count and rerun check_attachment_batch. For existing data above policy, ask the installation operator to review knowledge-policy.json within supported bounds. Existing attachments remain readable; a full-controller backup is available if logical export exceeds policy. Archiving records or removing worktrees does not reclaim this quota.";

export function attachmentViolations(limits: KnowledgeAttachmentLimits, used: KnowledgeQuotaUsage,
  incoming: KnowledgeQuotaUsage, files: ReadonlyArray<{ filename: string; size: number }> = []): KnowledgeLimitViolation[] {
  const violations: KnowledgeLimitViolation[] = [];
  for (const file of files) if (file.size > limits.fileBytes) violations.push({ constraint: "fileBytes", unit: "bytes", used: 0,
    limit: limits.fileBytes, incoming: file.size, remaining: limits.fileBytes, filename: file.filename });
  for (const [constraint, key, unit] of [["projectBytes", "bytes", "bytes"], ["projectFiles", "files", "records"]] as const) {
    const limit = limits[constraint];
    if (used[key] + incoming[key] > limit) violations.push({ constraint, unit, used: used[key], limit, incoming: incoming[key], remaining: Math.max(0, limit - used[key]) });
  }
  return violations;
}

export function assertAttachmentCapacity(limits: KnowledgeAttachmentLimits, used: KnowledgeQuotaUsage,
  incoming: KnowledgeQuotaUsage, files: ReadonlyArray<{ filename: string; size: number }> = []): void {
  const violations = attachmentViolations(limits, used, incoming, files);
  if (violations.length) throw new KnowledgeError("limit_exceeded", "Attachment capacity exceeded.", undefined, { violations, recovery: ATTACHMENT_CAPACITY_RECOVERY });
}

export function validateAttachmentFilename(filename: string): void {
  if (!filename || filename.length > 255 || filename === "." || filename === ".." || /[/\\\u0000-\u001f\u007f]/.test(filename))
    throw new KnowledgeError("invalid_request", "Attachment filename must be a basename of 1–255 characters without separators or control characters.");
}

export function attachmentRequestHashInput(recordKind: string, recordId: string, filename: string, mediaType: string, sha256: string): string {
  return JSON.stringify({ recordKind, recordId, filename, mediaType, sha256 });
}
