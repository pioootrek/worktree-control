---
audience: "contributors designing and implementing dashboard interfaces"
last_reviewed: "2026-09-28"
source_of_truth: "UI composition and interaction standards for new dashboard work"
status: "active"
---

# Dashboard UI standards

Apply these standards to new or changed dashboard flows. They are a working
contract for the GUI rework, not a claim that every existing screen complies.
The [approved visual direction](backlog/notes/NOTE-20260911-approved-gui-direction/direction.md)
remains authoritative. The [layout proposal](backlog/notes/NOTE-20260928-knowledge-reading-audit/layout-direction.md)
explains the audit evidence and staged adoption.

## Composition

Use the existing owned shadcn components, semantic theme tokens and Lucide
icons. Keep the configured Radix preset. Extend a presentation component when
it has a concrete repeated use; feature compositions own domain state and data
access. Styling changes retain the single dashboard subscription and polling
owner. Adding a screen never creates a second refresh loop.

The frame has one navigation sidebar, one context header and a main work area.
Show the current project scope and section once where they remain easy to find.
Keep navigation labels visible in expanded mode. Preferences and administration
belong in named menus; important errors, unsafe authentication mode and stale
or unavailable data stay visible outside those menus. Session actions describe
their actual scope: one global sign-out for a shared installation session; an
independent Knowledge credential has a distinct disconnect action in Preferences,
which preserves the runtime session. Keep these actions out of content toolbars.
A green status must
represent known state, not merely absence of a rendered error.

Use three content patterns:

| Task | Pattern | Detail behavior |
| --- | --- | --- |
| Operate on projects, tests or resources | Compact summary, toolbar, list/table | Short supplemental information in a Sheet or disclosure |
| Read tasks, discussions and memory | Useful list before selection; list and reader after selection | Wide reader, with a clear back/expand action; long documents are page content |
| Diagnose logs | Scope and search followed by console | Matching project/run and selected hit visible, follow/pause explicit |

Dialogs are for focused forms and confirmations. Avoid modal-in-modal
compositions and controls whose trigger disappears before focus can return.
Do not make every section a card. Use spacing and typography before extra
borders. Runtime project identity and Knowledge project identity remain
separate until an explicit authorized mapping exists.

## Density and controls

Put the primary content and action before secondary metrics. Use compact
summaries in operating views; detailed resource metrics belong in Resources.
Empty queues and supplementary empty sections should not reserve large space.
Before selecting a Knowledge record, use the available width for its list.

One toolbar contains search, frequent filters, additional filters and the
section action. Give input, select and button controls aligned edges and labels.
A collapsed filter area exposes its active state/count, and filters remain
clearable. Search retains a useful width when labels wrap. Do not reduce text
to fit arbitrary column counts.

Use readable body text and subdued supporting metadata. Limit prose line
length; retain natural widths/scrolling for code and data tables. Show full long
names through an accessible detail, wrapping or expansion, not hover alone.
Use lime for selection and the main action. States include a word or icon as
well as color; ordinary stopped/reserved states are not errors. Both themes
need readable text and visible focus.

## State and operations

Selection is navigation or an operation target, never an implicit mutation.
The running server identity stays distinct from the selected worktree. Keep
actions attached to an explicit target and preserve confirmation and ownership
rules. Disabled operations expose the reason without requiring hover.

Preserve list query, filter, page and logical position when opening/closing a
reader or detail. Scope state by project and identity so it cannot select a
record from a previous authorization context. Loading, no results, no data,
stale data and failure are separate states with appropriate next actions.
Start a new result set at the top after an explicit search, filter or page
change. Passive refreshes and returning from a reader preserve the user's
position instead.

Keep test command outcome, source observations and current freshness distinct.
Display unknown information honestly. Presentation must not relax backend
admission, authorization, revision checks or source-attribution rules.
Known local changes remain visible even when a test's freshness is unknown;
they do not prove that the test covered the current working tree.

Explain an unknown test relevance with the evidence that prevents confirmation,
such as stale Git metadata, a missing worktree, incomplete observations or local
changes. Preserve known command outcomes and at-run observations alongside that
reason. Show an applicable recovery action; refreshing current Git metadata can
reassess relevance but cannot repair missing historical execution evidence.
Distinguish the revision recorded at enqueue from observations immediately before
and after execution. None of these observations proves every intermediate state.
A test's output action targets that exact run. Runtime-failure navigation targets
the matching project and known attempted worktree; never infer the failed branch
from the currently selected worktree. Failure labels describe observed facts:
a generic failed phase does not prove a startup failure rather than a later
crash or stop failure. If a diagnostic recommends a recovery action, expose
that action in the same view whenever the user is authorized to perform it.

## Focus, scrolling and small screens

Use native links/buttons and named landmarks. Every icon-only action has an
accessible name; both PL and EN translations are required. Opening a modal
moves focus inside; closing returns it to a visible stable trigger. Opening a
mobile reader focuses its heading, and Back returns to the originating item
or a meaningful surviving list target.
Returning focus belongs to closing a reader or navigating Back. Changing
project or section clears the old return target and preserves focus on the
control the user just operated.

Operating lists normally scroll the page. A desktop reader may deliberately
have separate list/content scroll areas; consoles may own their scroll. Name
those regions and prevent sticky UI from covering focused elements or hits.
Keep desktop reader expand/restore controls outside the scrolling content so
the previous layout remains reachable at every reading position. Expanding or
restoring a reader retains the selected record, filters, and list position.
An automatically collapsed log section must not silently retain a frozen
buffer. Its hit count must follow live output, or its paused state and resume
action must remain visible while collapsed.

At small widths show list or reader, not compressed parallel columns. Core
row identity, state and primary action must be available without horizontal
scrolling. Secondary data can be disclosed. Keep the mobile frame compact;
large error messages remain readable even when they take more space. Menus
and panels must fit a short viewport and be scrollable when necessary.

## Reading documents

Give a document a stable address within its authorized project and parent
record. Opening, returning and browser Back/Forward preserve the surrounding
reading context. Put supported documents in the main reading path; keep
downloading the unchanged original as a separate action. Background refreshes
retain an unchanged open document, scroll position and focus while revalidating.
Clear visible content when its authorization or parent scope is lost.

Treat document contents as data. Do not execute embedded HTML or scripts,
resolve local filesystem paths, or automatically fetch external images.
Relative links target known authorized attachments; missing and ambiguous
targets need an explicit state. Bound preview size and disclose unsupported,
oversized, invalid or inaccessible files without presenting them as empty.

Present imported structured content only when recorded provenance proves its
relationship to the current body. Native edits take precedence over historical
source material. Keep original content accessible in secondary details.
Headings, lists, tables and code have distinct readable treatments; wide tables
and code may scroll locally without making the entire page scroll sideways.

List titles identify the topic; repeated transport or import prefixes belong in
secondary provenance. Derive alternate titles only from verified relationships
and retain the original content in details. Native or edited text takes
precedence over historical presentation hints. Use the same title in the list
and reader, and make that visible title searchable before server pagination.
A reply count describes the whole thread, not the loaded page. Do not present
import timestamps as conversation activity or invent a last-reply summary.

Keep historical presentation stable across unrelated status or description
changes. Recheck the fields and provenance that actually determine its meaning.
Use indexed provenance lookups; a single-record read must not verify every
record in the project. Search visible topics before pagination. Short previews
must preserve Unicode characters at their truncation boundary.

Historical replies follow a verified source sequence before pagination. A
source date, import timestamp or hashed ID does not prove that sequence.
Unverified source order needs an explicit state and stable fallback. Keep
historical authorship/date distinct from the account/time that recorded the
import. Native replies show their own author and creation time. Calendar-only
dates must not shift across timezones, and missing/invalid dates stay explicit.
Treat unverified attribution separately from genuinely absent source fields.
Withholding an author or date must not claim that the source omitted it.

## Linked records and search destinations

A record link identifies its destination by readable title and kind; an ID is
secondary context. Explain relationship type and direction relative to the
current record. Resolve by project, kind and ID together. A missing target has
an explicit unavailable state instead of a guessed route or stale title.
Useful relationships belong after the main content, outside technical metadata.

A reply search result identifies its discussion and shows bounded context around
the matched text when the body matched. Opening it reaches the exact reply,
including the correct page, with visible selection and one-time focus/scroll.
Links, modified clicks, reload and browser history retain that destination.
Passive refresh must not repeatedly move the reader. Keep return-to-results
query, filters, page and originating focus scoped to the identity and project;
clear obsolete reply/document targets on unrelated navigation.

Resolve a bounded result page through authorized shared operations. Do not fetch
all reply pages in the browser to find one target, or issue one HTTP request per
relation row. Preserve raw content and export independently of display labels.

## Verification and exceptions

Review actual content, including long names, empty/error states, foreign
reservations and read-only identities. Verify desktop 1440 and 1366 widths,
mobile 390 and 320 widths, a short viewport, PL/EN and dark/light. Include
keyboard focus/return and real 200% zoom in visual acceptance; a narrowed
viewport alone is not evidence of browser zoom. Record unverified cases.

Protect risky behavior with focused tests. Prefer meaningful flow assertions
over exact Tailwind classes or screenshots of only a happy-path title. Use the
repository's managed verification workflow, inspect accepted screenshots and
record the exact tested revision. UI standards are checked alongside React
quality and existing accessibility tests during review.

A feature-specific exception belongs beside its rationale and evidence. If
review establishes a reusable rule, update this document and link it from the
relevant local guide rather than duplicating the full standard in each feature.
