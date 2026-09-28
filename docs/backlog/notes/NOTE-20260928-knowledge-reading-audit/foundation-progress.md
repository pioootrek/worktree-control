# GUI foundation implementation and acceptance

Owner authorized implementation on 2026-09-28. Code was delegated to three Sol
agents on separate worktrees; root integrated and ran serialized verification.
UI standards are now in `docs/ui-standards.md`.

PR: https://github.com/pioootrek/worktree-switcher/pull/58 (not merged).
The isolated pilot is running the foundation build; its agent claim is released.

Application source captured visually: `ce44a32`. Candidate `04bd359` also fixes
768px path overflow, scoped reader focus, known local-change labels, live log
search and Memory list scroll restoration. The last two commits change only
the scroll regression's Playwright assertions; application source is `af30c87`.

Managed verification with observed source match:

- `pnpm check` on `af30c87`: lint without warnings, typecheck, 486 unit tests,
  7 resource tests; run `f0d50a47-d85c-4cbb-bed8-d9c5db7555aa`.
- `pnpm build` on `af30c87`: run `dfa2bba7-e050-4460-86dc-779322c3d1cf`.
- `pnpm test:e2e` on `d217d82`: 3/3 passed, run
  `2e8f37fa-f363-4bef-8fc8-1f336c1277af`. Final GitHub CI also runs this suite.
- Final `pnpm test:ui` on `04bd359`: pending, run
  `513c84dc-2748-4582-9cd2-0a34c52084bf`.

The first complete candidate passed 88 UI tests. Review expanded the suite to
94. Subsequent failed runs exposed a Memory reader-remount scroll loss and two
mistakes in the added tests (native select focus setup and browser/test-process
variable scope); they are recorded as failures, not successful acceptance.
Final GitHub CI acceptance remains pending.

## External review and fixes

n8n accepted one review request for target `all` on 2026-09-28; all three
reviewers completed. Root inspected each finding against the code:

| Reviewer | Finding | Outcome |
| --- | --- | --- |
| Claude | Known dirty worktree shown only as unknown freshness | Fixed in `71855d1`/`d217d82`; local-change label is independent of freshness and at-run attribution, with desktop/mobile coverage |
| Claude | Mobile tab/project navigation restores an old reader's focus | Fixed in `4734667`; scope changes clear the return target, while Back retains it |
| Kimi | Zero-hit collapsed logs retain an invisible frozen search buffer | Fixed in `38775e0`; search-owned pause releases until a live hit arrives; explicit reader pause remains visible |
| Kimi | Memory restores old scroll after new filters or page changes | Fixed in `cce6ebb`/`af30c87`; new results reset, passive refresh and reader navigation preserve position |
| Codex | No additional actionable findings; confirmed Kimi's two concerns | Covered by the fixes above |

Claude's reviewer session denied its GitHub publication call. Its findings were
recovered from the local review log; it did not publish a review. Kimi and Codex
published reviews. Reviewers did not rerun tests. Root handles the final
verification and disposition replies through the `review-follow-up` workflow.

## Implemented scope

Compact shared header and project scope, System/Preferences menus, mobile
Worktrees with visible identity/state/actions and focused detail dialogs,
full-width unselected Knowledge list, split/expanded reader, discussion replies
before metadata, disclosed filters, truthful read errors and return focus.
Tests/Resources adopt compact summaries and cards below 1280 CSS pixels. Logs
show hit counts and collapse zero-hit sections. Test source observations and
current freshness are labeled separately without relaxing their definitions.

## Inspected visual evidence

The attached 11 screenshots were inspected. Pilot data is the isolated copy
previously authorized by the owner. Runtime fixture projects are stopped after
restarting the pilot controller; persistent test/storage history remains.
Live log search and foreign-reservation scenarios use the automated fixtures;
they were not re-created as running pilot services in this capture.

- All five sections: 390 and 320 CSS pixel widths, no document horizontal overflow.
- Mobile frame: 67px on runtime sections, 56px on Knowledge.
- Desktop 1440, light/English 1366, intermediate/short viewport 1024×600.
- Mobile Knowledge selection focuses its H3; Back returns to the selected link.
- Real Chrome zoom 200% via extension `chrome.tabs.setZoom(2)`: physical 1440×1000,
  CSS 720×500, DPR 2, no horizontal overflow. Memory Back returned to its link.
  `rework-zoom-evidence.json` records CDP metrics. The zoom screenshot uses CDP
  capture: Playwright's default screenshot clipped the zoomed viewport and those
  clipped images were excluded from evidence.
- PL/dark and EN/light show readable selected foreground text. This is visual
  inspection, not a claim of exhaustive contrast or screen-reader certification.

Representative comparisons: original `runtime-screenshots/20-mobile-worktree-table.png`
versus `rework-screenshots/worktrees-desktop-pl-dark.png` and automated mobile
fixtures; original `screenshots/04-discussion.png` versus
`rework-screenshots/knowledge-discussion-reader-desktop.png`;
original `runtime-screenshots/17-mobile-tests.png` versus
`rework-screenshots/tests-mobile-320.png`.

## Remaining work

This foundation does not normalize imported discussion titles, render structured
memory JSON/documents, add document indexing, or redesign search destinations.
These remain in the open rework. Record-level source semantics and further
reading workflows still need their bounded audit slices. Keep the rework open.
