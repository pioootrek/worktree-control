import type { KnowledgeFailure } from "@/shared/contracts/knowledge";
import { IdentityError } from "@/server/modules/identity";
import { KnowledgeError } from "./knowledge-service";

export function knowledgeFailure(error: unknown): { status: number; body: KnowledgeFailure } {
  if (error instanceof KnowledgeError) {
    const status = error.code === "not_found" ? 404 : error.code.endsWith("conflict") ? 409 : error.code === "limit_exceeded" ? 413 : 400;
    return { status, body: { code: error.code, error: error.message, ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }), ...(error.details ? { details: error.details } : {}) } };
  }
  if (error instanceof IdentityError) {
    return { status: error.code === "invalid_credential" ? 401 : 403, body: { code: error.code, error: "Knowledge access denied." } };
  }
  return { status: 500, body: { code: "internal_error", error: "Knowledge operation failed." } };
}
