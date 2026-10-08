# Changelog

All notable changes to `worktree-control` are recorded here. The project is
pre-1.0: the CLI, configuration and data model may change between minor versions.

## 0.1.1 - 2026-10-08

First-run fixes for new installations, bounded MCP sessions and a safer service
installer. No schema migration.

### Changed

- Two-command install: `start` and `service install` issue the installation
  token on a fresh token-mode installation, print it once to an interactive
  terminal and continue. The token never reaches a service log: without an
  interactive terminal, or under `--service-mode`, both commands refuse and
  point at `auth token generate`, which is unchanged. (#91)
- `worktree-control --help`, `-h`, `help`, `--version` and `-v` print help or
  the version and exit without starting a controller. In 0.1.0 every
  leading-dash argument ran `start` against the default data directory. (#91)
- `service install` rejects unknown options before any effect. In 0.1.0,
  `service install --help` performed an installation with default settings.
  Install now inherits the installed settings, prints the changes, offers a
  read-only `--print`, requires `--yes` for deliberate legacy setting changes
  and `--unset STARTUP_FLAG` to reset one. Ambiguous or custom unit definitions
  and uninspected systemd overrides are refused; resource drop-ins are
  preserved. (#87, #89)
- MCP sessions are bounded: at most 64 sessions globally and 32 per credential.
  Claim renewal stops 15 minutes after the last qualifying call (`tools/call`
  or `resources/read`) and the lease expires with its remaining TTL, so an
  abandoned claim becomes available within 45 minutes instead of up to 8 hours.
  Sessions whose transport ended close after 15 minutes (never-used ones after
  60 seconds), sessions with an open stream after 60 minutes without activity.
  Closing drains accepted calls for up to 120 seconds and never stops a managed
  server, cancels an accepted test job or terminates a client process. New
  `start`/`service install` options: `--mcp-claim-renewal-idle-minutes`,
  `--mcp-session-idle-minutes`, `--mcp-open-session-idle-minutes`,
  `--mcp-reconnect-grace-seconds`, `--mcp-drain-seconds`, `--mcp-max-sessions`,
  `--mcp-max-sessions-per-credential`. Agents doing long work without MCP calls
  should call a tool or `renew_project_claim` at least every 30 minutes. (#86)

### Added

- Dashboard Resources → Sessions: owner-only MCP session diagnostics (activity,
  renewal state, close deadlines, admission counters, recent closures,
  controller RSS/CPU) through a GET-only `/api/mcp/diagnostics` endpoint; agent
  and worker credentials are rejected. (#88, #89)
- `mcp diagnostics` reports the new close reasons (`idle-expired`,
  `abandoned-transport`, `admission-refused`), per-session transport and
  renewal policy state, and lists claim holders first. (#86)
- Documentation: a stable local hostnames recipe (`docs/local-hostnames.md`,
  `http://<project>.localhost` through a reverse proxy on the stable port) and
  a README note that managed servers receive the project port as `PORT`. npm
  keywords for coding-agent users. (#90)

### Fixed

- `service install` fails on a corrupt or unreadable restore handoff record
  instead of installing a unit that would crash-loop. (#91)
- Service installation decodes quoted systemd drop-in paths without shell
  evaluation, and a no-op legacy setting no longer demands `--yes`. (#89)
- The dashboard keeps RAM/CPU updates flowing when a diagnostics read times
  out, and a new installation can return from Resources to Worktrees to
  register its first project. (#89)

### Platform status

Unchanged from 0.1.0: Linux x64 verified (Node.js 22.23.2 and 24.21.0 on
Ubuntu 24.04 in CI, including the packaged systemd user-service lifecycle and
a first-run token smoke under a pseudo-terminal); the macOS LaunchAgent
installer is unverified on a real host; Windows is unsupported.

Upgrade note: in 0.1.0, `service install --help` performs an installation and
`--help`/`--version` start a controller. Upgrade before exploring the CLI.

## 0.1.0 - 2026-10-05

First public release of the npm package `worktree-control`.

### What it is

Worktree Control is a local control plane for development servers and Git
worktrees. One Node.js controller serves a browser dashboard, a CLI and an MCP
endpoint, keeps its state in SQLite, and needs no hosted account. It is MIT
licensed.

- Runs one managed development server per registered project on a stable port,
  and moves it between that project's Git worktrees. Humans and agents claim,
  lock and release projects through the controller; a claim release leaves the
  server running.
- Starts Node.js (pnpm, npm, Yarn, Bun), Next.js, Vite, Astro, Nuxt, Angular and
  Django projects. The controller stops only process trees it owns and never an
  unknown process on an occupied port.
- Queues finite test, lint, typecheck and build presets per worktree and records
  which code they checked (branch, commit and local changes around the run).
- Provides project knowledge (backlog, discussions, memory, attachments, handoff
  context and export) through the dashboard, CLI and MCP, with scoped agent
  identities and an installation token.
- Installs as a Linux systemd user service or a macOS LaunchAgent without `sudo`.
- Ships a bundled agent skill at `skills/worktree-control`.
- Offers optional installation backups, scheduled user exports and encrypted
  off-host backup transfer, all disabled until configured.
- The dashboard supports English and Polish, dark and light themes.

New installations run in `token` mode and refuse to start until
`worktree-control auth token generate` has been run.

### Renamed from worktree-switcher

The product, repository and package were called Worktree Switcher until
2026-10-05. The rename changes the package and command names, not the database
schema, backup format or MCP tool names.

- Package `worktree-control`; commands `worktree-control` and the alias `wtc`.
  There is no `worktree-switcher` command.
- User service `worktree-control.service` (Linux) and
  `dev.worktree-control.controller` (macOS).
- Environment variables `WORKTREE_CONTROL_*`. The old `WORKTREE_SWITCHER_*` names
  are still read when the new one is unset, with a one-line warning. The HTTP
  header `X-Worktree-Control-Token` is preferred; the old header name is still
  accepted.
- The bundled skill is `worktree-control`.
- Data directories do not move. An existing `worktree-switcher` data or state
  directory keeps being used while the `worktree-control` one does not exist.
- MCP resource URIs keep the `worktree-switcher://` scheme as a stable client
  contract.
- The `worktree-switcher` package on npm is a different, unrelated project.

Migration path for an installed service: install `worktree-control` into its own
prefix, then run `worktree-control service install` with the legacy service's
options. It stops the legacy unit just before starting the new one, copies
systemd drop-ins, waits for the new service to stay up and removes the legacy
definition; on failure it restores the legacy service. Then update `PATH`,
symlinks, environment variables and scripts. Full steps:
[Upgrading an existing installation](docs/user-service.md#upgrading-an-existing-installation).
Treat it as a package upgrade and rehearse with a copy of your data first
([upgrade and recover](docs/package-trial.md#upgrade-and-recover)).

### Platform status

- Linux x64 is the verified platform. CI exercises Node.js 22.23.2 and 24.21.0 on
  Ubuntu 24.04, including a packaged systemd user-service lifecycle.
- macOS: the LaunchAgent installer exists, but its lifecycle is not verified on a
  real host and process metrics are reported as unavailable.
- Windows is unsupported (no process-tree or service management).
- Requires Node.js 22 or newer and Git. The native `better-sqlite3` dependency
  may need a prebuilt binary or local build tools.

### Known limitations

- Pre-1.0: no stability promise for the CLI, configuration or data model.
- Worktree Control runs project code under your OS user. Process ownership and
  preset validation are not a sandbox; use trusted repositories and clients.
- Literal environment values in server profiles are stored in SQLite. Keep
  secrets out of them.
- `open` authentication mode removes authentication and is meant for trusted
  loopback use only.
- Search covers record titles and bodies; attached documents can be read but
  are not searched.
- Local checks use the worktree's files, including uncommitted edits; they are
  not immutable snapshots.
- Remote verification workers, optional accounts, agent-fleet coordination and
  hosted operation are planned and not available. There is no hosted offer.
- Upgrade acceptance evidence is isolated (an exact historical schema-24 package
  to the current schema); it does not establish the state of your installation.
