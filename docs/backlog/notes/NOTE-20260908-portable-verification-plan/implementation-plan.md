# Portable verification and package smoke plan

## Current evidence, 2026-09-27

[Main CI 36312411574](https://github.com/pioootrek/worktree-switcher/actions/runs/36312411574)
passed at `17d0c9d`, including producer check/build/HTTPS/integration/UI/E2E,
artifact smoke on Node 22.23.2 and 24.21.0, and the packaged Linux systemd
lifecycle job. This supplies the previously pending evidence for portable CI
and package-trial slices 1–3. Populated package upgrade/failure recovery,
recorded real-client acceptance and durable release handoff remain open.
Earlier pending-CI statements below describe their dated baseline. No real
macOS trial, owner-service change or publication is claimed.

Date: 2026-09-08. Inspected main:
`2eb1f06640c6254f14e4b9b7ce7f20b0836bb2bb` (after PR #15).
Item: `FEAT-20260905-portable-verification`.
This is a source-grounded implementation plan. No CI workflow, package install,
consumer smoke test, runtime experiment or deployment was performed for this plan.

## Outcome and current evidence

Every PR should run supported source checks and build, then prove that its packed
application starts and serves its own dashboard and MCP from a clean consumer
installation. A source-checkout pass is not package-install evidence.

Inspected facts:

- No tracked `.github` workflow or package-smoke script exists at this baseline.
  `pnpm check` runs lint, typecheck and Vitest; `pnpm build` exports Next.js and
  bundles the CLI with tsup. Browser fixtures have a separate `pnpm test:ui`.
- `package.json` declares Node >=22 and pnpm 11.22.0. It is private/unpublished;
  local tarball verification does not require changing `private` or publishing.
- The package allowlist includes `dist/cli`, `out`, `skills`, README, licenses
  and selected documentation. Next.js uses `output: export`. The compiled CLI
  derives default `out` relative to its bundle, not the caller's current directory.
- `better-sqlite3` is a runtime native dependency. Source installation allows its
  build through `pnpm-workspace.yaml`; that workspace policy is not automatically
  a consumer installation policy. The package has runtime dependency ranges, so
  a fresh consumer dependency graph is not identical to the source frozen lock.
- CLI supports `project add`, `project list --json`, `doctor`, `config path`,
  `config mcp`, and explicit `--data-dir`, `--state-dir`, host/port/browse-root.
  Do not invent a `--version` success check: the command parser does not implement
  it at this baseline.
- Foreground `start --service-mode --no-open` writes a private service-access
  record and suppresses the browser pairing URL in startup output. It does not
  install or start a systemd/launchd service. Ordinary `--no-open` alone still
  prints that URL, so raw startup output is not a safe CI artifact by default.
- Offline project commands acquire the singleton lock. With a live access record,
  they forward through the authenticated controller API instead of opening a
  second database owner. Both paths should be tested from the installed binary.
- Compact MCP and claimed runtime tools are now merged. The smoke can use their
  actual contracts, including explicit stop before release, rather than planned
  tool names or internal ControlService calls.

## Proposed implementation boundaries

Add `.github/workflows/verify.yml` and one standalone Node smoke driver, proposed
`scripts/package-smoke.mjs`, exposed as `pnpm smoke:package`. The driver must run
from a copied file outside the source checkout, without TS compilation, source
imports, hidden local setup or a locally installed Worktree Switcher service.
Keep small helper modules only where needed; copy their exact dependency closure
with the driver. Use Node built-ins and, if needed, the MCP SDK resolved from the
consumer-installed package's declared dependency, never from the source checkout.

The script accepts a built tarball path. A local default may pack the current
already-built checkout first; it must fail clearly if required build artifacts
are absent, not silently build or fetch a different package version. Document:

1. `pnpm install --frozen-lockfile`
2. `pnpm check`
3. `pnpm build`
4. `pnpm smoke:package` (pack current artifacts and run the consumer smoke), or
   `pnpm smoke:package --tarball <exact-built-tarball>`

These are proposed script interfaces. Verify the installed pnpm pack flags before
writing the final workflow. Use the exact produced archive path, not a guessed
versioned filename or a wildcard that could pick an older tarball. No test should
invoke `pnpm dev`, service install/refresh, a published release or a remote host.

## 1. Small CI workflow with separate producer and consumer jobs

Use pull_request, push to main and manual workflow_dispatch triggers. Proposed
first platform: GitHub-hosted Ubuntu Linux with one exact supported Node 22 patch,
not a host-specific self-hosted runner. Resolve the patch and action commit pins
from their official releases at implementation time; record the versions rather
than using mutable `latest` tags. Keep pnpm pinned to the repository declaration.

Job A, `check-build`:

1. Checkout the tested revision with persisted Git credentials disabled. Install
   pinned Node/pnpm and dependencies using the frozen source lockfile. Preserve
   the declared dependency build allowlist; fail on missing native modules.
2. Run `pnpm check`, then `pnpm build` sequentially. No concurrent memory-heavy
   build/test jobs within one runner. Record exact commit, tool versions and
   command results. A terminated/restarted process is not a passed step.
3. Pack the just-built application to a dedicated output directory. Inspect its
   file manifest and compute SHA-256 before upload. Include the exact smoke driver
   and a small manifest listing commit, package version, artifact names/checksums
   and Node/pnpm versions. Do not include the source checkout or node_modules.
4. Upload only this explicit artifact set for the dependent consumer job. Use a
   short retention period, proposed seven days. Failure diagnostics are a separate
   safe allowlist, not the complete workspace or arbitrary logs.

Job B, `package-smoke`, depends on A:

1. Do **not** checkout the repository. Set up the same declared runtime and obtain
   only A's artifact for this workflow run. Verify the archive/driver checksums.
   A fresh hosted job prevents accidental source node_modules or state reuse.
2. Run the copied Node driver against the exact tarball. It installs the package
   into a temporary consumer directory, then runs the installed CLI and the
   packaged runtime flow below. No build output or dependencies from A may be
   linked into this installation.
3. Publish a bounded sanitized result report on success or failure. Cleanup must
   complete before the job reports success. Cancellation/job timeout never becomes
   a green result merely because the runner eventually destroys the VM.

Use `permissions: contents: read`, no deployment/package-write credentials, and
no `pull_request_target` execution of PR code. Pin external actions by immutable
commit. Run PR code only with the normal restricted PR token. Do not call the
owner's review webhook, Hub, private repositories or installed controller.

Configure concurrency per workflow and PR/ref, cancelling superseded runs.
Proposed overall budgets: 20 minutes for A, 15 minutes for B, with shorter command
budgets inside the smoke. Validate these against the first measured runs rather
than loosening host limits. Node/pnpm package caches may cache downloads keyed by
platform/runtime/lockfile; never restore source node_modules into the consumer.
Do not claim consumer resolution is frozen: npm dependency ranges are exercised
as a real fresh installation. Record a sanitized installed dependency manifest
or lock checksum to make failures diagnosable.

This first workflow verifies static asset delivery, not full browser interaction.
The current `pnpm test:ui` fixtures and remaining managed browser-flow backlog
retain their separate scope; do not present HTTP asset checks as visual QA.

## 2. Package manifest and consumer installation

Before launching anything, inspect the packed archive for:

- executable `dist/cli/index.js`, its required emitted chunks, `out/index.html`
  and referenced `_next` assets;
- packaged skill, README, license, third-party notices and promised docs;
- no state databases/WALs, MCP-token files, service-access records, controller
  locks, .env files, private keys, test output, .git, source node_modules or
  absolute/symlink entries escaping the package;
- no owner-specific filesystem dependencies in published configuration/runtime
  code. If legitimate documentation examples contain paths, distinguish them
  from an actual runtime dependency; do not flag every slash as a secret.

Preserve the package's existing allowlist instead of adding broad directories
just to make smoke pass. Fix missing bundle/assets/dependency declarations with
focused changes; do not shrink or replace dependencies as unrelated optimization.
Keep package name/version/private status unchanged for this item.

Create a fresh consumer directory outside the checkout and use a real package
manager installation of the local tarball with production dependencies only.
Proposed first consumer path: npm supplied with the pinned Node runtime,
`npm install --omit=dev --no-audit --no-fund <absolute-tarball>` in a generated
private consumer package. Record the npm version. Permit required dependency
installation lifecycle work so better-sqlite3 can load; do not pass ignore-scripts
and then hide a missing binary with the source workspace's build.

No source NODE_PATH, source node_modules/.bin entry, global Worktree Switcher bin,
workspace link or personal npm configuration may satisfy a consumer dependency.
Use a task-specific allowlisted child environment and local package-manager config
and cache directories. Respect authorized network/proxy requirements without
printing credentials. Do not repurpose shell HOME/CODEX_HOME variables or change
the user's package-manager configuration. Application state uses explicit CLI
paths, not reliance on a changed home directory.

The consumer may use network to obtain declared dependencies during installation;
it does not need release credentials, deployment access or private packages.
Report network/native-toolchain failures as failures of the corresponding stage,
not package-runtime success. Provide a finite install timeout (proposed five
minutes) and record whether a native prebuild or source build was used if observable.
Do not retry a failed runtime smoke by silently reinstalling or rebuilding it.

Resolve the installed `.bin/worktree-switcher` and prove it points into this
consumer prefix. Invoke that executable from an unrelated cwd. Check package
metadata and `config path` with explicit directories; create/read SQLite via
project registration to exercise the actual native addon. Do not use an imported
source adapter or mock store for package acceptance.

## 3. Dependency-free fixture and installed CLI flow

Generate a temporary Git repository with committed fixture files:

- package.json with `dev: node server.mjs`, optionally a fast `test` script;
- a tiny Node HTTP server using the supplied PORT and binding loopback only;
- a health response containing a unique fixture marker and process identity,
  so an unrelated server on the same port cannot satisfy the test;
- optionally a deliberate child process for the owned-cleanup assertion, with
  PID/identity evidence written inside the private fixture directory.

Use system Git with fixture-local author settings and signing disabled. Do not
change global Git config. The fixture needs no npm install or framework download;
only the package consumer itself installs dependencies. Keep files committed and
runtime evidence outside tracked source so test attribution is meaningful if
run_test is exercised. Django/framework compatibility remains separate validation.

Choose distinct temporary dashboard, MCP and fixture-server ports, each >=1024
because the current CLI rejects port 0. Allocate candidates by probing ephemeral
loopback listeners, then release immediately before launch. Binding can still
race: treat a collision as a diagnosed startup failure, never kill the listener.
A bounded retry may choose new ports only before a successful controller start
or stateful scenario; record it and do not relabel restarted execution as one
successful uninterrupted run. Avoid configured/default user ports entirely.

1. Run installed `project add <fixture> --name ... --port <fixture-port>` with
   explicit --data-dir and --state-dir while no controller exists. Read installed
   `project list --json` to obtain the actual project ID and verify repository/port.
   This exercises offline SQLite ownership and release of its singleton lock.
2. Launch the installed executable in the foreground with `start --host 127.0.0.1`,
   chosen dashboard/MCP ports, fixture browse-root, explicit data/state paths,
   `--service-mode --no-open`. Crucially omit `--web-root`: use the packaged default.
   Do not invoke any `service install/start/stop/restart` command.
3. Wait for readiness using bounded requests and the child exit event. Read only
   the fixture's private service-access record and token file in the harness.
   Keep their values out of console, command arguments, artifacts and error dumps.
   Service mode here is a foreground output/access-record mode, not a systemd unit.
4. Verify `/` and the actual same-origin script/style assets referenced by its
   HTML, with correct content types/nonempty contents and no 404/fallback HTML
   masquerading as JavaScript. Resolve URLs from the installed export; never
   fetch source out or pass a custom web root to repair a packaging defect.
5. Check the authenticated dashboard API and a missing-token rejection. Run
   installed `project list --json` while the controller is live to verify gateway
   forwarding and identical project identity. The existing singleton remains
   the database owner; no second controller is started for CLI inspection.

## 4. MCP flow against the packaged controller

Use the public MCP SDK from the consumer-installed dependency graph or a small
protocol-correct test client. A source-repository SDK import is not allowed in
job B. Keep all session IDs/authorization headers private. Test actual HTTP/MCP
responses, never application-service method calls.

1. Connect with the temporary MCP token; verify unauthorized access is rejected.
   Discover tools and registered projects, then list_worktrees to select the
   exact returned fixture path. Read compact project status.
2. Claim the project with one stable idempotency key and compact response. Wait
   for/verify running phase, exact worktree and configured port. Check the unique
   fixture health marker and actual owned process identity. If claim fails,
   preserve its lease-held evidence for cleanup and fail the stage.
3. Exercise the now-implemented runtime tools: stop while retaining the claim,
   start, repeat start as a no-op, restart once, and verify new process identity
   with the same marker/port/path. Retry restart with the same key and prove no
   second restart. Use fresh keys for distinct intended mutations.
4. Stop the owned runtime, verify its server and deliberate descendant are gone,
   then release the claim and confirm it is no longer held. Stop and release are
   distinct assertions. Missing runtime tools on this baseline's artifact is an
   artifact/contract failure, not permission to bypass via terminal commands.
5. Optionally enqueue one fast dependency-free test to exercise packaged queue
   imports/source evidence, using one committed fixture and stable key. This is
   not required to recreate the full queue/Node/Django browser acceptance suite.

Preserve port/worktree/claim ownership on every step. No scoped-token redesign,
claims against personal projects, or public package publication is required.

## 5. Cleanup, fault injection and useful evidence

The driver owns every child handle it creates and registers cleanup before the
first spawn. Apply finite request, process-start, transition and shutdown budgets
(proposed 10/30/45/15 seconds respectively), within the overall smoke timeout.
Use explicit condition polling rather than fixed sleeps; no overlapping retries
or detached promises. Never use pkill/kill-by-port or stop an unrelated process.

On normal completion, terminate the isolated controller gracefully and wait for
its exit. Assert owned fixture descendants exited, temporary listeners closed,
and service-access/singleton state was released. Also test shutdown while a fixture
runtime is active, rather than proving cleanup only after all processes stopped.
A second normal foreground launch with the same temporary state may verify
persistence/lock reuse as an explicitly separate scenario, not recovery that hides
a failed first scenario.

On failure or SIGINT/SIGTERM, close the MCP client, request owned cleanup where
possible, terminate only tracked owned children/groups and delete temporary state
in finally. If escalation is needed to avoid leftovers, retain a failed outcome;
forced cleanup never converts the test to success. Job timeout/hard runner loss
cannot promise execution of JavaScript finally; CI's disposable runner isolation
is a fallback containment boundary, not cleanup verification.

Add focused harness tests with injected command/transport/filesystem boundaries
for meaningful failures: missing package asset, native addon install/load error,
invalid checksum, readiness timeout/early controller exit, wrong health marker,
failed stop, survivor child, output redaction, interrupted cleanup and nonzero
source check. A harness returning green for any of these is itself a defect.
Run at least one controlled damaged-package/asset negative scenario in integration
so the package check cannot accidentally pass by serving checkout assets.

Emit a compact report: tested commit, tarball checksum/size, tool/platform versions,
installed package identity, step durations/results, asset counts and cleanup result.
Treat exact dependency versions as measured data, not an assumed frozen consumer
resolution. Upload only the report and reviewed redacted diagnostic excerpts.
Never upload the token/access record, raw database, complete stdout, Playwright
storage state, raw MCP traffic or user state. Test redaction with sentinel values;
GitHub masking alone is not the artifact policy.

## Implementation sequence and acceptance

1. Add the standalone smoke driver, public package script and deterministic fixture.
   Start with a built local tarball and verify manifest/installation/runtime paths.
2. Add fault-injection coverage and verify that a missing asset/survivor yields
   failure. Fix only packaging/CLI defects actually exposed by these tests.
3. Add the two-job CI with pinned setup, restricted permissions, concurrency,
   timeouts and explicit artifact allowlists. Job B must work without checkout.
4. Document the finite local command, prerequisites, expected report, native
   dependency behavior and limitations. Keep platform/service installation work
   and publication in their own backlog items.
5. Run supported check/build and package smoke sequentially, then verify the actual
   GitHub workflow on the implementation PR. Report both job results for the tested
   commit; a local pass is not proof CI ran. Do not merge around a failed check.

Acceptance: the exact artifact from a successful source build installs and runs
in a clean consumer; serves its own assets; supports offline/live CLI and actual
MCP ownership/runtime operations; leaves no owned process/state lock behind; and
fails truthfully for damaged packages, command failures and incomplete cleanup.
A reviewer can reproduce it using one documented finite smoke command.

Use Worktree Switcher queue presets for registered-project verification when
available, supported finite commands otherwise. The foreground consumer controller
and its generated fixture are owned by that finite smoke job; they are not another
copy of a registered project's development server. Preserve host resource guards,
run heavy work serially and never add llm-worker policies/paths to portable CI.

Backlog Hub fmt/validate remains required for documentation changes. Do not point
GitHub Actions at the owner's local Hub checkout or fetch an unpinned validator.
This first workflow can omit backlog validation until a portable pinned validator
is available; document that omission instead of writing a partial imitation.

After actual local/CI evidence is recorded, append results to this note and close
the item. Rollback removes the added workflow/smoke command and reverts any focused
packaging fix, without touching installed services, leases, databases or published
packages. Plan-only validation is Hub fmt/validate and git diff --check. No consumer
smoke or CI execution is claimed by this planning update.

## Implementation evidence, 2026-09-08

Implemented the two-job workflow and `scripts/package-smoke.mjs`. Local source
typechecking and all 234 Vitest tests passed, followed sequentially by `pnpm build`.
The first complete local package smoke passed on Linux x64 with Node v24.19.0 and
npm 11.17.0: a 522,398-byte tarball with 47 entries was installed into a fresh
consumer, native SQLite loaded, packaged assets and authenticated HTTP were served,
offline and live CLI identities matched, the MCP claim/start/stop/restart/release
flow passed, and shutdown removed the access record and controller lock without
forced cleanup. The observed tarball digest was
`d35468e69e3740d4fe497e87c3baceb331086f9387ca7092f571ba0967b6be72`; it is build
specific and not a release checksum.

Action tag commits were checked against their upstream Git repositories. A
controlled installed-index removal scenario was then added so every smoke run
also proves the damaged package cannot fall back to checkout assets. The final
post-change smoke passed all ten stages in 22.7 seconds with graceful cleanup.
GitHub Actions run 34261645309 then passed `check-build` in 1 minute 22 seconds
and the checkout-free `package-smoke` consumer in 50 seconds for fix commit
`b7cf866`. Both review findings were corrected and their threads resolved. This
provides the final hosted evidence required to close the feature item.
