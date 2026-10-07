---
name: worktree-control
description: Use when a repository's development server or test queue is managed by Worktree Control, or when the user asks to inspect, claim, start, switch, or test a registered project through its MCP tools. Do not use for creating, deleting, or pruning Git worktrees.
---

# Worktree Control

Coordinate with the Worktree Control controller before touching a registered
project's development server. Keep the server on the intended worktree without
disrupting another human or agent.

## Connect outside the repository

This skill does not configure MCP. The user must add the URL and authorization
header from `worktree-control config mcp` to the client's private MCP
configuration. Worktree Control was previously named Worktree Switcher, so an
existing client may still list the same tools under a `worktree-switcher`
server name; the tool names are unchanged.

Never ask the user to put that output in `AGENTS.md`, `CLAUDE.md`, source files,
logs, issues, or chat. If the Worktree Control tools are unavailable, say so
and follow the repository's normal development instructions. Do not invent an
endpoint or token.

## Check the controller without exposing credentials

When the user asks why MCP is unavailable and the local CLI exists, you may run
`worktree-control service status`. This is read-only and does not print the
browser pairing token or MCP bearer token.

Do not install, uninstall, stop, or restart the user service unless the user
explicitly asks for that lifecycle change. Do not run `service url` as a
diagnostic command. It prints the private browser URL.

If the service is stopped, report that state. Do not bypass it by starting the
managed project with `pnpm`, `npm`, `yarn`, `bun`, or a framework CLI.

## Inspect before acting

Use `list_projects` to find the registered project. Use `list_worktrees` to
match the current checkout to an exact controller-discovered path, then prefer
`get_project_status_compact`. Fall back to `get_project_status` when the compact
tool is absent. Fetch full status, storage, presets, worktrees, or bounded
`get_runtime_logs` only when that detail is needed.

Read-only status requests do not need a claim.

If the server is already running on another worktree, do not move it unless the
user asked to switch it or the current task clearly authorizes using the server
from this checkout. A claim may stop the existing managed process before it
starts the selected worktree.

## Claim the server when needed

For work that needs exclusive use of the development server, call
`claim_project` with:

- the registered project ID;
- an exact path returned by `list_worktrees`;
- a short reason tied to the current task;
- an idempotency key that is reused when retrying the same claim;
- an optional TTL between 30 and 1800 seconds.

A successful claim moves or starts the managed server when necessary. Do not
start another copy with `pnpm`, `npm`, `yarn`, `bun`, or a framework CLI.

After claiming, call `get_project_status` and verify the worktree, runtime
phase, and port. If `claim_project` returns an operation error, the claim is
still held. Inspect the returned failure and logs before deciding whether to
retry or release it.

Newer controllers accept `responseMode: compact` for `claim_project`. The
compact result still returns the reservation ID, exact placement, failure code,
and `leaseHeld`; it never changes claim semantics.

If another owner holds the project, do not stop its process, take its port, or
try to bypass the reservation. Report the owner and conflict. Force release is
intentionally unavailable through MCP.

## Control a claimed runtime

Use `start_project`, `restart_project`, or `stop_project` only when the task
authorizes changing the development server. Each operation requires the active
claim's project and reservation IDs plus an idempotency key. Reuse the same key
only when retrying the same request after transport uncertainty; use a new key
for a deliberate second restart or retry after a reported failure.

The controller always targets the worktree pinned by the active claim. Start is
a no-op when that runtime is already healthy, restart retains one capacity slot
across its controlled stop/start, and stop retains the claim while releasing
capacity after confirmed process-tree cleanup. A failed start or stop may retain
both the claim and capacity, so inspect compact status and bounded runtime logs
before deciding on another operation. Verify placement, phase, failure code,
capacity, and `leaseHeld` after every operation; a replayed receipt is historical
and should be followed by a current status read.

## Renew and release

The MCP session renews its claims automatically only while you keep using it.
Any tool call or resource read counts; listing tools, reconnecting and server
renewals do not. Renewal stops 15 minutes after your last call, and the claim
then expires with its remaining TTL (at most 30 minutes).

During long work without MCP calls, such as editing or a local build, call
`renew_project_claim` (or another tool such as `get_project_status_compact`) at
least every 30 minutes; every 15 minutes keeps renewal continuous. Otherwise
the claim lapses after at most 45 minutes and another agent may take the
project. Before relying on the server again after a long pause, check that the
claim is still yours with `get_project_status_compact`.

Call `release_project_claim` when the task no longer needs exclusive control.
Release does not stop the development server.

Claims belong to the MCP session that created them. If that session is lost, a
new session cannot renew or release the old claim. A session whose connection
stays down for more than 15 minutes after your last call, or that stays idle for
60 minutes, is closed by the controller; then claim again from the new session.
Report a stale claim and let it expire, or ask the user to review it in the
dashboard. The controller may refuse a new session when too many are open; close
unused MCP clients rather than retrying in a loop.

## Run finite verification through the queue

When `list_test_presets` is available, use it before starting a finite test,
typecheck, lint, or build command in a registered project. Select the exact
worktree path returned by `list_worktrees`, then call `run_test` with a stable
idempotency key that is reused if the request is retried.

Read `get_test_queue` when capacity or waiting time matters. Poll
`get_test_run` until the run reaches a terminal state and report its preset,
worktree, commit, result, and relevant output. Use `cancel_test_run` only for a
run created by the current MCP session. A local dashboard user remains able to
cancel any run.

Queued tests respect existing project reservations but do not claim, start, or
switch the development server. If an end-to-end test also needs the managed
server, claim the project separately and verify that the server and test target
the same worktree.

A test process does not inherit the environment of the selected development
server profile or of the controller. It receives a fixed system allowlist, the
variables its test profile declares, and controller-owned metadata such as the
managed server URL. Read `list_test_environment_profiles` when a preset needs
flags, fixtures, or a database guard, and report a missing variable instead of
running the command in a terminal to work around it. Only change a profile or
its preset assignment when the user asks for that change.

Do not bypass an available managed test preset by starting the same command in
a terminal. If test-queue tools are unavailable, follow the repository's own
finite verification command and host resource policy.

Newer controllers accept `responseMode: compact` for `run_test`. Follow a
pending project or run cursor with `wait_for_status_change` (10-second default,
20-second maximum), then verify with `get_project_status_compact` or
`get_test_run_status`. Verify both the process outcome and source attribution;
only `observed_match` supports a verified-source claim.
On timeout, use `retryAfterMs`; on a lost session, inspect again and never repeat
a mutation solely because waiting failed. Older controllers can be polled with
the legacy status tools.

## Report the result

When a server operation matters to the task, report the project name, selected
worktree, port, runtime phase, and whether the claim remains held. Never include
MCP tokens, lease secrets, or session identifiers.
