# K7a: self-import pilot

This procedure rehearses the knowledge import, a human/two-agent workflow and
recovery on an isolated copy. It never writes the live controller database and
never switches a project to the new store: the Git-backed backlog stays the
source of truth. The latest run and its limits are recorded in
[the knowledge item](../docs/backlog/feature/FEAT-20260905-shared-project-memory.json).
Do not treat any pilot result as approval to migrate the live backlog.

Run from the repository root of a clean, committed revision after installing
dependencies. Keep host-specific paths out of committed files.

## Credentials and privacy

A fresh database defaults to token mode, and the controller refuses to start
until an installation token exists. The offline step initializes it with the
public CLI (`auth token generate`) and stores it only in the pilot directory as
`installation-token` (mode 0600). The token authenticates:

- the browser, entered through the real access form (never in a URL);
- the online and offline CLI, through `WORKTREE_SWITCHER_TOKEN`;
- identity administration, which creates two scoped agents.

Each agent authenticates to MCP and CLI with its own agent token. The scripts
pass credentials only through headers, pipes and child environments, remove
inherited Worktree Switcher credential and path variables from child processes,
and never print a token. They run with `umask 077`; the pilot directory is
created with mode 0700.

The directory holds the installation token, identity databases, exports,
backups and screenshots. Keep it private and outside the repository; never
publish it wholesale. Delete it when the evidence is no longer needed.

## Offline import and recovery

```bash
pnpm exec tsx --tsconfig tsconfig.json scripts/knowledge-pilot.ts \
  /absolute/source/repository FULL_SOURCE_COMMIT_SHA \
  /absolute/trusted/llm-ops-hub /absolute/new/private/pilot-directory
```

The destination must not exist; its parent must exist. The trusted validator
checkout must be a clean checkout of the importer's pinned revision. The script:

1. checks that the offline identity CLI rejects a missing or wrong credential
   and accepts the installation token;
2. imports committed source bytes into a separate SQLite database under the
   singleton lock as the installation principal, reopening the database between
   batches and checking that staging stays invisible;
3. compares counts, original payloads, source hashes and attachment bytes with
   the plan; checks every item's title/status/priority, the exact set of
   imported `related_ids`/`followup_ids` relations and attachment hashes;
4. records who imported the batch (see the limitation below);
5. repeats the import and requires an identical snapshot;
6. compares complete knowledge snapshots after logical export/restore and after
   controller backup/restore.

The logical restore receives an independently copied identity baseline because
logical knowledge exports intentionally omit credentials. Reopening a
connection tests durable staging; it is not a process-kill or power-loss test.

`plan.json` and `report.json` keep provenance, counts, unresolved references and
import attribution. `pilot.json` marks the copy and records the implementation
commit and dirty state. A failed run keeps `failure.json` and its partial
directory; use a fresh destination for the next attempt.

### Import attribution limitation

`knowledge_import_batches` stores `actor_principal_id` but no authentication
method, and imported records get `created_by` without history rows. The report
therefore states `batchAuthenticationMethod: "not recorded"`. Records written
after import (GUI, MCP, CLI) carry an authentication method in their history.
Never infer a method for past batches; historical Hub authors and dates remain
available separately from import provenance.

## Managed GUI, CLI and two MCP clients

Build through the registered project's Worktree Switcher test queue. Select a
development environment profile containing:

```text
WORKTREE_SWITCHER_PILOT_ROOT=/absolute/new/private/pilot-directory
WORKTREE_SWITCHER_PILOT_MCP_PORT=<available distinct MCP port>
```

Claim the exact pilot worktree through MCP. `pnpm dev` uses the controller-assigned
`PORT`, binds the pilot to loopback, and reads/writes only the pilot's data/state
directories. Without a pilot profile it keeps the normal development command.
Do not start the managed server directly or reuse another controller's port.
Confirm the worktree, port and running phase, then run:

```bash
node scripts/knowledge-pilot-live.mjs /absolute/new/private/pilot-directory
```

This finite script needs Playwright's Chromium. It:

- requires `authenticationMode: "token"` in the pilot's service access record;
- checks that HTTP, MCP and the online CLI reject missing and wrong credentials;
- provisions two scoped agents through the online CLI with the installation
  token and reads knowledge through the CLI with an agent token;
- connects two MCP clients as distinct agents without runtime or test-queue tools;
- reads imported records, summaries and historical comment provenance;
- rejects a wrong token in the browser, then signs in through the access form;
- lets the human create a task in the GUI; agent 1 proposes a decision with an
  idempotent retry, agent 2 adds a question and cannot approve;
- approves the decision in the GUI and checks that history attributes creation
  to agent 1 (`agent_token`) and approval to the installation (`installation_token`);
- opens a new MCP session, a CLI call and a new browser session that read the
  approved decision and open question for the task;
- checks the memory view at 390px without horizontal overflow.

Each run adds fresh test records and agents to the copy. `live-report.json` and
screenshots are private local evidence. A failed run saves a failure screenshot
and page text. Run browser and build jobs sequentially on resource-constrained
hosts. Release the claim when finished; release does not stop the server. Stop
the pilot server and select the default profile again before normal use.

## Acceptance boundary

Successful assertions establish this dataset's import/recovery and the selected
live workflow. They do not approve cutover, prove arbitrary import mappings,
complete historical author/date presentation, or measure SaaS capacity. Inspect
unresolved references, archived items and original payload presentation before
moving the write source. Keep the report in the canonical backlog on `main`.
