"use client";
/* eslint-disable @next/next/no-img-element -- previews use short-lived, authorized blob URLs */

import { isValidElement, memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Download, FileText, Paperclip } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import type { KnowledgePage } from "@/shared/contracts/knowledge";
import type { KnowledgeAttachment, KnowledgeAttachmentRecordKind } from "@/shared/contracts/knowledge-attachments";
import { knowledgeRequest } from "./knowledge-client";
import { ATTACHMENT_DISCOVERY_LIMIT, IMAGE_PREVIEW_LIMIT, attachmentMatchesScope, decodePreviewText, documentUrl, previewKind, resolveDocumentLink } from "./document-reader-policy";

type Props = { token: string; projectId: string; recordId: string; recordKind: KnowledgeAttachmentRecordKind; changeVersion: number; presentation?: "attachments" | "documents"; onDocumentChange?: (open: boolean) => void };
type DownloadResponse = { attachment: KnowledgeAttachment; dataBase64: string };
type Preview = { id: string; kind: "markdown" | "text" | "image"; text?: string; url?: string };

function bytesFromBase64(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
function imageMime(file: KnowledgeAttachment): string {
  const type = file.mediaType.toLowerCase().split(";")[0].trim();
  if (/^image\/(png|jpeg|gif|webp)$/.test(type)) return type;
  const extension = file.filename.toLowerCase().split(".").pop();
  return extension === "jpg" ? "image/jpeg" : `image/${extension}`;
}
function displayPath(file: KnowledgeAttachment): string {
  return "relativePath" in file && typeof file.relativePath === "string" ? file.relativePath : file.filename;
}
function sameAttachment(left: KnowledgeAttachment, right: KnowledgeAttachment): boolean {
  return left.id === right.id && left.projectId === right.projectId && left.recordKind === right.recordKind && left.recordId === right.recordId
    && left.filename === right.filename && left.mediaType === right.mediaType && left.size === right.size && left.sha256 === right.sha256
    && left.createdBy === right.createdBy && left.createdAt === right.createdAt && displayPath(left) === displayPath(right);
}
function keepUnchangedAttachments(previous: KnowledgeAttachment[] | null, incoming: KnowledgeAttachment[]): KnowledgeAttachment[] {
  if (!previous) return incoming;
  const byId = new Map(previous.map(file => [file.id, file]));
  const merged = incoming.map(file => {
    const old = byId.get(file.id);
    return old && sameAttachment(old, file) ? old : file;
  });
  return previous.length === merged.length && previous.every((file, index) => file === merged[index]) ? previous : merged;
}
function formatLabel(file: KnowledgeAttachment): string {
  const extension = file.filename.match(/\.([^.]+)$/)?.[1];
  return extension && extension.length <= 8 ? extension.toUpperCase() : "FILE";
}
function imageHasSignature(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/png") return bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n);
  if (mime === "image/jpeg") return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  if (mime === "image/gif") return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6)));
  if (mime === "image/webp") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return false;
}
function headingText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(headingText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return headingText(node.props.children);
  return "";
}

type AttachmentScope = Pick<Props, "token" | "projectId" | "recordId" | "recordKind">;
async function fetchChecked(file: KnowledgeAttachment, props: AttachmentScope, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const result = await knowledgeRequest<DownloadResponse>(props.token, "attachment", { projectId: props.projectId, attachmentId: file.id }, signal);
  if (!attachmentMatchesScope(result.attachment, props.projectId, props.recordKind, props.recordId) || result.attachment.id !== file.id || result.attachment.size !== file.size || result.attachment.sha256 !== file.sha256) throw new Error("scope");
  return bytesFromBase64(result.dataBase64);
}

function useDownload(props: Props, setError: (value: boolean) => void) {
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const download = async (file: KnowledgeAttachment) => {
    const abort = new AbortController(); active.current?.abort(); active.current = abort;
    setBusy(true);
    try {
      const result = await knowledgeRequest<DownloadResponse>(props.token, "attachment", { projectId: props.projectId, attachmentId: file.id }, abort.signal);
      if (abort.signal.aborted) return;
      if (!attachmentMatchesScope(result.attachment, props.projectId, props.recordKind, props.recordId) || result.attachment.id !== file.id || result.attachment.sha256 !== file.sha256) throw new Error("scope");
      const url = URL.createObjectURL(new Blob([bytesFromBase64(result.dataBase64)], { type: "application/octet-stream" }));
      const link = document.createElement("a"); link.href = url; link.download = result.attachment.filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setError(false);
    } catch { if (!abort.signal.aborted) setError(true); } finally { if (!abort.signal.aborted) setBusy(false); if (active.current === abort) active.current = null; }
  };
  return { busy, download };
}

export function RecordAttachments(props: Props) {
  // Remount on authorization scope changes so a previous actor's bytes are never painted.
  const scope = `${props.token}:${props.projectId}:${props.recordKind}:${props.recordId}`;
  return props.presentation === "documents"
    ? <Documents key={scope} {...props} />
    : <LegacyAttachments key={scope} {...props} />;
}

function LegacyAttachments(props: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<KnowledgePage<KnowledgeAttachment> | null>(null);
  const [error, setError] = useState(false);
  const { busy, download } = useDownload(props, setError);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void knowledgeRequest<KnowledgePage<KnowledgeAttachment>>(props.token, "attachments", { projectId: props.projectId, recordId: props.recordId, recordKind: props.recordKind, offset }, abort.signal)
      .then(value => { if (!abort.signal.aborted) { setPage(value); setError(false); } })
      .catch(() => { if (!abort.signal.aborted) { setPage(null); setError(true); } });
    return () => abort.abort();
  }, [props.token, props.projectId, props.recordId, props.recordKind, offset, open, props.changeVersion]);
  return <section className="space-y-3 border-t border-border pt-4">
    <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}><Paperclip aria-hidden className="size-4" />{t("knowledge.attachments")}</Button>
    {open && <>
      {error && <p role="alert" className="text-sm">{t("knowledge.attachmentsFailed")}</p>}
      {!error && !page && <p role="status">{t("knowledge.loading")}</p>}
      {page && !page.items.length && <p className="text-sm text-muted-foreground">{t("knowledge.noAttachments")}</p>}
      {page?.items.map(item => <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"><span className="min-w-0 break-words text-sm">{item.filename}<span className="block text-xs text-muted-foreground">{Math.ceil(item.size / 1024)} KB</span></span><Button variant="outline" size="sm" disabled={busy} aria-label={`${t("knowledge.downloadAttachment")}: ${item.filename}`} onClick={() => void download(item)}><Download aria-hidden className="size-4" />{t("knowledge.downloadAttachment")}</Button></div>)}
      {page && (offset > 0 || page.nextOffset !== null) && <div className="flex gap-2"><Button variant="outline" disabled={!offset} onClick={() => { setPage(null); setOffset(Math.max(0, offset - 25)); }}>{t("knowledge.previous")}</Button><Button variant="outline" disabled={page.nextOffset === null} onClick={() => { setOffset(page.nextOffset!); setPage(null); }}>{t("knowledge.nextPage")}</Button></div>}
    </>}
  </section>;
}

function currentDocumentId(props: AttachmentScope): string {
  const url = new URL(window.location.href);
  const expectedTab = props.recordKind === "memory" ? "memory" : props.recordKind === "task" ? "backlog" : "discussions";
  if (url.searchParams.get("view") !== "knowledge" || url.searchParams.get("knowledgeProject") !== props.projectId || url.searchParams.get("knowledgeTab") !== expectedTab || url.searchParams.get("record") !== props.recordId) return "";
  return url.searchParams.get("document") ?? "";
}

function Documents(props: Props) {
  const { t } = useI18n();
  const { token, projectId, recordId, recordKind, changeVersion, onDocumentChange } = props;
  const [files, setFiles] = useState<KnowledgeAttachment[] | null>(null);
  const [listingError, setListingError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selectedId, setSelectedId] = useState(() => currentDocumentId(props));
  const [downloadError, setDownloadError] = useState(false);
  const { busy, download } = useDownload(props, setDownloadError);
  const triggerRef = useRef<HTMLAnchorElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const wasSelected = useRef(selectedId);
  const noteHashRef = useRef<string | null>(null);

  useEffect(() => {
    const sync = () => setSelectedId(currentDocumentId({ token, projectId, recordId, recordKind }));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [token, projectId, recordId, recordKind]);
  useEffect(() => { onDocumentChange?.(Boolean(selectedId)); }, [selectedId, onDocumentChange]);
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const discovered: KnowledgeAttachment[] = [];
        let offset = 0;
        while (offset < ATTACHMENT_DISCOVERY_LIMIT) {
          const page = await knowledgeRequest<KnowledgePage<KnowledgeAttachment>>(token, "attachments", { projectId, recordId, recordKind, offset, limit: 100 }, abort.signal);
          if (abort.signal.aborted) return;
          if (page.items.some(file => !attachmentMatchesScope(file, projectId, recordKind, recordId))) throw new Error("scope");
          discovered.push(...page.items.slice(0, ATTACHMENT_DISCOVERY_LIMIT - discovered.length));
          if (page.nextOffset === null || page.nextOffset <= offset || !page.items.length) break;
          offset = page.nextOffset;
        }
        if (!abort.signal.aborted) { setFiles(previous => keepUnchangedAttachments(previous, discovered)); setListingError(false); }
      } catch { if (!abort.signal.aborted) { setFiles(null); setListingError(true); } }
    })();
    return () => abort.abort();
  }, [token, projectId, recordId, recordKind, changeVersion, retry]);
  useEffect(() => {
    if (selectedId && selectedId !== wasSelected.current) headingRef.current?.focus();
    if (!selectedId && wasSelected.current) {
      const previousId = wasSelected.current;
      requestAnimationFrame(() => {
        const matchingLink = Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-document-id]") ?? [])
          .find(link => link.dataset.documentId === previousId);
        (matchingLink ?? (triggerRef.current?.isConnected ? triggerRef.current : null) ?? document.querySelector<HTMLElement>("[data-memory-detail] h3"))?.focus();
      });
    }
    wasSelected.current = selectedId;
  }, [selectedId]);
  const navigate = useCallback((id: string | null, hash?: string) => {
    if (id && !selectedId) noteHashRef.current = window.location.hash;
    const nextHash = id ? hash : noteHashRef.current ?? "";
    window.history.pushState(null, "", documentUrl(id, nextHash));
    if (!id) noteHashRef.current = null;
    setSelectedId(id ?? "");
  }, [selectedId]);
  const currentFiles = files;
  const selected = currentFiles?.find(file => file.id === selectedId);
  return <section className="min-w-0 space-y-3 border-t border-border pt-4" aria-label={t("knowledge.documents")}>
    <h4 className={selectedId ? "sr-only" : "flex items-center gap-2 font-medium"}><Paperclip aria-hidden className="size-4" />{t("knowledge.documents")}</h4>
    {listingError && <div role="alert" className="space-y-2 text-sm"><p>{t("knowledge.attachmentsFailed")}</p><Button variant="outline" size="sm" onClick={() => { setFiles(null); setListingError(false); setRetry(value => value + 1); }}>{t("knowledge.retry")}</Button></div>}
    {!currentFiles && !listingError && <p role="status" className="text-sm">{t("knowledge.loading")}</p>}
    {currentFiles?.length === 0 && <p className="text-sm text-muted-foreground">{t("knowledge.noAttachments")}</p>}
    {currentFiles && <ul ref={listRef} hidden={Boolean(selectedId)} className="space-y-2">{currentFiles.map(file => <li key={file.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border p-3">
      <FileText aria-hidden className="size-4 shrink-0" /><span className="min-w-0 flex-1 break-words text-sm">{displayPath(file)}<span className="block text-xs text-muted-foreground">{formatLabel(file)} · {Math.ceil(file.size / 1024)} KB</span></span>
      <a data-document-id={file.id} href={documentUrl(file.id)} className="inline-flex min-h-8 items-center rounded-md px-2 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring" aria-current={selectedId === file.id ? "page" : undefined} aria-label={`${t("knowledge.openDocument")}: ${file.filename}`} onClick={event => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); triggerRef.current = event.currentTarget; navigate(file.id); }}>{t("knowledge.openDocument")}</a>
      <Button variant="outline" size="sm" disabled={busy} aria-label={`${t("knowledge.downloadAttachment")}: ${file.filename}`} onClick={() => void download(file)}><Download aria-hidden className="size-4" />{t("knowledge.downloadAttachment")}</Button>
    </li>)}</ul>}
    {downloadError && <p role="alert" className="text-sm">{t("knowledge.attachmentsFailed")}</p>}
    {selectedId && <article className="min-w-0 space-y-4" aria-label={t("knowledge.documentPreview")}>
      <div className="flex flex-wrap items-center justify-between gap-2"><Button variant="ghost" size="sm" onClick={() => navigate(null)}><ArrowLeft aria-hidden className="size-4" />{t("knowledge.backToNote")}</Button>
        {selected && <Button variant="outline" size="sm" disabled={busy} aria-label={`${t("knowledge.downloadAttachment")}: ${selected.filename}`} onClick={() => void download(selected)}><Download aria-hidden className="size-4" />{t("knowledge.downloadAttachment")}</Button>}
      </div>
      <h4 ref={headingRef} tabIndex={-1} className="break-words text-base font-medium outline-none">{selected ? displayPath(selected) : t("knowledge.documentUnavailable")}</h4>
      {currentFiles && !selected && <p role="alert">{t("knowledge.documentUnavailable")}</p>}
      {selected && <PreviewDocument key={`${selected.id}:${selected.sha256}:${selected.mediaType}:${selected.size}`} file={selected} files={currentFiles!} props={props} navigate={navigate} />}
    </article>}
  </section>;
}

function SiblingImage({ file, alt, props }: { file: KnowledgeAttachment; alt: string; props: Props }) {
  const { t } = useI18n();
  const { token, projectId, recordId, recordKind } = props;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController(); let blobUrl: string | null = null;
    void fetchChecked(file, { token, projectId, recordId, recordKind }, abort.signal).then(bytes => {
      if (abort.signal.aborted) return;
      if (bytes.length > IMAGE_PREVIEW_LIMIT || !imageHasSignature(bytes, imageMime(file))) throw new Error("invalid");
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: imageMime(file) })); setUrl(blobUrl);
    }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => { abort.abort(); if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [file, token, projectId, recordId, recordKind]);
  if (failed) return <span>{alt || file.filename} — {t("knowledge.documentInvalid")}</span>;
  if (!url) return <span role="status">{alt || file.filename} — {t("knowledge.documentLoading")}</span>;
  return <img src={url} alt={alt || file.filename} className="max-h-[70vh] max-w-full object-contain" onError={() => setFailed(true)} />;
}

type PreviewDocumentProps = { file: KnowledgeAttachment; files: KnowledgeAttachment[]; props: Props; navigate: (id: string | null, hash?: string) => void };
const PreviewDocument = memo(function PreviewDocument({ file, files, props, navigate }: PreviewDocumentProps) {
  const { t } = useI18n();
  const { token, projectId, recordId, recordKind } = props;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failure, setFailure] = useState<"load" | "invalid" | null>(null);
  const [retry, setRetry] = useState(0);
  const kind = previewKind(file);
  useEffect(() => {
    if (kind === "unsupported" || kind === "large") return;
    const abort = new AbortController(); let blobUrl: string | null = null;
    void fetchChecked(file, { token, projectId, recordId, recordKind }, abort.signal).then(bytes => {
      if (abort.signal.aborted) return;
      if (bytes.length !== file.size || bytes.length > (kind === "image" ? IMAGE_PREVIEW_LIMIT : 256 * 1024)) throw new Error("invalid");
      if (kind === "image") {
        if (!imageHasSignature(bytes, imageMime(file))) throw new Error("invalid");
        blobUrl = URL.createObjectURL(new Blob([bytes], { type: imageMime(file) }));
        setPreview({ id: file.id, kind, url: blobUrl });
      } else {
        let text: string;
        try { text = decodePreviewText(bytes); } catch { throw new Error("invalid"); }
        setPreview({ id: file.id, kind, text });
      }
      setFailure(null);
    }).catch(error => { if (!abort.signal.aborted) setFailure(error instanceof Error && (error.message === "invalid" || error.message === "large") ? "invalid" : "load"); });
    return () => { abort.abort(); if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [file, token, projectId, recordId, recordKind, kind, retry]);
  useEffect(() => {
    if (preview?.kind !== "markdown" || !window.location.hash) return;
    let id: string;
    try { id = decodeURIComponent(window.location.hash.slice(1)); } catch { return; }
    const frame = requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [preview]);
  if (kind === "unsupported" || kind === "large") return <p role="status">{t(kind === "large" ? "knowledge.documentTooLarge" : "knowledge.documentUnsupported")}</p>;
  if (failure) return <div role="alert" className="space-y-2"><p>{t(failure === "invalid" ? "knowledge.documentInvalid" : "knowledge.documentFailed")}</p><Button variant="outline" size="sm" onClick={() => { setFailure(null); setPreview(null); setRetry(value => value + 1); }}>{t("knowledge.retry")}</Button></div>;
  if (!preview || preview.id !== file.id) return <p role="status">{t("knowledge.documentLoading")}</p>;
  if (preview.kind === "image") return <img src={preview.url} alt={file.filename} className="max-h-[70vh] max-w-full object-contain" onError={() => setFailure("invalid")} />;
  if (preview.kind === "text") return <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words text-sm" aria-label={t("knowledge.documentPreview")}>{preview.text}</pre>;
  const headingCounts = new Map<string, number>();
  const heading = (children: ReactNode, level: number) => {
    const text = headingText(children).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "section";
    const count = headingCounts.get(text) ?? 0;
    headingCounts.set(text, count + 1);
    const id = count ? `${text}-${count}` : text;
    const Tag = `h${level}` as "h1";
    return <Tag id={id} className="scroll-mt-6 break-words font-semibold text-foreground" style={{ fontSize: `${Math.max(1, 1.55 - level * 0.13)}rem` }}>{children}</Tag>;
  };
  return <div className="min-w-0 max-w-[80ch] space-y-4 break-words text-sm leading-7 text-foreground [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 [&_li]:my-1 [&_p]:my-3">
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
      h1: ({ children }) => heading(children, 1), h2: ({ children }) => heading(children, 2), h3: ({ children }) => heading(children, 3), h4: ({ children }) => heading(children, 4), h5: ({ children }) => heading(children, 5), h6: ({ children }) => heading(children, 6),
      table: ({ children }) => <div role="region" tabIndex={0} aria-label={t("knowledge.documentTable")} className="my-4 max-w-full overflow-x-auto"><table className="w-max min-w-full border-collapse text-left [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-1">{children}</table></div>,
      pre: ({ children }) => <div role="region" tabIndex={0} aria-label={t("knowledge.documentCode")} className="my-4 max-w-full overflow-x-auto rounded-md bg-muted p-3"><pre className="w-max min-w-full text-xs leading-5">{children}</pre></div>,
      a: ({ href, children }) => {
        const target = resolveDocumentLink(href ?? "", file, files);
        if (target.kind === "external") return <a href={target.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{children}</a>;
        if (target.kind === "anchor") return <a href={target.hash} className="underline underline-offset-2">{children}</a>;
        if (target.kind === "attachment") return <a href={documentUrl(target.file.id, target.hash)} className="underline underline-offset-2" onClick={event => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(target.file.id, target.hash); }}>{children}</a>;
        return <span title={t("knowledge.documentLinkUnavailable")} className="text-muted-foreground underline decoration-dotted">{children} ({t("knowledge.documentLinkUnavailable")})</span>;
      },
      img: ({ src, alt }) => {
        const source = typeof src === "string" ? src : "";
        const target = resolveDocumentLink(source, file, files);
        return target.kind === "attachment" && previewKind(target.file) === "image"
          ? <SiblingImage key={`${target.file.id}:${target.file.sha256}:${target.file.mediaType}:${target.file.size}`} file={target.file} alt={alt ?? ""} props={props} />
          : <span>{alt || source} — {t("knowledge.documentLinkUnavailable")}</span>;
      },
    }}>{preview.text}</ReactMarkdown>
  </div>;
}, (previous, next) => previous.file === next.file && previous.files === next.files && previous.navigate === next.navigate
  && previous.props.token === next.props.token && previous.props.projectId === next.props.projectId
  && previous.props.recordId === next.props.recordId && previous.props.recordKind === next.props.recordKind);
