---
audience: "contributors validating release resource use"
last_reviewed: "2026-10-19"
source_of_truth: "controller resource budgets and reproducible measurement procedure"
status: "active"
---

# Controller resource budget

Measure the controller's overhead above a bare Node HTTP process on the same
host and Node version. The historical absolute 50 MiB RSS target was below the
observed runtime floor and is no longer an acceptance criterion. Managed
applications retain resource priority.

## Acceptance criteria

The canonical benchmark requires all three independent runs to satisfy:

| Metric | Budget |
| --- | --- |
| Median controller RSS minus baseline, with 0 or 3 stopped projects | at most 32 MiB |
| Median controller RSS minus baseline, with 3 running projects | at most 96 MiB |
| Post-cycle median RSS minus pre-cycle median RSS, with the same three servers running | at most 32 MiB |
| Controller CPU with 0 or 3 stopped projects | at most 0.5% of one logical CPU |
| Controller CPU while monitoring 3 running projects | at most 5% of one logical CPU |
| Retained runtime logs / resource-history points per project | at most 400 lines / 60 points |

The numbers are implemented in `scripts/resource-metrics.mjs`. CPU is accumulated
user plus system process time divided by elapsed monotonic time, not a share of
all host CPUs. RSS includes the Node runtime, native SQLite allocations and
resident mapped pages; it is not V8 heap usage or an exact allocation counter.
The baseline difference estimates incremental resident cost. It does not
attribute every page to application code.

Use the median to reduce sensitivity to individual samples; retain peak RSS
and every raw sample for diagnosis. Peaks cover the idle observation windows,
not the unobserved instant of a log burst. A passing median does not prove that memory
can never grow over a longer session. This bounded workload supplements the
implementation's fixed log/history limits and regression tests. The retained-log
check covers runtime tails. Batching disk writes reduces allocation overhead
but does not impose a pending-byte limit or backpressure on continuous output
that exceeds disk throughput; this finite workload does not certify that case.

## Queued verification summaries

Stage 1 adds event-driven phase measurement; stage 3 adds passive per-run resource sampling.
Each run keeps a small monotonic phase observation map until finalization;
resource observers share the existing admission and capacity decisions. Detail and summary writes
share one transaction/connection, with summary updates skipped for unchanged
payloads (for example log-only checkpoints).

Summary history uses 30 days, 5,000 records/16 MiB per project and
50,000 records/128 MiB globally; each serialized summary is capped at 8 KiB.
The byte budgets count JSON only, not physical SQLite/WAL/index allocation.
Maintenance uses indexed age/project ordering and accounting totals, deleting
at most 64 terminal rows per call, after completion and once per minute.
Active rows are protected. A backlog after downtime is drained incrementally
and exposed by coverage metadata. Record/byte caps can shorten the time horizon;
30 days is a calibration default, not a guaranteed history window.

Migration backfill reads at most 64 existing details at once and writes only
legacy/unknown timing. Coverage and summaries cascade with project deletion.
No logs, environment values or arguments are copied to history. These bounds
and tests establish storage behavior; they do not claim a measured CPU/RSS
overhead for telemetry or any resource limit on supervised commands.

## Reproduce the benchmark

On Linux with `/proc` available, Node and Git installed:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm bench:resources --report /tmp/switcher-resources.json
```

The command verifies the build fingerprint before starting. The JSON report
records the Git revision, source fingerprint, bundle and benchmark script
hashes, Node/kernel/CPU details, sampling parameters, load averages, raw samples,
individual budget checks and cleanup result. A failed measurement or cleanup
returns non-zero. Missing samples never become a passing zero.

Each of three runs creates fresh temporary state and performs these phases in
order. Every phase settles for 15 seconds and then samples once per second for
30 seconds. There is an initial sample plus 30 intervals. Settling covers three
five-second resource-sampler periods, and observation covers six more.

1. Bare Node HTTP server, then stop it.
2. Built foreground controller with no registered projects.
3. The same controller with three registered, stopped projects.
4. Three running fixture servers, before the repeated workload.
5. The same three running slots after 30 sequential worktree switches, each
   followed by 2,000 log lines of 129 bytes. Total workload is 60,000 lines.

Each fixture is a dependency-free Node server in a real Git repository with two
worktrees. The controller uses its real SQLite database, launch adapter, HTTP
operations, log writer and resource sampler. HTTP and MCP listeners are enabled;
there are no connected browser/SSE or MCP clients during measurement. This is
an idle-controller gate, not evidence about open dashboards or agent load.

The baseline and controller use the same test-only Node preload
`scripts/resource-probe.mjs`. One IPC request per sample reads
`process.memoryUsage.rss()` and `process.cpuUsage()` inside the measured process.
Its overhead is present in both runs. The driver, browser and managed server
memory/CPU are excluded from controller measurements. No forced GC is requested. Linux monitoring uses at most eight concurrent
workers per scan, each reusing an 8 KiB buffer for process stat/status records.
Records of exactly 8 KiB are accepted after an EOF probe using the same buffer.
An oversized record rejects the sample after all worker descriptors close, so
monitoring reports unavailable instead of publishing an incomplete group total.
The disk log writer batches queued lines into writes of up to 64 KiB (except
an individually larger line), preserving line boundaries at rotation and
flushing accepted output on close. This avoids per-line promise chains.

Run builds, browser suites and this benchmark sequentially. Schedule sampling
away from other heavy host work and retain the load metadata. Investigate a
failure on a busy host and record any rerun; do not silently select the best
run. These are release checks rather than a noisy mandatory per-PR RSS gate.
`pnpm check` runs deterministic tests of the metric calculation.

## Check that the gate detects a regression

```sh
pnpm bench:resources --runs 1 --negative-control --report /tmp/switcher-resources-negative.json
```

This uses the same controller and workload. Immediately before the final phase,
the test-only preload retains and touches an extra 128 MiB buffer in the
controller process. The command must return non-zero, the report must name a
failed memory check, and cleanup must still be graceful. This is a bounded
runtime fault injection into the release bundle, not an intentionally shipped
production defect. It tests sensitivity to retained memory; it does not by
itself establish sensitivity to every CPU or Git-polling regression.

Shorter `--runs`, `--warmup`, `--seconds` and `--cycles` values are useful for
checking the driver. Such reports have `canonical: false` and cannot certify
release acceptance. Increasing the observation duration is appropriate when
investigating gradual growth; record the changed parameters.

## Isolation and interpretation

The benchmark owns only its freshly spawned processes and temporary directories.
It records observed descendant identities with Linux process start ticks and
checks they have exited after controller shutdown. Emergency termination fails
the run. It never treats an occupied port or a recycled PID as ownership.
It does not install, restart or reconfigure a user service, change host resource
guards, or use a registered project's development port.

Record fresh release evidence under `docs/backlog/notes/`. Historical RSS values
remain dated observations, not current promises. Broader multi-project
acceptance still needs its browser and owner-workflow evidence.

Measured evidence for the implementation incorporating PR #20 is recorded in
[the 2026-09-09 acceptance report](backlog/notes/NOTE-20260909-controller-resource-budget/findings.md),
including raw samples, failed candidates, margin and the negative control.

## Verification history reads

Summary analysis borrows the existing SQLite connection. Project/enqueue-time
range reads use `test_summaries_project_history`; there is no analytics database
or background scanner. A history page parses at most 1,000 summary candidates
and stops earlier after 50 matches. Metrics parse at most 5,000 candidates,
then calculate exact per-run percentiles in memory. Both permit one additional
unparsed lookahead row. Single-summary reads use the primary run ID index and
check project identity; comparison performs two such lookups. Detailed-run
availability uses indexed existence checks without decoding log tails.

The enqueue-time window is at most 31 days. Each summary has the existing
8 KiB serialized budget, giving a history page at most 400 KiB of compact
summary JSON plus wrappers and coverage. MCP pretty-printing adds whitespace.
Metrics can examine at most 40 MiB of serialized summary payload per request;
JavaScript object and sorting overhead are additional bounded costs. Results
contain only fixed outcome/population/duration groups. The limit applies before
identity filters, so a rare filter can yield an empty, truncated selection.
Every response exposes the relevant selection and retention limits. These are
logical budgets; they do not claim a physical SQLite disk or process RSS cap.

The isolated SQLite verification fixture exercises 5,000 summaries per project
and 50,000 globally, prints query plans, elapsed times and response sizes, and
asserts indexed access and candidate limits without a machine-speed threshold.
See [verification history API](verification-history-api.md) for consistency and
statistical semantics. Existing summary retention policy remains unchanged.


## Passive verification sampler cost

Runtime and finite-job Linux observers share one single-flight `/proc` stat
enumeration, cached for 250 ms after completion. The collector permits eight
open process-file readers globally, reusing eight 8 KiB buffers, with at most
256 waiting readers, 32,768 enumerated records and 4,096 candidate members per
group. Over-budget scans fail as missing measurements. RSS is read only for
requested group members and followed by another stat read to reject identity
changes during the read. Vanished processes during global stat enumeration
mark coverage partial with `process_churn`; their membership is unknown.
Other global read failures and missing/unreadable owned RSS/stat candidates
remain `incomplete_scan`. Oversized records reject the sample. Repeated runtime ticks coalesce
while a previous sample is pending; finite jobs schedule their next attempt
only after the preceding one completes.

Capturing a new job's leader also records the next collector scan generation.
Its first snapshot requires an enumeration started after capture, so neither a
warm cache nor an older in-flight directory listing can omit a newly spawned
leader solely because it predates spawn. An older flight drains before one
shared replacement starts; there is no retry loop or parallel full scan. Later
snapshots retain that minimum generation and use the ordinary shared cache.
Distinct captures during successive scans can require additional scans, so
unsynchronized job startup cost remains workload-dependent.

The first observation is still non-atomic. If the captured leader exits before
it and a surviving child are observed together, PGID alone cannot prove that
child's ownership. Observation then ends conservatively with `identity_lost`.
An unreadable or disappearing anchor during member validation can also prevent
that first observation. Freshness does not recover never-observed generations
or weaken permanent identity loss after continuity is lost.

The finite-job default is an immediate attempt followed by a one-second delay
after each attempt. No idle observer timer runs after completion. A short run
can legitimately have no samples. These measurements describe sampled sums
and CPU intervals; see [resource semantics](verification-history-api.md#passive-per-run-resources).

Run the bounded sampler-only probe with the discovered queue preset
`node:test:resource-sampling-cost` (package command
`pnpm test:resource-sampling-cost`). It runs three sequential repetitions of
fresh Node workers: baseline, one sampled group and three sampled groups. All
arms have three idle two-process fixture groups, six one-second intervals and
an initial sample. It records each RSS point, user+system CPU, actual elapsed
time, scan latency, environment/load and baseline deltas. Cleanup uses only
freshly spawned owned groups. SIGTERM/SIGINT request cancellation in both
parent and worker; the parent awaits worker termination and the worker awaits
all group cleanup attempts, even if one fails. Interruption and cleanup failure
exit unsuccessfully without reporting confirmed probe cleanup. Fixtures have
20-second lifetimes and close when their worker pipe disappears. These provide
bounded fallback after abrupt worker death, not synchronous SIGKILL cleanup or
an OS failure guarantee. It starts no server
or service and touches no supervised project. This short sampler-only probe
cannot certify controller release budgets, database/UI overhead, busy child
churn, accuracy, or long-duration behavior. Keep the full JSON and all runs;
do not select the best repetition or invent a pass threshold.
