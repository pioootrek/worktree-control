# Test result clarity stage

Owner authorized this stage on 2026-09-28 after accepting the existing Markdown attachment/import behavior. No description-format, content-model or import changes are required.

Base: `f4f002a`. Implementation delegated to Sol high in `rework/test-result-clarity` on a separate worktree. Root owns serial managed verification, pilot acceptance, n8n review and merge after green checks.

## User outcome

Separate the command outcome, source observations during execution, and relevance to the current worktree. Show the project, branch and observed revision without presenting the enqueue revision as proof of executed source. Explain unavailable relevance with a concrete reason and a useful next step. Keep the run-specific output easy to reach. Associate a failed server start only with its actual worktree and matching logs if existing contracts support this without expanding runtime lifecycle scope.

## Evidence and constraints

The original RT-04 audit did not identify why freshness was unknown. A read of the isolated pilot on 2026-09-28 around 19:49 UTC found four completed runs with observed_match, complete clean source observations, equal current HEAD and clean worktrees, but metadata.status stale (lastSuccessfulAt around 16:58 UTC). This is sufficient to explain current unknown results. The cancelled-before-start run has pending attribution and no preflight/finish; it must not be described as still awaiting execution.

Preserve the existing current-result gate: terminal command, observed_match, complete clean observation, equal HEAD, clean current worktree, no Git status error and fresh snapshot metadata. A passed command alone is never proof of current source verification. Known local changes and missing/stale/error metadata remain distinct. Do not change queue admission, authorization, source observation collection or server ownership.

Keep latest/history selection, filters, paging, cancellation, and focus return. Use existing shadcn components and PL/EN translations. A server failure must never label unrelated worktrees or link to a different project's log. Runtime/chart/global-log-search improvements outside these acceptance criteria remain later stages.

## Acceptance

Model and UI coverage for current, changed HEAD, local changes, missing worktree, incomplete/uncertain/legacy observations, stale/error/missing metadata, active and cancelled-before-start runs. Test that process outcome and filters retain existing semantics. Check observed versus queued revision, exact output navigation, localized close actions and keyboard return.

Managed check/build/UI, serialized with any pilot browser work. Inspect real pilot desktop/mobile, short viewport, PL/EN, dark/light and actual browser zoom. Reproduce failure states on isolated fixtures only. Record tested commits, screenshots and limitations. Dispatch n8n once per PR, handle actionable feedback, merge only after required checks are green.

References: [shadcn Sheet](https://ui.shadcn.com/docs/components/radix/sheet), [shadcn Alert](https://ui.shadcn.com/docs/components/radix/alert), [UI standards](../../../ui-standards.md).
