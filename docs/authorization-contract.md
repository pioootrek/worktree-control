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
`6b95f3db`.

Code: `src/shared/contracts/operations.ts` (browser-safe vocabulary) and
`src/server/modules/operations/` (public API in `index.ts`).

This page states what the code enforces. Everything else is listed under
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
impossible. Decisions, permission sets, relations, requirements and the
exported vocabularies are frozen and never shared between decisions. Resource
slot names are restricted, so no reserved property name can reach a prototype.
A value that trusted code throws or returns malformed never escapes
unsanitized and never leaves a lease, reservation or stream source held. The
module does not try to resist deliberately hostile in-process code beyond
that.

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
- a named predicate: `claim_holder`, `run_originating_session` or
  `worker_assignment`.

The `agents: false` and `freshLogin` flags complete the requirement.

`decide` is pure and runs in this order:

1. **Masking.** Every slot the requirement names must be resolved, and every
   resource the operation references must be visible to the caller. Masking
   iterates every own slot of the resources record. A malformed record (a
   prototype other than `Object.prototype` or `null`, a symbol key, an invalid
   slot name) fails closed. Otherwise the decision is `not_found` with reason
   `resource_not_found`. The answer is the same for a missing and an invisible
   resource. It does not depend on the flags or on the order of conjunction
   branches.
2. The human-only flag: `forbidden`/`human_only` for an agent.
3. The requirement: `forbidden`/`permission_denied`, or a predicate's own
   denial. Predicates are evaluated only on visible resources.
4. Fresh login: `login_stale`/`fresh_login_required`, or
   `forbidden`/`fresh_login_unavailable` for an agent.

Visibility follows decision M above. Every decision is a new frozen value.
Full authority passes permissions, the human-only flag and fresh
login. It is still subject to resource resolution and to the predicates that
protect foreign claims, runs and assignments.

Fresh login holds when `0 <= now - authenticatedAt < 600000`. The value comes
only from current provider evidence; missing or malformed evidence is stale.

The `ResourceResolver` port maps registrations, claims, test runs, profiles,
Vault entries, Knowledge records and worker attempts each to exactly one
project or to not-found. It never searches another namespace. `resolveAll`
returns a frozen record with a `null` prototype that holds deep, frozen copies.
It treats a malformed or mismatched answer as not-found.

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

An operation is `Operation<Input, InternalResult, PublicResult>`. It is either
a `read` or a `mutation`. `StreamOperation` covers streams. The
`OperationRegistry` rejects duplicate and malformed IDs. It also rejects
requirements with unknown permissions, predicates or slot names, empty
conjunctions, invalid public keys and malformed effects. It registers a frozen
copy whose requirement, allowlist and effect are deeply frozen. The only real
operation is `session.describe`, which is frozen and registered on no
transport.

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
   then write the idempotency record. A failed finalization or lease release
   writes `unknown`, never `completed`.
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

A mutation accepts an idempotency key only when it declares `retain` and the
runtime has an `IdempotencyStore`.

An operation that declares `retain` accepts only JSON-domain input, with or
without a key (decision V). The raw input passes the strict release serializer
(see [Release and errors](#release-and-errors)). Anything else is
`invalid_request`/`invalid_input` before any admission. `parse` receives the
serializer's canonical copy. The fingerprint is the canonical text of that
copy: JSON with object keys sorted by code unit, where `-0` is `0`. Key order
therefore never matters, and a `Date` is never equal to its string. A key on any other operation is
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

An attempt that fails before its commit point releases its own reservation, so
a retry runs fresh. If that release fails, the reservation stays and later
requests see `request_in_progress`. If an attempt crossed its commit point but
its final record could not be written, the runner tries once more to write
`unknown`. If that also fails, the record stays `started`, and later requests
see `request_in_progress`, never a replay.

A replay is a release of historical data. It requires a fresh decision on the
current authority and current resolution. It is then decided again against
the resources stored with the result. If the original project is no longer
visible to the caller, the answer is `not_found`. If the current resolution
differs from the stored one (moved, deleted and recreated, or changed
relation), the answer is `conflict`/`resource_changed`. Only then is the
stored result projected and released.

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
the I1 original-intent lookup. That lookup uses the saved origin-session
digest with an explicit digest version from task `6d680061`, and this module
does not implement it.

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
  `unknown`. It also clears reservations left behind by a failed release. The
  grants snapshot returns active grants only. The resolver keeps versions that
  are never reused for one reference.
- **Coordination sessions and leases.** Issuance, lease secret, renewal,
  expiry, generation changes, disconnect and restart. The module only compares
  a `CoordinationSessionRef` that a verifier returns.
- **Background authorization specifications.** Queued or scheduled work keeps
  an immutable authorization specification and an owner reference, never a
  closure over a request.
- **The I1 original-intent lookup.** It uses the saved origin-session digest
  with an explicit digest version from task `6d680061`.
- **Bootstrap.** It injects an `OperationObserver` that logs stream disposal
  failures.

## Not implemented

- Store adapters: the grants snapshot, resolver, credential verifier and
  idempotency store exist only as ports and in-memory test doubles.
- The disposition of the 204 current operations.
- Admin without `secrets` and reader with `logs:read` do not guarantee
  non-disclosure of secrets that an application prints into its logs.
