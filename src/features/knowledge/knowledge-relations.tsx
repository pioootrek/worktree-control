"use client";

import { ArrowUpRight, Link2Off } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { knowledgeSourceHref } from "@/shared/contracts/knowledge-links";
import type { KnowledgePage, KnowledgeRecordKind, KnowledgeRelationView } from "@/shared/contracts/knowledge";
import type { KnowledgeTab } from "./use-knowledge";

const relationLabels = {
  derived_from: { source: "knowledge.relation.derivedFrom", target: "knowledge.relation.basisFor" },
  blocks: { source: "knowledge.relation.blocks", target: "knowledge.relation.blockedBy" },
  relates_to: { source: "knowledge.relation.relatesTo", target: "knowledge.relation.relatesTo" },
  supersedes: { source: "knowledge.relation.supersedes", target: "knowledge.relation.supersededBy" },
} as const;

export function KnowledgeRelations({ projectId, recordKind, recordId, page, offset, onPage, onNavigate }: {
  projectId: string; recordKind: KnowledgeRecordKind; recordId: string; page: KnowledgePage<KnowledgeRelationView>; offset: number;
  onPage: (offset: number) => void; onNavigate: (tab: KnowledgeTab, recordId: string, replyId?: string) => void;
}) {
  const { t } = useI18n();
  if (!page.items.length && offset === 0) return null;
  return <section className="max-w-[75ch] space-y-3 border-t border-border pt-5" aria-label={t("knowledge.relations")}>
    <h4 className="font-medium">{t("knowledge.relations")}</h4>
    <ul className="space-y-2">{page.items.map(relation => {
      const source = relation.sourceKind === recordKind && relation.sourceId === recordId;
      const destination = relation.destination;
      const label = t(relationLabels[relation.type][source ? "source" : "target"]);
      const kind = destination?.kind ?? (source ? relation.targetKind : relation.sourceKind);
      const id = destination?.id ?? (source ? relation.targetId : relation.sourceId);
      const tab: KnowledgeTab = kind === "task" ? "backlog" : kind === "memory" ? "memory" : "discussions";
      const href = destination ? knowledgeSourceHref(projectId, { kind, id, revision: 1 }, destination.threadId) : "";
      const content = <><span className="min-w-0 flex-1 space-y-1"><span className="block break-words font-medium leading-snug">{destination
        ? kind === "reply" ? t("knowledge.replyInThread", { title: destination.title }) : destination.title
        : t("knowledge.relationUnavailable")}</span>
        <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground"><span>{t(`knowledge.source.${kind}`)}</span><span aria-hidden>·</span><span>{label}</span>
          {destination?.status && <><span aria-hidden>·</span><span>{t(`knowledge.${destination.status}`)}</span></>}</span>
        <span className="block break-all font-mono text-[11px] text-muted-foreground">{id}</span></span>
        {href ? <ArrowUpRight aria-hidden className="size-4 shrink-0 text-muted-foreground" /> : <Link2Off aria-hidden className="size-4 shrink-0 text-muted-foreground" />}</>;
      return <li key={relation.id}>{href
        ? <a className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring" href={href}
            onClick={event => { if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); onNavigate(tab, kind === "reply" ? destination!.threadId! : id, kind === "reply" ? id : undefined); }}>{content}</a>
        : <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/20 p-3 text-sm" aria-disabled="true">{content}</div>}</li>;
    })}</ul>
    {(offset > 0 || page.nextOffset !== null) && <div className="flex gap-2"><Button variant="outline" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - 25))}>{t("knowledge.previous")}</Button><Button variant="outline" disabled={page.nextOffset === null} onClick={() => onPage(page.nextOffset!)}>{t("knowledge.nextPage")}</Button></div>}
  </section>;
}
