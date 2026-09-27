# Packaged service and upgrade trial harness design

## Current evidence, 2026-09-27

[Main CI 36312411574](https://github.com/pioootrek/worktree-switcher/actions/runs/36312411574)
passed at `17d0c9d`, including producer check/build/HTTPS/integration/UI/E2E,
artifact smoke on Node 22.23.2 and 24.21.0, and the packaged Linux systemd
lifecycle job. This supplies the previously pending evidence for portable CI
and package-trial slices 1–3. Populated package upgrade/failure recovery,
recorded real-client acceptance and durable release handoff remain open.
Earlier pending-CI statements below describe their dated baseline. No real
macOS trial, owner-service change or publication is claimed.

Date: 2026-09-11. Applies after the global-prefix package smoke passes.
Status: delivery slice 3 harness and CI path implemented; real disposable-systemd
evidence remains pending. Slices 4–5 remain an executable contract.

## Isolation and invocation

Run the lifecycle harness only as a dedicated disposable Linux user in a fresh
VM or container with a real systemd user manager. It must never target the
developer's installed controller, default data/state directories, npm prefix,
or existing service definition. The implemented slice 3 runner supplies absolute
paths, candidate provenance and the expected disposable UID:

```text
node package-lifecycle-trial.mjs
  --candidate <candidate.tgz> --candidate-sha256 <digest> --provenance <json>
  --prefix <empty user-owned directory>
  --data-dir <empty directory> --state-dir <empty directory>
  --browse-root <empty directory> --expected-uid <uid>
  --report <absolute JSON path>
```

CI additionally passes paired `--session-ready` and `--session-continue` marker
paths. The unprivileged harness pauses at that boundary while the disposable VM
coordinator restarts `user@<uid>.service`, then proves the enabled package service
starts with a new user session and a new PID. The harness never invokes `sudo`.
The old-fixture arguments enter the interface only when slices 4–5 implement the
upgrade phases below.

Before mutation the slice 3 harness verifies the candidate digest and provenance,
the dedicated UID, writable empty prefix/data/state/browse paths, absence of a
Worktree Switcher service definition, no live singleton owner, and free selected
ports. Upgrade slices additionally verify the old-fixture digest. A failed preflight
performs no installation. The harness never enables linger, uses sudo, installs operating-
system packages, deletes data, or kills a process based only on port occupancy.

Every child process gets an allowlisted environment and a bounded timeout. Output
is redacted before entering the report. The runner records the candidate and, once
implemented, old package versions, full source SHAs and digests, OS/architecture, Node/npm versions,
native SQLite load, service-manager version, durations, exit status, and whether
cleanup was graceful. The tarballs and pre-upgrade backup are retained outside
the report; credentials, pairing URLs, service-access content and raw logs are not.

## Fixture and phases

The old fixture is a retained, separately checksummed package built from an exact
commit. It is not described as a published release. Its controller registers two
committed Git fixtures, creates environment and test profiles, records a completed
test, retains representative audit/history rows, and establishes a persistent MCP
token. A same-schema old/candidate pair separates path/service replacement from
migration behavior; a second fixture starts at the oldest supported schema.

The full harness contract runs these phases in order and stops at the first unsafe
boundary. Phase 1 plus its singleton/occupied-port negative cases and idempotent
uninstall are implemented in slice 3; phases 2–6 remain planned:

1. Install the candidate into a prefix containing spaces. Exercise service
   install, status, restart, open through a fake browser recorder, stop and a
   repeated idempotent install. Confirm the definition points only at the installed
   Node/CLI/dashboard paths. An unavailable user manager must yield a bounded,
   actionable error and leave no definition.
2. Install and populate the same-schema old fixture. Record service arguments and
   controller/test idle state, create a SQLite API backup, stop cleanly, replace
   the package, and refresh with every recorded option. Verify schema integrity,
   fixture records, dashboard assets, MCP identity/token continuity and the actual
   candidate version before accepting the upgrade.
3. Repeat from the migration fixture. Capture schema version and integrity before
   and after exactly one candidate start. Verify all representative records and
   that a new browser token is produced without changing the persistent MCP token.
4. Inject, one at a time, an npm replacement failure, definition-refresh failure,
   controller startup failure, and migration failure. Each injection has a named
   boundary and must prove the failed controller is stopped before recovery. The
   old artifact is run only after the matching pre-upgrade database/configuration
   backup is restored. Preserve a copy of failed state and report that later writes
   would be discarded by restoration.
5. Uninstall the service twice, then remove the package. Confirm no owned process
   or enabled definition survives while database, credentials, configuration and
   logs remain. Reinstall the candidate and confirm the preserved configuration.
6. Connect one real MCP client using private runtime configuration, list the exact
   fixture worktree, claim/start/status/stop/release it, and remove the fixture
   project. Record only tool names and sanitized outcomes.

Occupied dashboard, MCP and project ports; a live singleton; queued/running jobs;
and an old definition pointing into a removed checkout or Node version-manager
path are explicit negative scenarios. They must not stop unrelated processes,
start a second database owner, or silently drop configured service options.

## Report contract and implementation seams

The JSON report has `schemaVersion`, `candidate`, `oldFixture`, `environment`,
`preflight`, ordered `phases`, `faults`, `retainedState`, `cleanup`, and `manualSteps`.
Every phase contains start/end timestamps, command category (never secret arguments),
outcome, bounded diagnostic summary and evidence assertions. Overall success
requires every required phase, zero forced cleanup, a disabled/absent service after
removal, and preservation of the explicitly listed state paths.

Implement the driver with Node built-ins and the installed public CLI. Keep service
manager execution behind an adapter so unit tests can inject failures, but run the
acceptance path against real systemd. Database population and inspection use public
CLI/API/MCP operations plus a narrow read-only SQLite evidence probe; backup uses
the product's SQLite backup API once exposed. Until that API and migration fixture
exist, the upgrade phase must report `blocked`, never substitute a live-file copy or
claim rollback evidence.
