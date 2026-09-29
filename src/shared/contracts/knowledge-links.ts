import type { KnowledgeSource } from "./knowledge-memory";

export function knowledgeSourceHref(projectId: string, source: KnowledgeSource, replyThreadId?: string): string {
  if (source.kind === "external") return source.url;
  if (source.kind === "repository") return "";
  if (source.kind === "reply" && !replyThreadId) return "";
  const tab = source.kind === "memory" ? "memory" : source.kind === "task" ? "backlog" : "discussions";
  return `?view=knowledge&knowledgeProject=${encodeURIComponent(projectId)}&knowledgeTab=${tab}&record=${encodeURIComponent(source.kind === "reply" ? replyThreadId! : source.id)}${source.kind === "reply" ? `&reply=${encodeURIComponent(source.id)}` : ""}`;
}
