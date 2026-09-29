# Knowledge relations and search destinations

Owner accepted this next bounded GUI stage with “Startuj” on 2026-09-29 after PR #64. Application/test implementation delegated to Sol high on isolated `rework/knowledge-navigation`, base `125b644`. Root owns standards, managed verification, pilot screenshots, n8n all-review and merge after green CI.

## Observed problems

Audit KR-05: relation links show a generic kind and hash without topic or direction. Current task/thread reader hides them in technical details. Current renderer routes memory relations as discussions and leaves reply relations as bare IDs. Direction detection compares only ID, despite IDs being scoped by kind.

Audit KR-08: project search returns a reply with an empty title and the first 300 body characters. MemoryPanel discards its reply ID and navigates to the beginning of the parent thread; pages beyond the first are not addressable. Search controls live in the Memory component and are lost when it unmounts to open a different record kind. The existing chronology query is authoritative for locating a reply page.

## Contract

Relations identify the destination with its current title (or verified imported display title), kind, applicable status and direction/type relative to the selected record. Keep IDs secondary and unavailable targets explicit. Route every supported kind correctly. Place useful relationships in the reading flow after main content, outside technical metadata; omit empty supporting space. Preserve relation pagination and stored/exported records. Enrich a bounded page server-side under existing project authorization, not one browser request per row or an unbounded project scan.

Project search retains its existing surface and filters. A reply result identifies its parent discussion and shows bounded plain-text context around a literal match. Keep existing Unicode normalization/case matching and safe content rendering. If an alternate visible topic becomes searchable, apply that before pagination. No global palette or attachment full-text indexing in this slice.

An exact reply has a stable URL containing project, discussion, thread ID and reply ID. Ordinary click, modified click, reload and browser Back/Forward reach the same record. Locate its containing page on the server using the same ordering as ordinary replies, without fetching every page in the client. Wrong project/thread or missing target produces an explicit safe state; no foreign content disclosure. Mark and focus/scroll the requested reply once after load, below sticky UI. Passive refresh must not steal focus or scroll repeatedly. Manual page changes and unrelated navigation clear obsolete targets.

Returning to search restores query, filters, page, logical position and originating result focus, scoped to identity/project. Use URL or owned scoped state. Preserve document navigation, reader expansion/return, native author/time and imported chronology. Shared reply source links retain exact reply identity when the thread is known. Historical revision claims, memory editor and audit history are not redesigned here.

## Composition and boundaries

Use existing shadcn/Radix primitives, semantic tokens and native anchors. Inspiration: [shadcn Item](https://ui.shadcn.com/docs/components/radix/item), read on 2026-09-29, for title/description/kind/action hierarchy. No preset, library or data-format migration. Extract cohesive feature/query helpers when needed rather than growing the main dashboard or adding a generic routing framework. Keep one dashboard subscription and authorization in shared operations. Any necessary API changes are additive; schema changes require a concrete justification first.

## Acceptance

Backend coverage: relation direction including same ID/different kinds, all record destinations, missing/cross-project targets and paginated batches; late literal/Unicode snippet matches; exact reply beyond 25 with mixed imported/native chronology; wrong thread/project and authorization; unchanged raw data/export. Verify indexed/bounded reads.

UI coverage: PL/EN desktop/mobile relation links, search result to highlighted/focused page-two reply, return to retained search state/focus, direct URL reload and Back/Forward, rapid selection cancellation, manual page reset and expand/return. Root inspects isolated-pilot desktop, narrow/short viewport, dark/light and actual 200% zoom. Run managed check/build/UI serially, n8n all once, classify/fix all feedback, then merge only final-head green CI. Broader GUI/history rework remains open.
