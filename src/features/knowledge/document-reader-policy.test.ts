import { describe, expect, it } from "vitest";
import type { KnowledgeAttachment } from "@/shared/contracts/knowledge-attachments";
import { ATTACHMENT_DISCOVERY_LIMIT, IMAGE_PREVIEW_LIMIT, TEXT_PREVIEW_LIMIT, attachmentMatchesScope, decodePreviewText, previewKind, resolveDocumentLink } from "./document-reader-policy";

const file = (id: string, filename: string, mediaType = "application/octet-stream", size = 10): KnowledgeAttachment => ({
  id, filename, mediaType, size, projectId: "p", recordKind: "memory", recordId: "m", sha256: "x", createdBy: "a", createdAt: "2026-09-28",
});

describe("document reader policy", () => {
  it("recognizes imported octet-stream documents by safe extension and bounds previews", () => {
    expect(previewKind(file("1", "plan.md"))).toBe("markdown");
    expect(previewKind(file("2", "note.txt"))).toBe("text");
    expect(previewKind(file("3", "diagram.png"))).toBe("image");
    expect(previewKind(file("4", "script.html", "text/plain"))).toBe("unsupported");
    expect(previewKind(file("5", "vector.svg", "image/svg+xml"))).toBe("unsupported");
    expect(previewKind(file("6", "plan.md", "text/plain", TEXT_PREVIEW_LIMIT + 1))).toBe("large");
    expect(previewKind(file("7", "diagram.webp", "image/webp", IMAGE_PREVIEW_LIMIT + 1))).toBe("large");
    expect(ATTACHMENT_DISCOVERY_LIMIT).toBe(1000);
  });

  it("rejects malformed UTF-8 and oversized decoded text", () => {
    expect(decodePreviewText(new TextEncoder().encode("Zażółć"))).toBe("Zażółć");
    expect(() => decodePreviewText(Uint8Array.from([0xc3, 0x28]))).toThrow();
    expect(() => decodePreviewText(new Uint8Array(TEXT_PREVIEW_LIMIT + 1))).toThrow("large");
  });

  it("resolves only unique authorized sibling paths, decoding href exactly once", () => {
    const current = { ...file("1", "plan.md"), relativePath: "notes/plan.md" };
    const target = { ...file("2", "database-portability.md"), relativePath: "notes/database-portability.md" };
    const image = { ...file("3", "photo %.png"), relativePath: "assets/photo %.png" };
    const literal = { ...file("4", "%2e.md"), relativePath: "notes/%2e.md" };
    const files = [current, target, image, literal];
    expect(resolveDocumentLink("./database-portability.md", current, files)).toMatchObject({ kind: "attachment", file: target });
    expect(resolveDocumentLink("../assets/photo%20%25.png", current, files)).toMatchObject({ kind: "attachment", file: image });
    expect(resolveDocumentLink("%252e.md", current, files)).toMatchObject({ kind: "attachment", file: literal });
    expect(resolveDocumentLink("../../outside.md", current, files).kind).toBe("unavailable");
    expect(resolveDocumentLink("/database-portability.md", current, files).kind).toBe("unavailable");
    expect(resolveDocumentLink("%2fdatabase-portability.md", current, files).kind).toBe("unavailable");
    expect(resolveDocumentLink("./database-portability.md", current, [...files, { ...target, id: "duplicate" }]).kind).toBe("unavailable");
  });

  it("allows only HTTP(S) external links and scopes attachment responses", () => {
    const current = file("1", "plan.md");
    for (const href of ["javascript:alert(1)", "data:text/html,x", "file:///tmp/a", "blob:abc", "//tracker.example/a", "https://x.example@evil.example/"]) {
      const result = resolveDocumentLink(href, current, []);
      if (href.startsWith("https:")) expect(result).toMatchObject({ kind: "external", href: "https://x.example@evil.example/" });
      else expect(result.kind).toBe("unavailable");
    }
    expect(resolveDocumentLink("https://example.com", current, []).kind).toBe("external");
    expect(attachmentMatchesScope(current, "p", "memory", "m")).toBe(true);
    expect(attachmentMatchesScope(current, "other", "memory", "m")).toBe(false);
  });
});
