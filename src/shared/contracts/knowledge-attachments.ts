export type KnowledgeAttachmentRecordKind = "thread" | "reply" | "task" | "memory";

export interface KnowledgeAttachmentLimits { fileBytes: number; projectBytes: number; projectFiles: number }
export interface KnowledgeQuotaUsage { bytes: number; files: number }
export interface KnowledgeLimitViolation {
  constraint: "fileBytes" | "projectBytes" | "projectFiles";
  unit: "bytes" | "records";
  used: number; limit: number; incoming: number; remaining: number;
  filename?: string;
}
export interface KnowledgeAttachmentPolicy {
  projectId: string;
  limits: KnowledgeAttachmentLimits;
  used: KnowledgeQuotaUsage;
  largestFileBytes: number;
  remaining: KnowledgeQuotaUsage;
  exceeded: KnowledgeLimitViolation[];
  accounting: "logical_attachment_records";
  physicalDiskUsage: null;
}
export interface KnowledgeAttachmentManifestEntry {
  filename: string; size: number; sha256: string;
  /** Needed together to exclude a committed upload retry from incoming usage. */
  mediaType?: string; idempotencyKey?: string;
}
export interface KnowledgeEvidence {
  setId: string; taskId: string; commit: string; command: string;
  result: "passed" | "failed" | "interrupted" | "inconclusive";
  executedAt: string; scope: string;
}
export interface KnowledgeAttachmentPreflight {
  policy: KnowledgeAttachmentPolicy;
  accepted: boolean;
  incoming: KnowledgeQuotaUsage;
  violations: KnowledgeLimitViolation[];
  replayedFiles: string[];
  reservesCapacity: false;
  atomicUpload: false;
  evidence?: KnowledgeEvidence;
}

export interface KnowledgeAttachment {
  id: string;
  projectId: string;
  recordKind: KnowledgeAttachmentRecordKind;
  recordId: string;
  filename: string;
  /** Recorded path relative to the imported note, when provenance proves it. */
  relativePath?: string;
  mediaType: string;
  size: number;
  sha256: string;
  createdBy: string;
  createdAt: string;
}

export interface KnowledgeAttachmentDownload {
  attachment: KnowledgeAttachment;
  data: Uint8Array;
  disposition: "attachment";
}
