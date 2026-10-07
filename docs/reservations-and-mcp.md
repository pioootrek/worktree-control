---
audience: "product owner and contributors discussing agent coordination"
last_reviewed: "2026-10-07"
source_of_truth: "implemented reservation and local MCP integration design"
status: "active"
---

# Reservations and MCP integration

Decision state: the reservation model and local MCP integration are implemented.

## Use an exclusive reservation, not a semaphore

Each project has one managed server slot, so the user-facing primitive is a
binary exclusive reservation. A counting semaphore would suggest several
simultaneous holders, which is not the intended behavior.

Three mechanisms remain separate:

1. An internal operation mutex serializes short start, stop, and switch state
   transitions.
2. A human hard lock pins the project to a worktree until explicit release.
3. An agent lease reserves the project temporarily and must be renewed.

The reservation overlays runtime state. A project may therefore be
`running + reserved`, `stopped + reserved`, or `failed + reserved`; reservation
does not falsely claim that the process is healthy.

## Reservation record

```ts
type Reservation = {
  id: string
  projectId: string
  worktreeId: string
  kind: "human-lock" | "agent-lease"
  owner: {
    kind: "human" | "agent"
    id: string
    displayName: string
  }
  reason: string
  createdAt: string
  expiresAt: string | null
  tokenHash: string | null
}
```

The service returns the raw lease token once and stores only its hash. The token
is required to renew or release an agent lease. Repeating an acquire request
with the same idempotency key returns the existing lease instead of creating a
second one.

Human locks may be indefinite. Agent leases default to 30 minutes and have an
8-hour maximum lifetime. The server renews a lease automatically every 10
minutes (one third of a shorter TTL, at least every ten seconds), but only while
the owning MCP session showed qualifying client activity within the claim
renewal idle limit (15 minutes by default). After that, renewal stops and the
lease expires with its remaining TTL. See
[session liveness, cleanup and admission](#session-liveness-cleanup-and-admission).
A claim that finishes acquisition after its session began closing never starts
automatic renewal or retains its lease secret in that session. The accepted
runtime operation is not replayed or undone; its persisted lease keeps its
remaining TTL. Session closure never releases a lease early.
Agents can renew or release only leases for which they hold the token. A human
can force-release any reservation through an explicit UI or CLI action; that
action is audited and is not exposed as a normal LLM tool.

A reservation is pinned to one worktree. Its owner may restart that worktree;
other actors cannot switch, stop, or restart the reserved project. Stopping the
server does not release the reservation. An owner that needs another worktree
uses one atomic move operation so ownership is never briefly dropped.

## Conflict behavior

Acquisition is an atomic compare-and-set operation. A conflict returns the
current owner, reason, pinned worktree, and expiry without switching anything.
The existing holder is never silently displaced.

The controller implements acquisition as one SQLite write transaction that
expires stale leases, checks the current claim, records the new claim, and
appends its audit event. UI, CLI, and MCP never open the database directly.

The preferred agent operation atomically reserves and switches the server. A
separate `acquire` followed by `switch` would leave a race between the calls.
If switching fails, the result reports both the failed runtime transition and
whether the lease remains held so recovery is unambiguous.

Reservation guarantees apply only to Worktree Control operations. They cannot
prevent a human from killing a process or changing files outside the tool, so
status reconciliation must continue to report external changes.

## MCP shape

MCP is an adapter over the same application services used by UI and CLI. It
does not receive direct filesystem, Git, process, or persistence access.

The primary local transport is MCP Streamable HTTP on a dedicated loopback-only
listener:

```text
http://127.0.0.1:47832/mcp
```

It runs inside the existing controller, so connecting an agent does not create
another persistent Node.js process. The MCP SDK is loaded lazily on first use.
In `token` mode the endpoint requires the installation token as a bearer token;
`legacy` installations use a persistent token stored in an owner-only file, and
`open` mode requires none. `worktree-control config mcp` prints the client
configuration on explicit request. See [authentication modes](authentication.md). A future stdio command may act as a compatibility proxy for clients
without Streamable HTTP support.

Read-only MCP resources:

```text
worktree-switcher://projects
worktree-switcher://capacity
worktree-switcher://tests/queue
worktree-switcher://projects/{projectId}/status
worktree-switcher://projects/{projectId}/worktrees
```

These URIs, like the tool names, are a stable client contract. They keep the
`worktree-switcher://` scheme from before the 2026-10-05 product rename.

Initial MCP tools:

```text
list_projects
get_server_capacity
get_test_queue
get_project_status
get_project_status_compact
get_runtime_logs
get_project_storage
list_worktrees
list_test_presets
run_test
get_test_run
get_test_run_status
wait_for_status_change
cancel_test_run
set_project_environment
list_environment_profiles
save_environment_profile
select_environment_profile
delete_environment_profile
list_test_environment_profiles
save_test_environment_profile
delete_test_environment_profile
assign_test_preset_profile
claim_project
start_project
restart_project
stop_project
renew_project_claim
release_project_claim
```

Environment-profile tools apply to every managed runtime, including Django.
They expose named literal values but never inherited host values or a hidden
lease token. Profile mutations remain audited, reject controller- and
runtime-loader-owned variables (including `PORT`, `NODE_ENV`, `PATH`,
`NODE_OPTIONS`, loader paths, and Python import paths), and require the managed server to be stopped; the browser may
instead request an explicit stop-and-restart transaction.

`claim_project` accepts a project, discovered worktree path, reason,
requested TTL, and idempotency key. It atomically acquires an agent lease and,
when needed, switches the server. Its result contains an explicit lease handle
but never exposes the raw lease token. The MCP session retains that secret and
uses it for explicit and automatic renewals and release operations.

`start_project`, `restart_project`, and `stop_project` require the exact active
agent reservation held by the current MCP session. They accept no command, port,
environment, or worktree override. Start is a no-op for an already-running
claimed placement; restart performs one serialized stop/start while preserving
its capacity slot; stop keeps the reservation and releases capacity only after
owned-process cleanup is confirmed. Each request requires a session-scoped
idempotency key. Same-key retries replay the timestamped receipt, while a new
deliberate operation uses a new key. Receipts contain an allowlisted runtime,
claim, failure-code, and capacity projection without lease tokens, session IDs,
commands, environment values, or logs.

`claim_project` and `run_test` optionally accept `responseMode: compact`; their
default full response remains compatible. Projection happens after the same
single idempotent mutation, and a failed start still returns its reservation
handle and `leaseHeld` state.

`get_project_status_compact` returns an allowlisted, versioned projection with
an opaque controller-epoch cursor: project and placement IDs, runtime phase and
failure code, a non-identifying owner label/relation, and server/test capacity
counts. It performs no Git or preset discovery and omits logs, storage, history,
environment values, free-form reasons, and raw MCP session owners.

`get_test_run_status` reads projected SQLite columns without decoding retained
logs. It reports queued, preflight, and finish HEAD observations together with
the source attribution, comparisons, reason codes, and process outcome. Only an
`observed_match` result supports a verified-source claim. `get_runtime_logs` is an
explicit in-memory tail read, defaulting to 40 and allowing at most 100 lines
within 16 KiB.

`wait_for_status_change` accepts exactly one project or run and a previous
cursor. It samples compact state only while waiters exist, every second, with a
10-second default and 20-second maximum. Limits are 128 global waiters, four per
MCP session, and 64 targets. Timeout returns no repeated snapshot and includes
retry advice; cancellation, logical session closure, and shutdown dispose the waiter
without mutating claims, runtimes, or tests.

If controller-wide server capacity is exhausted, a new claim remains held but
reports the startup error explicitly. Agents can call `get_server_capacity`
before claiming to read the configured limit, current usage, available slots,
and projects holding them.

`list_projects` and `get_project_status` also return the read-only resource
snapshot for each managed server: aggregate current and peak RSS, CPU,
process count, sample time, bounded RAM history, and availability state. MCP
reads the same in-memory snapshot as the dashboard and never starts its own
sampler.

`get_project_storage` returns the latest persisted disk breakdown and bounded
history for each discovered worktree. It does not start a filesystem scan;
missing or stale measurements are scheduled by the dashboard or refreshed by
an explicit authenticated browser action.

Listing and status remain available without acquiring a lease. Mutations that
would violate an existing reservation return a typed conflict. Arbitrary shell
commands, arbitrary paths, force release, and indefinite agent locks are never
exposed as MCP tools.

Test tools select a preset discovered by a typed adapter for an exact current
worktree. `run_test` requires an idempotency key so transport retries cannot
queue duplicate processes. A run respects an existing project reservation but
does not claim or switch the development server. Only its originating MCP
session or a local dashboard user may cancel it.

Test environments are separate from development-server profiles. A test
process starts from a fixed allowlist of system variables and receives only
what its test profile declares, plus controller-owned metadata such as the
managed server URL and port. Neither the controller's own environment nor the
profile selected for the development server reaches a test run. Inheriting a
server profile is possible but requires naming that profile explicitly, so a
result never depends on which profile happens to be selected. `NODE_ENV` comes
from the profile: detected unit scripts default to `test`, while build, lint,
and typecheck presets run without a runtime mode. Test-profile tools return
variable names without values, and `get_test_run` reports the policy that was
applied to a finished run.

## Session liveness, cleanup and admission

Three things are separate and end independently:

1. **TCP/SSE disconnect.** A socket or the standalone SSE stream closes, for
   example on a network blip or proxy exit. This alone does not close the
   logical session; the client may reconnect with the same session ID.
2. **Logical session closure.** The controller forgets the session ID, its
   claim handles and its lease secrets. A later request with that ID gets
   `404 MCP session not found` and the client must initialize a new session.
3. **Claim expiry.** The persisted reservation ends at its recorded
   `expiresAt` or on explicit release. Session closure never releases it early,
   and a new session never inherits it.

**Qualifying activity** is an authenticated tool call (`tools/call`) or
resource read (`resources/read`) handled by the session, stamped when it starts
and when it settles. Initialize, `tools/list` and other listing, ping, SSE
(re)connects, server output and server-generated renewals do not count.
A call is evidence of authorized use, not proof that an agent is alive.

| Limit | Default | Option for `start` and `service install` |
| --- | --- | --- |
| Claim renewal idle limit | 15 min | `--mcp-claim-renewal-idle-minutes` |
| Interrupted-transport session idle limit | 15 min | `--mcp-session-idle-minutes` |
| Open-transport session idle limit | 60 min | `--mcp-open-session-idle-minutes` |
| Reconnect grace after an interruption | 60 s | `--mcp-reconnect-grace-seconds` |
| Cooperative drain on policy close | 120 s | `--mcp-drain-seconds` |
| Logical sessions, global | 64 | `--mcp-max-sessions` |
| Logical sessions per credential | 32 | `--mcp-max-sessions-per-credential` |
| Absolute session lifetime | 8 h | fixed |

**Renewal.** A renewal tick extends the lease only if the last qualifying
activity is younger than the claim renewal idle limit. Otherwise the session
keeps the claim handle but stops renewing (`stopped-idle` in diagnostics); a
later qualifying call resumes renewal immediately if the lease has not expired.
`renew_project_claim` is itself qualifying activity. Without a further call,
the worst case from the last real call to availability for other agents is the
renewal idle limit plus the remaining TTL: **15 + 30 = 45 minutes** with the
defaults, instead of up to the 8-hour lease maximum. Session closure does not
change this bound; neither does draining, the proxy's existence or another
session's traffic.

**Cleanup.** A session's transport is *interrupted* when it once had an SSE
stream and now has no open response; it is *open* while any session-bound
response is open; it is *request-only* if it never opened an SSE stream.

- Interrupted and never active: closed one 60-second reconnect grace after the
  first interruption (`abandoned-transport`). The grace is anchored to the first
  interruption since the last qualifying activity, so repeated reconnects do
  not extend it.
- Interrupted with activity: closed once the last qualifying activity is older
  than 15 minutes, and not before the grace has passed (`abandoned-transport`).
- Open or request-only: closed after 60 minutes without qualifying activity
  (`idle-expired`). The longer budget reflects measured idle gaps of up to
  62 minutes while a stream stayed open.
- Every session still closes at its absolute 8-hour lifetime.

A policy close stops admission of new work at once (new requests get `404`,
calls already queued in the protocol get an error), stops renewal and disposes
claim handles, then drains accepted calls for up to 120 seconds. A call that
completes inside the drain returns its real result. A call still pending after
the drain gets `503` with outcome `unknown`; the operation itself keeps running,
stays counted, and is never replayed. Inspect status before retrying it.
Explicit DELETE, authentication-policy changes and controller shutdown close
immediately as before. Closing a session never stops a managed server, never
cancels an accepted test job and never terminates a client or proxy process.

**Admission.** At most 64 logical sessions globally and 32 per credential
(including the shared installation credential) are admitted, counting sessions
that are still initializing and closed sessions whose accepted work has not
settled. An excess initialize request gets `503` with a `Retry-After` header and
error data `{ reason: "admission-refused", scope: "global" | "credential" }`;
established sessions keep working. Capacity returns as sessions are cleaned up.
With cleanup active, a replay of 43 hours of production samples peaks at about
20 retained sessions against 21 physical connections, below both bounds.
See [MCP diagnostics and measurement](mcp-diagnostics.md).

**Agents.** Long work without MCP calls (editing, local builds) must make a
qualifying call, for example `renew_project_claim` or
`get_project_status_compact`, at least every 30 minutes. Some renewal tick
always falls within 10 minutes of the last call, so the lease runs for at least
30 minutes after it, and a later call resumes renewal immediately. A call every
15 minutes keeps automatic renewal running without a pause. Without any call the
claim lapses after at most 45 minutes and another agent may take the project.
If the MCP transport also stays disconnected for more than 15 minutes, the
session itself closes; a client then starts a new session and must claim again.

## Security and audit

- The MCP endpoint binds only to `127.0.0.1`, validates `Origin`, and requires
  the active mode's bearer token (none in `open` mode). The token never travels
  in command-line arguments.
- Every mutation records actor, MCP client identity, project, worktree, reason,
  timestamp, outcome, and lease ID without recording the raw token.
- SQLite persists reservations and append-only audit events; the controller is
  the only database owner and all adapters use the same transactional service.
- Tool inputs use strict schemas and project/worktree identifiers are resolved
  against controller-owned discovery results.
- UI and CLI clearly show owner, reason, age, expiry, and whether the process
  still matches the reserved worktree.
- Remote and multi-user MCP access remains a separate security design.

## Deferred MCP work

- Optional stdio compatibility proxy.
- Client-specific configuration helpers beyond the generic JSON output.
- Remote authorization and user accounts.
