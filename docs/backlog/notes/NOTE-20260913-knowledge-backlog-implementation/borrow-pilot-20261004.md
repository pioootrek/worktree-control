# Borrow Everything: first local project cutover

Date: 2026-10-04. Status: rehearsal passed; production import is waiting for
an active claim on another project to end. Source cutover has not been
performed. The owner authorized starting a small
project pilot after confirming that the installation token works.

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
This proves the offline import and export of this fixed source. Production
MCP write/read acceptance and actual source cutover are still outstanding.

## Live maintenance gate

The fresh preflight on 2026-10-04, reviewed at 13:39 UTC, found an active
claim on **Poziomka na szlaku**, running from
`/home/pioootrek/development/szczyrk`. WinPath was also running without a
claim; the other two runtime projects were stopped and the test queue was
empty. The active claim belongs to another working session. Its expiry is
not a maintenance appointment: renewal or new work may keep it active.

The controller was not stopped and no production knowledge import, identity
change or repository source cutover was performed. The online backup was the
only production mutation in this pilot stage. The owner was informed that
the import must wait for a free maintenance window. Recheck the complete
runtime/claim/queue state immediately before proceeding; do not rely on this
dated snapshot or stop another agent's work.

Before production import, inspect fresh claims, queue state and managed
runtime placement. Once the system is available, stop the controller for the
bounded maintenance window, take and verify a final offline backup, execute
the same plan through the supported CLI, and start the same installed
service. Restore any previously running managed server through MCP at its
original discovered worktree and port. Check the imported data and a durable
write/read through fresh MCP sessions.

## Source ownership and recovery

Only after successful production acceptance, update Borrow's repository and
backlog instructions to make Knowledge the single writable backlog. Keep the
existing JSON files as the frozen pre-cutover snapshot; do not delete them or
introduce bidirectional synchronization. Product documents remain Git-owned.

A later rollback must first preserve all post-cutover changes using an export
or a fresh backup. The archived files do not include later Knowledge writes.
Restoring the full pre-import controller backup would also revert unrelated
projects and credentials, so it is not an automatic project rollback. A
failed pilot must leave source ownership explicit and retain evidence for
recovery; do not claim the migration completed before its checks pass.
