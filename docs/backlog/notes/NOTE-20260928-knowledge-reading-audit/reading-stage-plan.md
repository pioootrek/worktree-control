# Knowledge reading stage: implementation contract

Owner started stage 2 on 2026-09-28 after foundation PR #58. Base: `84cdd44`.
Coding is delegated to Sol high in three isolated worktrees: read projection,
document reader, and Memory composition. Root integrates on
`rework/knowledge-reading`, runs serialized managed verification, performs
pilot browser acceptance, dispatches n8n review and merges after green checks.

## Outcome and scope

Read Markdown, text and raster images inside Knowledge without downloading
first. Imported Memory shows a real summary and its documents, with original
stored content still available in a disclosure. A document has a copyable URL,
links to known sibling files and a predictable return to its note/list.
Imported discussion titles, history/chronology and attachment search indexing
remain separate follow-on stages. No migration, reimport or durable body rewrite.

## Read projection

`KnowledgeMemory` and search hits may carry `reading` with kind `imported-note`,
bodyFormat `text`, `metadata` or `manifest`, and a nullable bounded summary.
Only saved import provenance for the exact project/record may establish this.
The source payload must reproduce the current stored body using the importer's
actual normalization. A JSON-looking native body is still ordinary text; an
edited body differing from its import is ordinary current content. Unchanged
body after approval/archive can remain presented as imported content. Conflicting
or malformed provenance falls back conservatively. The projection must not
enter stored mutation results, history or logical exports accidentally.

For metadata use only actual string summary/description fields, not guesses
from identifiers or arbitrary object keys. Preserve matched excerpts for a
nonempty search. Keep original bytes and source metadata available.

Imported attachments currently store only a basename and octet-stream MIME.
An optional record-relative path therefore comes from matching attachment and
parent-note provenance, with matching current content hash and source identity.
Never guess a nested link's target by basename. Existing/native files can use
their known filename. No new SQLite schema is required for these projections.

## Document reader

Reuse authorized `attachments` and `attachment` operations. Validate parent,
project and record kind before displaying bytes. Scope and cancel requests on
token/selection changes so previous content cannot appear under a new identity.
Keep download separate and byte-preserving.

The URL uses `document=<attachment-id>` alongside the existing project/tab/record
selection. Other selections remove the document target. Back/Forward, direct
links, new tabs and returning to the note remain supported. Move focus to the
document heading on explicit open and back to a surviving trigger on return.

Preview Markdown/plain UTF-8 up to 256 KiB and PNG/JPEG/GIF/WebP up to 5 MiB.
Unsupported, oversized, invalid and inaccessible files have distinct truthful
fallbacks and appropriate retry/download actions. Discover at most the existing
1000-file project bound; do not eagerly fetch all document bodies.

Use react-markdown and remark-gfm for headings, lists, tables and code. Do not
execute raw HTML, SVG, scripts or MDX. Markdown links allow explicit HTTP(S)
navigation; relative links resolve only exact authorized sibling paths. Reject
unsafe schemes and path traversal, disclose missing/ambiguous targets. Do not
automatically load external images. Revoke object URLs when replaced/unmounted.
Prose uses a readable measure; code/tables scroll inside named regions.

References checked against official documentation:
[react-markdown](https://github.com/remarkjs/react-markdown),
[remark-gfm](https://github.com/remarkjs/remark-gfm),
[shadcn Collapsible](https://ui.shadcn.com/docs/components/radix/collapsible).
Keep the existing Radix preset and semantic tokens.

## Acceptance

Unit/service coverage: provenance evidence, native edits, ambiguous and malformed
inputs, project scope, relative path resolution, preview limits and URL safety.
UI coverage: text and native JSON versus imported manifest, raw disclosure,
Markdown table/code, authorized image, sibling navigation, URL reload, Back,
permission failure/retry, token change, exact original download and mobile bounds.
Use the managed check/build/UI and relevant transport suites, then inspect the
isolated pilot at desktop/mobile, PL/EN, dark/light, short viewport and real 200%
zoom. Record actual revisions, screenshots and any unverified behavior.
