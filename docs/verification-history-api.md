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
`resources.cpu` and `resources.rss` now return statistic objects instead of the
stage-2 literal `"unavailable"`. The top-level keys are preserved, but clients
must handle this deliberate type evolution. CPU names `peak_sampled_cpu_percent`
and unit `percent_one_core`; RSS names `peak_sampled_summed_rss` in bytes. Each
has the same fixed `populations` as durations, with `median`, `p95`, `valid`,
`missing`, `denominator`, status counts, summed `sampleCount` and
`cpuIntervalCount`. Partial measurements enter the descriptive statistics with
their quality counts exposed. Legacy gaps never enter as zero. Filter identities
and inspect quality before using an aggregate. Runner wait remains `"unavailable"`;
process duration can include an external runner's unobserved lock wait.

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
environments. Resource comparisons return `left`, `right` and right-minus-left
`delta`, labelled `descriptive_sampled_peaks_only`. Deltas require both runs in
`completed_execution`, both resource states `sampled`, and identical source and
interval. Otherwise deltas are null while individually observed peaks remain
visible. Matching cadence does not ensure matching coverage or workload.
Runner wait remains unavailable.

## Passive per-run resources

`get_test_run`, retained summaries and history entries expose
`telemetry.resources`, a nested version-1 record stored in the existing JSON.
SQLite remains schema 29. Old JSON without resources reads as `legacy_unknown`.
Existing retention caps and transactions apply; pruning details preserves the
summary. Recovery retains checkpointed observations and marks their quality
partial with `controller_interrupted`. It cannot reconstruct lost samples.

The observer starts only from a freshly spawned detached child and captures
its `/proc/PID/stat` start ticks. Each accepted snapshot must contain that
same leader generation or a previously observed surviving member generation.
A reused leader or loss of every known member permanently ends observation.
PID/PGID alone and persisted PIDs never establish sampling identity. Children
that leave the process group are outside coverage. Process stopping keeps its
existing ownership and retry behavior.

The initial attempt is immediate, then another attempt follows one second
after the preceding attempt completes. Scans never overlap within an observer;
slow reads increase the actual spacing. `intervalMs` is the configured delay,
not a promise of exactly one sample per second. `firstSampledAt`,
`lastSampledAt`, `attemptCount`, `sampleCount`, `missingSampleCount` and
`partialSampleCount` describe observations. `peakSampledProcessCount` counts
the largest observed group. `status` is `pending`, `sampled`, `partial`,
`unavailable`, `unsupported` or `legacy_unknown`. `sampled` means no detected
read/identity gaps, not complete temporal coverage. Bounded `reasons` report
gaps, churn, identity loss and interrupted/discarded reads.

`peakSampledRssBytes` is the largest sampled sum of member RSS. Shared resident
pages count once per process, so the sum can double count memory. Reads are
sequential observations, not an atomic snapshot. Peaks between attempts and
short-lived children can be missed. This is neither cgroup memory, allocation,
page-cache accounting nor a complete job peak.

CPU uses only nonnegative deltas between adjacent observations of the same
PID **and start ticks**. New/dead/reused members never add or subtract lifetime
CPU counters. Missing snapshots break the CPU interval. Valid member deltas
are summed and divided by host CPU-tick deltas, multiplied by the logical CPU
count; 100% represents one core and values may exceed 100%.
`peakSampledCpuPercent` is the largest observed interval value,
`cpuIntervalCount` its denominator and `observedCpuWindowMs` the sum of these
observed intervals. Churn makes this a partial CPU observation of surviving
members. CPU of unobserved/dead children and the initial/final tails is unknown;
there is no inferred total CPU time. No valid interval leaves the peak null.

Observation continues through leader exit/cleanup retries and stops after
confirmed group cleanup. Stop clears the timer immediately and discards late
reads; bounded file reads already underway drain and close without delaying
slot release or changing the finalized summary. Sampling errors cannot change
the command, exit/signal, stop cause or source qualification. Resource-only
checkpoints occur after the initial observation and at most once per ten seconds afterward; existing lifecycle/log writes
and finalization also retain observations. No raw resource history is stored.
No signal alone is diagnosed as OOM. This observer sets no limits or budgets
and exports no telemetry.
