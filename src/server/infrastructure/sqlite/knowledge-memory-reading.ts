import type { KnowledgeMemoryReading } from "@/shared/contracts/knowledge-memory";

const MAX_PAYLOAD_LENGTH = 131072;
const MAX_SUMMARY_LENGTH = 2000;

function summaryFrom(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const field of [record.summary, record.description]) {
    if (typeof field === "string" && field.trim()) return Array.from(field.trim()).slice(0, MAX_SUMMARY_LENGTH).join("");
  }
  return null;
}

/** A presentation hint is valid only while the persisted body still equals the importer's output. */
export function readingFromImport(originalPayloadJson: string | null, currentBody: string): KnowledgeMemoryReading | null {
  if (!originalPayloadJson || originalPayloadJson.length > MAX_PAYLOAD_LENGTH) return null;
  let payload: unknown;
  try { payload = JSON.parse(originalPayloadJson); } catch { return null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const sourceBody = record.body;
  const value = typeof sourceBody === "string" ? sourceBody : JSON.stringify(sourceBody ?? record);
  // Keep this normalization aligned with publishHubImport's text(..., "Imported empty note").
  const importedBody = typeof value === "string" && value.trim() ? value.trim() : "Imported empty note";
  if (importedBody !== currentBody) return null;
  const bodyFormat = typeof sourceBody === "string" ? "text" : sourceBody == null ? "manifest" : "metadata";
  return { kind: "imported-note", bodyFormat, summary: bodyFormat === "metadata" ? summaryFrom(sourceBody)
    : bodyFormat === "manifest" ? summaryFrom(record) : null };
}
