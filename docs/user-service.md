---
audience: "people running Worktree Control on a development machine"
last_reviewed: "2026-10-08"
source_of_truth: "user-service installation, operation, logs, and removal"
status: "active"
---

# Run Worktree Control as a user service

A terminal is useful while you evaluate Worktree Control. A user service is
better once the controller becomes part of your daily setup. It survives a
closed terminal, restarts after a crash, and keeps the dashboard and MCP
listener available for the length of your login session.

The installer supports:

- systemd user services on Linux
- LaunchAgents on macOS

It does not use `sudo`, install a system-wide daemon, change firewall rules, or
add CPU and memory limits.

## Before you install

Install and verify the trial package as described in the
[package trial guide](package-trial.md), then stop any foreground Worktree
Control process. The singleton lock does not let a service and a foreground
controller share the same state directory.

```bash
worktree-control doctor
```

A new installation runs in `token` mode. If it has no installation token yet,
`service install` creates one and prints it once, before the service starts.
Save it in a password manager; it is not shown again, and
`worktree-control auth token rotate` replaces a lost token. The token is never
written to the service definition or its logs. Without an interactive terminal,
`service install` refuses; run `worktree-control auth token generate` first.
See [authentication modes](authentication.md).

The examples below use the executable installed into a user-owned npm prefix.
When developing from a source checkout, use `node dist/cli/index.js` in its
place after a successful build.

## Install the service

```bash
worktree-control service install
```

Installation writes one user-owned definition and starts it immediately:

| Platform | Definition |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/systemd/user/worktree-control.service`, or `~/.config/systemd/user/worktree-control.service` |
| macOS | `~/Library/LaunchAgents/dev.worktree-control.controller.plist` |

The definition stores absolute paths to Node.js, the built CLI, dashboard
assets, data, and runtime state. It also stores the chosen host and ports. Its
controlled `PATH` includes standard system directories and the directories of
any supported package managers (`pnpm`, `npm`, `yarn`, or `bun`) found during
installation. It does not contain the installation token, the browser pairing
token or the MCP bearer token.

Installation is idempotent. Running the same command again keeps the existing
process. If the generated definition would change, the command stops and asks
for an explicit refresh.

Preview the generated local definition without writing files or calling the
service manager:

```bash
worktree-control service install --print
```

All service commands reject unknown options, misplaced arguments, duplicate
single-value options and missing values before performing service operations.
`--help` and `-h` currently print usage as an error and exit without installing.

## Choose the network and directories

`service install` accepts host, port, MCP, directory and backup startup options;
service mode always disables automatic browser opening:

```bash
worktree-control service install \
  --host 127.0.0.1 \
  --port 47831 \
  --mcp-port 47832 \
  --browse-root /home/me/development \
  --data-dir /home/me/.local/share/worktree-control \
  --state-dir /home/me/.local/state/worktree-control \
  --memory-warning-mib 1536
```

Use `--no-mcp` if you do not want the MCP listener. To publish the dashboard
through the supported HTTPS reverse-proxy setup, follow
[Protect the controller with HTTPS](controller-https.md). Its `--public-url`
mode requires a loopback `--host` and an explicit service refresh when changing
an existing definition.
`--memory-warning-mib` adds a visual warning when one managed process group
reaches the configured aggregate resident-memory threshold. It reports only;
the controller never terminates a server because of this threshold.
The `--mcp-*` session options (`--mcp-claim-renewal-idle-minutes`,
`--mcp-session-idle-minutes`, `--mcp-open-session-idle-minutes`,
`--mcp-reconnect-grace-seconds`, `--mcp-drain-seconds`, `--mcp-max-sessions`
and `--mcp-max-sessions-per-credential`) override the MCP session limits
described in [session liveness, cleanup and admission](reservations-and-mcp.md#session-liveness-cleanup-and-admission).
Explicit MCP session values are written into the definition and retained on
subsequent installs or refreshes.

The values become part of the service definition. Later installs, legacy
migrations and `service install --refresh` inherit every omitted startup
setting from that definition, including data/state directories, network,
backup policies and MCP limits. Explicit options replace only their own
setting; passing `--user-backup-target` replaces the full target list, and
`--backup-remote-disabled` clears the inherited remote transfer settings.
The new package supplies its own dashboard asset path unless `--web-root` is
passed explicitly. An unreadable or unrecognized definition is refused rather
than silently replaced with defaults. Automatic inheritance accepts the
generated definition with complete absolute startup paths and recognized
environment settings. Relative paths, environment substitutions and custom
main-unit settings require operator reconciliation first. Supported resource
drop-ins are preserved; command/environment overrides and conflicting legacy
and destination drop-ins are refused.

The preview covers local files. Before an actual Linux install, a read-only
service-manager check also verifies the loaded fragment and drop-ins and
rejects a stale definition or overrides outside the inspected local directory.
After loading the new definition, the installer checks the destination unit
again before stopping or starting a controller. A failed check restores the
previous files without interrupting the running service.
An explicit `--yes` does not bypass these checks. macOS validates the stored
LaunchAgent; real-host migration acceptance remains outstanding.

Use repeated `--unset STARTUP_FLAG` options to reset inherited settings. For
example, `--unset --no-mcp` enables MCP again,
`--unset --user-backup-enabled` disables user schedules, and
`--unset --backup-interval-seconds` disables the installation backup schedule.
A setting cannot be both supplied and unset in one command. The preview shows
the generated default when resetting a serialized numeric setting.

During migration from the legacy service name, an explicit settings change
prints a before/after comparison and requires `--yes`. First review the same
command with `--print`; package path updates alone need no confirmation.

A refresh or legacy migration restarts the controller and stops its managed
development servers and active test jobs. After the upgrade, agents must
reacquire claims and start the required servers through the normal workflow.

Commands that read the access record or MCP token do not parse the installed
service definition. If you choose custom directories, pass the matching path:

```bash
worktree-control service status --state-dir /home/me/.local/state/worktree-control
worktree-control service open --state-dir /home/me/.local/state/worktree-control
worktree-control config mcp --data-dir /home/me/.local/share/worktree-control
```

## Open the dashboard

Check the service first:

```bash
worktree-control service status
```

Status reports the service state, definition path, controller PID, uptime,
restart count when available, version, endpoints, log directory, CPU use, and
resident memory for the controller process. When the controller API is
reachable, it also reports managed-server capacity and current slot holders.
The dashboard separately samples each active managed process group every five
seconds and shows current and peak RAM, CPU, child-process count, and a bounded
history. This monitoring is Linux-only in the current release; other systems
show an explicit unsupported state.

Open the dashboard:

```bash
worktree-control service open
```

Sign in with the installation token. On a headless machine, print the address
and open it on an allowed device:

```bash
worktree-control service url
```

In `token` and `open` modes the address contains no secret. In `legacy` mode
`service url` prints a pairing credential; do not paste it into logs, issues,
source files, or a shared shell transcript. The underlying access record is stored
with owner-only permissions and is removed during a clean stop.

## Start, stop, and restart

```bash
worktree-control service start
worktree-control service stop
worktree-control service restart
```

A clean stop sends the controller `SIGTERM`. The controller closes MCP and the
dashboard, then stops every development-server process tree it owns. It never
kills an unrelated process just because that process uses a configured port.

On Linux, systemd keeps the controller and its children in the same service
cgroup. On macOS, the LaunchAgent keeps the process group attached to the job.
Both definitions retry after failure with a five-second throttle. systemd also
caps the restart burst.

## Read the logs

Application logs use the user state directory on both platforms:

```text
~/.local/state/worktree-control/logs/controller.log
~/.local/state/worktree-control/logs/projects/<project-id>.log
```

Linux also records service-manager output in the user journal:

```bash
journalctl --user -u worktree-control.service
journalctl --user -u worktree-control.service --since today
```

On macOS, LaunchAgent output uses:

```text
~/.local/state/worktree-control/logs/service.stdout.log
~/.local/state/worktree-control/logs/service.stderr.log
```

Custom `--state-dir` values move these files. Worktree Control does not write
to `/var/log`.

The browser URL and bearer tokens should never appear in these logs. If you
find one, treat it as a security bug.

## Update the installed service

Package upgrades against an existing data directory are not supported by the
current tarball trial. There is no public consistent-backup command or tested
rollback path yet. Do not replace the installed package or start a newer controller
against that state. Evaluate a candidate with a separate prefix and empty,
explicitly selected data and state directories as described in the
[package trial guide](package-trial.md).

`service install --refresh` updates only the service definition for the currently
installed build. Use it after deliberately changing its executable, Node.js,
dashboard, network or directory paths. Omitted startup settings are inherited:

```bash
worktree-control service stop
worktree-control service install --refresh --host 127.0.0.1
```

The explicit flag prevents a normal install from silently changing the existing
definition. It does not make a package or database upgrade safe.

After refresh:

```bash
worktree-control service status
```

Confirm the version, PID, endpoints, and log path.

## Upgrading an existing installation

Until 2026-10-05 this product was distributed as `worktree-switcher`. The rename
changes no database schema, backup format, or MCP tool name, but the new build
can still contain newer migrations than your installed one. Treat the move like
any package upgrade and prepare it as described in
[upgrade and recover](package-trial.md#upgrade-and-recover) first.

1. Install the `worktree-control` package into its own user-owned prefix, for
   example `$HOME/.local/worktree-control`, as in the
   [package trial guide](package-trial.md). It provides the `worktree-control`
   command and the short alias `wtc`, and no `worktree-switcher` command.
2. Review `worktree-control service install --print`, then run
   `worktree-control service install`. Both inherit the legacy startup options,
   including data/state directories; explicitly changed settings require
   `--yes` after reviewing their comparison. If both legacy and current
   definitions exist, reconcile them before installing. The command stops the
   legacy `worktree-switcher.service` (or the `dev.worktree-switcher.controller`
   LaunchAgent) just before starting the new service, because both use the same
   ports and lock. Legacy systemd drop-ins (`worktree-switcher.service.d/*.conf`)
   are copied to `worktree-control.service.d/` first, so memory limits and
   sandbox settings keep applying; a drop-in that already exists for the new
   unit with different contents is never overwritten, and the legacy directory
   is then kept for review. The command waits until the new service keeps one
   main process running without restarts (at most 30 seconds), then enables it,
   disables and removes the legacy definition, and prints what it did. If the
   new service fails to start or stay up, the new definition and copied drop-ins
   are removed again, a legacy service that was running is started again and
   keeps its definition. `service status` warns while a legacy definition
   remains.
3. Update your shell `PATH` and any symlinks you created, replacing the old
   prefix (for example `$HOME/.local/worktree-switcher/bin`) and links to the
   `worktree-switcher` executable with their `worktree-control` equivalents.
4. Rename environment variables from `WORKTREE_SWITCHER_*` to
   `WORKTREE_CONTROL_*`, for example `WORKTREE_CONTROL_TOKEN`,
   `WORKTREE_CONTROL_OWNER_TOKEN`, `WORKTREE_CONTROL_KNOWLEDGE_TOKEN`,
   `WORKTREE_CONTROL_DATA_DIR`, and `WORKTREE_CONTROL_STATE_DIR`. A legacy name is
   still read when the new one is unset, with a one-line deprecation warning on
   standard error. Test runs receive their metadata under both prefixes.
5. Scripts that send the `X-Worktree-Switcher-Token` header keep working during
   the transition; change them to `X-Worktree-Control-Token`.

Data directories do not move. Directories passed explicitly, by option or
environment variable, are used exactly as given. Without them, the controller
uses `~/.local/share/worktree-control` and `~/.local/state/worktree-control`,
except that it keeps using an existing `worktree-switcher` directory while the
corresponding `worktree-control` directory does not exist, and prints a notice.
Nothing is copied or moved automatically. The dashboard moves its saved theme,
language, project selection, and session tokens to the new browser storage keys
on first use.

After the new service runs, remove the old package, for example with
`npm uninstall --global --prefix "$HOME/.local/worktree-switcher" worktree-switcher`.
On npm, `worktree-switcher` is an unrelated project; do not install it.

## Linux login sessions and linger

A systemd user service normally starts with your user session and stops when
that user manager exits. If the controller must run before login, an
administrator can enable lingering for the account:

```bash
sudo loginctl enable-linger <user>
```

This changes host behavior. Worktree Control never runs that command for you.
Most development machines do not need it.

## Remove the service

```bash
worktree-control service uninstall
```

Uninstall stops the controller, disables and removes its user-service
definition, and reloads the service manager where needed. It also removes a
remaining pre-rename `worktree-switcher` service definition. It preserves:

- the SQLite database
- the `legacy` MCP token, if present
- project and controller logs
- project configuration and claims

Running uninstall again is safe. It reports that the service is not installed.

## Troubleshooting

### Another controller is already running

```text
Worktree Control is already running (PID ...)
```

Stop the foreground controller before starting the service, or stop the service
before using foreground mode. Do not delete the lock while the reported PID is
alive.

### The service is installed but does not start

On Linux:

```bash
systemctl --user status worktree-control.service --no-pager
journalctl --user -u worktree-control.service -n 100 --no-pager
systemd-analyze --user verify ~/.config/systemd/user/worktree-control.service
```

On macOS:

```bash
launchctl print gui/$(id -u)/dev.worktree-control.controller
```

Check whether Node.js and the built CLI still exist at the paths stored in the
definition. If they moved, run `service install --refresh` from the new build.

### The dashboard URL is unavailable

Run `service status`. If the service is active but `service url` reports a stale
record, inspect the controller log. The controller writes a fresh access record
only after the dashboard and MCP listeners start successfully.

### A configured port is already used

Worktree Control will report the conflict and leave the unknown process alone.
Stop that process yourself or assign a different project port in the dashboard.

### A package manager is missing in service mode

The installer records the directories containing supported package managers
that are available in your current terminal. If you install or move `pnpm`,
`npm`, `yarn`, or `bun` later, rebuild Worktree Control and refresh the service
definition from a terminal where the command is available:

```bash
command -v pnpm
worktree-control service install --refresh
```
