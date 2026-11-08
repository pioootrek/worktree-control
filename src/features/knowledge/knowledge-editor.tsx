"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useI18n } from "@/i18n/provider";
import type { KnowledgeFailure, KnowledgeTask, KnowledgeTaskPriority, KnowledgeTaskStatus, KnowledgeThread } from "@/shared/contracts/knowledge";
import { KnowledgeClientError, knowledgeRequest, type KnowledgeCredential } from "./knowledge-client";

function retryKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, "0")).join("");
}

export const fieldClass = "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
export type EditorMode = "thread" | "task" | "reply" | "from_thread" | "edit";
interface Draft { title: string; body: string; priority: KnowledgeTaskPriority; status: KnowledgeTaskStatus; expectedRevision: number; idempotencyKey: string; error: KnowledgeFailure | null }

export function KnowledgeEditor({ token, principalId, projectId, mode, record, onSaved, onCancel, onConflict }: {
  token: KnowledgeCredential; principalId: string; projectId: string; mode: EditorMode;
  record?: KnowledgeTask | KnowledgeThread;
  onSaved: (recordId?: string, tab?: "backlog" | "discussions") => void;
  onCancel: () => void; onConflict: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const storageKey = `knowledge:draft:${principalId}:${projectId}:${mode}:${record?.id ?? "new"}`;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      const initial: Draft = { title: record?.title ?? "", body: record ? ("description" in record ? record.description : mode === "from_thread" ? record.body : "") : "", priority: record && "priority" in record ? record.priority : "later", status: record && "status" in record ? record.status : "open", expectedRevision: record?.revision ?? 1, idempotencyKey: retryKey(), error: null };
      try {
        const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as Draft | null;
        if (stored && typeof stored.title === "string" && typeof stored.body === "string" && typeof stored.idempotencyKey === "string" && Number.isInteger(stored.expectedRevision)) setDraft(stored);
        else setDraft(initial);
      } catch { setDraft(initial); }
    }, 0);
    return () => clearTimeout(timer);
    // Only a different editor identity initializes the draft. Live records do not replace local edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const persist = (value: Draft) => {
    setDraft(value);
    try { sessionStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* In-memory draft remains usable when storage is full. */ }
  };
  if (!draft) return <p role="status">{t("knowledge.loading")}</p>;
  const edit = (patch: Partial<Draft>) => persist({ ...draft, ...patch });
  const submit = async () => {
    persist(draft);
    setBusy(true);
    try {
      const common = { projectId, idempotencyKey: draft.idempotencyKey };
      let result: { value: { id?: string; task?: { id: string } } };
      if (mode === "thread") result = await knowledgeRequest(token, "create_thread", { ...common, title: draft.title, body: draft.body });
      else if (mode === "reply") result = await knowledgeRequest(token, "create_reply", { ...common, threadId: record!.id, body: draft.body });
      else {
        const task = { ...common, title: draft.title, description: draft.body, priority: draft.priority };
        if (mode === "edit") result = await knowledgeRequest(token, "update_task", { ...task, taskId: record!.id, status: draft.status, expectedRevision: draft.expectedRevision });
        else if (mode === "from_thread") result = await knowledgeRequest(token, "task_from_thread", { ...task, threadId: record!.id });
        else result = await knowledgeRequest(token, "create_task", task);
      }
      sessionStorage.removeItem(storageKey);
      onSaved(mode === "reply" ? record!.id : result.value.task?.id ?? result.value.id, mode === "reply" || mode === "thread" ? "discussions" : "backlog");
    } catch (error) {
      const failure = error instanceof KnowledgeClientError ? error.failure : { code: "network_error", error: "Network error" };
      persist({ ...draft, error: failure });
      if (failure.code === "revision_conflict") onConflict();
    } finally { setBusy(false); }
  };
  const conflict = draft.error?.code === "revision_conflict";
  return <form className="space-y-4 rounded-xl border border-border p-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <h3 className="text-lg font-semibold">{t(mode === "reply" ? "knowledge.reply" : mode === "edit" ? "knowledge.edit" : mode === "from_thread" ? "knowledge.fromThread" : mode === "thread" ? "knowledge.addDiscussion" : "knowledge.addTask")}</h3>
    {draft.error && <Alert variant="destructive"><AlertDescription>{t(conflict ? "knowledge.conflict" : draft.error.code === "idempotency_conflict" ? "knowledge.retryConflict" : draft.error.code === "credential_invalid" || draft.error.code === "invalid_credential" ? "knowledge.sessionExpired" : "knowledge.saveFailed")}</AlertDescription></Alert>}
    {conflict && record && <div className="space-y-2">
      <p>{t("knowledge.savedVersion", { revision: record.revision })}</p>
      <p className="font-medium">{record.title}</p>
      <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">{"description" in record ? record.description : record.body}</p>
      <Button type="button" variant="outline" disabled={busy || record.revision <= draft.expectedRevision} onClick={() => edit({ expectedRevision: record.revision, error: null })}>{t("knowledge.rebaseDraft")}</Button>
    </div>}
    {mode !== "reply" && <div className="space-y-2"><Label htmlFor={`${id}-title`}>{t("knowledge.recordTitle")}</Label><Input autoFocus id={`${id}-title`} required maxLength={200} value={draft.title} onChange={event => edit({ title: event.target.value })} disabled={busy} /></div>}
    <div className="space-y-2"><Label htmlFor={`${id}-body`}>{t("knowledge.body")}</Label><textarea autoFocus={mode === "reply"} id={`${id}-body`} className={`${fieldClass} min-h-36`} required maxLength={65536} value={draft.body} onChange={event => edit({ body: event.target.value })} disabled={busy} /></div>
    {mode !== "reply" && mode !== "thread" && <div className="flex flex-wrap gap-4">
      <div className="space-y-2"><Label htmlFor={`${id}-priority`}>{t("knowledge.priority")}</Label><select id={`${id}-priority`} className={fieldClass} value={draft.priority} disabled={busy} onChange={event => edit({ priority: event.target.value as KnowledgeTaskPriority })}>{(["now", "next", "later"] as const).map(value => <option key={value} value={value}>{t(`knowledge.${value}`)}</option>)}</select></div>
      {mode === "edit" && <div className="space-y-2"><Label htmlFor={`${id}-status`}>{t("knowledge.status")}</Label><select id={`${id}-status`} className={fieldClass} value={draft.status} disabled={busy} onChange={event => edit({ status: event.target.value as KnowledgeTaskStatus })}>{(["open", "in_progress", "blocked", "done", "archived"] as const).map(value => <option key={value} value={value}>{t(`knowledge.${value}`)}</option>)}</select></div>}
    </div>}
    <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy || conflict}>{t(busy ? "knowledge.saving" : "knowledge.save")}</Button><Button type="button" variant="outline" disabled={busy} onClick={onCancel}>{t("knowledge.closeDraft")}</Button></div>
  </form>;
}
