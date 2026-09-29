# Reply chronology and attribution stage

Owner accepted this next bounded GUI stage on 2026-09-29 after PR #63. Base `bbcdef9`; Sol high owns application/test changes on `rework/reply-chronology` in an isolated worktree. Root owns standards, managed verification, pilot evidence and delivery through n8n review and green CI.

## Evidence

Current `listReplies` joins import source rows then sorts by `created_at,id`. Imported replies share their publication timestamp, so hashed IDs scramble source order. The current 14-reply knowledge thread dates include 05,05,13,13,27,13,05 September. Source comments have preserved `:note:N` legacy IDs and `#notes/N` paths. The original pinned source commit is `81069845634a3fed6365589ae32a5c3430a57478`; root matched all 92 replies in 12 threads to their source ordinals and unchanged text. A native QA thread has one reply. Private before snapshots and expected IDs are retained outside Git; publish bounded comparison evidence with delivery.

## Contract

Historical conversation uses verified numeric source sequence, not source dates, IDs or import publication time. Preserve missing, invalid and equal source dates without inventing precision. Verified historical replies precede native continuation, which uses stable created-at/ID ordering. Unverifiable historical replies need a deterministic fallback and an explicit source-order uncertainty state. SQL applies ordering before LIMIT/OFFSET; every stored reply appears once regardless of ambiguous provenance. Keep the current pagination API.

Proof uses same-project deterministic reply/thread/task IDs, matching parent path and numeric ordinal, coherent source identity, unambiguous provenance and the recorded task/thread relationship. Editable task/thread labels are not ordering evidence. Support older mapping-v1/null-target-revision imports when the preserved identity/path evidence suffices; never infer origin from a native text prefix. Separate verified source attribution from verified ordering. Uncertain provenance must not falsely identify an importer.

For verified imported replies, source author and historical date lead; importing actor, local import time and revision remain in named per-reply details. Native replies show their author and actual creation time. Unknown/invalid source dates remain explicit. Date-only values retain calendar dates without timezone conversion. Body remains plain text; preserve raw fields, IDs, revisions, timestamps, history and export. No data rewrite or importer remapping.

## Query and schema scope

Exact ambiguity detection must consider every provenance row targeting the reply, including a conflicting row with a different path. The existing project/source-path index cannot efficiently do that. A single additive index on `(project_id,target_kind,target_id)` is approved as necessary implementation scope, through the existing ordered migration mechanism. No column or record migration. Cover upgrading the preceding schema and indexed query paths. Preserve one database owner and migration transaction boundaries. The separate SQLite safety backlog remains open; this stage does not claim to resolve its backup/crash-recovery gaps.

## UI and standards

Use existing shadcn-based composition, semantic text/border tokens, typed PL/EN labels and accessible native disclosure. No new component library or layout redesign. Keep reply content primary, clarify why source order differs from dates, and distinguish record creation metadata from a historical author. Preserve expansion/return, mobile focus, creation and pagination controls.

## Acceptance and delivery

Cover more than 25 imported replies (numeric 2 vs10), equal/missing/invalid/out-of-order dates, mixed native replies, native-only threads, older and repeated imports, raw/export stability, ambiguous/malformed/cross-project provenance, no page omissions/duplicates and unchanged authorization. Include actual SQL query-plan evidence. Protect date-only display and native/source author separation in PL/EN browser tests.

Run managed check, build and UI serially; one heavy local job at a time. Pilot comparison checks all 92 pre-existing historical replies against pinned source order, including the 14-reply example, with raw data unchanged. Inspect desktop/mobile, short viewport, source details, pagination/new reply, focus and actual 200% zoom. Review through n8n once, handle findings, verify final head and merge only after green CI.

Relations, global search destinations and audit-history presentation are excluded. Keep the broader GUI rework open.
