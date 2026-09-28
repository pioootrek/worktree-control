import { z } from "zod";
import type { KnowledgeRecordKind, KnowledgeTask, KnowledgePage } from "./knowledge";
import { knowledgeSourceSchema } from "./knowledge-memory-schemas";
export type { MemoryRequest } from "./knowledge-memory-schemas";
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;
export type KnowledgeMemoryStatus = "active" | "archived" | "superseded";
export interface KnowledgeMemoryReading {
  kind: "imported-note";
  bodyFormat: "text" | "metadata" | "manifest";
  summary: string | null;
}
export interface KnowledgeMemory {
  id: string;
  projectId: string;
  title: string;
  body: string;
  reading?: KnowledgeMemoryReading;
  category: "decision" | "question" | "note";
  tags: string[];
  legacyId: string | null;
  sources: KnowledgeSource[];
  status: KnowledgeMemoryStatus;
  supersededBy: { id: string; revision: number } | null;
  approval: { revision: number; principalId: string; approvedAt: string } | null;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export type KnowledgeMemorySummary = Omit<KnowledgeMemory, "body" | "sources">;
export interface KnowledgeSearchHit {
  id: string; projectId: string; kind: KnowledgeRecordKind; title: string; excerpt: string;
  reading?: KnowledgeMemoryReading;
  revision: number; status: string; updatedAt: string; threadId: string | null;
}
export interface KnowledgeSourceState { href: string; source: KnowledgeSource; currentRevision: number | null; stale: boolean; inactive: boolean }
export interface KnowledgeContextMemory extends KnowledgeMemorySummary { href: string; excerpt: string; bodyTruncated: boolean; sourceStates: KnowledgeSourceState[] }
export interface KnowledgeTaskContext {
  formatVersion: 1;
  generatedAt: string;
  projectId: string;
  task: Omit<KnowledgeTask, "description">;
  taskHref: string;
  page: { limit: number; offset: number };
  scope: string;
  scopeTruncated: boolean;
  decisions: KnowledgeContextMemory[];
  proposals: KnowledgeContextMemory[];
  openQuestions: KnowledgeContextMemory[];
  evidence: KnowledgeSourceState[];
  nextOffset: number | null;
  fingerprint: string;
}
export interface KnowledgeExport {
  formatVersion: 1; generatedAt: string; projectId: string; taskId: string; fingerprint: string;
  format: "json" | "markdown"; content: string; nextOffset: number | null;
}
export interface KnowledgeSearchOptions {
  query?: string; kind?: KnowledgeRecordKind; status?: string; tag?: string; legacyId?: string; includeInactive?: boolean;
}
export type MemoryPage = KnowledgePage<KnowledgeMemory>;
