# S4u integrated closeout, 2026-10-03

Status: in progress. Owner authorized completing both agent threads, n8n review and merge when ready. GitHub has one open PR (#73); the two agent branches had no separate PRs. Both are integrated into the existing feature branch, preserving their commits.

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
