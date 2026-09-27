# Local controller package trial and release plan

## Current evidence, 2026-09-27

[Main CI 36312411574](https://github.com/pioootrek/worktree-switcher/actions/runs/36312411574)
passed at `17d0c9d`, including producer check/build/HTTPS/integration/UI/E2E,
artifact smoke on Node 22.23.2 and 24.21.0, and the packaged Linux systemd
lifecycle job. This supplies the previously pending evidence for portable CI
and package-trial slices 1–3. Populated package upgrade/failure recovery,
recorded real-client acceptance and durable release handoff remain open.
Earlier pending-CI statements below describe their dated baseline. No real
macOS trial, owner-service change or publication is claimed.

Date: 2026-09-11. Inspected baseline: `68d1edb` on main.
Owner: `FEAT-20260829-license-and-package-release`.
Status: implementation in progress; slices 1–2 are implemented locally, while
service, upgrade, owner-trial and release gates remain open. This work neither
publishes a package nor installs a service.

## What we distribute

The first artifact installs the standalone local Worktree Switcher controller.
It is a background service with a browser dashboard, local MCP endpoint, SQLite,
and ownership of local development servers and finite verification jobs. It is
not an AI agent and does not require a central controller or a hosted account.

The same product is intended to support an optional connected worker mode later.
That mode will fetch requested project commits and report execution results to a
self-hosted or maintainer-operated control plane. Remote authorization, persistence,
workspace and attempt foundations landed in PR 33, but enrollment, dispatch,
queue execution and end-to-end remote operation remain separate feature work.
Do not advertise this package as a working remote worker or invent a worker CLI.

Self-hosted users install a complete local product. Future SaaS accounts must not
be required for local startup, configuration or upgrades. Installation of new
worker software is distinct from a worker fetching source for a verification run.

## Existing evidence to reuse

- MIT licensing, notices, package entry point and asset allowlist already exist.
  The manifest currently declares version `0.0.1` and `private: true`.
- `pnpm build` produces the CLI and static dashboard with a build fingerprint.
- `.github/workflows/verify.yml` packs the checked build, records commit/toolchain
  metadata and SHA-256, and passes the exact artifact to a checkout-free consumer.
- `scripts/package-smoke.mjs` checks archive contents, installs production
  dependencies, verifies SQLite/CLI/dashboard/API/MCP, rejects damaged assets,
  records bounded output and verifies owned cleanup. It intentionally does not
  install or modify the user's service.
- CI artifacts currently expire after seven days. They are verification outputs,
  not a durable public download channel. Portable verification itself is already
  closed under `DONE-20260908-portable-verification`.

Extend this path. Do not add a second packer or rebuild an artifact after testing
and call the replacement verified. Update stale backlog wording that still treats
clean-consumer smoke as missing; the gap is the user-facing installation trial.

## Artifact and installation contract

Ship one `.tgz`, a checksum file, provenance and a short installation guide.
Provenance identifies package version, full source SHA, artifact digest, build
Node/pnpm versions, CI run and tested platform matrix. Every trial has an
unambiguous version/artifact identity; propose a pre-1.0 version during the first
implementation slice, without treating a proposed version as publication approval.

The tarball includes the CLI, static dashboard, skill, required documentation and
license notices. Inspect both archive paths and packaged text for unintended state,
credentials, local configuration and host-specific installation data. Verify README
links work from the installed package or use explicit repository links for contributor
documents deliberately excluded from the package.

The consumer needs a supported Node.js runtime, npm and Git, but does not need
pnpm, the source checkout or a Next.js build. Managed projects still need their own
dependencies and runtimes. The tarball is not an offline standalone executable:
npm installs production dependencies, including native SQLite. Record resolved
dependencies and native installation behavior; a fixed tarball digest alone does
not freeze transitive dependency resolution or prove reproducibility.

Use a documented writable npm prefix and PATH setup, avoiding a sudo requirement.
Test a prefix containing spaces and execution from outside the install directory.
The proposed user flow, with placeholders resolved in the delivered guide, is:

```text
verify the downloaded package checksum
npm install --global --prefix <user-owned-prefix> ./<verified-package>.tgz
add <user-owned-prefix>/bin to PATH
worktree-switcher doctor
worktree-switcher service install --host 127.0.0.1
worktree-switcher service open
```

Provide foreground mode when no user-service manager is available. The first
verified platform is Linux x64. Evaluate Node 22 and the current supported LTS
before choosing the release matrix; inspect current official tooling documentation
at implementation time. Treat macOS/arm64 as unverified until their native install
and real service tests pass. Do not infer Windows support from npm installation.

## Delivery slices and gates

| Slice | Change | Early validation / gate |
| --- | --- | --- |
| 1. Artifact identity and scope | Select trial version policy, inspect packed contents, retain existing provenance/digest flow, include a consumer guide and audit runtime dependencies. Keep registry publication disabled. | Pack a clean build; reject missing assets, forbidden data, digest mismatch and stale build. Check installed documentation links. Gate: one attributable artifact with complete assets and notices. |
| 2. Consumer CLI installation | Extend existing smoke coverage with an isolated global-style prefix, PATH discovery, installed skill and documented first-run commands. | Empty checkout-free consumer with production dependencies only; exercise doctor, register/list/remove fixture project, dashboard pairing and MCP claim/status/release. Check the native SQLite addon loads. Gate: no dependency on source-tree files, pnpm or preinstalled build outputs. |
| 3. Packaged service lifecycle | Verify installed CLI/Node/dashboard paths and user-service behavior using the existing service abstraction. | Dedicated disposable Linux user or VM: install/start/status/restart/open/stop/uninstall. Repeated install is idempotent; running foreground owner or occupied port is reported without interference. Verify reboot/login behavior as documented. Gate: no hard-coded builder paths or impact on unrelated services. |
| 4. Upgrade and recovery | Define controlled old-artifact to new-artifact upgrade with a database backup, saved service configuration and retained prior artifact. | Upgrade a populated previous package, verify migrated projects/profiles/history and MCP setup, then inject install/start/migration failures. Gate: successful upgrade preserves state; failure has an evidenced recovery procedure, without unsafe schema downgrade. |
| 5. Removal and owner trial | Document stop/service removal/package removal and preservation of data; complete one external-consumer human workflow with an actual MCP client. | Uninstall service before removing its executable; check no owned process survives, data remains and reinstall restores configuration. Record manual steps and installation failures. Gate: someone can follow the guide without building Switcher or manually repairing paths. |
| 6. Release handoff | Prepare a draft release description and exact verified files, checksums, platform limits and upgrade notes. | Check final artifact identity against smoke evidence and inspect public files for credentials. Gate: reviewable release candidate; public GitHub Release/tag and npm publication remain separately authorized actions. |

Run these slices in order; combine closely related documentation changes in the
same small PR where useful. The first PR should cover slices 1–2 and the concrete
service/upgrade test harness design. Do not call the complete user trial done while
service, upgrade or real-client acceptance lacks evidence.

## Upgrade policy

1. Verify the candidate package before touching the installation. Read current
   project claims, runtime phases and queued/running jobs. Wait for an idle
   controller or obtain explicit authorization to interrupt owned work.
2. Record installed version/artifact and all service options: executable and Node
   locations, data/state directories, browse root, host/ports, public URL, MCP and
   other configured flags. Back up SQLite consistently and preserve private
   credentials/configuration using owner-only permissions, never release artifacts.
3. Stop the old controller cleanly before replacing installed files. Confirm its
   owned children exited and no second database owner remains. Install the verified
   candidate; refresh the service definition only if paths/options require it,
   preserving every configured option. Do not rely on omitted options retaining
   custom values during `service install --refresh`.
4. Start once and verify migration version/integrity, representative stored records,
   installed asset/API operation, MCP and actual running build identity. A new browser
   token/session after restart is expected; show how to obtain the current private
   pairing link. Confirm MCP credentials persist through a normal upgrade.
5. If startup or migration fails, stop the failed installation before recovery.
   Do not run the old binary against an unverified newer schema. Restore the prior
   artifact and consistent pre-upgrade database/configuration only through the tested
   procedure. State that restoring an old backup discards later changes; preserve a
   copy of the failed state for diagnosis. Do not overwrite data modified after the
   upgrade without an explicit recovery decision.

The first upgrade fixture can use a retained pre-candidate artifact with populated
projects, profiles, test history and representative migration state. Record exact
old/new SHAs and package digests. An old test fixture is not a published previous
release. Also test a same-schema package update so paths and service ownership are
validated independently of migrations.

## Failure cases to prove before public distribution

- Native SQLite has no usable prebuilt binary: report whether installation fails
  or needs compilation tools. Test on a minimal system so a developer machine's
  existing compiler does not hide prerequisites. Do not silently install OS tools.
- Interrupted download/install, wrong checksum, inaccessible registry, insufficient
  disk or permissions: bounded failure and actionable diagnostics; preserve user data.
- Old service definition points into a removed checkout or Node version-manager
  directory: detect and describe repair using installed paths, without starting a
  second controller. Verify the supported Node-upgrade/service-refresh procedure.
- Occupied dashboard/MCP/project port, active singleton owner, pending jobs and an
  unavailable service manager: no unrelated process termination or resource bypass.
- Package uninstall leaves an enabled service behind: the documented order must
  prevent that condition. Removing the program does not remove repositories, SQLite,
  credentials or logs. Full data deletion is a separate explicit operation.
- Installation and private pairing/MCP output never leak credentials into CI logs,
  screenshots, reports, release notes or tarballs. Verify with synthetic credentials.

## Verification and publication boundary

Keep the existing fast tests and package smoke. Add behavioral tests for new failure
and upgrade paths; use disposable service environments for real lifecycle evidence.
Run supported finite commands serially within host resource policy. Use registered
queue presets when available, and never install the smoke candidate over the
owner's running local service as part of an automated test.

For implementation changes run appropriate focused checks, `pnpm check`, build,
exact-artifact package smoke and affected browser flows. Capture reports for install,
service, upgrade, rollback, removal and real-client acceptance. Capture actual Node,
OS/architecture, native addon result, artifact size, installation duration and manual
steps. Unsupported platforms and unexecuted tests stay explicitly unverified.

Keep `private: true` through the tarball trial. Public repository licensing is
already approved; do not redo that decision. A GitHub Release is the proposed first
durable download channel, prepared for final owner approval after all files are
ready. npm publication additionally requires the final name/version, authentication,
current registry requirements, removal of `private` and explicit authorization.
No registry credentials or publishing side effects belong in the smoke suite.

The existing feature remains open after this planning commit. On trial completion,
record evidence and distinguish the completed tarball outcome from any deliberately
deferred npm release under the backlog workflow. Coordinate real service platform
acceptance with `FEAT-20260829-user-service-installation` rather than claiming it
complete from service-definition unit tests alone.

## Slice 1–2 implementation evidence, 2026-09-11

Selected `0.1.0-trial.1` as the private, unpublished candidate identity. One
`scripts/package-trial.mjs` path now runs the existing `npm pack`, rejects stale
builds and non-private/non-prerelease manifests, and emits the exact tarball,
`SHA256SUMS`, provenance, copied smoke driver and `INSTALL.md`. Provenance records
the package/version, full source SHA, dirty state, artifact digest/size, Node/npm/
pnpm toolchain, CI run identity when present, and declared verification targets.

The packaged guide documents a sudo-free user prefix, foreground and user-service
startup, limits, upgrade caution and removal order. Relative README links are now
limited to packaged files; contributor-only documents use explicit repository
links. The tarball audit checks required CLI/dashboard/skill/docs/notices, forbidden
or escaping paths, symlinks, secret markers, builder-specific runtime paths and
installed README links.

The checkout-free smoke now installs through `npm install --global --prefix` into
a prefix containing spaces and invokes `worktree-switcher` through that prefix's
`PATH` from an unrelated directory. It verifies CLI provenance, `doctor`, native
SQLite load and provisioning path, offline add/list, live forwarding, packaged
assets/API, MCP version and runtime ownership, offline project removal, the full
resolved production graph and graceful cleanup. CI reuses the exact producer
artifact across Ubuntu 24.04 x64 jobs for Node 22.23.2 and 24.21.0, selected after
checking the current official Node LTS schedule on 2026-09-11.

Local evidence on Node 24.19.0/npm 11.17.0: lint, typecheck, 303 Vitest tests and
four resource tests passed; the production build passed; the 531,271-byte tarball
with 49 entries passed all 12 smoke stages in 20.3 seconds with a packaged
`better-sqlite3` Linux x64 prebuild and graceful cleanup. Its dirty-worktree digest
was `a3b2c1f69d0a5e26faf99702e0b443eecadc3a46edc9248b0906b27d2e325367` and is
development evidence, not a release checksum. CI matrix results are not yet known.

The concrete disposable-user/systemd, same-schema and migration upgrade, injected
failure recovery, removal and real MCP-client contract is recorded in
`package-lifecycle-harness.md`. Slice 3 now has a packaged lifecycle driver and a
disposable GitHub runner path, but real systemd evidence remains pending until that
job runs. Upgrade/recovery and real-client slices remain unimplemented and
unverified; the package release feature stays open.
