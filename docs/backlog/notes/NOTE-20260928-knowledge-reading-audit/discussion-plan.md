# Discussion clarity stage

Owner accepted this next stage after accepting PR #62: readable discussion topics, less repeated import text and useful context for choosing a thread. Authorized workflow remains Sol coding on an isolated worktree, serial managed verification, pilot acceptance, n8n review and merge after green checks.

Base 114ccbd; implementation delegated to Sol high on rework/discussion-clarity. Root owns standards, evidence and delivery. This bounded stage does not implement global search, reply chronology or audit-history redesign, and does not change the accepted free-form body/description model.

## Evidence

The accepted preview still lists 12 generated titles such as Imported discussion: FEAT-20260829-license-and-package-release, with no preview or reply count. Its reader repeats the generated title and import path before the conversation. Inspected [list](discussion-screenshots/before-list.png) and [reader](discussion-screenshots/before-reader.png), 1440x1000 PL dark, application f7b6f1d.

The importer records task provenance, historical reply provenance and a derived_from task-to-thread relation, but no direct thread provenance row. Thread title/body are deterministic generated strings. Normalizing a prefix alone would misrepresent native records.

## Contract

Add an optional bounded presentation projection on existing authorized thread list/detail reads: display title, short preview, verified-import indication and complete reply count. Preserve raw title/body, IDs, revisions, history and portable export. No data rewrite or schema migration.

Use source topic only when the same-project provenance proves the generated thread identity, relation and historical replies; exact generated title/body must still match. Missing, ambiguous, conflicting or edited evidence falls back to raw content. The historical source title/context must not be presented as an edited current task. Native descriptions remain plain text. Counts come from the full thread, not the loaded reply page. Do not label import timestamps as conversation activity.

Discussion search matches the visible display title and retains original title/ID search. Apply consistent case/accent folding and literal substring matching before pagination. No client-only filtering of a loaded page, unbounded browser payload or per-row browser fetch.

## Composition and standard

Use the existing shadcn style and a clear title/description/metadata hierarchy, inspired by [Item](https://ui.shadcn.com/docs/components/radix/item). Full list uses available width; split reader stays readable. Show the same topic in list and reader. Verified import provenance and raw generated fields remain accessible in secondary details; useful conversation content comes first. Imported previews use meaningful source context, native previews use their body. Do not fabricate a last-reply summary or hide authored content based only on a text prefix.

Preserve real hrefs, modified clicks, pagination, scope isolation, reader expand/return, mobile Back/focus, native create/reply and authorization. Correct the discussion search placeholder which currently refers to tasks.

## Acceptance

Backend coverage: valid import; native lookalike; missing/ambiguous/stale/edited provenance; project isolation; unchanged raw/export fields; displayed-title search beyond the first page; raw ID and literal queries; complete reply counts exceeding one page.

Browser coverage: meaningful imported/native rows, consistent reader topic and secondary originals, search, selection/return, reply count, PL/EN and mobile. Root runs managed check, build and UI with one heavy job at a time, then inspects the isolated pilot at desktop1440/1366, mobile390/320, short viewport and actual200% zoom. Record screenshots and limits. Dispatch n8n once, resolve all concerns with evidence and merge only the checked final head. Broader GUI rework stays open.

## Implementation availability

The initial Sol turn stopped at the account usage limit before writing code. The owner reset that limit and explicitly requested continuing with Sol; implementation resumed in the same worktree. The prior model-choice question is resolved. Baseline browser session is closed, its claim released, and the accepted previous preview continues running.
