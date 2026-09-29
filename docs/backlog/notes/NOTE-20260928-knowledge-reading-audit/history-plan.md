# Readable Memory history

Owner accepted this bounded stage on 2026-09-29 after PR #65. Sol high implements application/tests on isolated `rework/knowledge-history`, base `1639776`. Root owns standards, managed verification, pilot screenshots, n8n review and merge after final-head green CI.

## Baseline and scope

Memory history currently renders operation codes, revision/principal IDs and raw previous JSON without a date. Its request shares Promise.allSettled with search and record loading, so a slow history request delays reading. History stores the state before an event; comparing every row with the latest record would incorrectly attribute later changes to earlier events.

Scope is the existing Memory history surface: readable recorded date, actor, translated operation and revision; optional field comparison; secondary raw original snapshot. Include create, edit, approve/invalidation, archive, restore and supersede truthfully. Restore is stored as updated and may be named only from a verified transition. Do not invent source authors, user display names, unavailable versions or history for other record types. Preserve current revision approval/conflict behavior and all raw history/export fields; no data migration.

## Comparison contract

Add an optional bounded read projection through shared authorized operations if needed. The before snapshot belongs to revision r-1. The after snapshot may be the immediate next history entry's previous snapshot only when record/project/identity and exact revision continuity are proven; use current Memory only for an exact matching latest revision. A page boundary must not break this rule or cause browser page scans. Invalid, missing, oversized, inconsistent or gapped snapshots produce an explicit unavailable comparison, with original data still available separately.

Parse and render within explicit limits. Compare allowlisted user-relevant fields with plain text: title, body, category, status, tags, sources, approval and supersession. Do not present current edited/imported content as an older version. Resolve a bounded page and successor under existing authorization, with indexed reads and no per-row HTTP requests or full-project history scans.

## Interaction and composition

Fetch history lazily and independently from record/search, scoped to identity/project/record. Slow, failed or retried history leaves current content, selection and reading position intact. Distinguish loading, empty and error. Cancel stale requests and pending focus on navigation; a passive refresh must not repeatedly move focus. Preserve or deliberately reset history pagination for its proper scope; no stale data from another record.

Use existing shadcn/Radix primitives and semantic tokens. Inspiration: [shadcn Collapsible](https://ui.shadcn.com/docs/components/radix/collapsible), checked 2026-09-29, for explicit disclosure trigger/content. Show concise event summaries first, readable before/after on request and raw snapshot as a secondary option. Keep text readable at 320px and 200% zoom; comparison layout stacks at narrow widths. No new dependency, preset or generic timeline framework.

## Acceptance and delivery

Native lifecycle tests verify actual revision snapshots, approval invalidation, archive/restore/supersede, page-boundary successor, gaps/malformed snapshots/current mismatch, authorization and raw export preservation. Browser tests verify delayed/failed history still permits reading, scoped retry, switching/cancellation, pagination focus, safe literal content and before/after disclosures.

Root captures baseline and final isolated-pilot screenshots, validates existing history unchanged and native fixture transitions through supported APIs. Desktop/mobile, PL/EN, dark/light, short viewport and actual 200% zoom are scoped visual acceptance. Managed check/build/UI run serially on final source; n8n all once, feedback classified/fixed and final-head green CI before merge. Broader GUI rework remains open.

## Pilot baseline

Before changes, supported API reads captured 21 existing Memory records and their four audit events privately for raw comparison. Imported notes without events remain explicit empty histories. [Before screenshot](history-screenshots/before.png) shows a native decision creation/approval as operation codes and raw previous JSON. A clearly marked isolated-pilot fixture has 28 native revisions (create, approve, edit/invalidate, archive, restore, further edits and supersede), plus a replacement Memory. It was created only through supported API operations and retains per-revision snapshots outside Git for later exact comparison.
