import type { KnowledgeSearchHit } from "@/shared/contracts/knowledge-memory";

export type MemorySearchState = {
  query: string; tag: string; legacyId: string; kind: KnowledgeSearchHit["kind"] | "";
  status: "active" | "archived" | "superseded" | "open" | "in_progress" | "blocked" | "done" | "";
  inactive: boolean; offset: number;
};

export const defaultMemorySearch: MemorySearchState = { query: "", tag: "", legacyId: "", kind: "memory", status: "", inactive: false, offset: 0 };
const keys = ["memoryPrincipal", "memoryProject", "memoryQuery", "memoryKind", "memoryTag", "memoryLegacy", "memoryStatus", "memoryInactive", "memoryOffset", "memoryResult"] as const;
const kinds = ["", "thread", "reply", "task", "memory"] as const;
const statuses = ["", "active", "archived", "superseded", "open", "in_progress", "blocked", "done"] as const;

export function clearMemorySearch(params: URLSearchParams) { for (const key of keys) params.delete(key); }
export function memorySearchScope(params: URLSearchParams, principalId: string, projectId: string) {
  return params.get("memoryPrincipal") === principalId && params.get("memoryProject") === projectId;
}
export function readMemorySearch(params: URLSearchParams, principalId: string, projectId: string): MemorySearchState {
  if (!memorySearchScope(params, principalId, projectId)) return defaultMemorySearch;
  const kind = params.get("memoryKind") ?? "memory";
  const status = params.get("memoryStatus") ?? "";
  const rawOffset = Number(params.get("memoryOffset") ?? "0");
  return { query: (params.get("memoryQuery") ?? "").slice(0, 200), tag: (params.get("memoryTag") ?? "").slice(0, 80),
    legacyId: (params.get("memoryLegacy") ?? "").slice(0, 160), kind: kinds.includes(kind as never) ? kind as MemorySearchState["kind"] : "memory",
    status: statuses.includes(status as never) ? status as MemorySearchState["status"] : "",
    inactive: params.get("memoryInactive") === "1", offset: Number.isInteger(rawOffset) && rawOffset >= 0 && rawOffset <= 1000000 ? rawOffset : 0 };
}
export function writeMemorySearch(params: URLSearchParams, state: MemorySearchState, principalId: string, projectId: string, result = "") {
  clearMemorySearch(params);
  params.set("memoryPrincipal", principalId); params.set("memoryProject", projectId);
  if (state.query) params.set("memoryQuery", state.query);
  params.set("memoryKind", state.kind);
  if (state.tag) params.set("memoryTag", state.tag);
  if (state.legacyId) params.set("memoryLegacy", state.legacyId);
  if (state.status) params.set("memoryStatus", state.status);
  if (state.inactive) params.set("memoryInactive", "1");
  if (state.offset) params.set("memoryOffset", String(state.offset));
  if (result) params.set("memoryResult", result);
}
export function memoryResultKey(kind: KnowledgeSearchHit["kind"], id: string) { return `${kind}:${id}`; }
export function memoryResultHref(href: string, state: MemorySearchState, principalId: string, projectId: string, result: string) {
  const params = new URLSearchParams(href.slice(1));
  writeMemorySearch(params, state, principalId, projectId, result);
  return `?${params.toString()}`;
}
export function memoryReturnHref(source: URLSearchParams, principalId: string, projectId: string) {
  if (!memorySearchScope(source, principalId, projectId) || !source.get("memoryResult")) return "";
  const params = new URLSearchParams({ view: "knowledge", knowledgeProject: projectId, knowledgeTab: "memory" });
  writeMemorySearch(params, readMemorySearch(source, principalId, projectId), principalId, projectId, source.get("memoryResult")!);
  return `?${params.toString()}`;
}
