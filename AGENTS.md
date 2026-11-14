# Worktree Control repository guide

## Project and reference routing

Worktree Control (named Worktree Switcher until 2026-10-05) is a local-first
control plane with one managed server and stable configured port per project. Keep it independent of supervised repos.
Preserve the single Node.js controller, statically exported Next.js dashboard,
and local SQLite adapter.

Read only the references relevant to the task:

- Product or architecture decisions: [project brief](docs/project-brief.md).
- Runtime, persistence, or lifecycle changes: [architecture](docs/architecture.md).
- Adding or extracting modules: [codebase organization](docs/codebase-organization.md).
  Its destination map is incremental, not the current directory layout.
- Authorization, roles, the MCP contract, or moving an operation onto the
  shared registry: [authorization contract](docs/authorization-contract.md) and
  [operation dispositions](docs/authorization-operation-dispositions.md). They
  define the accepted target of the next breaking release; current behaviour
  is in [authentication](docs/authentication.md).
- Remote workers, memory, or coordination: [expansion assessment](docs/architecture-effort-assessment.md)
  and its linked feature plan. Planned features are not implemented contracts.
- Before non-trivial work: read current tasks and relevant memory in Knowledge
  project `k7a-worktree-switcher`, following [the workflow](docs/knowledge/AGENTS.md).
  Verify design examples against code; imported notes are available in Knowledge.

## Code boundaries

- HTTP, MCP, and CLI invoke shared application operations. Keep authorization,
  reservation policy, and state transitions there, with consistent input
  validation and safe errors across transports.
- Modules expose explicit public APIs and depend on interfaces for external
  effects. Avoid circular imports and access to another module's internals.
  Bootstrap connects concrete adapters.
- Browser code and shared contracts must not import controller implementations,
  SQLite, Node APIs, or privileged configuration. Reusable UI stays
  presentation-focused; feature code owns browser data access. Preserve i18n
  and accessible interactions.
- Extract the responsibility needed by the current task; retain `ControlService`
  as a facade during migration. Preserve API and error behavior during moves.
  Add future modules with their first workflow, not as empty scaffolding.

## Ownership invariants

- One controller/database owner holds the singleton lock, including offline
  CLI access. Preserve transaction boundaries and migration order when splitting
  SQLite code; extracted modules do not open independent connections.
- Runtime changes, test admission, and cache maintenance share lifecycle
  coordination. Do not duplicate lock maps or capacity counters. Finite jobs
  retain their separate queue and state machine.
- Execute shell-free commands against validated, discovered worktrees. Stop only
  verified owned process trees; an occupied port never proves ownership.
- Bound logs, history, scans, and subscriptions, and dispose owned resources.
  Log events must not trigger repeated full Git scans.

## Integration branch

The authorization unification (Knowledge task `040062b4`) lands on
`integration/auth-unification` until its release. `main` stays releasable at
schema 49. Choose the base branch by what the change does:

- **`integration/auth-unification`:** a schema step (numbers 50 and above
  belong to it), a change of authorization or security-fence behaviour, the
  deletion of an old authorization path, and the tests and package-acceptance
  expectations that change with them.
- **`main`:** unmounted additions (no production import, no schema step, no
  behaviour change), documentation, CI fixes and unrelated work. Code on
  `main` depends on schema 49 at most.

`main` reaches the integration branch through a `sync/main-<date>` pull
request with a merge commit; run the gate again on the merged head. Its
history is append-only: merge commits through pull requests.

Run an integration build on synthetic fixtures and released-baseline artifacts
only, with its own data, attachment, witness, restore and key paths and a
clean environment. Steps after 49 are provisional until the release candidate,
so rebuild fixtures after editing one, and treat every database such a build
has migrated as disposable.

The gate, who merges, and the reasons are in Knowledge reply `84abdf8a`,
section 7, of discussion `8a2683b8`. Merges into `main`, releases and
publication need the owner's word.

## Local instructions

Read the nearest `AGENTS.md` before editing a subtree. Add a local guide only
for distinct area-specific invariants and verification; link deeper details
rather than repeat root rules. Every `AGENTS.md` has a sibling `CLAUDE.md`
containing only `@AGENTS.md`; maintain the pair together.

## Verification

For code extraction, run relevant tests and `pnpm check`. Run `pnpm build` for
module/bundling changes and verify affected dashboard flows in the browser.
Use nearby `*.test.ts` files to cover behavior at risk. Documentation-only
changes need `git diff --check` and applicable documentation validation below.
Report actual results and unverified behavior.

When registered-project verification presets are available through MCP, use
`list_test_presets`, then `run_test` with the exact path from `list_worktrees`.
Reuse the idempotency key when retrying one request and poll `get_test_run` to
a terminal state. Do not bypass the queue with the same direct command. If
queue tools are unavailable, use supported finite commands within host limits.

Queued tests do not claim, start, or switch a development server. Tests needing
that server require a separate claim for the same worktree. Use the
`worktree-control` skill and MCP for managed development-server lifecycle.

## Backlog and documentation

Tasks, discussions and durable findings live in Knowledge project
`k7a-worktree-switcher`. Read [the workflow](docs/knowledge/AGENTS.md) before
writing them. Complete tasks with saved validation evidence and persist useful
findings before compaction. Imported sources and historical attachments are
available through Knowledge; Git retains their pre-retirement history.

Product documentation stays in Git. After documentation changes, run
`python3 scripts/docs.py fmt`, `python3 scripts/docs.py check`, and
`git diff --check`, using available managed verification presets. Treat open
`backlog-feedback` issues as human input and find their records by legacy ID.
