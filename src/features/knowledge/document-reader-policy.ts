import type { KnowledgeAttachment } from "@/shared/contracts/knowledge-attachments";

export const TEXT_PREVIEW_LIMIT = 256 * 1024;
export const IMAGE_PREVIEW_LIMIT = 5 * 1024 * 1024;
export const ATTACHMENT_DISCOVERY_LIMIT = 1000;

export type PreviewKind = "markdown" | "text" | "image" | "unsupported" | "large";

export function previewKind(file: KnowledgeAttachment): PreviewKind {
  const name = file.filename.toLowerCase();
  const type = file.mediaType.toLowerCase().split(";")[0].trim();
  if (/\.(svg|html?|xhtml)$/.test(name) || type === "image/svg+xml" || type === "text/html" || type === "application/xhtml+xml") return "unsupported";
  const markdown = /\.(md|markdown)$/.test(name) || type === "text/markdown";
  const plain = type === "text/plain" || /\.(txt|text)$/.test(name);
  const image = /^(image\/(png|jpeg|gif|webp))$/.test(type) || /\.(png|jpe?g|gif|webp)$/.test(name);
  if (!markdown && !plain && !image) return "unsupported";
  if (file.size > (image ? IMAGE_PREVIEW_LIMIT : TEXT_PREVIEW_LIMIT)) return "large";
  return image ? "image" : markdown ? "markdown" : "text";
}

export function decodePreviewText(bytes: Uint8Array): string {
  if (bytes.byteLength > TEXT_PREVIEW_LIMIT) throw new Error("large");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function attachmentMatchesScope(file: KnowledgeAttachment, projectId: string, recordKind: string, recordId: string): boolean {
  return file.projectId === projectId && file.recordKind === recordKind && file.recordId === recordId;
}

function normalizedPath(path: string): string | null {
  if (!path || path.startsWith("/") || path.startsWith("\\") || path.includes("\\") || path.includes("?")) return null;
  if (path.includes("\0")) return null;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join("/") || null;
}

export type DocumentLink =
  | { kind: "external"; href: string }
  | { kind: "anchor"; hash: string }
  | { kind: "attachment"; file: KnowledgeAttachment; hash: string }
  | { kind: "unavailable" };

export function resolveDocumentLink(href: string, current: KnowledgeAttachment, files: KnowledgeAttachment[]): DocumentLink {
  if (href.startsWith("#")) return { kind: "anchor", hash: href };
  if (/^https?:\/\//i.test(href)) {
    try { const url = new URL(href); return url.protocol === "http:" || url.protocol === "https:" ? { kind: "external", href: url.href } : { kind: "unavailable" }; }
    catch { return { kind: "unavailable" }; }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return { kind: "unavailable" };
  const [relative, fragment] = href.split("#", 2);
  if (!relative || relative.startsWith("/") || relative.startsWith("\\") || relative.includes("\\")) return { kind: "unavailable" };
  let decodedRelative: string;
  try { decodedRelative = decodeURIComponent(relative); } catch { return { kind: "unavailable" }; }
  if (decodedRelative.startsWith("/") || decodedRelative.startsWith("\\") || decodedRelative.includes("\\")) return { kind: "unavailable" };
  const sourcePath = "relativePath" in current && typeof current.relativePath === "string" ? current.relativePath : current.filename;
  const base = normalizedPath(sourcePath);
  if (!base) return { kind: "unavailable" };
  const path = normalizedPath([base.split("/").slice(0, -1).join("/"), decodedRelative].filter(Boolean).join("/"));
  if (!path) return { kind: "unavailable" };
  const matches = files.filter(file => normalizedPath("relativePath" in file && typeof file.relativePath === "string" ? file.relativePath : file.filename) === path);
  return matches.length === 1 ? { kind: "attachment", file: matches[0], hash: fragment ? `#${fragment}` : "" } : { kind: "unavailable" };
}

export function documentUrl(fileId: string | null, hash?: string): string {
  const url = new URL(window.location.href);
  const hadDocument = url.searchParams.has("document");
  if (fileId) url.searchParams.set("document", fileId);
  else url.searchParams.delete("document");
  if (hash !== undefined) url.hash = hash;
  else if (hadDocument) url.hash = "";
  return `${url.pathname}${url.search}${url.hash}`;
}
