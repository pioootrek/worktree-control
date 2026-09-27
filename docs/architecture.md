---
audience: "contributors implementing the controller and user interface"
last_reviewed: "2026-09-27"
source_of_truth: "runtime, persistence, configuration, and distribution decisions"
status: "active"
---

# Architecture decisions

## Runtime shape

Worktree Switcher ships as one long-lived Node.js process. Next.js is a build
tool for the App Router UI, configured with `output: "export"`; its generated
HTML, CSS, and JavaScript are package assets served by the controller. There is
no `next start` process and no server rendering at runtime.

The process contains four replaceable layers:

1. A thin HTTP layer serving static assets, JSON endpoints, and an SSE event
   stream on the configured local interface.
2. Application services coordinating projects, switching, readiness, and
   configuration.
3. Domain interfaces for persistence, Git inspection, process execution,
   clocks, and event publication.
4. Local adapters backed by SQLite, the Git CLI, Node child processes, and the
   filesystem.

The layers are module boundaries inside one process, not separate services.
This keeps idle memory and startup overhead low while preserving extraction
points if a future multi-user edition needs a remote control plane.

## GUI foundation

The statically exported Next.js dashboard uses shadcn/ui with the `new-york`
style and Radix base. Components are copied into `src/components/ui` and owned
by this repository; application-specific composition remains outside that
directory. Tailwind CSS and CSS variables provide the design tokens.

The UI is dark-first with a system/light option. Geist Sans is used for
interface text and Geist Mono for branches, commits, paths, ports, commands,
timestamps, and lease identifiers. Foundational surfaces use semantic tokens
such as `background`, `card`, `foreground`, `muted`, `border`, and `ring`
instead of ad-hoc palette values.

Initial primitives are installed only when their owning flow is implemented:

- `Button`, `Card`, `Badge`, and `Table` for project/runtime overview;
- `Tabs`, `Select`, `Tooltip`, and `ScrollArea` for worktree selection and logs;
- `Dialog` for editing and `AlertDialog` for stop, force-release, and other
  destructive confirmations;
- `Skeleton`, `Alert`, and empty states for loading, failures, and no-project
  onboarding;
- `Sheet` for responsive project navigation.

Runtime and reservation status never relies on color alone. Each state has a
label, icon, and accessible description. Keyboard navigation, visible focus,
reduced motion, and screen-reader announcements for process transitions are
part of acceptance criteria.

The shadcn CLI is initialized non-interactively with defaults and an explicit
Radix base. Components are added selectively, reviewed as application source,
and never bulk-installed with `--all`.

## Process ownership and shutdown

The controller records identity only for process trees it starts. On normal
exit, `SIGINT`, or `SIGTERM`, it stops those trees gracefully, waits for the
configured shutdown timeout, and then escalates only against the same verified
owned tree. A PID loaded after restart is never trusted without identity
reconciliation.

An occupied project port owned by an unknown process is a conflict, not
permission to terminate it. The dashboard reports the port and diagnostic
information, while recovery stays an explicit user action outside the tool.

Dirty worktrees are valid development targets. The dashboard displays a
persistent warning and the dirty-state timestamp but does not block start,
restart, switch, or reservation.

`autoStart` defaults to false. Project registration is explicit, dependency
installation is never automatic, and stopping a server does not release its
reservation.

Finite verification commands use a separate `TestJobManager`; they do not add
phases to the long-lived development-server state machine. `NodeTestCommandAdapter`
discovers allowlisted package scripts, while `DjangoTestCommandAdapter` resolves
`manage.py test` with the interpreter belonging to the exact worktree. Both
produce shell-free executable and argument arrays for the shared queue.

The queue is FIFO, has a persisted global parallel limit from 1 through 16,
and runs at most one job in a given worktree. Lowering the limit does not stop
active jobs. Cancellation signals the complete owned process group and
escalates only if it does not exit; the persisted run becomes terminal only
after process exit is confirmed. Output is written to the rotating file log
per line, while the bounded SQLite tail is persisted on a short debounce and
again at completion. Queue counts and scheduling candidates use filtered SQL
queries that do not hydrate historical log tails. Controller shutdown cancels
active jobs; stale queued or running records become `interrupted` during recovery.

Queued verification records bounded Git source observations at enqueue, before
spawn, and after owned-process cleanup. Preparation consumes the same global
slot and per-worktree exclusion as a running job. A changed or unavailable
preflight rejects the job without spawning; a successful command is reported as
`passed` only when complete, clean endpoint observations match. Dirty, changed,
or incomplete evidence preserves the separate process outcome but cannot certify
the queued revision. The status digest describes bounded Git status records, not
file contents: edits restored between observations, ignored inputs, environment,
and external services remain outside this source-attribution guarantee.

## Resource policy

Managed development applications have priority over Worktree Switcher. The
controller must be event-driven and have bounded memory use:

- no recursive filesystem watcher over managed repositories;
- no continuous Git polling while the dashboard is closed;
- a repository-keyed dashboard metadata projection with single-flight refresh,
  30-second freshness/error disclosure, at most 128 entries and an 8 MiB
  serialized metadata budget;
- at most four Git subprocesses with separately bounded queues of 128 operational
  and 128 background commands, prioritizing fresh operational validation even
  when the display queue is full;
- runtime log tails capped at 400 lines per project and 4,000 characters per
  line; disk output batched into 64 KiB writes while preserving rotation;
- one five-second resource sampler per active Linux process group, with at
  most 60 in-memory RAM points and eight workers per scan, each reusing an
  8 KiB process-file buffer; no sampler for stopped projects;
- one serialized filesystem scan queue for worktree disk usage, refreshed no
  more than once per six hours unless a user explicitly requests it, with a
  30-second cooldown measured from a failed attempt;
- one controller process and no resident Next.js runtime;
- release benchmarks report idle RSS, idle CPU, startup time, and growth while
  managing several fixture projects.

Release acceptance measures controller RSS above a same-host bare Node baseline.
The budgets are 32 MiB additional median RSS and 0.5% of one logical CPU with
projects stopped, or 96 MiB and 5% while monitoring three running projects.
Post-cycle growth is limited to 32 MiB against the same pre-cycle workload.
The [resource budget](resource-budget.md) defines the reproducible three-run
procedure, retained-log limits and negative control. The old absolute 50 MiB
RSS target is superseded; managed-server memory is measured separately.

The Linux resource adapter aggregates `/proc` counters for every member of the
detached process group created by the controller. This covers the package
manager, Next.js, and worker children without trusting unrelated PIDs. A
lightweight authenticated endpoint serves the in-memory snapshots so GUI
refreshes do not trigger Git discovery. Unsupported platforms and transient
permission/read failures produce explicit monitoring states and never affect
start, stop, readiness, or switching.

Worktree storage scans use filesystem metadata in a single traversal. They do
not invoke a shell, follow symlinks, include `.git` administrative data, or
leave a Git-discovered worktree root.
The scanner records allocated bytes for the complete tree, `.next`,
`.next/cache`, `node_modules`, and the five largest top-level directories.
Results are persisted in SQLite with the first measurement and at most 179
recent samples per worktree. Successful metadata discovery or an explicit
refresh may schedule a missing or stale measurement. Live dashboard reads and
read-only MCP summaries only consume stored snapshots and cannot requeue scans.

The first maintenance action uses a closed allowlist containing only the
Next.js `.next` directory. The service resolves the worktree through current
Git discovery, verifies a regular worktree root and a Next.js dependency,
rejects a symlinked `.next`, and refuses deletion while that worktree is
running, reserved, or being scanned. Browser input selects the `next` cache
kind and never supplies the deletion target. Successful, missing-directory,
and rejected attempts are written to the project audit trail. Cache deletion
is not exposed through read-only MCP.

Cache deletion, runtime changes, reservations, project removal, and test
admission use the same per-project lifecycle serialization. The lifecycle also
owns synchronous worktree maintenance and storage-scan permits keyed by project
and Git-discovered worktree path. A scan holds its permit while pending and
running; destructive maintenance and scan admission exclude each other without
blocking unrelated projects. Automatic scans skip admission during maintenance,
while explicit refresh waits on project serialization. Shutdown closes new
lifecycle admission and drains accepted work before storage and persistence are
closed.

## Persistence

Application services depend on operation-specific persistence interfaces.
`src/server/state-store.ts` defines runtime/project operations; identity,
authentication and knowledge modules define their own contracts. These are
implemented by `SqliteStateStore` and query helpers on one controller-owned
`better-sqlite3` connection. Atomic operations own their transactions inside
that adapter; there is no public generic `StateStore.transaction` API.

Knowledge uses independent project IDs, revision checks, history and
idempotency records. Removing a runtime project detaches its knowledge link
without deleting knowledge. Logical project transfer and full-controller
backup are different recovery operations; neither changes the authoritative
write location of an existing Hub project automatically.

On Linux the database lives at
`$XDG_DATA_HOME/worktree-switcher/state.sqlite3`, falling back to
`~/.local/share/worktree-switcher/state.sqlite3`. Logs live below
`$XDG_STATE_HOME/worktree-switcher/`, falling back to
`~/.local/state/worktree-switcher/`. The same environment variables and
fallback directories are used on the supported macOS build.

The controller opens one database connection, enables foreign keys and WAL,
uses prepared statements, and runs numbered migrations before accepting
requests. A state-directory lock prevents two controller instances with the
same runtime configuration from owning the process set. Stored PIDs are hints
only; restart reconciliation verifies process identity before acting on them.

Reservation acquisition uses a short `BEGIN IMMEDIATE` transaction: expire old
leases, check the active reservation, insert the new reservation, and append
the audit event before commit. A partial unique index enforces at most one
unreleased reservation per project. Raw lease tokens are never stored.

The initial schema contains `schema_migrations`, `settings`, `projects`,
`reservations`, and append-only `audit_events`. Logs and Git-derived worktree
metadata are not stored as relational history in the MVP. Database backup uses
the SQLite backup API rather than copying live database/WAL files.

Bounded worktree disk-usage samples are the one derived-history exception.
They live in `worktree_storage_samples`, are keyed by project and canonical
worktree path, and are discarded with their owning project.

Test-run metadata and the last 200 bounded output lines live in `test_runs`.
Each project retains 50 completed runs; active and queued records are never
removed by retention. Full rotating output is stored in the state log
directory rather than SQLite. Versioned source evidence is stored as bounded
JSON; rows created before source attribution map to `legacy_unknown` without
inventing execution-time observations.

Accounts would also require authentication, authorization, ownership,
and audit semantics; SQLite alone does not make the application multi-user.

## Project configuration model

The following is an illustrative configuration model from the initial design,
not a current API payload or importable configuration file. Current project
contracts live in `src/shared/contracts.ts`; persisted fields and migrations
live in the SQLite adapter:

```json
{
  "schemaVersion": 1,
  "server": {
    "host": "127.0.0.1",
    "port": 3410,
    "openBrowser": true
  },
  "projects": [
    {
      "id": "frontend",
      "name": "Web App",
      "repositoryPath": "/projects/web-app",
      "port": 3000,
      "command": {
        "executable": "pnpm",
        "args": ["dev", "--", "--port", "{port}"]
      },
      "selectedEnvironmentProfile": "staging",
      "environment": {
        "FEATURE_MODE": "staging"
      },
      "environmentProfiles": [
        { "name": "default", "environment": {} },
        {
          "name": "staging",
          "environment": {
            "FEATURE_MODE": "staging"
          }
        }
      ],
      "healthcheck": {
        "path": "/",
        "timeoutMs": 30000
      },
      "autoStart": false
    }
  ]
}
```

Unknown database schema versions fail with an actionable error. Project IDs are
stable, URL-safe keys. Ports must be unique among simultaneously running projects.
Repository paths are canonicalized during registration. The browser sends a
discovered worktree identifier, not a command or arbitrary filesystem path.

Environment values are explicit overrides merged onto a deliberately filtered
controller environment. Secrets should remain in the managed project's normal
environment mechanism and must not be copied into the database by default.

Each project stores a validated launch preset. Existing records migrate to the
Node.js preset. New registrations may select automatic detection, Node.js, or
Django; automatic detection is resolved to a concrete preset before storage.
The concrete executable and arguments are resolved against the selected
worktree before every start. Django therefore uses a worktree-local `.venv` or
`venv` when present and otherwise invokes `python3`, always through `shell:false`.

## Installation authentication

The shared authentication module enforces the stored installation mode across
HTTP, MCP and live subscriptions. New databases default to `token` and cannot
start until a token has been generated. Existing databases migrate to `legacy`;
`open` is explicit and `better-auth` is an unavailable provider. Installation
tokens are stored as verifiers, and rotation invalidates active sessions.
Local administration uses an owner-only Unix socket while running or the
singleton lock while stopped. Scoped knowledge credentials keep their grants;
they do not expose runtime claim/configuration tools.

See [authentication modes](authentication.md) for commands, migration and the
remaining open-mode CLI limitation in knowledge, identity administration and
logical import/export.

## CLI and package

The public npm package is `worktree-switcher` with one `bin` entry of the same
name. The package has not been published yet. The built executable currently
supports:

```text
worktree-switcher [start] [--no-open]
worktree-switcher auth status
worktree-switcher auth token generate|rotate
worktree-switcher auth mode set open|token|better-auth
worktree-switcher config path
worktree-switcher config mcp
worktree-switcher project add <path> [--name <name>] [--port <port>] [--preset auto|node|django]
worktree-switcher project list [--json]
worktree-switcher project remove <id>
worktree-switcher doctor
worktree-switcher service install [--refresh]
worktree-switcher service status|start|stop|restart|open|url|uninstall
```

Project mutations share `ControlService` with HTTP and MCP. When the user
service is running, project CLI commands use its owner-only access record and
HTTP API. Token mode requires `WORKTREE_SWITCHER_TOKEN`; open mode does not.
When no controller owns the state, the CLI acquires the same
singleton lock before opening SQLite. A foreground controller without a safe
access record causes a clear refusal instead of concurrent database access.

Until the package is published, source-checkout commands use the built entry
point:

```bash
node dist/cli/index.js auth token generate
node dist/cli/index.js start
# Stop the foreground controller before installing the service.
node dist/cli/index.js service install
```

Foreground mode is the evaluation and diagnostic path. The recommended daily
setup is an explicit user-service installation. Linux uses
`~/.config/systemd/user/worktree-switcher.service`; macOS uses
`~/Library/LaunchAgents/dev.worktree-switcher.controller.plist`.

The generated definition contains absolute executable, dashboard, data, and
state paths. Its environment has `NODE_ENV=production` and a controlled `PATH`
that includes the Node.js executable directory and standard system binary
directories. The service starts with the user's platform session. Both
platform definitions throttle failure retries to five seconds; systemd also
caps the restart burst.

The service never stores pairing URLs or bearer tokens in its definition or
manager logs. Once listeners are ready, the controller writes the current
browser URL to an owner-only state file. `service open` reads it without
printing it; `service url` prints it only after an explicit request.

`service status` combines manager state with the runtime access record and a
single `ps` sample. It reports PID, uptime, version, endpoints, restart and exit
data when the platform provides them, controller RSS, controller CPU, and log
locations. Full process-tree resource monitoring for managed servers remains a
separate feature.

The controller acquires an atomic state-directory lock before opening SQLite,
binding listeners, or creating a process manager. A live lock rejects a second
foreground or service instance that uses the same state directory. A stale
lock is replaced only after its PID no longer exists.

On normal `SIGINT` or `SIGTERM`, the controller closes listeners and gracefully
stops every process tree it owns. systemd's `KillMode=control-group` and the
LaunchAgent process-group policy cover unexpected controller failure. Unknown
processes that happen to occupy configured project ports remain untouched.

Upgrade refresh is explicit:

```bash
worktree-switcher service install --refresh
```

Without `--refresh`, installation refuses to replace a definition that points
at different paths or settings. Uninstall removes only the user-service
artifact and preserves the database, tokens, configuration, and logs.
