# Knowledge navigation delivery

[PR #65](https://github.com/pioootrek/worktree-switcher/pull/65) merged on 2026-09-29 at 07:42 UTC as `cad32a2cea5b155ad20da8f2b570902ef3d3aa71`. Sol high implemented application/tests on isolated `rework/knowledge-navigation`; root performed managed verification, isolated-pilot QA, review triage and delivery. The final tested head was `f4235878ffd63ad6945cf655a61def1ade2b90ab`.

## Result and standards

Relations show the destination title, kind, direction and available status after the reading content. Unavailable destinations are explicit. Reply search shows its discussion title and a bounded excerpt containing the literal match, then opens the exact reply's page with focus and highlighting. Native links retain reply identity and scoped search state; Back to results restores query, filters, page and result focus. Manual reply pagination preserves the reader and relation page and focuses the first newly loaded reply. Passive refresh does not steal focus.

The standards in `docs/ui-standards.md` now cover titled links, source identity, bounded match excerpts, narrow-screen visibility, navigation intent and cancellation. Existing shadcn primitives remain in use, informed by the [official Item composition](https://ui.shadcn.com/docs/components/radix/item). No new UI package or preset is introduced.

## Final verification

All managed runs below observed clean source matching the final head:

| Check | Result | Run |
| --- | --- | --- |
| Check | Lint/types, 509 application tests and 7 resource tests passed | `ed966fc3-a92c-46cc-bb02-29f16e9661c1` |
| Build | Passed | `5dd9a657-0afb-448b-8fa0-62ee1ddffea0` |
| Browser suite | 123/123 passed | `7ad1229e-617f-41ca-b42f-460732f8d3cf` |

[GitHub Verify 36537074101](https://github.com/pioootrek/worktree-switcher/actions/runs/36537074101) passed all four jobs on the final head: check-build, package smoke on Node 22/24 and package service lifecycle. All published review threads were resolved before merge.

The final supported-API comparison preserved all raw fields/order for 13 existing thread summaries and 94 replies, plus stored relation fields. A clearly marked native QA thread with 31 replies verified target reply 30 at offset 25, missing/wrong-thread targets, named relations and a reply source link preserving reply identity/revision. Fixtures were created only in the authorized isolated pilot through supported operations. No production data was changed.

Final live Chromium checks covered desktop 1440x1000, mobile 320x740, EN/light 1366x650 and actual browser zoom 200% (CSS viewport 683x325). Search/return focus, page-two targets, Expand/Show list and manual pagination focus passed. No page errors or horizontal overflow were observed. Reload/new-tab return was also checked during the preceding candidate and is covered by the final automated suite. [Compact API/browser evidence](navigation-evidence.json) records the final observations.

## Screenshots

The three `before-*` screenshots in `navigation-screenshots/` are the pre-change baseline. Nine final screenshots were inspected:

- [Search desktop](navigation-screenshots/after-search-desktop.png) and [search mobile](navigation-screenshots/after-search-mobile.png): late match remains visible within the bounded excerpt.
- [Reader mobile](navigation-screenshots/after-reader-mobile.png), [page two](navigation-screenshots/after-page-two.png) and [pagination focus](navigation-screenshots/after-page-focus-mobile.png).
- [Named relations](navigation-screenshots/after-relations.png).
- [English/light short viewport](navigation-screenshots/after-en-short.png).
- [200% zoom reader](navigation-screenshots/after-zoom.png) and [return to results](navigation-screenshots/after-zoom-results.png).

## Review and fixes

n8n `all` dispatched once using the dispatch-code-review workflow. Claude completed analysis but its permission mode denied GitHub publication; its finding was recovered from the log without impersonating the reviewer. Clearing a target reply had reset the entire reader and relation page. Sol fixed this and root's associated SPA Back focus issue.

Kimi published one concern about unrelated imported-topic verification during task/memory-only searches. A controlled SQLite fixture with correctly registered UDF counters and a positive control measured two topic and four hash calls for the old task-only query; specialized final task/memory reads perform zero such calls. This is fixture evidence, not a production latency benchmark. Sol fixed the query composition, root replied with evidence, and the thread was resolved. Codex published no additional actionable findings. Outcome: two review concerns fixed, none deferred or classified as false positives, zero unresolved published threads.

Live QA also caught a two-line excerpt clamp hiding the match at 320px and focus falling to BODY when the clicked pager became disabled. Both were fixed before final verification. Active searches expose the full bounded excerpt; intentional paging moves focus after loading and cancels pending intent on selection/error.

## Boundaries and preview

Current SQLite relation endpoints remain task/thread/reply. Memory relation rendering is presentation coverage, not a new persistence capability; memory sources and search destinations remain supported. Stored records, import payloads, export revisions and database schema are unchanged. This was scoped Chromium QA, not a full accessibility audit, cross-browser certification or production-scale performance benchmark. Broader GUI work, including history presentation, remains open in `RWK-20260928-gui-usability`.

The pilot preview was rebuilt and explicitly restarted on final `f423587`, then the browser was closed and the project claim released. The managed server remains running on the navigation worktree with isolated data. Access credentials are kept outside the repository.
