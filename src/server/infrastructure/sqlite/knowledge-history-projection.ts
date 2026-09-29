import type { KnowledgeHistoryEntry, KnowledgeMemoryHistorySnapshot } from "@/shared/contracts/knowledge";
import { knowledgeSourceSchema } from "@/shared/contracts/knowledge-memory-schemas";

type Identity = { id: string; projectId: string; revision: number };

/** Imported audit rows may predate the current contract. Never coerce them into a change claim. */
export function memoryHistorySnapshot(value: unknown, identity: Identity): KnowledgeMemoryHistorySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const short = (part: unknown, max: number): part is string => typeof part === "string" && part.length <= max;
  if (row.id !== identity.id || row.projectId !== identity.projectId || row.revision !== identity.revision ||
    !short(row.title, 200) || !short(row.body, 65536) ||
    !["decision", "question", "note"].includes(String(row.category)) ||
    !["active", "archived", "superseded"].includes(String(row.status)) ||
    !Array.isArray(row.tags) || row.tags.length > 20 || !row.tags.every(tag => short(tag, 80)) ||
    !(row.legacyId === null || short(row.legacyId, 160)) ||
    !Array.isArray(row.sources) || row.sources.length > 20 || !row.sources.every(source => knowledgeSourceSchema.safeParse(source).success)) return null;
  const approval = row.approval;
  if (approval !== null && (!approval || typeof approval !== "object" || Array.isArray(approval) ||
    !Number.isSafeInteger((approval as Record<string, unknown>).revision) || Number((approval as Record<string, unknown>).revision) < 1 ||
    !short((approval as Record<string, unknown>).principalId, 160) ||
    !short((approval as Record<string, unknown>).approvedAt, 80))) return null;
  const supersededBy = row.supersededBy;
  if (supersededBy !== null && (!supersededBy || typeof supersededBy !== "object" || Array.isArray(supersededBy) ||
    !short((supersededBy as Record<string, unknown>).id, 160) ||
    !Number.isSafeInteger((supersededBy as Record<string, unknown>).revision) || Number((supersededBy as Record<string, unknown>).revision) < 1)) return null;
  return {
    title: row.title as string, body: row.body as string,
    category: row.category as KnowledgeMemoryHistorySnapshot["category"],
    status: row.status as KnowledgeMemoryHistorySnapshot["status"],
    tags: row.tags as string[], legacyId: row.legacyId as string | null, sources: row.sources as KnowledgeMemoryHistorySnapshot["sources"],
    approval: approval === null ? null : { revision: (approval as Record<string, number>).revision, principalId: (approval as Record<string, string>).principalId, approvedAt: (approval as Record<string, string>).approvedAt },
    supersededBy: supersededBy === null ? null : { id: (supersededBy as Record<string, string>).id, revision: (supersededBy as Record<string, number>).revision },
  };
}

export function parseMemoryHistorySnapshot(json: string | null, identity: Identity): KnowledgeMemoryHistorySnapshot | null {
  if (typeof json !== "string" || json.length > 262144) return null;
  try { return memoryHistorySnapshot(JSON.parse(json), identity); } catch { return null; }
}

export function memoryHistoryComparison(entry: KnowledgeHistoryEntry, successor: KnowledgeHistoryEntry | undefined, current: unknown) {
  if (!Number.isSafeInteger(entry.revision) || entry.revision < 1) return null;
  const before = entry.operation === "created" && entry.revision === 1 && entry.previousJson === null
    ? null : parseMemoryHistorySnapshot(entry.previousJson, { id: entry.recordId, projectId: entry.projectId, revision: entry.revision - 1 });
  if (before === null && !(entry.operation === "created" && entry.revision === 1 && entry.previousJson === null)) return null;
  if (entry.operation === "created" && before !== null) return null;
  const after = successor
    ? successor.projectId === entry.projectId && successor.recordKind === "memory" && successor.recordId === entry.recordId && successor.revision === entry.revision + 1
      ? parseMemoryHistorySnapshot(successor.previousJson, { id: entry.recordId, projectId: entry.projectId, revision: entry.revision }) : null
    : memoryHistorySnapshot(current, { id: entry.recordId, projectId: entry.projectId, revision: entry.revision });
  return after ? { before, after } : null;
}
