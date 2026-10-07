---
audience: "contributors developing and testing application modules"
last_reviewed: "2026-10-07"
source_of_truth: "implemented module entry points and focused verification workflow"
status: "active"
---

# Developing a module

The controller still has one process and one database owner. `ControlService`
is the compatibility facade for runtime operations. Bootstrap in
`src/cli/index.ts` constructs identity, authentication and knowledge services;
the facade and extracted transport handlers share those services. Runtime
modules still share the facade's lifecycle dependencies.

## Where to change a workflow

| Change | Application code | Browser code | Focused verification |
| --- | --- | --- | --- |
| Server environment profiles and restart policy | `src/server/modules/environments/` | `src/features/environments/` | `pnpm test src/server/modules/environments` |
| Test environment filtering and preset assignment | `src/server/modules/environments/` and `verification/` | `src/features/verification/` | `pnpm test src/server/modules/environments src/server/test-job-manager.test.ts` |
| Runtime start/stop/switch or TLS | `src/server/modules/runtime/` and shared `lifecycle/` | `src/features/runtime/` and project-card composition | `pnpm test src/server/control-service-capacity.test.ts src/server/control-service-agent.test.ts src/server/modules/lifecycle` |
| Test-run SQL or storage history | `src/server/infrastructure/sqlite/test-run-queries.ts` or `storage-queries.ts` | Owning feature, if payload presentation changes | `pnpm test src/server/infrastructure/sqlite` |
| Remote verification admission, identity storage, and exact-commit workspaces | `src/server/modules/remote-verification/`, `src/server/infrastructure/sqlite/remote-verification-queries.ts`, and `src/server/infrastructure/git/remote-verification-workspace.ts` | None until a transport slice is implemented | `pnpm test src/server/modules/remote-verification src/server/infrastructure/sqlite src/server/infrastructure/git` |
| Installation authentication and live administration | `src/server/modules/authentication/`, `src/server/admin-socket.ts`, `src/cli/auth-management.ts` | Dashboard access form and shared session | `pnpm test src/server/modules/authentication src/server/installation-token-transports.test.ts src/cli/auth-management.test.ts` |
| Knowledge identity, content and recovery | `src/server/modules/identity/`, `src/server/modules/knowledge/`, SQLite knowledge helpers and extracted transports | `src/features/knowledge/` | `pnpm test src/server/modules/identity src/server/infrastructure/sqlite src/server/knowledge-transports.test.ts`; built integration and knowledge UI suites |
| MCP session admission, idle cleanup and claim renewal policy | `src/server/modules/mcp-sessions/`, wired by `src/server/transports/mcp/mcp-runtime.ts` | None | `pnpm test src/server/modules/mcp-sessions src/server/transports/mcp src/server/mcp-http-server.test.ts src/server/mcp-diagnostics.test.ts` |
| Schema upgrade | `src/server/infrastructure/sqlite/migrations.ts` | None | `pnpm test src/server/infrastructure/sqlite` |
| Session, event subscription, dashboard refresh | `src/features/dashboard/use-dashboard.ts` | `src/features/dashboard/dashboard.tsx` | `pnpm build` followed by `pnpm test:ui` |
| Dashboard read projection and Git refresh admission | `src/server/modules/dashboard/` and `src/server/git-worktrees.ts` | `src/features/dashboard/use-dashboard.ts` | `pnpm test src/server/modules/dashboard src/server/control-service-dashboard.test.ts src/server/events.test.ts` |

These are entry points, not claims that a change can ignore its callers.
Cross-workflow behavior still needs the relevant integration tests.
No token savings have been measured.

## Application seams

Each server module exposes an `index.ts`; cross-module imports use that API.
Modules accept narrow structural dependencies, including `Pick<StateStore, ...>`
and execution ports, so a test can provide only the methods the workflow needs.
The modules do not instantiate a database, process manager, queue, or lock map.
`ProjectLifecycle` owns the sole project lock map and pending-start capacity set.

Runtime operations and environment changes share this lifecycle instance with
verification admission and the facade's project/reservation operations.
A profile restart calls `operateLocked` while already holding the project lock.
It does not reacquire that lock. Capacity remains held across the stop and start.

`DashboardQueryService` owns display-only worktree/preset metadata caching,
repository single-flight refresh, stale/error disclosure, cheap live sections,
and cheap project summaries. `ControlService` exposes compatible full snapshots,
explicit project metadata refresh and live queries through that module. The
cache is never passed to runtime, reservation, verification, storage or cache
maintenance operations; those continue to validate against fresh Git discovery.
`SystemGitWorktreeReader` shares one bounded, priority-aware subprocess admission
boundary across both display reads and operational validation. Each priority has
its own queue budget so display saturation cannot reject fresh validation.

`SqliteStateStore` opens one connection, runs the unchanged schema initialization
and migrations, and lends the connection to query helpers. Helpers do not close
it. Reservation and profile transactions stay with the owner; storage retention
keeps its existing transaction. `src/server/sqlite-store.ts` remains a compatible
public entry point. SQL mapping types are internal persistence records.

`RemoteVerificationService` accepts an authenticated principal supplied by a
future transport and checks both principal and worker grants before persisting a
full-SHA request. `RemoteVerificationQueries` uses the controller's existing
SQLite connection. Its create-or-replay transaction owns the unique
principal/idempotency-key boundary. This slice does not connect workers or run
remote commands.

`SystemRemoteVerificationWorkspacePreparer` fetches only a registered Git
remote and accepts a commit only when a fetched remote-tracking ref contains
it. It creates a detached, clean clone below the controller-owned run root
without registering another project worktree or moving the development
checkout. Cleanup reconstructs the owned path from the request ID and leaves
sibling workspaces alone. The adapter receives the controller's shared
`GitCommandAdmission`; remote fetches use at most one shared slot and cannot occupy
the whole pool. Queue integration and attempt recovery remain separate work.

## Verification commands

Use managed verification presets when available, as required by the root guide.
The supported finite commands are:

- `pnpm test:modules`: extracted application/persistence tests and import-boundary checks.
- `pnpm test <path>`: one module or an existing integration test.
- `pnpm check`: lint, TypeScript, and all Vitest tests, including architecture checks.
- `pnpm build`: the static dashboard export and controller bundle.
- `pnpm test:ui`: Chromium checks against the already built `out/` directory.

Install the browser once with `pnpm exec playwright install chromium` if it is
not available. Rebuild after UI changes before running `test:ui`; the command
uses the existing export and does not rebuild it. Browser verification uses one
worker and no automatic retries. Failures retain traces and screenshots in the
ignored `test-results/` directory.

The UI suite intercepts requests to a fixture origin and serves the exported
files directly inside Chromium. It opens no HTTP listener, takes no server
claim, and uses no real project, session token, or controller database. It
checks rendered components, translated labels, mutation payloads, draft settings,
dialog focus restoration, test output, and one active event subscription.
It does not verify a live SSE transport, real Git discovery, process lifecycle,
or a live dashboard/controller integration. Current UI suites include mobile
layout checks, but these are fixture evidence. Separate `test:integration`,
`test:https` and `test:e2e` suites exercise built controllers and owned fixture
processes. A test against a managed development server needs a separate claim.

`src/architecture.test.ts` resolves both relative and `@/` imports. It rejects
server/CLI/Node/SQLite dependencies in browser code and shared contracts,
feature imports in reusable UI, cross-module access to server internals, and
cycles in local imports, including type-only imports.

## Deliberately remaining work

The facade still owns project registration/removal, reservation and claim
operations, cache maintenance, and controller shutdown. Most runtime HTTP/MCP
routing and bootstrap retain their existing locations; knowledge handlers
already live under `src/server/transports/`.
Extract these when their next workflow needs it, using the same lifecycle.

Cache deletion already shares lifecycle serialization with runtime, reservations,
project removal and test admission. That race was fixed in
[DONE-20260908-cache-lifecycle-serialization](backlog/done/DONE-20260908-cache-lifecycle-serialization.json).
Preserve the shared authority during further extraction.
Dashboard event classification and browser reconciliation live at the existing
event/feature boundaries; feature composition still has one SSE subscription
and one metrics timer.
