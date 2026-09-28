# Discussion clarity delivery

PR [#63](https://github.com/pioootrek/worktree-switcher/pull/63), branch `rework/discussion-clarity`, Sol high implementation on an isolated worktree. Root owns standards, managed verification, pilot acceptance and review disposition. Final code head: `6122e4a`. Merged as `20fb1d1c20db68d76a9c80e771092171bbb05323` at 2026-09-28 21:38 UTC after all four GitHub Verify jobs passed.

## Result

Verified imported discussions show a readable historical topic, bounded source preview and complete reply count. The list and reader use the same topic. Search matches that topic, the original title or ID before server pagination, with NFC/case normalization and literal substring matching. Native threads retain their authored body and title. Raw generated fields remain in secondary details; no importer rewrite, schema migration or stored-data change.

The projection verifies same-project import provenance, deterministic task/thread/reply/relation IDs, exact generated thread title/body, source identity and matching historical-note ordinal. Missing, conflicting or edited evidence falls back to raw fields. Ordinary task status/description changes retain the historical topic; changing the task title invalidates it. Detail reads constrain the thread ID and use indexed source-path lookups, with query-plan assertions. Unicode-safe truncation preserves a whole code point at the boundary.

## Verification

- Managed check on `c6bbbdd`: 500 unit tests and 7 resource tests passed, lint/typecheck included (`c0f369cc-bf7e-4ee4-ae69-7f626de772df`).
- Managed build on `c6bbbdd` passed (`fb09229d-5919-49da-a45b-e471d59dc8d4`).
- Managed UI on `c6bbbdd`: 117/117 passed (`68cd4cbc-20bc-4e56-9ec7-cd32d61a2bb2`). Final subsequent change only adjusts backend Unicode truncation and adds a boundary test; final CI also passed UI and E2E on `6122e4a`.
- Earlier failures were a test fixture violating relation uniqueness and two stale discussion-search label selectors; all corrected. No stopped process was counted as successful.
- Final `6122e4a` managed check passed: 501 unit tests + 7 resource tests, lint/typecheck (`c2e739de-d487-47b8-b215-2f273b13aced`). Final build passed (`60a67a81-6ef8-4a9c-9aa9-4994649c5bb1`). [GitHub Verify `36486390377`](https://github.com/pioootrek/worktree-switcher/actions/runs/36486390377) passed all four jobs: check/build/HTTPS/integration/UI/E2E, package smoke on Node 22.23.2 and 24.21.0, and packaged systemd lifecycle.
- Managed preview was restarted to `6122e4a`; post-restart HTTP smoke verified all 12 imported projections and the native thread/reply. Claim released; server left running on the discussion worktree, port 3001.

## Pilot acceptance

API comparison on the isolated pilot verified all 12 pre-existing imported threads: raw title/body/IDs/revisions/timestamps and all replies remained identical to the baseline. All 12 received verified topics. Counts were 10, 8, 14, 2, 4, 7, 7, 21, 7, 3, 4 and 5. [Evidence](discussion-api-evidence.json).

Inspected desktop 1440x1000 PL/dark and 1366x650 EN/light, 390x844 list, 320x740 reader, plus actual browser zoom 2.0 at a 683x325 CSS viewport. No horizontal page overflow. Displayed-title search returned the intended thread; expanded reader restored its list after deep scrolling; mobile/zoom Back returned focus to the selected row. Original import title/body remained visible in More details. [Zoom metrics](discussion-zoom-evidence.json).

A clearly named native QA thread was created through the UI only in the isolated copy (`3e03fa71-0421-490c-a641-82c1c6a4e4c5`). Its body was retained, reply save worked, and the row count became 1. It is intentionally left in that copy. No production data was changed.

Inspected screenshots: [list](discussion-screenshots/after-list.png), [reader](discussion-screenshots/after-reader.png), [mobile list](discussion-screenshots/mobile-390.png), [mobile reader](discussion-screenshots/mobile-reader-320.png), [native thread](discussion-screenshots/native.png), [short EN/light](discussion-screenshots/en-light-short.png), [original details](discussion-screenshots/original-details.png), [200% list](discussion-screenshots/zoom-list.png), [200% reader](discussion-screenshots/zoom-reader.png). Earlier before screenshots remain beside them. These screenshots are from `c6bbbdd`; the final Unicode-only backend adjustment does not alter these ASCII preview examples.

## Review

n8n target `all` dispatched once. Claude identified excessive provenance scans and topic loss after unrelated task edits; both fixed in `abdd229`, strengthened by `c6bbbdd` query-plan/pagination evidence. Claude could not publish because the reviewer environment denied its GitHub write; recovered findings were handled without impersonating that reviewer.

Kimi reviewed the updated `c6bbbdd` and published no remaining actionable findings. It withdrew its earlier scan comment after seeing the fix. Codex published one UTF-16 truncation finding; `6122e4a` uses code points and covers the emoji boundary for native/imported previews. The published thread was replied to with the passing final check and resolved; re-fetch confirmed zero unresolved threads. Classification: 1 published fix, no backlog/false-positive published concerns; 2 additional recovered Claude fixes.

## Limits and remaining work

This is scoped Chromium acceptance, not exhaustive accessibility or cross-browser certification. No large-production-dataset latency benchmark was run; indexed query shape is covered, and visible-title search still evaluates candidate threads in the project. Reply chronology, global search destinations and audit-history presentation remain outside this slice. Keep `RWK-20260928-gui-usability` open. Description/body remains free-form text as accepted by the owner.
