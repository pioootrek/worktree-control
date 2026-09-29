# Readable Memory history delivery

[PR #66](https://github.com/pioootrek/worktree-switcher/pull/66) merged on 2026-09-29T09:52:24Z as `d2982d08ace7247c3213f31d15aa7475020b05e4`. Sol high implemented application/tests on isolated `rework/knowledge-history`; root handled standards, managed verification, pilot QA, review triage and delivery. Final PR head: `cc070fbdcc3203c85e8537d4040a16761077c4e5`.

## Delivered behavior

History shows recorded actor/time, translated operation and revision. Opening Show changes reveals named before/after fields; the original previous JSON stays in secondary details. Verified status transitions distinguish restore from ordinary edits. Approval changes retain their actual revision. The browser treats content as plain text and stacks comparisons at narrow widths.

History is fetched lazily and independently from the Memory and search requests. Failure or delay leaves the main content usable; retry and pagination have deliberate focus destinations, while passive successful refresh does not move focus. Scoped keyed components and abort guards prevent a delayed record from replacing a different selection. Expand/Show list retains the history being read.

The optional, strict-validated `includeComparison` flag defaults to false across the shared operation. Ordinary agent/API history responses retain their previous shape and skip projection queries; the dashboard explicitly opts in. The indexed bounded page includes one successor row and an indexed predecessor check. Comparison uses exact consecutive snapshots, or the exact latest current revision. Missing, malformed, oversized or discontinuous data yields an unavailable comparison. Raw stored history, export data and schema are unchanged.

## Verification

| Check | Source | Result / run |
| --- | --- | --- |
| Managed check | `c04eac2` | Lint/types, 515 application tests + 7 resource tests passed; `28acc935-1fa8-4617-b8b6-56852d39a4a1` |
| Managed build | `c04eac2` | Passed; `489cf411-6761-48fe-95e8-a503694f8e97` |
| Managed UI | `cc070fb` | 125/125 passed; `e44bdcbd-133c-4301-b8c6-4fb2c7e285fc` |
| GitHub Verify | `cc070fb` | All four jobs passed: check-build, package smoke Node 22/24 and service lifecycle; [36550926195](https://github.com/pioootrek/worktree-switcher/actions/runs/36550926195) |

Managed passing runs had clean matching source observations. The final head changes only one UI-test selector and documentation relative to the passing check/build; application code is identical. Earlier checks failed on effect-state lint and a test fixture variable. The first UI run passed 124/125; its mis-scoped locator was corrected before the final run. Those failed attempts are not passing evidence. One early direct typecheck was run by the agent before root reiterated managed-only verification; it is not final evidence.

Tests cover lifecycle snapshots, approval invalidation, archive/restore/supersede, successor across pagination, gaps, malformed/oversized/forged data, exact-current mismatch, authorization and unchanged default history. UI regressions cover lazy loading, delayed and failed history, retry/page focus and switching records while an older read is delayed, then mutating only the selected record.

## Pilot and screenshots

Supported API comparison preserved all fields of 21 pre-existing Memory records and four raw audit events. A clearly marked native QA fixture created only through supported operations in the isolated pilot contains 28 revisions, plus a replacement record. Every before/after field matched the original mutation result at that revision, including the 25/3 page boundary. [API evidence](history-api-evidence.json).

Live Chromium verified PL/dark desktop, 320 px mobile, EN/light 1366x650 and actual 200% browser zoom (CSS 683x325). Pagination focused revision 26, then revision 1 on return. Reader expand/restore and an imported note with no recorded history behaved correctly. No page errors or page-wide horizontal overflow were observed. [Browser evidence](history-browser-evidence.json).

Inspected screenshots:

- [Before: raw operations/JSON](history-screenshots/before.png).
- [Readable event list](history-screenshots/after-desktop.png) and [approval comparison](history-screenshots/approval.png).
- [Edit and approval invalidation](history-screenshots/edit.png), [mobile comparison](history-screenshots/mobile.png).
- [Superseded](history-screenshots/superseded-mobile.png) and [restored](history-screenshots/restored-mobile.png) on mobile.
- [EN/light short viewport](history-screenshots/en-short.png) and [actual 200% zoom](history-screenshots/zoom.png).

This is scoped Chromium QA, not a full accessibility audit, cross-browser certification or production-scale benchmark. Invalid-history rendering is covered by automated fixtures; the real pilot was not corrupted to create that state. Production data was not changed.

## Review dispositions

n8n all dispatched once using the dispatch-code-review workflow. Kimi and Codex published completed reviews with no actionable findings. Claude completed analysis but its permission mode denied GitHub review publication. Root recovered its findings from the log, without reposting as the reviewer:

1. **Fix:** unconditional snapshot projection inflated every Memory history response, including agents. The new opt-in flag preserves raw defaults and skips additional projection reads; tests verify the default absence of comparison.
2. **False positive:** stale Memory A allegedly remains under B after navigation. MemoryPanelContent already remounts by recordId (and its parent by scope), resetting record state; abort guards discard old responses. A new passing regression delays A, navigates via list to B and verifies approval affects B only.

Outcome: one recovered concern fixed, one disproved, none deferred; zero unresolved published threads before merge. Root review also hardened malformed-current metadata handling, nested projection validation, legacy-ID comparison and deliberate pagination focus. Reusable rules are in `docs/ui-standards.md`.

## Remaining scope and preview

This delivers existing Memory history only; broader GUI work remains open in `RWK-20260928-gui-usability`. No task-history expansion, data-format policy change or storage migration is included.

The managed pilot remains running on the history worktree using the tested application build `c04eac2`, identical in application code to final `cc070fb`. Browser closed and claim released. Credentials remain outside Git.
