# Reply chronology progress

Stage authorized on 2026-09-29. Sol high implemented application/tests in isolated `rework/reply-chronology`; root owns verification and delivery. [PR #64](https://github.com/pioootrek/worktree-switcher/pull/64) merged as `a2b76933b9de0576a2934c6ac7607ddc442cd1bf` on 2026-09-29 at 05:50 UTC. Final branch head `48e8788a9cecd87b7f3ae64607c509273f45d3ef`.

## Result

SQL reads replies in proven numeric source-note order, then stable uncertain historical records, then native continuation. Pagination is applied after ordering; provenance joins collapse to one result per reply. Proof uses deterministic same-project identities, coherent parent task/relation and numeric note position, independently of editable labels. Migration 27 adds an exact provenance-target index without rewriting records; backup schema compatibility moves to 27.

Historical source author/date lead, record actor/time/revision live in per-reply details. Native replies show creation time. Date-only source values stay unchanged. Source-order uncertainty and source-attribution uncertainty are separate. Attribution requires matching preserved source text using JavaScript trim semantics; withheld fields use an explicit unverified state rather than claiming the source lacked data.

## Verification

Managed check on `d6a544d` passed: lint/typecheck, 504 unit tests and 7 resource tests (`e4a2dfce-21c2-46ec-bd86-4d0a0b68aeb7`). Managed build passed (`376333b0-5d2c-415b-a9e1-5339e3ee1a2f`). Managed UI on `d6a544d` had 117 pass/1 fail: its language-switch test assumed a native disclosure stayed open after reader remount. Test-only fix `48e8788` reopens the PL disclosure. Final managed UI on `48e8788` passed 118/118 (`02d0cb13-aca9-4018-844d-2f2565336d0b`); application sources remain identical to the passing check/build. [GitHub Verify 36527347454](https://github.com/pioootrek/worktree-switcher/actions/runs/36527347454) passed all four final-head jobs: check/build/HTTPS/integration/UI/E2E, package smoke on Node 22.23.2 and 24.21.0, and packaged systemd lifecycle.

Earlier draft checks found two fixture errors, both corrected: an unregistered native author violated a foreign key, then repeat import lacked expected project revision. Check and build subsequently passed on `1c0e2c7`. The UI run on that earlier head was deliberately cancelled once review required changing UI/API attribution states; it is not counted as successful.

## Review

n8n `all` dispatched once. Claude found that withheld author/date were falsely represented as missing source fields. Classified fix; `d6a544d` adds explicit attribution/date uncertainty and PL/EN regression coverage. Claude's review environment denied GitHub publication, so the finding was recovered from its execution log without impersonating the reviewer. Kimi and Codex published no actionable findings. Re-fetch confirmed zero inline review threads and no unresolved feedback. Codex queued a separate unit run behind root’s UI run, then cancelled it before execution; it is not test evidence. Classification: one recovered Claude fix, no deferred or rejected findings.

## Remaining scope

This bounded stage is complete. Keep the broader GUI rework open. Relations, global search destinations and audit-history presentation are outside this slice.

## Pilot acceptance

[API evidence](reply-chronology-api-evidence.json) compares all 13 threads/93 existing replies, including 92 historical replies in 12 imported threads, against preserved source commit `81069845634a3fed6365589ae32a5c3430a57478`. All historical IDs follow numeric source order, including API pagination at five replies per page. Every existing raw reply field remains equal to baseline. Native-only thread remains native.

A clearly marked QA reply was then added through the UI only in the isolated copy. It appears after all 14 source comments in the selected thread, with its own creation time and no historical projection. ID `cc3a5810-27a0-468c-afd7-0466c6cfd9f1`; it remains in that pilot copy. No production data was changed.

Inspected desktop 1440x1000 PL/dark, mobile 320x740, short 1366x650 EN/light and actual browser zoom 2.0 at 683x325 CSS viewport. No horizontal page overflow. Expand/Show list and mobile/zoom Back worked; Back restored focus to the selected thread. Source date-only values remained unchanged, source author led, record details disclosed importing actor/time/revision, native continuation displayed its own timestamp. [Zoom evidence](reply-chronology-zoom-evidence.json).

Screenshots: [desktop](reply-chronology-screenshots/after-desktop.png), [record details](reply-chronology-screenshots/details.png), [mobile reader](reply-chronology-screenshots/mobile.png), [mobile attribution](reply-chronology-screenshots/mobile-source.png), [native EN/light](reply-chronology-screenshots/native-en-short.png), [native continuation](reply-chronology-screenshots/native-continuation.png), [short EN/light](reply-chronology-screenshots/en-short.png), [200% zoom](reply-chronology-screenshots/zoom.png). Application build is `d6a544d`, identical to `48e8788` apart from the UI-test-only correction.

Managed preview runs on the reply-chronology worktree, port 3001, isolated pilot data. Claim released after browser closed. Acceptance is scoped Chromium QA, not full accessibility/cross-browser certification; no production-scale latency benchmark was run.
