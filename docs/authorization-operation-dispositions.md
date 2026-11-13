---
audience: "owner, implementers and reviewers of the authentication and authorization unification"
last_reviewed: "2026-11-13"
source_of_truth: "draft disposition of every current operation under the unreleased authorization contract; Knowledge task 040062b4, discussion 8a2683b8"
status: "active"
---

# Authorization operation dispositions

**DRAFT for review. It describes an unreleased breaking change.** Nothing in the
product follows this page yet. It is the slice 1 deliverable that
[the authorization contract](authorization-contract.md) lists under "Not
implemented": the disposition of every operation that exists today. Where the
accepted rules and the recorded decisions do not decide something, the cell
says `OPEN-<n>` and [section 6](#6-open-items) states the question. No OPEN item
was resolved by the author of this page.

## Sources

- The per-operation matrix of the current system, produced from source at
  commit `659b207e` (Knowledge reply `879cfa4c`). Both files live on the
  llm-worker host and are not in Git:
  - `/home/pioootrek/.local/state/worktree-control-auth-unification/slice1/operations.md`,
    sha256 `8071aa7d5464dcc09746cb6d314853227eb6353efe7cdf4f6a963fc6188d3416`
  - `/home/pioootrek/.local/state/worktree-control-auth-unification/slice1/findings.md`,
    sha256 `69053b268cbc1d3a9ae05c3d834809d152aae7c1e22ba1ca6e7d02ecbe28e39b`
- The contract as implemented: [authorization contract](authorization-contract.md),
  `src/shared/contracts/operations.ts` and `src/server/modules/operations/`.
- Knowledge task `040062b4`, discussion `8a2683b8`. Owner decisions:
  `9ba49f3c`, `2c641ff7`, `4ac7fb45`. Accepted target: `5583b882`, `1367c632`.
  Contract v1: `032aa386`; the review it adopts: `575a4fe8`. Decisions M and N:
  `9d5ae2f7`. Acceptance of the slice 1 code: `142b86d3`.
- Source reading in the worktree at `81b99935` (product source identical to
  `659b207e` outside the new module) for the matrix's open questions; see
  [section 6](#6-open-items).

## How to read this page

Surfaces. `H` is the HTTP API, on TCP and on the unix socket, with one adapter
and one operation schema. `M` is MCP. `C` is the CLI, over the unix socket or
offline under the controller lock. Every registry operation is on `H`, `M` and
`C` unless its row names an exclusion and the reason.

- `M†`: registered for full-authority actors only. An operation with
  `agents: false` is absent from an agent's MCP catalogue. In better-auth mode
  the MCP listener accepts agent tokens only, so such an operation has no MCP
  caller there (contract v1, answer g).
- Operations that exist only to administer accounts act on better-auth accounts.
  In open and token mode they answer `unavailable` (OPEN-19).

Requirement vocabulary (the contract's own): `authenticated`; `P on slot` (a
project permission on a resource slot); `installation P`; `allOf(...)`;
`collection(P)`; the predicates `claim_holder`, `run_originating_session` and
`worker_assignment`; and the flags `agents: false` and `freshLogin`. Full
authority (`installation`, `operator`) passes permissions and flags. It does
not pass resource resolution or the three predicates, which protect foreign
claims, runs and assignments.

Commit point (decision N). `entry`: the handler is past its point when invoked,
so nothing typed can be refused inside it. `declared`: a typed refusal is
possible before the effect begins, stated in one phrase. Reads and waits show
`-`.

Retain. `yes`: the operation declares retention and accepts an idempotency key.
A key on any other operation is `invalid_request`.

Row labels. The disposition table keeps the matrix's labels (`1.1` to `14.7`,
and `1.R`). The matrix gives Knowledge no row numbers: this page numbers its 37
operation names `7.1` to `7.37` in the matrix's listing order and its four
CLI-only items `7.38` to `7.41`.

## 1. Target operation catalogue

Identifiers are `family.verb`, lower case. A resource slot names what the
operation acts on; each slot resolves to exactly one project or to not-found.

### 1.1 Session

| Id | Kind | Resources | Requirement | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `session.describe` | read | none | `authenticated` | - | - | no | H M C | A hint, never an authorization. Actor, mode, listener, installation permissions, every visible project with the permissions held there (decision M), fresh-login state. Works with zero roles. The only operation implemented in slice 1. |

### 1.2 Project and registration

| Id | Kind | Resources | Requirement | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `project.list` | read | none | `collection(project:read)` | - | - | no | H M C | Per item: id, name, port, phase, worktree path, claim `none`, `own` or `other`. Holder identity of `other` only with `claims:manage` on that project. Filtered before pagination. No environment values, logs or test runs. |
| `project.status` | read | `project` | `project:read on project` | - | - | no | H M C | Safe status DTO. `compact` input replaces the compact variant. Raw executable and arguments only with `config:read`; literal environment values only with `secrets:read`; other holders' identities only with `claims:manage`. No logs, storage or test runs: separate operations. Knowledge summary fields: OPEN-13. |
| `project.worktrees` | read | `project` | `project:read on project` | - | - | no | H M C | Allowlist: path, branch, head, short head, detached, locked, prunable, dirty. Discovery runs outside admission; the release rechecks after it. Every call discovers, so no separate refresh operation exists. |
| `project.wait` | wait | `project` | `project:read on project` | - | - | no | H M C | Cursor envelope. Rechecks after the wait. Bounded waiters; default timeout 10 s, maximum 20 s. |
| `project.create` | mutation | none | `installation projects:create` | - | declared: port and path availability are refused before the store write | yes | H M C | Covers adding a registration with its project and creating a project without one. Port selection when none is given belongs here (task `7c1e30a6`). |
| `project.archive` | mutation | `project` | `project:manage on project` | - | declared: the revision conflict is refused before the write | yes | H M C | Today `knowledge:write`; operators lose it (decision v1, `575a4fe8` point 5). |
| `project.restore` | mutation | `project` | `project:manage on project` | - | declared: as `project.archive` | yes | H M C | As above. |
| `registration.attach` | mutation | `project` | `project:manage on project` | - | declared: path and port checks before the write | yes | H M C | Adds a machine registration to an existing project. |
| `registration.detach` | mutation | `registration` | `project:manage on registration` | - | declared: precondition refusals before the removal | yes | H M C | Does not delete Knowledge (accepted target, point 4). Whether it also answers "remove the project": OPEN-3. |
| `registration.move` | mutation | `registration` as `source`, `project` as `destination` | `allOf(project:manage on source, project:manage on destination)` | - | declared: both mappings are checked before the move | yes | H M C | Contract v1: needs `project:manage` on both. Rechecks resolve both mappings and their versions. |

### 1.3 Claim

| Id | Kind | Resources | Requirement | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claim.acquire` | mutation | `project` | `claims:manage on project` | - | declared: a conflicting holder or an unavailable worktree is refused before the reservation | yes | H M C | Only reserves: it never starts a server. The holder is a server-issued coordination session (OPEN-2). Result: claim summary, TTL at most 1800 s. |
| `claim.renew` | mutation | `claim` | `allOf(claims:manage on claim, claim_holder on claim)` | - | declared: a stale or expired claim is refused before the extension | yes | H M C | Keys are optional, as on the account surface today. Automatic renewal from a session is a background-authorization obligation, not an operation. |
| `claim.release` | mutation | `claim` | `allOf(claims:manage on claim, claim_holder on claim)` | - | entry: ownership is decided before the effect | yes | H M C | Does not stop the server. |
| `claim.force_release` | mutation | `claim` | `runtime:administer on claim` | - | entry: the removal has no typed refusal | yes | H M C | Separate and audited. The only way to remove another session's claim. |

### 1.4 Runtime

| Id | Kind | Resources | Requirement | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `runtime.start` | mutation | `project`, `claim` | `allOf(runtime:control on project, claim_holder on claim)` (OPEN-1) | - | declared: an occupied port, missing capacity or an unavailable worktree are refused before the spawn | yes | H M C | Explicit. An occupied port never proves ownership. Receipt allowlist as the scoped receipt today. |
| `runtime.restart` | mutation | `project`, `claim` | `allOf(runtime:control on project, claim_holder on claim)` (OPEN-1) | - | declared: refusals before the stop; the stop is past the point | yes | H M C | Keeps the claim and the capacity slot. |
| `runtime.stop` | mutation | `project`, `claim` | `allOf(runtime:control on project, claim_holder on claim)` (OPEN-1) | - | entry: a failed process-tree stop leaves cleanup unconfirmed | yes | H M C | The claim stays held. Stops only verified owned process trees. |
| `runtime.switch` | mutation | `project`, `claim` | `allOf(runtime:control on project, claim_holder on claim)` (OPEN-1) | - | declared: as `runtime.restart` | yes | H M C | Today HTTP only. |
| `runtime.force_stop` | mutation | `project` | `runtime:administer on project` | - | entry: as `runtime.stop` | yes | H M C | Stops a run started under another session's claim. Foreign processes stay protected. |
| `runtime.metrics` | read | none | `collection(project:read)` | - | - | no | H M C | Per project resource samples. |

### 1.5 Configuration

| Id | Kind | Resources | Requirement | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `config.read` | read | `project` | `config:read on project` | - | - | no | H M C | Launch preset, executable and arguments, TLS mode and paths, preset timeouts, environment variable names. Literal values only with `secrets:read`. Explicit public DTO. |
| `config.tls_set` | mutation | `project` | `config:write on project` | - | declared: path validation before the write | yes | H M C | Has no actor callback today (`575a4fe8`, point 1). |
| `config.environment_set` | mutation | `project` | `allOf(config:write on project, secrets:write on project)` (OPEN-7) | - | declared: reserved names and the stopped-server precondition are refused before the write | yes | H M C | Replaces the literal development environment. |
| `profile.list` | read | `project` | `config:read on project` | - | - | no | H M C | Selected profile, names, revision. Literal values only with `secrets:read`. |
| `profile.save` | mutation | `project` | `allOf(config:write on project, secrets:write on project)` (OPEN-7) | - | declared: validation and the selected-profile precondition before the write | yes | H M C | The HTTP-only `restart` option disappears. |
| `profile.delete` | mutation | `project` | `config:write on project` | - | declared: default and selected profiles are refused before the delete | yes | H M C | |
| `profile.select` | mutation | `project` | `profiles:select on project` (OPEN-1) | - | declared: revision conflict and an active runtime are refused before the commit | yes | H M C | Revision compare-and-set and idempotency on every surface. Never restarts. |
| `preset.timeout_set` | mutation | `project` | `config:write on project` | - | declared: revision conflict, override limit and an undiscovered preset are refused before the write | yes | H M C | Compare-and-set, discovered preset only. A null timeout removes the override. |
| `test_profile.list` | read | `project` | `config:read on project` | - | - | no | H M C | Variable names only. |
| `test_profile.save` | mutation | `project` | `allOf(config:write on project, secrets:write on project)` (OPEN-7) | - | declared: validation before the write | yes | H M C | One response shape on every surface. |
| `test_profile.delete` | mutation | `project` | `config:write on project` | - | declared: built-in and assigned profiles are refused before the delete | yes | H M C | |
| `test_preset.assign_profile` | mutation | `project` | `config:write on project` | - | declared: unknown profile refused before the write | yes | H M C | |
| `godot_web.configure` | mutation | `project` | `config:write on project` | - | declared: the stopped-server precondition and discovery before the write | yes | H M C | Awaits discovery then writes without a recheck today (`575a4fe8`, point 1). |
| `godot_web.status` | read | `project` | `project:read on project` | - | - | no | H M C | |
| `godot_web.rebuild` | mutation | `project` | OPEN-15 (candidate: `runtime:control on project`) | - | declared: an in-flight export is coalesced, not refused | yes | H M C | Background work keeps an immutable authorization specification and an owner reference. |

### 1.6 Test runs

| Id | Kind | Resources | Requirement | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `test_preset.list` | read | `project` | `tests:read on project` (OPEN-14) | - | - | no | H M C | Bounded: 64 trees, 256 presets, 64 KiB. |
| `test_run.enqueue` | mutation | `project` | `tests:run on project` (OPEN-1) | - | declared: a non-clean environment and a full queue are refused before the enqueue | yes | H M C | Records the originating session, principal and credential. Dispatch rechecks the requester. |
| `test_run.read` | read | `test_run` | `tests:read on test_run` | - | - | no | H M C | Project-wide safe status DTO for every caller. It never grows fields because the caller holds `config:read` or `logs:read`. No output tail, no raw command. |
| `test_run.logs` | read | `test_run` | `allOf(tests:read on test_run, logs:read on test_run)` | - | - | no | H M C | Redacted, bounded lines. Application output cannot be certified secret-free. |
| `test_run.cancel` | mutation | `test_run` | `allOf(tests:run on test_run, run_originating_session on test_run)` | - | declared: a terminal run is refused before the intent is recorded | yes | H M C | Cancellation intent only; the run stays running until cleanup is confirmed. |
| `test_run.wait` | wait | `test_run` | `tests:read on test_run` | - | - | no | H M C | Rechecks after the wait. |
| `test_run.history_list` | read | `project` | `tests:read on project` | - | - | no | H M C | Compact summaries, live keyset cursor, at most 50 results and 1000 scanned. |
| `test_run.summary` | read | `test_run` | `tests:read on test_run` | - | - | no | H M C | Retained compact summary. |
| `test_run.metrics` | read | `project` | `tests:read on project` | - | - | no | H M C | At most 5000 candidates, 31-day window. |
| `test_run.compare` | read | `test_run` as `left`, `test_run` as `right` | `allOf(tests:read on left, tests:read on right)` | - | - | no | H M C | |
| `test_run.lookup_intent` | read | `project` | OPEN-21 | - | - | no | H M C | The I1 original-intent lookup (task `6d680061`): saved origin-session digest with an explicit digest version, bounded ambiguous and unavailable outcomes, `releaseSafe`. No matrix row; required by `575a4fe8` answer d. |
| `test_run.admin_inspect` | read | `test_run` | `runtime:administer on test_run` (OPEN-22) | - | - | no | H M C | Ownership and resolution projection. |
| `test_run.admin_stop` | mutation | `test_run` | `runtime:administer on test_run` | - | declared: a run that is not running is refused before the stop | yes | H M C | Reason 3 to 200 characters, optional wait up to 120 s, request id as the idempotency key. Audited as the actor. |

### 1.7 Storage, capacity, logs and system reads

| Id | Kind | Resources | Requirement | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `storage.read` | read | `project` | `storage:read on project` | - | - | no | H M C | One worktree path, last 16 history points. |
| `storage.refresh` | mutation | `project` | OPEN-15 (candidates: `storage:read` or `storage:manage` on project) | - | declared: path validation before the scan is queued | yes | H M C | Queues a scan; needs an actor at the queueing point (`575a4fe8`, point 1). |
| `storage.cache_delete` | mutation | `project` | `storage:manage on project` | - | declared: path and cache kind are validated before the removal | yes | H M C | Deletes files. Rechecks after the filesystem awaits and before the removal. |
| `capacity.read` | read | none | `collection(project:read)` (OPEN-4) | - | - | no | H M C | Aggregate counts for any holder of `project:read` on at least one project; slot holders filtered per project by `claims:manage`. Installation-wide detail with `capacity:read`. |
| `capacity.set` | mutation | none | `installation capacity:write` | - | entry: an absolute-value write, no typed refusal known | no | H M C | Idempotent by nature. |
| `test_queue.read` | read | none | `collection(project:read)` (OPEN-4) | - | - | no | H M C | Limit, running, queued, available; no identities. |
| `test_queue.set` | mutation | none | `installation capacity:write` | - | entry: as `capacity.set` | no | H M C | Queue and capacity are one administrative group (accepted target, point 5). |
| `runtime_logs.read` | read | `project` | `logs:read on project` | - | - | no | H M C | Always bounded and credential-redacted. Application output may still hold secrets. |
| `diagnostics.mcp` | read | none | `installation diagnostics:read` | - | - | no | H M C | MCP session and diagnostic snapshot. |
| `events.subscribe` | stream | none | `collection(project:read)` per event (OPEN-9) | - | - | no | H (SSE framing); M and C excluded, OPEN-9 | Every event is a release, filtered per subscriber. Replaces the one-event-for-all broadcast. |
| `directory.browse` | read | none | OPEN-8 | - | - | no | H M C | Listing confined to the configured browse root by real path. |

### 1.8 Knowledge

All Knowledge operations take a `project` slot (and a `knowledge_record` slot
where a record id is given); an id from another project is `not_found`. Writes
require `knowledge:read` as well because their responses contain retained
content. The project's archived state limits writes as today and is not an
authorization rule. All writes retain and take an optional key.

| Id | Kind | Resources | Requirement | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `knowledge.memories` | read | `project` | `knowledge:read on project` | - | - | no | H M C | |
| `knowledge.memory` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | no | H M C | |
| `knowledge.create_memory` | mutation | `project` | `allOf(knowledge:write on project, knowledge:read on project)` | - | declared: validation and conflicts before the write | yes | H M C | |
| `knowledge.update_memory` | mutation | `project`, `knowledge_record` | `allOf(knowledge:write on project, knowledge:read on project)` | - | declared: revision conflict before the write | yes | H M C | |
| `knowledge.approve_memory` | mutation | `project`, `knowledge_record` | `allOf(knowledge:approve on project, knowledge:read on project)` | `agents: false`, `freshLogin` | declared: revision conflict before the write | yes | H M† C | Human-only sensitive action. Installation and operator are exempt. |
| `knowledge.archive_memory` | mutation | `project`, `knowledge_record` | `allOf(knowledge:write on project, knowledge:read on project)` | - | declared: as above | yes | H M C | |
| `knowledge.restore_memory` | mutation | `project`, `knowledge_record` | `allOf(knowledge:write on project, knowledge:read on project)` | - | declared: as above | yes | H M C | |
| `knowledge.supersede_memory` | mutation | `project`, `knowledge_record` | `allOf(knowledge:write on project, knowledge:read on project)` | - | declared: as above | yes | H M C | |
| `knowledge.search` | read | `project` | `knowledge:read on project` | - | - | no | H M C | |
| `knowledge.task_context` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | no | H M C | Bounded depth 8, 50 predecessors, 32 KiB history. |
| `knowledge.check_context_export` | read | `project` | `knowledge:read on project` | - | - | no | H M C | |
| `knowledge.export_context` | read | `project` | `allOf(knowledge:export on project, knowledge:read on project)` | - | - | no | H M C | Response capped at 256 KiB. |
| `knowledge.threads` | read | `project` | `knowledge:read on project` | - | - | no | H M C | |
| `knowledge.reply` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | no | H M C | |
| `knowledge.thread` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | no | H M C | |
| `knowledge.replies` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | no | H M C | |
| `knowledge.tasks` | read | `project` | `knowledge:read on project` | - | - | no | H M C | |
| `knowledge.task` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | no | H M C | |
| `knowledge.relations` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | no | H M C | |
| `knowledge.history` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | no | H M C | |
| `knowledge.create_thread` | mutation | `project` | `allOf(knowledge:write on project, knowledge:read on project)` | - | declared: validation before the write | yes | H M C | |
| `knowledge.create_reply` | mutation | `project`, `knowledge_record` | `allOf(knowledge:write on project, knowledge:read on project)` | - | declared: as above | yes | H M C | |
| `knowledge.create_task` | mutation | `project` | `allOf(knowledge:write on project, knowledge:read on project)` | - | declared: as above | yes | H M C | |
| `knowledge.task_from_thread` | mutation | `project`, `knowledge_record` | `allOf(knowledge:write on project, knowledge:read on project)` | - | declared: as above | yes | H M C | |
| `knowledge.update_task` | mutation | `project`, `knowledge_record` | `allOf(knowledge:write on project, knowledge:read on project)` | - | declared: revision conflict before the write | yes | H M C | |
| `knowledge.task_state` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | no | H M C | |
| `knowledge.update_task_state` | mutation | `project`, `knowledge_record` | `allOf(knowledge:write on project, knowledge:read on project)` | - | declared: revision conflict before the write | yes | H M C | Consent is never written. |
| `knowledge.attachments` | read | `project` | `attachments:read on project` | - | - | no | H M C | Readable on an archived project. |
| `knowledge.attachment_policy` | read | `project` | `attachments:read on project` | - | - | no | H M C | |
| `knowledge.check_attachment_batch` | read | `project` | `allOf(attachments:write on project, attachments:read on project)` | - | - | no | H M C | Manifest at most 10000 files, request at most 4 MiB. |
| `knowledge.attachment` | read | `project`, `knowledge_record` | `attachments:read on project` | - | - | no | H M C | Returns base64 content. |
| `knowledge.create_attachment` | mutation | `project`, `knowledge_record` | `attachments:write on project` | - | declared: size and capacity limits are refused before the commit | yes | H M C | `payload_too_large` above 14.1 MB. Authorization is rechecked inside the commit callback today and stays so. |
| `knowledge.project_export` | mutation | `project` | `allOf(knowledge:export on project, attachments:read on project)` | - | declared: limits and destination checks before the write | yes | C (unix or offline); H and M excluded, OPEN-10 | Writes a directory on the controller host. Offline under the lock today. |
| `knowledge.project_import` | mutation | `project` or none | `knowledge:import on project` into an existing project; `installation projects:create` when it creates one (OPEN-13) | - | declared: manifest and integrity checks before the first write | yes | C (unix or offline); H and M excluded, OPEN-10 | Today owner-session only. |

### 1.9 Vault

| Id | Kind | Resources | Requirement | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `vault.import` | mutation | `project` | `secrets:write on project` | - | declared: limits (16 profiles, 100 variables, 48 KiB) before the write | yes | H M C | Creates a profile from dotenv text. |
| `vault.update` | mutation | `vault_entry` | `secrets:write on vault_entry` | - | declared: revision conflict before the write | yes | H M C | Replaces the grant-gated `write`. |
| `vault.list` | read | `project` | `secrets:read on project` (OPEN-18) | - | - | no | H M C | Profile id, revision, timestamps; no values. |
| `vault.read` | read | `vault_entry` | `secrets:read on vault_entry` | - | - | no | H M C | The only operation that releases plaintext. No per-use consent. |
| `vault.audit` | read | `project` | `secrets:read on project` (OPEN-18) | - | - | no | H M C | Bounded audit. |
| `vault.recover_key` | mutation | none | `installation vault:recover` | `agents: false`, `freshLogin` | declared: provisional until the Vault code is read in slice 4 | yes | H M† C | From contract v1. No current operation exists (no matrix row). |

### 1.10 Backups and exports

| Id | Kind | Resources | Requirement | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `backup.overview` | read | none | `installation backups:manage` | - | - | no | H M C | Omits the destination directory. |
| `backup.create` | mutation | none | `installation backups:manage` | - | declared: policy and destination checks before the copy | yes | H M C | Rechecks before the copy starts, which does not happen today. |
| `backup.preview` | read | none | `installation backups:manage` | - | - | no | H M C | Kind provisional, OPEN-23. |
| `backup.restore` | mutation | none | `installation backups:manage` | - | declared: the drained handoff admission is the commit | yes | H M C | The post-response launch stays the specialized restore state machine (OPEN-23). |
| `backup.status` | read | none | `installation backups:manage` | - | - | no | H M C | |
| `backup.monitor` | read | none | `installation backups:manage` | - | - | no | H M C | Monitor metadata and thresholds. |
| `backup.remote_status` | read | none | `installation backups:manage` | - | - | no | H M C | |
| `backup.remote_reupload` | mutation | none | `installation backups:manage` | - | declared: unknown backup refused before the upload | yes | H M C | |
| `backup.remote_retry` | mutation | none | `installation backups:manage` | - | declared: generation check before the retry | yes | H M C | |
| `backup.remote_rebind` | mutation | none | `installation backups:manage` | - | declared: needs a completed restore, checked before the rebind | yes | C offline only; H and M excluded, OPEN-11 | Needs the exclusive controller lock. |
| `user_backup.overview` | read | none | `allOf(collection(knowledge:export), collection(attachments:read))` | - | - | no | H M C | Own schedules; items need both permissions on their project. Owner rules: OPEN-12. |
| `user_backup.save` | mutation | `project` | `allOf(knowledge:export on project, attachments:read on project)` | - | declared: policy gate and limits before the write | yes | H M C | Durable owner plus immutable job specification; current grants at dispatch. OPEN-12. |
| `user_backup.status` | read | none | `allOf(collection(knowledge:export), collection(attachments:read))` | - | - | no | H M C | |
| `user_backup.artifact` | read | `project` | `allOf(knowledge:export on project, attachments:read on project)` | - | - | no | H M C | Releases artifact content: a data release, authorized at release. |
| `user_export.recovery_list` | read | none | `installation backups:manage` | - | - | no | H M C | Today operator socket only. |
| `user_export.recovery_preview` | read | none | `installation backups:manage` | - | - | no | H M C | |
| `user_export.recovery_cleanup` | mutation | none | `installation backups:manage` | - | declared: confirmation id checked before the removal | yes | H M C | |

### 1.11 Accounts and roles

All operations here act on better-auth accounts. Reads carry `agents: false`;
mutations carry `agents: false` and `freshLogin` (account and role
administration, accepted target point 6). Whether reads need a fresh login is
part of OPEN-24.

| Id | Kind | Resources | Requirement | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `account.create` | mutation | none | `installation accounts:manage` | `agents: false`, `freshLogin` | declared: validation and kind checks before the write | yes | H M† C | Human or agent account. The first admin is created by the operator over the unix socket or offline (OPEN-19). |
| `account.enroll` | mutation | none | `installation accounts:manage` | `agents: false`, `freshLogin` | declared: validation before the credential write | yes | H M† C | Initial password and factors for a human; secret input by stdin or private file on the CLI, never argv. |
| `account.list` | read | none | `installation accounts:manage` | `agents: false` | - | no | H M† C | Includes token metadata. Page size at most 20. |
| `account.get` | read | none | `installation accounts:manage` | `agents: false` | - | no | H M† C | One account with every role it holds. |
| `account.disable` | mutation | none | `installation accounts:manage` | `agents: false`, `freshLogin` | declared: unknown account refused before the write | yes | H M† C | Disables, then reclaims sessions and the token. |
| `account.recover` | mutation | none | `installation accounts:manage` | `agents: false`, `freshLogin` | declared: provider capability checked before the reset | yes | H M† C | New password; factors preserved or reset. |
| `account.token_issue` | mutation | none | `installation accounts:manage` | `agents: false`, `freshLogin` | declared: account kind and state before the issue | yes | H M† C | The one revocable token of an agent account (OPEN-20). Plaintext once. |
| `account.token_revoke` | mutation | none | `installation accounts:manage` | `agents: false`, `freshLogin` | declared: unknown token refused before the revoke | yes | H M† C | |
| `role.grant` | mutation | `project` | `roles:manage on project` | `agents: false`, `freshLogin` | declared: recipient kind, scope and revision are checked before the write | yes | H M† C | Project roles only. Granting `secrets` is the same operation and therefore also needs the fresh login (OPEN-24). |
| `role.revoke` | mutation | `project` | `roles:manage on project` | `agents: false`, `freshLogin` | declared: revision conflict before the write | yes | H M† C | |
| `role.list` | read | `project` | `roles:manage on project` | `agents: false` | - | no | H M† C | Roles of every account on the project. |
| `admin_role.grant` | mutation | none | `installation accounts:manage` | `agents: false`, `freshLogin` | declared: recipient must be a human account | yes | H M† C | A project `roles:manage` never authorizes it (`575a4fe8`, point 5). |
| `admin_role.revoke` | mutation | none | `installation accounts:manage` | `agents: false`, `freshLogin` | declared: revision conflict before the write | yes | H M† C | |

### 1.12 Remote verification and workers

| Id | Kind | Resources | Requirement | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `remote_verification.submit` | mutation | `project` | `tests:run on project` | - | declared: unknown or unavailable worker and preset are refused before the record | yes | H M C | Submitter. The commit is immutable once recorded. |
| `remote_verification.get` | read | request (OPEN-6) | `tests:run on request` (OPEN-6) | - | - | no | H M C | Request, attempt, cancellation flag, uncertainty flag, bounded latest report. |
| `remote_verification.get_logs` | read | request (OPEN-6) | `tests:run on request` (OPEN-6) | - | - | no | H M C | Last uploaded output only. |
| `remote_verification.cancel` | mutation | request (OPEN-6) | `tests:run on request`, submitter only (OPEN-5) | - | declared: unknown request refused before the intent | yes | H M C | Persists intent even when the worker is offline. |
| `worker.poll` | mutation | none | `collection(worker:execute)` (OPEN-5) | - | declared: the assignment is recorded only after the executor and submitter checks | no | H on the worker listener only; M, C and the ordinary API listener excluded | Machine-to-machine protocol with its own versioning, framing and sequence numbers; the worker listener is a distinct boundary in the acceptance table. |
| `worker.report` | mutation | `worker_attempt` | `allOf(worker:execute on worker_attempt, worker_assignment on worker_attempt)` | - | declared: sequence check before the report is accepted | no | H on the worker listener only; M and C excluded | As `worker.poll`. |
| `worker.register` | mutation | `project` | `installation workers:manage` | - | declared: project and preset checks before the write | yes | C offline only; H and M excluded, OPEN-11 | Registers a worker for a project and presets. No token is issued and no caller grants are written. |
| `worker.recovery_inspect` | read | `worker_attempt` | `installation workers:manage` | - | - | no | C offline only; H and M excluded, OPEN-11 | |
| `worker.recovery_reconcile` | mutation | `worker_attempt` | `installation workers:manage` | - | declared: recovery assessment before the audit write | yes | C offline only; H and M excluded, OPEN-11 | |

## 2. Disposition of every matrix row

Classes: `REPLACED BY` (one target operation; several rows may share it),
`REMOVED` (with the deciding record and what covers the remaining need),
`SPECIALIZED` (a provider or transport route outside the registry) and `LOCAL`
(a local operator command outside the registry). Decision references: owner
decisions `9ba49f3c` (numbered 1 to 4 there), `2c641ff7`, `4ac7fb45`; accepted
target `5583b882`/`1367c632` (points 1 to 9 of the common goal); contract v1
`032aa386`.

### 2.1 Family 1: runtime and claims

| Row | Current operation (names per surface) | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 1.1 | project.list: MCP `list_projects`; account HTTP `list-projects` | REPLACED BY `project.list` | One DTO for every caller. Holder identity of another owner appears only for a caller holding `claims:manage` on that project (full authority does); resource samples move to `runtime.metrics`. HTTP gains a dedicated list route. |
| 1.2 | project.status: `get_project_status`; account `project-status`; resource `projects/{id}/status` | REPLACED BY `project.status` | The installation snapshot with literal environment values, executable and arguments, logs, storage and test runs is gone: those need `secrets:read`, `config:read`, `logs:read` and separate operations. |
| 1.3 | project.status_compact: `get_project_status_compact` | REPLACED BY `project.status` | `compact` input. Now available to human accounts (absent on the account surface today). |
| 1.4 | project.worktrees: `list_worktrees`; account `list-worktrees`; resource | REPLACED BY `project.worktrees` | Installation MCP loses `statusError`, last-commit time and merged-into fields (allowlist). |
| 1.5 | status.wait: `wait_for_status_change`; account tests `wait` (run only) | REPLACED BY `project.wait` and `test_run.wait` | Split by target because the requirement depends on the target. Installation gets the recheck after the wait. |
| 1.6 | claim.acquire: `claim_project`; account `claim` | REPLACED BY `claim.acquire` | Installation MCP claim no longer starts or moves the server; `runtime.start` is explicit (accepted target, point 8). No `responseMode`. TTL default and bounds identical on every surface. |
| 1.7 | claim.renew: `renew_project_claim`; account `renew` | REPLACED BY `claim.renew` | Optional idempotency key on every surface. |
| 1.8 | claim.release: `release_project_claim`; account `release` | REPLACED BY `claim.release` | Optional idempotency key on every surface. |
| 1.9 | runtime.start: `start_project`; account `start`; HTTP `operation:"start"` | REPLACED BY `runtime.start` | HTTP start without any claim is no longer possible (OPEN-1). HTTP gains the idempotency key and the receipt. |
| 1.10 | runtime.restart: `restart_project`; account; HTTP | REPLACED BY `runtime.restart` | As 1.9. |
| 1.11 | runtime.stop: `stop_project`; account; HTTP | REPLACED BY `runtime.stop` | As 1.9. Stopping another session's run is `runtime.force_stop`. |
| 1.12 | runtime.switch: HTTP `operation:"switch"` only | REPLACED BY `runtime.switch` | Now on MCP and CLI too. |
| 1.13 | reservation.acquire: HTTP human lock, owner `local-user` | REPLACED BY `claim.acquire` | One claim kind. The `local-user` owner and the separate human lock disappear; the token browser holds claims through a coordination session (OPEN-2). |
| 1.14 | reservation.release: HTTP | REPLACED BY `claim.release` | As 1.13. |
| 1.15 | reservation.force_release: HTTP, any authenticated caller | REPLACED BY `claim.force_release` | Needs `runtime:administer` (source: `releaseReservation(..., force)` bypasses owner and kind checks, `sqlite-state-store.ts:1413-1415`). |
| 1.R | mcp.resources: five `worktree-switcher://` URIs (not counted in the 204) | REPLACED BY `project.list`, `project.status`, `project.worktrees`, `capacity.read`, `test_queue.read` | Resources stay read views of these operations and authorize at call time (contract v1, answer g). |

### 2.2 Family 2: project administration

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 2.1 | project.add: HTTP `POST /api/projects`; CLI and socket `project add` | REPLACED BY `project.create` | Needs `projects:create` on the installation. The result is a safe summary, not the full view with environment values. Port choice is part of the operation. |
| 2.2 | project.remove: HTTP `DELETE`; CLI and socket `project remove` | REPLACED BY `registration.detach` (OPEN-3) | A maintainer may detach a registration of their own project. Knowledge is kept (accepted target, point 4). |
| 2.3 | project.metadata_refresh: HTTP only | REPLACED BY `project.worktrees` | Discovery on every call; the full snapshot response is gone. |
| 2.4 | project.tls_set: HTTP only | REPLACED BY `config.tls_set` | Needs `config:write`; now on MCP and CLI. |
| 2.5 | project.overview: HTTP `GET /api/dashboard`; CLI `project list`, `doctor`; socket `dashboard` | REPLACED BY `project.list` | The dashboard composes `project.list`, `project.status`, `runtime.metrics` and `events.subscribe`; mode and listener move to `session.describe`. `doctor` stays LOCAL. |

### 2.3 Family 3: configuration and environment profiles

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 3.1 | env.set: MCP `set_project_environment`; HTTP | REPLACED BY `config.environment_set` | Literal values need `secrets:write` (OPEN-7). Now on CLI. |
| 3.2 | profile.list: `list_environment_profiles`; account `profiles` | REPLACED BY `profile.list` | Names for readers; literal values need `secrets:read`. Needs `config:read`, no longer `profiles:select`. |
| 3.3 | profile.save: `save_environment_profile`; HTTP | REPLACED BY `profile.save` | HTTP-only `restart` option removed; call `runtime.restart`. |
| 3.4 | profile.select: `select_environment_profile`; account; HTTP | REPLACED BY `profile.select` | One schema: revision compare-and-set, idempotency key, name pattern. `restartRequired` and the HTTP `restart` option removed; never restarts. |
| 3.5 | profile.delete: `delete_environment_profile`; HTTP | REPLACED BY `profile.delete` | Needs `config:write`. |
| 3.6 | test_profile.list: `list_test_environment_profiles`; HTTP | REPLACED BY `test_profile.list` | |
| 3.7 | test_profile.save: `save_test_environment_profile`; HTTP | REPLACED BY `test_profile.save` | One response shape (today MCP returns the list, HTTP the project). |
| 3.8 | test_profile.delete: `delete_test_environment_profile`; HTTP | REPLACED BY `test_profile.delete` | One response shape. |
| 3.9 | test_preset.assign_profile: `assign_test_preset_profile`; HTTP | REPLACED BY `test_preset.assign_profile` | |
| 3.10 | test_preset.timeout_set: `set_test_preset_timeout`; account; HTTP | REPLACED BY `preset.timeout_set` | Compare-and-set and a discovered preset on every surface. Source shows the preset pattern also applies on the installation path (`preset-timeout.ts:5-8`). |
| 3.11 | project.configuration_read: `get_project_configuration` (agent); account `configuration` | REPLACED BY `config.read` | Needs `config:read`, no longer `config:write`. Now on HTTP and CLI. |

### 2.4 Family 4: verification and test runs

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 4.1 | test_preset.list: `list_test_presets`; account `presets` | REPLACED BY `test_preset.list` | One projection (OPEN-14). |
| 4.2 | test_run.enqueue: `run_test`; account `enqueue`; HTTP `POST /tests` | REPLACED BY `test_run.enqueue` | HTTP gains the idempotency key. No `responseMode`. Results are the safe status DTO, not the full run. |
| 4.3 | test_run.read: `get_test_run`; HTTP `GET /api/test-runs/:id` | REPLACED BY `test_run.read` | Any caller with `tests:read` reads any run of the project, as safe status: installation loses the output tail and command text there; output is `test_run.logs`. |
| 4.4 | test_run.status: `get_test_run_status`; account `status` | REPLACED BY `test_run.read` | `compact` input. |
| 4.5 | test_run.cancel: `cancel_test_run`; account `cancel`; HTTP | REPLACED BY `test_run.cancel` | Token HTTP can no longer cancel any run (the `local-user` author-check bypass, `test-job-manager.ts:232`). Cancel only from the originating session; takeover is `test_run.admin_stop`. |
| 4.6 | test_run.history_list: `list_test_runs`; HTTP | REPLACED BY `test_run.history_list` | Needs `tests:read`; now for agents and humans too. |
| 4.7 | test_run.summary: `get_test_run_summary`; HTTP | REPLACED BY `test_run.summary` | |
| 4.8 | test_run.metrics: `get_test_metrics`; HTTP | REPLACED BY `test_run.metrics` | |
| 4.9 | test_run.compare: `compare_test_runs`; HTTP | REPLACED BY `test_run.compare` | |
| 4.10 | test_run.admin_inspect: CLI `test-run inspect`; socket | REPLACED BY `test_run.admin_inspect` | Now a registry operation: needs `runtime:administer` for accounts; the operator holds it. Also on HTTP and MCP. |
| 4.11 | test_run.admin_stop: CLI `test-run stop`; socket | REPLACED BY `test_run.admin_stop` | As 4.10. |

### 2.5 Family 5: Godot web

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 5.1 | godot_web.configure: `configure_godot_web`; HTTP; CLI; socket | REPLACED BY `godot_web.configure` | Needs `config:write`; recheck after discovery. |
| 5.2 | godot_web.status: `get_web_export_status`; HTTP | REPLACED BY `godot_web.status` | |
| 5.3 | godot_web.rebuild: `rebuild_web_export`; HTTP; CLI; socket | REPLACED BY `godot_web.rebuild` | Requirement OPEN-15. The requesting actor is kept for the background enqueue. |

### 2.6 Family 6: storage, capacity, metrics and logs

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 6.1 | storage.read: `get_project_storage` | REPLACED BY `storage.read` | One projection per operation, the scoped one: one path, last 16 history points. The installation MCP's all-worktree dump goes (inferred from contract v1 amendment 7). Now on HTTP and CLI. |
| 6.2 | storage.refresh: HTTP only | REPLACED BY `storage.refresh` | Requirement OPEN-15. Gains an actor at the queueing point. |
| 6.3 | storage.cache_delete: HTTP only | REPLACED BY `storage.cache_delete` | Needs `storage:manage`; recheck before the removal. |
| 6.4 | capacity.read: `get_server_capacity` | REPLACED BY `capacity.read` | Aggregate counts for any `project:read` holder; slot holders need `claims:manage` per project (OPEN-4). |
| 6.5 | capacity.set: HTTP only | REPLACED BY `capacity.set` | Needs `capacity:write`; now on MCP and CLI. |
| 6.6 | test_queue.read: `get_test_queue` | REPLACED BY `test_queue.read` | OPEN-4. |
| 6.7 | test_queue.set: HTTP only | REPLACED BY `test_queue.set` | Needs `capacity:write`. |
| 6.8 | runtime_logs.read: `get_runtime_logs` | REPLACED BY `runtime_logs.read` | Installation MCP gets redacted bounded lines, not raw process output (source: raw today, `process-manager.ts:151-155`). |
| 6.9 | test_run_logs.read: agent `get_test_run_logs` | REPLACED BY `test_run.logs` | Needs `tests:read` and `logs:read`; not limited to own runs; now for installation and humans. |
| 6.10 | runtime.metrics: HTTP `GET /api/metrics` | REPLACED BY `runtime.metrics` | Filtered per project; now on MCP and CLI. |

### 2.7 Family 7: Knowledge

Rows `7.1` to `7.37` are the operation names of `knowledgeSchemas` in the
matrix's order; `7.38` to `7.41` are its four CLI-only items.

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 7.1 | `memories` | REPLACED BY `knowledge.memories` | |
| 7.2 | `memory` | REPLACED BY `knowledge.memory` | |
| 7.3 | `create_memory` | REPLACED BY `knowledge.create_memory` | |
| 7.4 | `update_memory` | REPLACED BY `knowledge.update_memory` | |
| 7.5 | `approve_memory` | REPLACED BY `knowledge.approve_memory` | Human-only with a fresh login in better-auth. Today any installation caller approves; now exempt only because installation is full authority. Owner session no longer exists. |
| 7.6 | `archive_memory` | REPLACED BY `knowledge.archive_memory` | |
| 7.7 | `restore_memory` | REPLACED BY `knowledge.restore_memory` | |
| 7.8 | `supersede_memory` | REPLACED BY `knowledge.supersede_memory` | |
| 7.9 | `search` | REPLACED BY `knowledge.search` | |
| 7.10 | `task_context` | REPLACED BY `knowledge.task_context` | |
| 7.11 | `check_context_export` | REPLACED BY `knowledge.check_context_export` | |
| 7.12 | `export_context` | REPLACED BY `knowledge.export_context` | |
| 7.13 | `project` | REPLACED BY `project.status` (OPEN-13) | One project entity. |
| 7.14 | `projects` | REPLACED BY `project.list` | The list now authorizes per item (today it calls no authorization, `knowledge-service.ts:96-100`). |
| 7.15 | `threads` | REPLACED BY `knowledge.threads` | |
| 7.16 | `reply` | REPLACED BY `knowledge.reply` | |
| 7.17 | `thread` | REPLACED BY `knowledge.thread` | |
| 7.18 | `replies` | REPLACED BY `knowledge.replies` | |
| 7.19 | `tasks` | REPLACED BY `knowledge.tasks` | |
| 7.20 | `task` | REPLACED BY `knowledge.task` | |
| 7.21 | `relations` | REPLACED BY `knowledge.relations` | |
| 7.22 | `history` | REPLACED BY `knowledge.history` | |
| 7.23 | `create_thread` | REPLACED BY `knowledge.create_thread` | |
| 7.24 | `create_reply` | REPLACED BY `knowledge.create_reply` | |
| 7.25 | `create_task` | REPLACED BY `knowledge.create_task` | |
| 7.26 | `task_from_thread` | REPLACED BY `knowledge.task_from_thread` | |
| 7.27 | `update_task` | REPLACED BY `knowledge.update_task` | |
| 7.28 | `task_state` | REPLACED BY `knowledge.task_state` | |
| 7.29 | `update_task_state` | REPLACED BY `knowledge.update_task_state` | |
| 7.30 | `archive_project` | REPLACED BY `project.archive` | Needs `project:manage` (maintainer), not `knowledge:write` (operator). |
| 7.31 | `restore_project` | REPLACED BY `project.restore` | As 7.30. |
| 7.32 | `link_runtime` | REMOVED: owner decision `9ba49f3c` point 2 and accepted target point 4 (one project entity) | Nothing to link: registration, claim, run, profile, Vault entry and Knowledge record resolve to one project. Remote-only identities and existing links are mapped explicitly by the migration (`5583b882` correction 2); `registration.attach` and `registration.move` cover later changes. |
| 7.33 | `attachments` | REPLACED BY `knowledge.attachments` | |
| 7.34 | `attachment_policy` | REPLACED BY `knowledge.attachment_policy` | |
| 7.35 | `check_attachment_batch` | REPLACED BY `knowledge.check_attachment_batch` | |
| 7.36 | `attachment` | REPLACED BY `knowledge.attachment` | |
| 7.37 | `create_attachment` | REPLACED BY `knowledge.create_attachment` | |
| 7.38 | project export: CLI `backup export-project` (offline) | REPLACED BY `knowledge.project_export` | Needs `knowledge:export` and `attachments:read`. CLI only (OPEN-10). |
| 7.39 | project import: CLI `backup import-project` (offline) | REPLACED BY `knowledge.project_import` (OPEN-13) | First real consumer of `knowledge:import`. Today owner session. CLI only (OPEN-10). |
| 7.40 | hub `knowledge plan-import` (offline, no authentication) | LOCAL, provisional (OPEN-10) | Offline file read of a legacy Hub plan. |
| 7.41 | hub `knowledge execute-import` (offline, owner or installation credential) | LOCAL, provisional (OPEN-10) | Offline import under the lock. |

### 2.8 Family 8: Vault

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 8.1 | import (owner only, Ed25519 proof) | REPLACED BY `vault.import` | `secrets:write` replaces the owner proof. Open and token mode open the Vault with the token (owner decision `9ba49f3c` point 1). |
| 8.2 | update (owner only) | REPLACED BY `vault.update` | As 8.1. |
| 8.3 | list (owner only) | REPLACED BY `vault.list` | OPEN-18. |
| 8.4 | read (owner direct; agent with approved grant) | REPLACED BY `vault.read` | `secrets:read`, no per-use grant. |
| 8.5 | request (agent) | REMOVED: accepted target point 6 (request and once-grant flow removed), owner decision `9ba49f3c` point 1 | The `secrets` role replaces the request; an admin or maintainer grants it with a fresh login (`role.grant`). |
| 8.6 | requests | REMOVED: as 8.5 | Nothing pending exists to list. |
| 8.7 | inspect-request | REMOVED: as 8.5 | |
| 8.8 | approve | REMOVED: as 8.5 | Approval is the role grant. |
| 8.9 | reject | REMOVED: as 8.5 | |
| 8.10 | revoke (grant) | REMOVED: as 8.5 | `role.revoke` removes the `secrets` role. |
| 8.11 | write (agent, approved write grant) | REPLACED BY `vault.update` | Direct write with `secrets:write`; the immutable-patch grant disappears. |
| 8.12 | use (always `vault_use_unavailable`) | REMOVED: accepted target point 6 (no fictional `env:use`) | Never worked, nothing covers it. |
| 8.13 | audit (owner only) | REPLACED BY `vault.audit` | OPEN-18. |

### 2.9 Family 9: installation backups

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 9.1 | backup.overview: HTTP `GET`; socket; CLI `backup list` | REPLACED BY `backup.overview` | Needs `backups:manage`. Reachable by an admin in better-auth (HTTP is unreachable there today). |
| 9.2 | backup.create: HTTP; socket `create` and `now`; CLI | REPLACED BY `backup.create` | `create <dir>` and `now` collapse into one operation with an optional destination. |
| 9.3 | backup.preview: HTTP only | REPLACED BY `backup.preview` | OPEN-23. |
| 9.4 | backup.restore: HTTP; socket; CLI offline | REPLACED BY `backup.restore` | Offline restore no longer uses a no-op authorize (`backup-management.ts:80`): it runs as operator. OPEN-23. |
| 9.5 | backup.status: HTTP; socket; CLI | REPLACED BY `backup.status` | |
| 9.6 | backup.monitor: socket; CLI | REPLACED BY `backup.monitor` | Now on HTTP and MCP. |
| 9.7 | backup.remote_status: socket; CLI | REPLACED BY `backup.remote_status` | |
| 9.8 | backup.remote_reupload: socket; CLI | REPLACED BY `backup.remote_reupload` | |
| 9.9 | backup.remote_retry: socket; CLI | REPLACED BY `backup.remote_retry` | |
| 9.10 | backup.remote_rebind: CLI offline only | REPLACED BY `backup.remote_rebind` | CLI offline only (OPEN-11); gains an authority check (none today). |

### 2.10 Family 10: user backups and exports

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 10.1 | user_backup.overview: HTTP | REPLACED BY `user_backup.overview` | Needs export and attachment read per project. The installation token is accepted (rejected today). OPEN-12. |
| 10.2 | user_backup.save: HTTP | REPLACED BY `user_backup.save` | OPEN-12. |
| 10.3 | user_backup.status: HTTP | REPLACED BY `user_backup.status` | |
| 10.4 | user_backup.artifact: HTTP | REPLACED BY `user_backup.artifact` | |
| 10.5 | user_export.recovery_list: socket; CLI | REPLACED BY `user_export.recovery_list` | Needs `backups:manage`; now on HTTP and MCP. |
| 10.6 | user_export.recovery_preview: socket; CLI | REPLACED BY `user_export.recovery_preview` | |
| 10.7 | user_export.recovery_cleanup: socket; CLI | REPLACED BY `user_export.recovery_cleanup` | |

### 2.11 Family 11: identity, accounts and roles

Removed by the accepted target (points 2 and 5) and owner decision `9ba49f3c`
point 4: owner sessions and owner bootstrap, recover and renew; sponsors,
runtime delegations, credential ceilings and separate runtime credentials;
agent tokens and Knowledge grants in token mode; legacy mode. Agents in
better-auth keep exactly one revocable account token.

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 11.1 | identity.describe: MCP `get_identity`; HTTP `GET /api/identity` | REPLACED BY `session.describe` | Lists visible projects and permissions actually held, installation permissions and fresh-login state. Knowledge grants, runtime access and credential ceilings disappear from the result. |
| 11.2 | owner.bootstrap: HTTP; CLI `identity bootstrap-owner` | REMOVED: accepted target point 2 (no owner sessions, no legacy mode); target plan point 9 | The first admin is created by the operator with `account.create`, `account.enroll` and `admin_role.grant` over the unix socket or offline (OPEN-19). |
| 11.3 | owner.recover: CLI `identity recover-owner` (offline) | REMOVED: as 11.2 | The operator recovers the admin with `account.recover`. |
| 11.4 | owner.renew: HTTP admin; CLI; socket | REMOVED: as 11.2 | Sessions are provider sessions with fresh-login evidence. |
| 11.5 | create-agent | REPLACED BY `account.create` | Needs `accounts:manage`, a human admin with a fresh login. |
| 11.6 | list-agents | REPLACED BY `account.list` | |
| 11.7 | revoke-agent | REPLACED BY `account.disable` | |
| 11.8 | issue-agent-token | REPLACED BY `account.token_issue` (OPEN-20) | Exactly one token per agent account. Not available in token mode. |
| 11.9 | list-agent-tokens | REPLACED BY `account.list` | Token metadata is part of the account projection; `account.get` for one account. |
| 11.10 | revoke-token | REPLACED BY `account.token_revoke` | |
| 11.11 | create-knowledge-project | REPLACED BY `project.create` | One project entity. |
| 11.12 | grant-knowledge | REPLACED BY `role.grant` | Knowledge grants become project roles. Removed in token mode (accepted target point 1). |
| 11.13 | list-knowledge-grants | REPLACED BY `role.list` | Per account: `account.get`. |
| 11.14 | revoke-knowledge-grant | REPLACED BY `role.revoke` | |
| 11.15 | set-knowledge-role | REPLACED BY `role.grant` | `reader`, `operator`, `manager` become `reader`, `operator`, `maintainer`; existing grants are reset (owner decision `9ba49f3c` point 4). |
| 11.16 | list-knowledge-roles | REPLACED BY `role.list` | |
| 11.17 | revoke-knowledge-role | REPLACED BY `role.revoke` | |
| 11.18 | set-runtime-delegation | REMOVED: accepted target point 2 (no sponsor, delegations or ceilings) | A project role granted to the agent account (`role.grant`) covers it; adding a project needs a role grant and no token reissue (task `46b6a246` archive note in `4ac7fb45`). |
| 11.19 | revoke-runtime-delegation | REMOVED: as 11.18 | `role.revoke`. |
| 11.20 | list-runtime-access | REMOVED: as 11.18 | `role.list` and `account.get`. |
| 11.21 | issue-runtime-credential | REMOVED: accepted target point 2 (no separate runtime credentials) | The account token plus roles. |
| 11.22 | rotate-runtime-credential | REMOVED: as 11.21 | `account.token_issue` replaces the one token. |
| 11.23 | provider status: CLI `auth provider status`; socket | LOCAL: `auth provider status` | Provider configuration and enrollment status. |
| 11.24 | provider configure | LOCAL: `auth provider configure` | Writes the protected provider configuration and signing secret; authentication configuration is a local operator command. |
| 11.25 | provider owner-create | REMOVED: accepted target point 2 (owner principal) | `account.create` plus `admin_role.grant`, by the operator. |
| 11.26 | provider human-create | REPLACED BY `account.create` | |
| 11.27 | provider human-list | REPLACED BY `account.list` | |
| 11.28 | provider human-disable | REPLACED BY `account.disable` | |
| 11.29 | provider knowledge-access-list | REPLACED BY `role.list` | |
| 11.30 | provider knowledge-access-set | REPLACED BY `role.grant` | |
| 11.31 | provider knowledge-access-revoke | REPLACED BY `role.revoke` | |
| 11.32 | provider runtime-access-list | REPLACED BY `role.list` | One role set instead of separate Knowledge and runtime memberships. |
| 11.33 | provider runtime-access-set | REPLACED BY `role.grant` | Humans can now hold `logs:read`, `storage:read` through the reader role (excluded from human runtime actions today). |
| 11.34 | provider runtime-access-revoke | REPLACED BY `role.revoke` | |
| 11.35 | provider enroll | REPLACED BY `account.enroll` | |
| 11.36 | provider recover | REPLACED BY `account.recover` | |
| 11.37 | sign-in: `POST /api/auth/sign-in/email` | SPECIALIZED: provider route `/api/auth/*` | Pre-login; mints the session. Not in the registry. |
| 11.38 | session: `GET /api/auth/get-session` | SPECIALIZED: provider route | Provider session probe. `session.describe` is the registry hint for clients. |
| 11.39 | sign-out | SPECIALIZED: provider route | |
| 11.40 | password: `change-password` | SPECIALIZED: provider route (OPEN-17) | Self-service; always revokes other sessions. |
| 11.41 | totp-enable | SPECIALIZED: provider route (OPEN-17) | MFA ceremony. |
| 11.42 | totp-verify | SPECIALIZED: provider route | MFA ceremony. |
| 11.43 | passkey-register-options | SPECIALIZED: provider route (OPEN-17) | Passkey ceremony; not on MCP. |
| 11.44 | passkey-registration | SPECIALIZED: provider route (OPEN-17) | |
| 11.45 | passkey-confirm-options | SPECIALIZED: provider route | |
| 11.46 | passkey-confirmation | SPECIALIZED: provider route | |
| 11.47 | passkey-authenticate-options | SPECIALIZED: provider route | Pre-login. |
| 11.48 | passkey-authentication | SPECIALIZED: provider route | Mints the session. |

### 2.12 Family 12: remote verification

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 12.1 | remote_verification.submit: MCP only | REPLACED BY `remote_verification.submit` | Needs `tests:run`; the per-principal submit grant written by `provision` disappears. Now on HTTP and CLI. |
| 12.2 | remote_verification.get: MCP only | REPLACED BY `remote_verification.get` | OPEN-6. |
| 12.3 | remote_verification.get_logs: MCP only | REPLACED BY `remote_verification.get_logs` | OPEN-6. |
| 12.4 | remote_verification.cancel: MCP only | REPLACED BY `remote_verification.cancel` | OPEN-5, OPEN-6. |
| 12.5 | remote_worker.poll: worker listener | REPLACED BY `worker.poll` | Worker listener only. Needs `worker:execute` per assignment's project; `workerId` selects, never authenticates (`575a4fe8` answer f). OPEN-5. |
| 12.6 | remote_worker.report: worker listener | REPLACED BY `worker.report` | Worker listener only. |
| 12.7 | remote_verification.provision: CLI offline | REPLACED BY `worker.register` | Worker token file and `callerPrincipalIds` are gone (separate worker tokens removed, accepted target point 2). CLI offline only (OPEN-11). |
| 12.8 | remote_verification.revoke_token: CLI offline | REMOVED: accepted target point 2 (separate worker tokens) | Better-auth: `account.token_revoke` on the executor agent account. Token and open mode: the installation token, rotated locally (14.3). |
| 12.9 | remote_verification.inspect: CLI offline | REPLACED BY `worker.recovery_inspect` | Needs `workers:manage` (owner session removed). CLI offline only (OPEN-11). |
| 12.10 | remote_verification.reconcile: CLI offline | REPLACED BY `worker.recovery_reconcile` | As 12.9. |

### 2.13 Family 13: diagnostics and system

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 13.1 | mcp.diagnostics: HTTP; CLI `mcp diagnostics`; socket | REPLACED BY `diagnostics.mcp` | Needs `diagnostics:read`. The legacy secret and owner-session checks disappear. |
| 13.2 | dashboard.live: HTTP partial dashboard | REPLACED BY `project.status` | The dashboard shell composes per-project reads and `events.subscribe` (accepted target point 7); no partial-section endpoint. |
| 13.3 | events.subscribe: HTTP SSE | REPLACED BY `events.subscribe` (OPEN-9) | Every event authorized per subscriber. |
| 13.4 | directories.browse: HTTP | REPLACED BY `directory.browse` (OPEN-8) | |
| 13.5 | auth.status_http: `GET /api/auth/status` | SPECIALIZED: public status route | Public, before any authentication. One body in every mode. |
| 13.6 | mcp.session_endpoint: `/mcp` | SPECIALIZED: MCP transport route | The catalogue registered at session creation is the stable catalogue for the actor kind and listener, with call-time authorization. |
| 13.7 | static.dashboard_assets | SPECIALIZED: static assets | Public. |
| 13.8 | controller.start: CLI `start` | LOCAL: `start` | |
| 13.9 | service.manage: CLI `service ...` | LOCAL: `service install` and siblings | |
| 13.10 | sandbox.run: CLI `sandbox` | LOCAL: `sandbox` | |
| 13.11 | config.mcp: CLI `config mcp` | LOCAL: `config mcp` | Not named in the rule list; classified with `config path`. It no longer reads the legacy `mcp-token` file or a hard-coded `wsi_` prefix; the extra token environment variables go (accepted target point 2). |
| 13.12 | config.path: CLI | LOCAL: `config path` | |
| 13.13 | cli.help / version | LOCAL: `help`, `--version` | |

### 2.14 Family 14: authentication mode, token and fence

All seven are local operator commands: mode selection, installation token
generation and rotation and the security fence are outside the registry (owner
rule: mode changes only through the CLI and only after restart).

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 14.1 | auth.status | LOCAL: `auth status` | |
| 14.2 | token.generate | LOCAL: `auth token generate` | |
| 14.3 | token.rotate | LOCAL: `auth token rotate` | Closing live MCP sessions and SSE streams becomes revalidation of the minted context (contract: revoked credential is `unauthenticated`). |
| 14.4 | mode.set | LOCAL: `auth mode set` | Values `open`, `token`, `better-auth`; `legacy` is not accepted. |
| 14.5 | fence.inspect | LOCAL: `auth fence inspect` | |
| 14.6 | fence.establish | LOCAL: `auth fence establish` | |
| 14.7 | fence.resume | LOCAL: `auth fence resume` | |

## 3. Counts and reconciliation

### 3.1 Target operations

| Family | Operations |
| --- | --- |
| Session | 1 |
| Project and registration | 10 |
| Claim | 4 |
| Runtime | 6 |
| Configuration | 15 |
| Test runs | 13 |
| Storage, capacity, logs and system reads | 11 |
| Knowledge | 34 |
| Vault | 6 |
| Backups and exports | 17 |
| Accounts and roles | 13 |
| Remote verification and workers | 9 |
| **Total** | **139** |

Kinds, counted from the tables: 62 reads, 74 mutations, 2 waits
(`project.wait`, `test_run.wait`) and 1 stream (`events.subscribe`). 70 of the
74 mutations retain; `capacity.set`, `test_queue.set`, `worker.poll` and
`worker.report` do not. Operations with `agents: false`: 15
(`knowledge.approve_memory`, `vault.recover_key` and the 13 account and role
operations). Operations with `freshLogin`: 12 (the same two and 10 account and
role mutations).

Target operations that no row's disposition column names as its replacement,
because the records require them and the matrix has no equivalent row:

| Operation | Why it exists |
| --- | --- |
| `registration.attach`, `registration.move` | Contract v1: `project:manage` covers attach, detach and move of registrations. Row 7.32 names them as covering the removed link. |
| `runtime.force_stop` | Contract v1: stopping another session's run needs `runtime:administer`. Named in row 1.11. |
| `admin_role.grant`, `admin_role.revoke` | Contract v1: admin assignment needs `accounts:manage`. Named in row 11.2. |
| `account.get` | Part of the account projection (rows 11.9, 11.13). |
| `test_run.lookup_intent` | Contract v1 amendment 3 and answer d (task `6d680061`). No matrix row. |
| `vault.recover_key` | Contract v1 (provisional). No current operation. |

### 3.2 Rows per disposition class

| Family | Rows | REPLACED BY | REMOVED | SPECIALIZED | LOCAL |
| --- | --- | --- | --- | --- | --- |
| 1 Runtime and claims | 15 | 15 | 0 | 0 | 0 |
| 2 Project administration | 5 | 5 | 0 | 0 | 0 |
| 3 Configuration and profiles | 11 | 11 | 0 | 0 | 0 |
| 4 Verification and test runs | 11 | 11 | 0 | 0 | 0 |
| 5 Godot web | 3 | 3 | 0 | 0 | 0 |
| 6 Storage, capacity, metrics, logs | 10 | 10 | 0 | 0 | 0 |
| 7 Knowledge (37 names and 4 CLI-only) | 41 | 38 | 1 | 0 | 2 |
| 8 Vault | 13 | 6 | 7 | 0 | 0 |
| 9 Installation backups | 10 | 10 | 0 | 0 | 0 |
| 10 User backups and exports | 7 | 7 | 0 | 0 | 0 |
| 11 Identity, accounts and roles | 48 | 25 | 9 | 12 | 2 |
| 12 Remote verification | 10 | 9 | 1 | 0 | 0 |
| 13 Diagnostics and system | 13 | 4 | 0 | 3 | 6 |
| 14 Mode, token and fence | 7 | 0 | 0 | 0 | 7 |
| **Total** | **204** | **154** | **18** | **15** | **17** |

The resource row `1.R` (MCP resources, not counted in the 204) is also
REPLACED BY the read operations it mirrors. Rows whose cell also carries an
`OPEN-<n>` marker keep the class shown. There are 35: 1.9, 1.13, 2.2, 3.1, 4.1,
5.3, 6.2, 6.4, 6.6, 7.13, 7.38 to 7.41, 8.3, 8.13, 9.3, 9.4, 9.10, 10.1, 10.2,
11.2, 11.8, 11.40, 11.41, 11.43, 11.44, 12.2 to 12.5, 12.7, 12.9, 13.3, 13.4.
Rows 7.40 and 7.41 are provisionally LOCAL; the others are decided in class and
open in detail. Section 6 states each question.

### 3.3 Reconciliation

- The table in section 2 has 205 labelled rows: the 204 rows of the matrix plus
  `1.R`. No label occurs twice. Per family the counts equal the matrix's
  Appendix B (15, 5, 11, 11, 3, 10, 41, 13, 10, 7, 48, 10, 13, 7).
- The class columns above add up to 204 per row and in total, and to 205 with
  `1.R`.
- Knowledge: rows 7.1 to 7.37 carry the 37 operation names of
  `knowledgeSchemas` once each, in the matrix's order (12 memory operations,
  then 25 others); 7.38 to 7.41 are the four CLI-only items. Of the 37 names,
  36 are REPLACED BY an operation (32 by `knowledge.*`, 4 by `project.*`:
  `project`, `projects`, `archive_project`, `restore_project`), 1 is REMOVED
  (`link_runtime`) and none is LOCAL. Of the four CLI-only items, two are
  REPLACED BY and two are provisionally LOCAL.
- Every target operation named in the disposition column exists in section 1
  and every operation in section 1 is either named there or listed in the
  table in 3.1.
- Many-to-one mappings: `project.status` (1.2, 1.3, 7.13, 13.2), `project.list`
  (1.1, 1.R, 2.5, 7.14), `role.grant`, `role.list` and `role.revoke` (four rows
  each), `account.list` (11.6, 11.9, 11.27), and pairs such as `claim.acquire`
  (1.6, 1.13), `claim.release` (1.8, 1.14), `project.create` (2.1, 11.11) and
  `test_run.read` (4.3, 4.4). Row 1.5 maps to two operations (`project.wait`
  and `test_run.wait`) because the requirement depends on the target.

The counts were checked by counting table rows in this file, not by a tool that
understands the matrix: the matrix itself was not re-counted from source.

## 4. Behaviour changes visible to users and agents

Derived from the tables; each cites its rows. They describe an unreleased
breaking release with no compatibility layer (owner decision `9ba49f3c`
point 4).

1. **New MCP and HTTP contract, no compatibility layer.** Tool names, inputs,
   results and errors change; catalogues are stable per actor kind and
   listener and authorize at call time. `get_identity` becomes
   `session.describe`. Every family.
2. **A claim only reserves.** Installation MCP `claim_project` no longer places
   and starts the server; callers invoke `runtime.start`. Rows 1.6, 1.13.
3. **Legacy mode, owner sessions and the sponsor machinery disappear.** Mode
   `legacy` is rejected; owner bootstrap, recover and renew, runtime
   delegations, credential ceilings and separate runtime credentials are gone,
   and existing grants are reset while accounts and history stay. Rows 11.2 to
   11.4, 11.18 to 11.22, 11.25.
4. **Vault.** The request, approve, reject, once-grant flow and the Ed25519
   owner proof are gone; open and token mode open the Vault with the
   installation token; in better-auth the `secrets` role gives direct read and
   write without per-use consent; `use` is removed. Rows 8.1 to 8.13.
5. **HTTP runtime control needs a claim.** Start, stop, restart and switch no
   longer work on an unclaimed project through the token dashboard, and gain
   idempotency keys and receipts (OPEN-1). Rows 1.9 to 1.12.
6. **Installation projections shrink to safe DTOs.** `get_project_status`, the
   dashboard snapshot and profile and run reads no longer return literal
   environment values, raw commands, logs or output tails inline; they come
   from `config.read`, `profile.list`, `runtime_logs.read` and `test_run.logs`,
   gated by permissions that full authority holds. Rows 1.2, 3.2, 4.3, 6.8.
7. **Runtime logs are redacted and bounded for installation callers.** Today
   raw process output (`process-manager.ts:151-155`). Inferred from the rule
   that full authority never sees authentication handles; the contract does
   not state it for logs. Row 6.8.
8. **Token HTTP can no longer cancel any run.** Cancel is limited to the
   originating session; takeover is `test_run.admin_stop`. Row 4.5.
9. **Taking over is explicit.** Force-releasing a claim needs
   `runtime:administer` (any HTTP caller can today); stopping another session's
   run is `runtime.force_stop`. Rows 1.11, 1.15.
10. **One claim kind.** The human lock with owner `local-user` and the separate
    reservation routes are gone; token browsers and multi-command CLI use
    coordination sessions (OPEN-2). Rows 1.13 to 1.15.
11. **Profile selection never restarts.** The HTTP `restart` option and
    `restartRequired` are removed; callers use `runtime.restart`. Rows 3.3 to
    3.5.
12. **Archive and restore of a project need `project:manage`.** Operators and
    agents with `knowledge:write` lose it. Rows 7.30, 7.31.
13. **One project.** `link_runtime` is removed, `project.create` replaces
    `project add` and `create-knowledge-project`, and removing a registration
    keeps Knowledge. Rows 2.1, 2.2, 7.32, 11.11.
14. **Knowledge approval is human-only with a fresh login** in better-auth.
    Installation and operator remain exempt, so a token-mode MCP client can
    approve, as today. Row 7.5.
15. **Fresh login for sensitive actions.** Account and role administration,
    granting `secrets`, Vault key recovery and Knowledge approval need a human
    session authenticated within 10 minutes (`login_stale`, 403); agents get
    `forbidden`. Rows 7.5, 11.5 to 11.36.
16. **Accounts exist only in better-auth.** Account and role operations answer
    `unavailable` in open and token mode; agent tokens and Knowledge grants in
    token mode are removed (OPEN-19). Rows 11.5 to 11.17.
17. **Capacity and queue reads.** Aggregate counts for any `project:read`
    holder; holder detail per project needs `claims:manage`. Installation and
    operator still see all holders (OPEN-4). Rows 6.4, 6.6.
18. **Installation backups in better-auth.** Reachable by an admin over HTTP
    (unreachable today); offline restore no longer uses a no-op authorize;
    backup creation gains a recheck before the copy. Rows 9.1 to 9.10.
19. **User backups accept the installation token** and no longer only owner
    session or agent token; human owners of schedules are OPEN-12. Rows 10.1 to
    10.4.
20. **Errors.** Fourteen categories with a stable reason, retry disposition and
    effect state; the Polish-message regular expression that picks 409 or 400
    is gone; localized and English raw messages no longer cross the wire;
    `outcome_unknown` means inspect before retrying. Every row.
21. **Missing and invisible resources look alike.** `not_found` for both, no
    existence leak through errors, cursors, counts or waits; the account
    surface's `project_access_denied` 403 for both changes. Rows 1.1 to 6.10.
22. **Idempotency.** A store adapter with bounded retention replaces the
    session-held ledger (64 per session, 512 global) and HTTP operations accept
    keys; replays are
    reauthorized and can answer `resource_changed`. Rows 1.6 to 1.12, 3.x, 4.2.
23. **Test run reads.** Any `tests:read` holder reads the project's runs as safe
    status; own-run proof stays safe even for a caller holding `config:read`
    (task `6d680061`); `test_preset.list` has one projection (OPEN-14).
    Rows 4.1 to 4.4, 6.9.
24. **Events.** Each event is filtered per subscriber instead of broadcasting
    project IDs to everyone (OPEN-9). Row 13.3.
25. **Parity.** The CLI gains runtime, claim, configuration, test, Vault and
    Knowledge-style operations; MCP gains configuration, TLS, Godot, backups
    and capacity setting; HTTP gains operations that were MCP-only (remote
    verification, history, metrics) and the agent-only configuration read.
    Rows 1.9 to 1.12, 2.4, 3.x, 4.6 to 4.9, 5.x, 6.x, 12.1 to 12.4.
26. **Agents get the rest of the surface, by role.** The installation-only
    tools (history, metrics, environment, profiles, Godot) are available to
    any account holding the permission; diagnostics are no longer a snapshot of
    grants at session start. Rows 3.x, 4.6 to 4.9, 5.x, 6.1 to 6.8.
27. **Local CLI is the operator without a token.** The extra token environment
    variables (`WORKTREE_CONTROL_KNOWLEDGE_TOKEN`, Vault, owner and installation
    variables) and human login through CLI or MCP are removed; the socket needs
    no credential in any mode and acts are recorded as the local operator.
    Rows 7.38 to 7.41, 8.1 to 8.13, 11.2 to 11.36, 13.11.
28. **Workers.** Separate worker tokens and per-principal submit grants are
    removed; `workerId` selects a worker and never authenticates one; in
    better-auth the worker is an agent account holding `executor`. Rows 12.1 to
    12.10.
29. **Compact and `responseMode` options are gone**; one safe DTO per result
    with a `compact` input where a cursor envelope is needed. Rows 1.2, 1.3,
    1.6, 4.2.
30. **Specialized routes stay.** Sign-in, sign-out, MFA and passkey ceremonies,
    public status and static assets are not operations and are never reachable
    through MCP. Rows 11.37 to 11.48, 13.5 to 13.7.

Most consequential, in order: 1 (no compatibility layer), 2 (claims no longer
start servers), 3 (legacy and owner machinery removed, grants reset), 4 (Vault
flow removed) and 5 (HTTP runtime control needs a claim).

## 5. Permission coverage

Every permission of `src/shared/contracts/operations.ts`, with the target
operations that require it. `(c)` marks a collection requirement, `(p)` a
permission that is required only through a projection tier, not by the
requirement.

| Permission | Required by |
| --- | --- |
| `project:read` | `project.list` (c), `project.status`, `project.worktrees`, `project.wait`, `runtime.metrics` (c), `godot_web.status`, `capacity.read` (c), `test_queue.read` (c), `events.subscribe` (c) |
| `project:manage` | `project.archive`, `project.restore`, `registration.attach`, `registration.detach`, `registration.move` (source and destination) |
| `logs:read` | `runtime_logs.read`, `test_run.logs` |
| `storage:read` | `storage.read`; `storage.refresh` candidate (OPEN-15) |
| `storage:manage` | `storage.cache_delete`; `storage.refresh` candidate (OPEN-15) |
| `config:read` | `config.read`, `profile.list`, `test_profile.list`; raw commands in `project.status` (p) |
| `config:write` | `config.tls_set`, `config.environment_set`, `profile.save`, `profile.delete`, `preset.timeout_set`, `test_profile.save`, `test_profile.delete`, `test_preset.assign_profile`, `godot_web.configure` |
| `profiles:select` | `profile.select` |
| `claims:manage` | `claim.acquire`, `claim.renew`, `claim.release`; holder identities in `project.list`, `project.status`, `capacity.read` (p) |
| `runtime:control` | `runtime.start`, `runtime.restart`, `runtime.stop`, `runtime.switch`; `godot_web.rebuild` candidate (OPEN-15) |
| `runtime:administer` | `claim.force_release`, `runtime.force_stop`, `test_run.admin_inspect`, `test_run.admin_stop` |
| `tests:run` | `test_run.enqueue`, `test_run.cancel`, `remote_verification.submit`, `remote_verification.get`, `remote_verification.get_logs`, `remote_verification.cancel` |
| `tests:read` | `test_preset.list`, `test_run.read`, `test_run.logs`, `test_run.wait`, `test_run.history_list`, `test_run.summary`, `test_run.metrics`, `test_run.compare`; `test_run.lookup_intent` (OPEN-21) |
| `knowledge:read` | `knowledge.memories`, `memory`, `search`, `task_context`, `check_context_export`, `threads`, `reply`, `thread`, `replies`, `tasks`, `task`, `relations`, `history`, `task_state`; as the second term of every Knowledge write, `approve_memory` and `export_context` |
| `knowledge:write` | `knowledge.create_memory`, `update_memory`, `archive_memory`, `restore_memory`, `supersede_memory`, `create_thread`, `create_reply`, `create_task`, `task_from_thread`, `update_task`, `update_task_state` |
| `knowledge:approve` | `knowledge.approve_memory` |
| `knowledge:export` | `knowledge.export_context`, `knowledge.project_export`, `user_backup.overview` (c), `user_backup.save`, `user_backup.status` (c), `user_backup.artifact` |
| `knowledge:import` | `knowledge.project_import` (existing project; OPEN-13) |
| `attachments:read` | `knowledge.attachments`, `attachment_policy`, `attachment`, `check_attachment_batch`, `knowledge.project_export`, `user_backup.overview` (c), `user_backup.save`, `user_backup.status` (c), `user_backup.artifact` |
| `attachments:write` | `knowledge.check_attachment_batch`, `knowledge.create_attachment` |
| `secrets:read` | `vault.list`, `vault.read`, `vault.audit`; literal environment values in `config.read`, `profile.list` (p) |
| `secrets:write` | `vault.import`, `vault.update`, `config.environment_set`, `profile.save`, `test_profile.save` (OPEN-7) |
| `roles:manage` | `role.grant`, `role.revoke`, `role.list` |
| `worker:execute` | `worker.poll` (c), `worker.report` |
| `accounts:manage` | `account.create`, `account.enroll`, `account.list`, `account.get`, `account.disable`, `account.recover`, `account.token_issue`, `account.token_revoke`, `admin_role.grant`, `admin_role.revoke` |
| `projects:create` | `project.create`; `knowledge.project_import` when it creates a project (OPEN-13) |
| `projects:remove` | **no operation** (OPEN-3) |
| `capacity:read` | **no requirement**: only the installation-wide detail tier of `capacity.read` (p) (OPEN-4, OPEN-16) |
| `capacity:write` | `capacity.set`, `test_queue.set` |
| `settings:write` | **no operation** (OPEN-16) |
| `backups:manage` | every `backup.*` and `user_export.recovery_*` operation |
| `workers:manage` | `worker.register`, `worker.recovery_inspect`, `worker.recovery_reconcile` |
| `diagnostics:read` | `diagnostics.mcp` |
| `vault:recover` | `vault.recover_key` |

Permissions no operation requires: `projects:remove`, `settings:write`, and
`capacity:read` (used only as a projection tier). `knowledge:import` has one
consumer.

Requirements that cannot be expressed with the existing vocabulary and
requirement kinds, or whose static form hides a decision:

- A disjunction (`collection(project:read)` or `capacity:read`) for
  `capacity.read` and `test_queue.read`: OPEN-4.
- A conditional requirement chosen by input: `config.environment_set`,
  `profile.save` and `test_profile.save` (values only versus structure,
  OPEN-7); `knowledge.project_import` (existing versus new project, OPEN-13);
  "holder if claimed" for `runtime.*`, `profile.select` and
  `test_run.enqueue` (OPEN-1).
- A submitter predicate: `remote_verification.cancel`, and the submitter check
  at delivery in `worker.poll` (OPEN-5). Only three predicates exist.
- A resource kind for remote verification requests: none of the eight kinds
  fits (OPEN-6).
- `directory.browse` (OPEN-8) and `test_run.lookup_intent` (OPEN-21): the
  requirement is undecided, not inexpressible.

## 6. Open items

Each item is a place where the accepted rules and the recorded decisions do not
decide the disposition, the requirement, the role, or the surface. The page
shows a provisional cell only so that the table is complete; none of these was
resolved by its author. "Where" lists the catalogue operations and matrix rows
that carry the marker.

### OPEN-1 Claim relation of mutations that today need a claim only sometimes

- Where: `runtime.start`, `runtime.restart`, `runtime.stop`, `runtime.switch`
  (1.9 to 1.12); `profile.select` (3.4); `test_run.enqueue` (4.2).
- Facts. The predicate `claim_holder` is evaluated on a `claim` resource and
  answers `conflict`/`claim_not_held` when nobody holds it and
  `claim_held` for another session; full authority is not exempt
  (`decide.ts`, `predicateHolds`). Today account and agent paths require an own
  claim for start, stop and restart (`scoped-runtime.ts` and `human-runtime.ts`
  per the matrix), `profile.select` and preset timeouts require it only when the
  project is claimed (matrix 3.4), enqueue accepts an optional reservation id,
  and the token HTTP dashboard starts, stops, restarts and switches with no
  claim at all. A conditional "holder if claimed" has no requirement form.
- Options. (a) Every runtime operation requires `claim_holder`, so an HTTP
  caller must claim first; `profile.select` and `test_run.enqueue` carry no claim
  predicate. (b) Add a predicate "holder when a claim exists" to the
  vocabulary. (c) Split each operation into claimed and unclaimed variants.
- Implication. (a) is the simplest and breaks the token dashboard's one-click
  start; (b) preserves today's behaviour and changes the contract module; (c)
  doubles the catalogue. The page's tables assume (a) for `runtime.*` and
  state no claim predicate for the other two.

### OPEN-2 Coordination sessions: issuance and surfaces

- Where: `claim.acquire`, `claim.renew`, `claim.release`, every `claim_holder`,
  `run_originating_session` and `worker_assignment` predicate; rows 1.6 to
  1.8, 1.13, 1.14.
- Facts. Contract v1 (amendment 2) makes the holder a server-issued session
  with lease secret, expiry, generation and credential binding, and requires
  "explicit bounded coordination sessions" for the token browser and multi-
  command CLI. The contract page lists issuance, renewal, disconnect and
  restart under "Obligations of later slices". MCP sessions renew their claim
  from a timer today (`mcp-runtime.ts:1003-1047` per the matrix).
- Question. Is issuance a registry operation (for example an open and close
  pair), implicit in the listener or connection, or part of
  `claim.acquire`? How does a second CLI command or a reloaded browser tab
  reach the same session, and how does the lease secret travel?
- Options. Implicit per connection (MCP session, browser tab storage); explicit
  `session.*` operations the client calls and renews; or a CLI-local file with
  a lease secret. Each implies different parity for the CLI and a different
  recheck on reconnect.

### OPEN-3 Project removal and `projects:remove`

- Where: `registration.detach` (2.2); permission `projects:remove`.
- Facts. Contract v1 gives maintainers `project:manage` over registrations;
  Astra noted that mapping all removal to `projects:remove` would deny
  maintainers their own project (`575a4fe8` point 5). The accepted target says
  removing a registration does not delete Knowledge. No decision names an
  operation that deletes a project entity; Knowledge projects can only be
  archived today.
- Question. Is there a hard-delete of the whole project (and of what, given
  Vault ciphertext, claims, test history and audit), and who may do it? Or is
  `projects:remove` unused?
- Options. Add `project.delete` with `projects:remove` and an explicit data
  rule; map 2.2 to `registration.detach` only and drop the permission; or let
  `registration.detach` of the last registration require `projects:remove`.

### OPEN-4 Aggregate gate of capacity and queue reads

- Where: `capacity.read`, `test_queue.read` (6.4, 6.6).
- Facts. Contract v1: aggregate counts go to any account holding `project:read`
  on at least one project; holder details are filtered per project by
  `claims:manage`; installation-wide detail and `capacity:write` stay with
  `admin`. The vocabulary has no disjunction and no "on at least one project"
  form.
- Options. (a) `collection(project:read)` and release the aggregate only when
  the filtered collection is non-empty or the caller is full authority; the
  `capacity:read` permission then only gates the detail tier. (b) Require
  `authenticated` and filter inside the projection. (c) Add an `anyOf` kind.
- Implication. (a) is the one drawn in the tables. An account with zero roles
  then sees nothing, which matches the contract text, but the rule lives in the
  projector, not in the requirement.

### OPEN-5 Submitter predicates for remote verification

- Where: `remote_verification.cancel` (12.4), `worker.poll` (12.5).
- Facts. Cancel today needs the `submit` grant and `requestedBy ==
  principal` (`remote-verification-controller.ts:44-46`); poll can deliver
  assignments from several projects and must check executor and submitter
  (`575a4fe8` point 4, answer f). Predicates available: `claim_holder`,
  `run_originating_session`, `worker_assignment`.
- Options. Add a `request_submitter` predicate and a delivery-time pairing of
  `worker:execute` with the submitter's `tests:run`; or treat any `tests:run`
  holder on the project as able to cancel (weaker than today); or do the check
  in the runtime adapter outside the requirement.

### OPEN-6 Resource kind for remote verification requests

- Where: `remote_verification.get`, `get_logs`, `cancel` (12.2 to 12.4).
- Facts. The resource kinds are `project`, `registration`, `claim`, `test_run`,
  `profile`, `vault_entry`, `knowledge_record` and `worker_attempt`. A request
  id is none of these.
- Options. Resolve a request through `test_run` if requests are linked to runs
  (not established); add a kind; or resolve through `worker_attempt` and give
  up access to requests that have no attempt yet.

### OPEN-7 Literal values versus structure in environment operations

- Where: `config.environment_set`, `profile.save`, `test_profile.save` (3.1,
  3.3, 3.7).
- Facts. Astra's answer b: literal values need `secrets:read`, their mutation
  `secrets:write`, and configuration authority as well when changing profile
  structure or execution policy. A requirement is static; "values only" and
  "structure" are properties of the input.
- Options. (a) Static `allOf(config:write, secrets:write)` as drawn: an
  account holding only `secrets` cannot change values, an operator cannot
  rename variables. (b) Two operations (names and structure under
  `config:write`; values under `secrets:write`). (c) A conditional
  requirement, which the vocabulary lacks.

### OPEN-8 Requirement of `directory.browse`

- Where: `directory.browse` (13.4).
- Facts. The listing is confined to the configured browse root by real path
  (`directory-browser.ts:19-25`). Two callers exist today: the add-project
  dialog and the TLS file picker.
- Options. `installation projects:create` (blocks maintainers editing TLS);
  `authenticated` (any account lists directory names of the host); or two
  operations, one per purpose.

### OPEN-9 `events.subscribe`: registry stream or specialized route

- Where: `events.subscribe` (13.3).
- Facts. The accepted target lists SSE among the specialized parts that stay
  (`5583b882`, point 7); the contract has a `stream` kind that authorizes and
  projects every event, and Astra noted that runtime SSE broadcasts every
  event with project IDs to all clients today (`575a4fe8` point 1).
  Controller-wide events (capacity, queue, controller section) carry no
  project.
- Options. Registry stream with SSE framing as the adapter, as drawn; or a
  specialized route that does its own per-subscriber filtering (duplicating
  the release rules). Either way: what a subscriber with no project receives
  for controller-wide events, and whether MCP gets a notification form (today
  it has `project.wait`).

### OPEN-10 Path-based Knowledge operations: surfaces and Hub import

- Where: `knowledge.project_export`, `knowledge.project_import` (7.38, 7.39);
  rows 7.40, 7.41.
- Facts. Today these run offline under the lock with an owner or
  installation credential, and read or write directories on the controller
  host. Exposing them on HTTP or MCP lets a remote caller name host paths. The
  Hub importer reads a legacy plan file (no authentication for `plan-import`)
  and imports under the lock; its Hub inputs are historical. The matrix did not
  read `hub-import*`.
- Options. Registry operations on `C` only as drawn, or on all surfaces with a
  host-path allowlist; Hub import as a registry operation with
  `knowledge:import` and `projects:create`, as LOCAL maintenance, or retired
  with the Hub (the file backlog was retired on 2026-10-10).

### OPEN-11 Offline-only operations

- Where: `backup.remote_rebind` (9.10), `worker.register` (12.7),
  `worker.recovery_inspect` and `worker.recovery_reconcile` (12.9, 12.10).
- Facts. Each needs the exclusive controller lock today (a completed restore,
  a stopped controller, or process recovery on the host). The acceptance table
  mints an operator context for offline invocations.
- Question. Stay offline-only registry operations on `C`, or gain an online
  path, which the parity rule would otherwise require? `fence.*` is already
  LOCAL by rule.

### OPEN-12 Owners of export schedules

- Where: `user_backup.overview`, `save`, `status`, `artifact` (10.1 to 10.4).
- Facts. Today a schedule's credential must be an owner session or an agent
  token; `provider_session` is refused ("Schedule credential is unavailable",
  `cli/index.ts:319-331`) and a credential created before the last restore
  requires renewal. Astra: a human session stored in a long-lived schedule
  stops working after logout, while re-resolving as installation elevates
  (`575a4fe8`, hypotheses). Contract: durable owner plus an immutable job
  specification with current owner grants at dispatch.
- Questions. May human accounts own schedules in better-auth? Who owns a
  schedule in open and token mode (the shared `installation` principal)? What
  happens to a schedule when its owner is disabled or loses `knowledge:export`?

### OPEN-13 One project in Knowledge reads, and the `knowledge:import` consumers

- Where: rows 7.13, 7.39; `knowledge.project_import`.
- Facts. Owner decision `9ba49f3c` point 2 and target point 4 make one
  project entity; the page replaces Knowledge `project` and `projects` by
  `project.status` and `project.list`. Knowledge `project` returns revision,
  status and a `writable` flag that the safe status DTO does not list. Project
  import requires an owner session today; `knowledge:import` is enforced by no
  operation (`project-transfer.ts:70`). Contract v1: import into an existing
  project needs `knowledge:import` on it, an import that creates a project
  needs `projects:create`.
- Questions. Do the merged DTOs carry the Knowledge fields, and does
  `knowledge_project` remain a tool name? Is create-versus-existing one
  operation with a conditional requirement or two operations?

### OPEN-14 Projection of `test_preset.list`

- Where: `test_preset.list` (4.1).
- Facts. The agent path lists presets whose environment profile is not `clean`
  and `run_test` then refuses them (`scoped-verification.ts:46-54` against
  `157-163`); the account path filters them (`human-verification.ts:50`). The
  permission is also open: agents need `tests:run` today, the page uses
  `tests:read`.
- Options. List only enqueueable presets (the account behaviour); list all with
  a flag; and `tests:read` or `tests:run`.

### OPEN-15 Requirements of `storage.refresh` and `godot_web.rebuild`

- Where: rows 6.2 and 5.3.
- Facts. Both exist only on HTTP and MCP today, with no permission and no
  requester at the queueing point. Roles do not say who may trigger a disk
  scan or a web export. `storage:manage` is maintainer-only.
- Options. `storage.refresh`: `storage:read` (reader can trigger a scan) or
  `storage:manage`. `godot_web.rebuild`: `runtime:control`, `config:write`, or
  `tests:run`.

### OPEN-16 Permissions without a consumer: `settings:write`, `capacity:read`

- Where: permission coverage.
- Facts. No current operation maps to `settings:write`. `capacity:read` is held
  by `admin` only and, with `project:read` everywhere, adds nothing to a
  requirement; the contract uses it for the installation-wide detail tier.
- Question. Which settings does `settings:write` guard (the matrix lists none)?
  Is `capacity:read` retained only as a projection tier, or does `capacity.read`
  need a separate installation-wide variant?

### OPEN-17 Self-service account ceremonies

- Where: rows 11.40, 11.41, 11.43, 11.44.
- Facts. Contract v1 names a requirement kind `authenticated` for
  `session.describe` "and self-service account operations", and Astra says to
  keep provider ceremonies outside the generic executor. Password change, TOTP
  enrollment and passkey registration need a current session and factor state
  that only the provider holds.
- Options. SPECIALIZED provider routes as drawn, or registry operations with
  `authenticated` that call the provider. The first keeps one boundary for
  ceremonies; the second gives them the shared error and release shape.

### OPEN-18 Vault list, audit, recovery and plaintext release

- Where: `vault.list`, `vault.audit` (8.3, 8.13), `vault.read`,
  `vault.recover_key`.
- Facts. No decision states who may list profile metadata or read the audit
  trail. `vault.read` releases plaintext to any account holding `secrets`,
  including an agent over MCP, into the agent's context. The key-recovery
  operation has no current code (the Vault code was not read for this page).
- Questions. Are list and audit `secrets:read`, `project:read`, or
  maintainer-visible? Is plaintext release over MCP intended? What does
  `vault.recover_key` do and what does a failed or interrupted recovery leave?

### OPEN-19 Accounts in open and token mode; first admin

- Where: account and role operations (11.5 to 11.36).
- Facts. The principle is "every feature works in every mode"; the target also
  says accounts are administered "where they exist". `admin` is a human role
  and account operations are `accounts:manage`.
- Question. In open and token mode, do account and role operations answer
  `unavailable`, or is there a degenerate meaning (for example a single
  installation actor)? Who creates the first admin: the operator over the
  socket or offline, as the page assumes from target point 9?

### OPEN-20 Agent token lifecycle

- Where: `account.token_issue`, `account.token_revoke` (11.8, 11.10, 11.22).
- Facts. "Exactly one revocable account token" per agent. Rotation today is a
  separate operation with scope and expiry rules (11.22).
- Questions. Does issuing replace the existing token or refuse while one is
  active? Is the first token issued by `account.create`? Optional expiry?

### OPEN-21 Original-intent lookup (task `6d680061`)

- Where: `test_run.lookup_intent`.
- Facts. Contract v1 keeps it a distinct bounded operation separate from
  project-wide safe read, originating-session cancel and administrative
  recovery. It uses the saved origin-session digest with an explicit digest
  version, preserves bounded ambiguous and unavailable outcomes and
  `releaseSafe`. The implementation is an obligation of a later slice and the
  I1 branch was not read.
- Questions. Requirement (`tests:read` on the project, plus a binding of
  original principal, credential and project?), digest versioning, and how the
  autofix adapter authenticates as the original principal.

### OPEN-22 Administrative recovery of runs and tests

- Where: `runtime.force_stop`, `test_run.admin_inspect`, `test_run.admin_stop`
  (4.10, 4.11, 1.11).
- Facts. Contract v1 says stopping or recovering another session's run needs
  `runtime:administer`. It does not say whether inspecting ownership and
  resolution needs it too, and the three operations are drawn under one
  permission.
- Options. Inspect under `tests:read` with the holder projection gated by
  `claims:manage`; or keep `runtime:administer`. Also whether a stopped
  project process requires the claim to be force-released first.

### OPEN-23 Backup preview kind and restore boundary

- Where: `backup.preview`, `backup.restore` (9.3, 9.4).
- Facts. `RestorePreview` reports `invalidatesScopedCredentials` and
  `stopsManagedProcessesAndTests`; Astra says restore has a pending replay and a
  drained handoff that needs "an explicit commit boundary, not a live session
  requirement after shutdown" (`575a4fe8` point 1). The accepted target keeps
  restore specialized. The matrix did not trace whether preview persists a
  record.
- Questions. Is `preview` a read or a mutation? Where exactly is the commit
  point, and what does the registry operation own versus the restore state
  machine?

### OPEN-24 Rules for role administration

- Where: `role.grant`, `role.revoke`, `role.list`, `admin_role.*`, account reads.
- Facts. A maintainer grants roles on their own project only; admin role
  assignment needs `accounts:manage`; granting `secrets` needs a fresh login;
  grants validate recipient kind and scope. `role.grant` is one operation, so
  every role grant requires a fresh login, not only `secrets`.
- Questions. May a maintainer grant `maintainer` and `secrets`? May an account
  revoke its own role or the last admin? Do the read operations need a fresh
  login or only `agents: false`? Should granting `secrets` be a separate
  operation so other grants avoid the fresh-login cost?

### Matrix open questions (findings section 7)

| Question | Answer from source | Remaining |
| --- | --- | --- |
| 1 Callback positions in `operateClaimed` and `placeClaimed` | Answered. `operateClaimed` calls `authority()` first (`runtime-service.ts:41`) and a combined claim and authority `verify` (`:45`) before the stop (`:64`), at `:77`, `:85`, `:87`, passes it to `startRuntime` (`:101`) and calls `authority()` once more at the end (`:134`). `placeClaimed` runs `verify` at `:146`, `:159` and passes it to `startRuntime` (`:171`). HTTP `operateLocked` calls `actor.revalidate` at `:269` and `:285` and passes `verify` to the spawn at `:314`. | The position inside `startRuntime` after readiness was not read. |
| 2 Force release and `operate` against an agent claim | Answered. `releaseReservation(..., force)` removes any active claim without owner or kind checks (`sqlite-state-store.ts:1408-1415`). Non-force release of an agent claim by `local-user` throws (`:1414`). HTTP `operate` by `local-user` against another owner's claim fails with `claim_stale` through `authorizeReservation` (`:1359-1366`). | Nothing. |
| 3 Backup `authorize` and `uiActions` | Partly. `authorize` is `authentication.isCurrentInstallationActor` (`cli/index.ts:277`); `uiActions` is policy data, default empty, and requires `--backup-dir` (`policy.ts:12-14`). | Which `restore-operations.ts` authorize calls run after awaits. |
| 4 Enforcement of `knowledge:import` | Answered. No operation checks it; project import requires an owner session (`project-transfer.ts:70`); the permission appears only in role tables (`policy.ts:13`) and legacy grant seeding (`sqlite-state-store.ts:239`). | Hub import (`hub-import*`) was not read. |
| 5 Account-mode dashboard live updates | Not answered. `/api/events` is unreachable with a provider cookie; `use-dashboard.ts:382` polls diagnostics and metrics every 5 s, which does not show how runtime state arrives. | Open (feeds OPEN-9). |
| 6 Redaction of `statusQueries.logs` | Answered. None: `logTail` returns raw lines (`process-manager.ts:151-155`) and the executable and arguments are written into the log (`:180`); `status-service.ts:166-180` only bounds size. | Nothing. |
| 7 `UserSchedules` `authorize` and `canRead` | Answered for `authorize` (`cli/index.ts:319-331`): current identity, no provider session, post-restore credential age, and `knowledge:read` plus `knowledge:export` per project. | `canRead` was not traced; feeds OPEN-12. |
| 8 Installation and remote grants | Answered. `provision` accepts only owner or agent callers (`cli/remote-verification.ts:105-108`), so an installation actor cannot hold a grant. | Moot under the target (grants are replaced by roles). |
| 9 Legacy pairing token and MCP secret | Answered. Different values: the HTTP pairing token is random per start (`cli/index.ts:382`), the MCP secret is a persisted file (`:389`). | Nothing; legacy mode is removed. |
| 10 Schema bounds | Partly. `testPresetTimeoutSchema`: id trimmed 1 to 160 with a required `node:`, `django:` or `godot:` prefix, timeout 1 to 86,400,000 or null (`preset-timeout.ts:5-8`). This **corrects the matrix** row 3.10, which says installation and HTTP accept any preset id text. | History, summary, metrics and comparison schemas not read. |
| 11 `DirectoryBrowser` limits | Answered. Real path of the requested directory must stay inside the real path of the configured root, so symlinks cannot escape (`directory-browser.ts:19-25`); errors are Polish text. | Nothing. |
| 12 Body of `/api/auth/status` | Answered. `{ mode, loginAvailable }` only (`authentication.ts:4`). The type still lists `legacy`. | Nothing. |
| 13 Which recovery methods need the owner | Answered. Both `inspect` and `reconcile` call `owner` (`worker-recovery.ts:49-50`, `69-70`), as does the method at `:46`. | Nothing. |
| 14 `recover-owner` while a controller runs | Answered. It skips both online branches (`identity-management.ts:245-259`) and acquires the lock (`:260`), which throws `ControllerAlreadyRunningError` when the pid is alive (`controller-lock.ts:75`). | Nothing; the operation is removed. |
| 15 Default wait of MCP `wait_for_status_change` | Answered. `DEFAULT_WAIT_MS` is 10,000 ms, maximum 20,000 (`status-service.ts:11-12`, `194`, `221`). | Nothing. |

Summary: answered from source 11 (1, 2, 4, 6, 8, 9, 11, 12, 13, 14, 15; 1 and 4
with a stated residue), answered in part 3 (3, 7, 10), not answered 1 (5). The
matrix's statement in row 3.10 that installation and HTTP accept any preset id
text is corrected by question 10.
