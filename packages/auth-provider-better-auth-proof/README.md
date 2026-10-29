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
the direct command above. No server or listening fixture is needed.

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
Setup and inspection can enter admission explicitly. HTTP handlers are invoked
through their installed Node request listener without opening a socket. MCP
uses the actual runtime's protocol registration over the SDK in-memory wire.
Automatic renewal runs its production timer callback with a manual session
clock. The tests do not wrap boundary calls in extra admission to conceal
missing production scopes. Filesystem/host/network effects use temporary
fixtures and mocks; finite-job cases run a real short Node process.

| Boundary | Strict held-provider evidence | Remaining acceptance work |
| --- | --- | --- |
| HTTP | Commit/rollback wait, single mutation and receipt replay, queued revocation, malformed 400, initial and body-read re-admission contention 503 with Retry-After | Broader route inventory |
| MCP | Actual in-memory request wrapper, commit/rollback wait, current identity after revocation, scoped readiness and retained retry | Full HTTP MCP transport authentication/body behavior and broader tool/resource matrix |
| Automatic renewal | Contention deadline and retry preserve claim; queued credential revocation/expiry and session close prevent renewal | Lease expiry during an admission wait |
| Remote controller | Poll/report wait on commit/rollback, exact report replay, current worker grant at delivery | Submit/cancel transport races and worker credential expiry |
| Remote worker | Current-state ACK merge retains cancellation, SQL-free network phase, receipt before preparation, ordered running/terminal outbox | Crash/restart matrix under strict admission and concurrent appended-report ACK race |
| Workspace preparation | Real preparation adapter, committed recovery provenance before mock Git effect, SQL-free wait and mapping revocation after re-admission | Dependency-installation and all cleanup/refusal paths under strict contention |
| Vault | Proof expiry, grant revocation before retained plaintext replay, owner credential revocation | Broader role/grant/once-receipt and expiry combinations; A4 policy unchanged |
| Schedules/restore | Actual automatic tick, current export grants, deferred launch admission, current restore authority, failed restart retains owner | Complete CLI response/listener shutdown and restore execution handoff |
| Storage/logs | One save per completed scan, duplicate coalescing, close while save waits, retention lookup waiting/refusal preserves files | Global scan backlog bounds and all retention/drain failures |
| Lifecycle/shutdown | Two same-project operations, provider during idle, no admitted project-lock waiter, new work refused while accepted work drains | Lock-order design acceptance and complete bootstrap shutdown; local readiness authorization gap is characterized separately |
| Shared branches | Joined SQL is refused while a sibling idles; detached participants remain independent | Dashboard fan-out retains admission during Git; this is no blanket safety claim for concurrent joined branches |

`live-admission.test.ts` also retains the original strict proofs for running-job
output/exit durability, current Knowledge event grants, status long-poll release,
backup/drain ownership, late provider continuation denial and forbidden nesting.
`better-auth-proof.test.ts` retains the earlier adapter regressions, including
abandoned-iterator cleanup, omitted driver arguments, sanitized dispose failure
and subject-wide invalidation only after commit for more than 100 sessions.

A provider-to-core resolution handoff is deliberately deferred. Resolving the
provider inside admitted core work is rejected as reentrant; resolving before
core admission would leave an authorization gap. Neither is a login integration.
`idle` suspends an entire joined participant and requires sequential SQL phases;
independent branches need their own detached admission. Project-lock waiters
release admission, and callbacks re-enter under the lock. Current limits are
5 seconds for admission, 60 seconds for persistence retry and 10 seconds for
database drain. They are implementation limits, not account-security defaults.

A failed strict regression blocks live-coexistence acceptance. Keep it failing
until production code is fixed; do not weaken it or run build/package
verification as evidence that admission is complete. General compatible-mode
suites and the pre-build resource scan's explicit skip do not close strict
coverage gaps or certify a fresh Community artifact.

Upstream licenses are reproduced in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
