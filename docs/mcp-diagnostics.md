---
audience: "operators and contributors measuring MCP resources"
last_reviewed: "2026-10-07"
source_of_truth: "implemented diagnostic read, session policy observations and measurements"
status: "active"
---

# MCP observations and repeatable measurement

The diagnostic read observes the controller. Session admission, idle cleanup and
claim renewal policy are implemented in the `mcp-sessions` application module and
described in [session liveness, cleanup and admission](reservations-and-mcp.md#session-liveness-cleanup-and-admission);
this read reports their outcomes and never decides them.

## Local administrative read

Run `worktree-control mcp diagnostics` against a running controller. For an
isolated instance, supply `--data-dir PATH --state-dir PATH`, or use the existing
path environment variables. The CLI sends the exact `mcp-diagnostics` command
to the existing owner-only Unix socket (0700 directory, 0600 socket). It never
opens SQLite or starts an absent controller. Timeout is five seconds and the
CLI bounds the response to 64 KiB. There is no public HTTP route, extra MCP tool,
scoped-credential permission or dashboard in this slice.

The transport's public snapshot and the application's status-wait diagnostics
are the read operations. Input validation is shared by the local socket
handler. The read has no lifecycle effects, including during maintenance.

| Observation | Meaning and limits |
| --- | --- |
| `connections` | Physical open sockets on the dedicated MCP listener, including idle keep-alive and unauthenticated connections. Neither agent count nor logical session count. |
| `logicalSessions`, `initializingSessions`, `drainingSessions` | Initialized registry entries, not-yet-initialized observations, and closed entries whose accepted handlers/responses have not settled. |
| `openResponses`, `sseResponses` | Authenticated session-bound HTTP responses still open; SSE is counted when the transport emits successful GET response headers. HTTP POST with JSON response also consumes a response. |
| `operations` | Executing registered protocol handlers (tools, resource reads/lists, etc.), excluding SDK bootstrap initialize/ping handlers. Count remains until `finally`, including a handler ignoring cancellation after close. |
| `runtimeRetryEntries` | Existing global retry-ledger occupancy, including completed receipts. Its existing bounds are 64/session and 512/global; it is not a running-call counter. |
| `claims`, `renewalTimers`, `lifetimeTimers`, `drainTimers` | Session-held claim/renewal handles and actual controller-owned timers. `lifetimeTimers` is each open session's single deadline timer (absolute lifetime and idle policy); `drainTimers` exist only while a policy close drains accepted calls. Persisted reservations can outlive these handles and must be inspected through existing project status. |
| `statusWaits` | Per-session entries contain only owned waiters and waiter timers, using an owner-key lookup. Targets and the single shared sampling timer appear only in the global administrative `statusWaits` object. Closed/draining session attribution can be unknown; global counts remain available. |
| `resourceSubscriptions` | Zero: this adapter registers no resource subscription handlers. SDK internal stream maps/keep-alive timers have no public inspection API and are explicitly `unknown`. |
| `lastClientMessageAt` | Last validated JSON-RPC message delivered by the transport after authentication and session binding; includes protocol housekeeping. |
| `lastClientRequestAt` | Last application-shaped tool/resource/prompt request delivered by the transport, including listing; it can still fail application validation. An observation only. |
| `lastQualifyingActivityAt` | Last authenticated `tools/call` or `resources/read` started or settled by the session. The only input to the idle and renewal policy. |
| `state`, `transportPhase`, `closeDueAt`, `closeDueReason` | Per session: `open`, `draining` or `closed`; transport `open`, `interrupted` (an SSE stream existed, no response is open), `request-only` (never streamed) or `closed`; and the deadline at which the policy would close it if nothing changes. |
| `renewalPolicyState`, `renewalsSkippedByPolicy` | Per session `none` (no claim), `renewing` or `stopped-idle`; the global and per-session counts of renewal ticks skipped because the client was idle. A skipped renewal never releases the lease. |
| `admission`, `policy` | Admitted sessions (including initializing and draining ones), number of distinct credentials and the largest per-credential count, the configured bounds and limits in seconds. No credential identifiers. |
| `lastAutomaticRenewalAt`, renewal success/failure totals | Server-generated renewal, recorded separately; never advances client activity. |
| `agentState`, client/proxy process fields | `unknown`: an HTTP server cannot prove an agent/process is alive behind a proxy. `no-open-response` is an observed transport state, not an inactive-agent classification. |
| Close reasons | Client DELETE, absolute lifetime, authentication policy, controller shutdown, failed initialization, `idle-expired`, `abandoned-transport`, `admission-refused` (a refused initialize; no session is created) and otherwise transport close. Cancellation is not recorded as successful termination. |

No credential IDs, raw MCP session IDs, lease tokens, client names, request
bodies or arbitrary error labels enter the snapshot. Session labels are local
sequence numbers with no authority. Every event changes fixed counters in O(1).
Reads return at most 32 session details, ordered with claim holders and
renewal timers first, then sessions with open responses, then the most recent
activity; `truncated` (also `omittedSessions`) counts the rest. Retained
observations are bounded by session admission. Recent closures keep at most 64
entries for 15 minutes, pruned on reads. Aggregate counts remain exact. Closed
observations are released when their tracked work settles.

There is no new background sampler or production histogram. Process CPU/RAM is
sampled on demand at most once per five seconds, with a timestamp and age. The
first CPU sample is unknown; subsequent percentages are elapsed CPU time as a
percentage of one logical core. The process sample is the controller alone,
not descendants, managed servers or proxies.

## Reproduction

Build the source through its verification queue, then run
`pnpm bench:mcp-resources test-results/mcp-resources.json 3 /path/to/mcp-remote/dist/proxy.js`.
The benchmark requires an already available `mcp-remote` 0.8.2 fixture and
records the proxy entry's SHA-256. It adds no proxy to the production package.
Like the existing `bench:resources`, `bench:mcp-resources` is a supported finite
measurement command, not a discovered test preset. Tests, check and build use
`list_worktrees`, `list_test_presets`, `run_test` and terminal polling.
This finite measurement uses three sequential isolated controllers,
three small connect/DELETE cycles per run, an owned SDK client, and the pinned
`mcp-remote` fixture. There is no production endpoint argument.
Private tokens/session IDs stay in temporary state, private IPC or child
process environments; reports contain only bounded observations.

The script creates a temporary database/state directory and tiny Git fixture,
uses ephemeral loopback ports, and owns every measured controller/client.
It captures Linux `/proc` CPU/RSS with process start identity, one-second
sampling and short three/five-second windows. Controller event-loop delay uses
a measurement-only preload with one 100 ms histogram. It launches no process
supervisor and selects no foreign processes for termination. Source hash,
platform, CPU, proxy version, snapshots and cleanup are saved to
`test-results/mcp-resources.json`. Short CPU windows are quantized by CLK_TCK;
this is not a host-capacity or saturation benchmark.

The direct client's transport is closed/reconnected with the same session,
a 20-second status wait is observed in flight, and a 30-second claim is followed
by forced loss of the owned client without DELETE. Reads after its original TTL
check continued renewal. Only that fixture session is subsequently deleted;
remaining lease availability is measured. Its server and accepted five-second
verification must survive caller loss. Proxy CPU/RSS and confirmed proxy exit
are measured separately. No result establishes orphan-process behavior in
Codex, Claude, T3 or another proxy version.

The report also compares the same controller's idle CPU/RSS with one diagnostic
read per second and microbenchmarks 10,000 observation updates plus 1,000
32-session reads/serializations. These measure marginal update/read cost;
short-window RSS differences alone are not a causal memory-leak result.

## Recorded measurements — 2026-10-05

The [raw resource report](measurements/mcp-diagnostics-20261005-resources.json)
and [queued verification evidence](measurements/mcp-diagnostics-20261005-verification.json)
refer to clean code/driver commit `866a049a29dfe507da054643d2946b351fe02f1d`.
All three sequential runs passed and confirmed owned controller/client exit
and temporary-state cleanup. Node v24.19.0, Linux 7.0.0-34-generic,
Intel i5-10600T (six logical CPUs), CLK_TCK 100; this describes the measurement
host, not a portable resource requirement. The pinned proxy was `mcp-remote`
0.8.2. Its entry hash and source/build/CLI/driver hashes are in the raw report.

Ranges below combine all three runs. CPU is percent of **one logical core**
in the scenario's three-second window; it excludes earlier initialization
bursts. RSS is `/proc` resident memory, in MiB (1,048,576 bytes). Client/proxy
RSS is measured separately from the controller. This was a small sequential
workload on a shared host, with no production traffic or saturation test.

| Scenario | Observation | Recovered / remaining resources and timing | Controller RSS / CPU |
| --- | --- | --- | --- |
| Baseline | Zero sessions, sockets, calls, waiters and session timers. | Controller alone; first diagnostic CPU sample is unknown. | 108.27–108.44 MiB / 0% |
| Three connect / DELETE cycles | Each connect: one logical session, one SSE, one lifetime timer; up to three sockets. | DELETE observed session/SSE/timer counts return to zero in 2.84–9.33 ms request-to-read latency; two idle keep-alive sockets can remain. This is counter recovery, not proof of GC. | First connect 123.11–123.89 MiB / 0%; after third DELETE 136.57–138.52 MiB / 0% |
| Transport interruption / same-session reconnect | Sockets and open responses 1 → 0; logical session and lifetime timer remain one. Reconnect still has one session. | Transport resources recover at the next read; no logical cleanup is expected. Reconnected SDK fixture uses POST without reopening SSE. | 137.07–139.14 MiB / 0–0.33% |
| 20-second operation | One call, waiter, waiter timer, target and shared sampler while waiting. | All five counters return to zero after 20.007–20.008 s; logical session/lifetime timer remain. | 138.36–139.64 MiB / 0–0.33% |
| Owned client disappears without DELETE | Confirmed child exit; sockets zero, but session, claim handle, renewal timer and lifetime timer remain one. After 12 s one renewal; after 35.08 s three renewals and reservation still held beyond its original 30 s TTL. | Client RSS zero; no session/renewal recovery in the observed interval. Last client request timestamp does not advance with renewal. | At 35 s: 164.73–169.50 MiB / 3.66%; renewal/work during the window is included. |
| Explicit DELETE after abandonment | Session/claim/timer counters zero; persisted lease retains its remaining TTL. | Reservation available 28.899–28.918 s after DELETE. Fixture server stays running and its accepted five-second test passes in every run. | 171.87–172.59 MiB / 0–0.33% |
| Pinned proxy connect / exit | One owned proxy process creates **two** logical sessions/SSE streams in this fixture. Its confirmed exit closes all sockets/responses. | Proxy RSS zero after exit; two sessions and two lifetime timers remain until fixture controller shutdown. The cause of the two sessions is not established here. | 171.90–172.59 MiB / 0–1.33% across connect/exit windows |

The owned SDK client consumed 103.09–106.66 MiB and 1.00–1.33% CPU in
its connected window. The separate proxy consumed 115.20–116.26 MiB and
0–0.33% CPU. These values are not part of controller RSS/CPU. Ending a logical
session is not evidence that a proxy process released its memory.

At the end of the workload, controller RSS did not return to the cold baseline.
The sequence also loaded the SDK, runtime/test workflows and retained proxy
sessions. Without a matched warmed baseline and GC/allocator analysis, the
RSS change cannot be attributed to a leak or to diagnostic storage. The report
preserves individual samples and process start identities for follow-up.

### Diagnostic overhead and verification

10,000 client-message/start/finish observation sequences took 8.67 ms wall time and 9.97 ms CPU
(about 0.87 microseconds wall time/sequence). 1,000 snapshot plus serialization
reads with 32 session details took 37.36 ms (about 37.36 microseconds/read);
the sampled response was 14,321 bytes. This response size is not a proven
worst case. Detail/history caps and the CLI's 64 KiB limit remain authoritative.
The administrative socket read has no background polling; process samples
are cached for five seconds.

One read per second in five-second windows produced controller CPU pairs
idle → polled of 0.599 → 0.798%, 0.999 → 0.599%, and 0.599 → 0.798%.
RSS stayed equal within each pair (171.90–172.59 MiB across runs).
Differences of −0.400 to +0.199 percentage points are at the short-window
CLK_TCK resolution and are not evidence of zero cost or a causal CPU saving.
The measurement-only histogram used 100 ms resolution; its roughly 100 ms
samples include that interval and must not be reported as 100 ms controller lag.

Supported queue checks on the same clean code passed: focused MCP/status tests
(23), `pnpm check` (1,006 Vitest tests plus 18 script tests), build, and the built
local administrative CLI integration (one test). The saved evidence records
run IDs, timestamps and matching enqueue/preflight/finish source observations.
A preliminary fixture setup failed before controller startup; an intermediate
SSE regression/check failed. Both were corrected; neither is passing evidence.
The final report supersedes preliminary resource reports. Dashboard code/flows
were not changed; the actual CLI and MCP transport were exercised instead.

These small measurements do not calibrate 64-session capacity, and a 20-second
wait does not validate multi-minute calls or full-body memory pressure. Expiry
races, lost-write responses, eight-hour expiry and admission were covered later
by the acceptance tests listed under the implemented session contract below.

Review follow-up corrected per-session attribution: the preserved historical
raw report's nested `targets` and `samplerTimers` mirror global counts and must
not be interpreted or summed as session-owned resources. The current read
omits those nested fields; global measurements above are unaffected. Focused
transport regressions additionally cover acquisition/explicit renewal/release
settling after session closure and rejected initialization cleanup. A claim
acquisition completing after closure does not retain its secret or start an
automatic timer; the persisted lease keeps its remaining TTL. This is cleanup
of an already closed session, not a new inactivity or admission policy.

Follow-up [queued verification evidence](measurements/mcp-diagnostics-review-20261005-verification.json)
records a clean `263bd8a` full check (1,011 Vitest and 21 script tests), build
and built CLI integration. The script regressions include actual owned-child
early exit: controller/state teardown still runs while failure is preserved;
state is retained if controller termination is unconfirmed. Historical resource
measurements above were not repeated or relabeled as this newer revision.

## Implemented session contract — 2026-10-07

Production sampling of `mcp diagnostics` every two minutes for 43 hours
(2026-10-05 11:15 to 2026-10-07 06:34 UTC, 1,301 samples) showed:

- logical sessions peaked at 208 while physical connections peaked at 21;
- 539 sessions closed, every one by the 8-hour absolute lifetime and none by
  client DELETE or transport close;
- 51 % of the sessions visible in detail never sent a request: `mcp-remote`
  opens an unused twin session per proxy process;
- one agent session held a WinPath claim for 376 minutes, with 37 automatic
  renewals after its last client request and its transport long gone;
- inter-request gaps in active sessions were p50 2.5, p95 12.6 and max
  61.9 minutes; in the claim-holding session p95 6.5 and max 10 minutes.

The defaults follow from these numbers: renewal stops 15 minutes after the last
qualifying call (above the claim-holding p95 and max), interrupted sessions
close after 15 minutes, sessions with an open stream keep 60 minutes because a
62-minute gap was observed, and never-used twins whose stream ended close after
one minute. Replaying all samples through these rules (open streams counted
exactly from the global gauge, other retained sessions extrapolated from the
visible details) gives a retained-session peak of about 20 (p95 16), below the
64-session global and 32-per-credential bounds even if every agent shares the
installation credential. The bounds were therefore kept.

Acceptance tests use owned SDK clients, an in-process loopback listener and a
manual clock (`src/server/transports/mcp/mcp-session-policy.test.ts`,
`mcp-session-lease.test.ts` and `src/server/modules/mcp-sessions`). The lease
test uses the real application service and SQLite reservations: after abrupt
loss the lease expired 40 minutes after the last call, another session was
refused until then and then acquired its own reservation, and the fake managed
server kept running. A 24-cycle connect/claim/DELETE-or-crash run returned all
session, timer, claim, operation and admission counters to zero.

A bounded check with the pinned `mcp-remote` 0.8.2 fixture against an isolated
listener confirmed the twin: two sessions, one never active. When the twin
reached its 60-minute open budget it closed as `idle-expired`; the proxy
process stayed alive and its next tool call succeeded. This was a one-off
scratch run, not a committed test or a change to `bench:mcp-resources`, and it
does not establish the behavior of other proxy versions, Codex, Claude Code or
T3 clients. The production effect of the new limits on idle gaps longer than
15 minutes with an interrupted transport is still to be measured after
deployment.
