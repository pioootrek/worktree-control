# K7a: self-import pilot

## Current status, 2026-09-27

This tooling is merged on `main`. The instructions below describe the original
K7a trial and need an authentication update before a new run: a fresh database
now defaults to token mode and refuses controller startup until an installation
token exists, while the pilot creates an owner session and uses the earlier
pairing/knowledge login path. The current main CI does not execute this pilot.
Track the update and current-run evidence in
[the knowledge item](../docs/backlog/feature/FEAT-20260905-shared-project-memory.json).
Do not use an old pilot result as approval to migrate the live backlog.

## Original trial procedure

Run from the repository root after installing dependencies. Use a clean,
committed revision based on current main after the authentication update. Keep
the existing Hub backlog as the authoritative write location throughout this
exercise.

## Offline import and recovery

```bash
pnpm exec tsx --tsconfig tsconfig.json scripts/knowledge-pilot.ts \
  /absolute/source/repository FULL_SOURCE_COMMIT_SHA \
  /absolute/trusted/llm-ops-hub /absolute/new/private/pilot-directory
```

The destination must not exist; its parent must exist. The trusted validator
checkout must satisfy the importer's pinned revision requirements. The script
imports committed source bytes into a separate SQLite database under a singleton
lock. It reopens the database between batches, checks invisible staging, source
payloads, counts and attachment hashes, repeats the import, and compares complete
knowledge snapshots after logical export/restore and controller backup/restore.
The logical restore receives an independently copied identity baseline because
logical knowledge exports intentionally omit credentials.

`plan.json` and `report.json` retain provenance, counts and unresolved references.
`pilot.json` marks this as a copy and records the implementation commit and dirty
state. Failed runs retain `failure.json` and their partial directory for inspection;
use a fresh destination for another offline exercise. Reopening a connection
tests durable staging; this is not a process-kill or power-loss test.

The directory also contains a short owner session, identity databases, exports
and backups. Keep it private and outside the repository. Do not publish its
contents wholesale. An expired owner session can be recovered through the
existing offline identity CLI while this pilot's controller is stopped.

## Managed GUI and two MCP clients

Build through the registered project's Worktree Switcher test queue. Select a
development environment profile containing:

```text
WORKTREE_SWITCHER_PILOT_ROOT=/absolute/new/private/pilot-directory
WORKTREE_SWITCHER_PILOT_MCP_PORT=<available distinct MCP port>
```

Claim the exact pilot worktree through MCP. `pnpm dev` uses the controller-assigned
`PORT`, binds the pilot to loopback, and reads/writes only the pilot's data/state
directories. With no pilot profile it retains the normal development command.
Do not start the managed server directly or reuse another controller's port.
Confirm the worktree, port and running phase before the browser exercise.

```bash
node scripts/knowledge-pilot-live.mjs /absolute/new/private/pilot-directory
```

This finite script needs Playwright's Chromium and an unexpired owner session.
It reads the pilot's private service access file, creates two agents, creates a
task in the real GUI, exchanges a decision/question through real MCP, checks
idempotent retry and denied agent approval, approves as the owner in the GUI,
and verifies that the second agent receives the approved task context. It also
checks the memory view at 390px without horizontal overflow.

Each run adds fresh test records and agents to the copy. `live-report.json` and
screenshots are private local evidence; no credentials are printed. Failed runs
save a failure screenshot and page text. Run browser/build jobs sequentially on
resource-constrained hosts. Release the claim when verification is finished;
release does not stop the server.

## Acceptance boundary

Successful assertions establish this dataset's import/recovery and selected live
workflow. They do not approve cutover, prove arbitrary import mappings, complete
historical author/date presentation, or measure SaaS capacity. Inspect unresolved
references, archived items and original payload presentation before moving the
write source. Keep the report in the canonical backlog on `main`. The original
integration branch series has merged; subsequent fixes use focused branches from main.
