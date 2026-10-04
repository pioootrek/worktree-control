export type KnowledgeErrorCode = "invalid_request" | "not_found" | "revision_conflict" | "idempotency_conflict" | "limit_exceeded";

export class KnowledgeError extends Error {
  constructor(readonly code: KnowledgeErrorCode, message: string, readonly currentRevision?: number,
    readonly details?: { violations: import("@/shared/contracts/knowledge-attachments").KnowledgeLimitViolation[]; recovery: string }) {
    super(message);
    this.name = "KnowledgeError";
  }
}
