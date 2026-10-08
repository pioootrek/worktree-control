---
audience: "people installing Worktree Control from the npm registry or a verified tarball"
last_reviewed: "2026-10-08"
source_of_truth: "trial artifact installation, first run, upgrade, and removal"
status: "active"
---

# Install the local controller

The `0.1.0` package installs the complete local Worktree Control controller:
CLI, browser dashboard, MCP endpoint, SQLite state, user-service commands, and
the bundled agent skill. It is not a remote worker and does not need a hosted
account. The same bytes are available as a CI-built tarball with checksums and
provenance, which is the path to use when you want to verify the artifact before
installing, or before the registry copy exists. Publication to the npm registry
is a separate owner action; the registry copy is the CI tarball, not a rebuild.

## Install from the npm registry

```bash
npm install --global worktree-control
worktree-control doctor
```

A global install into the system prefix may need elevated rights. To stay
without `sudo`, use the user-owned prefix shown below with `npm install --global
--prefix "$HOME/.local/worktree-control" worktree-control`. Then continue with
the first-run steps under [Install without sudo](#install-without-sudo).
The registry package is named `worktree-control`; the unrelated `worktree-switcher`
package on npm is a different project.

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
worktree-control-0.1.0.tgz
SHA256SUMS
provenance.json
INSTALL.md
package-smoke.mjs
package-install.mjs
package-lifecycle-trial.mjs
```

Check that `provenance.json` names the expected version, full source commit,
CI run, tarball digest, build toolchain, and verification targets. Then verify
the bytes before installing. Keep `package-install.mjs` beside the delivered
`package-smoke.mjs`, which imports it. The checksum manifest covers the tarball
and the smoke, installer and lifecycle scripts:

```bash
sha256sum --check SHA256SUMS
```

## Install without sudo

Use a writable, user-owned prefix. The example intentionally does not alter
the system npm prefix:

```bash
mkdir -p "$HOME/.local/worktree-control"
npm install --global \
  --prefix "$HOME/.local/worktree-control" \
  ./worktree-control-0.1.0.tgz
export PATH="$HOME/.local/worktree-control/bin:$PATH"
worktree-control doctor
```

Persist the `PATH` addition in the startup file for your shell. Installation
resolves production dependencies at that time; the tarball checksum does not
freeze their transitive versions. Keep the smoke report supplied with a release
candidate when exact resolved dependencies matter for diagnosis.

A new installation runs in `token` mode. Its first start creates the
installation token. To run without a service manager:

```bash
worktree-control start --host 127.0.0.1
```

The first run prints the installation token once. Save it in a password manager
straight away; it is not shown again. If you lose it, run
`worktree-control auth token rotate` to issue a new one. Open the printed
address and sign in with the token. Keep the token out of logs and issues. Stop
the controller with `Ctrl-C` before installing the background service.

The token is printed only to an interactive terminal. In a script or CI job,
run `worktree-control auth token generate` first and store its output
privately. See [authentication modes](authentication.md).

## Install the user service

On a Linux desktop with a systemd user manager:

```bash
worktree-control service install --host 127.0.0.1
worktree-control service status
worktree-control service open
```

If you skipped `start`, `service install` prints the installation token once
before it starts the service; save it as described above. `service open` opens
the dashboard sign-in page. For custom ports, directories, or a
public HTTPS origin, follow the bundled [user-service guide](user-service.md)
and [HTTPS guide](controller-https.md).

## Upgrade and recover

Moving from a pre-rename `worktree-switcher` trial package to `worktree-control`
also renames the executable, user service, and environment variables. Follow
[upgrading an existing installation](user-service.md#upgrading-an-existing-installation).

The controller provides full SQLite/attachment backup and recoverable restore.
The installed-artifact acceptance uses an exact historical schema-24 package
(`a727fd8ff01e141c6494615531e27e72a23f6320`) and the current package in separate
production prefixes. It exercises migration to schema 28, representative process
interruptions and recovery from disposable HTTPS storage after deleting the local
fixture copies. This is isolated evidence; it does not identify your deployed
version or establish off-host recovery targets for your data.

Before changing a real installation, identify its actual artifact and schema,
verify private ownership/permissions, and rehearse with an isolated consistent
copy. Historical service installations used `umask 0077`; a foreground installation
created with `0022` may need an explicit ownership/permission review before the
current controller accepts its data directory. Do not silently repair unknown
or aliased paths.

Backups are optional and configured only through operator CLI/service arguments.
When `--backup-before-migration --backup-dir <private-directory>` is enabled,
a failed required copy blocks migration. With backups off, a supported migration
runs without a backup destination, but there is no backup-based rollback.
For the selected backup profile, verify the recovery point before the upgrade,
stop the sole owner in an agreed maintenance window, and preserve the previous
artifact. Never run old code against the migrated database. After new writes,
preserve and account for those changes before considering an older snapshot;
recover old code with its matching snapshot in a separate directory.

Offline full restore preserves snapshot credentials. Inspect and revoke stale
sessions, agent tokens and grants before exposing the recovered installation.
Online/catalog restore applies its separate credential invalidation fence.
A real destination, recoverable keys, operator trial and rollout remain separate
acceptance steps. The storage-safety plan and dated evidence under `docs/backlog/`
record the isolated checks and the later operational and project-cutover procedure.

## Remove the installation

Remove the service definition before removing its executable:

```bash
worktree-control service uninstall
npm uninstall --global --prefix "$HOME/.local/worktree-control" worktree-control
```

This preserves repositories, the SQLite database, MCP credential, configuration,
and logs. Full data deletion is a separate, explicit operation. See
[reservations and MCP](reservations-and-mcp.md) before connecting an MCP client.

## Publish a release

Maintainers publish the CI-built tarball, not a checkout. Download the
`portable-package` artifact of the `Verify` run on the release commit on `main`,
run `sha256sum --check SHA256SUMS`, confirm `provenance.json` names the expected
package, version, full commit, `"dirty": false` and tarball digest, then run:

```bash
npm publish ./worktree-control-<version>.tgz --access public
npm view worktree-control version
```

`package.json` has a `prepublishOnly` script that always fails. It stops
`npm publish` run from a checkout, which would pack unverified local `dist/` and
`out/` without the fingerprint, clean-tree, checksum and provenance steps. npm
does not run lifecycle scripts when publishing a tarball, so the command above is
unaffected.
