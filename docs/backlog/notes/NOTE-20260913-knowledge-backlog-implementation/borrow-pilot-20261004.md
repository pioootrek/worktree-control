# Borrow Everything: first local project cutover

Date: 2026-10-04. Status: production import and Borrow source cutover complete.
The owner first authorized the pilot, asked us to wait for Poziomka's work to
finish, then confirmed completion and authorized closing this migration.

## Approved source and scope

- Repository: `/home/pioootrek/development/borrow-everything`.
- Source: clean `master`, matching remote `master`, commit
  `b01134689688bd81623b50b4be02ccfe5fea8886`.
- Knowledge target and import source ID: `borrow-everything`.
- Installed controller: `1be609bda1a54b2385ba8e607224c876b8544b95`, schema 28.
- Import validator: clean Hub `22afb656c74b2fde84cb92f1aefcf8b427697cc6`.
- Approved mapping version 2 plan hash:
  `d760c7ec4e7bb3cf7691dcad27466bd178a67f706a7ef7ead67ca16625c13aa7`.

The plan contains 10 open tasks, one completion and 10 embedded historical
comments. It has no missing files, conflicts, unresolved relations or
attachments. Twenty documentation/instruction files remain external sources;
product documentation continues to be maintained in Git. Configuration is
import metadata and the generated index is skipped. The complete original
payload and source provenance must be retained, including fields that are not
promoted to editable task fields.

Borrow was selected because it is small and synchronized. The local Hub
checkout differs from remote `main`; this pilot does not update that checkout
or choose between its versions. Other projects are outside this cutover.

## Backup and rehearsal gates

Private evidence root:
`/home/pioootrek/wts-recovery-20261004-qtlq4_wi/knowledge-pilot-inventory-fz64wtlg`.

The supported online manual backup completed successfully in `online-backup`.
Its database SHA256 is
`a0247d8027b421224944bc5e03ae92a050c65f1e38f7094c88a419bd27620ea9`.
Schema 28, SQLite integrity and foreign-key checks passed on the backup copy.
All 152 attachment objects (7,092,925 bytes) matched their sizes and hashes.
The backup contained two knowledge projects and no Borrow target/source
collision. Automatic backup policy was not enabled.

The import CLI owns the singleton lock and therefore requires an offline
controller. The backup was restored into an isolated private directory and
the approved plan executed there. No listener or development server started.
The rehearsal completed with exit 0 and `passed: true` in
`rehearsal-summary.json` under the private evidence root.

| Verification | Result |
| --- | --- |
| Import | 7 chunks, all 43 mappings published, `installation_token` attribution |
| Imported records | 11 tasks, 10 discussion threads, 10 replies, 10 relations |
| New attachments / memories | 0 / 0 |
| Original payloads, source hashes, commit and provenance | All 43 verified |
| Task title, description, status and priority | All 11 verified |
| Embedded comment text and original author/date payload | All 10 verified |
| Existing data and grants | No original rows changed or missing |
| Identical import retry | Same batch and all database tables unchanged |
| Logical export | Counts and payload hash/size verified; 43 import sources |
| SQLite checks | Integrity OK, zero foreign-key violations |

Logical export payload SHA256:
`9c127fe2567a62be78db9bd9a6e85879fd9f316429647b755400e23c6df4912f`.
This proves the offline import and export of this fixed source. The later
production acceptance is recorded below.

## Initial maintenance deferral

The fresh preflight on 2026-10-04, reviewed at 13:39 UTC, found an active
claim on **Poziomka na szlaku**, running from
`/home/pioootrek/development/szczyrk`. WinPath was also running without a
claim; the other two runtime projects were stopped and the test queue was
empty. The active claim belongs to another working session. Its expiry is
not a maintenance appointment: renewal or new work may keep it active.

The controller was not stopped during that first stage. Production import
and source cutover waited for the owner to confirm that the other work had
finished. The later preflight found zero claims, an empty queue and no runtime
transitions. Borrow still matched its approved source commit and remote
`master`; the installed CLI hash was unchanged.

## Production import and acceptance

Private evidence root:
`/home/pioootrek/wts-recovery-20261004-qtlq4_wi/borrow-pilot-live-90c0b4ci`.

The same installed service was stopped through the supported CLI. A fresh
offline backup completed and passed verification before the import. The
approved plan published all 43 mappings in seven chunks, attributed to
`installation_token`. A second offline backup verified the result on a copy.

| Backup | Database SHA256 |
| --- | --- |
| `final-offline-backup` | `165934fa88498dcb5b5249627afe961b58f88ab305c828931beaa7eff745ea3a` |
| `post-import-offline-backup` | `db6f67a53bf58492dcafb82824d7a72322c6a1a594b91eacabbfab32f30556e6` |

Both copies passed schema 28, integrity, foreign-key and all 152 attachment
hash/size checks. Every original row in all 30 tables was preserved, including
knowledge, runtime registrations, credentials, grants, remote identities and
controller settings. Only observational credential `last_used_at` timestamps
were excluded from comparison. Imported content passed the same full fidelity
checks as the rehearsal.

The controller restarted using the same installation; the observed new PID
was 285755 with `NRestarts=0`. The first helper exited 1 because its HTTP
probe ran immediately after service start, before the listener was ready.
The import had already succeeded. The failed report was retained; acceptance
continued against the ready service without reimporting or rolling back data.

Previously running servers were restored sequentially through owned MCP
claims, then both claims were released:

| Project | Restored worktree | Port | Health check |
| --- | --- | --- | --- |
| Poziomka na szlaku | `/home/pioootrek/development/szczyrk` | 3003 | Configured HTTP returned 307 |
| WinPath | `/home/pioootrek/development/.worktrees/win-path-6/se-forecast-integration` | 3000 | HTTPS 200, certificate verification result 0 |

The other three runtime projects remained stopped. The final queue was empty.
Fresh MCP reads compared all 11 imported tasks, 10 threads and 10 replies
against the verified copy. A useful native cutover thread was created once:
`84abbfee-b256-41bb-bb77-bff514a59cd9`. The identical retry returned the same
record with `replayed=true`, and a new independent MCP session read it back.
An initial harness assertion compared the whole response envelope, including
the intentionally changed replay flag; that failure was retained and corrected
without creating another record. `acceptance-summary.json` reports terminal
`passed: true`.

The root independently confirmed HTTP access to all 11 tasks: 10 active,
one done, no further page. This task did not rerun browser automation or
claim acceptance of every Knowledge UI flow.

## Source ownership and recovery

After production acceptance, Borrow commit
`060e9fe34f75440a7b6d4319d42bd3b59de5a298` was pushed to `master`. It updates
the root and backlog `AGENTS.md` plus `docs/README.md` to make Knowledge project
`borrow-everything` the single writable backlog/discussion/agent-memory store.
The `CLAUDE.md` companions retain `@AGENTS.md`. Every archived backlog JSON
file remains unchanged from the imported commit; there is no bidirectional
synchronization. Product documents remain Git-owned.

Hub `fmt`, `validate` (10 items, one done, 15 documentation pages) and
`git diff --check` passed. Borrow's working tree was clean after the push.
The parent shared-memory feature remains open: this completes one project's
cutover, not the migration of all repositories or the future playbook work.

The native cutover thread received an idempotent completion reply naming the
Borrow documentation commit. A fresh MCP session read the saved reply. A
final online manual backup, `final-online-backup` under the live evidence
root, completed successfully and includes that thread and reply. Its
database SHA256 is
`4257413333dff2ff81642567c84a7c7182f62f11036aed62df4a80c0f7a77864`.
Schema 28, SQLite integrity, foreign keys and all 152 attachment hashes passed
verification. Service, user and remote backup schedules remain disabled.
The user policy was read with the existing owner credential; the installation
token's 403 on this owner-specific route was an authorization boundary, not
a failed Knowledge login. No credentials or grants were changed.
`final-summary.json` records the completed acceptance. Borrow now contains
11 tasks, 11 threads and 11 replies, including the native cutover thread and
completion reply, plus 10 relations and 43 import source records.

A later rollback must first preserve all post-cutover changes using an export
or a fresh backup. The archived files do not include later Knowledge writes.
Restoring the full pre-import controller backup would also revert unrelated
projects and credentials, so it is not an automatic project rollback. A
failed future migration must leave source ownership explicit and retain
evidence for recovery.
