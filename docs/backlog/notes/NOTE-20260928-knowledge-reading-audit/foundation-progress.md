# GUI foundation implementation and acceptance

Owner authorized implementation on 2026-09-28. Code was delegated to three Sol
agents on separate worktrees; root integrated and ran serialized verification.
UI standards are now in `docs/ui-standards.md`.

PR: https://github.com/pioootrek/worktree-switcher/pull/58 (draft, not merged).
Application source captured: `ce44a32`; candidate `19dd38d` adds test corrections
only. Managed check passed with lint, typecheck, 486 unit tests and 7 resource
tests. Managed build passed. First UI run: 70 passed, 18 failed; trace review
identified stale selectors/expectations, now corrected. Second UI run pending.
External n8n review and final CI acceptance remain pending.

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
