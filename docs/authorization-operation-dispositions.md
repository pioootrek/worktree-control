---
audience: "owner, implementers and reviewers of the authentication and authorization unification"
last_reviewed: "2026-11-13"
source_of_truth: "revised draft disposition of every current operation under the unreleased authorization contract; Knowledge task 040062b4, discussion 8a2683b8, replies e06943b7, 42019833, ce8aa214 and 29cf8fa5"
status: "active"
---

# Authorization operation dispositions

**Revised draft. Review `ce8aa214` is applied; a focused re-review is pending.
It describes an unreleased breaking change.** Nothing in the product follows
this page yet. It is the slice 1 deliverable that
[the authorization contract](authorization-contract.md) lists under "Not
implemented": the disposition of every operation that exists today.

The first draft (commit `e1cd3fd1`) was revised against four Knowledge replies,
which are binding for this page in this order of precedence, later ones winning
where they differ:

1. `e06943b7`: the architect's first decisions on OPEN-3 to OPEN-24.
2. `42019833`: the owner's decision on OPEN-1 (a claim is protection, not
   permission).
3. `ce8aa214`: the independent review (findings F1 to F14, sixteen required
   changes).
4. `29cf8fa5`: the architect's final decisions: all sixteen required changes
   accepted, nine planned contract extensions, design answers for OPEN-2,
   OPEN-21 and OPEN-23, and two questions left to the owner (A and B).

Owner questions A and B were answered (`17802524`, [section 9.2](#92-owner-questions-a-and-b-decided));
no open item remains. The two places the revision found
undecided (`NEW-OPEN-1`, `NEW-OPEN-2`) were decided afterwards by the lead and
confirmed or extended by the owner (`46672ea8`, `fb1567d5`;
[section 9.4](#94-decided-after-the-revision)). Everything else the first draft
left open is decided and recorded in [section 9.1](#91-decided).

**Implemented versus planned.** The code in the draft pull request #128 can
express only what [section 1](#1-implemented-vocabulary-and-planned-contract-extensions)
lists as implemented. Every catalogue row that needs something else carries a
marker in its `Needs` column, so a reader can tell what that code can already
express.

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
  `9ba49f3c`, `2c641ff7`, `4ac7fb45`, and for OPEN-1 `42019833`. Accepted
  target: `5583b882`, `1367c632`. Contract v1: `032aa386`; the review it
  adopts: `575a4fe8`. Decisions M and N: `9d5ae2f7`. Acceptance of the slice 1
  code: `142b86d3`. Draft delivery and first decisions: `e06943b7`. Independent
  review: `ce8aa214`. Final decisions: `29cf8fa5`.
- Source reading in the worktree at `81b99935` (product source identical to
  `659b207e` outside the new module) for the matrix's open questions; see the
  [appendix](#appendix-matrix-open-questions).

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
  In open and token mode they answer `unavailable` with reason
  `accounts_not_enabled` (OPEN-19).

Requirement vocabulary used in the `Requirement` column: `authenticated`;
`P on slot` (a project permission on a resource slot); `installation P`;
`allOf(...)`; `collection(P)`; the predicates `claim_holder`,
`run_originating_session` and `worker_assignment`; and the flags `agents: false`
and `freshLogin`. These exist in the code. Requirement forms and predicates that
exist only as decisions (`any_project(P)`, `claim_holder_if_claimed`,
`schedule_owner`, `request_submitter`, `intent_origin`) are written the same way
and are always accompanied by a marker in the `Needs` column. Full authority
(`installation`, `operator`) passes permissions and flags. It does not pass
resource resolution or the predicates, which protect foreign claims, runs,
assignments and owned schedules.

`Needs` column. Empty (`-`) means the row can be expressed in the implemented
vocabulary and execution shapes. Otherwise it names the planned extension from
[section 1.2](#12-planned-contract-extensions) that the row depends on:
`query`, `bounded_stream`, `expected_transition`, `claim_holder_if_claimed`,
`any_project`, `schedule_owner`, `remote_request`, `request_submitter`,
`secret_safe_retention`, `token_delivery`, `intent_origin`, `coordination`.
A label
`OPEN-<n>` in a cell is a reference to the decision on that former open item in
[section 9.1](#91-decided); it is not an open marker.

Commit point (decision N). `entry`: the handler is past its point when invoked,
so nothing typed can be refused inside it. `declared`: a typed refusal is
possible before the effect begins, stated in one phrase. Reads, queries and
streams show `-`.

Retain. `yes`: the operation declares retention and accepts an idempotency key.
`yes, secret-safe`: the operation retains only a receipt of ids and revisions,
never its input or a secret output ([section 4.3](#43-secret-safe-retention-and-token-delivery)).
A key on any other operation is `invalid_request`. A key is 1 to 128 restricted
characters on every operation ([section 4.10](#410-idempotency-key-limits)).

Row labels. The disposition table keeps the matrix's labels (`1.1` to `14.7`,
and `1.R`). The matrix gives Knowledge no row numbers: this page numbers its 37
operation names `7.1` to `7.37` in the matrix's listing order and its four
CLI-only items `7.38` to `7.41`.

## 1. Implemented vocabulary and planned contract extensions

### 1.1 What the code can express today

From `src/shared/contracts/operations.ts` and
`src/server/modules/operations/` at `e1cd3fd1`:

| Part | Implemented |
| --- | --- |
| Operation kinds | `read` (a synchronous callback; a Promise is rejected), `mutation`, `stream` |
| Requirement kinds | `authenticated`, `installation`, `project` (a permission on a resource slot), `all`, `collection`, `predicate` |
| Predicates | `claim_holder`, `run_originating_session`, `worker_assignment` |
| Resource kinds | `project`, `registration`, `claim`, `test_run`, `profile`, `vault_entry`, `knowledge_record`, `worker_attempt` |
| Flags | `agents: false`, `freshLogin` |
| Permissions | the closed list of 24 project and 10 installation permissions, including `projects:remove` |
| Roles | `reader`, `operator`, `maintainer`, `secrets`, `executor`, `admin` |
| Replay and release | authorize and compare the original resource resolution (project, version, relation) again after the effect and on replay |

### 1.2 Planned contract extensions

These are design decisions of `29cf8fa5` (deltas 1 to 9) plus the two
additions of the same reply (`intent_origin`, `coordination.*`). They were
not implemented in PR #128. The first pull request of slice 4
([section 10](#10-proposed-cut-of-slice-4)) implements extensions 1 to 7, 9
and 10 in the unmounted module, as recorded in the `Status` column and
described in [the authorization contract](authorization-contract.md#contract-extensions-of-slice-4).
No product operation, transport or store adapter uses them yet. A row that
needs one of them says so in its `Needs` column.

| # | Extension | Marker in `Needs` | What it adds | Status |
| --- | --- | --- | --- | --- |
| 1 | Kind `query` and waits as bounded one-event streams | `query`, `bounded_stream` | `query`: authorization in an admitted phase, asynchronous work outside admission, then a fresh decision with unchanged resolution before release. `project.wait` and `test_run.wait` are streams of at most one event with waiter limits and cancellation. There is no `wait` kind. Discovery, hashing and filesystem reads (`project.worktrees`, `test_preset.list`, `backup.preview`, `directory.browse`) are queries. See [section 2](#2-execution-shapes-and-expected-transitions). | implemented, unmounted |
| 2 | Expected transitions | `expected_transition` | An operation may declare which resource slots its effect changes or removes (`registration.move`, `registration.detach`, `claim.release`, `claim.force_release`, `runtime.switch`, `user_backup.save`). | implemented, unmounted |
| 3 | Predicate `claim_holder_if_claimed` | `claim_holder_if_claimed` | Owner decision OPEN-1 (`42019833`): with no claim anyone holding the permission may act; when a claim exists only its holder may; anyone else needs `claim.force_release` (`runtime:administer`). Needs a way to resolve an absent claim safely. | implemented, unmounted: resource kind `project_claim`, requirement `same_project` and `recheck()` between steps of an effect |
| 4 | Requirement kind `any_project(permission)` | `any_project` | Aggregates (`capacity.read`, `test_queue.read`, controller-wide events) require `project:read` on at least one project. Installation detail is a separate operation requiring `capacity:read`. | implemented, unmounted |
| 5 | Predicate `schedule_owner` | `schedule_owner` | Durable account ownership of an export schedule, evaluated on a server-resolved schedule resource. | implemented, unmounted: resource kind `schedule` |
| 6 | Resource kind `remote_request`, predicate `request_submitter`, two-principal evaluation | `remote_request`, `request_submitter` | Assignment evaluates the executor's context and, separately, the stored submitter's current grants through an application authorization interface. | implemented, unmounted: `decideForPrincipal` and `PhaseScope.authorizePrincipal` |
| 7 | Secret-safe retention and once-only token delivery | `secret_safe_retention`, `token_delivery` | Keyed-digest fingerprints; ids-and-revisions receipts for secret-bearing operations; a token is delivered once. | implemented, unmounted; the key's source and rotation (D6) stay with the store adapter |
| 8 | Separate profile structure and literal-value operations | none | Catalogue structure only; the split operations use the implemented requirement forms. | nothing to implement in the contract |
| 9 | Drop `projects:remove` | none | The permission leaves the closed vocabulary; code, documentation and fixtures change together in the first slice 4 pull request. | implemented: removed from the code, the tests and `authorization-contract.md`; other sections of this page still mention it |
| 10 | Predicate `intent_origin` | `intent_origin` | Original principal, credential, project, worktree, preset, key and the saved origin digest with its version, for `test_run.lookup_intent`. | implemented, unmounted: resource kind `test_intent`, digest version 1; the lookup query is not |
| 11 | Operations `coordination.open`, `coordination.renew`, `coordination.close` and the session store | `coordination` | Server-issued coordination sessions. Today the contract only compares a `CoordinationSessionRef` that a verifier returns. | not implemented (D1) |

The planned contract changes do not need a general `anyOf` or a conditional
requirement: the splits of extension 8 and the two import operations replace
them.

## 2. Execution shapes and expected transitions

### 2.1 Reads, queries and streams

`read` stays a synchronous callback over data the application already holds.
Work that waits (discovery, hashing, filesystem access, process inspection)
cannot run inside it, and an asynchronous service must not be called before
authorization in a transport. `29cf8fa5` delta 1 specifies the shapes:

| Shape | Operations | Phases and limits |
| --- | --- | --- |
| `query` | `project.worktrees`, `test_preset.list`, `test_run.lookup_intent`, `directory.browse`, `backup.preview` | (1) Initial authorization and resolution in an admitted phase; (2) asynchronous work outside admission; (3) a fresh decision with the resolution unchanged before anything is released; a changed resolution or revoked authority releases nothing and answers as the new decision does. Caller cancellation abandons the work and releases nothing. Discovery is bounded and coalesced rather than repeated (for example 64 trees, 256 presets and 64 KiB for presets; the real-path root for directories). Nothing a query does is an effect the caller authorized: it persists nothing in the caller's name (`backup.preview` persists no restore request). |
| `stream`, one event | `project.wait`, `test_run.wait` | Initial authorization; idle waiting with no work in admission; re-resolution when the wait ends; authorization again before the event is released (release authorization); cancellation through `return()`; waiter limits; default timeout 10 s, maximum 20 s (the matrix, `status-service.ts:11-12`). At most one event is delivered. |
| `stream`, long-lived | `events.subscribe` | Every event is authorized and projected per subscriber; SSE is the adapter. Controller-wide events are aggregates released under `any_project(project:read)`. |

`wait` is not a kind. The first draft listed it as one; no code supports it.

### 2.2 Expected-transition receipts (planned extension 2)

An operation whose own effect changes the resource it was authorized against
invalidates the runner's rule that authorization and replay compare an
unchanged resolution. Affected operations and what each changes:

| Operation | Slot changed by its effect |
| --- | --- |
| `registration.move` | `source`: the registration's project and version change; `destination` receives it |
| `registration.detach` | `registration`: the mapping is removed |
| `claim.release` | `claim`: the active holder relation is removed |
| `claim.force_release` | `claim`: the holder relation is changed or removed |
| `runtime.switch` | `claim`: when a claim exists, the holder's claim moves to the destination worktree in the same effect (`46672ea8`) |
| `user_backup.save` | `schedule`: on a change of project the schedule's project binding changes; original and resulting project and owner are retained and both bindings are authorized on release and replay |

Rule (`29cf8fa5` delta 2). The operation declares its changed slots. For a
declared slot the runner authorizes release and replay against the relation
recorded at the commit point plus the resulting relation returned by the handler
and confirmed by the resolver. An undeclared slot keeps today's
unchanged-resolution rule, so an unrelated concurrent change still answers
`resource_changed`. Receipts carry nothing the caller could not see before the
effect. For `registration.move` the check stays against both the source and the
destination, including historical authority; a resolver version change on a
slot the operation did not declare is not suppressed, and replay checks are not
weakened globally. This is a prerequisite contract review in the first slice 4
pull request, not a transport workaround.

## 3. Target operation catalogue

Identifiers are `family.verb`, lower case. A resource slot names what the
operation acts on; each slot resolves to exactly one project or to not-found.
Where a requirement mentions a planned form (`claim_holder_if_claimed`,
`any_project`, `schedule_owner`, `request_submitter`, `intent_origin`), the
`Needs` column names it; the form is a decision of `29cf8fa5`, not code.

Every catalogue table has the same columns: `Id`, `Kind`, `Resources`,
`Requirement`, `Needs`, `Flags`, `Commit`, `Retain`, `Surfaces`, and
`Projection and notes`. Section 4 holds the specification that several rows
share (lifecycle invariants, profile split, retention, schedules, transfers,
remote verification, administrative stop, accounts, sensitive output).

### 3.1 Session and coordination

| Id | Kind | Resources | Requirement | Needs | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `session.describe` | read | none | `authenticated` | - | - | - | no | H M C | A hint, never an authorization. Actor, mode, listener, installation permissions, every visible project with the permissions held there (decision M), fresh-login state. Works with zero roles. The only operation implemented in slice 1. |
| `coordination.open` | mutation | none | `authenticated` | `coordination`, `secret_safe_retention` | - | declared: the credential identity and generation are checked before the session is stored | yes, secret-safe | H C; M: the transport opens one at MCP session start, no tool | OPEN-2. Returns a session id and a secret, bound to the credential identity and generation, with an idle expiry. The receipt holds ids only: a replay never returns the secret, and a lost response is repaired by opening again. A new session never adopts a claim. |
| `coordination.renew` | mutation | none (the presented session secret) | `authenticated` | `coordination` | - | declared: an expired or invalidated session is refused before the extension | no | H C; M: transport | Extends the idle expiry. Idempotent by nature. |
| `coordination.close` | mutation | none (the presented session secret) | `authenticated` | `coordination` | - | entry: closing has no typed refusal | no | H C; M: the transport closes it at MCP session end, no tool | Closes the session. |

Surfaces of the session (OPEN-2, `29cf8fa5`). Browser: the dashboard opens one
per tab and keeps the secret in tab storage, so a reload continues. CLI:
`session open` writes the secret to a private per-user file that later commands
use; `session close` removes it. Sessions and their claims are stored with an
expiry and survive a controller restart until it; a credential rotation or a
generation change invalidates them. Implementation belongs to the slice that
builds the first consumer ([section 9.3](#93-deferred-implementation)).

### 3.2 Project and registration

| Id | Kind | Resources | Requirement | Needs | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `project.list` | read | none | `collection(project:read)` | - | - | - | no | H M C | Per item: id, name, port, phase, worktree path, claim `none`, `own` or `other`. Holder identity of `other` only with `claims:manage` on that project. Filtered before pagination. No environment values, logs or test runs. |
| `project.status` | read | `project` | `project:read on project` | - | - | - | no | H M C | Safe status DTO; field allowlist ([section 4.9](#49-sensitive-output-allowlists)). `compact` input replaces the compact variant. Raw executable and arguments only with `config:read`; other holders' identities only with `claims:manage`. No literal environment values (they are the `*_values_read` operations), no logs, storage or test runs: separate operations. Carries safe Knowledge metadata only: revision, status, `writable` (OPEN-13); never Knowledge content. |
| `project.worktrees` | query | `project` | `project:read on project` | `query` | - | - | no | H M C | Allowlist: path, branch, head, short head, detached, locked, prunable, dirty. Discovery runs outside admission; the release rechecks after it. Every call discovers, so no separate refresh operation exists; discovery is bounded and coalesced and never triggered repeatedly by log events. |
| `project.wait` | stream | `project` | `project:read on project` | `bounded_stream` | - | - | no | H M C | At most one event; cursor envelope; rechecks after the wait and authorizes before release. Bounded waiters; default timeout 10 s, maximum 20 s. |
| `project.create` | mutation | none | `installation projects:create` | - | - | declared: port and path availability are refused before the store write | yes | H M C | Covers adding a registration with its project and creating a project without one. Port selection when none is given belongs here (task `7c1e30a6`). |
| `project.archive` | mutation | `project` | `project:manage on project` | - | - | declared: the revision conflict is refused before the write | yes | H M C | Today `knowledge:write`; operators lose it (decision v1, `575a4fe8` point 5). Archiving is its own operation: detaching a registration does not archive. |
| `project.restore` | mutation | `project` | `project:manage on project` | - | - | declared: as `project.archive` | yes | H M C | As above. |
| `registration.attach` | mutation | `project` | `project:manage on project` | - | - | declared: path and port checks before the write | yes | H M C | Adds a machine registration to an existing project. |
| `registration.detach` | mutation | `registration` | `project:manage on registration` | `expected_transition` | - | declared: precondition refusals before the removal | yes | H M C | OPEN-3: the only removal. Removing a registered project is detaching its registration; Knowledge is preserved, neither archived nor deleted. There is no hard delete of a project in this release. |
| `registration.move` | mutation | `registration` as `source`, `project` as `destination` | `allOf(project:manage on source, project:manage on destination)` | `expected_transition` | - | declared: both mappings are checked before the move | yes | H M C | Contract v1: needs `project:manage` on both. Rechecks resolve both mappings and their versions, including historical authority; the source mapping change is a declared transition. Moving a registration moves access to historical Vault data; requiring `secrets` on both projects was not adopted (`ce8aa214`). |

### 3.3 Claims

A claim protects a server from displacement; it is not a permission to act
([section 4.1](#41-lifecycle-invariants-and-the-claim-rule)). The holder is a
coordination session (OPEN-2).

| Id | Kind | Resources | Requirement | Needs | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claim.acquire` | mutation | `project` | `claims:manage on project` | `coordination` | - | declared: a conflicting holder or an unavailable worktree is refused before the reservation | yes | H M C | Only reserves: it never starts a server. A session never adopts another session's claim. Result: claim summary, TTL at most 1800 s. |
| `claim.renew` | mutation | `claim` | `allOf(claims:manage on claim, claim_holder on claim)` | `coordination` | - | declared: a stale or expired claim is refused before the extension | yes | H M C | Keys are optional, as on the account surface today. Automatic renewal from a session is a background-authorization obligation, not an operation. |
| `claim.release` | mutation | `claim` | `allOf(claims:manage on claim, claim_holder on claim)` | `coordination`, `expected_transition` | - | entry: ownership is decided before the effect | yes | H M C | Does not stop the server. The removal of the holder relation is a declared transition, so the receipt is deliverable. |
| `claim.force_release` | mutation | `claim` | `runtime:administer on claim` | `expected_transition` | `agents: false` | entry: the removal has no typed refusal | yes | H C; M excluded (owner decision `fb1567d5`) | Only a human breaks a claim: on `H` (the dashboard) and `C`; never on `M`, in any mode, because in open and token mode the dashboard and MCP share the installation actor and the rule is enforced by listener (owner decision `fb1567d5`). An agent blocked by a claim waits for its expiry. Separate and audited. The only way to remove another session's claim. It does not stop the server and does not kill an unverified foreign process. |

### 3.4 Runtime

In this family the slot `claim` is the project's claim, which may be absent.
Claim, registration, worktree and project must resolve to one another, or the
answer is `not_found`. Owner decision `42019833` (OPEN-1): the four ordinary
operations need `runtime:control` on the project and the predicate
`claim_holder_if_claimed`; no claim is required; when a claim exists only its
holder may act; anyone else needs `claim.force_release` first (or
`runtime.force_stop`). The rule is the same for humans, agents and full-authority
actors on every surface. Breaking someone else's claim is the exception: only a
human does it, through the dashboard or the CLI, never through MCP; an agent waits
for the claim to expire (owner decision `fb1567d5`). The preserved invariants per operation are in
[section 4.1](#41-lifecycle-invariants-and-the-claim-rule).

| Id | Kind | Resources | Requirement | Needs | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `runtime.start` | mutation | `project`, `claim` | `allOf(runtime:control on project, claim_holder_if_claimed on claim)` | `claim_holder_if_claimed` | - | declared: an occupied port, missing capacity, an unavailable worktree or a foreign claim are refused before the spawn | yes | H M C | Explicit. An occupied port never proves ownership. Absence of a claim is rechecked under the shared lifecycle coordination immediately before the spawn. Receipt allowlist as the scoped receipt today. |
| `runtime.restart` | mutation | `project`, `claim` | `allOf(runtime:control on project, claim_holder_if_claimed on claim)` | `claim_holder_if_claimed` | - | declared: refusals before the stop; the stop is past the point | yes | H M C | Keeps an existing claim and the capacity slot. The claim's absence is rechecked before the stop and again immediately before the start that follows it. |
| `runtime.stop` | mutation | `project`, `claim` | `allOf(runtime:control on project, claim_holder_if_claimed on claim)` | `claim_holder_if_claimed` | - | entry: a failed process-tree stop leaves cleanup unconfirmed | yes | H M C | An existing claim stays held. Stops only verified owned process trees. |
| `runtime.switch` | mutation | `project`, `claim` | `allOf(runtime:control on project, claim_holder_if_claimed on claim)` | `claim_holder_if_claimed`, `expected_transition` | - | declared: as `runtime.restart`; the destination must be a discovered worktree of the project | yes | H M C | Today HTTP only. When a claim exists, only its holder switches, and the claim moves to the destination worktree atomically in the same effect; with no claim, the switch creates none (`46672ea8`). |
| `runtime.force_stop` | mutation | `project` | `runtime:administer on project` | - | `agents: false` | entry: as `runtime.stop` | yes | H C; M excluded (owner decision `fb1567d5`) | Only a human breaks a claim: on `H` (the dashboard) and `C`; never on `M`, in any mode, because in open and token mode the dashboard and MCP share the installation actor and the rule is enforced by listener (owner decision `fb1567d5`). An agent blocked by a claim waits for its expiry. Stops a run started under another session's claim. Foreign processes stay protected; it does not authorize killing an unverified process and does not silently release a claim. |
| `runtime.metrics` | read | none | `collection(project:read)` | - | - | - | no | H M C | Per project resource samples. |

### 3.5 Configuration

Profile structure and literal values are separate operations, for reads and
writes, for development and test profiles ([section 4.2](#42-profile-structure-and-literal-values)).
Every mutation here except `godot_web.rebuild` carries `claim_holder_if_claimed`
on the slot `claim` (the project's claim, possibly absent): `allOf(<permission> on project,
claim_holder_if_claimed on claim)`. Existing reservation and worktree checks
stay as lifecycle invariants ([section 4.1](#41-lifecycle-invariants-and-the-claim-rule)).

| Id | Kind | Resources | Requirement | Needs | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `config.read` | read | `project` | `config:read on project` | - | - | - | no | H M C | Structure only: launch preset, executable and arguments, TLS mode and paths, preset timeouts, environment variable names, profile names, safe Vault metadata (entry names and revisions). No literal values. Explicit public DTO. |
| `config.environment_values_read` | read | `project` | `secrets:read on project` | - | - | - | no | H M C | Literal values of the development environment. A secrets-only account can read them without `config:read`. An `admin` without `secrets` cannot. |
| `config.tls_set` | mutation | `project`, `claim` | `allOf(config:write on project, claim_holder_if_claimed on claim)` | `claim_holder_if_claimed` | - | declared: path validation before the write | yes | H M C | Has no actor callback today (`575a4fe8`, point 1). A maintainer without `projects:create` types the path ([`directory.browse`](#37-storage-capacity-logs-and-system-reads)). |
| `config.environment_structure_set` | mutation | `project`, `claim` | `allOf(config:write on project, claim_holder_if_claimed on claim)` | `claim_holder_if_claimed` | - | declared: reserved names and the stopped-server precondition are refused before the write | yes | H M C | Names and reserved-name policy of the development environment. Preserves existing values; a new name has no value until `config.environment_values_set` sets one. |
| `config.environment_values_set` | mutation | `project`, `claim` | `allOf(secrets:write on project, claim_holder_if_claimed on claim)` | `claim_holder_if_claimed`, `secret_safe_retention` | - | declared: unknown names and the stopped-server precondition are refused before the write | yes, secret-safe | H M C | Sets values of names that exist. Cannot add, remove or rename a name or change policy. |
| `profile.list` | read | `project` | `config:read on project` | - | - | - | no | H M C | Selected profile, names, revision, structure and policy. No literal values. |
| `profile.values_read` | read | `project` | `secrets:read on project` | - | - | - | no | H M C | Literal values of one named development profile. |
| `profile.structure_save` | mutation | `project`, `claim` | `allOf(config:write on project, claim_holder_if_claimed on claim)` | `claim_holder_if_claimed` | - | declared: validation and the selected-profile precondition before the write | yes | H M C | Creates or changes a profile's names and policy; preserves existing values. The HTTP-only `restart` option disappears. |
| `profile.values_set` | mutation | `project`, `claim` | `allOf(secrets:write on project, claim_holder_if_claimed on claim)` | `claim_holder_if_claimed`, `secret_safe_retention` | - | declared: unknown profile or name refused before the write | yes, secret-safe | H M C | Values only. Cannot change a name, the profile's existence, policy or assignments. |
| `profile.delete` | mutation | `project`, `claim` | `allOf(config:write on project, claim_holder_if_claimed on claim)` | `claim_holder_if_claimed` | - | declared: default and selected profiles are refused before the delete | yes | H M C | |
| `profile.select` | mutation | `project`, `claim` | `allOf(profiles:select on project, claim_holder_if_claimed on claim)` | `claim_holder_if_claimed` | - | declared: revision conflict and an active runtime are refused before the commit | yes | H M C | Revision compare-and-set and idempotency on every surface. Never restarts. |
| `preset.timeout_set` | mutation | `project`, `claim` | `allOf(config:write on project, claim_holder_if_claimed on claim)` | `claim_holder_if_claimed` | - | declared: revision conflict, override limit and an undiscovered preset are refused before the write | yes | H M C | Compare-and-set, discovered preset only. A null timeout removes the override. |
| `test_profile.list` | read | `project` | `config:read on project` | - | - | - | no | H M C | Names, mode and structure; no literal values. |
| `test_profile.values_read` | read | `project` | `secrets:read on project` | - | - | - | no | H M C | Literal values of one named test profile. No matrix row: a new capability that closes the secrets-only gap (F5). |
| `test_profile.structure_save` | mutation | `project`, `claim` | `allOf(config:write on project, claim_holder_if_claimed on claim)` | `claim_holder_if_claimed` | - | declared: validation before the write | yes | H M C | Names, mode, server profile, `NODE_ENV` and required variables; preserves values. One response shape on every surface. |
| `test_profile.values_set` | mutation | `project`, `claim` | `allOf(secrets:write on project, claim_holder_if_claimed on claim)` | `claim_holder_if_claimed`, `secret_safe_retention` | - | declared: unknown profile or name refused before the write | yes, secret-safe | H M C | Values only; cannot change names, existence, mode or assignments. |
| `test_profile.delete` | mutation | `project`, `claim` | `allOf(config:write on project, claim_holder_if_claimed on claim)` | `claim_holder_if_claimed` | - | declared: built-in and assigned profiles are refused before the delete | yes | H M C | |
| `test_preset.assign_profile` | mutation | `project`, `claim` | `allOf(config:write on project, claim_holder_if_claimed on claim)` | `claim_holder_if_claimed` | - | declared: unknown profile refused before the write | yes | H M C | |
| `godot_web.configure` | mutation | `project`, `claim` | `allOf(config:write on project, claim_holder_if_claimed on claim)` | `claim_holder_if_claimed` | - | declared: the stopped-server precondition and discovery before the write | yes | H M C | Rechecks after discovery; awaits discovery then writes without a recheck today (`575a4fe8`, point 1). The predicate is applied by the rule that covers every configuration write ([section 4.1](#41-lifecycle-invariants-and-the-claim-rule)). |
| `godot_web.status` | read | `project` | `project:read on project` | - | - | - | no | H M C | Field allowlist ([section 4.9](#49-sensitive-output-allowlists)). |
| `godot_web.rebuild` | mutation | `project` | `runtime:control on project` | - | - | declared: an in-flight export is coalesced, not refused | yes | H M C | OPEN-15. Background work keeps an immutable authorization specification carrying the requester's authority; lifecycle and queue guards stay. |

### 3.6 Test runs

| Id | Kind | Resources | Requirement | Needs | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `test_preset.list` | query | `project` | `tests:read on project` | `query` | - | - | no | H M C | OPEN-14: lists all presets with an `enqueueable` flag. The flag is an advisory result of current eligibility (including `tests:run` and environment restrictions), never a permission and never guaranteed admission. No raw commands or values. Bounded: 64 trees, 256 presets, 64 KiB. |
| `test_run.enqueue` | mutation | `project` | `tests:run on project` | `coordination` | - | declared: a non-clean environment and a full queue are refused before the enqueue | yes | H M C | No claim is required and none is acquired. Existing reservation and worktree rules stay ([section 4.1](#41-lifecycle-invariants-and-the-claim-rule)). Records the originating session, principal and credential. Dispatch rechecks the requester. |
| `test_run.read` | read | `test_run` | `tests:read on test_run` | - | - | - | no | H M C | Project-wide safe status DTO for every caller. It never grows fields because the caller holds `config:read` or `logs:read`. No output tail, no raw command. |
| `test_run.logs` | read | `test_run` | `allOf(tests:read on test_run, logs:read on test_run)` | - | - | - | no | H M C | Redacted, bounded lines. Application output cannot be certified secret-free. |
| `test_run.cancel` | mutation | `test_run` | `allOf(tests:run on test_run, run_originating_session on test_run)` | `coordination` | - | declared: a terminal run is refused before the intent is recorded | yes | H M C | Cancellation intent only; the run stays running until cleanup is confirmed. |
| `test_run.wait` | stream | `test_run` | `tests:read on test_run` | `bounded_stream` | - | - | no | H M C | At most one event; rechecks after the wait and authorizes before release. |
| `test_run.history_list` | read | `project` | `tests:read on project` | - | - | - | no | H M C | Compact summaries, live keyset cursor, at most 50 results and 1000 scanned. Field allowlist ([section 4.9](#49-sensitive-output-allowlists)). |
| `test_run.summary` | read | `test_run` | `tests:read on test_run` | - | - | - | no | H M C | Retained compact summary. Field allowlist. |
| `test_run.metrics` | read | `project` | `tests:read on project` | - | - | - | no | H M C | At most 5000 candidates, 31-day window. Field allowlist. |
| `test_run.compare` | read | `test_run` as `left`, `test_run` as `right` | `allOf(tests:read on left, tests:read on right)` | - | - | - | no | H M C | Field allowlist. |
| `test_run.lookup_intent` | query | `project` | `allOf(tests:run on project, intent_origin on project)` | `query`, `intent_origin` | - | - | no | H M C | OPEN-21 (task `6d680061`). Original principal, credential, project, worktree, preset, key and the saved origin digest with its version. A new session under the same credential may look up and may not cancel; a rotated credential does not adopt old intent. Bounded `unavailable` and `ambiguous` are not quiescence; `releaseSafe` proves one run's cleanup and nothing more. No matrix row; required by `575a4fe8` answer d. |
| `test_run.admin_inspect` | read | `test_run` | `tests:read on test_run` | - | - | - | no | H M C | OPEN-22. A distinct projector, not a second status endpoint: bounded ownership, persistence and resolution evidence. Gated fields: holder identity under `claims:manage`; command, arguments and cwd under `config:read`; error and log text under `logs:read`; audit under `runtime:administer` ([section 4.7](#47-administrative-stop-and-inspect)). |
| `test_run.admin_stop` | mutation | `test_run` | `runtime:administer on test_run` | - | - | declared: an unknown run is refused before any effect; every other outcome (queued cancellation, join, owned cleanup retry, none) is a typed result ([section 4.7](#47-administrative-stop-and-inspect)) | yes | H M C | Keeps queued cancellation, join of finalization, owned cleanup retry and safe none. Reason 3 to 200 characters, optional wait up to 120 s, request id as the idempotency key. Audited as the actor. Never signals an unowned or saved PID. |

### 3.7 Storage, capacity, logs and system reads

| Id | Kind | Resources | Requirement | Needs | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `storage.read` | read | `project` | `storage:read on project` | - | - | - | no | H M C | One worktree path, last 16 history points. |
| `storage.refresh` | mutation | `project` | `storage:manage on project` | - | - | declared: path validation before the scan is queued | yes | H M C | OPEN-15: explicit scans only. Queues a scan; the queued work carries the requester's immutable authority. Lifecycle and queue guards stay. |
| `storage.cache_delete` | mutation | `project` | `storage:manage on project` | - | - | declared: path and cache kind are validated before the removal | yes | H M C | Deletes files. Rechecks after the filesystem awaits and before the removal. |
| `capacity.read` | read | none | `any_project(project:read)` | `any_project` | - | - | no | H M C | OPEN-4. Aggregate counts for a caller holding `project:read` on at least one project; slot holders filtered per project by `claims:manage`. A collection requirement alone is not the gate: the rule is implemented at release. |
| `capacity.detail_read` | read | none | `installation capacity:read` | - | - | - | no | H M C | Installation-wide detail. Works for an `admin` on an installation with no projects. No matrix row: a split of row 6.4. |
| `capacity.set` | mutation | none | `installation capacity:write` | - | - | entry: an absolute-value write, no typed refusal known | no | H M C | OPEN-16: capacity limits. Idempotent by nature. |
| `test_queue.read` | read | none | `any_project(project:read)` | `any_project` | - | - | no | H M C | Limit, running, queued, available; no identities. |
| `test_queue.set` | mutation | none | `installation settings:write` | - | - | entry: as `capacity.set` | no | H M C | OPEN-16: the test-queue settings (maximum parallel runs). `settings:write` guards actual controller settings; no generic settings operation is invented to consume it. |
| `runtime_logs.read` | read | `project` | `logs:read on project` | - | - | - | no | H M C | Always bounded and credential-redacted. Application output may still hold secrets. |
| `diagnostics.mcp` | read | none | `installation diagnostics:read` | - | - | - | no | H M C | MCP session and diagnostic snapshot. Field allowlist ([section 4.9](#49-sensitive-output-allowlists)). |
| `events.subscribe` | stream | none | `any_project(project:read)` for controller-wide events; per project events by `project:read on project` | `any_project` | - | - | no | H (SSE framing); M and C excluded (MCP keeps `project.wait`) | OPEN-9. A registry stream with SSE as its adapter: every event is authorized and projected per subscriber. Replaces the one-event-for-all broadcast. |
| `directory.browse` | query | none | `installation projects:create` | `query` | - | - | no | H M C | OPEN-8. Listing confined to the configured browse root by real path. A maintainer without `projects:create` types the TLS path by hand. |

### 3.8 Knowledge

All Knowledge operations take a `project` slot (and a `knowledge_record` slot
where a record id is given); an id from another project is `not_found`. Writes
require `knowledge:read` as well because their responses contain retained
content. The project's archived state limits writes as today and is not an
authorization rule. All writes retain and take an optional key.

| Id | Kind | Resources | Requirement | Needs | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `knowledge.memories` | read | `project` | `knowledge:read on project` | - | - | - | no | H M C | |
| `knowledge.memory` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | - | no | H M C | |
| `knowledge.create_memory` | mutation | `project` | `allOf(knowledge:write on project, knowledge:read on project)` | - | - | declared: validation and conflicts before the write | yes | H M C | |
| `knowledge.update_memory` | mutation | `project`, `knowledge_record` | `allOf(knowledge:write on project, knowledge:read on project)` | - | - | declared: revision conflict before the write | yes | H M C | |
| `knowledge.approve_memory` | mutation | `project`, `knowledge_record` | `allOf(knowledge:approve on project, knowledge:read on project)` | - | `agents: false`, `freshLogin` | declared: revision conflict before the write | yes | H M† C | Human-only sensitive action. Installation and operator are exempt. |
| `knowledge.archive_memory` | mutation | `project`, `knowledge_record` | `allOf(knowledge:write on project, knowledge:read on project)` | - | - | declared: as above | yes | H M C | |
| `knowledge.restore_memory` | mutation | `project`, `knowledge_record` | `allOf(knowledge:write on project, knowledge:read on project)` | - | - | declared: as above | yes | H M C | |
| `knowledge.supersede_memory` | mutation | `project`, `knowledge_record` | `allOf(knowledge:write on project, knowledge:read on project)` | - | - | declared: as above | yes | H M C | |
| `knowledge.search` | read | `project` | `knowledge:read on project` | - | - | - | no | H M C | |
| `knowledge.task_context` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | - | no | H M C | Bounded depth 8, 50 predecessors, 32 KiB history. |
| `knowledge.check_context_export` | read | `project` | `knowledge:read on project` | - | - | - | no | H M C | |
| `knowledge.export_context` | read | `project` | `allOf(knowledge:export on project, knowledge:read on project)` | - | - | - | no | H M C | Response capped at 256 KiB. |
| `knowledge.threads` | read | `project` | `knowledge:read on project` | - | - | - | no | H M C | |
| `knowledge.reply` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | - | no | H M C | |
| `knowledge.thread` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | - | no | H M C | |
| `knowledge.replies` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | - | no | H M C | |
| `knowledge.tasks` | read | `project` | `knowledge:read on project` | - | - | - | no | H M C | |
| `knowledge.task` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | - | no | H M C | |
| `knowledge.relations` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | - | no | H M C | |
| `knowledge.history` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | - | no | H M C | |
| `knowledge.create_thread` | mutation | `project` | `allOf(knowledge:write on project, knowledge:read on project)` | - | - | declared: validation before the write | yes | H M C | |
| `knowledge.create_reply` | mutation | `project`, `knowledge_record` | `allOf(knowledge:write on project, knowledge:read on project)` | - | - | declared: as above | yes | H M C | |
| `knowledge.create_task` | mutation | `project` | `allOf(knowledge:write on project, knowledge:read on project)` | - | - | declared: as above | yes | H M C | |
| `knowledge.task_from_thread` | mutation | `project`, `knowledge_record` | `allOf(knowledge:write on project, knowledge:read on project)` | - | - | declared: as above | yes | H M C | |
| `knowledge.update_task` | mutation | `project`, `knowledge_record` | `allOf(knowledge:write on project, knowledge:read on project)` | - | - | declared: revision conflict before the write | yes | H M C | |
| `knowledge.task_state` | read | `project`, `knowledge_record` | `knowledge:read on project` | - | - | - | no | H M C | |
| `knowledge.update_task_state` | mutation | `project`, `knowledge_record` | `allOf(knowledge:write on project, knowledge:read on project)` | - | - | declared: revision conflict before the write | yes | H M C | Consent is never written. |
| `knowledge.attachments` | read | `project` | `attachments:read on project` | - | - | - | no | H M C | Readable on an archived project. |
| `knowledge.attachment_policy` | read | `project` | `attachments:read on project` | - | - | - | no | H M C | |
| `knowledge.check_attachment_batch` | read | `project` | `allOf(attachments:write on project, attachments:read on project)` | - | - | - | no | H M C | Manifest at most 10000 files, request at most 4 MiB. |
| `knowledge.attachment` | read | `project`, `knowledge_record` | `attachments:read on project` | - | - | - | no | H M C | Returns base64 content. |
| `knowledge.create_attachment` | mutation | `project`, `knowledge_record` | `attachments:write on project` | - | - | declared: size and capacity limits are refused before the commit | yes | H M C | `payload_too_large` above 14.1 MB. Authorization is rechecked inside the commit callback today and stays so. |
| `knowledge.project_export` | mutation | `project` | `allOf(knowledge:export on project, attachments:read on project)` | - | - | declared: limits and destination checks before the write | yes | C (unix or offline); H and M excluded in this release (owner decision `17802524`) | Writes a directory on the controller host: Knowledge and attachments only, no Vault data, grants or credentials. Raw host paths stay local (OPEN-10). No account-facing form in this release (owner decision `17802524`). |
| `knowledge.project_import` | mutation | `project` as `destination` | `knowledge:import on destination` | - | - | declared: manifest and integrity checks before the first write | yes | C (unix or offline); H and M excluded in this release (owner decision `17802524`) | OPEN-13: import into an existing project. Fixed schema ([section 4.5](#45-project-transfer-and-import)). Today owner-session only; the first enforcement of `knowledge:import`. |
| `project.create_from_import` | mutation | none | `installation projects:create` | - | - | declared: manifest and integrity checks before the first write | yes | C (unix or offline); H and M excluded in this release (owner decision `17802524`) | OPEN-13: import that creates a new project. Fixed schema, same restrictions. No matrix row of its own; row 7.39 splits by destination. |

### 3.9 Vault

| Id | Kind | Resources | Requirement | Needs | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `vault.import` | mutation | `project` | `secrets:write on project` | `secret_safe_retention` | - | declared: limits (16 profiles, 100 variables, 48 KiB) before the write | yes, secret-safe | H M C | Creates a profile from dotenv text. The dotenv text is never retained. |
| `vault.update` | mutation | `vault_entry` | `secrets:write on vault_entry` | `secret_safe_retention` | - | declared: revision conflict before the write | yes, secret-safe | H M C | Replaces the grant-gated `write`. There is no `vault.write`. |
| `vault.list` | read | `project` | `secrets:read on project` | - | - | - | no | H M C | Entry id, revision, timestamps; no values. A secrets-only account can discover entries; configuration readers see names through `config.read`. |
| `vault.read` | read | `vault_entry` | `secrets:read on vault_entry` | - | - | - | no | H M C | The only Vault operation that releases plaintext, to any account holding `secrets`, including an agent over MCP. No per-use consent. An `admin` without `secrets` cannot read it. |
| `vault.audit` | read | `project` | `roles:manage on project` | - | - | - | no | H M C | OPEN-18: bounded audit with no values; a field allowlist keeps plaintext, ciphertext and key material out ([section 4.9](#49-sensitive-output-allowlists)). |
| `vault.recover_key` | mutation | none | `installation vault:recover` | - | `agents: false`, `freshLogin` | declared: provisional until the Vault code is read in slice 4 | yes | H M† C | From contract v1. No current operation exists (no matrix row). Preserves encryption: it cannot expose plaintext, resurrect grants, or release plaintext merely because `admin` holds `vault:recover`. Details deferred ([section 9.3](#93-deferred-implementation)). |

### 3.10 Backups and exports

| Id | Kind | Resources | Requirement | Needs | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `backup.overview` | read | none | `installation backups:manage` | - | - | - | no | H M C | Omits the destination directory. |
| `backup.create` | mutation | none | `installation backups:manage` | - | - | declared: policy and destination checks before the copy | yes | H M C | Remote surfaces take a configured destination id; only the local operator may name a path. Rechecks before the copy starts, which does not happen today. |
| `backup.preview` | query | none | `installation backups:manage` | `query` | - | - | no | H M C | OPEN-23: persists nothing. Verification and temporary scratch work run outside admission. |
| `backup.restore` | mutation | none | `installation backups:manage` | - | - | declared: the commit point is the first durable write of the restore request | yes | H M C | OPEN-23: durable restore admission. The specialized handoff makes the last authorization and fence check before draining; completion after shutdown runs under the recorded specification, not a live session ([section 4.6](#44-export-schedules-ownership)). |
| `backup.status` | read | none | `installation backups:manage` | - | - | - | no | H M C | |
| `backup.monitor` | read | none | `installation backups:manage` | - | - | - | no | H M C | Monitor metadata and thresholds. |
| `backup.remote_status` | read | none | `installation backups:manage` | - | - | - | no | H M C | |
| `backup.remote_reupload` | mutation | none | `installation backups:manage` | - | - | declared: unknown backup refused before the upload | yes | H M C | Destinations are configured destination ids. |
| `backup.remote_retry` | mutation | none | `installation backups:manage` | - | - | declared: generation check before the retry | yes | H M C | |
| `backup.remote_rebind` | mutation | none | `installation backups:manage` | - | - | declared: needs a completed restore, checked before the rebind | yes | C offline only; H and M excluded (OPEN-11) | Needs the exclusive controller lock: stopped-controller maintenance of the local operator. |
| `user_backup.overview` | read | none | `allOf(collection(knowledge:export), collection(attachments:read))`, items filtered by `schedule_owner` | `schedule_owner` | - | - | no | H M C | An account sees its own schedules; items need both permissions on their project; full authority sees all. Owner filtering happens before pagination and release ([section 4.4](#44-export-schedules-ownership)). |
| `user_backup.save` | mutation | `project`, `schedule` | `allOf(knowledge:export on project, attachments:read on project, schedule_owner on schedule)` | `schedule_owner`, `expected_transition` | - | declared: policy gate and limits before the write | yes | H M C | Durable owner plus immutable job specification. On a change of project both the old binding (resolved from `schedule`) and the new one (`project`) are authorized, at the effect and again on release and replay (declared expected transition of `schedule`). Absent `schedule` on create. A schedule created by the local operator in better-auth is owned by `operator` (`46672ea8`, owner `fb1567d5`). |
| `user_backup.status` | read | none | `allOf(collection(knowledge:export), collection(attachments:read))`, items filtered by `schedule_owner` | `schedule_owner` | - | - | no | H M C | As `user_backup.overview`. |
| `user_backup.artifact` | read | `schedule` | `allOf(knowledge:export on schedule, attachments:read on schedule, schedule_owner on schedule)` | `schedule_owner` | - | - | no | H M C | Releases artifact content: a data release, authorized at release; the server resolves the artifact to its schedule and project. |
| `user_export.recovery_list` | read | none | `installation backups:manage` | - | - | - | no | H M C | Today operator socket only. Field allowlist ([section 4.9](#49-sensitive-output-allowlists)). |
| `user_export.recovery_preview` | read | none | `installation backups:manage` | - | - | - | no | H M C | Field allowlist. |
| `user_export.recovery_cleanup` | mutation | none | `installation backups:manage` | - | - | declared: confirmation id checked before the removal | yes | H M C | |

### 3.11 Accounts and roles

All operations here act on better-auth accounts. Reads are human-only
(`agents: false`) and need no fresh login; mutations are human-only and carry
`freshLogin` (account and role administration, accepted target point 6;
OPEN-24).

| Id | Kind | Resources | Requirement | Needs | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `account.create` | mutation | none | `installation accounts:manage` | - | `agents: false`, `freshLogin` | declared: validation and kind checks before the write | yes | H M† C | Human or agent account. Creating an account does not issue a token. The first admin is created by the operator over the unix socket or offline ([section 4.8](#48-accounts-last-admin-and-lost-admin-recovery)). |
| `account.enroll` | mutation | none | `installation accounts:manage` | `secret_safe_retention` | `agents: false`, `freshLogin` | declared: validation before the credential write | yes, secret-safe | H M† C | Email, name and password of a human. Factor enrollment stays with the provider ceremonies (row 11.41 to 11.46). Secret input by stdin or private file on the CLI, never argv. |
| `account.list` | read | none | `installation accounts:manage` | - | `agents: false` | - | no | H M† C | Includes token metadata. Page size at most 20. |
| `account.get` | read | none | `installation accounts:manage` | - | `agents: false` | - | no | H M† C | One account with every role it holds. |
| `account.disable` | mutation | none | `installation accounts:manage` | - | `agents: false`, `freshLogin` | declared: unknown account and the last active admin are refused before the write | yes | H M† C | Disables, then reclaims sessions and the token and invalidates its background authority. The last active admin is protected ([section 4.8](#48-accounts-last-admin-and-lost-admin-recovery)). |
| `account.recover` | mutation | none | `installation accounts:manage` | `secret_safe_retention` | `agents: false`, `freshLogin` | declared: provider capability checked before the reset | yes, secret-safe | H M† C | New password; factors preserved or reset. It does not by itself re-enable a disabled account. |
| `account.token_issue` | mutation | none | `installation accounts:manage` | `token_delivery`, `secret_safe_retention` | `agents: false`, `freshLogin` | declared: account kind and state before the issue | yes, secret-safe | H M† C | The one revocable token of an agent account (OPEN-20): issuing replaces the active token atomically; no expiry by default, an optional expiry may be given. Delivered once ([section 4.3](#43-secret-safe-retention-and-token-delivery)). |
| `account.token_revoke` | mutation | none | `installation accounts:manage` | - | `agents: false`, `freshLogin` | declared: unknown token refused before the revoke | yes | H M† C | Old contexts and background authority end immediately. |
| `role.grant` | mutation | `project` | `roles:manage on project` | - | `agents: false`, `freshLogin` | declared: recipient kind, scope and revision are checked before the write | yes | H M† C | Project roles only. A maintainer may grant and revoke the five project roles on its own project, including `maintainer` and `secrets`. Granting `secrets` is the same operation and also needs the fresh login (OPEN-24). |
| `role.revoke` | mutation | `project` | `roles:manage on project` | - | `agents: false`, `freshLogin` | declared: revision conflict before the write | yes | H M† C | |
| `role.list` | read | `project` | `roles:manage on project` | - | `agents: false` | - | no | H M† C | Roles of every account on the project. |
| `admin_role.grant` | mutation | none | `installation accounts:manage` | - | `agents: false`, `freshLogin` | declared: recipient must be a human account | yes | H M† C | A project `roles:manage` never authorizes it (`575a4fe8`, point 5). |
| `admin_role.revoke` | mutation | none | `installation accounts:manage` | - | `agents: false`, `freshLogin` | declared: revision conflict and the last admin are refused before the write | yes | H M† C | The last `admin` cannot be revoked except by the operator. |

### 3.12 Remote verification and workers

| Id | Kind | Resources | Requirement | Needs | Flags | Commit | Retain | Surfaces | Projection and notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `remote_verification.submit` | mutation | `project` | `tests:run on project` | - | - | declared: unknown or unavailable worker and preset are refused before the record | yes | H M C | Records the submitter. The commit is immutable once recorded. |
| `remote_verification.get` | read | `request` (kind `remote_request`) | `tests:run on request` | `remote_request` | - | - | no | H M C | Request, attempt, cancellation flag, uncertainty flag, bounded latest report. Field allowlist ([section 4.9](#49-sensitive-output-allowlists)). |
| `remote_verification.get_logs` | read | `request` (kind `remote_request`) | `tests:run on request` | `remote_request` | - | - | no | H M C | Last uploaded output only. Field allowlist. |
| `remote_verification.cancel` | mutation | `request` (kind `remote_request`) | `allOf(tests:run on request, request_submitter on request)` | `remote_request`, `request_submitter` | - | declared: unknown request refused before the intent | yes | H M C | Persists intent even when the worker is offline. |
| `worker.poll` | mutation | none | per candidate request: `worker:execute` on the request's project for the executor, and `tests:run` on the same project for the stored submitter, evaluated separately | `remote_request`, `request_submitter`, `coordination` | - | declared: the assignment is recorded only after both evaluations succeed | no | H on the worker listener only; M, C and the ordinary API listener excluded | Not `collection(worker:execute)`. In better-auth the executor is an authenticated agent account; in open and token mode it is the installation actor on the worker listener; in every mode it is bound to an active registration; project and preset compatibility are checked; the assignment is recorded; each item is released separately ([section 4.6](#46-remote-verification-and-workers)). Machine-to-machine protocol with its own versioning, framing and sequence numbers. |
| `worker.report` | mutation | `worker_attempt` | `allOf(worker:execute on worker_attempt, worker_assignment on worker_attempt)` | `coordination` | - | declared: sequence check before the report is accepted | no | H on the worker listener only; M and C excluded | Preserves exact assignment, sequence, immutable commit and cleanup checks. Finalization and cleanup of an assignment already begun complete after a revocation. |
| `worker.register` | mutation | `project` | `installation workers:manage` | - | `agents: false`, `freshLogin` | declared: project and preset checks before the write | yes | H M† C (owner decision `17802524`) | Registers a worker for a project and presets. No token is issued and no caller grants are written. |
| `worker.recovery_inspect` | read | `worker_attempt` | `installation workers:manage` | - | - | - | no | C offline only; H and M excluded (OPEN-11) | Stopped-controller process recovery on the host. |
| `worker.recovery_reconcile` | mutation | `worker_attempt` | `installation workers:manage` | - | - | declared: recovery assessment before the audit write | yes | C offline only; H and M excluded (OPEN-11) | As `worker.recovery_inspect`. |

## 4. Specification shared by several operations

### 4.1 Lifecycle invariants and the claim rule

**The owner's principle (`42019833`).** A claim is protection, not permission.
It tells others not to touch a server because someone is working with it. A
server without a claim may be stopped by anyone, including on behalf of a
completely different project. Whoever cares about a server must claim it;
without a claim it can be displaced without being asked. This holds for humans,
agents and full-authority actors, on every surface. It is intended behaviour,
not a defect, and belongs in the behaviour notes and in the agent skill text:
claim before relying on a server.

**The rule.** `claim_holder_if_claimed` on the project's claim slot:

| State of the project's claim | Who may act (given `runtime:control` or the operation's own permission) |
| --- | --- |
| No claim | anyone holding the permission |
| A claim held by the caller's coordination session | the caller |
| A claim held by another session | nobody, until it is released, expires, or is force-released by a human (`claim.force_release`, `runtime:administer`, dashboard or CLI only, `fb1567d5`) |

Full authority does not pass the predicate: protection of foreign claims is the
point. "No claim required" never means "a foreign reservation can be ignored".
The absence of a claim is not decided once at the start of a request. It is
rechecked under the shared lifecycle coordination (the one that serializes
runtime changes, test admission and cache maintenance) immediately before each
new effect: the spawn of a start, the stop of a restart or switch, the start
that follows that stop, the commit of a configuration write, and an eviction
for capacity. Claim, registration, worktree and project must resolve to one
another; a claim id supplied for another project does not select it and the
answer is `not_found`. Mandatory possession of a claim is not required anywhere
in this family; respecting a claim that exists is.

**Applies to.** `runtime.start`, `runtime.restart`, `runtime.stop`,
`runtime.switch`, and every configuration mutation in section 3.5
(`config.tls_set`, `config.environment_structure_set`,
`config.environment_values_set`, `profile.structure_save`, `profile.values_set`,
`profile.delete`, `profile.select`, `preset.timeout_set`,
`test_profile.structure_save`, `test_profile.values_set`,
`test_profile.delete`, `test_preset.assign_profile`, `godot_web.configure`).
The reply names profile selection, environment and profile changes and the
preset timeout and asks for the predicate on "every mutation that disturbs or
replaces a running server"; the page applies it to the whole configuration
family so that no configuration write is left outside the rule (`ce8aa214` F9
lists the omitted rows). The remaining operations of F9 keep the lifecycle
invariants below without the predicate.

**Preserved invariants per operation.**

| Operation | Invariants preserved (source: `ce8aa214` F9, `29cf8fa5` delta 3) |
| --- | --- |
| `runtime.start` | The worktree is a discovered worktree of the project and the claim, if any, pins it. Capacity: a free slot or a refusal. An occupied port never proves ownership. Another project's capacity pressure can evict an unclaimed server; the eviction rechecks the absence of a claim. |
| `runtime.restart` | Keeps the capacity slot and an existing claim. The stop is past the point of no typed refusal; the claim's absence is rechecked again before the start. A refusal after the stop reports the real effect state (`committed`), never a silent success. |
| `runtime.stop` | Stops only verified owned process trees. An existing claim stays held. A failed stop leaves cleanup unconfirmed (`cleanup_unconfirmed`). |
| `runtime.switch` | The destination is a discovered worktree of the same project. The holder's claim moves to the destination atomically with the switch (declared expected transition of `claim`); with no claim none is created. Claim absence is rechecked before each effect as for `runtime.restart`. |
| `runtime.force_stop` | Stops a run started under another session's claim. Never signals an unverified foreign process; never releases the claim. |
| `claim.acquire` | Refuses a conflicting holder and an unavailable worktree. Never starts a server. |
| `claim.release`, `claim.force_release` | Do not stop the server. Force release is audited, human-only and never on MCP (`fb1567d5`); an agent waits for the claim's expiry. |
| Configuration mutations of section 3.5 | The existing reservation check (a foreign claim refuses the write), the worktree check, the stopped-server precondition where the source states it (environment, selected-profile edit, Godot configuration), the revision compare-and-set, and the recheck immediately before the commit. |
| `test_run.enqueue` | No claim is required and none is acquired. Existing reservation and worktree rules stay: an enqueue against a worktree reserved by another session is handled exactly as today (`reservationId` and the reservation check). Dispatch rechecks the requester and the queue. |
| `storage.refresh`, `storage.cache_delete`, `godot_web.rebuild` | Path validation to discovered worktrees; queue and lifecycle guards; recheck before the removal or the dispatch; background work keeps the requester's immutable authority. |

### 4.2 Profile structure and literal values

Decision of `29cf8fa5` (delta 8), completing OPEN-7 as `ce8aa214` required.
Development and test profiles each have separate operations for reading and
writing structure and literal values. No static conjunction and no conditional
requirement is needed.

| Concern | Operation | Requirement |
| --- | --- | --- |
| Read structure | `config.read`, `profile.list`, `test_profile.list` | `config:read` |
| Read literal values | `config.environment_values_read`, `profile.values_read`, `test_profile.values_read` | `secrets:read` |
| Write structure | `config.environment_structure_set`, `profile.structure_save`, `test_profile.structure_save`, `profile.delete`, `test_profile.delete`, `test_preset.assign_profile`, `preset.timeout_set` | `config:write` |
| Write values | `config.environment_values_set`, `profile.values_set`, `test_profile.values_set` | `secrets:write` |

Rules.

- Structure operations preserve literal values. A name added by a structure
  operation has no value until a values operation sets one.
- Values operations cannot change names, the existence of a profile, policy or
  assignments. An unknown name is refused before the write.
- A secrets-only account (it holds `secrets` and not `reader`) can read and
  write values and discover Vault entries with `vault.list`; it does not gain
  `config:read` implicitly. An account may hold several roles, so an agent that
  needs names as well holds `reader` or `operator` too.
- An `admin` holds no `secrets`: it reads no literal values through any of
  these operations, through `vault.list`, `vault.audit` or `vault.recover_key`.
- `project.status`, `config.read`, `profile.list` and `test_profile.list` never
  carry literal values.

### 4.3 Secret-safe retention and token delivery

Decision of `29cf8fa5` (delta 7) for `ce8aa214` F10. The runner's fingerprint
today is canonical input text and a completed receipt retains the internal
result, so ordinary retention would copy secrets into a second store. This is a
hazard for the integration, not a demonstrated leak from the unmounted module.

- Fingerprints are keyed digests, not canonical input text.
- An operation flagged secret-bearing retains a receipt of ids and revisions
  only: never its input and never a secret output.
- Replay of a secret-bearing operation is reauthorized as before and returns
  that receipt.

| Operation | Secret it carries | Receipt holds |
| --- | --- | --- |
| `config.environment_values_set`, `profile.values_set`, `test_profile.values_set` | literal values | project, profile, names changed, revision |
| `vault.import`, `vault.update` | dotenv or values | entry ids, revisions |
| `account.enroll`, `account.recover` | password | account id, revision |
| `coordination.open` | the session secret | session id, expiry |
| `account.token_issue` | the token | account id, token id, expiry |

Token issuance (OPEN-20, delta 7). `account.token_issue` replaces the account's
active token atomically and delivers the new token once. A replay returns the
receipt without the token. A lost response is repaired by issuing again, which
replaces the token. A replay after a later rotation returns the receipt only and
never reactivates or presents a superseded token as current. Replacing or
revoking a token ends the old token's contexts and background authority
immediately. No expiry by default; an expiry may be given. Whether the CLI
prints the token or writes a private file is an adapter detail.

### 4.4 Export schedules: ownership

For `user_backup.*` (`ce8aa214` F3, `29cf8fa5` delta 5 and OPEN-12).

- A schedule has a durable owner and an immutable job specification, never a
  stored session. Account actors own their schedules; in open and token mode
  the owner is recorded as `installation`. A schedule created by the local
  operator in better-auth mode is owned by `operator`: only full-authority
  actors can read, change or fetch it, and no account sees it, in listings,
  errors or artifact releases (`46672ea8`, accepted by the owner in
  `fb1567d5`).
- Changing a schedule's project is a declared expected transition of the
  `schedule` slot ([section 2.2](#22-expected-transition-receipts-planned-extension-2)):
  original and resulting project and owner are retained, and both bindings are
  authorized on release and replay.
- Each schedule, execution and artifact is a server-resolved resource (the
  slot `schedule`, a resource kind the replies require and do not name) that
  resolves to exactly one project and carries its owner as a relation. The
  binding of an execution to its project is derived by the server, never taken
  from input.
- `schedule_owner` lets account actors read, change and fetch artifacts of
  their own schedules only. Full authority manages all.
- Owner filtering applies before pagination and release; a schedule of another
  owner is `not_found`.
- Changing a schedule's project authorizes the old binding and the new one.
- The complete export-plus-attachment requirement (`knowledge:export` and
  `attachments:read` on the project) is rechecked at every dispatch and at every
  publication of an artifact. A disabled owner or a lost `knowledge:export`
  suspends the schedule with a reason; there is no re-resolution as
  installation.
- A restore invalidates background authority; the next dispatch re-checks the
  owner and the permissions.
- Agents cannot own an export schedule under the six roles: `knowledge:export`
  is held by `maintainer` and `admin`, which are human-only. Whether this
  stays (owner decision `17802524`): the role table is not changed, and a
  human sets up export schedules.

Restore (OPEN-23, `29cf8fa5`). `backup.preview` is a query and persists
nothing. `backup.restore` is the registry operation of durable restore
admission; its commit point is the first durable write of the restore request.
The specialized handoff makes the last authorization and fence check before it
drains, and completion after shutdown runs under the recorded specification,
not under a live session. The exact adapter is deferred.

### 4.5 Project transfer and import

OPEN-10, OPEN-13, `ce8aa214` F6 and required change 8.

- Two fixed schemas, not one operation with a conditional requirement:
  `knowledge.project_import` (existing destination, `knowledge:import` on it)
  and `project.create_from_import` (new destination, `projects:create`).
- The real destination is resolved and authorized, never only an input project
  id while data is written elsewhere.
- Both reject restored grants, credentials and automatic registration startup.
- Both are restricted to Knowledge and attachments. A bundle carrying secrets
  is not accepted under import or create permission alone; no secret-transfer
  operation is specified.
- `knowledge.project_export` writes Knowledge and attachments only.
- Raw host paths stay local (the CLI under the unix socket or offline).
  Bundle transfer has no account-facing form in this release (owner decision `17802524`); a
  maintainer who needs it asks someone with access to the machine.
- Hub import (rows 7.40, 7.41) stays a local maintenance command. It no longer
  reads an owner credential: local offline operator authentication replaces it,
  with the lock, the import validation and the provenance retained, and no
  remote fallback.

### 4.6 Remote verification and workers

`ce8aa214` F8, `29cf8fa5` delta 6.

| Phase | Operation | Authorization |
| --- | --- | --- |
| Submit | `remote_verification.submit` | `tests:run` on the project; the submitter is stored |
| Read, cancel | `remote_verification.get`, `get_logs`, `cancel` | `tests:run` on the request (kind `remote_request`, resolves to its project and version); cancel adds `request_submitter` (the caller is the stored submitter) |
| Assign new work | `worker.poll` | two evaluations: the executor's own context (in better-auth, an authenticated agent account holding `executor`; in open and token mode, the installation actor on the worker listener; in every mode bound to an active registration; `worker:execute` on the request's project; project and preset compatibility) and, separately, the stored submitter's current grants (`tests:run`) through an application authorization interface, without replacing the executor's context; the assignment is recorded; each item is released on its own |
| Deliver cancellation | within the worker exchange (`worker.poll`, `worker.report`) | the persisted cancellation intent is delivered to the assignment's worker; it is not authorization to start new work |
| Report, finalize, clean up | `worker.report` | `worker_assignment` and `worker:execute` on the attempt; exact assignment, sequence, immutable commit and cleanup checks; finalization and cleanup of an assignment already begun complete after a revocation; no new assignment is made |

`collection(worker:execute)` is not a permission to assign work or to update an
arbitrary worker's contact state. Full authority stays subject to the
assignment and process-ownership invariants. `workerId` selects a worker and
never authenticates one. Revoking a worker's access is `account.token_revoke`
for the executor agent account in better-auth, and rotation of the installation
token in token mode; open mode has no token to revoke.

### 4.7 Administrative stop and inspect

`test_run.admin_stop` (`ce8aa214` F12, `run-administration.ts:250`). Outcomes
preserved from `administrativeStopAction`:

- cancellation of a queued or preparing run;
- stop of an owned running process tree, with the optional wait;
- joining a finalization that is already in progress;
- retry of owned cleanup;
- safe none, when there is nothing to do.

An unknown run is refused before any effect. The page does not map these
outcomes to run states beyond this list: the replies name the outcomes and the
source (`run-administration.ts:250`) owns the mapping.

It never signals an unowned or saved PID. Force stop does not authorize
killing a foreign process and does not silently release a claim.

`test_run.admin_inspect` (OPEN-22). Requires `tests:read`. It is its own
projector with bounded ownership, persistence and resolution evidence. Today's
inspection also returns command, arguments, cwd, error text and audit, so the
page gates them: command, arguments and cwd need `config:read`; error and log
text need `logs:read`; holder identity needs `claims:manage`; audit needs
`runtime:administer`. This mapping reuses the tiers of `project.status` and
`test_run.logs`; it is an editorial proposal for the re-review, since the
replies ask for explicit gates and name none.

### 4.8 Accounts, last admin and lost-admin recovery

OPEN-19, OPEN-20, OPEN-24, `ce8aa214` required changes 14 and 15.

- Account and role operations exist in better-auth. In open and token mode
  they answer `unavailable` with reason `accounts_not_enabled`.
- **Setup sequence.** The first `admin` is created by the operator over the unix
  socket or offline, which needs no existing admin: `account.create`,
  `account.enroll`, then `admin_role.grant`.
- **Lost admin.** Recovery has no owner-session dependency. The operator
  creates a new human account, enrolls it and grants `admin`; or the operator
  runs `account.recover` on an existing admin. `account.recover` gives a new
  password and keeps or resets factors; it does not by itself re-enable a
  disabled account.
- **Last-admin rules.** The last active `admin` cannot be disabled
  (`account.disable`) and its role cannot be revoked (`admin_role.revoke`),
  except by the operator. A disabled last account stays disabled; the operator
  creates a new account and grants `admin` as above.
- **Reads and mutations.** Account and role reads are human-only without a
  fresh login. Every mutation (accounts, role grants and revocations, token
  issue and revoke) is human-only and needs `freshLogin`.
- A maintainer may grant and revoke the five project roles on its own project,
  including `maintainer` and `secrets`; recipient kind is validated (roles have
  recipient kinds) and grants are project-only.
- **Provider and local commands.** Exactly these provider commands are LOCAL:
  `auth provider status` (row 11.23) and `auth provider configure` (11.24).
  They only report or write the protected provider configuration. They are not
  an escape hatch for the replaced account and role commands: every replaced
  provider account and role action invokes the shared application operation.
  No network request can select operator authority, and no operation falls
  back to the private socket after an account denial.

### 4.9 Sensitive output allowlists

Every sensitive read has a field allowlist. The same allowlist applies on the
error path, in replayed receipts and in events: a refusal, a receipt or an event
carries nothing the caller could not see in the read. "Safe" or "bounded" alone
does not gate commands, logs, holder identities or authentication material.
This table fixes categories; the exact fields are fixed in the implementing
pull request ([section 9.3](#93-deferred-implementation)). Everything in the
"Gated" column is excluded from the release until that pull request names the
exact field and its permission; a family pull request must not copy an internal
DTO to fill it.

| Operation | Allowed to every holder of its permission | Gated |
| --- | --- | --- |
| `project.status`, merged project DTO | ids, name, port, phase, worktree path, claim `none`, `own` or `other`, safe Knowledge metadata (revision, status, `writable`) | executable and arguments: `config:read`; holder identity: `claims:manage`; Knowledge content: never |
| `config.read` | structure, names, TLS mode and paths, preset timeouts, Vault entry names and revisions | literal values: never here (`*_values_read`) |
| `test_run.read`, `history_list`, `summary`, `metrics`, `compare` | ids, preset id, phase, outcome, timestamps, bounded counts and durations | raw command, output, environment, holder identity |
| `test_run.logs` | redacted bounded lines | application output may still hold secrets |
| `test_run.admin_inspect` | bounded ownership, persistence and resolution evidence | see [section 4.7](#47-administrative-stop-and-inspect) |
| `godot_web.status` | export state and counts | error text: `logs:read`; paths and commands: `config:read` |
| `remote_verification.get`, `get_logs` | request, attempt, flags, bounded latest report; last uploaded output | authentication material and assignment secrets: never |
| `diagnostics.mcp` | counts and states | tokens, session secrets, grants: never |
| `user_export.recovery_list`, `recovery_preview` | recovery item ids, sizes, ages | paths and contents |
| `vault.audit` | who, when, what kind of action, entry id | values, ciphertext, key material: never |
| `capacity.read`, `test_queue.read` | counts | holder identities: `claims:manage` per project |

### 4.10 Idempotency key limits

The runner accepts keys of 1 to 128 restricted characters. This page applies
that limit to every operation that retains. Knowledge accepts 200 characters
and backups 256 today (matrix), and the configuration and test operations 1 to
120, so some existing keys no longer fit: behaviour change 34. `test_run.admin_stop`
keeps its request id (8 to 120 characters) as its key, which is within the
limit.

### 4.11 Aggregates and collections

`collection(P)` is not an authorization gate for an effect: the runner decides
it as allowed and the permission is enforced when the projector filters items.
Therefore:

- The aggregate eligibility of `capacity.read`, `test_queue.read` and
  controller-wide events is the planned requirement `any_project(project:read)`
  ([section 1.2](#12-planned-contract-extensions)), implemented at release. It
  is not the broader "visible project" of decision M: a subscriber that sees a
  project only through `secrets` or `executor` does not receive controller
  aggregates.
- Installation detail is `capacity.detail_read` (`installation capacity:read`).
  It works for an `admin` on an installation with no projects, which a filtered
  project collection could not.
- Per-project identities (slot holders) are filtered with `claims:manage`.
- A collection requirement never authorizes a mutation or the aggregate by
  itself. `worker.poll` therefore does not use one.

### 4.12 Replacement compositions

One matrix row may be replaced by several target operations. Two are written
out because the first draft named one operation for them (`ce8aa214` F11).

**Row 2.3 `project.metadata_refresh`.** Today a dashboard refresh discovers
worktrees and presets, updates freshness and error metadata, calls
`storage.ensureFresh` and returns the full localized snapshot. Replacement:

| Effect today | Replacement |
| --- | --- |
| Worktree discovery | `project.worktrees` (query) |
| Preset discovery | `test_preset.list` (query) |
| Freshness and error metadata | retained as internal cache state of the discovery service, updated by those queries; it is not a write authorized in the caller's name, and both queries project it |
| Implicit storage freshness check | removed: scans are explicit (`storage.refresh`, `storage:manage`); `storage.read` shows the cached snapshot |
| Full snapshot in the response | removed |

Discovery stays bounded and coalesced, and log events do not trigger repeated
full Git scans.

**Row 13.2 `dashboard.live`.** Today a partial dashboard by section
(`runtime`, `reservation`, `tests`, `storage`, `controller`) with an event
version. Replacement:

| Section | Replacement |
| --- | --- |
| `runtime`, `reservation` | `project.status` |
| `tests` | `test_run.history_list` and `test_run.read` |
| `storage` | `storage.read` |
| `controller` | `capacity.read`, `test_queue.read` and `runtime.metrics` |
| version, changes | `events.subscribe` (SSE), re-reading the operations above |

## 5. Disposition of every matrix row

Classes: `REPLACED BY` (one or more target operations; several rows may share
one), `REMOVED` (with the deciding record and what covers the remaining need),
`SPECIALIZED` (a provider or transport route outside the registry) and `LOCAL`
(a local operator command outside the registry). A row replaced by several
operations is a composition: the cell lists each operation and the
behaviour column says which part each covers. Decision references: owner
decisions `9ba49f3c` (numbered 1 to 4 there), `2c641ff7`, `4ac7fb45`, `42019833`;
accepted target `5583b882`/`1367c632` (points 1 to 9 of the common goal);
contract v1 `032aa386`. A reference `OPEN-<n>` points to the decision on that
former open item in [section 9.1](#91-decided). No row carries an undecided marker.

### 5.1 Family 1: runtime and claims

| Row | Current operation (names per surface) | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 1.1 | project.list: MCP `list_projects`; account HTTP `list-projects` | REPLACED BY `project.list` | One DTO for every caller. Holder identity of another owner appears only for a caller holding `claims:manage` on that project (full authority does); resource samples move to `runtime.metrics`. The account and token HTTP surfaces get a dedicated list route. |
| 1.2 | project.status: `get_project_status`; account `project-status`; resource `projects/{id}/status` | REPLACED BY `project.status` | The installation snapshot is split: literal environment values leave status reads and are the `secrets:read` operations `config.environment_values_read` and `profile.values_read`; executable and arguments appear in `project.status` only for a holder of `config:read` (and in `config.read`); logs, storage and test runs are separate operations. |
| 1.3 | project.status_compact: `get_project_status_compact` | REPLACED BY `project.status` | `compact` input. Now available to human accounts (absent on the account surface today). |
| 1.4 | project.worktrees: `list_worktrees`; account `list-worktrees`; resource | REPLACED BY `project.worktrees` | A query (planned extension 1). Installation MCP loses `statusError`, last-commit time and merged-into fields (allowlist). |
| 1.5 | status.wait: `wait_for_status_change`; account tests `wait` (run only) | REPLACED BY `project.wait` and `test_run.wait` | Split by target because the requirement depends on the target. Both are bounded streams of at most one event (planned extension 1); there is no `wait` kind. Installation gets the recheck after the wait. |
| 1.6 | claim.acquire: `claim_project`; account `claim` | REPLACED BY `claim.acquire` | Installation MCP claim no longer starts or moves the server; `runtime.start` is explicit (accepted target, point 8). No `responseMode`. TTL default and bounds identical on every surface. The holder is a coordination session. |
| 1.7 | claim.renew: `renew_project_claim`; account `renew` | REPLACED BY `claim.renew` | Optional idempotency key on every surface. |
| 1.8 | claim.release: `release_project_claim`; account `release` | REPLACED BY `claim.release` | Optional idempotency key on every surface. Declared expected transition. |
| 1.9 | runtime.start: `start_project`; account `start`; HTTP `operation:"start"` | REPLACED BY `runtime.start` | `runtime:control` and, when a claim exists, its holder (OPEN-1, owner decision `42019833`). No claim is required: the token dashboard's one-click start stays, and agents no longer have to claim first. HTTP gains the idempotency key and the receipt. |
| 1.10 | runtime.restart: `restart_project`; account; HTTP | REPLACED BY `runtime.restart` | As 1.9. The claim's absence is rechecked again after the stop. |
| 1.11 | runtime.stop: `stop_project`; account; HTTP | REPLACED BY `runtime.stop` | As 1.9. Stopping a server that another session claimed is `claim.force_release` first or `runtime.force_stop`. |
| 1.12 | runtime.switch: HTTP `operation:"switch"` only | REPLACED BY `runtime.switch` | As 1.9; now on MCP and CLI too. The holder's claim moves with the switch; no claim, none created (`46672ea8`). |
| 1.13 | reservation.acquire: HTTP human lock, owner `local-user` | REPLACED BY `claim.acquire` | One claim kind. The `local-user` owner and the separate human lock disappear; the token browser holds claims through a coordination session opened per tab (OPEN-2). |
| 1.14 | reservation.release: HTTP | REPLACED BY `claim.release` | As 1.13. |
| 1.15 | reservation.force_release: HTTP, any authenticated caller | REPLACED BY `claim.force_release` | Needs `runtime:administer` (source: `releaseReservation(..., force)` bypasses owner and kind checks, `sqlite-state-store.ts:1413-1415`). Declared expected transition. Human only, never on MCP (`fb1567d5`). |
| 1.R | mcp.resources: five `worktree-switcher://` URIs (not counted in the 204) | REPLACED BY `project.list`, `project.status`, `project.worktrees`, `capacity.read`, `test_queue.read` | Resources stay read views of these operations and authorize at call time (contract v1, answer g). |

### 5.2 Family 2: project administration

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 2.1 | project.add: HTTP `POST /api/projects`; CLI and socket `project add` | REPLACED BY `project.create` | Needs `projects:create` on the installation. The result is a safe summary, not the full view with environment values. Port choice is part of the operation. |
| 2.2 | project.remove: HTTP `DELETE`; CLI and socket `project remove` | REPLACED BY `registration.detach` | OPEN-3: there is no hard delete of a project. A maintainer may detach a registration of their own project. Knowledge is preserved, not archived; archiving is `project.archive`. `projects:remove` leaves the vocabulary. Declared expected transition. |
| 2.3 | project.metadata_refresh: HTTP only | REPLACED BY `project.worktrees` and `test_preset.list` | A composition ([section 4.12](#412-replacement-compositions)): worktree discovery and preset discovery are two queries; freshness and error metadata stay internal cache state; the implicit storage freshness check is removed (scans are `storage.refresh`); the full snapshot response is gone. |
| 2.4 | project.tls_set: HTTP only | REPLACED BY `config.tls_set` | Needs `config:write` and respects an existing claim; now on MCP and CLI. |
| 2.5 | project.overview: HTTP `GET /api/dashboard`; CLI `project list`, `doctor`; socket `dashboard` | REPLACED BY `project.list`, `project.status`, `runtime.metrics`, `events.subscribe` and `session.describe` | A composition: the dashboard composes the first four; mode and listener move to `session.describe`. `doctor` stays LOCAL. |

### 5.3 Family 3: configuration and environment profiles

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 3.1 | env.set: MCP `set_project_environment`; HTTP | REPLACED BY `config.environment_structure_set` and `config.environment_values_set` | One-to-many (OPEN-7, delta 8): names and policy need `config:write`; literal values need `secrets:write`; an operation that changes both is two calls. Both respect an existing claim. Now on CLI. |
| 3.2 | profile.list: `list_environment_profiles`; account `profiles` | REPLACED BY `profile.list` and `profile.values_read` | Names, structure and revision for readers (`config:read`); literal values are a separate read (`secrets:read`). No longer `profiles:select`. |
| 3.3 | profile.save: `save_environment_profile`; HTTP | REPLACED BY `profile.structure_save` and `profile.values_set` | One-to-many. HTTP-only `restart` option removed; call `runtime.restart`. |
| 3.4 | profile.select: `select_environment_profile`; account; HTTP | REPLACED BY `profile.select` | One schema: revision compare-and-set, idempotency key, name pattern. `restartRequired` and the HTTP `restart` option removed; never restarts. Respects an existing claim; no claim is required. |
| 3.5 | profile.delete: `delete_environment_profile`; HTTP | REPLACED BY `profile.delete` | Needs `config:write`. |
| 3.6 | test_profile.list: `list_test_environment_profiles`; HTTP | REPLACED BY `test_profile.list` | Names and structure only, as today. Literal values: `test_profile.values_read` (new, no matrix row). |
| 3.7 | test_profile.save: `save_test_environment_profile`; HTTP | REPLACED BY `test_profile.structure_save` and `test_profile.values_set` | One-to-many. One response shape (today MCP returns the list, HTTP the project). |
| 3.8 | test_profile.delete: `delete_test_environment_profile`; HTTP | REPLACED BY `test_profile.delete` | One response shape. |
| 3.9 | test_preset.assign_profile: `assign_test_preset_profile`; HTTP | REPLACED BY `test_preset.assign_profile` | |
| 3.10 | test_preset.timeout_set: `set_test_preset_timeout`; account; HTTP | REPLACED BY `preset.timeout_set` | Compare-and-set and a discovered preset on every surface. Respects an existing claim. Source shows the preset pattern also applies on the installation path (`preset-timeout.ts:5-8`). |
| 3.11 | project.configuration_read: `get_project_configuration` (agent); account `configuration` | REPLACED BY `config.read` and `config.environment_values_read` | Structure needs `config:read`, no longer `config:write`; literal values need `secrets:read`. Now on HTTP and CLI for the actor kinds that lacked it. |

### 5.4 Family 4: verification and test runs

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 4.1 | test_preset.list: `list_test_presets`; account `presets` | REPLACED BY `test_preset.list` | A query. One projection: all presets with an advisory `enqueueable` flag (OPEN-14); `tests:read`, no longer `tests:run`. |
| 4.2 | test_run.enqueue: `run_test`; account `enqueue`; HTTP `POST /tests` | REPLACED BY `test_run.enqueue` | HTTP gains the idempotency key. No `responseMode`. Results are the safe status DTO, not the full run. No claim is required; existing reservation and worktree rules stay. |
| 4.3 | test_run.read: `get_test_run`; HTTP `GET /api/test-runs/:id` | REPLACED BY `test_run.read` | Any caller with `tests:read` reads any run of the project, as safe status: installation loses the output tail and command text there; output is `test_run.logs`. |
| 4.4 | test_run.status: `get_test_run_status`; account `status` | REPLACED BY `test_run.read` | `compact` input. |
| 4.5 | test_run.cancel: `cancel_test_run`; account `cancel`; HTTP | REPLACED BY `test_run.cancel` | Token HTTP can no longer cancel any run (the `local-user` author-check bypass, `test-job-manager.ts:232`). Cancel only from the originating session; takeover is `test_run.admin_stop`. |
| 4.6 | test_run.history_list: `list_test_runs`; HTTP | REPLACED BY `test_run.history_list` | Needs `tests:read`; agents and human accounts gain it where the installation MCP and token HTTP had it. |
| 4.7 | test_run.summary: `get_test_run_summary`; HTTP | REPLACED BY `test_run.summary` | |
| 4.8 | test_run.metrics: `get_test_metrics`; HTTP | REPLACED BY `test_run.metrics` | |
| 4.9 | test_run.compare: `compare_test_runs`; HTTP | REPLACED BY `test_run.compare` | |
| 4.10 | test_run.admin_inspect: CLI `test-run inspect`; socket | REPLACED BY `test_run.admin_inspect` | Now a registry operation requiring `tests:read` (OPEN-22) with a distinct projector whose command, log, holder and audit fields are gated ([section 4.7](#47-administrative-stop-and-inspect)). Also on HTTP and MCP. |
| 4.11 | test_run.admin_stop: CLI `test-run stop`; socket | REPLACED BY `test_run.admin_stop` | Needs `runtime:administer` for accounts; the operator holds it. Keeps queued cancellation, join, owned cleanup retry and safe none. Also on HTTP and MCP. |

### 5.5 Family 5: Godot web

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 5.1 | godot_web.configure: `configure_godot_web`; HTTP; CLI; socket | REPLACED BY `godot_web.configure` | Needs `config:write`; respects an existing claim; recheck after discovery. |
| 5.2 | godot_web.status: `get_web_export_status`; HTTP | REPLACED BY `godot_web.status` | Field allowlist. |
| 5.3 | godot_web.rebuild: `rebuild_web_export`; HTTP; CLI; socket | REPLACED BY `godot_web.rebuild` | Needs `runtime:control` (OPEN-15). The requesting actor's authority is kept as an immutable specification for the background enqueue. |

### 5.6 Family 6: storage, capacity, metrics and logs

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 6.1 | storage.read: `get_project_storage` | REPLACED BY `storage.read` | One projection per operation, the scoped one: one path, last 16 history points. The installation MCP's all-worktree dump goes (inferred from contract v1 amendment 7). Now on HTTP and CLI. |
| 6.2 | storage.refresh: HTTP only | REPLACED BY `storage.refresh` | Needs `storage:manage` (OPEN-15). Gains an actor at the queueing point. |
| 6.3 | storage.cache_delete: HTTP only | REPLACED BY `storage.cache_delete` | Needs `storage:manage`; recheck before the removal. |
| 6.4 | capacity.read: `get_server_capacity` | REPLACED BY `capacity.read` and `capacity.detail_read` | Split (OPEN-4): aggregate counts for any caller with `project:read` on at least one project (`any_project`); slot holders need `claims:manage` per project; installation-wide detail is a separate operation with `capacity:read`. |
| 6.5 | capacity.set: HTTP only | REPLACED BY `capacity.set` | Needs `capacity:write`; now on MCP and CLI. |
| 6.6 | test_queue.read: `get_test_queue` | REPLACED BY `test_queue.read` | `any_project(project:read)`; no identities. |
| 6.7 | test_queue.set: HTTP only | REPLACED BY `test_queue.set` | Needs `settings:write` (OPEN-16), no longer any HTTP caller. |
| 6.8 | runtime_logs.read: `get_runtime_logs` | REPLACED BY `runtime_logs.read` | Installation MCP gets redacted bounded lines, not raw process output (source: raw today, `process-manager.ts:151-155`). |
| 6.9 | test_run_logs.read: agent `get_test_run_logs` | REPLACED BY `test_run.logs` | Needs `tests:read` and `logs:read`; not limited to own runs; now for installation and humans. |
| 6.10 | runtime.metrics: HTTP `GET /api/metrics` | REPLACED BY `runtime.metrics` | Filtered per project; now on MCP and CLI. |

### 5.7 Family 7: Knowledge

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
| 7.13 | `project` | REPLACED BY `project.status` | One project entity (OPEN-13). Revision, status and the `writable` flag join the safe status DTO; Knowledge content does not. |
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
| 7.38 | project export: CLI `backup export-project` (offline) | REPLACED BY `knowledge.project_export` | Needs `knowledge:export` and `attachments:read`. CLI only in this release (owner decision `17802524`). |
| 7.39 | project import: CLI `backup import-project` (offline) | REPLACED BY `knowledge.project_import` and `project.create_from_import` | Split by destination (OPEN-13): existing project with `knowledge:import` (its first real consumer), new project with `projects:create`. Today owner session. CLI only in this release (owner decision `17802524`). |
| 7.40 | hub `knowledge plan-import` (offline, no authentication) | LOCAL: `knowledge plan-import` | Offline file read of a legacy Hub plan; stays local maintenance (OPEN-10). |
| 7.41 | hub `knowledge execute-import` (offline, owner or installation credential) | LOCAL: `knowledge execute-import` | Local offline operator authentication replaces the owner credential; the lock, validation and provenance are retained; no remote fallback (OPEN-10). |

### 5.8 Family 8: Vault

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 8.1 | import (owner only, Ed25519 proof) | REPLACED BY `vault.import` | `secrets:write` replaces the owner proof. Token mode opens the Vault with the installation token; open mode with no credential (owner decision `9ba49f3c` point 1). The dotenv text is never retained. |
| 8.2 | update (owner only) | REPLACED BY `vault.update` | As 8.1. |
| 8.3 | list (owner only) | REPLACED BY `vault.list` | `secrets:read`; configuration readers see names through `config.read` (OPEN-18). |
| 8.4 | read (owner direct; agent with approved grant) | REPLACED BY `vault.read` | `secrets:read`, no per-use grant. |
| 8.5 | request (agent) | REMOVED: accepted target point 6 (request and once-grant flow removed), owner decision `9ba49f3c` point 1 | The `secrets` role replaces the request; an admin or maintainer grants it with a fresh login (`role.grant`). Historical audit is preserved; legacy encrypted grants and receipts never authorize. |
| 8.6 | requests | REMOVED: as 8.5 | Nothing pending exists to list. |
| 8.7 | inspect-request | REMOVED: as 8.5 | |
| 8.8 | approve | REMOVED: as 8.5 | Approval is the role grant. |
| 8.9 | reject | REMOVED: as 8.5 | |
| 8.10 | revoke (grant) | REMOVED: as 8.5 | `role.revoke` removes the `secrets` role. |
| 8.11 | write (agent, approved write grant) | REPLACED BY `vault.update` | Direct write with `secrets:write`; the immutable-patch grant disappears. There is no `vault.write`. |
| 8.12 | use (always `vault_use_unavailable`) | REMOVED: accepted target point 6 (no fictional `env:use`) | Never worked, nothing covers it. |
| 8.13 | audit (owner only) | REPLACED BY `vault.audit` | `roles:manage` on the project, bounded, no values (OPEN-18). |

### 5.9 Family 9: installation backups

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 9.1 | backup.overview: HTTP `GET`; socket; CLI `backup list` | REPLACED BY `backup.overview` | Needs `backups:manage`. Reachable by an admin in better-auth (HTTP is unreachable there today). |
| 9.2 | backup.create: HTTP; socket `create` and `now`; CLI | REPLACED BY `backup.create` | `create <dir>` and `now` collapse into one operation. Remote surfaces take a configured destination id; only the local operator names a path. |
| 9.3 | backup.preview: HTTP only | REPLACED BY `backup.preview` | A query; persists nothing (OPEN-23). |
| 9.4 | backup.restore: HTTP; socket; CLI offline | REPLACED BY `backup.restore` | Offline restore no longer uses a no-op authorize (`backup-management.ts:80`): it runs as operator. The commit point is the first durable write of the restore request; the specialized handoff keeps its own last check (OPEN-23). |
| 9.5 | backup.status: HTTP; socket; CLI | REPLACED BY `backup.status` | |
| 9.6 | backup.monitor: socket; CLI | REPLACED BY `backup.monitor` | Now on HTTP and MCP. |
| 9.7 | backup.remote_status: socket; CLI | REPLACED BY `backup.remote_status` | |
| 9.8 | backup.remote_reupload: socket; CLI | REPLACED BY `backup.remote_reupload` | |
| 9.9 | backup.remote_retry: socket; CLI | REPLACED BY `backup.remote_retry` | |
| 9.10 | backup.remote_rebind: CLI offline only | REPLACED BY `backup.remote_rebind` | CLI offline only, stopped-controller maintenance (OPEN-11); gains an authority check (none today). |

### 5.10 Family 10: user backups and exports

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 10.1 | user_backup.overview: HTTP | REPLACED BY `user_backup.overview` | Needs export and attachment read per project and `schedule_owner` filtering. The installation token is accepted (rejected today). Agent-owned schedules are unavailable under the six roles (owner decision `17802524`). |
| 10.2 | user_backup.save: HTTP | REPLACED BY `user_backup.save` | Durable owner; both bindings authorized on a project change; recheck at dispatch. Expected transition on a change of project; a local operator's schedule is owned by `operator` (`46672ea8`). |
| 10.3 | user_backup.status: HTTP | REPLACED BY `user_backup.status` | As 10.1. |
| 10.4 | user_backup.artifact: HTTP | REPLACED BY `user_backup.artifact` | Owner-checked; publication rechecked. |
| 10.5 | user_export.recovery_list: socket; CLI | REPLACED BY `user_export.recovery_list` | Needs `backups:manage`; now on HTTP and MCP. |
| 10.6 | user_export.recovery_preview: socket; CLI | REPLACED BY `user_export.recovery_preview` | |
| 10.7 | user_export.recovery_cleanup: socket; CLI | REPLACED BY `user_export.recovery_cleanup` | |

### 5.11 Family 11: identity, accounts and roles

Removed by the accepted target (points 2 and 5) and owner decision `9ba49f3c`
point 4: owner sessions and owner bootstrap, recover and renew; sponsors,
runtime delegations, credential ceilings and separate runtime credentials;
agent tokens and Knowledge grants in token mode; legacy mode. Agents in
better-auth keep exactly one revocable account token. Knowledge grants in token
mode are not an uncovered need: they disappear because installation already has
full authority.

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 11.1 | identity.describe: MCP `get_identity`; HTTP `GET /api/identity` | REPLACED BY `session.describe` | Lists visible projects and permissions actually held, installation permissions and fresh-login state. Knowledge grants, runtime access and credential ceilings disappear from the result. |
| 11.2 | owner.bootstrap: HTTP; CLI `identity bootstrap-owner` | REMOVED: accepted target point 2 (no owner sessions, no legacy mode); target plan point 9 | The first admin is created by the operator with `account.create`, `account.enroll` and `admin_role.grant` over the unix socket or offline, with no existing admin and no owner-session dependency ([section 4.8](#48-accounts-last-admin-and-lost-admin-recovery)). |
| 11.3 | owner.recover: CLI `identity recover-owner` (offline) | REMOVED: as 11.2 | Lost-admin recovery: operator account creation, enrollment and `admin_role.grant`, or `account.recover` (section 4.8). |
| 11.4 | owner.renew: HTTP admin; CLI; socket | REMOVED: as 11.2 | Sessions are provider sessions with fresh-login evidence. |
| 11.5 | create-agent | REPLACED BY `account.create` | Needs `accounts:manage`, a human admin with a fresh login. Creating an account does not issue a token. |
| 11.6 | list-agents | REPLACED BY `account.list` | |
| 11.7 | revoke-agent | REPLACED BY `account.disable` | The last active admin cannot be disabled except by the operator. |
| 11.8 | issue-agent-token | REPLACED BY `account.token_issue` | Exactly one token per agent account; issuing replaces it atomically; delivered once (OPEN-20, [section 4.3](#43-secret-safe-retention-and-token-delivery)). Not available in token mode. |
| 11.9 | list-agent-tokens | REPLACED BY `account.list` | Token metadata is part of the account projection; `account.get` for one account. |
| 11.10 | revoke-token | REPLACED BY `account.token_revoke` | |
| 11.11 | create-knowledge-project | REPLACED BY `project.create` | One project entity. |
| 11.12 | grant-knowledge | REPLACED BY `role.grant` | Knowledge grants become project roles; better-auth only, unavailable in open and token mode; no legacy grant fallback remains. |
| 11.13 | list-knowledge-grants | REPLACED BY `role.list` | Per account: `account.get`. As 11.12. |
| 11.14 | revoke-knowledge-grant | REPLACED BY `role.revoke` | As 11.12. |
| 11.15 | set-knowledge-role | REPLACED BY `role.grant` | `reader`, `operator`, `manager` become `reader`, `operator`, `maintainer`; existing grants are reset (owner decision `9ba49f3c` point 4). As 11.12. |
| 11.16 | list-knowledge-roles | REPLACED BY `role.list` | As 11.12. |
| 11.17 | revoke-knowledge-role | REPLACED BY `role.revoke` | As 11.12. |
| 11.18 | set-runtime-delegation | REMOVED: accepted target point 2 (no sponsor, delegations or ceilings) | A project role granted to the agent account (`role.grant`) covers it; adding a project needs a role grant and no token reissue (task `46b6a246` archive note in `4ac7fb45`). |
| 11.19 | revoke-runtime-delegation | REMOVED: as 11.18 | `role.revoke`. |
| 11.20 | list-runtime-access | REMOVED: as 11.18 | `role.list` and `account.get`. |
| 11.21 | issue-runtime-credential | REMOVED: accepted target point 2 (no separate runtime credentials) | The account token plus roles. |
| 11.22 | rotate-runtime-credential | REMOVED: as 11.21 | `account.token_issue` replaces the one token. Rotation is administered by a fresh human admin or the local operator; agents have no self-service token administration. |
| 11.23 | provider status: CLI `auth provider status`; socket | LOCAL: `auth provider status` | Provider configuration and enrollment status only. |
| 11.24 | provider configure | LOCAL: `auth provider configure` | Writes the protected provider configuration and signing secret; authentication configuration is a local operator command. Not an escape hatch for the replaced account and role commands. |
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
| 11.35 | provider enroll | REPLACED BY `account.enroll` | Email, name and password only; factor enrollment belongs to the provider ceremonies (11.41 to 11.46). |
| 11.36 | provider recover | REPLACED BY `account.recover` | New password; does not by itself re-enable a disabled account. |
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

### 5.12 Family 12: remote verification

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 12.1 | remote_verification.submit: MCP only | REPLACED BY `remote_verification.submit` | Needs `tests:run`; the per-principal submit grant written by `provision` disappears. Now on HTTP and CLI. |
| 12.2 | remote_verification.get: MCP only | REPLACED BY `remote_verification.get` | Request resource of kind `remote_request` (OPEN-6). |
| 12.3 | remote_verification.get_logs: MCP only | REPLACED BY `remote_verification.get_logs` | As 12.2. |
| 12.4 | remote_verification.cancel: MCP only | REPLACED BY `remote_verification.cancel` | `request_submitter` (OPEN-5). |
| 12.5 | remote_worker.poll: worker listener | REPLACED BY `worker.poll` | Worker listener only. Two evaluations at assignment: the executor's and the stored submitter's (OPEN-5); `workerId` selects, never authenticates (`575a4fe8` answer f). |
| 12.6 | remote_worker.report: worker listener | REPLACED BY `worker.report` | Worker listener only. |
| 12.7 | remote_verification.provision: CLI offline | REPLACED BY `worker.register` | Worker token file and `callerPrincipalIds` are gone (separate worker tokens removed, accepted target point 2). Becomes an online operation for a human `admin` (owner decision `17802524`). |
| 12.8 | remote_verification.revoke_token: CLI offline | REMOVED: accepted target point 2 (separate worker tokens) | Better-auth: `account.token_revoke` on the executor agent account. Token mode: the installation token, rotated locally (14.3). Open mode has no token to revoke. |
| 12.9 | remote_verification.inspect: CLI offline | REPLACED BY `worker.recovery_inspect` | Needs `workers:manage` (owner session removed). CLI offline only: stopped-controller recovery (OPEN-11). |
| 12.10 | remote_verification.reconcile: CLI offline | REPLACED BY `worker.recovery_reconcile` | As 12.9. |

### 5.13 Family 13: diagnostics and system

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 13.1 | mcp.diagnostics: HTTP; CLI `mcp diagnostics`; socket | REPLACED BY `diagnostics.mcp` | Needs `diagnostics:read`. The legacy secret and owner-session checks disappear. Field allowlist. |
| 13.2 | dashboard.live: HTTP partial dashboard | REPLACED BY `project.status`, `test_run.history_list`, `test_run.read`, `storage.read`, `capacity.read`, `test_queue.read`, `runtime.metrics` and `events.subscribe` | A composition by section ([section 4.12](#412-replacement-compositions)): runtime and reservation from `project.status`; tests from the two test operations; storage from `storage.read`; controller from the three controller reads; version and changes from `events.subscribe`. No partial-section endpoint (accepted target point 7). |
| 13.3 | events.subscribe: HTTP SSE | REPLACED BY `events.subscribe` | Every event authorized and projected per subscriber; controller-wide events as aggregates under `any_project(project:read)` (OPEN-9). |
| 13.4 | directories.browse: HTTP | REPLACED BY `directory.browse` | A query; needs `projects:create` (OPEN-8). |
| 13.5 | auth.status_http: `GET /api/auth/status` | SPECIALIZED: public status route | Public, before any authentication. One body in every mode. |
| 13.6 | mcp.session_endpoint: `/mcp` | SPECIALIZED: MCP transport route | The catalogue registered at session creation is the stable catalogue for the actor kind and listener, with call-time authorization. |
| 13.7 | static.dashboard_assets | SPECIALIZED: static assets | Public. |
| 13.8 | controller.start: CLI `start` | LOCAL: `start` | |
| 13.9 | service.manage: CLI `service ...` | LOCAL: `service install` and siblings | |
| 13.10 | sandbox.run: CLI `sandbox` | LOCAL: `sandbox` | |
| 13.11 | config.mcp: CLI `config mcp` | LOCAL: `config mcp` | Not named in the rule list; classified with `config path`. It no longer reads the legacy `mcp-token` file or a hard-coded `wsi_` prefix; the extra token environment variables go (accepted target point 2). |
| 13.12 | config.path: CLI | LOCAL: `config path` | |
| 13.13 | cli.help / version | LOCAL: `help`, `--version` | |

### 5.14 Family 14: authentication mode, token and fence

All seven are local operator commands: mode selection, installation token
generation and rotation and the security fence are outside the registry (owner
rule: mode changes only through the CLI and only after restart). Exposing them
through TCP or using them as a fallback after an account denial would be a
bypass.

| Row | Current operation | Disposition | Target and behaviour change |
| --- | --- | --- | --- |
| 14.1 | auth.status | LOCAL: `auth status` | |
| 14.2 | token.generate | LOCAL: `auth token generate` | |
| 14.3 | token.rotate | LOCAL: `auth token rotate` | Rotation revokes derived authority immediately: closing live MCP sessions and SSE streams becomes revalidation of the minted context (contract: revoked credential is `unauthenticated`). |
| 14.4 | mode.set | LOCAL: `auth mode set` | Values `open`, `token`, `better-auth`; `legacy` is not accepted; a change applies after restart. |
| 14.5 | fence.inspect | LOCAL: `auth fence inspect` | |
| 14.6 | fence.establish | LOCAL: `auth fence establish` | |
| 14.7 | fence.resume | LOCAL: `auth fence resume` | Resume still quarantines credentials, grants, sessions and pending work. |

## 6. Counts and reconciliation

All numbers below were taken from the tables of this file by text extraction
(see 6.4), not from the matrix.

### 6.1 Target operations

| Family | Operations | Reads | Queries | Mutations | Streams |
| --- | --- | --- | --- | --- | --- |
| 3.1 Session and coordination | 4 | 1 | 0 | 3 | 0 |
| 3.2 Project and registration | 10 | 2 | 1 | 6 | 1 |
| 3.3 Claims | 4 | 0 | 0 | 4 | 0 |
| 3.4 Runtime | 6 | 1 | 0 | 5 | 0 |
| 3.5 Configuration | 21 | 7 | 0 | 14 | 0 |
| 3.6 Test runs | 13 | 7 | 2 | 3 | 1 |
| 3.7 Storage, capacity, logs and system reads | 12 | 6 | 1 | 4 | 1 |
| 3.8 Knowledge | 35 | 19 | 0 | 16 | 0 |
| 3.9 Vault | 6 | 3 | 0 | 3 | 0 |
| 3.10 Backups and exports | 17 | 9 | 1 | 7 | 0 |
| 3.11 Accounts and roles | 13 | 3 | 0 | 10 | 0 |
| 3.12 Remote verification and workers | 9 | 3 | 0 | 6 | 0 |
| **Total** | **150** | **61** | **5** | **81** | **3** |

There is no `wait` kind. Of the 81 mutations, 75 retain (9 of them
secret-safe: `config.environment_values_set`, `profile.values_set`,
`test_profile.values_set`, `vault.import`, `vault.update`, `account.enroll`,
`account.recover`, `account.token_issue`, `coordination.open`); `coordination.renew`,
`coordination.close`, `capacity.set`, `test_queue.set`, `worker.poll` and
`worker.report` do not. Operations with `agents: false`: 18
(`knowledge.approve_memory`, `vault.recover_key`, `claim.force_release`,
`runtime.force_stop`, `worker.register` and the 13 account and role
operations). Operations with `freshLogin`: 13 (`knowledge.approve_memory`,
`vault.recover_key`, `worker.register` and 10 account and role mutations).
Rows carrying a marker in the `Needs` column: 52, all of which
name a planned extension (`query` 5, `bounded_stream` 2, `expected_transition`
6, `claim_holder_if_claimed` 17, `any_project` 3, `schedule_owner` 4,
`remote_request` 4, `request_submitter` 2, `secret_safe_retention` 9,
`token_delivery` 1, `intent_origin` 1, `coordination` 10; a row may carry
several).

The first draft had 139 operations (62 reads, 74 mutations, 2 waits, 1
stream). Changes against it:

| Change | Operations |
| --- | --- |
| Removed (split) | `config.environment_set`, `profile.save`, `test_profile.save` |
| Added: profile structure and values | `config.environment_structure_set`, `config.environment_values_set`, `profile.structure_save`, `profile.values_set`, `test_profile.structure_save`, `test_profile.values_set` |
| Added: value reads | `config.environment_values_read`, `profile.values_read`, `test_profile.values_read` |
| Added: capacity detail | `capacity.detail_read` |
| Added: import by destination | `project.create_from_import` (`knowledge.project_import` stays for the existing project) |
| Added: coordination sessions | `coordination.open`, `coordination.renew`, `coordination.close` |
| Kind changed to `query` | `project.worktrees`, `test_preset.list`, `test_run.lookup_intent`, `directory.browse`, `backup.preview` |
| Kind changed from `wait` to bounded `stream` | `project.wait`, `test_run.wait` |
| Renamed | none; `vault.write` never was an id (the ids are `vault.import` and `vault.update`) |

139 - 3 + 14 = 150. Requirements, notes or flags changed for many other
operations (for example `vault.list`, `vault.audit`, `test_queue.set`,
`test_run.admin_inspect`, `test_preset.list`, `godot_web.rebuild`,
`storage.refresh`); the page does not list every cell edit.

Target operations that no row's disposition column names as its replacement,
because the records require them and the matrix has no equivalent row (12):

| Operation | Why it exists |
| --- | --- |
| `registration.attach`, `registration.move` | Contract v1: `project:manage` covers attach, detach and move of registrations. Row 7.32 names them as covering the removed link. |
| `runtime.force_stop` | Contract v1: stopping another session's run needs `runtime:administer`. Named in row 1.11. |
| `admin_role.grant`, `admin_role.revoke` | Contract v1: admin assignment needs `accounts:manage`. `admin_role.grant` is named in rows 11.2 and 11.25; `admin_role.revoke` is named by no row. |
| `account.get` | Part of the account projection (rows 11.9, 11.13). |
| `test_run.lookup_intent` | Contract v1 amendment 3 and answer d (task `6d680061`). No matrix row. |
| `vault.recover_key` | Contract v1 (provisional). No current operation. |
| `coordination.open`, `coordination.renew`, `coordination.close` | OPEN-2: the claim, run and worker predicates need coordination sessions. No matrix row; named in rows 1.13 and 1.6 only as the mechanism. |
| `test_profile.values_read` | Closes the secrets-only gap (`ce8aa214` F5); today test-profile values are not readable at all. |

Operations named in the disposition cell of no row, anywhere in section 5:
`admin_role.revoke`, `coordination.open`, `coordination.renew`,
`coordination.close`, `test_run.lookup_intent`, `vault.recover_key`. They have no
row because the matrix has none; they exist because the records require them.

### 6.2 Rows per disposition class

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
REPLACED BY the read operations it mirrors. Rows 7.40 and 7.41 are LOCAL
without a provisional mark: Hub import stays a local maintenance command
(OPEN-10). No row carries an undecided marker. The first draft had 35 rows with an open
marker; all are decided and carry only a decision reference `OPEN-<n>` or the
owner decision `17802524`.

### 6.3 Reconciliation

- Section 5 has 205 labelled rows: the 204 rows of the matrix plus `1.R`. Each
  label occurs once. Per family the counts equal the matrix's Appendix B (15,
  5, 11, 11, 3, 10, 41, 13, 10, 7, 48, 10, 13, 7).
- The class columns above add up to 204 per row and in total, and to 205 with
  `1.R`. The class counts are the same as in the first draft (154, 18, 15, 17):
  no row changed class.
- Knowledge: rows 7.1 to 7.37 carry the 37 operation names of
  `knowledgeSchemas` once each, in the matrix's order (12 memory operations,
  then 25 others); 7.38 to 7.41 are the four CLI-only items. Of the 37 names,
  36 are REPLACED BY an operation (32 by `knowledge.*`, 4 by `project.*`:
  `project`, `projects`, `archive_project`, `restore_project`), 1 is REMOVED
  (`link_runtime`) and none is LOCAL. Of the four CLI-only items, two are
  REPLACED BY and two are LOCAL.
- Every target operation named in the disposition column exists in section 3,
  and every operation in section 3 is either named in a disposition column or
  listed in the table in 6.1.
- One-to-many replacement compositions (a row replaced by several operations,
  each covering a stated part): 1.5 (`project.wait`, `test_run.wait`), 2.3
  (`project.worktrees`, `test_preset.list`; section 4.12), 2.5 (`project.list`,
  `project.status`, `runtime.metrics`, `events.subscribe`, `session.describe`),
  3.1, 3.3 and 3.7 (structure and values), 3.2 and 3.11 (structure read and
  values read), 6.4 (`capacity.read`, `capacity.detail_read`), 7.39
  (`knowledge.project_import`, `project.create_from_import`), 13.2 (eight
  operations; section 4.12) and 1.R (five read operations).
- Many-to-one mappings: `project.status` (1.2, 1.3, 7.13, 13.2), `project.list`
  (1.1, 1.R, 2.5, 7.14), `role.grant`, `role.list` and `role.revoke` (four rows
  each), `account.list` (11.6, 11.9, 11.27), and pairs such as `claim.acquire`
  (1.6, 1.13), `claim.release` (1.8, 1.14), `project.create` (2.1, 11.11) and
  `test_run.read` (4.3, 4.4).

### 6.4 How it was checked

A shell script (`awk`, `grep`, `sort`, `comm`; no interpreter of the product)
over this file: (1) the labels of the rows of section 5 (`N.M` and `1.R`), their
number and uniqueness; (2) the class word of each row, by family; (3) the id
column of every table of section 3, its row count per table and the `Kind`
column; (4) every backticked `family.verb` id in the disposition column
checked against section 3 (a typo shows as an id not in the catalogue); (5)
the ids of section 3 that appear in no disposition column and in no cell of
section 5; (6) the number of cells in every row of sections 3 and 5; (7) the
markers of the `Needs` column (no row carries an owner marker since `17802524`). The matrix
itself was not re-counted from source.

## 7. Behaviour changes visible to users and agents

Derived from the tables; each cites its rows. They describe an unreleased
breaking release with no compatibility layer (owner decision `9ba49f3c`
point 4). Items 1 to 30 keep the numbering of the first draft; items 4, 5, 6,
15, 25, 26, 27, 29 and 30 are corrected as review `ce8aa214` asked; items 31 and
up are added.

1. **New MCP and HTTP contract, no compatibility layer.** Tool names, inputs,
   results and errors change; catalogues are stable per actor kind and
   listener and authorize at call time. `get_identity` becomes
   `session.describe`. Every family.
2. **A claim reserves and protects; it never starts a server.** Installation MCP
   `claim_project` no longer places and starts the server; callers invoke
   `runtime.start`. Rows 1.6, 1.13.
3. **Legacy mode, owner sessions and the sponsor machinery disappear.** Mode
   `legacy` is rejected; owner bootstrap, recover and renew, runtime
   delegations, credential ceilings and separate runtime credentials are gone,
   and existing grants are reset while accounts and history stay. Rows 11.2 to
   11.4, 11.18 to 11.22, 11.25.
4. **Vault.** The request, approve, reject, once-grant flow and the Ed25519
   owner proof are gone. Token mode opens the Vault with the installation
   token; open mode uses no token (the accepted resolver rejects a supplied
   credential there) and the Vault is available to the installation actor. In
   better-auth the `secrets` role gives direct read and write without per-use
   consent; `use` is removed. Rows 8.1 to 8.13.
5. **Runtime control respects claims; it does not require one (owner decision
   `42019833`).** Start, stop, restart and switch need no claim, so the token
   dashboard keeps its one-click start; agents no longer have to claim first. When
   a claim exists only its holder may act, for every actor kind and surface;
   others need `claim.force_release` (`runtime:administer`). The absence of a
   claim is rechecked immediately before each effect. HTTP gains idempotency keys
   and receipts. Rows 1.9 to 1.12.
6. **Installation projections shrink to safe DTOs.** `get_project_status`, the
   dashboard snapshot and profile and run reads no longer return literal
   environment values, logs or output tails inline. Literal values come from
   `config.environment_values_read`, `profile.values_read` and
   `test_profile.values_read` (`secrets:read`: installation and operator pass
   permissions; an account holds it only through the `secrets` role). Logs come from `runtime_logs.read` and
   `test_run.logs`. `project.status` still returns the raw executable and
   arguments to a holder of `config:read`; that tier is not removed. Rows 1.2,
   3.2, 4.3, 6.8.
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
    `restartRequired` are removed; callers use `runtime.restart`. Rows 3.3,
    3.4.
12. **Archive and restore of a project need `project:manage`.** Operators and
    agents with `knowledge:write` lose it. Rows 7.30, 7.31.
13. **One project, and no hard delete.** `link_runtime` is removed,
    `project.create` replaces `project add` and `create-knowledge-project`,
    and removing a registration (`registration.detach`) keeps Knowledge without
    archiving it. `projects:remove` leaves the vocabulary. Rows 2.1, 2.2, 7.32,
    11.11.
14. **Knowledge approval is human-only with a fresh login** in better-auth.
    Installation and operator remain exempt, so a token-mode MCP client can
    approve, as today. Row 7.5.
15. **Fresh login for sensitive mutations.** Account and role mutations,
    granting `secrets`, Vault key recovery and Knowledge approval need a human
    session authenticated within 10 minutes (`login_stale`, 403); agents get
    `forbidden`. Account and role reads are human-only and need no fresh login.
    Rows 7.5, 11.5 to 11.36.
16. **Accounts exist only in better-auth.** Account and role operations answer
    `unavailable` with reason `accounts_not_enabled` in open and token mode;
    agent tokens and Knowledge grants in token mode are removed (OPEN-19). Rows
    11.5 to 11.17.
17. **Capacity and queue reads.** Aggregate counts for any caller with
    `project:read` on at least one project; holder detail per project needs
    `claims:manage`; installation-wide detail is a separate operation with
    `capacity:read`. Installation and operator still see all holders (OPEN-4).
    Rows 6.4, 6.6.
18. **Installation backups in better-auth.** Reachable by an admin over HTTP
    (unreachable today); offline restore no longer uses a no-op authorize;
    backup creation gains a recheck before the copy. Rows 9.1 to 9.10.
19. **User backups accept the installation token** and no longer only owner
    session or agent token; ownership and rechecks are in item 41. Rows 10.1 to
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
    keys; replays are reauthorized and can answer `resource_changed`, except
    for the declared transitions of `registration.move`, `registration.detach`,
    `claim.release`, `claim.force_release`, `runtime.switch` and
    `user_backup.save`. Rows 1.6 to 1.12, 3.x, 4.2.
23. **Test run reads.** Any `tests:read` holder reads the project's runs as safe
    status; own-run proof stays safe even for a caller holding `config:read`
    (task `6d680061`); `test_preset.list` lists all presets with an advisory
    `enqueueable` flag and needs `tests:read` (OPEN-14). Rows 4.1 to 4.4, 6.9.
24. **Events.** Each event is filtered per subscriber instead of broadcasting
    project IDs to everyone; controller-wide events go to a subscriber holding
    `project:read` on at least one project (OPEN-9). Row 13.3.
25. **Parity.** The new actor and listener pairs, by row: the CLI gains
    runtime, claim, configuration, test, Vault and Knowledge-style operations;
    MCP gains configuration, TLS, Godot, backups and capacity setting; remote
    verification submit, read and cancel (MCP only today) reach HTTP and the CLI;
    human accounts and agents gain the history, summary, metrics and comparison
    reads that the installation MCP and token HTTP already had; the
    configuration read reaches the pairs named in row 3.11. Rows 1.9 to 1.12, 2.4,
    3.x, 4.6 to 4.9, 5.x, 6.x, 12.1 to 12.4.
26. **Role reachability limits what agents get.** The installation-only tools
    (history, metrics, environment, profiles, Godot) are available to any
    account holding the permission, but tool visibility is not role
    reachability. Agents can hold only `reader`, `operator`, `secrets` and
    `executor`; `maintainer` and `admin` are human-only. So `config:write`,
    `storage:manage`, `knowledge:export`, project administration and
    installation administration are unreachable by any agent. Diagnostics are no
    longer a snapshot of grants at session start. Rows 3.x, 4.6 to 4.9, 5.x,
    6.1 to 6.8.
27. **Local CLI is the operator without a token.** The extra token environment
    variables (`WORKTREE_CONTROL_KNOWLEDGE_TOKEN`, Vault, owner and installation
    variables) are removed; the socket needs no credential in any mode and acts
    are recorded as the local operator. A human login through CLI or MCP was
    rejected from the target; it is not a current feature that this release
    removes. Rows 7.38 to 7.41, 8.1 to 8.13, 11.2 to 11.36, 13.11.
28. **Workers.** Separate worker tokens and per-principal submit grants are
    removed; `workerId` selects a worker and never authenticates one; in
    better-auth the worker is an agent account holding `executor`, bound to an
    active registration. Rows 12.1 to 12.10.
29. **Compact and `responseMode` variants and names are gone.** One safe DTO per
    result. A `compact` input remains where the specified operations take one
    (`project.status`, `test_run.read`, and the cursor envelopes). Rows 1.2,
    1.3, 1.6, 4.2.
30. **Preserved exception, not a change: specialized routes stay.** Sign-in,
    sign-out, MFA and passkey ceremonies, public status and static assets are
    not operations and are never reachable through MCP. Rows 11.37 to 11.48,
    13.5 to 13.7.
31. **An unclaimed server has no protection against displacement.** Anyone with
    `runtime:control` may stop it, including capacity eviction in favour of
    another project; whoever relies on a server must claim it (owner principle
    `42019833`). The agent skill text says "claim before relying on a server".
    Rows 1.9 to 1.12.
32. **Profile structure and literal values are separate workflows.** Names and
    policy need `config:write`; values need `secrets:write` and are read with
    `secrets:read`; a structure change preserves values, and a new name has no
    value until a values operation sets it. Rows 3.1 to 3.3, 3.6, 3.7, 3.11.
33. **Once-only token delivery and atomic replacement.** `account.token_issue`
    replaces the active agent token atomically, ending the old token's contexts
    and background authority at once; the token is delivered once, a replay
    returns a receipt without it, and a lost response is repaired by issuing
    again. No expiry by default. Rows 11.8, 11.22.
34. **Idempotency keys are 1 to 128 restricted characters on every operation.**
    Knowledge accepts 200 and backups 256 today, so some existing keys no
    longer fit. Secret-bearing operations retain only ids and revisions; a replay
    never returns a secret. Rows 7.x, 9.x, 10.x, 3.x.
35. **Agents cannot own export schedules** under the six roles, because
    `knowledge:export` is human-only (owner decision `17802524`). Rows 10.1 to 10.4.
36. **Project bundle transfer stays a local operator command; worker
    registration moves online.** In better-auth a `maintainer` cannot export or
    import a whole project from the dashboard in this release, although the
    accepted target grants it; someone with access to the machine does it. A
    human `admin` registers workers from the dashboard or the CLI (fresh login).
    Owner decision `17802524`. Rows 7.38, 7.39, 12.7.
37. **Expanded human access by role.** Human maintainers hold Knowledge approval,
    export and import and project administration by role; `knowledge:import` is
    enforced for the first time (today no operation checks it,
    `project-transfer.ts:70`); attachment access follows the reader and operator roles. Rows 7.5, 7.38, 7.39, 7.30, 7.31.
38. **Agents lose configuration-write capability they held.** Structure writes
    need `config:write`, which only humans hold; an agent changes literal values
    only with the `secrets` role. Rows 3.1, 3.3, 3.7, 3.10.
39. **One test-environment policy across modes.** Presets whose environment
    profile is not `clean` are refused at enqueue on every surface and listed
    with `enqueueable: false`; today the agent path refuses them and the
    account path hides them (the installation and HTTP paths were not
    re-read). Rows 4.1, 4.2.
40. **Metadata refresh is a composition.** A refresh is worktree discovery plus
    preset discovery; the implicit storage freshness check and the full snapshot
    response are removed; scans are explicit (`storage.refresh`,
    `storage:manage`). Rows 2.3, 6.2, 13.2.
41. **Export schedules have enforced owners.** Account actors see and change only
    their own schedules; the export and attachment permissions are rechecked at
    every dispatch and publication; a disabled owner or a lost permission
    suspends the schedule with a reason; a restore invalidates background
    authority. Rows 10.1 to 10.4.
42. **Last-admin protection and lost-admin recovery.** The last active `admin`
    cannot be disabled or have its role revoked except by the operator; lost-admin
    recovery is operator account creation, enrollment and `admin_role.grant`, with
    no owner session. Rows 7.x, 11.2, 11.3, 11.7.
43. **Backup destinations on remote surfaces are configured ids.** Only the
    local operator names a path. Row 9.2.
44. **Hub import authenticates as the local offline operator.** It no longer
    reads an owner credential; there is no remote fallback. Row 7.41.
45. **Queue settings and capacity detail.** `test_queue.set` needs
    `settings:write` (any HTTP caller today); installation-wide capacity detail
    is `capacity.detail_read`. Rows 6.4, 6.7.
46. **Administrative inspection and stop.** Inspecting a run needs `tests:read`
    with command, log, holder and audit fields gated; stopping keeps queued
    cancellation, join, owned cleanup retry and safe none. Rows 4.10, 4.11.
47. **Only a human breaks a claim.** `claim.force_release` and
    `runtime.force_stop` are human-only and never on MCP, in every mode; in open
    and token mode the dashboard and the CLI keep them. An agent blocked by
    another session's claim waits for the claim to expire (owner decision
    `fb1567d5`). Rows 1.11, 1.15.
48. **A switch carries its claim.** When the holder switches a claimed server to
    another worktree, the claim moves with it; an unclaimed switch creates no
    claim. Row 1.12.

Most consequential, in order: 1 (no compatibility layer), 2 and 5 and 31
(claims protect but never start, and runtime control respects them), 3 (legacy
and owner machinery removed, grants reset), 4 (Vault flow removed), 32 and 33
(profile split and once-only tokens), and the two items that depend on the
owner, 35 and 36.

## 8. Permission coverage

Every permission of `src/shared/contracts/operations.ts`, with the target
operations that require it. `(c)` marks a collection or `any_project`
requirement, `(p)` a permission that is required only through a projection
tier, not by the requirement, and `(o)` an operation whose only surface is an
operator command, so that no account reaches the permission through it.

| Permission | Required by |
| --- | --- |
| `project:read` | `project.list` (c), `project.status`, `project.worktrees`, `project.wait`, `runtime.metrics` (c), `godot_web.status`, `capacity.read` (c, `any_project`), `test_queue.read` (c, `any_project`), `events.subscribe` (c, `any_project` for controller-wide events) |
| `project:manage` | `project.archive`, `project.restore`, `registration.attach`, `registration.detach`, `registration.move` (source and destination) |
| `logs:read` | `runtime_logs.read`, `test_run.logs`; error and log text in `test_run.admin_inspect` (p) |
| `storage:read` | `storage.read` |
| `storage:manage` | `storage.refresh`, `storage.cache_delete` |
| `config:read` | `config.read`, `profile.list`, `test_profile.list`; raw commands in `project.status` (p); command, arguments and cwd in `test_run.admin_inspect` (p) |
| `config:write` | `config.tls_set`, `config.environment_structure_set`, `profile.structure_save`, `profile.delete`, `preset.timeout_set`, `test_profile.structure_save`, `test_profile.delete`, `test_preset.assign_profile`, `godot_web.configure` |
| `profiles:select` | `profile.select` |
| `claims:manage` | `claim.acquire`, `claim.renew`, `claim.release`; holder identities in `project.list`, `project.status`, `capacity.read`, `test_run.admin_inspect` (p) |
| `runtime:control` | `runtime.start`, `runtime.restart`, `runtime.stop`, `runtime.switch`, `godot_web.rebuild` |
| `runtime:administer` | `claim.force_release`, `runtime.force_stop`, `test_run.admin_stop`; audit in `test_run.admin_inspect` (p) |
| `tests:run` | `test_run.enqueue`, `test_run.cancel`, `test_run.lookup_intent`, `remote_verification.submit`, `remote_verification.get`, `remote_verification.get_logs`, `remote_verification.cancel`; the stored submitter's `tests:run` at `worker.poll` (second evaluation) |
| `tests:read` | `test_preset.list`, `test_run.read`, `test_run.logs`, `test_run.wait`, `test_run.history_list`, `test_run.summary`, `test_run.metrics`, `test_run.compare`, `test_run.admin_inspect` |
| `knowledge:read` | `knowledge.memories`, `memory`, `search`, `task_context`, `check_context_export`, `threads`, `reply`, `thread`, `replies`, `tasks`, `task`, `relations`, `history`, `task_state`; as the second term of every Knowledge write, `approve_memory` and `export_context` |
| `knowledge:write` | `knowledge.create_memory`, `update_memory`, `archive_memory`, `restore_memory`, `supersede_memory`, `create_thread`, `create_reply`, `create_task`, `task_from_thread`, `update_task`, `update_task_state` |
| `knowledge:approve` | `knowledge.approve_memory` |
| `knowledge:export` | `knowledge.export_context`, `knowledge.project_export` (o), `user_backup.overview` (c), `user_backup.save`, `user_backup.status` (c), `user_backup.artifact` (agents cannot hold it: owner decision `17802524`) |
| `knowledge:import` | `knowledge.project_import` (o); one consumer |
| `attachments:read` | `knowledge.attachments`, `attachment_policy`, `attachment`, `check_attachment_batch`, `knowledge.project_export` (o), `user_backup.overview` (c), `user_backup.save`, `user_backup.status` (c), `user_backup.artifact` |
| `attachments:write` | `knowledge.check_attachment_batch`, `knowledge.create_attachment` |
| `secrets:read` | `vault.list`, `vault.read`, `config.environment_values_read`, `profile.values_read`, `test_profile.values_read` |
| `secrets:write` | `vault.import`, `vault.update`, `config.environment_values_set`, `profile.values_set`, `test_profile.values_set` |
| `roles:manage` | `role.grant`, `role.revoke`, `role.list`, `vault.audit` |
| `worker:execute` | `worker.poll` (the executor's evaluation, per item), `worker.report` |
| `accounts:manage` | `account.create`, `account.enroll`, `account.list`, `account.get`, `account.disable`, `account.recover`, `account.token_issue`, `account.token_revoke`, `admin_role.grant`, `admin_role.revoke` |
| `projects:create` | `project.create`, `directory.browse`; `project.create_from_import` (o) |
| `projects:remove` | **no operation**; dropped from the vocabulary (planned extension 9, OPEN-3) |
| `capacity:read` | `capacity.detail_read` |
| `capacity:write` | `capacity.set` |
| `settings:write` | `test_queue.set` |
| `backups:manage` | every `backup.*` and `user_export.recovery_*` operation |
| `workers:manage` | `worker.register`, `worker.recovery_inspect` (o), `worker.recovery_reconcile` (o) |
| `diagnostics:read` | `diagnostics.mcp` |
| `vault:recover` | `vault.recover_key` |

Permissions with no operation: `projects:remove`. Permission whose only
consumer is an operator-only surface in this release, so that no account reaches
it: `knowledge:import` (and `project.create_from_import` for `projects:create`),
accepted by the owner (`17802524`). `workers:manage` is reachable through
`worker.register`; its recovery operations are stopped-controller maintenance
and stay operator-only under OPEN-11.

Requirement forms that need a planned extension:

| Form | Operations |
| --- | --- |
| `claim_holder_if_claimed` | `runtime.start`, `runtime.restart`, `runtime.stop`, `runtime.switch`, and the 13 configuration mutations of section 3.5 |
| `any_project(P)` | `capacity.read`, `test_queue.read`, `events.subscribe` (controller-wide events) |
| `schedule_owner` | `user_backup.overview`, `save`, `status`, `artifact` |
| `request_submitter`, resource kind `remote_request` | `remote_verification.get`, `get_logs`, `cancel`, `worker.poll` |
| `intent_origin` | `test_run.lookup_intent` |
| Kind `query` | `project.worktrees`, `test_preset.list`, `test_run.lookup_intent`, `directory.browse`, `backup.preview` |
| Bounded one-event stream | `project.wait`, `test_run.wait` |
| Expected transition | `registration.move`, `registration.detach`, `claim.release`, `claim.force_release`, `runtime.switch`, `user_backup.save` |
| Secret-safe retention | the nine operations of section 4.3; token delivery for `account.token_issue` |
| Coordination sessions | `coordination.*`, `claim.acquire`, `claim.renew`, `claim.release`, `test_run.enqueue`, `test_run.cancel`, `worker.poll` (assignment creation), `worker.report` |

No general disjunction (`anyOf`) and no conditional requirement is needed:
OPEN-4 uses `any_project` and a separate detail operation; OPEN-7 and OPEN-13
use splits.

## 9. Open items

The first draft listed 24 open items. Each is now one of four things.

### 9.1 Decided

One line per former open item: the decision, who decided it, and the reply that
records it. **Owner** means a decision of the owner; **agent** means a decision
of the architect (Fable) inside the accepted target, reviewed by Astra
(`ce8aa214`) and corrected by `29cf8fa5` where noted. Where the page applies a
decision is in the sections it names.

| Item | Decision | Decided by | Record |
| --- | --- | --- | --- |
| OPEN-1 | Option (b): `runtime.start`, `restart`, `stop`, `switch` need `runtime:control` plus `claim_holder_if_claimed`; no claim required; when a claim exists only its holder may act, others need `claim.force_release`; absence rechecked under lifecycle coordination before each effect, including after the stop inside a restart; the same predicate covers every configuration mutation (3.4, 3.5, 4.1) | **owner** | `42019833`; recheck condition `ce8aa214`, adopted by `29cf8fa5` |
| OPEN-2 | `coordination.open`, `renew`, `close`; MCP transport opens and closes, browser per tab, CLI `session open` file; stored with expiry, survive restart, invalidated by rotation or generation change; a new session never adopts a claim (3.1). Implementation deferred (D1) | agent | `29cf8fa5` |
| OPEN-3 | No hard delete of a project; removal is `registration.detach` under `project:manage`; Knowledge is preserved, not archived; `projects:remove` dropped | agent | `e06943b7`, corrected by `29cf8fa5`; agreed in `ce8aa214` |
| OPEN-4 | `capacity.read` and `test_queue.read` need `any_project(project:read)`; holders filtered by `claims:manage`; `capacity.detail_read` (`capacity:read`) works on an empty installation | agent | `e06943b7`, corrected by `ce8aa214` F7 and `29cf8fa5` delta 4 |
| OPEN-5 | `request_submitter` for cancel; `worker.poll` evaluates the executor and, separately, the stored submitter's current grants | agent | `e06943b7`, corrected by `ce8aa214` F8 and `29cf8fa5` delta 6 |
| OPEN-6 | New resource kind `remote_request`, implemented before the family mounts | agent | `e06943b7`, `29cf8fa5` delta 6 |
| OPEN-7 | Structure and literal values are separate operations, reads and writes, for development and test profiles | agent | `e06943b7`, completed by `ce8aa214` required change 5 and `29cf8fa5` delta 8 |
| OPEN-8 | `directory.browse` (a query) needs `installation projects:create`; a maintainer without it types the TLS path | agent | `e06943b7`, `ce8aa214`, `29cf8fa5` delta 1 |
| OPEN-9 | `events.subscribe` is a registry stream with SSE as adapter; controller-wide events are aggregates under `any_project`; MCP keeps `project.wait` | agent | `e06943b7`, corrected by `29cf8fa5` |
| OPEN-10 | Raw host paths and Hub import stay local; Hub import uses local offline operator authentication with validation and provenance retained. Bundle transfer stays operator-only in this release (owner, `17802524`) | agent and owner | `e06943b7`, corrected by `29cf8fa5`; `ce8aa214` F6, F13 |
| OPEN-11 | Operations that need the exclusive controller lock (`backup.remote_rebind`, `worker.recovery_inspect`, `worker.recovery_reconcile`) stay offline operator commands. `worker.register` is an online operation for a human `admin` (owner, `17802524`) | agent and owner | `e06943b7`; `ce8aa214` F6; `29cf8fa5` |
| OPEN-12 | Durable owner, immutable job specification, current grants at dispatch, `schedule_owner`, no installation fallback; agents cannot own schedules (owner, `17802524`); local operator's schedule is owned by `operator` (`46672ea8`, `fb1567d5`) | agent (remainder: owner) | `e06943b7`, `ce8aa214` F3, F4, `29cf8fa5` delta 5 |
| OPEN-13 | Merged project DTO carries safe Knowledge metadata; two import operations: `knowledge.project_import` and `project.create_from_import` | agent | `e06943b7`, `ce8aa214` required change 8 |
| OPEN-14 | `test_preset.list` lists all presets with an advisory `enqueueable` flag; `tests:read` | agent | `e06943b7`; `ce8aa214` |
| OPEN-15 | `storage.refresh` needs `storage:manage`; `godot_web.rebuild` needs `runtime:control` | agent | `e06943b7`; `ce8aa214` |
| OPEN-16 | `settings:write` guards `test_queue.set`; `capacity:write` guards `capacity.set`; `capacity:read` is the detail tier | agent | `e06943b7`; `ce8aa214` |
| OPEN-17 | Password change, TOTP and passkey ceremonies stay specialized provider routes | agent | `e06943b7`; `ce8aa214` |
| OPEN-18 | `vault.list` needs `secrets:read`; configuration readers see names through `config.read`; `vault.read`, `vault.import`, `vault.update` follow `secrets:read` and `secrets:write`; `vault.audit` needs `roles:manage`; there is no `vault.write`; `vault.recover_key` preserves encryption | agent | `e06943b7`, corrected by `29cf8fa5` |
| OPEN-19 | Open and token mode answer `unavailable` (`accounts_not_enabled`); the first admin is created by the operator | agent | `e06943b7`; `ce8aa214` |
| OPEN-20 | Issuing a token replaces the active one atomically; account creation issues none; no expiry by default, optional expiry; token delivered once | agent | `e06943b7`, `29cf8fa5` delta 7 |
| OPEN-21 | A query requiring `tests:run` and the predicate `intent_origin`; implementation deferred (D2) | agent | `29cf8fa5`; `ce8aa214` |
| OPEN-22 | Inspect needs `tests:read` with holder identity under `claims:manage`; stopping, recovering another session's run and force stop need `runtime:administer`; queued cancellation, join, cleanup retry and safe none preserved | agent | `e06943b7`, `ce8aa214` F12, `29cf8fa5` |
| OPEN-23 | `backup.preview` is a query and persists nothing; `backup.restore` is a mutation whose commit point is the first durable write of the restore request; the handoff makes the last authorization and fence check; completion runs under the recorded specification. Adapter deferred (D3) | agent | `29cf8fa5`; `ce8aa214` |
| OPEN-24 | All role grants and revocations are human-only with a fresh login; a maintainer may grant and revoke the five project roles on its own project; the last active `admin` cannot be disabled or have its role revoked except by the operator; account and role reads are human-only without a fresh login | agent | `e06943b7`, corrected by `29cf8fa5` |

### 9.2 Owner questions A and B (decided)

Both answered by the owner (`17802524`), accepting the recommendations of
`29cf8fa5`. Both apply to better-auth mode only.

- **A.** Worker registration (`worker.register`, row 12.7) is an online
  operation for a human `admin` on the dashboard and the CLI, with
  `agents: false` and `freshLogin`. Project bundle transfer
  (`knowledge.project_export`, `knowledge.project_import`,
  `project.create_from_import`; rows 7.38, 7.39) stays a local operator command
  in this release, an accepted reduction of the maintainer capability of the
  accepted target.
- **B.** Agents cannot own export schedules (rows 10.1 to 10.4): no role an agent
  can hold includes `knowledge:export`, and the role table is not changed.

### 9.3 Deferred implementation

Designs are specified above; the code belongs to a later slice. The first pull
request of slice 4 carries the contract extensions of section 1.2.

| Id | Item | Belongs to |
| --- | --- | --- |
| D1 | Coordination sessions (OPEN-2): the session store, transport wiring, browser tab storage, CLI private file, expiry and restart behaviour, and what `coordination.close` does to the session's claims | the slice that builds the first consumer (claims) |
| D2 | Original-intent lookup (OPEN-21, task `6d680061`): `intent_origin`, digest versioning, the autofix adapter's authentication as the original principal | the test-runs slice |
| D3 | Restore admission and handoff adapter (OPEN-23): exact adapter, the specialized handoff's last check, post-shutdown completion authority | the backups slice |
| D4 | `vault.recover_key`: read the Vault code in slice 4; the operation preserves encryption and cannot expose plaintext or resurrect grants; what a failed or interrupted recovery leaves | the Vault slice |
| D5 | Exact field allowlists of every sensitive read (section 4.9 fixes categories) and the projector of `test_run.admin_inspect` | each family's pull request |
| D6 | Secret-safe store details: the source and rotation of the digest key, protected storage of receipts (section 4.3) | the first pull request of slice 4 |
| D7 | Removal of `projects:remove` from code, documentation and fixtures together | the first pull request of slice 4 |
| D8 | Source-reading residues from the matrix: the position inside `startRuntime` after readiness, which `restore-operations.ts` authorize calls run after awaits, the history, summary, metrics and comparison schemas, and the Hub import internals | the family pull request that touches them |

### 9.4 Decided after the revision

The revision found two places the four replies did not decide. Both were decided
afterwards; with owner questions A and B answered (section 9.2), no open item
remains.

- **NEW-OPEN-1, `runtime.switch` and a claim pinned to the old worktree.**
  Decided by the lead (`46672ea8`): when a claim exists only its holder switches,
  and the claim moves to the destination worktree atomically in the same effect,
  declared as an expected transition of the `claim` slot; with no claim the switch
  creates none. The owner added (`fb1567d5`): only a human breaks someone else's
  claim, through the dashboard or the CLI; an agent waits for the claim's expiry.
  Hence `claim.force_release` and `runtime.force_stop` are `agents: false` and
  excluded from MCP in every mode.
- **NEW-OPEN-2, owner of a schedule created by the local operator in
  better-auth.** Decided by the lead (`46672ea8`) and accepted by the owner
  (`fb1567d5`): the owner is `operator`; only full-authority actors can read,
  change or fetch it; no account sees it.

## 10. Proposed cut of slice 4

A proposal, not a decision. It reproduces the ordering of review `ce8aa214`.
Treat the catalogue as a draft inventory, not as a single implementation pull
request or a fixed final count. The aim is about 12 to 15 reviewable pull
requests, split by security boundary rather than equal row count.

1. Contract integration prerequisites: the reviewed deltas of section 1.2,
   admission interfaces for asynchronous work, expected-transition receipts and
   the secret-safe retention design. No production family yet.
2. Production adapters and bootstrap: credential verifier, active-grants
   snapshot, typed and versioned resolver, bounded synchronous idempotency store
   with restart repair, coordination-session lifecycle and the trusted TCP, unix,
   MCP and offline boundaries. Depends on slices 2 and 3; new RBAC and session
   state is fenced and quarantined from its first migration.
3. First vertical family: `session.describe` plus `project.list`,
   `project.status` and `project.worktrees`, through the shared HTTP adapter,
   unix, MCP and CLI. This proves zero-role visibility, per-item authorization,
   projections, asynchronous discovery and transport parity. Include a real
   retained Knowledge write as a small follow-on pull request to prove mutation
   and replay; read-only success is not enough to certify the adapter stack.
4. Knowledge content CRUD, then attachments and context exports in a separate
   pull request. Archive and restore stay under `project:manage`, and approval
   under fresh human authorization.
5. Account and token administration and project and admin role management, with
   bootstrap and lost-admin recovery and specialized provider integration. Split
   token delivery from role changes if review size warrants it.
6. Project create, archive, restore and registration attach, detach and move,
   including two-project authorization and expected-transition receipts.
7. Claims and the coordination-session consumers.
8. Runtime start, restart, stop, switch and force stop, including process
   ownership, capacity and multi-effect rechecks.
9. Configuration, profile and preset operations, with structure and value
   separation and reservation protection.
10. Local test enqueue, read, cancel, history and metrics plus the I1 lookup and
    proof; administrative stop and recovery may be a separate pull request.
11. Storage, capacity and settings, diagnostics, Godot and SSE. Split SSE and
    Godot if this exceeds one focused review; each has distinct background and
    release boundaries.
12. Vault read, write, audit and key recovery integration, including encrypted
    retention and registration mapping and AAD preservation.
13. User schedules and artifacts and Knowledge transfer, resolving the owner,
    role and surface decisions first (questions A and B).
14. Installation backups, restore, rebind and the recovery handoff.
15. Remote submitter operations and the worker protocol and recovery; split
    submitter versus executor integration if necessary, but verify their joint
    dispatch contract before acceptance.

Dependency notes.

- Ordering after the first vertical family can vary with dependencies. Do not
  migrate workers before durable requester and session and lifecycle semantics
  exist, or secret-bearing mutations before the receipt design exists.
- Family pull requests replace all relevant adapters and remove duplicate
  authority paths together, and stay unreleased until the breaking-release gates
  pass. Scope the unmounted guard deliberately during integration rather than
  deleting its protection globally. Minimal dashboard migration is still a
  release dependency in slice 5.
- Before the first family mounts, require real resolver, grants and verifier
  adapters and the complete transport boundary. Before the first retained write,
  require the store adapter. Before the first claim, cancel or report, require
  coordination sessions. Prefer landing these foundations before the first
  family rather than shipping fixture adapters or transport-local authorization.
- Future verification must exercise actor by mode by listener by role, hidden and
  missing resources, revocation during waits, effects, replay and streams, and
  ownership and cleanup. No such verification was run for this page.


## Appendix: matrix open questions

The matrix's own open questions (findings section 7), answered from source in
the first draft and kept as the record of what was read. Residues that matter
for implementation are carried as D8 in [section 9.3](#93-deferred-implementation).

| Question | Answer from source | Remaining |
| --- | --- | --- |
| 1 Callback positions in `operateClaimed` and `placeClaimed` | Answered. `operateClaimed` calls `authority()` first (`runtime-service.ts:41`) and a combined claim and authority `verify` (`:45`) before the stop (`:64`), at `:77`, `:85`, `:87`, passes it to `startRuntime` (`:101`) and calls `authority()` once more at the end (`:134`). `placeClaimed` runs `verify` at `:146`, `:159` and passes it to `startRuntime` (`:171`). HTTP `operateLocked` calls `actor.revalidate` at `:269` and `:285` and passes `verify` to the spawn at `:314`. | The position inside `startRuntime` after readiness was not read. |
| 2 Force release and `operate` against an agent claim | Answered. `releaseReservation(..., force)` removes any active claim without owner or kind checks (`sqlite-state-store.ts:1408-1415`). Non-force release of an agent claim by `local-user` throws (`:1414`). HTTP `operate` by `local-user` against another owner's claim fails with `claim_stale` through `authorizeReservation` (`:1359-1366`). | Nothing. |
| 3 Backup `authorize` and `uiActions` | Partly. `authorize` is `authentication.isCurrentInstallationActor` (`cli/index.ts:277`); `uiActions` is policy data, default empty, and requires `--backup-dir` (`policy.ts:12-14`). | Which `restore-operations.ts` authorize calls run after awaits. |
| 4 Enforcement of `knowledge:import` | Answered. No operation checks it; project import requires an owner session (`project-transfer.ts:70`); the permission appears only in role tables (`policy.ts:13`) and legacy grant seeding (`sqlite-state-store.ts:239`). | Hub import (`hub-import*`) was not read. |
| 5 Account-mode dashboard live updates | Not answered. `/api/events` is unreachable with a provider cookie; `use-dashboard.ts:382` polls diagnostics and metrics every 5 s, which does not show how runtime state arrives. | Not answered from source; no longer blocks anything, because `events.subscribe` is decided as a registry stream (OPEN-9). |
| 6 Redaction of `statusQueries.logs` | Answered. None: `logTail` returns raw lines (`process-manager.ts:151-155`) and the executable and arguments are written into the log (`:180`); `status-service.ts:166-180` only bounds size. | Nothing. |
| 7 `UserSchedules` `authorize` and `canRead` | Answered for `authorize` (`cli/index.ts:319-331`): current identity, no provider session, post-restore credential age, and `knowledge:read` plus `knowledge:export` per project. | `canRead` was not traced; ownership is now specified by `schedule_owner` (section 4.4). |
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
