# Knowledge navigation progress

Stage authorized on 2026-09-29; Sol high implements application/tests in isolated `rework/knowledge-navigation`. [PR #65](https://github.com/pioootrek/worktree-switcher/pull/65) is open. Root owns managed verification, isolated-pilot QA, review triage and delivery. This report is in progress; no merge is claimed.

## Verified checkpoint

`c50ca3e02dec1afc3ef2bcf79a68fbdd0c2d750a`: managed check passed (509 application tests, 7 resource tests, lint and types; run `c53a3635-2561-48ea-a036-96ec85908282`), build passed (`eacae04d-1958-486e-9da5-89e048a26e32`), UI passed 122/122 (`3e0a2a31-9af8-48a6-b638-91980c3467f5`). All three runs had clean matching source observations. Earlier draft check failures were lint/type issues; the first UI run had 120 pass/1 fail because an alert selector also matched Next.js's route announcer, corrected before this checkpoint.

## Pilot evidence and pending fixes

The existing 13 thread summaries and 94 replies, their raw fields/order and stored relation fields matched the pre-change API snapshot. Search for `dual-engine` identifies its imported discussion; a clearly marked QA thread with 31 native replies verifies server location of reply 30 at offset 25. Its linked task and memory preserve source revisions, with the reply source URL retaining reply identity. Fixtures were created through supported operations only in the authorized isolated pilot copy; no production data changed.

Live Chromium at 1440x1000 and 320x740 confirmed exact reply focus, readable relations in both directions, reload, new-tab return to query/result focus and Expand/Show list. No page errors or horizontal overflow observed. Two live-QA findings remain in implementation: the two-line search excerpt clamp hides the match at 320px, and paging to a boundary disables the clicked pager and leaves focus on BODY. Active searches will show the full bounded excerpt; intentional pagination will focus the new page's first reply, with cancellation on navigation/error and no passive refresh focus theft.

## Review

n8n `all` dispatched once. Claude found that clearing a reply target via full selection reset unmounted the reader and reset relation pagination; fixed in `c50ca3e`, together with root's SPA Back focus correction. Claude's permission mode denied GitHub publication; its completed finding was read from the log, not reposted under the reviewer's name.

Kimi published one performance concern about imported-topic verification on task/memory-only searches. Thread `PRRT_kwDOUINt8M6m_472` remains open pending measured verification and an appropriate outcome. Codex published no additional actionable findings. Current review count: one recovered Claude fix, one published Kimi concern under investigation; no deferred items.

## Boundaries

Current SQLite relation endpoints remain task/thread/reply; memory relation rendering is presentation coverage, not a new persistence capability. Memory sources and search destinations remain supported. No schema or content-format migration is introduced. Broader GUI rework and audit-history presentation remain open.

Preview currently serves the tested checkpoint from the navigation worktree with isolated pilot data; browser closed and claim released. Further source edits do not imply an updated preview until managed rebuild/restart.
