# S4u integrated closeout, 2026-10-03

Status: merged. PR #73 was merged at 2026-10-03T11:02:57Z as `1f9c90fff36af25d5ca609299270d51dabc70a96`, from verified head `6f3db2f6a6bb82187ae472e8d39b0d18d9907cb4`. The entries below preserve the work and verification sequence. Owner authorized completing both agent threads, n8n review and merge when ready. GitHub has one open PR (#73); the two agent branches had no separate PRs. Both are integrated into the existing feature branch, preserving their commits.

Agent 1: 3530ea77f2d1352f165940c3e530a3feeccd594b, bounded generation/version-bound mutation receipts. Agent 2: db12e4b46eb885d9f25a0ad2ee68fcc098823497, private operator export recovery. Merge 81a61ff resolves the shared schedule module and updates agent-2 fixtures to the new key protocol.

Local review found uncharged staging after a timeout before publication stamping. Regression 9437212 failed as expected (101 passed, 1 failed): the next export succeeded despite retained staging exceeding owner quota. ef1abf6 counts staging, preserves its execution through pruning/target-policy changes, and permits explicit recovery of a complete matching staging envelope. No uncertain catch-path unlink was introduced. 0d0e3cb adds actual staged SIGKILL recovery and corrupt/foreign/hardlink/symlink refusal tests.

Managed focused suite e9be5fb4-d930-4893-bfb9-5ea1f312fe63 passed all 106 tests at clean integrated 0d0e3cb6482ef0cb57eae22ffc0e265e24bf3f21 with observed_match. First post-fix run f6e0d787-8613-4841-9aa3-a26928eab7bd failed the existing first recovery test's 5-second timeout; the new regression passed. That failure remains evidence; no assertion or timeout was weakened. Full integrated check/build/integration/UI and GitHub CI are pending. Individual agent results are historical evidence, not integrated acceptance.

n8n dispatch for PR #73, target all, was accepted at approximately 10:38 UTC on 2026-10-03: Workflow was started. Review completion and outcomes are pending. No duplicate dispatch, production deployment, host service/limit change or next slice. Parent remains open for S4b/S5 and later acceptance.

## First n8n review follow-up

Claude reviewed integrated 0d0e3cb and reported two valid capacity lockouts (discussion_r4172825466 and discussion_r4172825468). Retained succeeded copies can fill owner bytes or the global 2048 execution history; automatic retention cannot run without a new success. f6ed795a7be72cdb39b9b3f30456f9e9c3f7ad9c extends explicit local-operator cleanup to verified succeeded copies. Preview reports the original state, original outcomes are preserved, and the same file/envelope/alias/intent/replay checks apply. This deliberately requires operator confirmation instead of automatically deleting the last successful copy before a new one exists. README describes the capacity-recovery workflow.

Managed focused 00a17184-f2e1-43a1-afc1-e45a09eb021c passed 108 tests at f6ed795 with observed_match, including owner quota exhaustion and a full 2048-record fixture followed by confirmed cleanup and successful export for another principal. Full verification of this later head is pending. Earlier 0d0e3cb check a7a94062-94b4-4f9b-b993-60051f5d75a8 passed 888 Vitest + 7 script tests, and build 5bdaaf04-e1ec-4c23-8e9b-7ad74e285c5f passed.

## CI timeout diagnosis

GitHub run 37117045484 on 0d0e3cb failed the existing first recovery test at 5 seconds (5836 ms reported), matching the earlier local timeout. Controlled probe 8e523bd / MCP 1ddb2ffd-5799-48ed-a492-e91b6a8d13de measured 4022 ms total, 43 ms in 12 readBoundedJson calls and 0.30 ms in 97 fsync calls. Replacing deep object equality of 700 KB Buffers with exact native Buffer.equals comparisons in a3e3625 / MCP a05a87f6-c7ed-45a9-92f1-e09c2b4fc716 reduced the same scenario to 215 ms; reads remained 38 ms and fsync 0.28 ms. All 108 focused tests passed. No production parser change, timeout increase or assertion weakening. Timing instrumentation was removed in final head 6f3db2f6a6bb82187ae472e8d39b0d18d9907cb4.

Managed full check ba98270d-a360-4085-9d01-a4041a1ba48d passed on f6ed795 (890 Vitest + 7 script tests). Final-head verification is running. The first two new review threads are classified fix, replied with published code/test evidence and resolved. Kimi/Codex review and final merge are pending.

## Final managed verification

All four runs observed clean matching enqueue/preflight/finish Git state at 6f3db2f6a6bb82187ae472e8d39b0d18d9907cb4:

| Preset | Run | Result |
| --- | --- | --- |
| check | b739e1a0-aab2-4d26-9dfb-edc6ae5fc0fe | PASS: lint/types, 890 Vitest + 7 scripts |
| build | 38630531-c312-41b3-9019-f24fb20595f7 | PASS: static dashboard and bundled controller/CLI |
| test:integration | 289e9e71-6498-43c4-81dc-db7897e9d3ec | PASS: 33 built-controller tests, including actual SQLite restore and private CLI cleanup/restart |
| test:ui:user-backups | d6cb113a-2da8-4dae-93b9-0ccab30eefbf | PASS: 17 Chromium tests, PL/EN retries/expiry/keyboard and 1440/1366/390/320 layouts |

No development server was claimed, started or switched. The global test queue remained serial. Browser fixtures use static export with intercepted HTTP; they do not establish end-to-end browser recovery of real data. Exact source records and relevant output tails are in the closeout evidence file. GitHub run 37117584381 and remaining n8n reviews are pending.

## Merge and final external acceptance

PR #73 merged at 2026-10-03T11:02:57Z as `1f9c90fff36af25d5ca609299270d51dabc70a96`, using exact-head matching for `6f3db2f6a6bb82187ae472e8d39b0d18d9907cb4`. Both original agent heads are ancestors of main. There were no separate agent PRs; their two branches were integrated and closed together in #73.

[CI 37117584381](https://github.com/pioootrek/worktree-switcher/actions/runs/37117584381) passed all four jobs: 890 Vitest + 7 script tests, build, HTTPS, 33 integrations, 166 UI and 3 E2E; installed-package smoke passed 14 steps each on Node 22.23.2 and 24.21.0, and disposable systemd lifecycle passed with graceful cleanup/service absent/data preserved. Downloaded artifact and smoke/lifecycle helper SHA256 values were independently checked. Tarball `261ea9d58821fbfbf9ef0dcd9a7e16a8415101b620e395b395e6d15786e5d37f`, 841802 bytes, from clean synthetic merge `0ce5829a0a541835a50cbb740df2e1d40784f520` whose parents are main `a3216e6` and final feature `6f3db2f`. Later main changes before merge were documentation only.

n8n dispatch used dispatch-code-review, target all. Claude's two new findings were fixed in f6ed795, tested, replied and resolved. Both original deferred findings also received replies updating their outcome to implemented fixes. Codex reviewed final 6f3db2f at 11:01:37Z and reported no new actionable issues. Final thread re-fetch found zero unresolved threads and no additional pages. Kimi did not complete: the existing reviewer systemd RuntimeMaxSec=20min stopped it at 11:00 UTC (exit 143, result timeout), with no published review. It is not counted as completed acceptance; host limits were unchanged and the accepted dispatch was not duplicated.

S4u is closed. The parent RWK stays open for S4b off-host transfer and S5 operational acceptance. No production deployment, production database access, host service/limit changes or later slice. Physical power loss, physical disk exhaustion, installed old-artifact upgrade, new-host ledger recovery, actual macOS lifecycle and browser 200% zoom remain unverified.
