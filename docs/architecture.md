---
audience: "contributors implementing the controller and user interface"
last_reviewed: "2026-11-16"
source_of_truth: "runtime, persistence, configuration, and distribution decisions"
status: "active"
---

# Architecture decisions

## Current A5 account integration

Production bootstrap now validates the actual pinned optional provider, canonical
HTTPS configuration, external fence and existing owner enrollment before account
mode can be selected or listeners opened. The shared bounded adapter is publicly
mounted only for the immutable active RBAC boot. Individual agents keep explicit
credential ceilings; diagnostic logs/storage/capacity have independent grants.
Unconverted cookie and broad privileged operations deny. The optional provider
artifact remains separate from Community. See the current
[operator contract](authentication.md#account-mode-better-auth) for the transport
inventory, protected CLI, account dashboard and installed acceptance. The static
dashboard selects the separate account dashboard only for an active
`better-auth` boot. Older slice descriptions below record their original
boundaries; A5 supersedes the unconditional mode-refusal, missing-public-mount
and missing-GUI statements. General ENV roles remain unimplemented.

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
`scripts/project.sh`, then exposes `godot:check` and `godot:export-macos`.
An optional `scripts/worktree-control-presets.json` v1 adds validated names
under `godot.presets`; see the [manifest format](../README.md#supported-projects).
All Godot presets resolve to `bash` plus `["scripts/project.sh", name]`.
Discovery and execution revalidate the files and manifest; no script means no
presets. An invalid manifest is an error, with a bounded 16 KiB read, strict
schema, at most 16 additional names, and regular-file/worktree containment checks.
The manifest does not change environment profiles or timeout policy.
All adapters produce shell-free executable
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
A local operator can inspect and stop one exact run over the owner-only admin
socket with `worktree-control test-run`; the job manager decides and applies the
effect under admission and never adopts a group it did not spawn. See
[single-run administration](test-run-administration.md).

Each locally executed run receives a private temporary directory. At start
the controller first sweeps the roots that an earlier instance recorded in
`run-directory-root.json` (version 3) in its state directory. It then creates a
root with `mkdtemp` under the OS temporary directory (`wtc-XXXXXX`, mode 0700),
writes a random 256-bit token to the marker file `.wtc-root` (mode 0600) inside
it, synchronizes the root and its parent directory so that the marker's entry
is durable, and only then records the path, the token and the boot id of this
start (Linux `/proc/sys/kernel/random/boot_id`, otherwise `null`). A recorded
root is touched only when its path is absolute and normalized, its name starts
with `wtc-`, `lstat` shows a real directory owned by the controller's user, and
its marker is a regular file with a single link, owned by that user and opened
without following links, whose content equals the recorded token (compared in
constant time; tokens are never logged). The same check applies to the live
root whenever a run directory is created or removed, and when the root is
removed at shutdown. Anything else is left untouched and logged as
`run_directory.previous_root_skipped` with a reason. Its entry stays recorded
while the path exists and is dropped once nothing exists at it, whatever its
name. A record in any other shape, including earlier formats, is ignored
(`run_directory.record_ignored`) and never used for deletion. The controller
keeps one private copy of the ignored record beside it,
`run-directory-root.ignored.json` (mode 0600, at most 64 KiB, overwritten each
time), names it in the event, and never reads it. Directories without a
matching record are never touched, so controllers with separate state
directories never delete each other's roots.

This identity check protects against a damaged or stale record: a path that
names a home directory or repository, or a temporary path later reused by
another directory. It does not protect against a malicious process of the same
user. A test runs as that user and can delete or copy the marker. A deleted
marker makes the sweep skip the root, a logged leak rather than a deletion.

Identity alone does not prove that a root is unused. Test processes are spawned
detached, so after the controller is killed outside a supervising cgroup they
can still run and use their `TMPDIR`. Right after a successful spawn the queue
therefore binds the run directory to the run's process group (the detached
child's pid; Windows has no group id) and the record is written durably. When
the directory is removed, its binding is dropped. If that write fails, the
controller logs `run_directory.binding_not_recorded` and the run continues;
its directory then counts as one whose liveness is unknown. At the next start,
a run directory directly inside an identified root is **proven quiescent**
only in two cases:

- The root's recorded boot id and the current boot id are both known and
  differ. Every process of that boot is gone, so the whole root is removed
  without probing.
- Its binding names a group id that is a safe integer greater than 1, and a
  zero-signal probe of that group (`kill(-group, 0)`) fails with `ESRCH`.

The probe only ever sends signal 0. It never stops or adopts a process. A
successful probe, `EPERM`, or a binding that is missing, `null` or invalid
means the group may be alive, and the directory is kept. Quiescent run
directories are removed, and the root is removed once only its marker is left.
A root that keeps a run directory stays recorded with the bindings of what it
kept and is logged once per start as `run_directory.previous_root_retained`
with reason `liveness_unknown` and the kept and removed counts. A later start
removes it once the groups are gone. A start examines at most 4,096 entries of
one root. A binding leaves the record only when its directory was removed or is
confirmed absent from a complete listing, so the bindings of entries a
truncated listing did not reach stay recorded for a later start. Listing the
root and removing its top-level files and links observe the same deadline as
the removal of a tree. When it passes, the sweep stops, the root stays recorded
with its remaining bindings, and the controller logs
`run_directory.previous_root_skipped` with reason `sweep_budget_exhausted`
(`removal_deadline` when the deadline of one root passes first). A reused
group id can only delay the sweep. A process that left its run's process
group is outside this proof, as it is outside process cleanup. Where the platform provides no group id or boot
id, such roots stay for the operator. To recover one by hand, take its path
from the event or the record, confirm that nothing uses it (for example
`pgrep -g <group>` for each recorded group and `lsof +D <path>`), remove the
directory, and restart the controller. That start drops the entry of a path
that no longer exists.

The record holds at most 64 roots and 64 KiB. A root that still exists is
never dropped from it. When a new root would exceed either limit, the
controller creates no root and logs `run_directory.record_full` with the
record file, the entries and bytes the record would need, and both limits.
Local runs then fail before spawn with `run_directory_unavailable`. The
operator reviews the paths named by `run_directory.previous_root_skipped` and
`run_directory.previous_root_retained` events, removes those that are not
needed, and restarts the controller. Entries whose path no longer exists are
dropped at that start. A binding that would push the record past 64 KiB is not
recorded and is logged.

Just before spawn, in the same admitted phase as the running state, the run gets
a short 0700 subdirectory (for example `/tmp/wtc-AbC123/r1`, short enough for
Unix socket paths) and `TMPDIR`, `TMP` and `TEMP` point to it. These values
override a test profile's values; stored profiles stay valid. Finalization
removes the directory after the owned process group is confirmed stopped, or
after spawn failed, and before the run releases its slot and its worktree. Run
directories are never named like the marker, and the marker is removed last,
with the root. Removal uses asynchronous, streamed, bounded calls and checks
each target with `lstat`: only a directory owned by the controller's user that
is the verified root or directly inside it, never following links or crossing
devices. It holds one open directory at any depth and repairs owner permissions
a test removed, including mode 0000. A directory without owner read permission
can only be repaired by path, so its device and inode are verified again after
`chmod`. The sweep only reaches that repair for run directories proven
quiescent, which keeps the precondition of this path-based fallback. If the
emptied root cannot be removed after its marker was unlinked (for example
because the temporary parent lost write permission) and it is still the same
directory, the marker is written back with the same token. A crash between the
marker's unlink and the root's removal leaves a recorded root without a marker.
Every later start skips it with `marker_missing`, and the operator removes it by
hand after checking that it is empty.

Each removal attempt (one run directory, the live root at shutdown, or one
recorded root at startup) has a deadline of 120 seconds, shared by its whole
traversal and every unlink batch. The startup sweep also has a total budget of
120 seconds across all recorded roots. When the deadline passes, removal waits
for its pending unlinks, keeps the root's marker, and fails with
`run_directory_removal_deadline`. This bounds a producer that keeps recreating
entries. Roots that the startup budget does not reach stay recorded and are
logged as `run_directory.previous_root_skipped` with reason
`sweep_budget_exhausted`. In the queue, a run directory whose removal failed
three times, or once at its deadline, leaves the run with its process outcome
and process-cleanup state. The run gains the reason code
`run_directory_cleanup_failed`, the controller logs
`test_run.run_directory_cleanup_failed`, the slot is released, and the
directory is left for a later startup sweep. Admission stays open. Orderly
shutdown removes the root after every owned group has stopped. If a group's
cleanup is unconfirmed, the root stays recorded. Without a root, local runs
fail before spawn with `run_directory_unavailable`. Remote-worker attempts keep
their own per-attempt directories and are unchanged. This is temporary-file
hygiene, not a sandbox. A process that escapes its owned group can still race
path-based removal, and work outside `TMPDIR` is not covered.

The startup sweep runs before the controller reports ready, so a large
leftover root delays startup, at most by the sweep budget.
`pnpm test:run-directory-scale` measures removal on the OS temporary directory
and on a disk-backed directory inside the checkout. On a Linux host with a
RAM-backed tmpfs, an ext4 root disk and Node.js 24, 200,000 empty files in four
directories took about 2.4 seconds on tmpfs and 2.9 seconds on disk. A chain of
400 nested directories took about 0.2 seconds. 20,000 sibling directories with
one file each took about 10 seconds on tmpfs and 15 seconds on disk, and 5,000
of them took about a quarter of that, so time grows linearly with the number of
siblings. The longest event-loop delay was about 14 ms at a 10 ms sampling
resolution, and at most 33 file descriptors were open. Leftover roots exist only
after a crash or a failed removal, so the sweep stays in the startup path for
now.

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
P3b refuses unacknowledged restore before opening the store; its protected quarantine receipt permits subsequent recovery without erasing provenance. One disposal joins
accepted administration/preparation and drains the provider before SQLite closes.
A5 validates account readiness before mode selection and public browser mounting. See
[shared provider composition](authentication-reference.md#shared-controller-provider-composition-p1)
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
See [human runtime leases](authentication-reference.md#human-runtime-operators-and-leases-p2b1).
P2b2 adds human tests-only discovery/enqueue/own-run status/wait/cancel on the
existing finite queue and shared status budgets. Schema 47 keeps a durable
provider-bound run marker and separate immutable requester attribution. A
provider-owned native-row reference revalidates original current session and
membership without constructing an agent or trusting persistence as authority.
Missing attribution fails closed. Original no-claim/exact-claim fences govern
dispatch and replay; all human own-run access retains its original session and
membership revision, including completed history. P2c supplies explicit literal
profile selection and timeout-only configuration below. A5 mounts the converted public workflows and denies the remaining unsupported operations.

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
See [the bounded contract](authentication-reference.md#human-literal-profiles-and-preset-timeouts-p2c).

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
and uses prepared statements. It creates a fresh database at the supported
schema. An existing database must already be current: an ordinary opening never
migrates it (see [Ordinary admission](#ordinary-admission)), and the numbered
migrations run only in explicit offline maintenance (`auth fence establish` and
`resume`, `upgrade apply`). All schema steps share one immediate transaction with foreign keys
off and a foreign-key check before commit. A caller may add data acts to that
transaction after the steps and before validation. SQLite cannot enable foreign
keys inside a transaction, so no ON DELETE action runs for the acts: an act
deletes or updates every dependent row its statements would leave without a
parent. Nothing is repaired for it. Any violation left after the acts fails the
check before commit and rolls back the steps and the acts. Acts start only from
a database without a violation.

A state-directory lock prevents two controller instances with the same runtime
configuration from owning the process set. Stored PIDs are hints
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
and maintenance copies (`pre-migration-`, `pre-establishment-` and
`pre-upgrade-v<n>-<UUID>`). The configured count governs scheduled copies, not
all catalog entries. Maintenance copies are always protected and never
retention candidates, even when a ledger record names one; the operator removes
them. A failed preflight never deletes old recovery points or relaxes the
budget. A successful standalone maintenance copy does not prove
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
current captured token ID. Old format-1 handoffs use their historical policy mode.
P3b requires protected quarantine before the next boot: captured policy/token
remain evidence, resumed mode is explicit, and a durable receipt follows handoff
acknowledgement. Malformed records fail closed; A5 transport/cutover acceptance
remains open.

New databases default to `token` and cannot
start until a token has been generated. Existing databases migrate to `legacy`;
`open` is explicit and `better-auth` requires the configured optional provider. Installation
tokens are stored as verifiers, and rotation invalidates active sessions.
Local administration uses an owner-only Unix socket while running or the
singleton lock while stopped. Scoped knowledge credentials keep their grants;
they do not expose runtime claim/configuration tools.

See [authentication modes](authentication.md) for commands and migration.
Knowledge CLI, identity administration and logical import/export now apply
the active policy when no token variable is present, including open mode.

The first A3 slice adds a versioned server-only provider contract and explicit
local loader, exercised by a private Better Auth workspace proof. Startup
loads it only for an active RBAC boot after validated readiness. Protected CLI
maintenance shares that same lazy lifetime. Controller
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
[browser contract](authentication-reference.md#bounded-browser-adapter).

The isolated adapter also serves
[closed factor routes](authentication-reference.md#closed-factor-http-api). The runtime dispatches
a closed operation table and returns an opaque release plus a separate settlement
promise, so a response slot outlives a timed-out borrow until its callback really ends.
A final check against current rows, the durable publication marker and header emission form one synchronous
admitted phase. Accepted cleanup uses reserved queue room on the same gate, with no new
lock, counter or connection.

Current isolated provider API is contract 5, storage revision 3, implementation
`0.0.0-proof.5` and core schema 49. Earlier versions evolved as follows.
Provider API contract 2 requires durable `signOut`; version 1 fails compatibility
checks. Contract 3 adds the application-owned `host.protection` port: the provider
calls it synchronously inside its open transaction, and `AccountProtection` keeps
policy, transitions and the current-authority rule in the controller. Disposal tracks actual provider settlement and closes only its borrowed facade.
The runtime also owns cleanup of sessions it minted but never released, as bounded
in-memory ID records tied to the exclusive borrow. Issuers are refused before minting
at the bound. Schema 41 keeps session issuance durable: each new session commits with a
`pending` marker, `may_publish` commits before any cookie leaves, and the owner's one
ordinary-restart recovery removes `pending` rows before an issuer can load. Installation-wide
row and batch bounds are required inputs. An unacknowledged restore refuses that recovery before store opening; a protected quarantine receipt permits subsequent boot recovery. See
[durable issuance](authentication-reference.md#closed-factor-http-api).
The owning shutdown helper disposes the optional provider after external
producers/listeners/accepted responses drain and before service/SQLite close.
A rejected disposal reports unconfirmed cleanup and retains both owner locks;
concurrent calls share completion or failure. Partial-load disposal failure is
also reported honestly. Raw library logs/router errors are replaced with fixed
events, including errors that the native router would otherwise print directly.
Local provider modules are trusted code, not sandboxed plugins. See the
[proof contract and limitations](authentication-reference.md#optional-provider-proof-first-a3-slice).

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
[implemented API](authentication-reference.md#provider-authorization-handoff).
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
worktree-control auth fence inspect
worktree-control auth fence establish --expect <preflight> --backup-dir <dir>
worktree-control auth fence resume --expect <preflight> --mode open|token|better-auth
worktree-control upgrade inspect [--decisions <file>]
worktree-control upgrade apply --expect <plan hash> --backup-dir <dir>
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
Account mode issues no CLI credential, so project commands and `doctor` use the
controller's owner-only admin socket. Its handler validates input like the HTTP
route, runs under database admission and publishes the same dashboard events.
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
P3b now requires an external checkpoint and protected quarantine receipt before restored provider loading. Public account activation and A5 transport enforcement remain separate gates.

### External restore checkpoint and protected resume (P3b)

Migration49 adds a fixed SQLite checkpoint and authority-table triggers, preserving
migrations1..48. The sole core/provider connection publishes a private external
pending witness from the BEFORE-trigger observer before authority rows change,
and a confirmed witness after FULL SQLite COMMIT.
Normal confirmed restarts preserve current rights. Supported restore and raw
DB-only rollback fail closed before provider/listeners, including older schemas.
The bounded witness binds the canonical database path and installation outside
the application backup payload; custom state-directory nesting does not change
that boundary. Whole-host rollback including the witness is outside this local
OS-owner trust model.

Protected offline `auth fence inspect/establish/resume` uses both singleton locks
and an exact preflight. Resume quarantines restored credentials, sessions, factors,
passwords, grants, leases and pending work as data acts of the schema
transaction, so pending schema steps and the quarantine commit together. It
preserves the same owner and history, then acknowledges the existing handoff and publishes a durable receipt. No public
session or token can perform it. Captured mode/token policy remains historical
evidence; resumed mode is explicit, and old verifiers stay invalid. Schedules and
vault use an additional receipt floor while retaining their separate signed proof.
See [operator flow and crash protocol](authentication.md#external-security-fence-and-protected-resume-p3b).
A5 implements validated account selection/public mounting, explicit agent diagnostics
and the transport deny inventory. Independent review and verified live/client
migration remain release gates. The five historical factor negatives remain visible.

### Upgrade marker, schema step 50 (integration branch only)

This section describes `integration/auth-unification`, not a release. Steps 50
to 52 are applied by default but may still change until the release candidate;
a database an unreleased build migrated is disposable.

`SUPPORTED_SCHEMA_VERSION` is 52: what this release creates, its default schema
target and recognition ceiling, and the highest step it knows.
`initializeSchema`, `inspectSchema`, the owned database, offline fence
maintenance, the quarantine, the upgrade and backup manifest validation take an
optional target or ceiling that defaults to it. Each target and ceiling passes
through `schemaTarget`, which accepts 49 to 52 and refuses 53 and above,
whichever alias, re-export or wrapper passes the value. The provisional switch
of earlier integration builds is gone. Explicit lower targets (49, 50, 51)
remain for the steps themselves and for versioned test fixtures and snapshots.

`schemaTarget` also refuses any value below `SECURITY_FENCE_SCHEMA_VERSION`
(49, the schema the security fence was introduced at). That constant does not
move: it is the lowest explicit target or ceiling and the lowest source of the
explicit upgrade's structural steps.

The guard test `schema-entry-points.test.ts` (it replaced
`provisional-schema.test.ts`) checks module imports and openings in every
non-test script file under `src/`, fixtures included. It confines imports of the
step modules to listed importer and module pairs: no non-test file imports the
project directory of step 51, the authority reset is imported only by the
quarantine and the authority acts, the recovery's predictor only by the
authority acts, and the exact-text check only by the predictor and both act
domains. The text `account_grants` appears only in step 52's module, the
authority acts, the schema recognition and a test fixture, so no mounted code
reads the new grants. It confines the mounted entry points to their places (see
[Ordinary admission](#ordinary-admission)) and classifies every opening of the
database. It recognises static imports (type-only and side-effect imports
included), `export ... from`, `import x = require()`, `import()` types, and
`import()` or `require()` calls with a literal specifier, resolved to a file.
It does not cover non-literal specifiers, files outside `src/`, test files, or
files that are not scripts. Non-literal specifiers under `src` fail the
separate unmounted guard of the operations contract, outside its own
allow-list.

Step 50 adds the single-row `upgrade_marker` table: state `pending` or
`complete`, the time of its last change, and `plan_hash`, the hash of the
upgrade plan whose apply set it to `complete`. The upgrade marker is separate
from the schema version. A database initialised from empty starts `complete`
without a plan hash. A database migrated from an earlier schema starts
`pending`, and resume sets it to `pending` again inside its quarantine and
clears the plan hash. Both have the same structure. Whoever can set the marker
to `complete` skips the data upgrade, so the step adds the three fence triggers
of step 49 for this table. That coverage is a separate list by version; the
schema-49 list is unchanged. The step writes its row before those triggers
exist and writes no fenced table, so it can run in the creation of a fresh
database before the fence attaches.

The plan hash is 64 lowercase hexadecimal characters, enforced by the table and
by validation at 50. SQLite's text `length` and `GLOB` stop at the first NUL
character, so the table's check also requires 64 bytes; without it, 64 hex
characters followed by a NUL and a suffix would pass the table and fail
validation. Then: `pending` has none, and `complete` has one unless it is
the `complete` of a fresh installation. A fresh and an applied `complete` are
told apart only by that null, and nothing else needs to tell them apart: only
the upgrade writes a hash, and a fresh installation never needed a plan. The
explicit upgrade below is the only writer of `complete` after initialisation.

Inspection at ceiling 50 compares the stored `CREATE` text of the marker table
and of its three triggers with the text the step executes, byte for byte.
SQLite stores that text unchanged, and the comparison keeps the case and spacing
inside string literals. Recognition of schema 49 and earlier, including the
schema-49 triggers, is unchanged.

### Project mapping structure, schema step 51 (integration branch only)

This section describes `integration/auth-unification`, not a release. Step 51 is
applied by the default target and by an explicit target of 51 or more, and may
still change until the release candidate. A step-51 database is refused like any
unknown newer schema at ceilings 49 and 50.

In the project mapping, `knowledge_projects` is the project (a `ProjectId`),
`projects` is the registration of a repository on this machine (a
`RegistrationId`), and `remote_project_identities` is a project as remote
workers know it. Step 51 adds structure only: it creates no project, sets no
parent, stamps no existing row and writes no journal row. Every data decision is
an act of an operator-approved upgrade plan (see "Project mapping acts" below).

The step adds these parts, in `mapping-structure-migration.ts`:

- `project_mapping_clock`, a single-row table with the installation-wide mapping
  clock: an integer from 0 to 9007199254740991 (`Number.MAX_SAFE_INTEGER`). The
  step writes its row, with 0, before the table's triggers exist.
- Three columns on `projects` and on `remote_project_identities`:
  `parent_project_id` (nullable, a foreign key to `knowledge_projects(id)`),
  `incarnation` and `mapping_version` (integers, `NOT NULL DEFAULT 0`, bounded by
  a `CHECK`). A row without a parent is valid (parentless). Rows that exist when
  the step runs keep 0 in both stamps until an act or the quarantine stamps them.
- `project_mapping_journal`, the append-only decision journal of the later
  acts. It records the subject (a registration or a remote identity, its ID and
  incarnation), the project, the basis (`created_project`, `accepted_link` for
  a registration, `accepted_binding` for a remote identity, or
  `journal_reuse`), the plan hash, the run receipt and the time. It has no
  foreign keys, because the history outlives a removed registration.
- The three fence triggers of step 49 for the clock and the journal, in a
  coverage entry for step 51, and a separate list of the step's other triggers.

Every stamp is a value the clock has issued: a writer advances the clock, then
uses its value. A stamp need not be freshly issued. A mapping version may be set
to the clock's current value, which other rows may already carry (the quarantine
gives every row the same one), and an unstamped row may take any issued value as
its incarnation that no other row of its table holds. `incarnation` is the value
issued when the row was created, or the value it was stamped with if it predates
the step, and never changes after it is stamped. Non-zero incarnations are
unique within each table. `mapping_version` is the value of the row's creation
or of its last mapping change (a parent set or cleared). The step's triggers
enforce this:

- An `INSERT` that brings a stamp of its own is refused. After every other
  `INSERT`, a trigger advances the clock and stamps both columns of the new row.
  So the existing writers (`project add` and remote provisioning), which do not
  know these columns, still get a fresh incarnation. Each row of a multi-row
  `INSERT` gets its own advance. A row deleted and created again with the same
  ID gets a new, larger one, including through `INSERT OR REPLACE` on any unique
  key, whatever `recursive_triggers` says. The insert's own `changes` and
  `lastInsertRowid` are unaffected. The trigger checks that its stamp landed.
  Through the file's own schema that check cannot fail; a connection's `TEMP`
  trigger, which the file does not hold, can skip or undo the stamp, and then
  the insert fails.
- An incarnation changes only from 0 to a value the clock has issued, with a
  mapping version no smaller than it, and only to a value no other row of the
  table holds. A row's trigger sees the rows its statement has already changed,
  so one `UPDATE` that gives several rows the same value fails as a whole. A
  unique index would not do this: under `UPDATE OR REPLACE` it would delete the
  row that holds the value.
- A changed mapping version must be larger than before and equal to the
  clock's current value. A changed parent needs a larger mapping version. An
  update of any other column leaves both stamps alone.
- The clock only advances, and its row is neither replaced nor deleted.
- The journal refuses `UPDATE`, `DELETE` and an `INSERT` with an explicit
  sequence that is not above every existing one. This refuses every replacing
  form (`INSERT OR REPLACE`, `REPLACE INTO`, an upsert), whatever
  `recursive_triggers` says, and an insert into an earlier gap, so sequence
  order is append order. The later acts read a subject's latest record by the
  largest sequence. An omitted sequence is issued by `AUTOINCREMENT`, which
  never issues one at or below the largest existing sequence.
- A journal `INSERT` must name an incarnation the clock has issued: at most the
  clock's current value, and none while the clock row is missing.
- The journal's time is canonical UTC with milliseconds and a real instant: the
  value must equal the formatting of its own Julian day. Formatting the value
  directly is not enough, because SQLite's parser accepts hour 24 and prints it
  back; the Julian day turns it into the next day. Every `toISOString` value
  from year 0 to 9999 passes.

Every refusal is `RAISE(ABORT)`. Inside a trigger, SQLite applies the conflict
algorithm of the statement that fired it, so without these refusals an
`INSERT OR IGNORE` at an exhausted clock would skip the clock update and reuse
the last stamp. At the maximum the insert fails; the clock never wraps.

The structure guards against defects in the application, not against a raw
rewrite of the file, a dropped trigger, a `TEMP` trigger, or a restore. An
`INSERT` into the journal with an explicit sequence above the last one is still
possible: it leaves a gap, and later sequences continue above it. A write to
`sqlite_sequence` is not refused either. Raising it leaves a gap. Lowering it
changes nothing, because `AUTOINCREMENT` also stays above the largest existing
sequence. The journal sequence orders records; it is not a version, and a
restore rewinds it like everything else.

The step writes only DDL against tables that are already fenced, its own clock
row before the clock's triggers exist, and `schema_migrations`. So it can run in
ordinary startup before the fence attaches. Afterwards, every write to the
clock, the journal and the new columns reaches the fence.

Recognition at ceiling 51 compares the two new tables, their indexes and every
new trigger byte for byte, as for step 50. The expected trigger set is still a
function of the version: fence coverage and the step's other triggers, and
nothing else. The new columns on the two older tables are recognised exactly.
Their table's text was shaped by earlier, released steps, so it keeps the
released comparison. From 51 on, that text must end with exactly the text the
step appended: the three definitions with their `CHECK` and foreign key. A
column that a step from 50 on adds to an older table must also carry the
reference's default, which the released comparison does not compare. It must
not exist before its version, which the released rule requires only of tables
from step 38 on. Older columns and tables are recognised as before.

Validation at 51 requires the following:

- The clock row exists once and holds a safe integer of at least 0.
- Every stamp is a safe integer from 0 to the clock. The mapping version is no
  smaller than the incarnation, both stamps are 0 or both are greater than 0,
  and only a stamped row has a parent.
- No two rows of one table share a non-zero incarnation.
- Every parent names an existing project, as the foreign-key check also
  requires.
- Every journal row has typed and bounded fields: lowercase hexadecimal plan
  hash and lowercase UUID receipt, both length-checked in bytes, a canonical
  time that is a real instant (the same Julian-day rule as the table), a legal
  kind and basis, an incarnation from 1 to the clock, and a sequence within
  `sqlite_sequence`.

Step 50's validation of the marker's `changed_at` had the same weakness: it
accepted hour 24. It now uses the same Julian-day rule. Step 50's table and
checksum are unchanged; its column has no `CHECK`, so validation is the only
rule.

`auth fence resume` at target 51 clears the mapping in its one schema and
quarantine transaction. It advances the clock, clears every parent, and sets
every mapping version to the clock's new value. A row that is still unstamped
gets an incarnation of its own, from the old clock value plus one upward. The
clock advances by the number of such rows, or by one when there are none. Issued
incarnations, `knowledge_projects` and the journal stay as they are, and the
quarantine writes no journal row. A clock that cannot advance (missing,
malformed, behind a stamp, or at its maximum) refuses with
`security_fence_recovery_required` and rolls back everything, schema steps
included. At the default target and at 50 the quarantine runs exactly the
statements it ran before. The explicit offline upgrade lists step 51 among its
structural steps, and at target 51 its plan carries the project mapping acts.

The step's operations check their step against the supported version before
they touch a database: the migration, the validation rule, the quarantine's
plan and its statements. The directory's constructor checks it too. Its constants (statement text,
trigger lists and checksum) are data and are not gated: the coverage lists and
the upgrade's step list read them when their modules load.

`project-directory-queries.ts` is a typed, read-only project directory. Nothing
mounts it and no non-test file imports it (`schema-entry-points.test.ts`
enforces that). It looks up a
registration, a remote identity and a project by ID, and the registrations and
remote identities of a project. It returns storage facts only: the parent
project or null and both stamps, with unstamped rows returned as 0. Each lookup
reads its own table and never falls back to another. Its branded ID types are
declared locally while the operations contract is unmounted, because the
unmounted guard refuses every import of `src/shared/contracts/operations.ts`.

The stamps have limits. `mapping_version` is a bounded change stamp, and not by
itself the `version` of a `ResolvedResource`. A later adapter composes that
version and must also account for relation changes. Incarnations are unique
per table, and clock values increase, only within one linear history of the
database. A restore of an
older database rewinds the clock, which may then issue values it issued before.
The recovery boundary is the quarantine, which re-stamps every row. So anything
that keeps a version across requests must be emptied or invalidated by the
quarantine. That is an obligation of the change that adds such a store.

### Grants storage, schema step 52 (integration branch only)

This section describes `integration/auth-unification`, not a release. Step 52 is
the supported version: applied by default and by an explicit target of 52, and
it may still change until the release candidate. A step-52 database is refused
like any unknown newer schema at ceilings 49 to 51.

Step 52 adds the table `account_grants`: one row per stored role assignment of
the authorization contract (`StoredGrant`). A row names an account
(`remote_principals.id`), one of the six roles, a scope kind (`project` or
`installation`), the Knowledge project when the scope is a project, and the time
it was granted. There is no expiry column: a grant holds until it is deleted,
and revocation is deletion. The step carries structure only and writes no
grant; only the upgrade's authority acts write one (below). Nothing outside
the SQLite adapter directory reads the table yet; the adapter that reads grants
comes with a later change.

The table enforces:

- a known role, and the scope kind the contract's role table gives it: `admin`
  on the installation, every other role on a project. The roles and scopes are
  a literal list in the step, because production code must not import the
  unmounted contract. A test parses the contract's source and fails if the
  list or the table's `CHECK` disagree with it;
- a project exactly when the scope is a project, and both foreign keys;
- typed, bounded IDs (text of 1 to 640 bytes, at most 160 characters, no NUL)
  and a `granted_at` that is canonical UTC with milliseconds and a real
  instant, by the Julian-day rule of the step-51 journal;
- at most one row per account, role and scope. A `UNIQUE` constraint over the
  four columns would accept a second installation grant, because SQLite treats
  NULLs as distinct in a unique key. The unique index
  `account_grants_key` therefore indexes `ifnull(project_id,'')`, which is
  never a project ID;
- immutable rows. A trigger refuses every `UPDATE`. Another refuses an `INSERT`
  of a grant that exists before any conflict resolution, so `INSERT OR
  REPLACE`, `REPLACE INTO` and an upsert cannot replace a stored grant with a
  new `granted_at`, and `INSERT OR IGNORE` reports the duplicate. It also
  refuses an `INSERT` that names the rowid of an existing row, and
  `CHECK(rowid>0)` keeps an explicit rowid away from the -1 the trigger reads
  for an omitted one. This holds whatever `recursive_triggers` says. `DELETE`
  is allowed.

The table does not enforce who may hold a role (`maintainer` and `admin` only
humans, `executor` only agents), and validation does not either. The contract
re-validates every stored grant against the account's stored kind on every
evaluation, so an inconsistent row refuses only itself instead of making the
installation unstartable. Validation at 52 checks the table's shape rules
again: role, scope consistency, project presence, typed IDs, canonical time
and no duplicate; an existing account and project are the foreign-key check's.
SQLite's `integrity_check`, which validation runs first, already refuses a row
that breaks a `CHECK`, so the shape rule is defence in depth; the duplicate rule
is the only one no `CHECK` states.

The table has the three fence triggers of step 49, in a coverage entry for step
52, and its two guard triggers in the list of the step's other triggers, so the
expected triggers stay a function of the schema version. Recognition at ceiling
52 compares the table's, its two indexes' and its five triggers' `CREATE` text
byte for byte, with the step's name and checksum. The step is DDL only and
writes no fenced row, so it is safe in the creation of a fresh database before
the fence attaches. Its operations check the step against the supported version.

`auth fence resume` at target 52 also deletes every grant in its one
transaction, so no grant written after an upgrade survives a quarantine; the
next upgrade grants `admin` again when its rule holds. Below 52 the quarantine
issues the statements it issued before, in the same order and with the same
bindings. Its test-run recovery now reads its input in a read-only preparation
before it writes (see "Authority acts" below), and the recovery's writes are
unchanged.

### Explicit offline upgrade (integration branch only)

This section describes `integration/auth-unification`, not a release. The
machinery is in `upgrade-plan.ts` and `upgrade-maintenance.ts` under
`src/server/infrastructure/sqlite/`. It is mounted as the offline commands
`upgrade inspect [--decisions <file>]` and `upgrade apply --expect <plan hash>
--backup-dir <dir>` (see [Composition and commands](#composition-and-commands)).
Every entry point needs a schema target of at least 50 and at most the
supported 52, and refuses others as unsupported before any lock or file. A
format-2 witness once written is read, verified and carried forward by ordinary
fenced writes. The project mapping acts and the authority acts are described
below.

An installation's database is in one of four states. The fence decides trust
exactly as `SecurityFence.preflight` does. A confirmed witness that carries an
earlier recovery receipt is trusted like any other confirmed witness. The state
depends on the target. A completed step-50 database is current at target 50
but needs the upgrade at target 51: inspect plans step 51 only, and apply runs it
and records the new plan hash in the marker. A database above the target is not
in any state: ownership's schema ceiling is the target, and it refuses a newer
schema as unrecognised before the state is read.

| State | Recognised by | Operator's next step |
| --- | --- | --- |
| Current | trusted fence, marker `complete`, schema at the target | nothing |
| Upgrade needed | trusted fence, and marker absent (schema 49), marker `pending`, or schema below the target | `upgrade inspect`, then `upgrade apply --expect <plan hash> --backup-dir <dir>` |
| Pre-fence | no fence, establishment allowed | `auth fence establish --backup-dir <dir>`, then upgrade |
| Fenced | anything else: a pending, mismatched or missing witness on fenced data, or an unacknowledged restore | `auth fence resume`, then upgrade |

Both commands take both singleton locks as the fence maintenance does, but take
database ownership inspection-only: an unfinished restore (a restore journal
that is not `verified`) is refused before SQLite opens, never recovered, and no
file mode is normalised. The refusal is `upgrade_restore_unfinished` in state
"fenced" with the next step `auth fence inspect`. That command's ordinary
ownership completes the interrupted restore and reports the preflight for the
resume that a restored database then needs.

`upgrade inspect` writes neither the database nor the witness. Its read-only
SQLite connection may still create an empty WAL and a shared-memory index
beside a database that has none; an empty WAL holds no frames, and the
preflight is computed while that connection is open. Only in "upgrade needed"
it writes one plan, replacing any earlier one, and returns it with its hash. In
every other state it writes nothing and reports the next step. The plan holds:

- `kind` (`worktree-control/upgrade-plan`) and `format` (2; a format-1 plan is
  refused as malformed);
- `binding`, the fence's binding of the canonical database path, and
  `installation` from `security_checkpoint`, so a plan cannot be applied to
  another database;
- `base`, the preflight hash over the database, its WAL and the witness;
- `source` and `target` schema versions;
- `steps`, the version, name and checksum of every structural step apply runs;
- `decisions`, the operator's normalised decisions, by act domain;
- `acts`, the ordered data acts;
- `review`, what the operator approves, by act domain.

The plan hash is the SHA-256 of the plan's canonical JSON: keys sorted by
UTF-16 code units, no whitespace, and only strings, safe integers, booleans,
null, arrays and plain objects. It carries no timestamp, and new project IDs are
reused from an equal earlier plan, so two inspects of an unchanged database with
the same decisions give the same hash. At target 50 no act domain applies:
`decisions`, `acts` and `review` are empty, and a plan with any act or decision
is refused as malformed. The hash covers every field.

The plan file is `plan.json` in the private directory `<database>.upgrade`,
beside the database and outside the fence's `.security` directory. It is written
with the durable private-storage helpers and read with mode, ownership and
alias checks, without following links. It is parsed strictly, with no duplicate
keys, and its envelope hash must match the canonical payload. The bound is
8 MiB and 50 000 acts, the same as the backup manifest. Later project mappings
and role decisions are one act of a few hundred bytes per registration or grant.
Inspect reaps a bounded batch of leftover temporaries from an interrupted write
and refuses links and unknown entries.

`upgrade apply --expect <plan hash>` runs in this order:

1. Take both locks, with inspection-only ownership.
2. Require "upgrade needed". When the state is "current" (so the schema is at
   this run's target) and the marker records the same plan hash, answer
   "already applied" and change nothing. An earlier plan for a lower target is
   not already applied at a higher one: it is not the plan inspect wrote there. Refuse
   every other state with its next step.
3. Check owner continuity.
4. Read the plan. Refuse it when it is missing or malformed, when its hash
   differs from `--expect`, when its binding names another database, when its
   base differs from the current preflight, or when its steps differ from the
   code's. Then recompute the proposal read-only at the source and refuse a plan
   whose decisions, acts or review differ from it (`upgrade_plan_unproposed`).
5. Write the backup through an injected function and accept it only as this
   run's copy of this source. The function receives a Backup API source that
   takes exactly one snapshot, through the read-only connection, and records
   the device and inode of the file written once the copy completes.
   `createControllerBackup` switches that file's journal mode in place and
   renames its staging directory to the destination, so the file keeps its
   identity but not its path or bytes. The returned tree is accepted only when
   the snapshot completed before the function returned, the tree's database
   file has that identity, its manifest is its own, the tree validates at the
   target ceiling, and the copy's schema version and checkpoint (installation
   and epoch) equal the live source's. A tree of another database, an older
   tree of this one, a tree made without the provided snapshot or after a
   second snapshot, and this run's file overwritten in place with an older
   state are all refused as `upgrade_backup_failed`.
6. Take the source image (the bytes of the database and its WAL) and then the
   preflight, which must equal the base again. The Backup API writes neither
   file through the read-only connection; a probe confirmed this for an empty
   WAL and for a WAL left by a crashed writer.
7. Publish a pending witness with the upgrade receipt. When the publication
   fails, the fence decides the outcome, not the point of failure: the witness
   and the source are read again under the locks still held. A trusted fence
   whose preflight still equals the base means the witness was not replaced,
   and the result is `upgrade_witness_unchanged` (not committed, state "upgrade
   needed", next step `upgrade apply`). Anything else, including a witness
   renamed into place before a failed directory sync, is uncertain.
8. Switch to writing, which only this point does. Under the locks, require
   again that no restore other than a verified one exists (and synchronise a
   verified journal's directories, which is all recovery does for it), and
   normalise the modes of the database and its sidecars as ordinary ownership
   would have. Then close the read-only connection and open the pathname
   again: first a read-only guard connection, which holds an open read
   transaction and so SQLite's shared lock on its file, then the writable
   connection. The pathname must name the same file before the guard opens and
   after the writable open, and before the durability settings, the observer
   or any write the reopened database must be the inspected one. Its file
   identity, checkpoint, policy, owner and restore must equal the pending
   witness's copy of the trusted record, and its source image must equal step
   6's. A mismatch leaves the pending witness and is `upgrade_source_changed`
   (not committed, state "fenced", next step `auth fence resume`).

   No refusal writes the file it refused, nor the inspected file wherever it
   was moved. Probes of better-sqlite3 13.0.3 (SQLite 3.53.4) on WAL databases
   whose WAL held uncheckpointed frames showed what that rests on. Opening a
   writable connection executes nothing, and closing it without having
   executed anything changes no file. Opening, reading and setting the
   durability pragmas change neither the database nor its WAL. A writable
   connection that has read checkpoints the WAL into its file and deletes the
   WAL when it closes, unless another connection in the process holds a shared
   lock on the same file, or the file no longer sits at the pathname (SQLite
   checks this itself). In rollback-journal mode, its first read rolls back a
   hot journal into the file unless such a lock is held. A read-only
   connection never checkpoints, truncates or rolls back. So the writable
   connection executes nothing until the file identity matched, and a refusal
   before that closes it without effect, whichever file it opened. When the
   verification refuses, the guard holds the lock on its file, and before the
   writable connection closes, read-only connections are opened on whatever
   the pathname names then, until one has read while the pathname named the
   same file throughout. They stay open across the close.

   The checks cannot detect a change that is undone before they run, a swap of
   files around the identity check that is swapped back, or a raw write made
   after them, while the transaction runs. Without access to SQLite's file
   descriptors, one case remains unprotected. After the pathname was swapped
   and swapped back around the identity check, the writable connection may
   have read a file other than the guard's. If the pathname names that file
   when the connection closes and no reader holds it, the close checkpoints
   into it. That needs the pathname to have named another file during each
   reader's open and read, or no reader to be able to read the file there (it
   was overwritten in place, or a hot journal was planted beside it). The
   refused file may keep an empty WAL and a shared-memory index.
9. In one schema transaction, run the structural steps, the proposal
   recomputed at the target (a difference aborts), the plan's acts in
   order, the marker update to `complete` with the plan hash, and last an
   `authentication.upgrade_applied` audit event. That event carries the receipt
   and the plan hash and is this run's commit evidence.
10. Validate at the target, publish the pending and then the confirmed witness,
    and delete the plan file. `upgradeReceipt` confirms only the database the
    pending witness was published for: the epoch changes in the transaction,
    the installation and the file identity do not.

| Failure point | Database | Witness | Operator's next step |
| --- | --- | --- | --- |
| An unfinished restore (step 1, or inspect) | unchanged | unchanged | `auth fence inspect`, which completes the restore, then resume |
| Before the pending witness (steps 1–6) | unchanged | unchanged | apply again with the same plan |
| Publication failed, witness not replaced | unchanged | unchanged | apply again with the same plan |
| Publication failed after the rename | unchanged | pending | `auth fence resume` at the target, then inspect and apply |
| The reopened database is not the inspected one | not written | pending | `auth fence resume` at the target, then inspect and apply |
| After the pending witness, before the commit | unchanged | pending | `auth fence resume` at the target, then inspect and apply |
| After the commit, before the confirmed witness | upgraded | pending | reported as committed; resume sets the marker to `pending`, then inspect and apply |
| Confirmed witness not durable (publication falls back to pending) | upgraded | pending | as the previous row |
| Success not seen | upgraded | confirmed | apply with the same `--expect` answers "already applied" |
| Success, removing the plan file failed | upgraded | confirmed | none; the result says `planRemoved: false`, and the left plan names a plan already applied |

When the plan file cannot be removed after the confirmed witness, apply still
succeeds and reports `planRemoved: false`. The upgrade is complete; the file is
inert, because a later apply with its hash answers "already applied" (with
`planRemoved: false` while the file remains) and any other hash is refused in
"current". The next successful inspect in "upgrade needed" replaces it.

Errors are `UpgradeError` values with a code, the next step, and `committed`
only when this run's transaction is proven committed by a raised schema
version or its audit event. The codes are `upgrade_unsupported`,
`upgrade_invalid_input`, `upgrade_owner_running`, `upgrade_wrong_state` (with
the state), `upgrade_owner_changed`, `upgrade_plan_missing`,
`upgrade_plan_invalid`, `upgrade_plan_foreign`, `upgrade_plan_mismatch`,
`upgrade_base_changed`, `upgrade_step_mismatch`, `upgrade_plan_storage`,
`upgrade_backup_failed`, `upgrade_restore_unfinished`,
`upgrade_witness_unchanged`, `upgrade_source_changed` and
`upgrade_outcome_uncertain`, and for the project mapping
`upgrade_decisions_invalid`, `upgrade_plan_unproposed`, `upgrade_plan_bounds`
and the stops listed below. Messages carry no secrets, paths or file contents;
a refusal about rows names them in its `details` (IDs only, bounded).

The contract also defines `upgrade_required` (next step `upgrade inspect`,
state "upgrade needed"). Only the ordinary admission check raises it, at every
ordinary opening of the store; see [Ordinary admission](#ordinary-admission).

The witness gains format 2: format 1 plus a required `upgrade` field (receipt,
plan hash and start time). Apply writes it, and ordinary fenced writes carry it
forward. Establish and resume write format 1 without it. A record without an
upgrade stays format 1 byte for byte, so existing witnesses decode, verify their
hash and compare as before. A binary that knows only format 1 refuses a format-2
record as recovery required instead of misreading it. An upgrade never writes
`receipt` or `recoveredAt`. They keep the last establish or resume, and
`securityRecoveryBoundary` returns the same value before and after an upgrade.

#### Composition and commands

`src/server/bootstrap/upgrade-maintenance.ts` composes the SQLite functions:
`inspectUpgrade(paths, decisions?, target?)` and
`applyUpgrade(paths, { expect }, { directory, applicationVersion }, target?)`.
The pre-upgrade backup of step 5 is the real `createControllerBackup`, writing
into `<directory>/pre-upgrade-v<source schema>-<UUID>` with the installation's
Knowledge attachments, beside the existing `pre-migration-v…` convention.
`src/server/bootstrap/maintenance-backup.ts` holds this one backup
composition, which establishment with a backup shares. The run's target is
the backup's schema ceiling (`createControllerBackup`'s optional
`schemaCeiling`), so a source above the supported schema, such as a step-52
database whose marker a resume set to `pending`, can be backed up. Without
the option every backup keeps the supported ceiling. Omitted, `target` is the
supported schema, where the upgrade refuses as unsupported.

`src/cli/upgrade.ts` holds the runner of the `upgrade inspect [--decisions
<file>]` and `upgrade apply --expect <plan hash> --backup-dir <dir>` commands,
with `upgradeErrorBody`, which maps a thrown error to a JSON body without
library text, paths or input values. The CLI entry registers it before the
generic start parsing (which would otherwise reject `--backup-dir`), passes the
arguments starting with `upgrade` and the package version, and prints
`upgradeErrorBody` on stderr with exit code 1 on failure. The commands run
offline only and do not pass the ordinary admission check: they are how a
database becomes current. The decisions file is read before any lock: a regular
file (no symbolic link), at most 8 MiB (the plan's own bound), UTF-8 JSON without
duplicate keys, with the mapping keys `links`, `bindings` and `isolate`;
anything else is `upgrade_invalid_input`. Inspect prints the status, the plan
hash, the normalised decisions, the operator's lines and the review, never the
plan itself. Only the runner imports the composition (and a test fixture), and
only the CLI entry imports the runner (`schema-entry-points.test.ts`).

### Ordinary admission

This section describes `integration/auth-unification`, not a release. Every
ordinary opening of the store admits only a current database. The check is
`assertOrdinaryAdmission` (`ordinary-admission.ts`). Its one caller is the
constructor of `OwnedSqliteDatabase` opened with `ordinary: true`, after
ownership inspected the database read-only (schema recognised at the ceiling,
`validateDatabase` at its version) and before the constructor returns, so
before anything can enable writes, migrate, attach the fence or copy the
database. `SqliteStateStore` opens its own owner that way and refuses any owner
that was not admitted. A refusal closes the read-only connection and releases
the lock.

The check reads, in this order:

1. The fence, by `SecurityFence.inspect`. Its refusals
   (`security_fence_establishment_required`, `security_fence_recovery_required`)
   win: a rolled-back, restored or pending database goes to recovery, never to
   the upgrade. A fresh, initialising database the fence accepts is admitted.
2. The schema version must equal the target (the supported 52) and the upgrade
   marker must be `complete`; otherwise `UpgradeError("upgrade_required",
   "upgrade inspect", false, "upgrade_needed")`. A schema-52 database without a
   marker row is corrupt and gets `validateDatabase`'s refusal, which ownership
   gave already.

Ordinary openings (application access) and maintenance openings (which must
keep working on a database that needs the upgrade):

| Opening | Class |
| --- | --- |
| Controller start (`openControllerStore`), service install's pre-bootstrap (`openCurrentControllerStore`) | ordinary |
| Offline `auth` status, token and mode; `auth provider`; `identity`; `knowledge execute-import`; `project` and `doctor`; `config mcp`; `remote-verification` provision, revoke-token and reconcile; `backup export-project` and `import-project`; the sandbox (fresh) | ordinary, through `SqliteStateStore` |
| `remote-verification inspect` (`openRemoteRecoveryInspection`) | ordinary, inspection-only owner |
| `auth fence inspect`, `establish`, `resume` | maintenance |
| `upgrade inspect`, `apply` | maintenance |
| Offline `backup create`, snapshot verification, restore and restore staging, remote rebind | maintenance |

`schema-entry-points.test.ts` lists every construction of `SqliteStateStore`
and `OwnedSqliteDatabase`, every direct `better-sqlite3` open and every call of
`acquireDatabaseOwnership` under `src/` with this classification, and fails on a
new or changed one until it is classified. Production stores never receive an
owner from outside; only test fixtures open an owner at an explicit lower
target for the store (`openStoreAt` in `fixtures/released-schema.ts`).

An existing database is never migrated at an ordinary opening. An admitted
one is at its target with a complete marker, so the store's schema transaction
applies no step to it: every recorded step returns at once, and only the
bootstrap's idempotent statements run (`CREATE TABLE` and `CREATE INDEX` with
`IF NOT EXISTS`, and `INSERT OR IGNORE` of migration 1). They write no row a
fence trigger covers and need no fence function, and they restore a bootstrap
index a current database lost, such as the partial unique index
`test_runs_actor_idempotency`, which neither schema recognition nor
`validateDatabase` requires. A fresh database is created at its target with the
marker `complete`; the creation's initialization marker is removed only after the fence published its
witness, and "empty" is still read from the actual tables inside the schema
transaction.

The order of the controller start, before and after:

| Step | Before | After |
| --- | --- | --- |
| 1 | state-directory lock | state-directory lock (and the deprecation notice of `--backup-before-migration`) |
| 2 | restore handoff replay | restore handoff replay (unchanged) |
| 3 | ordinary ownership: lock, restore recovery, mode normalisation, read-only inspection | the same |
| 4 | `--backup-before-migration` copy of an older schema | the admission check (read-only) |
| 5 | fence inspection | — (inside the check) |
| 6 | writable reopen, durability pragmas, migrations | writable reopen, durability pragmas, the schema transaction: creation when fresh, otherwise only the idempotent bootstrap |
| 7 | initialization marker removed, fence attached | fence attached, then the initialization marker removed |
| 8 | token bootstrap, session recovery, listeners | the same |

The check adds one marker read to an ordinary start. The schema transaction
of a current database does what it did before: no step, the idempotent
bootstrap and the validation.

On a refusal the database file, a non-empty WAL, the witness, an upgrade plan
and the restore evidence are byte-identical. The opening may have created the
state-directory and database-owner lock files, an empty WAL and a shared-memory
file (a read-only SQLite open of a WAL database), and ordinary ownership may have
narrowed the file modes of the database and its sidecars to `0600`. Two steps
run before the check, as they did before: a restore the operator requested
whose replacement was interrupted is completed by ordinary ownership (the check
then applies to the restored database), and the controller start's restore
handoff replay executes a pending handoff or records an interrupted, never
executed one as `interrupted`. Nothing else is written.

Every CLI family prints the refusal as the body of `upgradeErrorBody` (`code`,
`error`, `nextStep`, `state`) on stderr with exit code 1, the controller start
and the service executable included; command-specific translation passes it
through (the provider administration path no longer turns it into
`provider_failed`). The fence codes keep their own messages. A refused start
opens no listener, admin socket, dashboard or MCP endpoint; no upgrade operation
is reachable through them.

`--backup-before-migration` is accepted for installed service definitions but
takes no copy: start prints one fixed notice that backups are now taken by
`auth fence establish --backup-dir` and `upgrade apply --backup-dir`.
`--backup-dir` keeps its scheduling meaning. `service install` on a stopped
installation that needs the upgrade, establishment or recovery fails with that
refusal before it issues a token or changes a service definition; `--print`
opens nothing. One exception is deliberate: with a restore handoff pending, the
pre-bootstrap leaves the database to the controller and does not open it, so
the installation proceeds as before, issues no token, and writes and starts
the service. The service's start completes the restore and is then refused
with `security_fence_recovery_required` until `auth fence resume` and the
upgrade.

### Project mapping acts (integration branch only)

This section describes `integration/auth-unification`, not a release. The acts
run through the mounted `upgrade` commands. Mapping needs target 51 or more. The
code is in `mapping-upgrade-acts.ts` (the proposal pass, the review and the act
kinds), `upgrade-contract.ts` (errors, canonical JSON, limits and the domain
interface) and `upgrade-plan.ts` (the registry, the plan, its validation and
execution), all under `src/server/infrastructure/sqlite/`.

Schema steps carry structure only. Every decision about data is an act of an
operator-approved plan: which registration belongs to which project, which
projects are created, and where each remote identity maps. Nothing is
inferred, never from a name, a repository path or a remote URL. A link row
(`knowledge_project_runtime_links`) and its Knowledge history are not evidence
of approval: in released versions an agent with `knowledge:write` could link
any unlinked registration to its own Knowledge project. A link or a worker
binding becomes parenthood only when the operator accepts it.

#### Decisions

`inspectSqliteUpgrade(paths, target, decisions)` takes the operator's
decisions. Their shape is checked strictly before any lock or file: unknown
keys, IDs that are not bounded text (1 to 160 characters, at most 640 bytes,
no NUL; a linked project ID up to 4096 characters), lists over 50 000 entries
and duplicates are refused as `upgrade_decisions_invalid`.

- `links: [{ registrationId, projectId }]` accepts an existing link. It must
  name a current link row: that Knowledge project, that registration, and
  `unlinked_at` NULL.
- `bindings: [{ remoteIdentityId, registrationId }]` accepts an existing
  binding. It must name at least one row of `remote_worker_project_grants` for
  that identity (`project_id`) and registration (`local_project_id`), revoked
  or not. Accepting the pair accepts every worker row of it. It never changes
  or restores a grant.
- `isolate: { registrations, remoteIdentities }` gives the subject a new
  project of its own. It declines a journal nomination, and for an identity it
  resolves divergence.

A subject both accepted and isolated, a registration accepted into two
projects, and an entry that names no such row are refused, and no plan is
written. A link decision names a current link only: a link with `unlinked_at`
set, or one whose registration was removed (`runtime_project_id` NULL), is
refused. Several binding decisions for one identity are allowed when they lead
to one project. Without decisions (no argument, or `{}`) nothing is accepted;
an explicit `null` is refused like any other value that is not an object. At
target 50, where no act domain applies, any decision is refused. The plan stores the decisions in
normalised form (every key present, lists sorted) under the hash.

#### Outcomes

One proposal pass computes the complete ordered act list and the review from
the database, the normalised decisions and a source of new project IDs. It
gives the same result at the source schema (49 or 50, where step 51's tables
and columns do not exist and read as an empty journal, stamps 0 and no parent)
and at 51 inside the upgrade transaction, so apply can recompute it.

Every registration gets exactly one outcome, in this precedence:

1. Its link is accepted: it is attached to that existing project
   (`accepted_link`).
2. It is isolated: a new project (`created_project`).
3. A journal nomination is eligible: it is attached to the nominated project
   (`journal_reuse`).
4. Otherwise: a new project (`created_project`).

A nomination is eligible when all of the following hold. The subject's latest
journal entry (highest sequence) has basis `created_project` or
`journal_reuse`. Its project still exists. Its incarnation equals the row's
current, non-zero incarnation, so the row is the same one and not created
again. The project's creation provenance is exactly one `created_project`
entry, for this same subject and incarnation. An `accepted_link` or
`accepted_binding` entry is never reused by default: accepting a pre-existing
project needs the decision again.

Every remote identity gets exactly one outcome:

1. One or more of its bindings are accepted: every accepted binding's
   registration must have the same destination in this plan, and the identity
   maps there (`accepted_binding`); if they differ, the plan stops. That
   destination is an existing project, or the new project this plan creates
   for the registration, which the identity then joins.
2. It is isolated: a new project.
3. Its bindings (every row, revoked ones included) lead to registrations with
   more than one destination: the plan stops, and the identity needs an
   explicit decision.
4. An eligible journal nomination, by the same rule (`journal_reuse`).
5. Otherwise: a new project. An unaccepted binding never maps an identity to a
   registration's project.

Knowledge projects without a registration are untouched, and link rows are
never changed. A new project ID is a random UUID, the form the application
uses for Knowledge projects. It differs from every ID in `projects`,
`knowledge_projects` and `remote_project_identities`, from every project of
the journal and from the other new IDs. A repeated inspect reuses the new IDs
of the existing plan file when that plan's binding, installation, base,
source, target, steps and decisions equal the new one's, so an unchanged
database and the same decisions give the same plan hash. A replay that cannot
reuse a subject's new ID (missing, not a UUID, or no longer free) refuses and
names the subject.

A new project's name is derived from its subject's name during the proposal,
for display only; it decides nothing. The rule is the application's own, the
stricter of `IdentityService.createKnowledgeProject` (trimmed, 1 to 120) and
the export/import snapshot schema (1 to 120), both counting JavaScript string
length (UTF-16 code units):

1. Trim with `String.prototype.trim`, as the application does.
2. If longer than 120, cut at 120 without splitting a surrogate pair (cut at
   119 when a pair would straddle the cut), then trim the end again.
3. If empty after trimming, use `Registration <id>` or `Remote identity <id>`,
   bounded by the same cut.

So every created project could have been created by the application and
round-trips through project export and import. The `create_project` act
carries the derived name, and both its payload schema and its execution check
the rule again. A stored name that is not text is a malformed-value stop.

The acts are ordered: every `create_project` (registrations, then identities,
each by subject ID), then every `attach_registration` (by registration ID),
then every `map_remote_identity` (by identity ID).

#### Stop conditions

A stop writes no plan. An existing plan file stays as it was, and the
database and the witness are unchanged. The refusal is an `UpgradeError` with
the next step `upgrade inspect` and `details`: the offending rows by table, ID
(control characters escaped) and problem, with the total count and whether the
list is cut. The details are bounded: at most 100 findings, a table name of at
most 64 and a problem of at most 400 characters (cut with `…`), at most 5
samples of any list a problem embeds (journal sequences, destinations),
followed by "and N more (M in all)", and at most 64 KiB of JSON for the
details as a whole, beyond which the last findings are dropped. The count is
always complete.

| Code | Stop |
| --- | --- |
| `upgrade_mapping_collision` | The same ID in more than one of `projects.id`, `knowledge_projects.id` and `remote_project_identities.id`, linked or not. |
| `upgrade_mapping_dangling` | A current link whose registration or project is missing, a binding whose worker, identity or registration is missing, or a parent that names a missing project. A link whose registration was removed (`runtime_project_id` NULL) is not dangling. |
| `upgrade_mapping_divergent` | Accepted bindings that disagree, or an undecided identity whose bindings lead to several projects. |
| `upgrade_mapping_unexpected` | A registration or identity with a parent while the upgrade is needed. A quarantine clears every parent, so a parent here is a state the protocol does not produce. |
| `upgrade_mapping_journal` | A project with more than one `created_project` entry, a `created_project` entry for a project accepted by an earlier entry, an incarnation above the clock, or an illegal kind and basis. |
| `upgrade_mapping_malformed` | A stored value of another storage class than its column needs (see below), an identifier whose stored bytes are not the UTF-8 encoding of the text read back (see below), a non-text or unbounded subject ID, malformed stamps or parent, a malformed link, binding, journal row or clock, or a principal of unknown kind. |
| `upgrade_mapping_clock` | The clock cannot advance once for every attach and map act of the plan (its value plus their number would pass 2^53 − 1). |
| `upgrade_plan_bounds` | More than 50 000 acts, more than 500 000 rows of the read tables, or a plan above 8 MiB. Refused, never truncated. |
| `upgrade_decisions_invalid` | A decision that is malformed, conflicting, not allowed at this target, or names no such row. |

Ownership validates the database (`PRAGMA foreign_key_check` and step 51's
rules) before the pass runs. So a dangling reference, malformed stamps and the
journal rows the table refuses are refused there first, with a generic
validation error. The pass detects them anyway.

The clock check runs at inspect and again in the pre-backup validation, which
replays the same pass, so an exhausted clock refuses before the backup and the
pending witness with nothing changed. The clock's `CHECK` during the acts
remains the last defence.

The tables are not `STRICT`, so a declared column type does not keep a BLOB, a
REAL or another class out. Before using any value, the pass checks the storage
class (`typeof`) of every column it or its review reads, and stops on any
other: text for every ID, name, status, kind, basis and timestamp
(`projects.id`, `name`, `environment_profiles_json`;
`remote_project_identities.id`, `name`, `status`; `knowledge_projects.id`,
`name`, `status`; `knowledge_project_runtime_links.knowledge_project_id`,
`linked_at`; `remote_worker_project_grants.worker_id`, `project_id`,
`local_project_id`; `remote_workers.id`, `principal_id`, `name`, `status`;
`remote_principals.id`, `kind`, `status`; the journal's `subject_kind`,
`subject_id`, `project_id`, `basis`, `recorded_at`; the `project_id` of
`dev_environment_vaults`, `reservations`, `test_runs`,
`remote_verification_requests` and the Knowledge content tables;
`remote_verification_requests.id`; `remote_verification_attempts.request_id`;
`knowledge_import_batches.target_project_id`; every column the last link change
reads from `knowledge_history`; the `project_id` and `principal_id` of the
grant, role, delegation, membership and remote-principal-grant tables;
`runtime_credential_scopes.credential_id`, `project_id`;
`principal_credentials.id`, `principal_id`, `status`). Text or NULL for
`parent_project_id`, `runtime_project_id`, `unlinked_at`, `released_at` and
every `revoked_at`. Integer for `incarnation`, `mapping_version`, the journal's
`sequence` and `subject_incarnation`, and the clock's `singleton` and `value`.
`MAPPING_STORED_COLUMNS` in `mapping-upgrade-acts.ts` is the list.

SQLite also keeps the bytes of a text value as given, without checking that
they are UTF-8, and better-sqlite3 reads an invalid sequence back as U+FFFD.
Such an ID read back and bound again is other bytes than the stored ones: the
plan would name it, `attach_registration` or `map_remote_identity` would then
match no row (`WHERE id=?`) or find no project, and the transaction would fail
after the pending witness. Two stored IDs that differ can also read back
equal. So, after the storage classes, the pass refuses every identifier it
compares or an act writes back or matches on, on every row, unless its stored
bytes (`CAST(column AS BLOB)`) are exactly the UTF-8 encoding of the string
read back: `projects.id` and `parent_project_id`,
`remote_project_identities.id` and `parent_project_id`, `knowledge_projects.id`,
`knowledge_project_runtime_links.knowledge_project_id` and
`runtime_project_id`, `remote_worker_project_grants.worker_id`, `project_id`
and `local_project_id`, `remote_workers.id`, and the journal's `subject_id`
and `project_id` (`MAPPING_TEXT_COLUMNS`). Ownership's foreign-key validation
does not refuse such an ID when every reference to it holds the same bytes;
it refuses only a reference whose bytes name no row. A decision is JavaScript
text and reaches an act only through equality with one of these IDs. The
check (`stored-text.ts`) is shared with the authority acts and the test-run
recovery's predictor, and only they may import it.

#### The review

The plan carries, under the hash, a `review` computed by the same pass, so
what the operator read is what the hash names. It holds IDs, counts, statuses,
timestamps and display names only. Names are escaped: C0 and C1 control
characters, DEL, the bidirectional controls and the line separators become
`\u{hex}`, a backslash becomes `\\`, and names over 200 characters are cut with
`…`. No repository path, remote URL, environment value, ciphertext or stored
JSON is included.

- **Each registration:** its outcome and its incarnation. The outcome holds the
  destination, the basis, `created` (this subject's own `create_project` act
  creates it) and `existing` (it is a row of `knowledge_projects` now); an
  identity that joins a registration's new project has both false. Its current link, if any: the project, `linked_at`,
  whether it is accepted, and the attribution of the last link change from
  Knowledge history (principal, kind, authentication method, time), stated as
  recorded history and not as approval. The journal nomination, if any, and
  whether it was used and why not. Its inventory: Vault records (profiles are
  inside the ciphertext and are not counted), claims and reservations (and the
  active ones), test runs, and environment profiles.
- **Each remote identity:** its outcome, status and incarnation; every binding
  (worker, worker name and status, the worker principal's status,
  registration, revoked or not, accepted or not); the nomination; and counts of
  its verification requests and attempts.
- **Each existing destination project** (a row of `knowledge_projects`
  reached by an accepted link, a journal nomination, or an accepted binding to
  a registration that goes there): its Knowledge inventory (threads, replies,
  tasks, memories, attachments, history rows, import batches). It lists every
  registration and identity that this plan attaches to it or that the journal
  last associated with it, and whether that subject still exists. It also
  counts, in `authorityRows`, the stored authority rows by the kind of the
  principal they name (owner, human, agent, worker, installation): Knowledge
  grants and role bindings on the project; delegations, memberships, credential
  scopes and worker bindings on the registrations the plan attaches; principal
  grants on the identities it maps. Each row is counted as `unrevoked` or
  `revoked` by its own `revoked_at`, a credential scope by its credential's
  stored `status` (`active` or not). These are row counts: not distinct
  principals and not effective access, since a revoked principal or an expired
  credential is not taken into account. Grant tables keep only the latest value
  of each grant, so the counts are not a complete history either.
- **Each new project** (`newProjects`): its ID, the derived name (escaped),
  how the name was derived (`copied`, `trimmed`, `shortened` or `replaced`)
  and the source name's length, the subject it is created for, and every
  registration and identity that joins it in this plan. It has no Knowledge
  content and no stored authority yet. An identity that accepts a binding to a
  registration with a new project is listed there, so the operator sees that it
  joins that new project.
- The number of other projects, which are not touched.

A journal nomination is shown with its project, sequence and time. It is a
nomination from history: the operator approves it through the plan hash or
declines it with `isolate`. The journal authorizes nothing. `describeUpgradeActs`
returns the operator's lines from the acts and the review. A line states only
what holds: a link or nomination that is not the basis says so, and when the
subject joins that same project by another basis, the line says that too
rather than claiming it does not join. Lists are sorted by ID, so the review is
deterministic.

#### The acts

The acts run in the upgrade's one schema transaction, after the structural
steps, with foreign keys off. Each receives the plan's source and target, the
plan hash, the run's receipt and one time for the run, and re-checks its
preconditions. A mismatch aborts the whole transaction.

- `create_project { projectId, name }` refuses when the ID is not a UUID,
  exists in any of the three ID tables, or the name breaks the application's
  name rule. Then it inserts one `knowledge_projects` row in the form the
  application writes one: `active`, revision 1, both timestamps the run's time,
  and the derived name. It is not the application's creation path, which only
  an owner session reaches and whose `saveKnowledgeProject` also writes a
  `knowledge.project_saved` audit event. The act writes no audit event of its
  own: the row alone is a valid, readable project, and the upgrade's audit
  event and the journal rows record why it exists. It writes no grant, role,
  membership, link or history row.
- `attach_registration { registrationId, projectId, basis }` requires the
  registration with a NULL parent and the project. It advances the clock
  (`UPDATE project_mapping_clock SET value=value+1`), then in one UPDATE sets
  `incarnation` to the new clock value when it is still 0, `mapping_version`
  to the new value, and the parent. It checks the result and appends one
  journal row with the incarnation after stamping, the project, the basis, the
  plan hash, the receipt and the time. Step 51's triggers accept this for an
  unstamped row (the fresh value is held by no other row) and for a stamped
  one (the version is larger and equals the clock). At an exhausted clock the
  advance fails the clock's `CHECK`, and the transaction rolls back.
- `map_remote_identity { remoteIdentityId, projectId, basis }` does the same
  for a remote identity.

No act reads or writes `dev_environment_vaults`. No act writes a grant, role,
membership, link, Knowledge content or history row. IDs, provenance and
history ordinals stay the same, and so do the Vault's authenticated data (the
registration ID, the profile ID and the revision).

After apply at 51, every registration and remote identity has a parent and
non-zero stamps. The journal has exactly one row per attach and map act of the
plan.

#### Validation, twice

The plan's acts are accepted only when they are exactly what the pass produces
for this database, the plan's decisions and the plan's own new IDs. Apply
recomputes the pass with the plan's decisions, replays the new IDs for the same
subjects (generating none), and requires canonical equality of the acts and the
review:

- before the backup and the pending witness, read-only at the source schema.
  A difference is `upgrade_plan_unproposed`, next step `upgrade inspect`, with
  nothing changed. Its details name what differs: the decisions' form, the
  acts (compared on their own, so a forged act list is refused for its acts even
  with a review forged to match), the review, or the subject whose new ID the
  replay cannot reuse; a stop of the replayed pass keeps that stop's findings;
- inside the schema transaction, after the structural steps and before the
  first act, at the target. A difference aborts the transaction, which leaves
  the database fenced like any failure there.

The decisions must also be in normalised form. So a hand-written or altered
plan with a consistent hash cannot do any of the following: attach a
registration to a project the pass would not choose, label as created a
project that already existed, create a project that nothing attaches to, skip
or repeat a registration, change the decisions or the review, or order acts
against their dependencies. A replayed new ID must be a UUID that is still
free.

#### The plan and the act registry

The plan is format 2. It has the fields of format 1 plus `decisions` and
`review`, both keyed by act domain and present for exactly the domains that
apply at the target. At target 50 both are empty objects and `acts` is empty. A
format-1 plan is refused as malformed. The hash covers every field. The
review's shape is provisional and has changed within format 2 (the outcome's
`existing`, `newProjects`, `authorityRows`); a plan written in an earlier shape
fails the strict review schema and is refused as malformed, so the format
number was not raised for an unreleased change.

An act domain supplies its decision keys, the strict schemas of its stored
decisions and review, its act kinds (a strict payload and `execute`), one
`propose` pass, and `describe`. The domains run in registry order, so the
authority acts run after the mapping acts. A domain's `minimumTarget` decides
at which targets it applies: mapping from 51, authority from 52. Adding the
authority domain did not change the plan's envelope, which already carries
decisions and a review per domain under the hash, so the format stays 2; no
plan at target 52 was ever written by a release.

The bounds are 50 000 acts, 8 MiB per plan file, 500 000 rows each of
`knowledge_projects`, links, bindings, workers and journal rows read by the
pass, 100 findings and 64 KiB of details per refusal, 400 characters per
problem, 120 characters (UTF-16 code units) per created project's name and 200
per displayed name.

### Authority acts (integration branch only)

This section describes `integration/auth-unification`, not a release. The acts
run through the mounted `upgrade` commands. The authority domain needs target
52, the supported version. The code is in `authority-upgrade-acts.ts` (the pass, the review and
the act kinds) and `authority-reset.ts` (the reset statements it shares with
the quarantine), under `src/server/infrastructure/sqlite/`.

The upgrade is one-way. It resets the authority of the old model and writes the
first grant of the new one, as acts of the approved plan, after every mapping
act. The domain takes no operator decision: any decision key for it is refused
as `upgrade_decisions_invalid`. Its acts, in this order:

1. `revoke_old_grants` revokes the six tables with a revocation column in place
   (`knowledge_project_grants`, `knowledge_role_bindings`,
   `runtime_delegations`, `runtime_human_memberships`,
   `remote_principal_project_grants`, `remote_worker_project_grants`). A
   revocation time already stored is kept. Role bindings, delegations and
   memberships also advance their revision and take the run's time as
   `updated_at`, as the quarantine always did. `runtime_credential_scopes` has
   no revocation column: its rows stay as inert rows, and their credentials are
   revoked by the next act. Worker bindings stay revoked and are never rebuilt
   from the mapping.
2. `revoke_credentials` revokes every row of `principal_credentials`. Its kinds
   are `agent_token`, `owner_session` and `worker_token`, all three revoked;
   there is no other kind. A revoked credential cannot be revived.
3. `release_running_work` releases every active claim or reservation, cancels
   pending and assigned remote requests, sets assigned, preparing and running
   attempts to `cancel_requested`, and marks queued and running test runs
   (and runs whose summary is not terminal) interrupted through
   `markInterruptedTestRuns`, whose trimming of old history also deletes the
   requester rows of the runs it trims. The act then checks the recovery's
   outcome against its prediction (see below) and refuses to complete on any
   disagreement. Attribution and history stay. This invalidates the work
   logically; it does not prove that a remote process stopped. The upgrade
   runs with the controller stopped.
4. `grant_admin` writes one `admin` grant on the installation for the owner,
   only when exactly one principal of kind `owner` exists and it is active.
   Otherwise there is no such act, no account holds `admin` after the upgrade,
   and the local operator creates the first admin later. The act checks the
   rule again when it runs, and that no grant is stored yet.

Kept: the installation token and the authentication mode in
`controller_settings`, accounts, passwords, factors, every table of the
authentication provider, and history. No Vault ciphertext is read or written.

The quarantine of `auth fence resume` and these acts share one implementation
of each statement group: credentials, the six tables, reservations, remote
requests and attempts, and test runs. The quarantine runs them in its own
order, around the statements only it runs: clearing provider passwords and
tokens, sessions, verifications, passkeys and two-factor material, advancing
account policies, consuming factor contexts and failing charged receipts,
setting the mode and removing the installation token. The statements write
the run's time as a literal, as the quarantine always has; the shared guard
accepts exactly the spellings `toISOString` produces, including the signed
six-digit years of an extreme clock, so no character other than digits, `+`,
`-`, `:`, `.`, `T` and `Z` reaches the SQL, and the quarantine refuses no time
its base accepted. Tests run the quarantine as it was before the extraction
and the extracted one on twin databases at targets 49, 50 and 51 (and at 49
with an extended-year clock). They compare every table by storage class and
bytes, and the full ordered trace of SQL text and bindings of every `exec` and
prepared statement, on a fixture in which every statement changes a row.
Another test shows that the upgrade's reset acts and the quarantine leave
identical rows in every shared table and differ exactly in those
quarantine-only effects.

#### The test-run recovery and its predictor

`markInterruptedTestRuns` (in `test-run-queries.ts`) is the recovery of
ordinary startup, of the quarantine and of `release_running_work`. It is the
product's sequential code, unchanged: for each run it interrupts, it writes the
run, saves its summary, prunes summaries by age and by the per-project and
global caps, and trims that project's history; a final trim covers every
project. It samples the clock at its start and again at each pruning.

The upgrade adds a read-only predictor, `test-run-recovery-prediction.ts`,
imported only by `authority-upgrade-acts.ts` (the import guard of
`schema-entry-points.test.ts` enforces that). It never writes and the recovery
does not call it. It carries its own copies of the recovery's rules, so they
exist twice; a differential test runs the real recovery on a copy of a rich
fixture and compares every table the recovery writes with the prediction made
on the original, by storage class and bytes and with a fixed clock, so a rule
changed on one side only fails it. Its limits:

- identifiers and ordered texts must be text whose bytes are the UTF-8 encoding
  of the string read back (the check of `stored-text.ts`, shared with both act
  domains), so that JavaScript equality and byte order are SQLite's `BINARY`
  comparisons;
- counters and byte totals are JavaScript numbers, so every one and every sum
  the recovery can reach must be a safe integer;
- it uses one instant for the whole recovery; with a moving clock only results
  that depend on the time can differ (summary evictions by age and what the
  caps evict after them, `finished_at`, `recoveredAt`, `last_pruned_at`);
- it predicts the values bound for an interrupted run's columns, not the
  conversion column affinity applies to a value of an unusual class, and rows
  by key, not by rowid; trigger and foreign-key effects are not modelled.

Before predicting, the proposal refuses as `upgrade_authority_malformed`
(naming the table and the row's key, or its rowid when the key is not printable
text, never a stored value) everything outside those limits or on which the
recovery could fail for some clock:

- a value of another storage class, or text that is not valid UTF-8, among run
  IDs, project IDs, phases and queue times of `test_runs`, run IDs, project
  IDs and queue times of `test_run_summaries`, project IDs of
  `test_summary_coverage`, and run IDs of both requester tables;
- a summary outside its `CHECK` (`terminal` 0 or 1, `bytes` 1 to 8192), and an
  accounting counter that is not an integer from 0 to 2^53 - 1;
- for a run to be interrupted: stored source or telemetry of a shape the
  recovery cannot change, JSON that does not parse, a summary over the record
  budget when counted with the longest instant spelling, a stored summary of
  its ID that belongs to another registration, a stored summary that is the
  one the recovery would write at one instant, and a stored value its upsert's
  `CHECK` refuses;
- totals that could leave the safe integer range: all records plus one per run
  interrupted, all bytes plus a full summary per run, and each project's
  evictions plus one per summary;
- summaries without their project's accounting, and accounting below its
  summaries' records or bytes;
- a receipt payload the history trimming's pinning rule cannot read, whether or
  not a trim of this recovery reads it.

None of these depends on the time. Where the recovery's own outcome depends on
it, the refusal is conservative: a stored summary of another registration is
refused although the recovery reaches it only if pruning by age has not
evicted it first; accounting below its summaries is refused although it fails
only if enough evictions happen; the budget is counted at the longest instant
spelling; and a receipt is refused although SQLite reads receipts only when a
trim has a candidate. With these refused, the recovery cannot fail at any clock
and the prediction is exact at a fixed one.

The review contains only results that do not depend on the time: runs queued,
running and with an unfinished summary, runs interrupted, and runs the history
trims delete. Pruning by age deletes only finished summaries, which no trim
reads, so the trims do not depend on it. A test recomputes the review with the
clock 31 days and a year ahead and requires it to be equal.

`release_running_work` predicts the recovery in its transaction, records the
run IDs and requester run IDs, runs the original recovery, and checks: the runs
deleted are exactly the predicted ones (by identity, not by count); every
interrupted run that remains is `interrupted` with no queue position; no
queued or running run and no run with an unfinished summary remains; the
requester rows of deleted runs are gone and every other one remains. A
disagreement aborts the transaction. That is a late failure by design: it
means the predictor and the recovery disagree, the database is left fenced and
needs `auth fence resume`. A test injects such a disagreement.

When the quarantine's own recovery cannot run on a row (it throws), `auth
fence resume` fails too, before anything is committed. The operator can then
restore a verified backup, or repair the row offline with the controller
stopped. `test_run_summaries` and `test_summary_coverage` are not covered by
the security fence: a plain SQLite client can delete a summary or correct its
project's accounting, and the database stays trusted. `test_runs`, both
requester tables and `remote_worker_receipts` are covered by the fence: an edit
made outside an owner fences the installation, `auth fence resume` then
quarantines it again and runs the recovery on the edited rows, and no supported
command repairs these rows.

The reset acts have fixed payloads, and `grant_admin` names the account. So the
plan hash binds what happens without listing every row. The row effects are
bound by the review's counts under the same hash and by the plan's base
preflight, and the whole-plan validation recomputes the acts and the review,
before the backup and inside the transaction, and refuses any difference as
`upgrade_plan_unproposed`. A plan without a reset act, with acts out of order,
with an `admin` grant for another account, a non-owner or while several owners
exist, or with counts that do not match the database is refused. Authority acts
before a mapping act are refused as `upgrade_plan_invalid` when the plan is
read.

The pass reads only tables that exist at schema 49, plus `account_grants` from
52 on, which is absent at the source and read as empty, so it gives the same
result at the source and inside the transaction. It predicts the test-run
recovery that `release_running_work` runs, read-only, at inspect and at both
validations, after the refusals above. Its review, in counts, IDs,
kinds and statuses only (no token hash, secret or stored JSON):

- for each of the six tables: rows, rows already revoked, rows this plan
  revokes, and whether revisions advance;
- `runtime_credential_scopes`: its rows, all of which stay inert, and the
  distinct credentials they name by stored status before and after;
- credentials by kind: active (revoked by this plan), revoked, and revoked
  without a revocation time (which this plan sets);
- reservations to release; remote requests and attempts by phase, and how many
  are cancelled;
- test runs queued, running and with an unfinished summary, how many are
  interrupted, and how many old runs the history trimming then deletes, both
  from the prediction and independent of the time;
- every principal of kind `owner`, with its ID and status, and the admin
  decision: `grant` with the account, or `none` with the reason `no_owner`,
  `owner_not_active` or `several_owners`.

The operator's lines state that the upgrade is one-way, that every listed token
stops working, that rights must be granted again, that running work is
interrupted, and what is kept.

| Stop | Meaning |
| --- | --- |
| `upgrade_authority_malformed` | A value the pass reads has another storage class; a principal's ID (`remote_principals.id`, every row) is text whose stored bytes are not the UTF-8 encoding of the string read back, so that the owner's would be granted as an account that does not exist (`AUTHORITY_TEXT_COLUMNS`, the check of `stored-text.ts`); a principal or credential has an unknown kind or status; a revision or a live attempt's version cannot advance; a run to be interrupted holds stored JSON that does not parse; the test-run recovery's predictor refuses a row (see the list above; naming the row by its key or rowid and the kind of problem, never a stored value); or the single active owner's ID cannot be a grant's account. |
| `upgrade_authority_unexpected` | Grants of the new model are stored while the upgrade is needed. A quarantine deletes every one, so the protocol does not produce this. |
| `upgrade_plan_bounds` | More than 64 principals of kind `owner`, the fence's own bound (through the protocol the fence refuses first). |

A stop writes no plan and changes nothing. A failure of an act aborts the
transaction, which rolls back the mapping acts and the structural steps too and
leaves the database fenced; after `auth fence resume`, inspect and apply run
again. After a completed upgrade, resume deletes every grant, sets the marker
to `pending` and clears every parent; the next upgrade grants `admin` again
when its rule still holds. At targets 50 and 51 the domain does not apply.

### Pre-establishment backup (integration branch only)

`auth fence establish --expect <hash> --backup-dir <dir>` runs
`establishSqliteSecurityFence` through the bootstrap composition
`establishSecurityFenceWithBackup` (in
`src/server/bootstrap/security-maintenance.ts`), with the handoff of
`maintainSecurityFence` and the shared backup composition, writing
`<directory>/pre-establishment-v<source schema>-<UUID>`. `--backup-dir` is
required for establish and refused for `inspect` and `resume`: one non-blank,
NUL-free value, made absolute. Only the fence command calls the composition
(`schema-entry-points.test.ts`). It shares the one implementation of
`maintainSqliteSecurityFence`, which keeps its synchronous signature and
behaviour for inspect and resume. At the supported target a non-fresh source
reaches schema 52 with the upgrade marker `pending`. Every fence result carries
`nextStep`, which is `upgrade inspect` once the fence is trusted. The order is:

1. Both locks and ownership, the status, the `--expect` comparison, the
   handoff preflight, the trusted no-op (which takes no backup),
   `establishmentAllowed` and owner continuity, as establish does today.
2. The backup, through the owner's read-only connection, accepted only as this
   run's bound copy (step 5 of the upgrade, from the shared
   `takeBoundBackup`). A pre-fence source has no checkpoint, so its copy must
   have none either. Only the snapshot's origin binds it: this run wrote it
   through the owned connection under both locks, and the second preflight
   shows that the source did not move. The current binding does not detect an
   in-place overwrite of the snapshot file with an older state of the same
   database at the same schema version. A digest of the snapshot's logical
   content, taken before control of the snapshot returns to the backup function
   and compared afterwards, would detect it; that is possible later work.
3. The preflight again, which must equal `--expect`.
4. The pending witness, the migration and the receipts, as without a backup.

A backup that fails, does not validate or is not this run's is refused as
`SecurityFenceBackupError` with its own code, `security_fence_backup_failed`;
`auth fence inspect` still reports the database as
`security_fence_establishment_required`. Only this path throws the code. A moved
preflight after the backup is `security_fence_preflight_changed`. In both cases
the database file and its WAL are unchanged, no witness is written, and
establish can run again. A failure after the pending witness leaves the backup
in place. `inspect` and `resume` take no backup.

Establish without a backup guarantees the same, and in both, other files may
change. Before the status is checked, ordinary ownership may create its lock
files, recover an interrupted restore and narrow file modes. A read-only SQLite
open may create an empty WAL and a shared-memory file. A refused run with a
backup may also leave output of the backup function behind, such as a complete
or partial backup tree.
