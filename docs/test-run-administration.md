---
audience: "local operators of a running controller and contributors changing finite-job lifecycle"
last_reviewed: "2026-11-12"
source_of_truth: "protected single-run inspection and stop over the owner-only admin socket"
status: "active"
---

# Inspect and stop one orphaned test run

A test run can lose its client: an agent credential is rotated, the original
MCP or account session ends, or a workflow crashes after `run_test`. The
controller keeps supervising the job and its preset timeout, but ordinary
cancellation stays restricted to the run's author. The local operator can
inspect that one run and ask its owner to stop it, without a controller restart
and without reusing the original session.

```bash
worktree-control test-run inspect <run-id> [--project <project-id>]
worktree-control test-run stop <run-id> --reason "<why>" [--project <project-id>] \
  [--wait-seconds <0-120>] [--request-id <key>]
```

Add `--data-dir PATH --state-dir PATH` for an isolated instance. The CLI prints
one JSON object.

| Exit code | Meaning |
| --- | --- |
| 0 | `stop`: cleanup confirmed and finalization durable. `inspect`: record found. |
| 2 | `stop`: still pending after the bounded wait. Inspect or repeat later. |
| 3 | Unresolved: no proof of quiescence (including an unknown run ID). Follow `nextStep`. |
| 1 | Refused or failed: invalid input, project mismatch, maintenance or no controller. |

## Authorization boundary

The command uses only the running controller's owner-only Unix socket (0700
directory, 0600 socket), as other protected maintenance commands do. OS
permissions on that socket are the administrator credential, whatever the
public authentication mode (open, token or account). The request has no actor,
session or credential field; any extra field is rejected. Run IDs match exactly;
there is no prefix search.

- There is no HTTP route or MCP tool for this operation. Scoped agents, human
  sessions and the installation token keep their existing rights. In
  particular, agent cancellation still requires the originating session.
- Without a listening socket the CLI fails with `controller_unavailable`. It
  never opens SQLite, takes the controller lock or signals a process itself.
- `--project` adds a binding check. A mismatch is refused without effect.
- `--reason` is required (3–200 printable characters). It is stored in the
  audit trail, so never put secrets in it.

## Read the result

`inspect` returns allowlisted run fields, live ownership, the committed record
and a resolution. `run` is the newest state the controller holds, which can be
ahead of the database. `durableRecord` shows what the store has committed
(`phase`, `cleanup`, `finalizedAt`) and the state of the run's newest write:
`committed`, `pending` (waiting for database admission) or `failed`. `stop`
returns the same two views. Output contains no log tail, environment values, requester identifiers or
session identifiers; the requester appears only as a class such as `agent`.
The command and working directory are included so that an operator can find a
process the controller no longer owns.

`resolution.state` and `stop` `outcome` use the same three values:

| State | Reasons | Meaning |
| --- | --- | --- |
| `pending` | `queued`, `preparing`, `running`, `stop_in_progress`, `finalizing` | This controller owns the work or its cleanup and is still progressing. |
| `confirmed` | `finalized` | The committed record is terminal and finalized, with cleanup confirmed (or provably not required before spawn), and no newer write is outstanding. |
| `unresolved` | `process_cleanup_unconfirmed`, `finalization_not_durable`, `preparation_cleanup_unconfirmed`, `workspace_cleanup_failed`, `ownership_lost_after_restart`, `ownership_unknown`, `cleanup_evidence_unavailable`, `run_not_found`, `stop_request_failed` | The controller cannot prove that no process or workspace remains. |

`confirmed` uses the same release boundary as the queue and is decided from the
committed record only. A terminal phase or `finalizedAt` held in memory is never
enough: the queue writes the terminal state before it releases a slot, so a
failed terminal write leaves the run unresolved. The process outcome
remains separate: a run that exited with code 3 stays `failed`, and a natural
exit is never reported as a cancellation. Source attribution is unchanged.

## What stop does

The finite-job manager reads the run and its live ownership, decides, and applies
the effect in one admitted phase. A natural exit, timeout or concurrent request
therefore cannot be overtaken.

| Evidence | `action` |
| --- | --- |
| Queued, or in source preflight or remote preparation | `cancel` through the existing queue path; preparation is aborted and disposed by its owner |
| Running process group spawned by this controller | `cancel`: SIGTERM to the owned group, SIGKILL after the existing grace period |
| Owned group whose earlier cleanup failed (after exit, timeout or cancel) | `cleanup_retry`: retries the same owned group; the recorded stop cause and exit result stay |
| Stop or finalization already in progress, including cancelled source preflight awaiting its observer | `join`: no new effect |
| Terminal, recovered after restart, unowned or unknown | `none` |

The command then waits up to `--wait-seconds` (default 30, maximum 120) for a
non-pending state, polling the run without holding database admission. On
expiry it returns `pending` and leaves the stop in progress; its later decision is
written to the controller log. Repeat `stop` or use `inspect`; never restart the
controller to wait it out.

Retries are idempotent by state: a repeated or concurrent request joins the
existing stop, and a confirmed run gets `action: "none"`. `--request-id`
(generated as `cli-<uuid>` when omitted) correlates audit records. It is not a
replay cache.

If the owner fails before returning its decision, the result and audit use
`action: "undetermined"`: cancellation may already have started. The same
action is used when the decision exceeds the wait budget. Inspect the run
before retrying; neither case proves that no effect occurred.

The operation affects one run. Other queued or running tests continue, and the
queue limit is unchanged. A slot is released only by the owner's own durable
finalization. No record is rewritten, deleted or reclassified to make a run look
finished, and no external workflow slot (for example an autofix lease) is
released.

## Unresolved cases

- **`process_cleanup_unconfirmed`**: the controller still owns the group and
  keeps its queue slot. Repeat `stop` to retry cleanup. If it keeps failing,
  check the process group of the command shown and the controller log.
- **`finalization_not_durable`**: the controller finished the run in memory, but
  writing its terminal state to the database failed. The committed record still
  shows the earlier phase, the run keeps its queue slot, and the persistence
  failure keeps the test queue closed (`test_run.persistence_failed` in the
  controller log). `stop` has no effect: it neither retries the write nor
  releases the slot. The shown process outcome is not changed. Check database
  health and free space. Only a controller restart reopens the queue, and
  recovery then records the run as `interrupted`, not as finished. Other runs
  that were already finalized durably stay `confirmed`.
- **`ownership_lost_after_restart`**: the controller that started the run stopped
  before observing its cleanup. Recovery marked the record `interrupted` with
  `recoveredAt`. The current controller never spawned that group and does not
  store or signal a PID. A PID may since belong to an unrelated process. Find
  processes of the shown command and working directory on the host, verify them,
  and stop them manually if needed.
- **`preparation_cleanup_unconfirmed`, `workspace_cleanup_failed`**: remote
  preparation or workspace disposal was not confirmed. New test admission stays
  blocked with `remote_execution_cleanup_unconfirmed` until the remote worker is
  reconciled. This command neither disposes the workspace nor lifts the block.
- **`ownership_unknown`**: the record says `running`, but the manager holds no
  owned group for it. Nothing is signalled.
- **`cleanup_evidence_unavailable`**: a legacy or incomplete record without
  durable finalization or cleanup evidence.
- **`run_not_found`**: no record has this exact ID. A missing record is not
  evidence of quiescence; retention may have removed it.

## Audit

Each `stop` appends two rows to the controller audit table, actor `local-admin`:
`test_run.admin_stop_requested` before any effect and
`test_run.admin_stop_result` after the wait. Details contain the request ID, run
and project IDs, operator (`local-admin-socket`, the controller's UID and
username), reason, action, outcome and reason code, phase/cleanup before and
after as held by the owner, and the committed phase and write state after the
wait (`durablePhaseAfter`, `persistenceAfter`). They contain no tokens, session identifiers, environment values or log
output. A refused project binding or malformed request has no effect and is not
audited. `inspect` is read-only and shows the newest ten audit records of the
run.

## Limits

- Ownership exists only for groups spawned by the current controller process.
  A run that was still queued, preparing or running when the controller stopped
  is recovered as `interrupted` with `recoveredAt` and stays unresolved for this
  command, as does any record without durable cleanup evidence. A run that was
  durably finalized before the restart, without `recoveredAt`, can still be
  `confirmed`.
- Root, or anyone else able to open the socket, holds the same authority as the
  controller's account.
- The audit table is append-only and has no separate retention for these rows.
- The command does not reconcile remote workers, restart the controller or
  change test queue capacity.
