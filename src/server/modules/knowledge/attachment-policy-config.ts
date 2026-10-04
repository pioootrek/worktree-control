import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { attachmentLimits, DEFAULT_ATTACHMENT_LIMITS } from "./attachment-policy";
import { KnowledgeError } from "./knowledge-error";

/** Installation file, read once at bootstrap (and by offline import/export commands). */
export function loadAttachmentLimits(dataDirectory: string) {
  const file = join(dataDirectory, "knowledge-policy.json");
  if (!existsSync(file)) return attachmentLimits(DEFAULT_ATTACHMENT_LIMITS);
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new KnowledgeError("invalid_request", "Invalid knowledge-policy.json file.");
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { throw new KnowledgeError("invalid_request", "Invalid knowledge-policy.json JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["fileBytes", "projectBytes", "projectFiles"].includes(key)))
    throw new KnowledgeError("invalid_request", "Unknown fields in knowledge-policy.json.");
  return attachmentLimits({ ...DEFAULT_ATTACHMENT_LIMITS, ...value });
}
