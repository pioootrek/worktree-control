---
audience: "agents and contributors using verification history"
last_reviewed: "2026-10-19"
source_of_truth: "shared verification history operations and transport contracts"
status: "active"
---

# Verification history API

The `ControlService` facade delegates to `VerificationHistoryService`. HTTP and
MCP use these same validated operations on the controller-owned SQLite
connection. They perform no Git discovery, start no server, and require no
claim. They require the same runtime authority as `get_test_run`: legacy runtime
access or installation authentication under the selected installation mode.
Project-scoped Knowledge credentials have no verification permission. HTTP
keeps existing token, session and origin guards; MCP omits these tools entirely
from scoped sessions and reauthenticates each request.

| MCP tool | HTTP GET route | Required input |
| --- | --- | --- |
| `list_test_runs` | `/api/projects/:projectId/test-runs` | `from`, `to` |
| `get_test_run_summary` | `/api/projects/:projectId/test-runs/:runId` | Project and run UUIDs |
| `get_test_metrics` | `/api/projects/:projectId/test-metrics` | `from`, `to` |
| `compare_test_runs` | `/api/projects/:projectId/test-run-comparison` | `leftRunId`, `rightRunId` |

MCP carries `projectId` in its argument object; HTTP gets it exclusively from
the route. HTTP returns the operation result directly. Query strings carry
HTTP filters, integers as decimal text and booleans as `true` or `false`.
Duplicate query keys and unknown fields fail. Invalid HTTP requests use the
existing 400 error response; MCP returns its existing tool error form. A
missing summary and a run ID belonging to another project produce the same
safe error. Existing `get_test_run` and `/api/test-runs/:runId` semantics do not
change; detailed records can disappear while summaries remain available.

## Filters and retained data

History and metrics require `from` and `to` as canonical UTC timestamps, such
as `2026-10-19T00:00:00.000Z`. The inclusive interval selects **enqueue time**,
not process start or finish, and can span at most 31 days. Exact optional
filters are `presetId` (160 characters), `worktreePath` (1,024), `head` (128),
`statusDigest` (128), `dirty` (boolean), `processOutcome` and `attribution`.
Filters are combined with AND. Identity strings are the stored bounded
summary identities, including a `sha256:` identity if stage 1 shortened an
oversized value. They do not accept arbitrary SQL or regular expressions.

Process outcomes are `passed`, `failed`, `cancelled`, `timed_out`, `interrupted`
and `unknown` (a null process outcome). Attribution is independently `pending`,
`observed_match`, `changed`, `uncertain` or `legacy_unknown`. A passed process
can still have failed phase and changed source. No read changes source
qualification. No timestamp arithmetic reconstructs missing durations.

Each history entry and summary lookup returns `{summary, detailAvailable}`.
The summary remains the version-1 bounded record from stage 1. It omits raw
command arguments, environment values/names, profile values, errors and logs.
`detailAvailable` is an indexed existence observation at read time; it does
not guarantee the detail will survive the next request.

History and metrics return project-wide `coverage`: retained record/JSON byte
counts, oldest/newest enqueue timestamps, lifetime eviction count, last pruning
time, policy and pending maintenance. `historicalCompleteness` is always
`not_guaranteed`. This describes the retained project, not a count of all
matching historical executions. Migration backfilled only retained details;
older deleted details cannot be reconstructed. Retention can evict inside a
requested interval and below its age target. Count/byte targets can temporarily
be exceeded by active data and incremental maintenance. The stage-1 defaults
remain 30 days, 5,000 records/16 MiB per project, 50,000/128 MiB globally,
8 KiB per summary and at most 64 deletions per maintenance call.

## History pagination and cost

`limit` defaults to 50 and accepts 1 through 50. Order is descending
`(queuedAt, runId)`, including a deterministic run-ID tie breaker. The page
iterates the project/time index, parses at most 1,000 candidate summaries and
stops as soon as `limit` matches have been found. It reads at most one extra
unparsed row to detect continuation. `selection.scanned` counts parsed
candidates, before optional filters. `scanLimitReached` indicates that the
candidate budget interrupted a page with more candidate rows available.

Follow `nextCursor` until it is null, including after an empty filtered page.
The cursor is signed, versioned and bound to project, normalized filters,
window and fixed order. A caller may change page size. The 2,048-character
cursor limit bounds decoding. Invalid, altered, differently scoped or
pre-restart cursors fail safely. Start a new listing after controller restart.
No cursor state accumulates on the controller.

The first page anchors its highest candidate key. Later pages seek strictly
below the previous last scanned key. Newer insertions above the anchor are
excluded; deletions and retention do not duplicate or offset existing rows.
This is `live_keyset_not_snapshot`: backdated inserts below the current key
may appear, rows inserted into already visited ranges are omitted, and updates
to mutable outcomes/attribution can change filter membership. Repeat a fresh
listing when current membership matters. No result claims snapshot completeness.

## Metrics and populations

Metrics select the newest 5,000 candidates in the project/time interval **before
optional filters**. `selection.scanned`, `scanLimit`, `truncated`, `matched`
and order make that selection explicit. Truncation means more retained candidate
rows exist in that interval, even if filters matched none of the selected rows.
Narrow the time window to analyze an older or smaller population. The query
never scans unrelated project history or computes an uncapped matching total.

`processOutcomes` and `sourceAttributions` count matched summaries independently;
each axis sums to `selection.matched`. Duration statistics are partitioned:

- `in_progress`: queued/running phase, including unfinished finalization.
- `cancelled`, `timed_out`, `interrupted`: respective run phases, even when a
  known passed process result survived recovery or cancellation.
- `rejected`: rejected preflight or spawn error without those censored phases.
- `completed_execution`: passed/failed process outcome, exit termination,
  observed spawn/exit/finalized timestamps and confirmed cleanup.
- `other_incomplete`: remaining records, including legacy data and unconfirmed
  cleanup. They are not treated as completed execution.

Every population includes count and separate queue, prepare, process, cleanup,
finalization and total statistics in milliseconds. Each statistic has
`denominator` equal to that population's count, `valid` finite nonnegative
measurements and `missing = denominator - valid`. Null, legacy, invalid or
missing measurements are excluded, never replaced with zero. Empty valid sets
return null median and p95. Incomplete populations can contain measured partial
intervals; their statistics remain explicitly separate from completed execution.

The median is the middle sorted value, or mean of the two middle values for an
even sample count (`sorted_midpoint_mean`). p95 is exact nearest rank,
`sorted[ceil(0.95*n)-1]`. Both use raw selected per-run observations; there is no
averaging of daily percentiles. There are no unbounded group-by dimensions.
CPU, RSS and runner wait have explicit `unavailable` status. Process duration
can include waiting inside an external runner whose lock boundary is unobserved.

## Comparisons

Both run UUIDs must resolve to retained summaries within the specified project.
Pruned or inaccessible summaries fail with the same missing-run error; no
partial comparison reveals another project's run. Comparison returns both
entries, identity difference flags for source/command/profile/preset/worktree,
per-run populations and right-minus-left timing deltas. A delta is null if
either observation is unavailable. Censored deltas are descriptive and include
an explicit caveat; they are not a completed-execution regression verdict.

Caveats identify differing identities, unqualified or missing source observations,
missing timing and incomplete execution. Every comparison explains that matching
SHA/status digest does not prove identical files, environment, installed tools
or external services. Profile digests identify policy selection, not secret
values. No comparison declares flaky tests, unnecessary repeats or equivalent
environments. CPU/RSS and runner wait remain unavailable.
