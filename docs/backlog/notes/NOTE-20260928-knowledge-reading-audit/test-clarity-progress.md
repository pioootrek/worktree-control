# Test result clarity: implementation and acceptance

PR: https://github.com/pioootrek/worktree-switcher/pull/62

Status: PR #62 merged as 0e84aef on 2026-09-28 at 20:37:12 UTC after green CI on f7b6f1d. Broader GUI rework remains open.

## Diagnosis

On the real isolated pilot, completed API/Portal runs had observed_match, complete clean observations and matching clean worktrees, but metadata.status stale. This explains RT-04. The existing project metadata refresh endpoint changed Portal metadata to fresh at 2026-09-28T19:55:20Z. All three Portal runs then satisfied the existing current gate; one command was still failed and two passed. No source-attribution policy changed.

Baseline: [before](test-clarity-screenshots/before.png), inspected at 1440x900, PL dark, on the previously accepted session-actions preview. It shows the generic unknown explanation which this stage replaces.

## Implementation

Sol high implemented the stage in an isolated worktree. ff345e4 adds per-reason freshness presentation, queue/preflight/finish revision distinctions, per-project Git refresh with inline errors, accessible run output and localized test-dialog close labels. c7652da adds a failed-runtime row action scoped to its known worktree, selecting the exact project before opening Logs and focusing its heading. Existing runtime badge scoping was already fixed by the foundation stage.

Managed check on a7f5c9c failed TypeScript because the new source presentation state widened to string. 8728e6e adds an explicit union and labels current snapshot HEAD as the last Git read. The next check passed typecheck but failed two unit fixtures which provided only finish evidence while asserting observed_match. Test-only 812a06b adds independent complete enqueue/preflight/finish observations.

## Managed verification

- Check bf0586b3-7897-47cb-9173-4b41d99f1165 passed 498 unit and 7 resource tests on clean 812a06b.
- Check 84d09e32-b36e-4266-9ada-b54b0654b681 passed 498 unit and 7 resource tests on 8e3357a; build caf3a03f-7066-42f1-94cf-dcf6a0e2dbb2 passed the same application revision.
- UI 45220239-3e66-4566-a6f7-4849d14f8400 on 8e3357a: 111 passed, one obsolete exact mobile text assertion failed after the reason was added to the same paragraph. Test-only 8e03261 updates that assertion; 8df20c7 additionally protects the exact last-read state against regression.
- UI dacaf0bb-1311-4d00-9eb5-5d8ac49bc88b on clean 8df20c7 passed 112 cases and failed two new assertions expecting metadata reasons in a summary which displayed only the first reason. f7b6f1d shows the first reason distinct from the state label and checks full guidance in the detail.
- Final check 6db8d4d4-c75e-4498-b078-498c8a7924c9 on f7b6f1d passed lint, typecheck, 498 unit and 7 resource tests. Final build ca8d5bf5-5313-4505-afa3-57d2cdb8855c passed. UI 64457c95-a4fd-42f2-aca9-d6b7ef043ac6 passed all 115 tests on the same clean revision.

These failed runs are not successful acceptance. Heavy local verification and manual Chromium run serially.

## Pilot acceptance

Initial pilot acceptance used application 8e3357a; final dirty-recovery and zoom acceptance used rebuilt f7b6f1d through the same managed server. Test-only changes in 8e03261 and 8df20c7 did not alter the initial build.

- [PL dark desktop](test-clarity-screenshots/after-pl.png), 1440x900: failed command and matching current source remain visibly distinct.
- [Mobile detail](test-clarity-screenshots/mobile-detail.png), 390x844, and [320px](test-clarity-screenshots/mobile-320.png), 320x740: document scrollWidth equals viewport width; close and output navigation are reachable. Long identities/revisions wrap locally.
- [EN light short viewport](test-clarity-screenshots/stale-en-short.png), 1366x650: naturally expired Git metadata yields an explicit reason and refresh action. [After refresh](test-clarity-screenshots/refreshed.png), same failed run returns to current-source relevance while retaining exit code 9 and its original output.
- Jump to log focuses the exact selected run's named output region. Escape returns to the invoking result button on desktop and mobile.
- [Runtime log](test-clarity-screenshots/runtime-log.png): an MCP claim on the synthetic Worker fixture intentionally exits 7. Only its actual failed worktree has the log action; clicking selects Worker, opens its console and focuses its heading. The fixture claim was released. No operational project was started.
- Actual Chrome zoom was set to 2 through chrome.tabs.setZoom. Playwright screenshots were blank/offset, so root repeated capture directly through CDP on final f7b6f1d. Inspected [200% detail](test-clarity-screenshots/final-zoom-detail.png) and [200% output](test-clarity-screenshots/final-zoom-output.png): readable wrapping and reachable output. CDP reports 720x456.5 CSS viewport, zoom 2, scrollWidth 720, output focus Pokaż wynik; see [zoom evidence](test-clarity-zoom-evidence.json). A capture made during the closing animation was discarded.
- Final f7b6f1d [dirty recovery](test-clarity-screenshots/final-dirty.png) was reproduced on the pilot using one temporary untracked marker in the Portal fixture. The metadata action remains available and does not mark the result current while the marker exists. Removing only that marker and refreshing restores current-source relevance and removes the now-unneeded action. The original failed command remains failed. Marker cleanup verified.
- No browser pageerror events during these flows. Chrome and managed UI verification ran serially; all browser sessions and claims are now closed/released. The managed preview remains running on the test-result-clarity worktree, port 3001.

Manual acceptance is scoped to Chromium and synthetic pilot data, not a full assistive-technology or cross-browser audit. Automated fixtures cover failed refresh/retry and source-observation edge cases.

## Review

n8n dispatch accepted once for target all; no retry. Claude analyzed the patch but its reviewer session denied GitHub publication. Root read its local report and independently verified its finding; no Claude review was published or impersonated.

Kimi published two actionable threads. The failed-start label also applied to crashes/failed stops: 8e3357a uses neutral Server failure logs / Logi błędu serwera and covers a late process exit. The missing exact dirty+stale state coverage is addressed by 8df20c7 with stale mobile390 and missing-metadata desktop1440 cases. Both threads were answered with commit and verification evidence and resolved after the relevant tests passed.

Codex published one additional valid thread: a fresh dirty snapshot tells the user to refresh Git but hides that action. Sol fixed this in f7b6f1d and added a flow proving that refresh while still dirty does not certify current source, but a second refresh after the worktree is cleaned can restore current relevance. Final check/build, all 115 UI tests and the real dirty-to-clean pilot flow passed; the thread was answered and resolved.

Root re-fetched all review threads: three fixed, zero deferred, zero false positives, zero unresolved. The final React/diff pass found no additional issue: derived state is computed during render, the log focus request is cleared after success, refresh uses the existing mutation path, and no new backend or browser data-access boundary is introduced.

## Delivery

GitHub [Verify 36479300247](https://github.com/pioootrek/worktree-switcher/actions/runs/36479300247) passed on f7b6f1d: check/build/HTTPS/integration/UI/E2E, package smoke on Node 22.23.2 and 24.21.0, and packaged systemd lifecycle. PR #62 merged as 0e84aef after that result and a final review-thread read. Main was fast-forwarded to the merge. Standards cover source evidence, observed failure labels and in-view recovery. This bounded stage does not complete the broader GUI rework.
