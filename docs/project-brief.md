---
audience: "contributors and coding agents"
last_reviewed: "2026-10-05"
source_of_truth: "product intent and initial architecture of Worktree Control"
status: "active"
---

# Worktree Control: product brief

## Problem

Developers using Git worktrees often run the same application from several
branches. Moving a development server between those worktrees is manual: stop
the process, find the correct directory, start the correct command, verify the
port, and recover when an old child process remains alive. The effort grows
when a workspace contains several related projects such as a frontend, API,
and documentation site.

## Product direction

Worktree Control is a local-first, open-source web application that discovers
the worktrees belonging to registered Git repositories and manages their
development servers. One persistent control plane serves the dashboard. Every
registered project has an independent runtime slot, stable port, process state,
logs, and selected worktree.

The controller also manages finite verification jobs against exact discovered
worktrees. Test adapters discover safe framework-specific presets, while one
shared queue enforces a global parallel limit and serializes runs within each
worktree.

For example, one Switch instance may run all of the following concurrently:

- frontend from `feature/checkout` on port 3000;
- backend from `feature/payments-api` on port 4000;
- documentation from `main` on port 5000.

Switching the frontend worktree must not interrupt the backend or documentation
servers.

Shared human/agent memory, discussions, tasks, attachments and Hub import are
implemented on `main`; see [shared project memory](shared-project-memory-plan.md)
for delivered stages and remaining pilot/cutover work. Knowledge has a durable
project identity independent of runtime ownership. This repository's current
work lives in Knowledge project `k7a-worktree-switcher`; the repository-backed
records remain its import archive. Other projects follow their own explicit
migration decisions; see [the workflow](backlog/AGENTS.md).
The subsequent [agent coordination plan](agent-fleet-coordination-plan.md)
adds assignments, messages, and evidence across sessions. Agent coordination
and autonomous execution remain planned; delivered knowledge does not imply an
implemented fleet or a decision to rename the product.

The first remote-execution experiment is
[verification of pushed commits on customer-owned workers](remote-verification-plan.md).
An existing LLM client or human requests a configured check for an exact SHA
and receives its result. It follows urgent runtime reliability work and
precedes autonomous fleet execution; a full forum or paid SaaS is not required.
Request/attempt persistence and exact-SHA workspace preparation are implemented.
Worker connectivity, queue execution and caller transports remain incomplete;
there is no supported end-to-end remote endpoint yet.

The [environment runtime plan](environment-runtime-plan.md) incorporates the
owner's Secret Runtime proposal through scoped worker-side credential delivery.
Its original documents are retained as reference; a standalone vault and its
proposed technology stack are not adopted as current Worktree Control architecture.

The [architecture and effort assessment](architecture-effort-assessment.md)
records the expected structural changes, indicative effort, exclusions, and
delivery uncertainty. It recommends an incremental remote-verification slice,
not a rewrite or a committed launch schedule.

## Initial architecture

The control plane lives outside the repositories it manages. Next.js builds the
dashboard as a static export; it is not a persistent application server. One
lightweight Node.js process serves the exported files, exposes the loopback API,
and manages child processes. Git remains the source of truth for worktree
discovery. The manager starts commands with the selected worktree as their
working directory, observes readiness, streams logs, and terminates the
complete previous process tree before reuse of a port.

Each project has its own serialized state machine: `stopped`, `starting`,
`running`, `stopping`, or `failed`. Operations for different projects may run
concurrently; switch operations for one project are serialized.

The first version uses a stable direct port for each managed application. A
reverse proxy and coordinated multi-project workspace profiles are deferred
until the independent-project flow is reliable.

The controller is event-driven: it does not continuously scan repositories or
watch complete worktree trees. Expensive Git status checks are lazy and
refreshes are bounded. Release verification measures controller overhead
separately from the projects it manages. The [resource budget](resource-budget.md)
limits median RSS above a same-host Node baseline, idle CPU, post-cycle growth
and retained logs. It distinguishes stopped projects from the cost of monitoring
three running applications and replaces the historical absolute RSS target.

## Persistence and service boundary

The MVP stores projects, settings, runtime recovery hints, reservations, and
audit events in a local SQLite database. Logs use the platform state directory
and remain outside the database. Only one controller instance owns the database
and managed processes at a time.

HTTP handlers and UI code do not access files directly. Application services
depend on interfaces such as `StateStore`, `GitWorktreeReader`, and
`ProcessRunner`; the first `StateStore` implementation is SQLite-backed. A
future remote implementation can replace that adapter without changing use
cases or API contracts.

User accounts are not part of the local MVP. Adding them later requires an
authentication and authorization boundary plus ownership and concurrency
rules; changing the persistence adapter alone would not be sufficient.

## Configuration contract

The database has explicit schema migrations and versioned project records.
Commands are stored as an executable plus an argument array and always spawned
without a shell. Each project declares its repository path, stable port,
optional environment overrides, health check, startup timeout, and whether it
should start automatically. The selected worktree is runtime state and is
never accepted as an arbitrary browser-provided working directory.

Named environment profiles provide validated literal overrides for both Node.js
and Django processes. The selected profile persists across worktree switches;
changing an active profile requires a controlled restart. Controller and runtime
loader variables such as `PORT`, `NODE_ENV`, `PATH`, `NODE_OPTIONS`, dynamic
loader paths, and Python import paths cannot be overridden, and audit events record variable names without values.
The controller's own `NODE_ENV` is never inherited by managed children. Development
servers run with `NODE_ENV=development`; finite test jobs leave it unset unless a
trusted test adapter explicitly selects a value.
Secrets, environment files, relative working directories, PATH prefixes, and
required runtime directories remain part of the broader profile backlog.

An optional controller-wide counting semaphore limits concurrently starting
or running managed servers. Capacity is independent from reservations: a lock
consumes no slot until its server starts. Switching retains the current slot,
failed starts release it, and lowering the limit never terminates existing
processes.

Registration offers automatic, Node.js, and Django launch presets. For Node.js
projects, it detects `pnpm`, `npm`, `yarn`, or `bun` from
`packageManager` and lockfiles. It requires a `dev` script, except that an
Angular workspace identified by `angular.json` and `@angular/cli` may use the
standard `start: ng serve` script. The launch resolver chooses how to pass the
stable port instead of appending one universal argument sequence: Next.js and
unknown Node servers receive `PORT`, while Vite, Astro, and Nuxt receive their
supported `--port` argument through the package manager's forwarding syntax.
Angular receives explicit loopback `--host` and stable `--port` arguments
through either its `dev` or `start` script. Django projects are detected through a root-level
`manage.py` and run on loopback with `.venv/bin/python`, `venv/bin/python`, or a
`python3` fallback. The command is resolved again for the selected worktree
before every start, so local virtual environments can differ between worktrees.
Dependency installation, migrations, ASGI server presets, external virtual
environments, and LAN binding are not automatic. Persisted commands remain
explicit arrays so a future settings flow can add custom presets without
changing process spawning.

Next.js projects may opt into development HTTPS. The launch resolver supports
the certificate generated by `next dev --experimental-https` or local key,
certificate, and optional CA files. The controller stores canonical file paths,
not private-key contents. A TLS change is accepted only while that project's
managed process is stopped. This setting does not add TLS to the Worktree
Control control plane.

## Distribution and operation

The npm package and executable are named `worktree-control`; `wtc` is a short
alias for the same executable. The product was called Worktree Switcher until
2026-10-05, when it was renamed because the npm name `worktree-switcher` had
been taken that day by an unrelated Windows-only project; `worktree-switcher`
on npm is not this product. A global user-level installation registered as an operating-system user service is the
recommended daily-use path. The package remains private and unpublished; use
the verified tarball or a source build for foreground evaluation and diagnostics.
Running `worktree-control` or `worktree-control start`
starts one foreground controller, opens the browser, and owns its managed child
processes. New installations first require `auth token generate`; existing
installations retain legacy mode until explicitly migrated. `--no-open` supports
headless use. See [authentication](authentication.md) for CLI access and migration.

The CLI installs a systemd user service on Linux or a LaunchAgent on macOS
without requiring root. The service starts with the user's platform session,
uses bounded restart backoff, and exposes status and recovery commands. A
single-instance lock prevents a background and foreground controller from
sharing the database or process state. Pre-login Linux operation through user
lingering remains an explicit administrator choice and is never enabled
silently.

On normal shutdown or `SIGINT`/`SIGTERM`, the controller gracefully stops every
process tree it started. It never terminates an unknown process merely because
that process occupies a configured port. Leaving managed servers running after
controller exit is not part of the MVP.

Implemented supporting commands cover `auth`, `identity`, `knowledge`,
`backup`, `config path`, `config mcp`, `project add|list|remove`, `doctor`, and the
`service install|status|start|stop|restart|open|url|uninstall` lifecycle.
Project commands delegate to an authenticated running user service or acquire
the controller singleton lock for offline access. Standalone platform binaries
remain deferred until real usage justifies their maintenance.

## Interface system

The owner-approved redesign direction is recorded in
[Approved GUI direction](backlog/notes/NOTE-20260911-approved-gui-direction/direction.md),
including the canonical project-detail mock. Subsequent GUI design follows its
charcoal and restrained lime visual system. WinPath may inform the component
development process only; copying its appearance is explicitly prohibited.
This approval records a design target, not a shipped redesign.

The dashboard uses shadcn/ui source components with the `new-york` style,
Radix primitives, Tailwind CSS, and CSS-variable design tokens. It is dark-first
for a developer-tool context while retaining a light/system theme option.

The interface supports Polish and English through an owned, typed translation
layer with no hosted localization dependency. English is the default and
fallback language. A visible control persists manual preference locally, and API
requests carry the selected language so controller errors match the dashboard.
CLI output follows the operating-system locale.

Only components used by an implemented flow are added to the repository. The
initial set covers buttons, cards, badges, tables, dialogs, destructive
confirmations, tabs, selects, tooltips, scroll areas, skeletons, alerts, and a
responsive sheet. Reservation and runtime states always combine color with
text and an icon so meaning does not depend on color perception.

## MVP

- Register multiple local Git repositories.
- Discover worktrees using Git's stable porcelain output.
- Show branch, commit, path, dirty state, and worktree health.
- Start, stop, restart, and switch each project independently.
- Reserve a project on a specific worktree with a human hard lock or expiring
  agent lease.
- Preserve a stable configured port per project.
- Show readiness, failure details, and recent logs.
- Discover, queue, cancel, and retain results for Node.js and Django test or verification presets per worktree.
- Install the controller as a persistent user-level service and prevent a
  second controller from taking ownership of the same state.
- Allow a dirty worktree to run while showing a persistent warning.
- Listen on configured local interfaces (LAN by default), require an ephemeral
  pairing token for all control data and mutations, and reject arbitrary
  commands or paths.
- Persist project configuration and the last selection; reconcile live process
  state after a control-plane restart.

## Deferred ideas

- Workspace profiles that activate a coordinated set of worktrees across
  several projects.
- Creation, locking, pruning, or deletion of worktrees.
- A browser terminal.
- Reverse proxying with transparent HMR WebSocket support.
- Windows process-tree support; the initial target is Linux and macOS.

## Agent integration

A loopback-only MCP Streamable HTTP listener exposes project/runtime status as
resources and lets an agent atomically reserve, switch, renew, and release its
own expiring lease. It shares the controller process and service layer, loads
the MCP SDK lazily, and never gives the model a raw lease token. The complete
design is in `docs/reservations-and-mcp.md`.

## Current decisions

- Use one lightweight Node.js controller and a statically exported Next.js UI;
  do not run a persistent Next.js server.
- Use a local SQLite adapter behind application-service interfaces; keep all
  database access inside the single controller process.
- Use explicit, shell-free executable and argument arrays with per-project
  ports, environment overrides, health checks, and timeouts.
- Keep finite test jobs separate from long-lived server state. Bound them with
  a global queue limit and permit at most one active run per worktree.
- Build the dashboard from owned shadcn/ui source components using the
  `new-york` Radix variant, Tailwind CSS, and token-based theming.
- Include visible reservations in MVP. Human locks may be indefinite; agent
  leases expire and renew. Force release remains a human UI/CLI action.
- Serve authenticated MCP Streamable HTTP on a dedicated loopback listener in
  the existing controller; keep remote MCP and stdio compatibility deferred.
- Permit dirty worktrees with a warning, stop owned child processes when the
  controller exits, and never kill an unknown process occupying a port.
- Publish the npm package and executable as `worktree-control` (renamed from
  `worktree-switcher` on 2026-10-05, as described above); retain a
  foreground mode for evaluation and make a user-level background service the
  recommended daily-use installation.
- Listen on LAN interfaces by default and print an ephemeral secret pairing
  link. Keep loopback-only operation available through `--host 127.0.0.1`;
  restrict any host firewall rule to the trusted LAN subnet.
