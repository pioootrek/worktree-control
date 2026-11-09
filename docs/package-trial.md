---
audience: "people installing Worktree Control from the npm registry or a verified tarball"
last_reviewed: "2026-11-08"
source_of_truth: "trial artifact installation, first run, upgrade, and removal"
status: "active"
---

# Install the local controller

The `0.2.0` package installs the complete local Worktree Control controller:
CLI, browser dashboard, MCP endpoint, SQLite state, user-service commands, and
the bundled agent skill. It is not a remote worker and does not need a hosted
account. Optional individual accounts need a separate provider artifact; see
[authentication](https://github.com/pioootrek/worktree-control/blob/v0.2.0/docs/authentication.md#account-mode-better-auth).
Upgrading from `0.1.1` needs one protected offline step; follow
[Upgrade from 0.1.1 to 0.2.0](#upgrade-from-011-to-020).

The same bytes are available as a CI-built tarball with checksums and
provenance, which is the path to use when you want to verify the artifact before
installing, or before the registry copy exists. Publication to the npm registry
is a separate owner action; the registry copy is the CI tarball, not a rebuild.
Until `npm view worktree-control version` reports `0.2.0`, the registry still
serves `0.1.1`.

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
worktree-control-0.2.0.tgz
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
  ./worktree-control-0.2.0.tgz
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
privately. See [authentication modes](https://github.com/pioootrek/worktree-control/blob/v0.2.0/docs/authentication.md).

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
public HTTPS origin, follow the bundled [user-service guide](https://github.com/pioootrek/worktree-control/blob/v0.2.0/docs/user-service.md)
and [HTTPS guide](https://github.com/pioootrek/worktree-control/blob/v0.2.0/docs/controller-https.md).

## Upgrade from 0.1.1 to 0.2.0

`0.2.0` migrates the database from schema 28 to schema 49 and adds an
[external security fence](https://github.com/pioootrek/worktree-control/blob/v0.2.0/docs/authentication.md#external-security-fence-and-protected-resume-p3b).
The first `0.2.0` start on a `0.1.1` database refuses until you establish the
fence with a protected offline command; establishment performs the migration.
Your existing mode keeps working: a `token` installation keeps its installation
token, an `open` installation stays open. Owner and agent principals, agent
tokens, Knowledge grants, projects and Knowledge history are preserved.
Existing agent tokens gain no new permissions. Individual accounts are optional
and need a separate provider; you can add them later.

This procedure was verified on Linux x64 by the installed acceptance, which
upgrades the registry `worktree-control@0.1.1` with the `0.2.0` candidate in
separate prefixes. macOS and Windows are unverified. Rehearse on a copy first
if your installation matters, and keep every command on the same data and state
directories: add `--data-dir <path> --state-dir <path>` to each command if you
use custom paths. `worktree-control service install --print` shows the
installed service options without changing anything.

Stopping the controller ends MCP sessions and stops the development servers it
manages. Ask agents to finish their work and release their claims first.

### 1. Check the current installation

```bash
worktree-control --version          # 0.1.1
worktree-control auth status        # note mode and configuredMode
```

### 2. Stop the controller

```bash
worktree-control service stop
worktree-control service status     # must report the service as stopped
```

For a foreground controller, stop it with `Ctrl-C`. Every later step until
step 7 needs the controller stopped.

### 3. Back up with 0.1.1

While `0.1.1` is still installed, create an application backup in a new private
directory (the path below is an example):

```bash
umask 077
worktree-control backup create "$HOME/worktree-control-backups/0.1.1-before-0.2.0"
```

The destination parent must be private (mode `0700`) or not exist yet; the
command creates a missing parent privately. Do not use the home directory
itself as the parent: homes accessible to a group or other users are refused.
A `backup_failed` result can indicate unsafe destination permissions; do not
skip the backup. The command prints the backup manifest. Keep it outside
any Git working tree. The fence establishment in step 6 performs the migration
itself, so `--backup-before-migration` does not run for it: this backup is your
recovery point. Do not rely on a plain copy of the data directory instead; see
[Recovery](#recovery).

### 4. Install 0.2.0 into the same prefix

```bash
npm install --global worktree-control@0.2.0
worktree-control --version          # 0.2.0
```

Use the same `--prefix` you installed `0.1.1` with, or install the verified
`worktree-control-0.2.0.tgz` as described above. A service installed from that
prefix starts the new executable without a definition change. If you install
into a different prefix, refresh the service definition afterwards as
described in the
[user-service guide](https://github.com/pioootrek/worktree-control/blob/v0.2.0/docs/user-service.md).

Do not start the controller yet. Until step 6, `0.2.0` refuses to start and
`worktree-control auth status` exits with a security-fence error. That refusal
is expected. With `--backup-before-migration`, a refused start can still
create a full backup before refusing; repeated service retries can create
several copies. Keep the service stopped until establishment completes.

### 5. Inspect the fence

```bash
worktree-control auth fence inspect
```

For a `0.1.1` database the result reports `code:
"security_fence_establishment_required"`, `establishmentAllowed: true`,
`schemaVersion: 28` and a `preflight` hash. Continue only with that result **and only if this installation has never
already been upgraded**. A plain pre-upgrade copy without its witness cannot
be distinguished from a never-upgraded store and must not be adopted. If
it reports `security_fence_recovery_required` or `establishmentAllowed: false`,
the database is not a plain `0.1.1` store (for example a restore is pending or a
witness already exists); stop and read [Recovery](#recovery).

### 6. Establish the fence

```bash
worktree-control auth fence establish --expect <preflight-from-step-5>
```

Establishment migrates the database to schema 49, writes the private witness
directory `state.sqlite3.security/` next to the database in the data directory
and reports `code: "security_fence_current"` with `changed: true`. The witness
is deliberately not part of application backups. Never delete, move or copy it,
and never place an older copy beside a database.

| Refusal | Meaning | What to do |
| --- | --- | --- |
| `security_fence_preflight_changed` | The database or witness changed after inspection | Repeat step 5 and use the new hash |
| `security_fence_owner_running` | A controller still owns the data directory | Stop it, then repeat step 5 |
| `security_fence_recovery_required` | Establishment is not allowed for this store | See [Recovery](#recovery) |
| `security_fence_pending` | Establishment did not finish | See [Recovery](#recovery) |

### 7. Start and verify

```bash
worktree-control auth status        # works again; mode unchanged
worktree-control service start
worktree-control service status     # version 0.2.0
```

Sign in to the dashboard with the same installation token. Reconnect MCP
clients; they use the same token, but their sessions ended with the restart.
Agent tokens keep their Knowledge grants. To grant agents runtime access or to
add individual accounts, follow
[authentication](https://github.com/pioootrek/worktree-control/blob/v0.2.0/docs/authentication.md).

### Recovery

There is no supported downgrade. `0.1.1` refuses a schema-49 database, and an
older executable is never a rollback. Recovery happens with `0.2.0`:

- **Refused before establishment.** If `establish` was refused with
  `security_fence_preflight_changed`, `security_fence_owner_running` or a
  refused preflight, nothing was migrated; `auth fence inspect` still reports
  schema 28. Fix the cause and repeat from step 5.
- **Establishment did not finish, or inspection reports
  `security_fence_recovery_required`.** Do not delete the witness or edit the
  database. Run `auth fence inspect` again and, only as a deliberate decision,
  `auth fence resume --expect <preflight> --mode token`. Resume keeps
  principals, projects and Knowledge history but revokes every credential,
  session and grant and clears the installation token. Afterwards generate a
  new token with `auth token generate`, then reissue agent credentials and
  grants explicitly. See
  [protected resume](https://github.com/pioootrek/worktree-control/blob/v0.2.0/docs/authentication.md#protected-operator-workflow).
- **Restoring the pre-upgrade backup** into this installation uses `0.2.0`
  `backup restore` and is then fenced like any restore: the next start refuses
  until a protected resume quarantines the restored credentials. Restoring a
  `0.1.1` snapshot with `0.2.0` is covered by the public-baseline installed
  acceptance, in both existing and empty directories. With the service stopped:

  ```bash
  worktree-control backup restore "$HOME/worktree-control-backups/0.1.1-before-0.2.0"
  worktree-control auth fence inspect
  worktree-control auth fence resume --expect <new-preflight> --mode token
  worktree-control auth token generate
  ```

  Resume preserves the backup's principal IDs, projects and Knowledge history
  but revokes all credentials and grants. Reissue agent credentials and grants
  explicitly, then start the service. Old tokens, including tokens revoked
  after the backup, remain invalid. Writes made after the backup are lost.
- **Never** replace the data directory with an older plain copy, remove the
  witness directory, or copy an old witness next to restored data to avoid the
  quarantine. Revoked credentials and sessions would become valid again.

If you decide to run `0.1.1` again anyway, do it as a separate installation:
restore the pre-upgrade backup with a separately installed `0.1.1` into new,
separate data and state directories, never on the migrated database. That copy
carries every credential as of the backup, including any you revoked later, so
rotate its installation token and revoke stale agent tokens before exposing it.
This is a separate recovery copy, not a rollback of the upgraded installation.

## Earlier upgrades

These notes cover older packages and the restic recovery trial.

Moving from a pre-rename `worktree-switcher` trial package to `worktree-control`
also renames the executable, user service, and environment variables. Follow
[upgrading an existing installation](https://github.com/pioootrek/worktree-control/blob/v0.2.0/docs/user-service.md#upgrading-an-existing-installation).

The former schema-24 → schema-28 restic trial is historical evidence only.
Its `test:package:upgrade` and `test:package:upgrade:driver` presets have been
retired: they predate the security fence and must not be used as 0.2.0 evidence.
Their source remains for reference. Current installed upgrade and recovery
acceptance is `test:rbac-artifact` with the public 0.1.1 baseline, plus
`test:rbac-artifact:fresh`. Neither replaces an operator's off-host recovery
rehearsal or establishes off-host recovery targets.

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

In `0.2.0` every restore, offline or online, is refused at the next start until
a protected `auth fence resume` quarantines the restored credentials, sessions
and grants. A real destination, recoverable keys, operator trial and rollout remain separate
acceptance steps. The imported storage-safety plan and dated evidence in Knowledge record the
isolated checks and the later operational and project-cutover procedure.

## Remove the installation

Remove the service definition before removing its executable:

```bash
worktree-control service uninstall
npm uninstall --global --prefix "$HOME/.local/worktree-control" worktree-control
```

This preserves repositories, the SQLite database, MCP credential, configuration,
and logs. Full data deletion is a separate, explicit operation. See
[reservations and MCP](https://github.com/pioootrek/worktree-control/blob/v0.2.0/docs/reservations-and-mcp.md) before connecting an MCP client.

## Publish a release

Maintainers publish the CI-built tarball, not a checkout. Download the
`portable-package` artifact of the `Verify` run on the release commit on `main`,
run `sha256sum --check SHA256SUMS`, confirm `provenance.json` names the expected
package, version, full commit, `"dirty": false` and tarball digest. Create the
matching `v<version>` tag on that commit before publication so versioned links
in the shipped installation guides resolve, then run:

```bash
npm publish ./worktree-control-<version>.tgz --access public
npm view worktree-control version
```

The optional account provider is not published to npm. Attach the files of the
`optional-auth-provider` artifact from the same `Verify` run to the GitHub
Release for that version, after checking its
`worktree-control-provider-SHA256SUMS` and that its
`worktree-control-provider-provenance.json` names the same commit, `"dirty": false` and the matching
`compatibleCore`. See
[release packaging](https://github.com/pioootrek/worktree-control/blob/v0.2.0/docs/release-packaging.md).

`package.json` has a `prepublishOnly` script that always fails. It stops
`npm publish` run from a checkout, which would pack unverified local `dist/` and
`out/` without the fingerprint, clean-tree, checksum and provenance steps. npm
does not run lifecycle scripts when publishing a tarball, so the command above is
unaffected.
