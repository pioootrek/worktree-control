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
| Schedules/restore | Actual automatic tick and current export grants; installed HTTP finish/close/already-disconnected handoff, one deferred launch, current revocation, refused shutdown blocks execution and retains owner | Physical replacement/restart is mocked; concurrent CLI shutdown remains blocked below |
| Storage/logs | One save per completed scan, duplicate coalescing, close while save waits, retention lookup waiting/refusal preserves files | Global scan backlog bounds and all retention/drain failures |
| Lifecycle/shutdown | Same-project serialization and idle admission; owning service drains real process completion/backup; actual CLI sequence closes HTTP/MCP/admin/remote Unix listeners, refuses queued HTTP dispatch in maintenance and drains accepted admin completion; service failure retains database owner | Three preserved CLI failures: controller lock released on failed drain, both owners released despite listener failure, concurrent shutdown returns early |
| Provider Knowledge handoff | 25 real-provider cases: exact opaque actor, current session/mapping/principal/grant/role, queue/idle/lock/replay, failed notification, rollback, substitutions, original-expiry cap, drain/disposal and denied privilege elevation | No transport mounting, login or account-mode activation |
| Local readiness | Installed HTTP reservation/force-release queue behind readiness; installed admin rotation invalidates the installation actor before the accepted local operation returns 200 | Existing unscoped runtime does not reauthenticate after readiness; injected direct-store takeover is not transport evidence |
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
- **Tested restore boundary:** five `restore-http-handoff.test.ts` cases use
  the installed HTTP handler, real durable restore admission/launch and owning
  CLI shutdown. Finish then close, close then finish and an already-disconnected
  response each launch once. Revocation ordered before deferred admission
  denies restart; unconfirmed cleanup prevents execution and retains both
  owners. On successful nonconcurrent shutdown the database owner closes
  before the execution callback while the controller lock stays held. Physical
  replacement and starting the next controller are mocked. A 202 response
  records admission, not successful restore.
- **Blocked CLI gate:** `cli-shutdown-admission.test.ts` invokes the actual
  shutdown sequence extracted unchanged from `src/cli/index.ts` into
  `src/server/bootstrap/controller-shutdown.ts`. Installed HTTP/MCP/admin/remote
  listeners use temporary Unix sockets. The successful test refuses queued HTTP dispatch in maintenance, drains its
  response and the already accepted admin write/response once, rejects new
  work, then releases both locks. Three failing regressions preserve actual defects: failed provider
  drain releases the controller lock while the database lock remains; failed
  listener closure still closes the database/releases the controller lock;
  concurrent handoff shutdown resolves before the first provider drain.
  `ControlService.shutdown` passing alone does not close these gates.
- **Readiness classification:** `lifecycle-admission.test.ts` drives installed
  HTTP operation/reservation/force-release handlers. Both mutations wait behind
  readiness with no admitted lock waiter; the old direct-store reservation
  injection is not a supported transport takeover. The installed admin
  token-rotation handler can change authority during readiness. The old
  installation actor becomes invalid before the accepted local operation
  returns 200. This passing characterization records a current-authority
  limitation of the existing installation runtime path, not scoped/provider
  authorization acceptance. Scoped natural lease expiry has separate tests.
- **Separately deferred:** real host reboot/recovery, all dependency-install
  cleanup failures, broader route/tool permutations and global scan-backlog
  bounds need their own focused evidence. Compatible-mode recovery tests in
  `src/server/modules/remote-verification/remote-worker-recovery.test.ts` and
  `worker-owner-recovery.test.ts` cover many of these state machines; they are
  not strict held-provider evidence. Account enrollment/factors/browser API,
  A4 vault policy and A5 cutover/external restore fencing remain separate gates.

The implemented handoff resolves the provider outside core admission and checks
current stored authority synchronously inside each Knowledge call. Resolving
the provider inside admitted core work is still rejected as reentrant. Call
the application again after idle/lock waits before a new effect or replay.
No production provider loading or login integration is added.
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
without changing production behavior. Build/fresh package verification are
withheld because these backend blockers remain. A prebuild artifact scan skip
or an older build does not certify the changed CLI/static dashboard. Final
check/docs run evidence belongs in the owning Knowledge task and handoff.

A failed strict regression blocks live-coexistence acceptance. Keep it failing
until production code is fixed; do not weaken it or use build/package success
as a substitute for admission acceptance.

Upstream licenses are reproduced in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
