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
password-change JSON; production browser API design remains open. Core queries
currently fail with `busy` during a borrow. Restoring backups can restore old
sessions and passwords until A5 adds an external revocation fence. A2 credentials
remain unchanged; A4 vault authorization still requires its separate proof.
Human enrollment, factors, invitations, role administration, GUI and account
activation are outside this slice. See the
[authentication contract](../../docs/authentication.md#optional-provider-proof-first-a3-slice).

Upstream licenses are reproduced in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
