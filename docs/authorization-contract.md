---
audience: "owner, implementers and reviewers of the authentication and authorization unification"
last_reviewed: "2026-11-13"
source_of_truth: "implemented, unmounted authorization contract for the unreleased breaking auth unification; Knowledge task 040062b4"
status: "active"
---

# Authorization contract

**Status: contract for an unreleased breaking change. The code exists but is
unmounted.** No HTTP route, MCP tool, CLI command, policy function, schema or
migration uses it. `unmounted.test.ts` fails if a file of a fixed inventory
imports it or its contract file (see [Unmounted guard](#unmounted-guard)). Current behaviour is described in
[authentication](authentication.md) and
[identity and authorization plan](identity-authorization-plan.md) until the
release that mounts this contract.

Evidence: Knowledge task `040062b4`, discussion `8a2683b8`. The owner-accepted
target is in replies `5583b882` and `1367c632`. Proposal v0 is `efa8c8e5`, the
independent review with eleven required changes is `575a4fe8`, and contract v1
(binding) is `032aa386`. The review of the first implementation and the
parent decisions A to L are in reply `ad5ac74a`. Decisions M and N are in
`9d5ae2f7`; the second review, decisions O to V and the acceptance rule are in
`6b95f3db`; the third review and decisions W and X are in `9403b43c`; the
fourth review and decisions Y and Z are in `e33c6ace`. The contract
extensions of slice 4 (described under
[Contract extensions of slice 4](#contract-extensions-of-slice-4)) implement
the planned deltas of `29cf8fa5`, which answer review `ce8aa214` (F1, F2, F3,
F7, F8, F10). Owner decisions `42019833` (a claim is protection, not
permission) and `fb1567d5` (only a human breaks a claim, never on MCP) and
lead decision `46672ea8` apply.

Code: `src/shared/contracts/operations.ts` (browser-safe vocabulary) and
`src/server/modules/operations/` (public API in `index.ts`).

This page states what the code enforces, including the
[contract extensions of slice 4](#contract-extensions-of-slice-4). Everything else is listed under
[Obligations of later slices](#obligations-of-later-slices) and
[Not implemented](#not-implemented).

## Threat model

Decision O bounds what this module defends against:

- **Untrusted:** everything that arrives through a transport. That includes
  inputs, credentials, headers, idempotency keys and resource references.
- **Trusted but fallible:** code inside the process. That includes operation
  definitions, adapters (verifier, grants snapshot, resolver, idempotency
  store, admission) and effect handlers.

For trusted code, the module makes accidental corruption of authority
impossible. Decisions, relations, requirements and the exported vocabularies
are frozen and never shared between decisions. A permission set is frozen and
belongs to one admitted phase: a replay's historical decision reuses the set
of the phase that admitted it (decision Y). Resource slot names are restricted, so no reserved property name can reach a prototype.
A value that trusted code throws or returns malformed never escapes
unsanitized. The runner always calls the release of a lease it owns, gives
back the reservation of an attempt that never crossed its commit point, and
disposes a stream source it opened. Two cases can still leave something held,
and both are reported rather than hidden:

- A lease or stream source whose release or disposal fails may stay held. A
  failure means it throws, rejects, times out, or returns a promise where a
  synchronous answer is required. The runner calls it once and does not
  retry. After an effect that began, the caller gets `cleanup_unconfirmed`. A
  failed disposal goes to the disposal observer. A failed lease release before
  any effect began is not reported.
- A reservation whose own removal fails stays `reserved`. A record whose
  final write and its repair both fail stays `started`, and later requests
  see `request_in_progress` until the store adapter clears it. If a
  `completed` write landed before the store reported its failure, the record
  stays `completed` (see [Idempotency](#idempotency) and
  [Obligations of later slices](#obligations-of-later-slices)).

The module does not try to resist deliberately hostile in-process code beyond
that.

### Synchronous callbacks

Decision W. A callback whose contract is synchronous is checked at run time,
because an `async` function satisfies a `void` return type. If it returns a
promise or another thenable, whether that would reject or fulfil, the runner
marks its rejection as handled and treats the call as failed. It never counts
such a step as done. Asynchronous work belongs in the effect, not in these
callbacks. The checked call sites and their answers:

| Call | A thenable means |
| --- | --- |
| `finalize`, `Lease.release` | a failed step: the record is `unknown`, the caller gets `cleanup_unconfirmed`, a retry gets `outcome_unknown` |
| `IdempotencyStore` `get`, `put`, `release` | a failed store call, handled as if it had thrown (see [Idempotency](#idempotency)) |
| `parse`, `resources`, `project`, `projectEvent` | `internal` with reason `parse_not_synchronous`, `resources_not_synchronous` or `projection_not_synchronous` |
| an `admitted` effect, `read` | as described under [Operations and the runner](#operations-and-the-runner) |
| `open` of a stream, or an iterator that is itself a thenable | `internal`/`invalid_stream` |
| `OperationRuntime.now`, `OperationRuntime.grants`, `GrantsSnapshot` methods | `internal` with reason `runtime_not_synchronous` or `grants_not_synchronous` |
| `ResourceResolver.resolve` | a failed lookup (see [Requirements and decisions](#requirements-and-decisions)) |
| `ResourceResolver.listProjects` in `session.describe` and for `any_project` | `internal`/`resolver_not_synchronous` |
| `plan` of a query, `timeoutMs` of a wait, `receipt` of a secret-bearing operation | `internal` with reason `plan_not_synchronous` or `wait_not_synchronous`; a receipt is a failed completion step (`cleanup_unconfirmed`) |
| `CredentialVerifier` `verify`, `current` | no credential: `unauthenticated` |
| a listener's `open()`, the offline `lockHeld()` | closed: only a synchronous `true` keeps a listener open or the lock held |
| `OperationObserver.streamDisposalFailed` | ignored, as any observer result |

The iterator methods `next()` and `return()` are asynchronous by contract and
are handled under [Streams](#streams).

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
`accounts:manage`, `projects:create`, `capacity:read`, `capacity:write`,
`settings:write`, `backups:manage`, `workers:manage`, `diagnostics:read` and
`vault:recover`. `projects:remove` was dropped (`29cf8fa5` delta 9, OPEN-3):
there is no hard delete of a project, and a requirement naming it is rejected
at registration.

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
installation permission. Every call returns new frozen values. A permission
set is an immutable set with no mutating methods, and `project()` returns a new
one on each call. The exported permission, role, error, retry and effect lists
are frozen.

**Visibility (decision M).** A project is visible to an account that holds at
least one valid, active role on it (any of the five project roles), to an
account holding `admin`, and to full authority. A grant that fails
re-validation gives no visibility. Visibility grants no permission:
permission checks are independent. An agent holding only `executor` sees the
project, may execute assignments there, and gets `forbidden` when it tries to
read. An account holding only `secrets` sees the project and holds only
`secrets:read` and `secrets:write` there.

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
- `any_project(permission)`, for aggregates (see
  [Aggregates](#aggregates));
- `same_project(slots)`: every named slot resolves to one and the same
  project;
- a named predicate: `claim_holder`, `run_originating_session`,
  `worker_assignment`, `claim_holder_if_claimed`, `schedule_owner`,
  `request_submitter` or `intent_origin`.

The `agents: false` and `freshLogin` flags complete the requirement.

`decide` computes the effective permissions from a grants snapshot and then
runs `decideWith`. `decideWith` takes permissions computed beforehand, calls no
adapter and runs in this order:

1. **Masking.** Every slot the requirement names must be resolved, and every
   resource the operation references must be visible to the caller. This
   step only sees resources that `resolveAll` returned. The answer is
   independent of the references' order and of hidden resources because
   `resolveAll` first applies the three passes of decision X, described
   below. Masking
   iterates every own slot of the resources record. A malformed record (a
   prototype other than `Object.prototype` or `null`, a symbol key, an invalid
   slot name) fails closed. Otherwise the decision is `not_found` with reason
   `resource_not_found`. The answer is the same for a missing and an invisible
   resource. It does not depend on the flags or on the order of conjunction
   branches. Ownership masking follows: a schedule of another owner
   (`schedule_owner`), an intent of another principal or credential
   (`intent_origin`) and slots bound by `same_project` that resolve to
   different projects are `not_found` too, decided before every other part of
   the requirement.
2. The human-only flag: `forbidden`/`human_only` for an agent.
3. The requirement: `forbidden`/`permission_denied`, or a predicate's own
   denial. Predicates are evaluated only on visible resources.
4. Fresh login: `login_stale`/`fresh_login_required`, or
   `forbidden`/`fresh_login_unavailable` for an agent.

Visibility follows decision M above. Every decision is a new frozen value.
Full authority passes permissions, `any_project`, the human-only flag and
fresh login, and manages every schedule. It is still subject to resource
resolution and to the predicates that protect foreign claims (including
`claim_holder_if_claimed`), runs, assignments, submitted requests and
intents.

Fresh login holds when `0 <= now - authenticatedAt < 600000`. The value comes
only from current provider evidence; missing or malformed evidence is stale.

The `ResourceResolver` port maps registrations, claims, test runs, profiles,
Vault entries, Knowledge records, worker attempts, project claim slots
(`project_claim`), schedules, remote requests (`remote_request`) and saved
test-run intents (`test_intent`) each to exactly one project or to not-found. It never searches another namespace. `resolveAll`
returns a frozen record with a `null` prototype that holds deep, frozen copies.
It treats a malformed or mismatched answer as not-found.

Decision X. `resolveAll` handles the references in three passes, so that no
answer depends on the order of the references or on whether a resource the
caller cannot see exists:

1. **Syntax.** Every reference is checked before any lookup. Any malformed
   reference is `invalid_request`, whatever exists. With several malformed
   references, the reason is the first of `invalid_resource_reference`,
   `unknown_resource_kind` and `invalid_resource_id` that any of them has.
2. **Lookup.** The resolver is called for every reference, without stopping
   at a miss or a failure.
3. **One answer.** A failed lookup wins over a miss: the resolver threw, or
   returned a thenable (`internal`/`resolver_not_synchronous`). The failure of
   the first failing slot in code-unit order is released after sanitization,
   whatever the other references are. Otherwise any missing reference is
   `not_found`/`resource_not_found`. Every resolved resource then goes
   through masking in `decideWith`, which gives the same `not_found` for an
   invisible one.

Decision Y. In every admitted phase that decides, the runner first does
everything that can fail independently of the referenced resources:
authority revalidation and the listener exclusion, the clock
(`OperationRuntime.now`), the grants snapshot (`OperationRuntime.grants`), the
effective permissions, which make every `GrantsSnapshot` call, and, only for a
requirement with an `any_project` part, the current project list
(`ResourceResolver.listProjects`). Only then does `resolveAll` run its three
passes.
A fault before resolution therefore gives the same answer whatever exists, and
the resolver is not called. After resolution only `decideWith` runs before the
answer. It reads the frozen authority, the frozen requirement, the frozen
resolution copies and the closures of the permission set, so a denial is one
of its own answers. Anything after an allowed decision runs only when every
referenced resource exists and is visible. A malformed reference is therefore
`invalid_request` only when every earlier step succeeded.

With that order, a missing and an existing invisible resource get the same
category, status, reason, retry and effect, provided the resolver itself
answers a missing reference with `null`. A resolver whose own failure depends
on whether the failing reference exists can still reveal that. Resolvers
return `null` for a missing reference and throw only on a fault.

Every decision point resolves through this path: admission, the recheck
before an effect and before an idle commit point, `recheck()` inside an idle
effect, the release, a replay, a stream open, each stream event and both
admitted phases of a query. A replay is decided after its phase's
admission allowed the current resolution, reusing that phase's permissions.
`session.describe` references no resource; it lists projects only after an
allowed decision.

Resource slot names must match `^[A-Za-z][A-Za-z0-9_]{0,63}$` (decision Q).
`OperationRegistry.register` checks the slot names of the requirement.
`resolveAll` checks every key of `resources(input)` and rejects a non-plain
record, such as one where a `__proto__` literal became the prototype, with
`internal`/`invalid_resource_slot`. `sameResolution` compares every own slot of
both records. Each resolution carries a version. The version changes whenever the
mapping or relation changes and is never reused for the same reference,
including after delete and recreate. That is an obligation of every resolver
adapter.

## Operations and the runner

An operation is `Operation<Input, InternalResult, PublicResult>`. It is a
`read`, a `query` or a `mutation`. `StreamOperation` covers streams, including
bounded one-event waits. There is no `wait` kind. The
`OperationRegistry` rejects duplicate and malformed IDs. It also rejects
requirements with unknown permissions, predicates or slot names, empty
conjunctions, invalid public keys, malformed effects, transition lists,
secret hooks, wait bounds and listener exclusions. It registers a frozen copy
whose requirement, allowlist, effect, transition list, wait bounds and
exclusions are frozen. The only real operation is `session.describe`, which is
frozen and registered on no transport. Every other operation in the tests is a
fixture.

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
   (`conflict`/`resource_changed`) and an aborted request. Then run exactly one
   effect with its commit point (see [Commit point](#commit-point)).
4. Complete an effect that began under reserved admission, without an
   authority check, in this order (decision R): finalize, release the lease,
   then write the idempotency record. A step counts as done only when its
   synchronous callback returned normally (decision W). A finalization or
   lease release that throws or returns a promise or other thenable writes
   `unknown`, never `completed`. The caller gets `cleanup_unconfirmed`, and a
   retry gets `outcome_unknown`. A record write that throws or returns a
   thenable is repaired at once in the same admitted callback (decision Z):
   the callback writes `unknown` before it returns, even when the failed write
   was a `completed` one that landed.
5. Revalidate, re-resolve and decide, then release through the projector.

Finalization, audit and owned cleanup of an effect that began complete even
after revocation. The result is then withheld.

A synchronous (`admitted`) effect that returns a promise or thenable is a
programming error. Its continuation may still act, so the runner marks the
rejection as handled and reports `outcome_unknown` with reason
`admitted_effect_not_synchronous`, whatever the commit point. A read that
returns a promise is `internal`/`read_not_synchronous`. Neither leaves an
unhandled rejection.

### Commit point

Decision N. The operation definition fixes the commit point through
`effect.commitPoint`. The runner never infers it from what the handler does.

- `"entry"` (or absent): the handler is past its commit point when it is
  invoked. The record becomes `started` in the admitted phase that invokes it.
  Anything the handler throws is `outcome_unknown`, keeping the thrown
  reason.
- `"declared"`: only such a handler gets a `commit()` on its scope. Before it
  calls `commit()`, a typed error keeps its category and reason with effect
  `not_started`, an untyped error is `internal`/`unexpected_failure` with
  `not_started`, and the reservation is released. `commit()` is the only way to
  cross the point. It marks the record `started` and the effect state
  `unknown`. From then on, anything thrown is `outcome_unknown` unless the
  handler settled.
  - For an `admitted` effect, `commit()` is synchronous and runs in the same
    admitted phase as the effect's final decision.
  - For an `idle` effect, `commit()` always re-enters admission and takes a
    fresh decision: revalidated authority, current grants, unchanged
    resolution, request not aborted. Only then does it cross. On a denial it
    rejects with that denial, and the handler cannot cross.
  - A handler that settles without having crossed, including one that
    swallowed a refused `commit()`, is reported as `outcome_unknown` with
    reason `commit_point_not_declared`. A `commit()` after the handler settled
    rejects with `internal`/`effect_scope_closed`.

A malformed `commitPoint` is rejected at registration, and at run time before
anything happens, as `internal`/`invalid_operation`.

Every effect scope also has `transition(slot, result)` (see
[Expected transitions](#expected-transitions)), and the scope of an `idle`
effect has `recheck()` (see
[Claims and multi-step effects](#claims-and-multi-step-effects)).

### Streams

Streams open after an admitted decision. Each event is awaited outside
admission, then authorized, re-resolved and projected in its own admitted
phase. Decision T:

- A failure of construction or of `next()`, a malformed iterator result (not an
  object, a throwing `done` or `value`, a non-boolean `done`) and a projection
  or serialization failure are source failures. The source is disposed once,
  and the stream ends with one sanitized error item.
- A denial ends the stream with one error item and disposes the source.
- Abort of the request signal or the consumer's `return()` settles a pending
  read at once, ends the stream with `done` and disposes the source exactly
  once. `return()` always resolves `{ done: true }`. A read that settles or
  rejects later is ignored and never becomes an unhandled rejection.
- No event is projected or yielded after an abort, a `return()` or a denial.
- A source that finishes by itself is not disposed.
- A source created before a failure in the opening phase is disposed too.
- Disposal is awaited for at most `disposeTimeoutMs` (1 s by default).
  Every disposal failure or timeout is reported to
  `OperationRuntime.observer.streamDisposalFailed` with the operation ID and
  the kind, never the thrown value. A throwing observer changes nothing. A
  disposal failure never replaces or follows a denial and adds nothing after
  the consumer ended the stream. In every other case the stream already ends
  with its one error item.
- The runner provides no `throw()`.

## Idempotency

A mutation accepts an idempotency key only when it declares `retain`, the
runtime has an `IdempotencyStore` and a fingerprint key
(`OperationRuntime.fingerprintKey`, at least 32 bytes, copied at
construction). Without the key, a request with an idempotency key is
`unavailable`/`idempotency_unavailable`; the operation still runs without one.

An operation that declares `retain` accepts only JSON-domain input, with or
without a key (decision V). The raw input passes the strict release serializer
(see [Release and errors](#release-and-errors)). Anything else is
`invalid_request`/`invalid_input` before any admission. `parse` receives the
serializer's canonical copy. The canonical text of that copy is JSON with
object keys sorted by code unit, where `-0` is `0`. Key order therefore never
matters, and a `Date` is never equal to its string. The stored fingerprint is
a keyed digest of the operation ID and that text, `hmac-sha256:v1:<hex>`
(`29cf8fa5` delta 7). The text itself is never stored, and the same input
under another key never matches. A key on any other operation is
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

The first admission phase writes a `reserved` record with the fingerprint and
the resolved resources. It does this in the same synchronous admitted phase as
the read, so concurrent requests cannot both reserve. The record becomes
`started` at the commit point, not before. It becomes `completed` with the
internal result, or `unknown`, in the completion phase, after the lease was
released. The runner validates and copies every record it reads back. A
malformed record is `internal`/`invalid_idempotency_record`.

A later request with the same key gets:

| Existing record | Answer |
| --- | --- |
| different fingerprint | `conflict`/`idempotency_conflict` |
| `reserved` or `started` | `conflict`/`request_in_progress` |
| `unknown` (unknown effect or unconfirmed cleanup) | `outcome_unknown`/`previous_attempt_outcome_unknown` |
| `completed` | replay, as below |
| none | a fresh run |

A failed store call is any call that throws or returns a thenable (decision W).
The runner owns the reservation before it writes it, so a `reserved` or
`started` write that lands and then throws is still given back. An attempt
that fails before its commit point releases its own reservation, so
a retry runs fresh. If that release fails, the reservation stays and later
requests see `request_in_progress`.

Decision Z. The completion callback owns the final record of an attempt that
crossed its commit point. If its write throws or returns a thenable, the same
callback writes `unknown` at once, before it returns. No other admission runs
between the two writes, so no request can read a `completed` record that the
runner is about to replace. The caller gets `cleanup_unconfirmed` (or
`outcome_unknown` for an effect that failed), and a retry gets
`outcome_unknown`. The `finally` block of the runner writes `unknown` only for
an attempt whose completion callback never ran, for example because its
admission was refused. It never writes after the callback ran. If the repair
also fails, nothing more is tried: the record stays `started`, and later
requests see `request_in_progress`, never a replay. If the failed write was a
`completed` one that landed, the record stays `completed` and a retry replays
it, while the original caller was told `cleanup_unconfirmed`. If a store
returns a thenable and finishes the write later, that write can land after
the runner's `unknown`. Store adapters must therefore be synchronous and must
not report failure for a write that landed.

A replay is a release of historical data. It requires a fresh decision on the
current authority and current resolution. It is then decided again against
the resources stored with the result. If the original project is no longer
visible to the caller, the answer is `not_found`. If the current resolution
differs from the stored one (moved, deleted and recreated, or changed
relation), the answer is `conflict`/`resource_changed`. Only then is the
stored result projected and released. An operation with expected transitions
replays as described under [Expected transitions](#expected-transitions); a
secret-bearing operation replays its receipt (see
[Secret-bearing operations](#secret-bearing-operations)).

Retained internal results must be structured-cloneable plain data. Store
adapter obligations are listed under
[Obligations of later slices](#obligations-of-later-slices).

## Release and errors

Every release point serializes before it checks. This covers success, replay,
each stream event and each error. The serializer accepts only plain objects
(prototype `Object.prototype` or `null`), dense arrays, strings, finite
numbers, booleans and `null`. It rejects a `toJSON` key (own or inherited,
enumerable or not, whatever its value), accessors (also on array indices),
non-enumerable and symbol keys, `__proto__` keys, functions, symbols,
`undefined`, bigints, proxies, typed arrays and every other prototype, cycles,
nesting deeper than 32 and more than 100000 values (decision V). Each property
is read once from its data descriptor. `-0` becomes `0`. The allowlist of
top-level public keys is then checked on the serialized value, so nothing can
change between the check and the release.

Errors are released in the closed five-field shape. `releaseError` also checks
the outcome rules below. A value that fails becomes a generic error that keeps
a known effect state, read only from an own data property.

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

- An effect state of `unknown` is always `outcome_unknown`. The
  `OperationError` constructor normalizes it, and `classify` normalizes it
  again from the fields it reads, so a typed error that already carries
  `unknown` is never released under its own category.
- A handler past its commit point that throws has an unknown outcome. The
  error is `outcome_unknown` whatever was thrown, and the thrown reason is kept.
  Before a declared commit point, `classifyBeforeCommit` applies (see
  [Commit point](#commit-point)).
- `busy` and a `retry` disposition are impossible once an effect began. A
  `busy` after a committed effect becomes `unavailable`.
- A typed error's own effect is used only when the runner observed none
  (`null` or `not_started`).
- An admission refused because the caller aborted is
  `unavailable`/`request_cancelled` with `retry`.
- Unexpected faults are released as `internal`/`unexpected_failure`, or as
  `outcome_unknown` for an unknown effect, without details.

Sanitization is total (decision S). `classify` never returns the thrown value
and never calls a method on it. It reads the fields of a typed error as own
data properties inside a guard and builds a new error. The admission check on
a thrown value is guarded too. Whatever a handler, projector, finalizer or
stream source throws, `run` resolves to a well-formed error, and so do a
replay and every stream error item. `run` never rejects.

## Contract extensions of slice 4

These implement the planned deltas of `29cf8fa5` and the two additions of the
same reply (`intent_origin`; coordination sessions are not part of this). All
of it is unmounted, like the rest of the module.

### Queries

Kind `query` (delta 1, review F1). Discovery, hashing and filesystem reads
cannot run inside a synchronous `read`. A query runs in three steps:

1. In one admitted phase: decide, then `plan(input, scope)`, which captures
   synchronously what the work needs.
2. Outside admission: `work(plan, signal)`. The signal aborts on caller
   cancellation (`unavailable`/`request_cancelled`, `retry`) and at the
   deadline (`unavailable`/`query_timed_out`, `retry`). The deadline is
   `OperationRuntime.queryDeadlineMs` (default 30 s); an operation's own
   `timeoutMs` can only shorten it. A result or failure that settles after the
   abort is ignored and never becomes an unhandled rejection.
3. In a new admitted phase: decide again, require the resolution unchanged
   (`conflict`/`resource_changed`) and the request not aborted, then project
   and release. A failure of the work is released only after this decision,
   so a caller who lost access learns nothing from it.

A query takes no idempotency key. Nothing it does may be an effect.

### Waits

A wait is a `StreamOperation` with `wait: { maxWaiters, timeoutMs(input) }`.
It delivers at most one event, released under the same per-event decision as
every stream event:

- At most `maxWaiters` waits of one operation ID are open per runner. Another
  is `busy`/`too_many_waiters` with `retry`, before admission. A slot is
  released exactly once, however the wait ends, including a refused opening.
- `timeoutMs(input)` must be an integer from 1 to `MAX_WAIT_TIMEOUT_MS`
  (20000), otherwise `invalid_request`/`invalid_wait_timeout`. At the timeout
  the stream ends with `done` and no event.
- After its one event, the stream ends; the next read is `done`.
- On timeout and after the event, the source is disposed as when the consumer
  ends the stream (decision T).

### Expected transitions

Delta 2, review F2. A mutation may list in `transitions` the slots whose
resource its own effect changes or removes, for example the holder relation
of `claim.release` or the mapping of `registration.detach`. Without this, the
release decision on the current resolution would refuse the operation's own
receipt (`claim_not_held`, `not_found` or `resource_changed`).

- Past its commit point and before it settles, the handler reports each
  declared slot's result with `transition(slot, result)`: `unchanged`,
  `removed`, or `changed` with the resulting project and relation. A call
  before the commit point is `internal`/`transition_before_commit`, for an
  undeclared slot `internal`/`undeclared_transition`, after settling
  `internal`/`effect_scope_closed`.
- In the completion phase, before the lease is released, the runner confirms
  each report with the resolver. `removed` needs the reference missing;
  `unchanged` needs the same version and project; `changed` needs a new
  version with the reported project and relation. An unreported slot, a
  mismatch or a resolver failure leaves the result unconfirmed: the record
  becomes `unknown` and the caller gets `conflict`/`transition_unconfirmed`
  with effect `committed`.
- The confirmed resolution of each declared slot is stored with a `completed`
  record (`IdempotencyRecord.transitions`, `null` for a removed slot).
- Release and replay resolve the current state, where only a declared slot may
  be missing. They then decide twice: on the resolution recorded at the commit
  point, with the full requirement (historical authority), and on the
  resulting resolution, without predicates on declared slots and without
  requirements on removed slots. Finally the current resolution must equal
  the resulting one: the confirmed result for every declared slot, the commit
  point for every other slot. Any other change, including an unrelated
  concurrent change of an undeclared slot, is `conflict`/`resource_changed`.
  Resolver version changes are never suppressed.
- For an operation with transitions, the idempotency record is read before
  the current resolution, because after the operation's own transition the
  current state legitimately differs from the commit point.
- The projector receives the commit-point resolution only, so a receipt can
  carry nothing the caller could not see before the effect. Which fields the
  receipt holds stays the operation's choice.
- If the effect failed, the transition is unconfirmed or cleanup is
  unconfirmed, the runner still decides on the commit-point resolution before
  it releases the error.

### Claims and multi-step effects

Delta 3, owner decision `42019833`. The predicate `claim_holder_if_claimed`
holds when the slot's `claim` relation has no holder, or when its holder is
the caller's coordination session (identifier, generation and credential).
Otherwise it is `claim_held`/`claim_held_by_another_session`. Full authority
is not exempt, and a caller without a coordination session only passes an
absent claim.

- Absence is a resolved fact, never a missing resource. Resource kind
  `project_claim` is the claim slot of one project; its identifier is the
  project identifier. It resolves while the project exists, to that project,
  with a `claim` relation whose holder is `null` when no claim exists. Its
  version changes whenever the claim changes, so a claim that appears between
  phases also fails the unchanged-resolution rule.
- `same_project("project", "claim")` binds the slots to one project. A claim of
  another project is `not_found`, even when both are visible.
- The scope of an `idle` effect has `recheck()`: it re-enters admission,
  revalidates authority, reads current grants, re-resolves every resource and
  requires the resolution of the commit point unchanged and the request not
  aborted. A handler calls it while holding the lifecycle coordination (its
  lease from `acquire`), immediately before each further effect, for example
  after the stop inside a restart. It rejects with the denial. A rejection
  that the handler rethrows unchanged past its commit point is released with
  its own category and reason and effect `committed`: the earlier steps
  happened and the refused one never began. The record becomes `unknown`, so a
  retry inspects first. A handler that swallows the rejection and continues
  acts against a denial, which the runner cannot prevent.

### Aggregates

Delta 4, review F7. `any_project(permission)` holds for full authority,
also on an installation without projects, and for an account that holds the
permission on at least one current, visible project. A grant on a project that
no longer exists does not count, and visibility alone (`secrets` or
`executor` only) does not either. An `admin` passes only when a project
exists. It is decided at every decision point, not by a projector, and it is
independent of `collection`, which allows the call and filters items. A
decision without a project list fails closed with
`forbidden`/`project_list_unavailable`.

### Durable ownership

Delta 5, review F3, decisions `46672ea8` and `fb1567d5`. A stored principal
is an account, `installation` or `operator`. `durablePrincipal(authority)`
records the owner: the account of a human or agent, `operator` for the
operator in better-auth mode, and `installation` otherwise (in open and token
mode the operator and the installation are one principal).

- Resource kind `schedule` carries its owner (relation `schedule`).
- `schedule_owner` lets an account act only on schedules it owns. Any other
  owner, including `installation` and `operator`, is masked as `not_found`
  before the rest of the requirement, so a foreign schedule looks exactly like
  a missing or invisible one. Full authority manages every schedule.
- `ReleaseContext.owns(owner)` filters listed items by owner before
  pagination: full authority owns every item, an account only its own.

### Remote requests and stored principals

Delta 6, review F8. Resource kind `remote_request` carries its stored
submitter. `request_submitter` holds when the caller's durable principal is
the submitter, otherwise `forbidden`/`not_submitter`; full authority is not
exempt.

The application authorization interface `decideForPrincipal` (also
`PhaseScope.authorizePrincipal`) decides a requirement for a stored principal
on its current grants, without replacing or changing the caller's context. An
account is evaluated as the kind the grants store records now; an unknown or
disabled account holds nothing. `installation` and `operator` hold full
authority. A stored principal has no credential, coordination session or
provider evidence, so it never passes a session predicate, `intent_origin` or
fresh login. A malformed principal is `forbidden`/`invalid_principal`.
`authorizePrincipal` works only while the admitted phase runs synchronously;
afterwards, and in an `idle` effect, it throws `internal`/`phase_closed`.

### Original intent

Delta for OPEN-21. Resource kind `test_intent` carries the saved origin:
principal, credential identifier and generation, project, worktree, preset,
key, the origin digest and its digest version. The runner reads the caller's
credential identity from the context registry; `CurrentAuthority` is
unchanged. `intent_origin` holds when:

- the origin's principal is the caller's durable principal, the credential
  identifier and generation are the caller's, and the origin's project is the
  resource's project. Otherwise the answer is `not_found`, masked like a
  missing intent. A new coordination session under the same credential
  passes; a rotated credential or another principal does not, and an operator,
  which has no credential, never adopts an intent;
- the digest version is supported (`INTENT_DIGEST_VERSIONS`, today only 1),
  otherwise `forbidden`/`intent_digest_unsupported`;
- the digest equals `intentOriginDigest(version, origin)`, otherwise
  `forbidden`/`intent_digest_mismatch`. Version 1 is SHA-256 of a JSON array
  binding the other fields.

The version 1 digest is defined here, because no existing digest of task
`6d680061` was found in this repository. An adapter that stores intents must
use it, or add a version.

### Secret-bearing operations

Delta 7, review F10. A mutation with `secret: { receipt, projectReceipt }`
must declare `retain`.

- The first response is `project(result)`, which may deliver a secret once,
  for example a token.
- The store keeps only `receiptValue(receipt(result))`: a flat record of at
  most 32 keys whose values are `null`, booleans, safe integers,
  identifier-like strings (no spaces, quotes, slashes or `=`, at most 200
  characters) or arrays of at most 256 such strings or integers. Nothing else
  is retained, not the input and not the result. The fingerprint is a keyed
  digest as for every retained operation.
- A replay is reauthorized as before and returns `projectReceipt(receipt)`,
  checked against the same allowlist. It never returns the secret.
- A receipt that fails the check retains nothing: the record becomes
  `unknown`, the caller gets `cleanup_unconfirmed`, and a retry gets
  `outcome_unknown`.
- The check stops a whole result or nested data from being retained by
  accident. It cannot tell a secret that looks like an identifier from an
  identifier: the operation chooses the receipt's fields.

### Listener exclusion

Owner decision `fb1567d5`. An operation may declare `excludedListeners`. In
open and token mode the dashboard and MCP share the installation actor, so
`claim.force_release` and `runtime.force_stop` exclude `mcp` in every mode.

- `OperationRegistry.availableOn(id, listener)` and `idsOn(listener)` let a
  transport register only what it may serve. An unknown ID is not available.
- The runner refuses an excluded listener as
  `not_found`/`operation_not_registered` before it parses the input, using
  the listener recorded when the context was minted. Every admitted phase
  checks the revalidated listener again.

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
| Visibility requires `project:read` | Replaced by decision M: any active role makes a project visible. |
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
the I1 original-intent lookup. That lookup is the `intent_origin` predicate
(see [Original intent](#original-intent)); the query operation that uses it is
not implemented.

## Unmounted guard

`unmounted.test.ts` enforces decision U over a fixed inventory: every source
file under `src`, `packages` and `scripts`, plus these root files:
`eslint.config.mjs`, `next-env.d.ts`, `next.config.ts`, `playwright.config.ts`,
`playwright.e2e.config.ts`, `postcss.config.mjs` and the six `vitest.*.config.ts`
files. Build and dependency trees (`node_modules`, `.git`, `.next`, `dist`,
`out`, `build`, `coverage`, `.turbo`, `test-results`, `playwright-report`) are
never scanned. The test also fails when a root-level source file is missing
from that list. Files of the module itself and the contract file are exempt.
`tests/`, `site/`, `skills/` and `design-reference/` are not part of the
inventory.

Within the inventory, the guard does three things:

- It resolves every literal specifier: static imports, re-exports, type
  imports, `import()`, `require()`, `require.resolve()`, `module.require()`,
  `import.meta.resolve()` and `import x = require()`. It resolves relative
  paths, the `@/` alias, absolute paths and `file:` URLs. A specifier fails when
  its path names the module or its contract file, or when a resolved file's
  real path lies inside them, so a symlink on the way cannot hide the target.
- It fails on every non-literal specifier unless the file is on `ALLOWLIST`
  with a reason. The result of `createRequire` may only be bound to `require`,
  called at once, or used as `createRequire(...).resolve("literal")`.
- It fails on any symbolic link inside the inventory.

Allowlisted files with non-literal specifiers, unchanged:

| File | Reason |
| --- | --- |
| `src/server/modules/authentication/provider-runtime.ts` | Loads the optional external authentication provider from its configured file URL. |
| `packages/auth-provider-better-auth-proof/test/better-auth-proof.test.ts` | Imports frozen fixture modules of the provider proof by computed file URL. |
| `scripts/auth-provider-session-restart.mjs` | Imports an emitted passkey authenticator from a build output path. |
| `scripts/https-caddy.mjs` | Reads the pinned Caddy manifest through `createRequire` from a computed path. |
| `scripts/package-install.mjs` | Loads `better-sqlite3` from the installed package directory under test. |
| `scripts/package-installed-fault.mjs` | Loads the installed package's CLI and `better-sqlite3` from a temporary install. |
| `scripts/package-rbac.mjs` | Loads the MCP SDK from the installed package directory under test. |
| `scripts/package-smoke.mjs` | Loads the MCP SDK from the packed package directory under test. |
| `scripts/package-smoke.test.mjs` | Imports a copy of `package-smoke.mjs` from a temporary directory. |

The guard does not see a `require` function passed around as a value, worker
or child-process entry points (`new Worker(path)`, `fork(path)`), `vm`
evaluation or string-built code. Those are not import specifiers. They are
outside decision U and listed as notes for slice 4.

## Obligations of later slices

These are not implemented here. The slices that mount the contract own them.

- **Transport handling of streams.** A transport must call `return()` when its
  consumer goes away or stops reading (abandonment). The runner provides no
  `throw()`. A transport that needs one must map it to `return()` and must not
  forward a consumer error into the source.
- **Store adapters.** The idempotency store stores and returns copies and
  bounds retention. After a controller restart it deletes `reserved` records,
  whose effect never crossed its commit point, and turns `started` records into
  `unknown`. It also clears reservations left behind by a failed release. Its
  calls are synchronous, and it never reports failure for a write that landed
  (decision Z). The grants snapshot returns active grants only. The resolver keeps versions that
  are never reused for one reference.
- **Coordination sessions and leases.** Issuance, lease secret, renewal,
  expiry, generation changes, disconnect and restart. The module only compares
  a `CoordinationSessionRef` that a verifier returns.
- **Resolver adapter for the new kinds.** A `project_claim` resolves while its
  project exists and carries a `claim` relation with a `null` holder when no
  claim exists; its version changes with every claim change. `schedule`,
  `remote_request` and `test_intent` carry their stored principal or origin.
- **Store adapter for transitions and receipts.** A `completed` record keeps
  its confirmed transitions; the source and rotation of the fingerprint key
  (D6) belong to the adapter.
- **Transports.** Register only operations that `availableOn` allows for the
  listener, and never register `claim.force_release` or `runtime.force_stop`
  on MCP.
- **Background authorization specifications.** Queued or scheduled work keeps
  an immutable authorization specification and an owner reference, never a
  closure over a request.
- **The I1 original-intent lookup.** The predicate is implemented; the
  `test_run.lookup_intent` query, the intent store and its digest adapter are
  not.
- **Bootstrap.** It injects an `OperationObserver` that logs stream disposal
  failures.

## Not implemented

- Store adapters: the grants snapshot, resolver, credential verifier and
  idempotency store exist only as ports and in-memory test doubles.
- Coordination-session issuance and storage (`coordination.*`), any
  transport, and every product operation of the catalogue except
  `session.describe`. The extensions of slice 4 are exercised by test
  fixtures only.
- The disposition of the 204 current operations: a revised draft under review
  in [authorization operation dispositions](authorization-operation-dispositions.md).
- Admin without `secrets` and reader with `logs:read` do not guarantee
  non-disclosure of secrets that an application prints into its logs.
