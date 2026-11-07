---
audience: "contributors implementing the controller and user interface"
last_reviewed: "2026-11-07"
source_of_truth: "runtime, persistence, configuration, and distribution decisions"
status: "active"
---

# Architecture decisions

## Runtime shape

Worktree Control ships as one long-lived Node.js process. Next.js is a build
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

`autoStart` defaults to false. Project registration is explicit. Ordinary
registered projects never install dependencies automatically, and stopping a
server does not release its reservation.

Finite verification commands use a separate `TestJobManager`; they do not add
phases to the long-lived development-server state machine. `NodeTestCommandAdapter`
discovers allowlisted package scripts, while `DjangoTestCommandAdapter` resolves
`manage.py test` with the interpreter belonging to the exact worktree.
`GodotTestCommandAdapter` requires a root `project.godot` and a worktree-contained
`scripts/project.sh`, then exposes only `godot:check` and `godot:export-macos`.
These resolve to `bash` plus `["scripts/project.sh", "check"]` or
`["scripts/project.sh", "export-macos"]`. Discovery and execution revalidate the
files; no script means no presets. All adapters produce shell-free executable
and argument arrays for the shared queue; project scripts own their internal
tool resolution and guards.

The queue is FIFO, has a persisted global parallel limit from 1 through 16,
and runs at most one job in a given worktree. Lowering the limit does not stop
active jobs. Cancellation signals the complete owned process group and
escalates only if it does not exit; the persisted run becomes terminal only
after process exit is confirmed. Output is written to the rotating file log
per line, while the bounded SQLite tail is persisted on a short debounce and
again at completion. Queue counts and scheduling candidates use filtered SQL
queries that do not hydrate historical log tails. Controller shutdown cancels
active jobs; stale queued or running records become `interrupted` during recovery.

Scoped finite verification adds independent `tests:run` authorization in the
verification application module. Migration 44 writes an immutable requester
row atomically with enqueue, binding principal, credential, project, originating
session and any required reservation/hash. Existing jobs and credentials receive
no backfill. The same queue checks current authority at dispatch and immediately
before spawn; it retains existing process ownership and cleanup semantics.
Own-run reads/waits use an allowlist through the shared status sampler and
recheck authority after admission. New sessions with the same credential may
read retained results; cancellation remains restricted to the originating
session. Server-profile inheritance requires separate ENV authority and is
denied for these scoped enqueues. Raw HTTP runtime routes remain closed.
See [finite verification](authentication.md#independently-delegated-finite-verification).

Queued verification records bounded Git source observations at enqueue, before
spawn, and after owned-process cleanup. Preparation consumes the same global
slot and per-worktree exclusion as a running job. A changed or unavailable
preflight rejects the job without spawning; a successful command is reported as
`passed` only when complete, clean endpoint observations match. Dirty, changed,
or incomplete evidence preserves the separate process outcome but cannot certify
the queued revision. The status digest describes bounded Git status records, not
file contents: edits restored between observations, ignored inputs, environment,
and external services remain outside this source-attribution guarantee.

Remote-worker preparation may explicitly enable a worker-local pinned pnpm 11
policy for trusted exact-SHA repositories. Its cancellable Git/setup subprocesses
use the same owned-process-group adapter, shared Git admission and finite queue
slot. One admitted preparation deadline spans source fetch through preflight;
execution keeps its separate preset timeout. Per-attempt HOME/TMP/cache and
secret-free environment do not create a sandbox. Unknown process or workspace
cleanup retains ownership and blocks finite admission, including after restart.
A stopped-installation owner session can inspect an exact uncertain attempt and
reconcile it after a different boot on the same Linux host. Signed provenance
is committed before any Git/setup/execution subprocess and binds host, boot,
installation and original directory identities. Recovery records a separate
monotonic local audit, preserves uncertain reports, and retains/excludes artifact
slots and the source cache. Same-boot or insufficient evidence stays blocked.
The finite queue rechecks retained-path exclusions before work, even without
remote configuration. This operation uses the existing singleton connection and
locks; it adds no process signalling, database owner or report protocol.
See the [remote verification setup contract](remote-verification-plan.md) for
commands, proof assumptions, retained artifacts and remaining acceptance gates.

The production authentication bootstrap owns one lazy provider composition.
Protected administration and the internal browser preparation method share its
runtime, configuration pin, current-session authority and IdentityService.
Ordinary-restart issuance recovery runs once on the existing store before load;
restored provenance refuses it without sweeping pending rows. One disposal joins
accepted administration/preparation and drains the provider before SQLite closes.
The public browser mount and account-mode selector remain gated. See
[shared provider composition](authentication.md#shared-controller-provider-composition-p1)
for explicit engineering limits. P2a adds an explicit runtime reader aggregate
(schema 45), protected local administration and current-provider-session reads
through the existing scoped projections and controller facade. Discovery yields
the same connection admission and rechecks before result delivery. Humans have
no agent lease ownership. P2b1 adds explicit operator action subsets and actual
provider-session human leases through shared runtime operations and a closed
mutate route. Schema 46 retains reservations on the sole connection, adds a
permanent bound marker, finite-deadline/evidence sidecar and bounded durable
intent ledger. The existing lifecycle locks, capacity and process verifier are
reused; pending/interrupted intent never reruns automatically. Exact original
membership/session authority fences mutation and delivery, including replays.
See [human runtime leases](authentication.md#human-runtime-operators-and-leases-p2b1).
P2b2 adds human tests-only discovery/enqueue/own-run status/wait/cancel on the
existing finite queue and shared status budgets. Schema 47 keeps a durable
provider-bound run marker and separate immutable requester attribution. A
provider-owned native-row reference revalidates original current session and
membership without constructing an agent or trusting persistence as authority.
Missing attribution fails closed. Original no-claim/exact-claim fences govern
dispatch and replay; all human own-run access retains its original session and
membership revision, including completed history. P2c supplies explicit literal
profile selection and timeout-only configuration below. Remaining transport parity, P3 recovery/restore fencing and A5 remain activation
gates; no public browser mount is enabled.

### Human configuration operations

`HumanConfigurationService` accepts only actual provider-session actors and uses
IdentityService, the existing ProjectLifecycle lock/admission and discovered
worktrees/presets. ControlService and the closed internal authentication HTTP
adapter call that shared application. Profile selection and timeout-only overrides
are independent explicit human permissions, with no implied runtime or ENV rights.

Schema 48 extends the existing bounded human runtime intent ledger with a typed
configuration context and marker. Original session/evidence/membership and
no-claim or exact pinned-lease context fence both writes and receipt replay.
SqliteStateStore shares the agent configuration mutation/revision/audit fragment;
the human transaction also completes the durable receipt on the sole connection.
No new lifecycle, queue, lock map, capacity counter or provider connection is added.
Selection never controls processes; queued timeout snapshots remain unchanged.
See [the bounded contract](authentication.md#human-literal-profiles-and-preset-timeouts-p2c).

## Resource policy

Managed development applications have priority over Worktree Control. The
controller must be event-driven and have bounded memory use:

- no recursive filesystem watcher over managed repositories, except the
  bounded per-directory source watcher of a running `godot-web` preview
  (opt-in, Git-ignored and output paths skipped, at most 4,096 directories,
  disposed when the runtime stops; see [Godot Web preview](godot-web.md));
- no continuous Git polling while the dashboard is closed;
- a repository-keyed dashboard metadata projection with single-flight refresh,
  30-second freshness/error disclosure, at most 128 entries and an 8 MiB
  serialized metadata budget;
- at most four Git subprocesses with separately bounded queues of 128 operational
  and 128 background commands, prioritizing fresh operational validation even
  when the display queue is full;
- runtime log tails capped at 400 lines per project and 4,000 characters per
  line; disk output batched into 64 KiB writes while preserving rotation;
- one five-second runtime resource observer per active Linux process group,
  with at most 60 in-memory RAM points; passive finite-job observers use a
  one-second delay after each completed attempt. Both share a single-flight
  process enumeration with a 250 ms cache and eight bounded file readers;
  no observer timer runs for stopped projects or completed jobs;
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

The Linux resource adapter aggregates `/proc` counters for observed members of the
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
`$XDG_DATA_HOME/worktree-control/state.sqlite3`, falling back to
`~/.local/share/worktree-control/state.sqlite3`. Logs live below
`$XDG_STATE_HOME/worktree-control/`, falling back to
`~/.local/state/worktree-control/`. The same environment variables and
fallback directories are used on the supported macOS build.
`WORKTREE_CONTROL_DATA_DIR` and `WORKTREE_CONTROL_STATE_DIR` override them.

Installations from before the 2026-10-05 rename used `worktree-switcher`
directory names. When no directory flag or variable is given, the new default
directory does not exist, and the corresponding `worktree-switcher` directory
does, the controller keeps using the legacy directory and prints a one-line
notice. It never moves or copies data. Legacy `WORKTREE_SWITCHER_*` variables
are still read, with a deprecation warning, when the new name is unset.

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

Installation backup admission and preflight retain the stable `backup_limit`
error code with optional bounded `limit` evidence: `reason`, `current`,
`required`, and `maximum`. `catalog_bytes` means the recognized catalog plus
the estimated new snapshot exceeds the configured byte budget.
`filesystem_space` means destination space available to the controller is less
than the estimate plus a 16 MiB reserve (`current: 0`, `maximum: available`).
`manual_history`, `service_history`, `queue`, `catalog_scan`, and
`catalog_entries` use counts; `snapshot_bytes` identifies an oversized snapshot
at asynchronous verification. Remote-transfer limits remain separate.

`worktree-control backup list`, `backup status --idempotency-key <key>`, and
the authorized backup HTTP API expose recorded execution evidence on each
operation. Missed scheduled admission records evidence in `schedule.limit`;
`schedule.error` describes admission, while `schedule.lastOperation` describes
the latest admitted attempt. A successful admission clears the previous
admission evidence. Historical operations without evidence remain unknown;
current capacity must not be presented as an old attempt's measurement.
The optional fields survive controller restart in the checksummed operation
ledger, without paths, identities, or keys in the public evidence. Older
ledgers remain readable. Once new fields are written, an older binary with a
strict ledger schema cannot read them; preserve the ledger and use a compatible
binary rather than removing evidence to roll back.

Retention runs only after a successful scheduled backup. Budget for the next
full snapshot as well as retained copies, including recognized protected manual
and pre-migration copies. The configured count governs scheduled copies, not
all catalog entries. A failed preflight never deletes old recovery points or
relaxes the budget. A successful standalone pre-migration copy does not prove
that the scheduled catalog has headroom. When capacity prevents progress,
operator recovery requires an explicit policy or protected-copy decision.

Bounded worktree disk-usage samples are the one derived-history exception.
They live in `worktree_storage_samples`, are keyed by project and canonical
worktree path, and are discarded with their owning project.

Test-run metadata and the last 200 bounded output lines live in `test_runs`.
Each project retains 50 completed runs; active and queued records are never
removed by retention. Full rotating output is stored in the state log
directory rather than SQLite. Versioned source evidence is stored as bounded
JSON; rows created before source attribution map to `legacy_unknown` without
inventing execution-time observations.

Version-1 `test_run_summaries` persist independently of detailed rows, using the
same owner connection and transaction as each run checkpoint. Migration 29
backfills only retained details with `legacy_unknown` timing; pruned history
cannot be reconstructed. Project removal cascades both summaries and coverage
accounting under the existing project operation. `get_test_run` supplies additive
`telemetry` for retained runs. Stage 3 nests a versioned passive resource
summary inside that existing JSON, preserving schema 29 and summary retention.
A fresh spawn's PID/start ticks and surviving observed generations establish
sampling identity; PGID alone does not. Its first enumeration must start after
identity capture, even when another consumer has a cached or in-flight scan.
If the leader exits before any surviving generation is observed with it,
sampling ends conservatively because group continuity cannot be established.
RSS is sampled summed process RSS, and
CPU describes only deltas between observed matching generations (100% is one
core), never complete job totals. Missing/partial/unsupported/legacy quality
and denominators travel with the peaks. Explained churn and final-read gaps
permit descriptive comparisons; identity/read integrity failures exclude both
resource deltas and counter gaps exclude CPU deltas. No cgroups, resource enforcement or
exporter is introduced. See [resource semantics](verification-history-api.md#passive-per-run-resources).
`VerificationHistoryService` supplies retained
summary history, single-summary lookup, metrics and comparison through the
`ControlService` facade to HTTP and MCP. It uses the same runtime authentication
boundary as verification detail reads; scoped Knowledge grants do not authorize
verification. See [verification history API](verification-history-api.md) for
filters, keyset consistency, statistics and query limits.

Telemetry uses wall timestamps for correlation and same-controller monotonic
intervals for duration. `admittedAt` ends queue residence and begins preparation;
`prepareFinishedAt` ends preflight, including rejection. `startedAt` retains its
existing pre-spawn meaning; `spawnedAt` records the spawn event and `exitedAt`
records the leader's exit event. Requested cancellation/timeout has its own
`stopRequestedAt`. Cleanup duration begins at observed exit (or spawn error)
and ends at confirmed owned-tree cleanup. Output-pipe closure, final source
observation and log closure belong to finalization. `finishedAt` keeps its
existing boundary after process cleanup/output closure, before final source and
log finalization; `finalizedAt` is captured immediately before the atomic final
detail/summary write, excluding that write's latency. Queue cancellation without
admission measures queue residence to the stop request; cancelled preparation
retains exclusion and finishes measurement when its observer settles.

Missing intervals are null, never inferred from wall times. Internal runner
lock waiting is unknown (`runnerWaitMs: null`). After restart, `recoveredAt`
records reconciliation and lost intervals remain unknown; known exit observations
and process outcomes survive. Termination distinguishes exit, cancel, timeout,
interruption, spawn error, rejected preparation and unknown. Exit 137 or SIGKILL
alone does not identify OOM. Source attribution and process outcome remain
separate; dirty command success cannot certify `observed_match`.

Summaries contain bounded project/preset/worktree and source identities, command
and profile-policy digests, result and timing. They omit arguments, environment
values/names, raw profile values, free-form errors and log tails. A profile digest
identifies declared policy selection, not its secret values or the actual
installed toolchain. Primary persistence failures roll back detail and summary,
stop further admission, emit a controller error and remain visible at shutdown.
An unavailable monotonic observation only makes telemetry partial.

Local stage-1 retention defaults are 30 days from enqueue, 5,000 records and
16 MiB of logical summary JSON per project, with 50,000 records/128 MiB globally
and 8 KiB per record. These conservative defaults are for calibration, not the
plan's proposed 90-day product policy. Limits can evict earlier than the time
horizon. At most 64 terminal summaries are deleted per completion or one-minute
maintenance tick, also once on startup; queued, preparing, executing and
unfinished-finalization summaries are excluded. Active data and a maintenance
backlog can temporarily exceed targets. Internal coverage reports retained
count/bytes, oldest/newest enqueue, eviction count, last pruning time, policy
and pending maintenance. SQLite indexes/pages/WAL overhead is outside the logical
JSON budget. These stage-1 retention rules do not retain detailed traces.
Passive per-run resource sampling was added in stage 3, as described above.

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
Node.js preset. New registrations may select automatic detection, Node.js,
Django, or `none`; automatic detection is resolved to a concrete preset before
storage. A root `project.godot` resolves to `none` only when Node/Django detection
is absent. Explicit `none` also accepts repositories without those manifests.
These verification-only projects have no runtime command (stored executable is
empty and arguments are empty), use no server capacity, and do not inspect or
listen on their configured port. The port schema and uniqueness stay unchanged.
Start, restart, switch, stop, TLS changes and claim-with-start refuse `none` at
the application boundary; the process adapter also refuses a direct start.
Claim refusal leaves no lease. Manual reservations retain their existing test
admission semantics. Tests need no runtime claim and receive no controller
server URL/port metadata for `none`. The dashboard derives its localized
no-server status from the persisted preset, keeping finite job phases separate
from the runtime state machine.

Migration 30 expands `projects.launch_preset` and `test_runs.adapter` CHECKs
through the existing table-rebuild helper, preserving rows, indexes and foreign
keys. It runs on the sole owned connection in the ordered schema transaction,
with FK validation before commit and migration provenance recorded together.
Migration 31 adds `projects.test_preset_timeouts_json` with an empty-object
default, preserving existing project profiles and queue settings. The sole
SQLite owner writes an override and its audit event in one transaction.
Verification applies it both during preset discovery and when capturing a
new run's timeout; adapters retain their 15-minute defaults. See
[preset timeout configuration](reservations-and-mcp.md) for bounds and reset
semantics.

The `godot-web` preset is explicit opt-in and never chosen by detection. Its
runtime is the bundled `godot-web-server` entry started as an owned process
group with the project's port; it reads only the per-project public store
under the state directory and is bound to its worktree by an opaque key in its
arguments. The controller owns the watcher, export scheduling and atomic
generation publication. Exports are finite jobs (`godot:web-export`) in the
shared queue; trusted in-process `observe` and `settle` hooks let the module
observe source and publish while the job still holds its worktree slot.
Migration 43 rebuilds the `projects.launch_preset` CHECK with the existing
helper and adds the nullable `projects.godot_web_json`, in the same ordered
schema transaction, after the released migrations 35–42. The rebuild keeps the
foreign keys of every `projects` child, including the runtime-access tables.
Godot Web background work (runtime events, watcher timers, queue settlement and
follow-up exports) takes its own database admission and releases it while
waiting for an export to settle. See [Godot Web preview](godot-web.md).

The concrete executable and arguments are resolved against the selected
worktree before every start. Django therefore uses a worktree-local `.venv` or
`venv` when present and otherwise invokes `python3`, always through `shell:false`.

## Installation authentication

The shared authentication module captures the active installation mode once per
controller boot, after migrations and restore recovery, and enforces it across
HTTP, MCP and live subscriptions. The existing stored policy mode is the
next-start selection. Protected CLI administration alone can select it;
activation requires a separate service restart. Private status distinguishes
active/configured mode and restart requirement. Offline status has no active
mode. Public HTTP, GUI and MCP expose no selector. Selection does not change
sessions, listeners or live client access records; rotation still invalidates
credentials and derived sessions immediately. Every authentication reads current
token IDs/verifiers and current principal/grant authority. Serialized admitted
selection rereads fresh policy and atomically saves selection plus audit, with
no schema or configuration-revision change. Maintenance is checked inside
admission after waits.

Version-2 restore handoffs persist active `executionMode` separately from the
latest configured authentication policy. Execution uses the former and the
current captured token ID; startup restores the latter before capturing the new
boot mode. Old format-1 handoffs use their historical policy mode. New malformed,
unknown or inconsistent records fail closed. Existing restore revocation fences
and owner locks remain; A5 provider-session resurrection remains unresolved.

New databases default to `token` and cannot
start until a token has been generated. Existing databases migrate to `legacy`;
`open` is explicit and `better-auth` is an unavailable provider. Installation
tokens are stored as verifiers, and rotation invalidates active sessions.
Local administration uses an owner-only Unix socket while running or the
singleton lock while stopped. Scoped knowledge credentials keep their grants;
they do not expose runtime claim/configuration tools.

See [authentication modes](authentication.md) for commands and migration.
Knowledge CLI, identity administration and logical import/export now apply
the active policy when no token variable is present, including open mode.

The first A3 slice adds a versioned server-only provider contract and explicit
local loader, exercised by a private Better Auth workspace proof. Startup
does not load it and account mode stays unavailable. Explicit protected CLI
maintenance uses a single lazy runtime without mounting browser login. Controller
migration 38 owns the empty namespaced provider tables and explicit subject-to-owner
mapping. Controller migration 39 adds only the `provider_session` Knowledge
history method, preserving rows, IDs, timestamps, indexes and deleted-ID
watermarks. Migration 40 adds frozen two-factor and passkey plugin storage plus
controller-recognized account policy, monotone steps, credential trust, attempt
state and immutable session evidence, and provider storage revision 2. Earlier
migrations and checksums remain unchanged. Full backups identify the current schema;
genuine 38 and 39 backups and logical history transfers remain supported. There is
no credential, factor, evidence or grant backfill.
An exclusive connection
guard protects core SQL, prepared statements and backups while asynchronous
provider work borrows the sole connection. Shared core admission and exclusive
provider admission now coordinate on that gate; see [database admission](#database-admission).
The strict proof includes HTTP error-classification regressions; broader
integration coverage and design acceptance remain open. Safe live coexistence
is not accepted.
The bounded browser adapter is dispatched outside blanket core admission in
explicit isolated composition. It reads strict bounded bodies, borrows the
provider, then checks current authority and releases safe DTOs/cookies in a
synchronous admitted phase. Sensitive password changes recheck the exact actor
inside the actual queued borrow. Converted Knowledge effects/results use
`ProviderKnowledgeApplication.executeAdmitted` in that same synchronous phase.
Unconverted HTTP and separate MCP requests carrying provider cookies are denied
before compatible installation authority, including open mode. Production main
has no browser-composition caller. Provider maintenance is reached only through
the protected CLI/private Unix socket. See the
[browser contract](authentication.md#bounded-browser-adapter).

The isolated adapter also serves
[closed factor routes](authentication.md#closed-factor-http-api). The runtime dispatches
a closed operation table and returns an opaque release plus a separate settlement
promise, so a response slot outlives a timed-out borrow until its callback really ends.
A final check against current rows, the durable publication marker and header emission form one synchronous
admitted phase. Accepted cleanup uses reserved queue room on the same gate, with no new
lock, counter or connection.

Current isolated provider API is contract 5, storage revision 3, implementation
`0.0.0-proof.5` and core schema 48. Earlier versions evolved as follows.
Provider API contract 2 requires durable `signOut`; version 1 fails compatibility
checks. Contract 3 adds the application-owned `host.protection` port: the provider
calls it synchronously inside its open transaction, and `AccountProtection` keeps
policy, transitions and the current-authority rule in the controller. Disposal tracks actual provider settlement and closes only its borrowed facade.
The runtime also owns cleanup of sessions it minted but never released, as bounded
in-memory ID records tied to the exclusive borrow. Issuers are refused before minting
at the bound. Schema 41 keeps session issuance durable: each new session commits with a
`pending` marker, `may_publish` commits before any cookie leaves, and the owner's one
ordinary-restart recovery removes `pending` rows before an issuer can load. Installation-wide
row and batch bounds are required inputs. A recognized restore refuses that recovery. See
[durable issuance](authentication.md#closed-factor-http-api).
The owning shutdown helper disposes the optional provider after external
producers/listeners/accepted responses drain and before service/SQLite close.
A rejected disposal reports unconfirmed cleanup and retains both owner locks;
concurrent calls share completion or failure. Partial-load disposal failure is
also reported honestly. Raw library logs/router errors are replaced with fixed
events, including errors that the native router would otherwise print directly.
Local provider modules are trusted code, not sandboxed plugins. See the
[proof contract and limitations](authentication.md#optional-provider-proof-first-a3-slice).

Protected provider administration shares one server-only application across
offline CLI and the private socket. Short config/status/principal phases use
core admission; loading and account effects run outside it. A storage decorator
rechecks maintenance and pinned configuration in the actual queued borrow,
using the existing gate. One retained initialization promise belongs to each
controller. Shutdown joins accepted commands even after client disconnect,
then partial loading, provider disposal/drain, service/SQLite close and owner
release. Unconfirmed cleanup retains ownership and a referenced process lifetime.
The private durable configuration needs separate backup; its operational event
does not claim atomic filesystem/SQLite audit. Principal-only creation and
enrollment intentionally commit separately without issuing a credential/grant.
See [protected maintenance](authentication.md#protected-provider-maintenance).

Schema 42 adds ordinary `human` principals by rebuilding only the referenced
principal table on the owner's existing connection and ordered migration
transaction. Final integrity/FK validation commits or rolls back the rebuild.
Historical owners, migration SQL/checksums 1..41, credentials, factors, issuance
markers and content IDs remain unchanged. Provider mappings/session projections
allow only active owner/human kinds; opaque actors freeze and compare exact kind
and mapping link time. Provider contract/storage/native tables are unchanged.

Protected human lifecycle and Knowledge membership operations share
`ProviderAdminApplication` and `HumanAccountService` across private IPC/offline
CLI. They do not import the provider. A human membership uses the A1 binding's
revision as aggregate CAS for grant, binding and audit in one immediate
transaction. Legacy grant/role mutators refuse these targets. Ordinary humans
need both active rows and explicit read/write grants; roles only restrict them.
No installation/runtime role table or cookie administration authority is added.
See [ordinary human accounts](authentication.md#ordinary-humans-and-knowledge-memberships-a3-i24).

## Database admission

`SqliteStateStore.admission` uses the owner's existing connection gate. It adds
no connection, database lock, project lock map or finite-capacity counter.
`run` joins a live core participant; `detached` creates a separate participant.
`tryRun` executes synchronous work only when admission needs no wait. `outside`
starts a background flow without inheriting its caller's participant.
Consecutive core tickets can share admission, while a queued provider prevents
later independent core roots from bypassing it. Provider-to-core transaction
access is restricted to the synchronous controller-operation port. Upgrades
from core admission to provider borrowing fail immediately.

`idle` releases the participant for a SQL-free wait, then waits for admission
again before returning. It suspends the whole participant, including joined
calls. Joined branches must therefore run sequential phases; independently
idling branches need separate `detached` admissions. The dashboard's existing
`Promise.all` projection does not idle during bounded Git discovery and retains
admission until its branches settle. This avoids sibling suspension there but
can delay provider access. It is not a general proof that all future fan-out is
safe.

The current `ProjectLifecycle.serialized` implementation releases the caller's
admission before waiting for the project lock. The callback runs admitted under
that lock. A holder may idle for readiness, stop, network or preparation work;
no admitted caller may wait for that lock while retaining admission. This is a
change from the earlier admission-before-project-lock proposal. Strict tests
exercise two operations on one project with a provider between them, but design
acceptance of this ordering remains separate. Scoped operations recheck current
authority around effects and before returning retained outcomes. Local
`RuntimeService.operateLocked` accepts a current-authority callback for installed
HTTP runtime operations. It rechecks after asynchronous phases and immediately
before spawn; the HTTP boundary rechecks before responding. Reservation mutations
use the same callback under the project lock. Token rotation while waiting denies
queued mutations and successful replies. Already performed effects are not rolled
back. Installed reservation requests serialize behind readiness, so direct-store
reservation injection is not a supported transport takeover. Scoped lease expiry
and provider Knowledge authorization remain separate policies.

Accepted finite jobs coalesce bounded log/resource checkpoints, preserve event
timestamps and serialize writes per run. A terminal durability barrier precedes
slot release. Background completion uses reserved queue capacity. Retry helpers
retry only admission refused before callback entry, never a runtime effect,
attachment publication, backup creation or entire network workflow that already
ran. Scan completion saves under fresh admission. Log retention awaits current
retention answers; a failed lookup does not authorize deletion. Remote outbox
ACKs merge into the current receipt after networking, preserving newer state.

Database admission currently waits at most 5 seconds by default. Persistence
retry normally has a 60-second budget; log-retention lookup uses 10 seconds.
Database drain defaults to 10 seconds. These are implementation limits subject
to review, not approved account-session or security-policy defaults. Compatible
mode preserves existing synchronous access when no provider is loaded; strict
mode is enabled after fixture bootstrap to detect missed boundaries.

The owner closes external lifecycle admission and timers before draining
accepted work. The connection gate's `beginDrain` deliberately leaves core
admission open for those completions while closing provider admission. It is
not an external-request firewall. Store close waits for actual provider
execution, core participants and driver backups. Timeout or failed driver close
retains database ownership, and restore execution must wait for confirmed
shutdown. Tests cover the owning service and actual CLI shutdown orchestration
with temporary Unix HTTP/MCP/admin/remote listeners. The success path refuses queued HTTP dispatch during maintenance and drains
its response plus the accepted admin write/response once. Failed producer or
listener closure prevents SQLite close; unconfirmed service cleanup retains its
database owner, and any shutdown failure retains controller ownership. Concurrent
same-mode calls join one completion, including failure. A different handoff mode
is refused. The sequence lives in `src/server/bootstrap/controller-shutdown.ts`;
there is no automatic retry that hides a failed shutdown.

Installed restore completion callbacks and deferred launch are covered under
contention, including duplicate finish/close, disconnected responses, current
revocation and refused shutdown. Execution waits for confirmed shutdown, retaining
the controller lock while closing database ownership. Physical replacement and
restart are mocked. HTTP 202 acknowledges admission, not completed restore.

The implemented provider-to-core handoff authenticates outside admission and
issues an exact runtime-owned frozen actor. `IdentityService` uses that runtime
as a synchronous current-session authority inside each admitted Knowledge phase.
Current session/mapping/principal state and original expiry are checked before
ordinary grants/role ceilings and replay. Safe identity metadata has no A2
credential. No provider reentry or notification-only cache authorizes work.
Owner/runtime/vault privileges remain denied. See the
[implemented API](authentication.md#provider-authorization-handoff).
Production browser loading/account mode and broader callback coverage remain
separate acceptance gates. The bounded isolated browser API already exists. The [proof coverage table](../packages/auth-provider-better-auth-proof/README.md#live-admission-coverage)
records what the strict integration tests exercise and what remains open.

## CLI and package

The npm package is `worktree-control`, with the `worktree-control` executable
and the short alias `wtc`. It does not install a `worktree-switcher` command:
that npm name belongs to an unrelated project. The package has not been
published yet. The built executable currently supports:

```text
worktree-control [start] [--no-open]
worktree-control auth status
worktree-control auth token generate|rotate
worktree-control auth mode set open|token|better-auth
worktree-control config path
worktree-control config mcp
worktree-control project add <path> [--name <name>] [--port <port>] [--preset auto|node|django|none]
worktree-control project list [--json]
worktree-control project remove <id>
worktree-control doctor
worktree-control service install [--refresh]
worktree-control service status|start|stop|restart|open|url|uninstall
```

Project mutations share `ControlService` with HTTP and MCP. When the user
service is running, project CLI commands use its owner-only access record and
HTTP API. Token mode requires `WORKTREE_CONTROL_TOKEN`; open mode does not.
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
`~/.config/systemd/user/worktree-control.service`; macOS uses
`~/Library/LaunchAgents/dev.worktree-control.controller.plist`.
`service install` migrates a pre-rename `worktree-switcher.service` or
`dev.worktree-switcher.controller` definition: it copies the legacy unit's
systemd drop-ins to the new unit, stops the legacy service just before starting
the new one (both use the same ports and lock), waits until the new main
process stays up without restarts for a few seconds (bounded to 30 s), and only
then enables the new service and disables and removes the legacy definition. A
failed start or health check rolls back: the new definition, its copied
drop-ins and enabled state are removed (or a previous definition restored), and
a legacy service that was running is started again. `service status` warns
about a remaining legacy definition, and `service uninstall` removes it.

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
worktree-control service install --refresh
```

Without `--refresh`, installation refuses to replace a definition that points
at different paths or settings. Uninstall removes only the user-service
artifact and preserves the database, tokens, configuration, and logs.

### Protected recovery boundary (P3a)

The shared production provider now supports password recovery for existing active
humans and the single active owner. Private CLI input defaults to preserving
factors; explicit `factors: "reset"` requires a new password and the provider's
`localFactorReset: "v1"` readiness plus separate reset method. Password, sessions,
factor bindings, challenge authority and account generation change in one sole
connection transaction. IDs, roles, grants, audit, TOTP steps and account budgets
remain. See [authentication](authentication.md#protected-factor-loss-recovery-p3a) for the operator contract.
Restored provenance remains denied until P3b; public account activation and A5
transport enforcement remain separate gates.
