# Better Auth provider proof

Private, unpublished proof that Better Auth 1.7.14 with Kysely 0.28.17 can run
against the Worktree Control controller's single SQLite connection. It is not
part of the Community package, is not loaded at controller startup, and does not
make the `better-auth` authentication mode selectable.

The proof harness loads it from an explicit local path through the server-only
`loadAuthenticationProvider` API and borrows the controller-owned connection
one operation at a time. Storage comes from controller migrations 38 and 40; the
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

This proof does not establish ASVS Level 2, and its numeric limits are experimental
settings. Standard Better Auth stores
bearer session tokens and includes native session tokens in sign-in and
password-change JSON; production browser API design remains open. Admitted core phases now wait on the
same gate while a provider borrows the connection. Strict proof fixtures reject
unadmitted SQL even when idle; production without a provider retains compatible
synchronous store access. Live coexistence remains unaccepted while broader
coverage and design gates are open. Restoring backups can restore old
sessions and passwords until A5 adds an external revocation fence. A2 credentials
remain unchanged; A4 vault authorization still requires its separate proof.
Public factor routes, factor management, invitations, role administration, GUI and
account activation remain outside this slice. Protected CLI enrollment/recovery is
described below. See the
[authentication contract](../../docs/authentication.md#optional-provider-proof-first-a3-slice).

## Protected CLI maintenance proof

A3-I10 adds strict configuration/status, first-principal-only creation,
enrollment and recovery through actual `runAuthCommand` and the private Unix
socket. `cli-provider-administration.test.ts` uses the real pinned provider and
sole SQLite owner. Fixtures create principals without compatibility bearers,
then explicitly enroll. Lifecycle cases cover accepted work after disconnect,
lazy initialization, queued maintenance refusal and failed disposal ownership.
The browser proof remains isolated; no production browser route is mounted and
`better-auth` selection remains unavailable.

After a fresh managed `node:build`, queue `node:test:auth-provider-cli-artifact`.
It emits a private JavaScript provider with the existing bundler, then invokes
the built CLI for configure/create/enroll/recover with stdin. It tests duplicate
global paths and a finite child whose actual provider disposal rejects after
destruction. That child must report committed effect/uncertain cleanup while
retaining its process and both locks. The harness then terminates only that
owned temporary child and removes fixtures. No install, service change or
persistent test daemon is involved. Emitted code stays in the harness's private
temporary directory, outside Community assets; its dependencies resolve through
a temporary link to the existing pinned proof dependencies.

Private signing configuration requires separate protected backup. No rotation,
atomic filesystem/SQLite config audit, exactly-once recovery, MFA or full A3
acceptance is claimed. See the exact
[operator workflow](../../docs/authentication.md#protected-provider-maintenance).

After a fresh managed build, `node:test:integration:provider-administration`
starts the actual built CLI controller with zero managed projects and temporary
ports, data and state. It exercises configure/status/owner creation/enrollment/
recovery through private IPC, active open and token modes with pending mode
changes, exact CLI conflict errors, secret exclusion, sole SQLite ownership and
SIGTERM cleanup. These cases execute `main` rather than reconstruct its dispatcher.

The same preset covers a real admin-listener start refusal and injected SQLite
close failures during startup cleanup and SIGTERM. A child-only Node preload
arms the driver failure after setup; no production fault flag is added. The
restore case invokes the actual HTTP restore route and confirms provider disposal
before the injected driver failure. The restore-failure callback now retains a
referenced process lifetime and a nonzero exit state when cleanup is unconfirmed.
The regression requires a live owner that refuses both controller and SQLite
takeover after provider disposal, rather than only leftover lock files.
This demonstrates failure handling under a controlled storage fault, not a way
for an unprivileged caller to cause that fault. Listener-cleanup uncertainty
after an accepted request, OS service recovery and full A3 acceptance remain
separate gates.

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
open. Positive production third-mode tests belong after account authentication, optional-method readiness and complete
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
Production main cannot select or mount this provider. Only protected maintenance
explicitly loads it, without composing the browser adapter.

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

The provider implements API contract 5, implementation `0.0.0-proof.5`.
Older modules fail closed, including the retained incompatible-loader fixture.
`signOut` keeps the native handler/limiter and explicitly deletes/verifies the
caller session, covering a real delete-hook failure that native sign-out swallows.
The core drops native bodies and arbitrary headers; no bearer token is returned
in browser JSON. Library logs/router exceptions become fixed events. After-commit
notification failures remain `committed:true`, without automatic mutation replay.
The current composition uses schema 41 and provider storage revision 3. Contract 5
adds durable session issuance and changes no pinned dependency.

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

## A3-I12 factor compatibility experiment

`test/factor-compatibility.test.ts` runs the installed Better Auth/core 1.7.14
`twoFactor` plugin on the controller's sole temporary SQLite owner. At I12,
TOTP was an unselected compatibility candidate. The owner has since selected
both TOTP and passkeys as optional methods; the pinned TOTP implementation still
needs an accepted replay remedy. Production remains
schema 39, provider storage revision 1 and contract 2. This experiment changes no
production provider, route, actor, mode or migration. Account mode remains
unavailable; A4, A5, roles and GUI remain separate.

The fixture first provisions an ordinary password account. Its temporary owner
then compiles pinned `getMigrations` SQL, applies that SQL in an exclusive borrow,
and awaits real `checkSchema`. A second generation pass must have no outstanding
changes. The extended fixture is never reopened as a recognized production
store. Every fixture read and write uses that owner's borrow; there is no second
SQLite connection. Disposal drains provider work before closing SQLite and
checks owner-lock release. Generated SQL contains table definitions only and is
saved to `/tmp/a3-i12-factor-generated-ddl.sql` by the schema test.

The default `node:test:auth-provider-proof` preset includes both passing
characterization and ordinary failing `UNMET PRODUCT ACCEPTANCE` tests. The
latter assert that one accepted TOTP cannot authenticate another password
challenge, including reuse of an enrollment code. They are neither skipped nor
marked as expected failures. The pinned plugin accepts those reuses, including
through the bounded wrapper, so the proof suite stays red. Challenge single-use
and TOTP single-use are separate properties. A further acceptance regression
requires the account failure count to survive rollback after a failed guess.

Observed native behavior includes unverified enrollment followed by flag changes
and session-cookie rotation. Enrollment's JSON token names the deleted session;
the cookie identifies the persisted replacement. Password sign-in produces a
pending cookie without an authenticated session, and one queued completion wins.
Wrong guesses survive normally, the challenge budget exhausts, and account
lockout spans independent challenges. A fresh peer per request and a fixed,
restored clock keep the plugin's unrelated per-peer limiter and TOTP boundaries
out of those results. The observed five-guess challenge budget, ten-failure
account lock and other numeric library settings are fixture evidence only. Native
verification with an existing session counts neither the challenge nor the
account budget, even across eleven wrong guesses with distinct peers.

Recovery codes consume once across queued independent challenges and regenerated
codes replace the old set. Native verification also accepts a code from an
unverified factor. Native trusted-device login bypasses a later factor challenge.
Native sessions have no method or factor-verification timestamp. An old password
session survives another session's enrollment; the enabled flag does not prove
that session completed a factor.

`test/factor-provider.ts` retains native handler mode and two supported-context
probes. An outer core `runWithTransaction` is masked by `auth.handler`'s
`runWithAdapter`; the direct server API preserves the internal adapter context
but its direct `context.adapter` still differs. The probes return before an
unjoined SQL call could wait on Kysely's single connection. They do not claim to
execute that deadlock.

The bounded experiment instead supplies a real Kysely `Transaction` as the
short-lived Better Auth instance's database and sets its library transaction
option to false to avoid nested transactions. The outer Kysely transaction
remains real. Adapter methods, library globals and installed files are unchanged.
SQL traces verify that both direct factor writes and internal challenge/session
writes, fixture preflight and the stand-in evidence insert share that transaction.
This is fixture feasibility evidence, not an accepted production design.

Faults cover factor creation, flags, rotation, recovery-code and challenge
consumption, session creation, stand-in evidence, commit and cookie refusal.
A temporary SQLite trigger demonstrates partial native enrollment commits on a
later factor-write failure. A library create-session veto returns an error
Response after consuming a recovery code, while a SQL exception throws. The
wrapper rolls back success-critical writes and withholds cookies on failure,
and buffers invalidation until after commit. A failed notification remains
`committed:true`. Blanket rollback of every 401 erases failure accounting;
blanket commit of every error Response loses a recovery code without a session.

The bounded classifier and its separate challenge burn are experimental. Burning
a challenge is not durable account-level failed-guess accounting after a SQL
failure. A post-increment fault currently rolls that count back to zero; the
challenge burn does not repair it. The stand-in evidence table is not an approved evidence schema or a
controller authority source. Recovery results are marked restricted; this
implementation version cannot issue any controller actor. The wrapper fixes
`trustDevice:false`, rejects caller trust fields, strips incoming trust cookies
and rolls back any nondeletion trust cookie. Its closed route map denies native
OTP, disable, URI/code viewing, generation and catch-all routes. There is no
public factor integration.

Integration remains blocked on cross-challenge TOTP replay, authoritative
session-specific method/time and security-revision/purpose evidence, and a
reviewed durable failure-accounting design. This proof does not choose a recovery
policy, absolute/freshness deadlines, session caps, restore fence or production
factor. It does not certify disconnect cleanup, process restart, browser UX or
complete A3 acceptance. Further work must use supported library capabilities or
an explicitly reviewed alternative; no custom production replay crypto is added.

Primary API references: [Better Auth two-factor plugin](https://better-auth.com/docs/plugins/2fa),
[Kysely transactions](https://kysely-org.github.io/kysely-apidoc/classes/Kysely.html#transaction).
Installed pinned source and the runnable cases determine these findings.

## Isolated durable admission and receipt proof (A3-I13)

The separately selected `admitted` fixture candidate adds
`test/factor-admission.ts` and `test/factor-admission.test.ts`. Native and bounded
I12 candidates keep their original assertions, including all five negative
acceptance baselines. A3-I17 extends this same admitted candidate with the
monotone TOTP step described below. It cannot issue a controller actor. Production schema 39, storage 1, contract 2 and the password provider are
unchanged.

The temporary owner creates five `factor_admission_*` tables for subjects,
contexts, budgets, receipts and evidence. I17 adds one fixture step table.
`FixtureAdmission` exposes `bindContext`, `admit`, `settleSuccess` and `readReceipt` over its borrowed
connection. It owns no connection, scheduler or lock. The fixture policy is four
charged attempts per subject per fixed 60-second window, a 15-second ticket,
64 rows per bounded table and pruning batches of eight. Tests vary these inputs;
none is an approved product default. Charges include successful attempts. No
refund, success reset or administrative reset exists.

A native database session hook observes the subject and original password
session dates. Only the completed handler's actual challenge outcome permits a
binding: the whole issued opaque cookie is hashed with standard SHA-256 and
bound to that subject, native verification row, immutable purpose, security
revision, factor fingerprint and deadlines. Input cookies are never decoded to
choose a subject. Enrollment uses the supported current-session lookup and an
issued setup context. Its original password time and deadline come from persisted
evidence for that exact session, subject and security generation; native session
refresh cannot extend them. Missing, stale or expired evidence refuses enrollment.
Current mapping, principal, native challenge and factor
state are checked before admission. TOTP and recovery share one subject budget;
new challenges and provider reload cannot reset it. Unknown, forged, expired,
revoked and mismatched contexts never reach native verification.

Within the same exclusive borrow, a short Kysely transaction commits the charge
and server-owned attempt receipt. The caller confirms the receipt before a
separate transaction invokes the real native handler on a transaction-scoped
Kysely instance. Persisted session/cookie confirmation, password evidence and
success receipt join that second transaction. Evidence retains the original
password authentication time/deadline; factor sessions are capped to the original
deadline. TOTP, enrollment and recovery observations explicitly have
`authorizingMfa:0` and retain method `password`. They cannot supply stronger
authority from this experimental backend.

SQL fault seams distinguish errors before COMMIT from errors after the driver
actually commits. Admission errors always stop evaluation, even when a durable
charge is reconciled. Success errors read the durable completion receipt under
the same owner, only after confirming that the transaction has ended. Failed
COMMIT plus failed ROLLBACK cannot publish its uncommitted receipt or notifications;
the owner performs final rollback and closes provider admission. A failed receipt
read reports an unconfirmed outcome without retrying verification. A known committed success withholds cookies on lost
acknowledgment, returns only receipt status and delivers buffered notifications.
In `runtime.browser`, the controller takes the new session's identity from the evidence
this provider writes in that transaction, and removes only that session after settlement.
The provider contract has no separate call for it. `browser-session-cleanup.test.ts`
proves the bound and the lost-acknowledgment, reconciliation and cleanup-timeout paths
through the actual HTTP listener.
Notification failure retains `committed:true`. Internal duplicate IDs return
status without evaluating any submitted credential or minting another session.
Clients cannot choose these IDs. Returned native errors, SQL faults, session,
cookie and evidence vetoes roll back success writes while retaining the charge.
Cancellation checks run before admission, before native continuation and after
native completion. A timed-out borrow closes provider admission, refuses late
SQL and retains a charged row; teardown waits for the actual execution to drain.
An unresolved charged receipt is never evicted to make room.

Tests use real correct and wrong credentials, two provisioned subjects, fixed
restored time, serialized queued requests and the actual module-global memory
IP limiter across short-lived auth instances and provider reload. Peer addresses
come only from the trusted fixture transport. There is no server-API verification
path in this candidate. SQL traces contain statement text and transaction flags,
never parameters. Sentinel tests also exercise failed assertion diagnostics.
Trace artifacts are written privately under `/tmp/a3-i13-*-trace.json`.

This is reload on one temporary owner, not process restart, backup or production
schema acceptance. One timeout test reads the existing owner's admitted core
facade after provider admission has closed; it opens no connection. Receipt
pruning is bounded and removes only expired terminal rows. Uncertain live rows
can permanently consume capacity until a separately designed reconciliation
policy exists. Password/challenge-creation admission, global fairness, final
numeric policy, external restore fencing, public transport and disconnected
response cleanup remain integration work. Password sessions still require the
existing production evidence/authority gates. Full A3 remains in progress.

## A3-I17 TOTP step candidate

`test/factor-replay.test.ts` extends the existing `admitted` candidate, with the
same owner, exclusive borrow, Kysely boundary, committed attempt charge and
receipt protocol. It replaces the A3-I16 lifetime presentation ledger. The HMAC
key and commitment, marker table, 256-row capacity and their tests are removed.

Native Better Auth/core 1.7.14 remains the OTP verifier, and its success remains
necessary. Installed `@better-auth/utils` 0.5.1 checks counters -1, current and
+1, then returns a boolean. It exposes no matched counter or clock sample.
`src/totp-step.ts` is a reusable post-native observer built on the public
`createOTP(...).hotp(counter)`, pinned exactly in this private package. There is
no handwritten OTP verification, fork or patch. The default provider does not
import it. The observer can only refuse more; it never supplies a success native
did not grant.

The rule runs only after a real native success:

1. Native receives the shared `TOTP_SETTINGS`: 30-second period, six digits.
2. `t0` is sampled immediately before the native verification entry and `t1`
   after native returns, inside the same success transaction.
3. The bracket is `floor(t0/P)-1` to `floor(t1/P)+1`. Nonfinite, unsafe,
   fractional or negative times, negative counters, `t1 < t0` even within one
   period, and a span above three are refused. At most four counters are ever
   evaluated, so no loop depends on elapsed time.
4. Every counter in the bracket is evaluated with a fixed-length digit comparison
   and no early exit. The set must be nonempty. The candidate is its maximum, so
   a digit string matching two counters consumes both.
5. `factor_totp_steps` holds one `last_step` per opaque subject. A guarded
   `INSERT ... ON CONFLICT DO UPDATE ... WHERE excluded.last_step > last_step`
   must change exactly one row, in the same transaction as enrollment or session
   writes, evidence and receipt.

Any refusal rolls the whole native success back: no cookie, session, evidence or
step. A match is a policy witness inside an observed interval. It is not native's
exact matched counter. Coverage of native's window assumes its clock sample lies
between the observed instants. An unobserved excursion may let native accept an
older counter while the same digits match a newer observed witness; that
collision can succeed. Exact native-counter provenance would require a separate
clock/verifier contract or native metadata. Wrong codes write no step, and
the earlier committed charge stays. Failed COMMIT plus ROLLBACK, unreadable
receipts and lost acknowledgments keep the existing no-output, no-cookie and
no-automatic-retry rules.

The counter is independent of factor row, secret, generation, purpose, session
and ciphertext. Replacement, verified toggles, re-encryption, reload and clock
changes never reset it, and no reset API exists. A future audited reset can
reopen consumed steps, so it needs its own management decision. Row ID plus a
ciphertext hash is only a staleness check on live contexts: a re-encryption
during an attempt fails closed, and the counter still refuses a replay on a
later context. The fixture stores no raw code, code hash, presentation history
or secret plaintext.

The observer decrypts with the library's `secretConfig`, so versioned secrets
keep working. It accepts native-generated text only. Imported `base32:` secrets
decode to different bytes natively, so `readNativeTotpSecret` refuses them.

User consequences are strict and deliberate. A second ceremony in one step needs
a newer code. After a future-window code the wait can exceed 30 seconds, because
the device must first show a code beyond that future step. A success while the
clock runs ahead keeps the counter ahead after correction, so TOTP refuses until
real time passes it; recovery or a passkey remain the alternatives. A later
identical decimal string at a newer counter is accepted, proved with `393421` at
counters 59788416 and 59788440. `768734` matches counters 61331809 and 61331811
inside one native window, and the higher step is consumed once. Restoring an
older database can reopen steps; A5 owns that fence.

Only the private fixture handler exposes these additional POST operations:

| Path | Exact body | Result |
| --- | --- | --- |
| `/two-factor/reauthentication-context` | `{}` with the existing signed session cookie | A short-lived opaque context for that exact current session, factor, principal mapping, generation and original password lifetime; no cookie |
| `/two-factor/reauthenticate-totp` | `{context,code}` with that same session | The native authenticated verifier, admitted once per context; nonauthorizing `{outcome:"observation",authorizingMfa:false}` with no cookie or new session |

The reauthentication capability is spent in the committed admission transaction,
even for a wrong code. A fresh context can be issued independently, while the
step spans enrollment, login and reauthentication. Neither the native JSON token
nor enrollment authority is used to pretend that an existing session became a new
login. Original password authentication/deadline, method `password`, factor count
1 and `authorizingMfa:0` remain unchanged. Current revocation, mapping, factor,
session and generation checks run before admission, before native continuation
and at settlement. Recovery codes retain native single-use behavior and the shared
charged budget; they consume no step.

The focused suites use real native verification and an independent client. They
cover all ceremony directions, the next step after each, concurrent challenges,
exact ASCII and leading zeros, the 29.999 boundary, a period crossed during the
call, reversal inside and across a period, oversized and invalid observations,
later decimal collisions and a two-match window, many successes with one row,
independent subjects, native replacement, re-encryption, current-state mutations,
zero-row updates, cancellation, SQL/COMMIT/ROLLBACK/read faults and lost responses.
Inherited I13 fixtures enroll on the previous window step so the current step
stays available. All five ordinary native/bounded acceptance failures remain
untouched and unskipped.

This is a helper plus a fixture proof, not production activation. Production
needs its own migration, storage revision and evidence port, and failed-guess
accounting stays separate. No production actor, session-method upgrade, public
API, ASVS Level 2, account activation or completed A3 claim follows. Parent review
and acceptance remain separate. This fixture remains a historical proof; A3-I18 below
is the integrated provider.

## A3-I18 integrated factor authority

`src/index.ts` is now the real integrated provider: pinned two-factor and passkey
plugins, a closed route list, and ceremonies in `src/factor-ceremonies.ts` over the
controller's `host.protection` port. It runs on recognized migration 40 storage,
closes and reopens through `SqliteStateStore`, and issues real provider actors through
`runtime.authenticate` into `ProviderKnowledgeApplication`.
`test/integrated-factor-authority.test.ts` is its acceptance suite. See the
[contract and limits](../../docs/authentication.md#integrated-factor-authority).

Routes outside the list return 404, including every native route not listed in
`FACTOR_ROUTES` or `NATIVE_ROUTES`. Sign-in strips all cookies, so a trust cookie cannot
choose a native branch. Each native operation runs in a scoped library instance
sharing one Kysely transaction. Notifications wait for a known COMMIT.

The earlier factor and passkey fixtures remain as historical proofs on their own
fixture tables, and they cannot issue actors. Their five `factor-compatibility` negative
baselines still characterize native and old bounded behavior and still fail, so the
whole proof command reports failure. Report those five separately from integrated
acceptance. They do not describe the integrated provider, and they must not be
inverted, skipped or moved without a transparent, separately reviewed decision.

Evidence is the persisted row, not the provider's claim: `resolveSession` reads
it and the runtime rejects a claim that disagrees. Limits must be supplied through
`factors`. Test limits live in `test/integrated-fixture.ts` and are not product values.

Not proved here: process restart under a real service, versioned `secretConfig` and
`base32:` secrets end to end, A4, A5, final failed-guess policy, factor management or
recovery. No account activation or complete A3 follows.

## A3-I20 closed factor HTTP matrix

`browser-factor-authentication.test.ts` enters through the actual
`createControllerServer` and `AuthenticationHttp`, then the closed runtime operations,
the pinned provider, schema 40, a runtime actor and current Knowledge policy. Cookies move
only through a real jar. It reuses the independent OTP generator and the software P-256
authenticator, with no success stub, fake verifier or inserted evidence.

The file covers no selection, TOTP only, passkey only with `none` and `packed`
attestation, both methods in both addition orders, and WebAuthn refusals for UV, UP, RP,
origin, challenge, handle, signature, replay, counters and swapped accounts. It also
covers current-state release, authority ceilings, exact body and cookie limits, raw
duplicate headers, real socket aborts, slot retention, anonymous flooding, COMMIT and
receipt faults, notification failure, unconfirmed cleanup and store reopen.

Fixture limits are finite inputs chosen to prove bounds: `LIMITS` and `TRANSPORT_LIMITS`
in `test/integrated-fixture.ts` and `test/browser-authentication-fixture.ts`. The peer,
global, peer-map, native-row and reservation values are not owner-approved.

The temporary Unix listener is not a managed server. These cases prove real cryptographic
verification through the HTTP handler, not a browser engine, hardware provenance, TLS,
proxying or a service-process restart.

## A3-I14 passkey proof

The owner selected both authenticator-app TOTP and passkeys as optional methods
on 2026-11-02 ("Kody i passkey", then "Opcjonalne"). That supersedes the earlier
engineering proposal requiring MFA for every human. An account without optional
enrollment can use a password; enrolled/selected protection cannot be bypassed
through an unprotected password path. Methods are alternatives, not mandatory
sequential TOTP plus passkey checks. Enabled flags grant no roles or privileges.
Current production identity hard guards remain. See the
[policy record](../../docs/authentication.md#owner-selected-optional-methods).

The new `test/passkey-*` files are a separate, nonauthorizing backend experiment.
The default provider is unchanged. Only this private package adds exact
`@better-auth/passkey` 1.7.14; its locked runtime uses SimpleWebAuthn server
13.3.3 and browser 13.3.0. Better Auth/core remain 1.7.14, Kysely remains 0.28.17,
and the existing root SQLite driver remains 13.0.3. Additional locked runtime
notices are in `THIRD_PARTY_NOTICES.md`. Community has no provider/passkey runtime
import, and packaging checks scan fresh CLI/dashboard assets for implementation.

The temporary SQLite owner generates candidate passkey DDL with pinned
`getMigrations`, applies it inside its existing exclusive borrow and awaits real
`checkSchema`. Production schema 39, storage 1 and contract 2 are unchanged.
No extended fixture database is reopened through the production inspector.
Each operation uses that same owner and lifecycle gate. The fixture origin is
`https://controller.test` and RP ID is `controller.test`; neither is client input
or live host configuration. A production integration needs a stable, operator-owned
HTTPS origin/RP decision before credentials can be enrolled.

An independent test authenticator uses Node crypto with ephemeral P-256 keys,
packed ES256 self-attestation and signed assertions. It does not mock verification,
implement a production verifier or claim authenticator hardware provenance.
A3-I15 extends this same provider to privacy-preserving `fmt:none` enrollment.
Registration options now request `none`; verified packed self-attestation remains
supported with its prior signed-UV behavior. Native `fmt:none` checks structure
without an attestation signature. The fixture ignores its unsigned UV bit and
stages the native credential without trust, selected protection, session evidence
or a new session/cookie. Staging binds the exact native row/key fingerprint,
subject, issued handle, original password session, generation, immutable password
deadline and enrollment purpose. It expires at the earliest of the original
registration challenge deadline, password deadline and original ten-minute
password freshness boundary.

`GET /passkey/generate-confirm-options` requires the original session and an
existing staged context capability. It issues a fresh native authentication
challenge restricted to that exact candidate. `POST /passkey/verify-confirmation`
accepts only `{response}` and uses actual native signature verification plus
verified signed UP/UV and stored-handle matching. Current bindings are checked
before admission, at native entry, in the verification callback and at settlement.
Normal login refuses staged keys. Existing passkey or TOTP protection refuses
this password-session enrollment path; management needs its own reviewed proof.

Confirmation commits its one-use charge before verification. Its separate success
transaction joins the native counter update, trust promotion and completion
receipt. The native endpoint always creates a session; the wrapper deletes that
exact new session through the library's internal adapter before committing and
suppresses all native cookies and body tokens. It stores no evidence for the
deleted session and keeps the original password session and evidence unchanged.
Its deletion notification names only the ephemeral session. Later normal passkey
login can create the existing nonauthorizing `passkey_uv` observation. Promotion
does not authorize old sessions or activate production policy.

Staged entries use the existing fixture capacity of 64 and cleanup batch of 8.
Cleanup removes an expired native row only while it still matches the staged
subject/fingerprint and has no trust. It preserves trusted or replaced rows and
candidates with unresolved charged receipts. These are fixture limits, not
approved product defaults. The focused staged-enrollment tests cover real signed
confirmation, unsigned/forged UV, binding and revocation at every phase, zero
counters, replay/concurrency, rollback-restored challenges, COMMIT uncertainty,
failed rollback, lost output, provider reload on the same owner, immutable
deadlines, capacity and cleanup.
Both native verifiers set `requireUserVerification:false` in this pinned plugin.
Supported `registration.afterVerification` and `authentication.afterVerification`
callbacks require actual verified `userVerified:true` before trusted packed
enrollment, confirmation promotion or normal login. Untrusted `none` staging is
the sole structural-registration exception. Registration requests require UV through the
plugin option. Native assertion options hard-code `preferred`; the bounded
response sets `required`, independently of the server callback check. Signed UP
alone, forged client UV metadata and tampered signatures never substitute for UV.

Native registration issues a random user handle without storing it on the
credential. Native assertion does not bind that handle. Nonzero counters must increase;
zero-only authenticator counters remain natively supported and cannot supply
clone detection. Challenge replay is still denied. The fixture stores the
issued handle with its exact mapped subject, verified enrollment UV, native
credential fingerprint and security generation, then checks it in the supported
authentication callback. Only current trusted credentials qualify for login;
the dedicated confirmation operation alone can verify a bound staged key. The library's
passkey model has no enrollment UV history, session method or security generation.
Those missing durable bindings are an integration gate, not invented upstream
metadata. The fixture's method is explicitly `passkey_uv`, never password plus
an imaginary second factor. Its evidence is nonauthorizing and its implementation
version cannot mint a controller actor.

A committed admission transaction reserves one ceremony capability and charges a
bounded subject budget before native entry. A separate transaction-scoped native
auth instance joins credential/counter/session writes, UV trust, evidence and
completion receipt. No independent connection, lock or copied library adapter is
introduced. Failure rolls back success writes while retaining the charge and
spending the wrapper capability. A lost output or blind retry cannot re-enter
that ceremony. Real COMMIT acknowledgment failure is reconciled only after the
transaction has ended; an open or unreadable outcome withholds authority. The
owner gate handles an abandoned transaction. Observations and SQL-only traces
are bounded; parameters, native JSON bearers and private keys stay out of DTOs,
logs and handoffs. Session cookies remain private response credentials.

Fixture-only conservative restrictions refuse passkey replacement/removal,
password fallback after passkey protection, public signup, trusted-device use,
recovery and unreviewed management endpoints. Existing sessions do not acquire
stronger evidence at enrollment. A real TOTP interop case uses the existing
isolated factor provider for setup, then checks that password login remains
pending and verified-UV passkey is an alternative. It does not accept TOTP replay
or promote that experimental provider into production. The inherited four replay
failures and old bounded counter-loss failure remain ordinary failing tests.

The exact next integration needs a controller-owned policy port for binding
current subject/purpose/session/credential generations and immutable deadlines,
committing admission before verification, settling actual session evidence in
the success transaction, and reading receipts without re-evaluation. Passkey
bindings must retain the native-issued handle and UV enrollment trust; current
session projection must distinguish `password` from `passkey_uv` using durable
session-specific evidence. Contract 2 cannot express this. Proposed fixture
methods in `passkey-admission.ts` are executable evidence, not approved
production tables or final product defaults. Safe management/freshness/recovery,
production migrations/backups, complete transport/cookie/disconnect treatment,
accepted TOTP replay handling and A5 remain public activation gates. Optional
policy is documented and proved locally only; no live activation, mandatory MFA
role policy or ASVS conformance is implied. Full A3 remains in progress.

## Durable session restart (A3-I22)

`pnpm test:auth-provider-session-restart` runs `scripts/auth-provider-session-restart.mjs`.
It builds `test/fixtures/session-restart-worker.ts` and the provider into private temporary
output, and neither ever reaches Community `dist`. Each boot is a fresh Node process with the
real controller and database locks, `openControllerStore`, the shared isolated HTTP
composition and the owning shutdown. Software TOTP and passkeys drive it over a Unix socket.

The parent signals only a `ChildProcess` it spawned, after that child's nonce and PID
handshake, and waits for actual exit before starting the next owner. A live challenger is
refused while the owner runs. The next owner replaces the stale records through the normal
path, and nothing unlinks a lock. Cuts hook real statements and the real final phase in the
worker, so no fixture writes session state. It covers kills inside the mint transaction,
after native COMMIT, inside and after the publication transaction, and after the parent
received a cookie, with repeated crashes for all four evidence writers, capacity across
boots, recovery batches, a private clock for expiry, and a restored snapshot.

It uses U=2, B=4, Q=1, which are test inputs only. Ordinary fixtures use finite larger
bounds through `ISSUANCE`, and `readyIssuance` runs the owner's recovery before a load.
In-process faults that need a live runtime, such as unreadable markers and failed cleanup,
are in `browser-session-issuance.test.ts`. Migration and tamper cases, including the frozen
`schema-v40.sql`, are in `authentication-session-issuance-migration.test.ts`. The proof
covers neither a browser, hardware, TLS, a proxy nor the installed service.
