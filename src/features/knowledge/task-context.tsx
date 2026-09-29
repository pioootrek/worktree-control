"use client";

import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { Label } from "@/components/ui/label";
import { fieldClass } from "./knowledge-editor";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import type { KnowledgeExport, KnowledgeTaskContext } from "@/shared/contracts/knowledge-memory";
import { knowledgeRequest } from "./knowledge-client";
import { knowledgeSourceHref as sourceHref } from "@/shared/contracts/knowledge-links";

export function TaskContext({ token, projectId, taskId, changeVersion }: { token: string; projectId: string; taskId: string; changeVersion: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<KnowledgeTaskContext | null>(null);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(25);
  const [previousOffsets, setPreviousOffsets] = useState<number[]>([]);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "busy" | "copied">("idle");
  const [copyFallback, setCopyFallback] = useState("");
  const [exported, setExported] = useState<{ fingerprint: string; offset: number; limit: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void knowledgeRequest<KnowledgeTaskContext>(token, "task_context", { projectId, taskId, offset, limit }, abort.signal)
      .then(value => { if (!abort.signal.aborted) { setContext(value); setError(false); } })
      .catch(() => { if (!abort.signal.aborted) { setContext(null); setError(true); } });
    return () => abort.abort();
  }, [token, projectId, taskId, open, offset, limit, version, changeVersion]);
  const download = async (format: "json" | "markdown") => {
    try {
      const value = await knowledgeRequest<KnowledgeExport>(token, "export_context", { projectId, taskId, offset, limit, format });
      const url = URL.createObjectURL(new Blob([value.content], { type: format === "json" ? "application/json" : "text/markdown;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = `task-context-${taskId}-${offset}.${format === "json" ? "json" : "md"}`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExported({ fingerprint: value.fingerprint, offset, limit }); setError(false); setVersion(v => v + 1);
    } catch { setError(true); }
  };
  const copyForAgent = async () => {
    setCopyState("busy"); setCopyFallback("");
    try {
      const value = await knowledgeRequest<KnowledgeExport>(token, "export_context", { projectId, taskId, offset, limit, format: "markdown" });
      try { await navigator.clipboard.writeText(value.content); setCopyState("copied"); }
      catch { setCopyFallback(value.content); setCopyState("idle"); }
      setExported({ fingerprint: value.fingerprint, offset, limit }); setError(false); setOpen(true); setVersion(v => v + 1);
    } catch { setError(true); setCopyState("idle"); }
  };
  return <section aria-label={t("knowledge.taskContext")} className="space-y-3 border-t border-border pt-4">
    <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { setOpen(true); setVersion(v => v + 1); }}>{t("knowledge.taskContext")}</Button>
      <Button variant="secondary" disabled={copyState === "busy"} onClick={() => void copyForAgent()}><Copy aria-hidden className="size-4" />{t("knowledge.copyForAgent")}</Button></div>
    {copyState === "copied" && <p role="status" className="text-sm">{t("knowledge.contextCopied")}</p>}
    {copyFallback && <div className="space-y-2"><Label htmlFor={`copy-context-${taskId}`}>{t("knowledge.copyManually")}</Label><textarea id={`copy-context-${taskId}`} readOnly className={`${fieldClass} min-h-40`} value={copyFallback} onFocus={event => event.target.select()} /></div>}
    {(copyState === "copied" || copyFallback) && <p className="text-xs text-muted-foreground">{t("knowledge.copyScope")}</p>}
    {open && <div className="max-w-xs space-y-2"><Label htmlFor={`context-page-size-${taskId}`}>{t("knowledge.contextPageSize")}</Label><select id={`context-page-size-${taskId}`} className={fieldClass} value={limit} onChange={event => { setLimit(Number(event.target.value)); setOffset(0); setPreviousOffsets([]); setContext(null); setCopyState("idle"); setCopyFallback(""); }}>{[1, 5, 10, 25].map(size => <option key={size} value={size}>{size}</option>)}</select></div>}
    {error && <p role="alert">{t("knowledge.contextFailed")}</p>}
    {open && context && <>
      <p className="text-sm">{t("knowledge.contextHelp")}</p>
      {exported && exported.offset === offset && exported.limit === limit && exported.fingerprint !== context.fingerprint && <p role="status">{t("knowledge.exportStale")}</p>}
      <p className="whitespace-pre-wrap break-words text-sm">{context.scope}</p>
      {context.scopeTruncated && <p>{t("knowledge.truncated")}</p>}
      {([ ["knowledge.decisions", context.decisions], ["knowledge.proposals", context.proposals], ["knowledge.openQuestions", context.openQuestions] ] as const).map(([label, items]) => <div className="space-y-2" key={label}>
        <h4 className="font-medium">{t(label)}</h4>
        {!items.length && <p className="text-sm text-muted-foreground">{t("knowledge.empty")}</p>}
        {items.map(item => <div key={item.id} className="space-y-1 rounded-lg border border-border p-3">
          <a className="break-words underline" href={sourceHref(projectId, { kind: "memory", id: item.id, revision: item.revision })}>{item.title} · r{item.revision}</a>
          <p className="whitespace-pre-wrap break-words text-sm">{item.excerpt}</p>
          {item.bodyTruncated && <p className="text-sm">{t("knowledge.truncated")}</p>}
          <ul>{item.sourceStates.map((state, index) => <li className="break-all text-xs" key={index}>
            {state.source.kind === "repository" ? `${state.source.sourceId} · ${state.source.commit}:${state.source.path}` : state.href
              ? <a className="underline" href={state.href}>{state.source.kind === "external" ? state.source.label : `${state.source.id} · r${state.source.revision}`}</a>
              : <span>{t("knowledge.sourceUnavailable")}{"id" in state.source ? `: ${state.source.id}` : ""}</span>}
            {(state.stale || state.inactive) && ` · ${t("knowledge.sourceStale")}`}
          </li>)}</ul>
        </div>)}
      </div>)}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void download("json")}>{t("knowledge.exportJson")}</Button>
        <Button variant="outline" onClick={() => void download("markdown")}>{t("knowledge.exportMarkdown")}</Button>
        <Button variant="outline" disabled={!previousOffsets.length} onClick={() => { setOffset(previousOffsets.at(-1)!); setPreviousOffsets(previousOffsets.slice(0, -1)); setContext(null); setCopyState("idle"); setCopyFallback(""); }}>{t("knowledge.previous")}</Button>
        <Button variant="outline" disabled={context.nextOffset === null} onClick={() => { setPreviousOffsets([...previousOffsets, offset]); setOffset(context.nextOffset!); setContext(null); setCopyState("idle"); setCopyFallback(""); }}>{t("knowledge.nextPage")}</Button>
      </div>
    </>}
  </section>;
}
