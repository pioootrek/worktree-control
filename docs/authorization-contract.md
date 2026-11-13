---
audience: "owner, implementers and reviewers of the authentication and authorization unification"
last_reviewed: "2026-11-13"
source_of_truth: "implemented, unmounted authorization contract for the unreleased breaking auth unification; Knowledge task 040062b4"
status: "active"
---

# Authorization contract

**Status: contract for an unreleased breaking change. The code exists but is
unmounted.** No HTTP route, MCP tool, CLI command, policy function, schema or
migration uses it. `unmounted.test.ts` fails if any file outside the module
imports it or its contract file. Current behaviour is described in
[authentication](authentication.md) and
[identity and authorization plan](identity-authorization-plan.md) until the
release that mounts this contract.

Evidence: Knowledge task `040062b4`, discussion `8a2683b8`. The owner-accepted
target is in replies `5583b882` and `1367c632`. Proposal v0 is `efa8c8e5`, the
independent review with eleven required changes is `575a4fe8`, and contract v1
(binding) is `032aa386`. The review of the first implementation and the
parent decisions A to L are in reply `ad5ac74a`.

Code: `src/shared/contracts/operations.ts` (browser-safe vocabulary) and
`src/server/modules/operations/` (public API in `index.ts`).

This page states what the code enforces. Everything else is listed under
[Not implemented](#not-implemented).

## Actors and authentication

There are four actor kinds: `installation`, `operator`, `human` and `agent`.
`installation` and `operator` hold full authority. A remote worker is the
installation in open and token mode, or an agent holding `executor` in
better-auth mode.

Only a listener boundary (`createListenerBoundary`) or an offline invocation
holding the exclusive lock (`mintOfflineContext`) can mint an
`AuthenticationContext`. Each minted context is registered in a registry
private to the module. The runner obtains authority only through that
registry. It never calls the `revalidate` method of the object it was given.
An object of the same shape, a copy, an object inheriting from a minted context
or a proxy of one is `unauthenticated` with reason `unrecognized_context`.
Test fixtures mint through the same boundaries. The context is frozen and its
`toJSON` throws, so the strict release serializer rejects it.

At mint, the boundary copies and deep-freezes the credential identity, actor,
provider evidence and coordination session returned by the
`CredentialVerifier`. This copy is the baseline. Each revalidation copies the
verifier's current answer again, compares it with the baseline and returns a
new, deeply frozen `CurrentAuthority`. Mutating a returned authority, or the
objects a verifier returned or keeps, cannot change the baseline. Revalidation
fails with `unauthenticated` when the listener has closed, the credential is
revoked or rotated, the actor differs or the coordination session changed. It
never falls back to another credential and never substitutes another actor.

`acceptanceTable` lists every accepted mode × listener × credential
combination. `resolveAcceptance` rejects everything else:

| Mode | `api` | `mcp` | `worker` | `unix` | `offline` |
| --- | --- | --- | --- | --- | --- |
| `open` | no credential → installation | no credential → installation | no credential → installation | no credential → operator | lock held → operator |
| `token` | installation token | installation token | installation token | no credential → operator | lock held → operator |
| `better-auth` | provider session → human; agent token → agent | agent token | agent token | no credential → operator | lock held → operator |

These are always rejected: mixed credentials, legacy owner and worker tokens,
legacy pairing secrets, an installation token in better-auth mode, any
credential in open mode, any credential on `unix` or `offline`, and browser
headers on `unix`. The former `legacy` mode is not a contract mode. Pre-login,
MFA ceremonies, public status and static assets are not operations and are
never registered, so they produce no actor. Nothing in this slice routes them.

## Permissions and roles

The permission list is closed. Project permissions: `project:read`,
`project:manage`, `logs:read`, `storage:read`, `storage:manage`, `config:read`,
`config:write`, `profiles:select`, `claims:manage`, `runtime:control`,
`runtime:administer`, `tests:run`, `tests:read`, `knowledge:read`,
`knowledge:write`, `knowledge:approve`, `knowledge:export`, `knowledge:import`,
`attachments:read`, `attachments:write`, `secrets:read`, `secrets:write`,
`roles:manage` and `worker:execute`. Installation permissions:
`accounts:manage`, `projects:create`, `projects:remove`, `capacity:read`,
`capacity:write`, `settings:write`, `backups:manage`, `workers:manage`,
`diagnostics:read` and `vault:recover`.

| Role | Scope | Recipient | Permissions |
| --- | --- | --- | --- |
| `reader` | project | any | `project:read`, `logs:read`, `storage:read`, `config:read`, `tests:read`, `knowledge:read`, `attachments:read` |
| `operator` | project | any | reader plus `claims:manage`, `runtime:control`, `tests:run`, `profiles:select`, `knowledge:write`, `attachments:write` |
| `maintainer` | project | human | operator plus `config:write`, `storage:manage`, `roles:manage`, `knowledge:approve`, `knowledge:export`, `knowledge:import`, `project:manage`, `runtime:administer` |
| `secrets` | project | any | `secrets:read`, `secrets:write` |
| `executor` | project | agent | `worker:execute` |
| `admin` | installation | human | maintainer on every project plus every installation permission; never `secrets` |

`grantAllowed` validates role, recipient kind and scope when a role is granted.
`effectivePermissions` validates them again for every stored grant, using the
account kind stored on the server. A project grant never yields an
installation permission.

Grants do not expire; revocation is removal. The `GrantsSnapshot` port
contains active grants only. Returning nothing else is the snapshot adapter's
obligation, to be tested with that adapter in slice 3. Stored grants have no
expiry field, and the module never filters grants by time.

## Requirements and decisions

An operation declares an `OperationRequirement`. Its `require` field takes one
of these forms:

- `authenticated`, with no permission;
- a project permission on a named resource;
- an installation permission;
- `allOf`, a conjunction over one or several resources;
- `collection`, filtered per item at release (several are allowed; an item
  needs all of them);
- a named predicate: `claim_holder`, `run_originating_session` or
  `worker_assignment`.

The `agents: false` and `freshLogin` flags complete the requirement.

`decide` is pure and runs in this order:

1. **Masking.** Every slot the requirement names must be resolved, and every
   resource the operation references must be visible to the caller. Otherwise
   the decision is `not_found` with reason `resource_not_found`. The answer is
   the same for a missing and an invisible resource. It does not depend on the
   flags or on the order of conjunction branches.
2. The human-only flag: `forbidden`/`human_only` for an agent.
3. The requirement: `forbidden`/`permission_denied`, or a predicate's own
   denial. Predicates are evaluated only on visible resources.
4. Fresh login: `login_stale`/`fresh_login_required`, or
   `forbidden`/`fresh_login_unavailable` for an agent.

A resource is visible with `project:read` on its project or with full
authority. Full authority passes permissions, the human-only flag and fresh
login. It is still subject to resource resolution and to the predicates that
protect foreign claims, runs and assignments.

Fresh login holds when `0 <= now - authenticatedAt < 600000`. The value comes
only from current provider evidence; missing or malformed evidence is stale.

The `ResourceResolver` port maps registrations, claims, test runs, profiles,
Vault entries, Knowledge records and worker attempts each to exactly one
project or to not-found. It never searches another namespace. `resolveAll`
returns deep, frozen copies and treats a malformed or mismatched answer as
not-found. Each resolution carries a version. The version changes whenever the
mapping or relation changes and is never reused for the same reference,
including after delete and recreate. That is an obligation of every resolver
adapter.

## Operations and the runner

An operation is `Operation<Input, InternalResult, PublicResult>`. It is either
a `read` or a `mutation`. `StreamOperation` covers streams. The
`OperationRegistry` rejects duplicate and malformed IDs. The only real
operation is `session.describe`, which is registered on no transport.

`OperationRunner` runs a mutation as these admitted phases, built on
`src/server/database-admission.ts`:

1. Revalidate, resolve and decide. With an idempotency key, record the
   reservation or answer from an existing one (see
   [Idempotency](#idempotency)).
2. Run the optional SQL-free wait, such as a lock, outside admission. The
   runner owns the lease from the moment `acquire` resolves, inside the wait.
   It releases the lease exactly once on every path, including a refused
   re-admission after the wait.
3. Revalidate, re-resolve and decide again. Refuse a changed resource mapping
   (`conflict`/`resource_changed`). Mark the reservation as started, then start
   exactly one effect.
4. Complete under reserved admission, without an authority check: finalize,
   then write the idempotency record.
5. Revalidate, re-resolve and decide, then release through the projector.

Finalization, audit and owned cleanup of an effect that began complete even
after revocation. The result is then withheld.

Streams open after an admitted decision. Each event is awaited outside
admission, then authorized, re-resolved and projected in its own admitted
phase. A denial, or a failure of construction, `next()` or projection, ends the
stream with one sanitized error item and disposes the source. Aborting the
signal, or the consumer's `return()`, settles a pending read at once, ends the
stream and disposes the source exactly once. No event is projected or yielded
after an abort or a denial. Disposal is awaited for at most `disposeTimeoutMs`
(1 s by default), so a source that never settles cannot hang the consumer. A
disposal failure is swallowed and never replaces or follows a denial.

## Idempotency

A mutation accepts an idempotency key only when it declares `retain` and the
runtime has an `IdempotencyStore`. A key on any other operation is
`invalid_request`/`idempotency_not_supported`. Without a store it is
`unavailable`/`idempotency_unavailable`. Reads and streams never take a key.

The store holds one record per operation ID, principal and key. The principal
is never caller-supplied:

- human or agent: `account:<accountId>`. Accounts never share keys, so one
  account cannot replay another account's result;
- every installation caller: `installation`. Every operator, on the unix
  socket or offline: `operator`. All callers of these actors share the actor
  and hold full authority over the same data. The same key from two such
  callers is deduplicated, or is a fingerprint conflict, instead of running
  twice.

The first admission phase writes a `reserved` record with the fingerprint of
the parsed input and the resolved resources. It does this in the same
synchronous admitted phase as the read, so concurrent requests cannot both
reserve. The record becomes `started` in the phase that admits the effect. It
becomes `completed` with the internal result, or `unknown`, in the completion
phase.

A later request with the same key gets:

| Existing record | Answer |
| --- | --- |
| different fingerprint | `conflict`/`idempotency_conflict` |
| `reserved` or `started` | `conflict`/`request_in_progress` |
| `unknown` (unknown effect or unconfirmed cleanup) | `outcome_unknown`/`previous_attempt_outcome_unknown` |
| `completed` | replay, as below |
| none | a fresh run |

An attempt that fails before its effect began releases its own reservation, so
a retry runs fresh. If that release cannot be admitted, the reservation stays
and later requests see `request_in_progress`.

A replay is a release of historical data. It requires a fresh decision on the
current authority and current resolution. It is then decided again against
the resources stored with the result. If the original project is no longer
visible to the caller, the answer is `not_found`. If the current resolution
differs from the stored one (moved, deleted and recreated, or changed
relation), the answer is `conflict`/`resource_changed`. Only then is the
stored result projected and released.

Adapter obligations, not implemented in this slice: store copies, bound
retention, and after a controller restart delete `reserved` records and turn
`started` records into `unknown`. Retained internal results must be
structured-cloneable plain data.

## Release and errors

Every release point serializes before it checks. This covers success, replay,
each stream event and each error. The serializer accepts only plain objects
(prototype `Object.prototype` or `null`), dense arrays, strings, finite
numbers, booleans and `null`. It rejects `toJSON` (own or inherited,
enumerable or not), accessors, non-enumerable and symbol keys, `__proto__`
keys, functions, symbols, `undefined`, bigints, proxies, other prototypes,
cycles and nesting deeper than 32. Each property is read once. The allowlist
of top-level public keys is then checked on the serialized value, so nothing
can change between the check and the release. Errors are released in the
closed five-field shape. A malformed error becomes a generic `internal` error
that keeps a known effect state.

In collections, `ReleaseContext.filter` and `page` keep an item only when its
project is visible and grants the requested permission and every collection
permission of the requirement. Filtering happens before pagination. The cursor
encodes only the key of the last released item, and no total count is
returned.

Error categories and statuses:

| Category | Status | Category | Status |
| --- | --- | --- | --- |
| `unauthenticated` | 401 | `rate_limited` | 429 |
| `forbidden` | 403 | `busy` | 503 |
| `login_stale` | 403 | `unavailable` | 503 |
| `not_found` | 404 | `internal` | 500 |
| `invalid_request` | 400 | `payload_too_large` | 413 |
| `conflict` | 409 | `gone` | 410 |
| `claim_held` | 409 | `outcome_unknown` | 409 |

Every error carries a machine-readable reason and a retry disposition:
`retry`, `reauthenticate`, `inspect_first` or `none`. It also carries the
effect state: `not_started`, `committed`, `unknown`, `cleanup_unconfirmed`, or
`null` for reads and streams.

The effect state the runner observed always wins (`classify`, `publicError`):

- An effect that was invoked and threw has an unknown outcome. The error is
  `outcome_unknown` whatever was thrown, and the thrown reason is kept. An
  effect that must report a refusal as `not_started` has to refuse in its
  requirement or in `acquire`, before the effect.
- `busy` and a `retry` disposition are impossible once an effect began. A
  `busy` after a committed effect becomes `unavailable`.
- A typed error's own effect is used only when the runner observed none
  (`null` or `not_started`).
- An admission refused because the caller aborted is
  `unavailable`/`request_cancelled` with `retry`.
- Unexpected faults are released as `internal`/`unexpected_failure`, or as
  `outcome_unknown` for an unknown effect, without details.

## Accepted deviations

The independent review in `ad5ac74a` assessed these choices of the first
implementation.

| Deviation | Status |
| --- | --- |
| Any credential in open mode is rejected | Accepted: stricter and safe. |
| Worker assignment binds session and account | Accepted: stricter and safe; provisional until the worker protocol is migrated. |
| `conflict`/`resource_changed` when a resolution changes between phases | Accepted: stricter and safe. |
| A changed coordination session is `unauthenticated` | Accepted: stricter and safe. |
| `outcome_unknown` uses status 409 | Accepted with this note: generic clients must not retry it as a 503. |
| Visibility requires `project:read` | Accepted with this note. With masking first, an agent holding only `executor` cannot see the project and gets `not_found`; a worker account also needs `reader` there. This needs a parent decision before the worker protocol is migrated. |
| `worker_attempt` resource kind | Accepted with this note. |
| Cancellation before the effect | Accepted with this note: `unavailable`/`request_cancelled`, `retry`, effect `not_started`. |
| Failed finalization is `cleanup_unconfirmed` | Accepted with this note. |
| An agent on a fresh-login requirement is `forbidden` | Correct. |
| Agent tokens on the better-auth TCP API | Correct. |
| Run-origin comparison as a replacement for the I1 original-intent lookup | Wrong as stated; see below. |
| Retention rule as a complete idempotency contract | Wrong as stated; replaced by [Idempotency](#idempotency). |

The `run_originating_session` predicate only compares the caller's
coordination session with the run's recorded origin session and credential.
It is the rule for ordinary cancel from the originating session. It is **not**
the I1 original-intent lookup. That lookup uses the saved origin-session
digest with an explicit digest version from task `6d680061`, and this module
does not implement it.

## Not implemented

- Server-issued coordination sessions: issuance, lease secret, renewal,
  expiry, generation changes, disconnect and restart semantics. The module
  only compares a `CoordinationSessionRef` that a verifier returns.
- The I1 original-intent lookup and its origin-session digest version.
- Background authorization specifications and owner references for queued
  or scheduled work.
- Store adapters: the grants snapshot, resolver, credential verifier and
  idempotency store exist only as ports and in-memory test doubles.
- The disposition of the 204 current operations.
- Admin without `secrets` and reader with `logs:read` do not guarantee
  non-disclosure of secrets that an application prints into its logs.
