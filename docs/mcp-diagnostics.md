---
audience: "operators and contributors measuring MCP resources"
last_reviewed: "2026-10-05"
source_of_truth: "implemented diagnostic read and proposed follow-up policy"
status: "active"
---

# MCP observations and repeatable measurement

This slice observes the existing controller. Proposed limits below are not
implemented settings. The installation's production configuration is unchanged.

## Local administrative read

Run `worktree-switcher mcp diagnostics` against a running controller. For an
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
| `openResponses`, `sseResponses` | Authenticated session-bound HTTP responses still open; SSE is counted when the transport exposes its response headers. HTTP POST with JSON response also consumes a response. |
| `operations` | Executing registered protocol handlers (tools, resource reads/lists, etc.), excluding SDK bootstrap initialize/ping handlers. Count remains until `finally`, including a handler ignoring cancellation after close. |
| `runtimeRetryEntries` | Existing global retry-ledger occupancy, including completed receipts. Its existing bounds are 64/session and 512/global; it is not a running-call counter. |
| `claims`, `renewalTimers`, `lifetimeTimers` | Session-held claim/renewal handles and actual controller-owned timers. Persisted reservations can outlive these handles and must be inspected through existing project status. |
| `statusWaits` | Actual application waiters, waiter timers, targets and the shared sampling timer. The per-session waiter count is an owner-key lookup; closed/draining session attribution can be unknown. Global counts remain available. |
| `resourceSubscriptions` | Zero: this adapter registers no resource subscription handlers. SDK internal stream maps/keep-alive timers have no public inspection API and are explicitly `unknown`. |
| `lastClientMessageAt` | Last validated JSON-RPC message delivered by the transport after authentication and session binding; includes protocol housekeeping. |
| `lastClientRequestAt` | Last application-shaped tool/resource/prompt request delivered by the transport; it can still fail application validation. An observation, not proof of agent liveness or a renewal authorization. |
| `lastAutomaticRenewalAt`, renewal success/failure totals | Server-generated renewal, recorded separately; never advances client activity. |
| `agentState`, client/proxy process fields | `unknown`: an HTTP server cannot prove an agent/process is alive behind a proxy. `no-open-response` is an observed transport state, not an inactive-agent classification. |
| Close reasons | Client DELETE, absolute lifetime, authentication policy, controller shutdown, failed initialization and otherwise transport close. Cancellation is not recorded as successful termination. |

No credential IDs, raw MCP session IDs, lease tokens, client names, request
bodies or arbitrary error labels enter the snapshot. Session labels are local
sequence numbers with no authority. Every event changes fixed counters in O(1).
Reads inspect at most 32 session details and 64 recent closures, with an omitted
count. Recent closure retention is 15 minutes, pruned on reads; the ring is
always capped at 64 even without reads. Aggregate counts remain exact. Live
observations share the existing session lifetime, and closed observations are
released when their tracked work settles. This is not a new session-retention
bound; admission/expiry remains the next PR.

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

## Proposed second PR contract

All values in this section are proposals, pending its bounded acceptance tests.

- Admit at most 64 logical sessions globally and 32 per credential, including
  the shared installation credential. Count initializing and draining work
  against capacity too. Use predictable refusal without disturbing established
  callers. No new token scope is needed.
- Admit at most 32 application calls globally and four per session, including
  waits. Keep the existing status-wait limits (128/global, four/session,
  64 targets) and retry-ledger limits as additional ceilings. Existing accepted
  verification jobs consume their own queue, not MCP call capacity.
- Qualifying activity is an authenticated, session-bound application request
  admitted after schema/authorization validation: a tool call or resource read.
  Discovery/listing, initialize, GET/SSE open, ping, proxy heartbeat, server
  output/progress, automatic renewal and parent-process existence do not extend
  owner activity. Requests remain evidence of authorized use, not proof of
  human or agent presence. Document compatibility for clients that only list.
- Start with a 15-minute idle budget and a 60-second reconnect grace after a
  positively observed interruption of an established transport. A completed
  normal JSON POST is not such an interruption. The idle deadline remains
  authoritative even with an open SSE stream. Unknown/disconnected/closing
  states remain distinct. A same-authentication reconnect may resume within
  grace, but never grants another session ownership.
- At idle deadline plus at most 60 seconds of grace, close new MCP admission
  and stop renewal, regardless of a still-running call. Drain accepted handlers
  for up to 120 seconds, signal cancellation where supported, and keep actual
  work counted after that bound if termination is unconfirmed. Never claim a
  canceled write failed or replay it blindly; return/recover a truthful
  completed/failed/unknown outcome. A long operation must not be terminated
  solely because it passed the idle budget. Define lease requirements for
  continuing runtime mutations under the existing lifecycle coordination.
- Without explicit client release, the upper bound from last qualifying
  activity to reservation availability is **15 min + 60 s + remaining TTL
  (at most 30 min) = 46 min**. Grace cannot extend this deadline repeatedly.
  The existing eight-hour reservation maximum may shorten it. Do not tie this
  bound to draining duration, proxy existence or a new session's traffic.
- Session cleanup must dispose session-owned resources idempotently without
  stopping the project server, canceling an accepted test or killing a proxy.
  Keep initializing failures, explicit DELETE, policy close, absolute lifetime,
  shutdown, expiry races and lost-write responses in its acceptance matrix.

These are starting safety ceilings, not measured maximum capacity. The first
slice measures small legitimate workloads and retained abandonment; the next
PR must validate admission/refusal and per-credential fairness only on isolated
fixtures before treating these values as a supported contract.
