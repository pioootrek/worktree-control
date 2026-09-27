---
audience: "people installing a verified Worktree Switcher trial tarball"
last_reviewed: "2026-09-27"
source_of_truth: "trial artifact installation, first run, upgrade, and removal"
status: "active"
---

# Install the local controller trial

The `0.1.0-trial.1` artifact installs the complete local Worktree Switcher
controller: CLI, browser dashboard, MCP endpoint, SQLite state, user-service
commands, and the bundled agent skill. It is not a remote worker and does not
need a hosted account. The package remains private in the npm manifest and is
distributed as an explicitly downloaded tarball, not through the npm registry.

## Requirements and verified scope

- Linux x64 is the first verified platform. CI exercises Node.js 22.23.2 and
  Node.js 24.21.0 on Ubuntu 24.04.
- Node.js 22 or newer, npm, and Git must already be available.
- Installing production dependencies requires registry access. The native
  `better-sqlite3` dependency may need a compatible prebuilt binary or local
  compilation tools; the installer never installs operating-system tools.
- Managed repositories keep their own runtime and dependency requirements.
- macOS arm64 and Windows remain unverified for this tarball trial.

The download set contains:

```text
worktree-switcher-0.1.0-trial.1.tgz
SHA256SUMS
provenance.json
INSTALL.md
package-smoke.mjs
package-lifecycle-trial.mjs
```

Check that `provenance.json` names the expected version, full source commit,
CI run, tarball digest, build toolchain, and verification targets. Then verify
the bytes before installing:

```bash
sha256sum --check SHA256SUMS
```

## Install without sudo

Use a writable, user-owned prefix. The example intentionally does not alter
the system npm prefix:

```bash
mkdir -p "$HOME/.local/worktree-switcher"
npm install --global \
  --prefix "$HOME/.local/worktree-switcher" \
  ./worktree-switcher-0.1.0-trial.1.tgz
export PATH="$HOME/.local/worktree-switcher/bin:$PATH"
worktree-switcher doctor
```

Persist the `PATH` addition in the startup file for your shell. Installation
resolves production dependencies at that time; the tarball checksum does not
freeze their transitive versions. Keep the smoke report supplied with a release
candidate when exact resolved dependencies matter for diagnosis.

A new installation runs in `token` mode. Generate the installation token once
and save it in a password manager; the controller refuses to start without it.
See [authentication modes](authentication.md).

```bash
worktree-switcher auth token generate
```

To run without a service manager:

```bash
worktree-switcher start --host 127.0.0.1
```

Open the printed address and sign in with the installation token. Keep the
token out of logs and issues. Stop it with `Ctrl-C` before installing the background service.

## Install the user service

On a Linux desktop with a systemd user manager:

```bash
worktree-switcher service install --host 127.0.0.1
worktree-switcher service status
worktree-switcher service open
```

`service open` opens the dashboard sign-in page. For custom ports, directories, or a
public HTTPS origin, follow the bundled [user-service guide](user-service.md)
and [HTTPS guide](controller-https.md).

## Upgrade and recover

Upgrading an installation that contains existing state is not supported by this
trial. Worktree Switcher does not yet expose the consistent SQLite backup API or
the tested recovery path required to make that operation safe. Do not replace the
installed package or run a newer controller against the existing data directory.

Evaluate another candidate with a separate npm prefix and empty, explicitly
selected data and state directories. Keep the existing service stopped while its
ports are reused. The old-to-new migration, backup and rollback harness is a later
acceptance gate; this guide will gain upgrade commands only after that gate passes.

## Remove the trial

Remove the service definition before removing its executable:

```bash
worktree-switcher service uninstall
npm uninstall --global --prefix "$HOME/.local/worktree-switcher" worktree-switcher
```

This preserves repositories, the SQLite database, MCP credential, configuration,
and logs. Full data deletion is a separate, explicit operation. See
[reservations and MCP](reservations-and-mcp.md) before connecting an MCP client.
