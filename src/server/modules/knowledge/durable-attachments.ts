import { InvalidAttachmentObject, publishAttachmentObject, type AttachmentObject } from "@/server/attachment-objects";
import { KnowledgeError } from "./knowledge-error";

export function publishKnowledgeAttachment(root: string, object: AttachmentObject, source: Uint8Array | { path: string }): void {
  try { publishAttachmentObject(root, object, source); } catch (error) {
    if (error instanceof InvalidAttachmentObject) throw new KnowledgeError("invalid_request", error.message);
    throw error;
  }
}
