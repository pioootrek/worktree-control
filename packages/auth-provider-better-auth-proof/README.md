# Better Auth provider proof

Private, unpublished proof that Better Auth 1.7.14 with Kysely 0.28.17 can run
against the Worktree Control controller's single SQLite connection. It is not
part of the Community package, is not loaded by the controller, and does not
make the `better-auth` authentication mode selectable.

The proof harness loads it from an explicit local path through the server-only
`loadAuthenticationProvider` API and borrows the controller-owned connection
one operation at a time. Storage comes from controller migration 38; the
provider never runs library migrations. Provider modules are trusted local
code, not sandboxed code.

Run its real-library tests from the repository root:

```sh
pnpm test:auth-provider-proof
```

On a Worktree Control registered checkout, use `list_worktrees` and
`list_test_presets`, then queue `node:test:auth-provider-proof` with `run_test`
against the exact discovered path. Poll to terminal completion and inspect
process outcome and source attribution. Do not bypass the managed preset with
the direct command above. No development server or TCP port is needed. CLI
shutdown fixtures bind only temporary Unix sockets inside their isolated roots.

Verification runs serially on a clean local commit: `node:test:auth-provider-proof`,
`node:check`, `node:build`, `node:test:package:tools`, then `node:test:docs`.
The root `pnpm test:package:tools` command requires a fresh build fingerprint
and scans every file in `dist/cli` and `out` for provider implementation markers.
The general resource tests can explicitly skip that scan before a build;
a skipped scan is not artifact verification. The root manifest and lockfile
importer must exclude provider dependencies. The workspace file and lockfile
are Community fingerprint inputs; this optional package's source is not.
To reproduce dependency resolution, run `pnpm install --frozen-lockfile` at the
root. Its workspace importer pins Better Auth and core at 1.7.14 and Kysely at
0.28.17; the existing root driver is `better-sqlite3` 13.0.3.

The pinned library snapshots only 100 rows for bulk session-deletion hooks.
The proof wraps its shared `deleteUserSessions` operation in a transaction and
queues a subject-wide invalidation after commit, covering local revocation,
recovery and native password/reset/revocation handlers regardless of session
count. Single-session deletion retains its narrower notification. Tests cover
101 sessions and verify that rolled-back changes emit no invalidation.

This password-only proof does not satisfy MFA or establish ASVS Level 2.
Its numeric limits are experimental settings. Standard Better Auth stores
bearer session tokens and includes native session tokens in sign-in and
password-change JSON; production browser API design remains open. Admitted core phases now wait on the
same gate while a provider borrows the connection. Strict proof fixtures reject
unadmitted SQL even when idle; production without a provider retains compatible
synchronous store access. Live coexistence remains unaccepted while broader
coverage and design gates are open. Restoring backups can restore old
sessions and passwords until A5 adds an external revocation fence. A2 credentials
remain unchanged; A4 vault authorization still requires its separate proof.
Human enrollment, factors, invitations, role administration, GUI and account
activation are outside this slice. See the
[authentication contract](../../docs/authentication.md#optional-provider-proof-first-a3-slice).

## Live admission coverage

The strict fixtures use `SqliteStateStore.requireAdmission()` after bootstrap
and the actual pinned provider, paused inside a real transaction after a write.
Setup and inspection can enter admission explicitly. Most HTTP tests invoke
the installed Node request listener without a socket; CLI shutdown tests use
temporary Unix listeners to exercise Node response draining. MCP
uses the actual runtime's protocol registration over the SDK in-memory wire.
Automatic renewal runs its production timer callback with a manual session
clock. The tests do not wrap boundary calls in extra admission to conceal
missing production scopes. Filesystem/host/network effects use temporary
fixtures and mocks; finite-job cases run a real short Node process.

| Boundary | Strict held-provider evidence | Remaining acceptance work |
| --- | --- | --- |
| HTTP | Commit/rollback wait, single mutation and receipt replay, queued revocation, malformed 400, initial and body-read re-admission contention 503 with Retry-After (Knowledge, vault, backups and user backups) | Broader route inventory |
| MCP | Actual in-memory request wrapper, commit/rollback wait, current identity after revocation, policy closure prevents queued installation mutations, scoped readiness and retained retry; actual HTTP initial and post-body contention preserve Retry-After, post-body queued revocation | Complete SDK HTTP session and broader tool/resource matrix |
| Finite-job cancellation | Cancellation admitted after the preflight read remains terminal; no stale queued checkpoint or process spawn | Broader preparation/error interleavings |
| Automatic renewal | Contention deadline and retry preserve claim; queued credential revocation/expiry and session close prevent renewal; lease expiry during the wait prevents renewal, runtime spawn and retained retry | Complete SDK HTTP session lifecycle remains separate |
| Remote controller | Poll/report wait on commit/rollback, exact report replay, current worker grant at delivery; actual MCP submit/cancel and queued grant revocation; worker expiry at HTTP body-read re-admission; installed listener closes in CLI fixture | Remote worker cleanup/reboot failures; CLI ownership failures below |
| Remote worker | Current-state ACK merge retains cancellation and a real running report appended during upload; SQL-free network phase, receipt before preparation, ordered terminal outbox; reopened strict owner refuses interrupted execution and retains cleanup block | Real crash/reboot and signed owner-recovery host acceptance under provider contention |
| Workspace preparation | Real preparation adapter, committed recovery provenance before mock Git effect, SQL-free wait and mapping revocation after re-admission | Dependency-installation and all cleanup/refusal paths under strict contention |
| Vault | Proof expiry, grant revocation before retained plaintext replay, owner credential revocation | Broader role/grant/once-receipt and expiry combinations; A4 policy unchanged |
| Schedules/restore | Actual automatic tick and current export grants; installed HTTP finish/close/already-disconnected handoff, one deferred launch, current revocation, refused shutdown blocks execution and retains owner | Physical replacement/restart is mocked; host recovery remains separate |
| Storage/logs | One save per completed scan, duplicate coalescing, close while save waits, retention lookup waiting/refusal preserves files | Global scan backlog bounds and all retention/drain failures |
| Lifecycle/shutdown | Same-project serialization and idle admission; owning service drains real process completion/backup; actual CLI sequence closes HTTP/MCP/admin/remote Unix listeners, refuses queued HTTP dispatch in maintenance and drains accepted admin completion; service failure retains database owner | Failed listener/process/provider cleanup retains ownership; concurrent same-mode callers join completion; failures stay failures |
| Provider Knowledge handoff | 25 real-provider cases: exact opaque actor, current session/mapping/principal/grant/role, queue/idle/lock/replay, failed notification, rollback, substitutions, original-expiry cap, drain/disposal and denied privilege elevation | No production transport mounting or account-mode activation; isolated browser evidence below |
| Local readiness | Installed HTTP reservation/force-release queue behind readiness; current authority is rechecked before effects and replies after admin rotation | Other installation workflows need separate review; injected direct-store takeover is not transport evidence |
| Shared branches | Joined SQL is refused while a sibling idles; detached participants remain independent | Dashboard fan-out retains admission during Git; this is no blanket safety claim for concurrent joined branches |

`live-admission.test.ts` also retains the original strict proofs for running-job
output/exit durability, current Knowledge event grants, status long-poll release,
backup/drain ownership, late provider continuation denial and forbidden nesting.
`better-auth-proof.test.ts` retains the earlier adapter regressions, including
abandoned-iterator cleanup, omitted driver arguments, sanitized dispose failure
and subject-wide invalidation only after commit for more than 100 sessions.
The connection gate unit tests also reject already-aborted provider requests
both on a free connection and behind another provider borrow.

The bounded acceptance checklist is:

- **Tested:** `shutdown-admission.test.ts` calls `ControlService.shutdown`
  directly while accepted process completion, a queued driver backup and the
  actual provider transaction are pending. It checks terminal persistence,
  one finalized save, refusal of new lifecycle/jobs, lock retention on a real
  drain deadline, refusal of a second owner and successful later store close.
  The fixture shortens only that drain call. Failed runtime disposal stays a
  failed idempotent result; store drain/close is the retryable operation.
- **Tested:** `remote-admission.test.ts` calls actual MCP submit/cancel
  handlers over the SDK wire without an outer admission scope. Pending
  cancellation leaves durable intent and creates no attempt. A separate
  submitted request is persisted once, survives replay and retains terminal
  report evidence. Queued grant revocation denies both handlers; worker
  credential expiry denies the HTTP operation after its body-read wait.
- **Tested:** the same file's `merges a queued ACK` case holds the first
  upload while a real finite job appends `running` through the production
  callback. A second provider transaction delays the ACK write; it preserves
  both reports. The next tick collects and acknowledges terminal evidence.
  This is distinct from the cancellation-only ACK test. Its reopened-owner
  case persists `uncertain`, blocks cleanup-dependent admission and never
  enqueues the interrupted attempt again.
- **Tested:** `mcp-admission.test.ts`'s `does not revive a lease` case queues
  both the production renewal callback and `start_project`, then advances only
  wall-clock time past the stored lease. Neither renewal nor retry can spawn.
- **Regression coverage:** `mcp-http-admission.test.ts`'s `preserves
  Retry-After` case invokes the actual installed `/mcp` listener. It authenticates,
  waits for body bytes without admission, then times out re-admission behind
  the provider. `mcp-http-server.ts` preserves the retryable classification
  both at initial admission and after the body read: 503 with
  `Retry-After: 1`. The same
  file checks initial admission and current post-body credential revocation.
- **Tested handoff:** `provider-authorization.test.ts` now has 25 cases using
  actual Better Auth and the public `ProviderKnowledgeApplication`, with no
  outer admission for normal calls. The exact frozen actor belongs to one
  runtime. Each call checks current stored authority and ordinary Knowledge
  grants/role ceilings; mapping alone grants nothing. Safe identity metadata
  uses `credential: null`. Owner administration, token mint/renew, runtime,
  privileged approval and vault access remain denied. See the
  [implemented API](../../docs/authentication.md#provider-authorization-handoff).
- **Migration evidence:** seven existing
  `src/server/infrastructure/sqlite/provider-session-history-migration.test.ts`
  cases cover genuine 38-to-39 upgrade/late rollback, old registry rows and
  indexes, malformed storage refusal, deleted/empty-history watermarks and
  full/logical backup transfer. Controller schema 39 adds only honest
  `provider_session` history attribution. Provider storage revision stays 1;
  migration 1..38 definitions/checksums and owner-only import batches do not widen.
  These are unit-suite cases, not part of the optional proof count.
- **Tested restore boundary:** seven `restore-http-handoff.test.ts` cases use
  the installed HTTP handler, real durable restore admission/launch and owning
  CLI shutdown. Finish then close, close then finish and an already-disconnected
  response each launch once. Revocation ordered before deferred admission
  denies restart; unconfirmed service/listener cleanup prevents execution and
  retains both owners through the production failure callback, without forced
  exit. A refused launch or failed execution releases ownership only after
  confirmed cleanup. On successful nonconcurrent shutdown the database owner closes
  before the execution callback while the controller lock stays held. Physical
  replacement and starting the next controller are mocked. A 202 response
  records admission, not successful restore.
- **CLI regression coverage:** `cli-shutdown-admission.test.ts` invokes the actual
  owning sequence with HTTP/MCP/admin/remote listeners on temporary Unix sockets.
  It checks maintenance fencing, accepted-response drain and both ownership locks.
  Failed listener, process cleanup or provider drain retains ownership; concurrent
  same-mode calls wait for the same result, retained failures never become success,
  and a conflicting handoff mode is refused. SQLite closes only after producers
  and listeners confirm closure. Explicit recovery is required after failure.
- **Readiness and current authority:** `lifecycle-admission.test.ts` drives installed
  HTTP operation/reservation/force-release handlers and admin token rotation.
  Reservation mutations wait behind readiness without holding admission. Rotation
  during the wait denies queued mutations and the old caller's successful response.
  Existing authorized process effects are not rolled back. Direct-store injection
  remains separate from supported serialization; scoped lease expiry is tested
  independently, and provider sessions still cannot control runtime.
- **Separately deferred:** real host reboot/recovery, all dependency-install
  cleanup failures, broader route/tool permutations and global scan-backlog
  bounds need their own focused evidence. Compatible-mode recovery tests in
  `src/server/modules/remote-verification/remote-worker-recovery.test.ts` and
  `worker-owner-recovery.test.ts` cover many of these state machines; they are
  not strict held-provider evidence. Account enrollment/factors/production browser activation,
  A4 vault policy and A5 cutover/external restore fencing remain separate gates.

The implemented handoff resolves the provider outside core admission and checks
current stored authority synchronously inside each Knowledge call. Resolving
the provider inside admitted core work is still rejected as reentrant. Call
the application again after idle/lock waits before a new effect or replay.
No production provider loading or login integration is added. The isolated
browser composition below exercises the exported core adapter.
`idle` suspends an entire joined participant and requires sequential SQL phases;
independent branches need their own detached admission. Project-lock waiters
release admission, and callbacks re-enter under the lock. Current limits are
5 seconds for admission, 60 seconds for persistence retry and 10 seconds for
database drain. They are implementation limits, not account-security defaults.

The independent managed proof on clean `7ea9a1d` ran 123 cases: 120 passed,
three CLI shutdown regressions failed (run
`c8e4faaa-e892-4e63-b695-2ac7d7aca674`, exit 1, `observed_match`, confirmed
cleanup). The first attempt on `385330a` had the same three failures plus an
incorrect readiness-fixture ordering assumption; that fixture was corrected
without changing production behavior. These baseline failures preceded the parent shutdown and authority fixes.
A prebuild artifact scan skip
or an older build does not certify the changed CLI/static dashboard. Final
check/docs run evidence belongs in the owning Knowledge task and handoff.

A failed strict regression blocks live-coexistence acceptance. Keep it failing
until production code is fixed; do not weaken it or use build/package success
as a substitute for admission acceptance.

Upstream licenses are reproduced in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).


## Restart-only mode selection

`mode-restart-admission.test.ts` uses the actual CLI, private Unix admin listener,
HTTP/MCP runtime, sole-owner locks and owning shutdown helper. Its temporary
Unix sockets never start a managed development server. It selects a future
mode in boot A, verifies current HTTP/MCP authority and retained sessions, drains
and closes ownership, then reopens the same database for boot B. It covers
token/open, legacy upgrade, offline status, token prerequisites, cancellation,
current rotation, public setter refusals, maintenance admission and startup
failure. Existing runtime/readiness rotation regressions remain in the suite.
Mode is the only boot snapshot; credentials and current grants stay live.

Restore unit fixtures separately exercise physical replacement, format-2 active
execution authority versus pending configuration, format-1 compatibility and
malformed new-record refusal. Startup applies configured policy before the new
snapshot. Controller schema 39, provider storage revision 1 and migration
checksums do not change. External A5 session/password restore fencing remains
open. Positive production third-mode tests belong after account/MFA and complete
A5 transport enforcement; this suite does not make `better-auth` selectable.

## Isolated bounded browser integration

`browser-authentication.test.ts` composes the exported
`composeIsolatedBrowserAuthentication` and `AuthenticationHttp` with the actual
`createControllerServer`, strict sole SQLite owner and pinned provider. Requests
use temporary Unix sockets with canonical HTTPS Host/Origin and a distinct
explicit trusted fixture peer. No TCP listener or managed development server is
started. The active boot snapshot is open, with optional adapter composition
limited to the fixture. Pending token selection never reconstructs that snapshot.
No production selector, environment switch or fourth product mode is introduced.
Production main still cannot select/load/mount this provider.

The fixture demonstrates strict login/session/logout/password DTOs and cookies,
then calls the same HTTP `/api/knowledge` with explicit grants, including write
and receipt replay. It denies unmapped/revoked principals uniformly, discards
unreleased login sessions, rejects native endpoints/aliases/extra fields before
dispatch, validates original Host/Origin, strips spoofed IP/bearer/forwarding
headers, saturates the real native limiter, bounds body/in-flight work, preserves
refresh cookies and checks current actors around waits. Password change replaces
its cookie and revokes all old sessions; protected runtime recovery also
invalidates old cookies with a pending mode selection. Tests retain exact actor,
original-expiry and privilege cases from the earlier suite.

The provider implements API contract 2, implementation `0.0.0-proof.2`.
Version-1 modules fail closed, including the retained incompatible-loader fixture.
`signOut` keeps the native handler/limiter and explicitly deletes/verifies the
caller session, covering a real delete-hook failure that native sign-out swallows.
The core drops native bodies and arbitrary headers; no bearer token is returned
in browser JSON. Library logs/router exceptions become fixed events. After-commit
notification failures remain `committed:true`, without automatic mutation replay.
Schema 39, provider storage revision 1 and pinned dependencies do not change.

Provider-cookie requests to unconverted HTTP operations and the actual separate
MCP listener are denied before installation authority, even with open active.
Owner-session/vault authority is not synthesized. The fixture also assembles the
production HTTP shape without the optional adapter: login is unavailable and
public status exposes active mode only, including when token is pending.

`browser-authentication-shutdown.test.ts` invokes the actual owning shutdown
helper with an accepted real HTTP password transaction. Listener/response drain
precedes provider disposal, which precedes SQLite close. Disposal rejection
invalidates provider actors/facade but retains both locks and the shared failure.
The injected fault runs after real Kysely destruction solely to permit isolated
fixture cleanup; production must treat unconfirmed cleanup as failure.

Experimental bounds and proxy limitations are documented in the
[browser API contract](../../docs/authentication.md#bounded-browser-adapter).
The native limiter is in-memory and per peer/path, not per account. Behind a
proxy all remote clients share its peer until explicit trusted-proxy design.
No production security defaults, MFA/ASVS Level 2, full transport cutover,
external restore fence, GUI, OS restart or completed A3 claim follows.

## Next protected CLI integration contract

Keep mode selection separate from provider material and keep the same live boot
snapshot. Add strict operator commands through the private OS-owned Unix socket
while running, or under both singleton owners offline. Read bounded secrets from
private input/stdin or prompts; never argv, public HTTP/MCP, logs or output.
Validate private module/signing material and canonical HTTPS configuration before
loading. Configuration presence must not activate account mode.

Enrollment explicitly chooses a stable active principal, then calls
`runtime.provisionLocal({principalId,email,name,password,actor})`. A fresh
installation needs a narrow local principal-creation operation; do not call
owner-session bootstrap/recovery merely to mint a compatibility bearer. Mapping
by email and implicit grants are forbidden. Initial grants/bindings must be
explicit. Recovery calls
`runtime.recoverLocal({principalId,newPassword,actor})`, retaining principal and
grants while revoking all sessions atomically; do not reactivate revoked mappings
or principals. Give committed notification failures honest operator feedback.

Offline provider use starts no service and disposes/drains before SQLite close.
Running use stays with the sole controller owner. Pass the optional resource to
`createControllerShutdown`; rejected load/disposal must retain ownership until
cleanup is confirmed. Same-OS-user agents share this administrative trust boundary.
Protected configuration/secret persistence, fresh-principal enrollment, CLI input
and IPC schema, multi-human roles, factors/MFA and complete A5 enforcement are
future work. Do not add a password-proof activation flag to reach that work.
