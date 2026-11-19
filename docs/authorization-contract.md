---
audience: "owner, implementers and reviewers of the authentication and authorization unification"
last_reviewed: "2026-11-19"
source_of_truth: "authorization contract with session.describe mounted on API and unix for the unreleased breaking auth unification; Knowledge task 040062b4"
status: "active"
---

# Authorization contract

**Status: unreleased breaking change.** Only `session.describe` is mounted,
through `POST /api/operations/session.describe` on the API listener and private
unix socket. Only the exact raw operation path can succeed. Aliases entering
`/api/operations` or `/mcp/operations` through dot segments, encoded path syntax,
backslashes or duplicate slashes receive the new not-found envelope on both
listeners through normal request dispatch, for every method. On unix the fixed
cookie refusal still comes first. Neither listener registers CONNECT or Upgrade handlers. Node
closes every CONNECT connection without a response or dispatch, including targets
inside the namespace. Upgrade headers keep normal HTTP request dispatch.
Other routes and tools retain their existing authentication.
Provider cookies are mounted on the API listener in account mode. Unix keeps
its fixed `unauthenticated` / `provider_cookie_not_supported` refusal before
body reads or capacity admission. Unsupported modes keep that preflight refusal.
For supported API modes the acceptance table decides: open refuses a cookie as
`credential_in_open_mode`, token as `credential_not_accepted_here`, and account
mode accepts only a current provider session. Mixed credentials always remain
mixed, including when cookie resolution returns null.
The import guard permits only the explicit composition and transport consumers
(see [Unmounted guard](#unmounted-guard)). Current operator behaviour is in
[authentication](authentication.md).

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

A verifier that throws gives no answer. That covers a throw from `verify` or
`current` and a throw from a getter on the object they return. The boundary
handles it exactly as a `null` answer: `unauthenticated` with reason
`invalid_credential` at mint and `credential_no_longer_valid` at revalidation.
The thrown value is not attached to the error and is not passed on.

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

Classification by wire format selects a verifier, never authority.
`classifyBearer` recognises the full `wsi_` installation-token and `wts_`
machine-token formats; everything else is unrecognised. The abstract
`legacy_owner_token` and `legacy_worker_token` classes remain in the acceptance
matrix and its tests, but are unreachable from the wire. Owner and worker
tokens have the `wts_` format and reach the agent verifier. In account mode
(`better-auth`) their committed kinds fail verification, so they answer
`unauthenticated` / `invalid_credential`. There is no fallback or promotion
from a token's format to an actor.

`InstallationVerifier` implements the installation-token and anonymous paths.
`AgentTokenVerifier` implements the agent-token path. Both read synchronous
ports on the store owner's admitted connection and open no connection.
`CompositeCredentialVerifier` dispatches each accepted path to its configured
verifier, including the existing provider-session verifier, without fallback.
Installation and agent paths are mounted on API; unix uses operator authority.
They write no usage time or other state, including `last_used_at`.

The agent verifier compares SHA-256 of the entire presented token with the
stored verifier hash in constant time, using an equal-length dummy for a
missing or malformed hash. It does this before copying and validating the
remaining row facts. Credential-ID existence may still be observable through
lookup timing, as with `authenticateBearer`; the verifier does not defend
against that. Only an active `agent_token` credential belonging to an active
`agent` principal can authorize. A revoked credential, a revocation timestamp
or an expiry at or before the verifier's clock refuses.

The agent identity is the credential ID and a versioned 48-bit fingerprint.
Its ordered field list is credential `id`, `principal_id`, `kind`,
`verifier_hash`, `status`, `expires_at`, `created_at`, `revoked_at`, then
principal `id`, `kind`, `status`. Its encoding is UTF-8 `JSON.stringify` of an
array starting with `"wtc-agent-token-credential-v1"` and followed by those
fields in order, preserving nulls and adding no whitespace. SHA-256 of that
encoding supplies the first six bytes, interpreted as an unsigned big-endian
integer. Usage time, label and token prefix are excluded.

The installation identity is the token ID, or the fixed
`anonymous-installation` ID, and a fingerprint with the same encoding and
48-bit digest rule. The verifier requires the listener's active mode at
construction, the same mode passed to `createListenerBoundary`. Only active
`token` mode accepts the installation token; only active `open` mode accepts
anonymous requests without a secret. Active `better-auth` mode accepts neither
path. The stored mode is the next-start selection, validated as part of the
policy's shape but ignored for eligibility and identity until restart.
Selecting a mode preserves the authentication generation and existing contexts.
The token fingerprint's ordered array is
`["wtc-installation-credential-v2", active_mode, authentication_generation, token.id, token.prefix, token.verifier_hash, token.created_at]`.
For the anonymous path it is only
`["wtc-installation-credential-v2", active_mode, authentication_generation]`.
Token facts and the authentication generation are re-read on every `verify`
and `current`. Token rotation or removal, a changed creation time or a same-ID
verifier-hash replacement ends token contexts immediately. An authentication
generation change ends both token and anonymous contexts. `current` returns
the recomputed identity; the boundary compares it with the mint baseline and
refuses a change.

Disabling a credential or principal invalidates its context while disabled.
Re-enabling with every fingerprinted fact unchanged may validate that same
request-scoped context again. There is no principal-incarnation detection:
same-ID deletion and recreation with the same facts is not detected. D1a
adds neither principal recreation nor
credential-ID reuse. A durable incarnation must exist before supporting
same-ID principal recreation, and retained contexts need a separate review.

### Provider sessions

`ProviderSessionVerifier`
(`src/server/modules/operations/adapters/provider-session-verifier.ts`) is the
existing `CredentialVerifier` for the `provider_session` path. It answers
`null` for every other path. `CompositeCredentialVerifier` can dispatch that
path to it alongside the installation and agent verifiers. Bootstrap constructs it when a provider is present. The operations cookie
transport is mounted on the API listener for `session.describe`. It reads committed authority and writes no usage
state.

**Handoff.** The provider verifies its cookie asynchronously and outside this
module, so `verify` cannot do that itself (decision W). A transport passes the
`VerifiedProviderSession` that the provider resolved to `stage`. `stage`
copies the session ID, subject, creation time and claimed method, and returns
a random 256-bit handle. The transport presents that handle as the provider
session secret. `verify` accepts a handle once, and only before `stagedTtlMs`
has passed. A cookie, a session ID or any other string is not a handle and
verifies nothing. The registry holds at most `stagedCapacity` handles. When it
is full, `stage` refuses a new handle; it never evicts an unexpired one. Both
limits are required options with no default.

The adapter does not and cannot establish that the provider resolved the
session it is given for this request. `stage` checks only the claim's shape
and provider ID, and `verify` checks the claim against committed state. It is the
caller's obligation that only the provider's own resolution result for the
current request reaches `stage`.

**Eligibility.** A required option `eligible: () => boolean` has no default;
the constructor rejects options without it. `stage`, `verify` and `current`
call it on every invocation, and continue only when it returns the literal
`true`. A throw, a thenable (whose rejection is absorbed) and any other value,
a truthy one included, refuse: `stage` and `current` answer `null`, and
`verify` consumes the handle and answers `null`. The answer is never cached
or latched. When the check answers `true` again, `current` answers from
committed state as before. A context minted before the withdrawal then
revalidates again, as long as its session still authorizes with the same
generation. This matches the runtime's own check, which is also a predicate
evaluated at one point in time. A handle consumed while the provider was not
eligible stays consumed.

**Committed state only.** The staged claim never authorizes anything. `verify`
and `current` read the session again through an injected
`ProviderSessionReader`. Its `currentSession(providerId, sessionId)` has the
shape of the provider storage method of the same name. The adapter opens no
connection and imports no SQLite code. It decides through
`evaluateSessionAuthority`, the provider's single rule, at the adapter's own
clock. Of the runtime's checks before it issues a provider actor and when it
revalidates one (`isCurrentProviderSession`), the adapter makes these:

- the provider is eligible, through the injected check above;
- the session is read for the adapter's own provider ID;
- the principal kind is `owner` or `human`;
- the principal ID is present and the mapping's link time is canonical;
- the evidence belongs to this session and subject, and its authentication
  time parses;
- the subject, principal and its kind, the mapping's link time, the session's
  creation time and every evidence field are unchanged since the credential
  was verified. The adapter compares them through the generation, described
  below.

`verify` also refuses when the staged subject, creation time or method
disagrees with committed state, as the runtime's own resolution does.

The adapter also refuses a session ID longer than 512 characters before any
read. Actor issue and `isCurrentProviderSession` have no such limit; the cap
is the one the runtime applies to a retained session
(`validateRetainedRuntimeSession`). The adapter is stricter here.

One runtime check differs. The runtime refuses an actor once the session
expiry it captured at issue has passed. The adapter keeps no expiry. It reads
the native expiry again on every call, and the expiry from when the context
was minted is not retained. A refresh inside the immutable original deadline
therefore keeps an already minted context valid. A refresh extends neither
login freshness, which comes only from the evidence's authentication time,
nor the original deadline.

**Answer.** A valid session yields:

- the actor `{ kind: "human", accountId }` of the committed principal. An
  owner principal is a human too, because the target has no owner sessions;
- `ProviderEvidence.authenticatedAt`, which is `Date.parse` of the committed
  evidence's `authenticatedAt` and nothing else. A refresh or a session
  exchange does not change it. For `password_totp` it is the time of the
  password stage, so a TOTP code entered late can already be stale;
- `coordinationSession: null`.

The identity is `{ path: "provider_session", credentialId: <session ID>,
generation }`. The generation is the first 48 bits of a SHA-256 over every
committed fact the session's authority depends on: the provider, session,
subject, principal and its kind, the mapping's link time, the session's
creation time, every evidence field, the account generation and policy
revision, and the current factor binding. A refresh changes none of these.

`current(identity)` reads the identity's session again. It answers only when
that session still authorizes and its generation is unchanged. Otherwise it
answers `null`. That covers a session that was removed, expired or relinked,
one past its original deadline, and one whose account generation, policy
revision, factor binding or account consistency changed. The boundary then
fails with `unauthenticated`/`credential_no_longer_valid` at admission, before
an effect or at release. A change that the provider rule does not see, such
as a relinked mapping, still changes the generation. That is a defence only:
the SQLite queries insert a subject mapping once and only revoke it, and a
partial unique index allows one active mapping per principal, so no workflow
relinks a mapping today. A new login is another session and so another
credential: it never upgrades a context minted earlier.

**Failures.** `verify` and `current` never throw. An eligibility check or a
reader that throws or returns a promise, a malformed state, a malformed claim
and a clock that is not a finite number all answer `null`. A thrown value is
not passed on.

The contract's fresh-login rule is unchanged. It runs on the runner's clock;
the provider rule runs on the adapter's clock. With one shared clock that
never moves backwards, or with identical timestamps, the provider rule already
refuses evidence from the future, so the caller gets `unauthenticated` rather
than `login_stale`. The adapter and the runner read the clock separately, so
their two reads can straddle a backward step. The provider rule can then
accept evidence that the fresh-login rule, at a time before the
authentication, refuses as from the future, and the caller gets
`login_stale`. Both outcomes refuse.

The gate tests in `provider-session-verifier.test.ts` cover all three login
methods, refresh, inheritance on password change, re-login, the 600000 ms
boundary, every change above and the eligibility check. They mint through `createListenerBoundary`
(`better-auth`, `api`) and run through the runner. Sessions and evidence come
from the real `AccountProtection` and `SessionIssuance`. The fixture writes
the rows below them by hand: an in-memory double of the SQLite row adapter,
native users, sessions, TOTP secrets, passkey rows, challenges, refresh,
revocation and the changes listed above.

### Mounted API cookie boundary

The raw operations parser claims the namespace before legacy authentication or
browser dispatch. The API adapter then checks the operation and POST method,
controller eligibility, and the browser's shared canonical Host, singleton
headers, Fetch Metadata and cookie-size checks. It parses managed cookies with
the same alias and duplicate checks and requires the canonical Origin. It
rebuilds provider headers through the browser's allowlist using the socket peer,
forwarding only the session cookie. Forwarding and internal-IP headers, bearer
secrets, unrelated cookies and ceremony cookies do not reach the provider.

It acquires one initiating slot from administration's aggregate 16-slot budget
before reading the body or starting provider work. Twelve slots are available
to initiating requests; browser completions retain four. Before body reads it
also checks the composition's current provider eligibility, as the browser checks
its pinned-configuration guard. Busy remains contention; an evaluated refusal
is passed to mint with the raw credentials so the acceptance table keeps its
mode-specific or mixed-credential answer. If mint returns `invalid_credential`
or succeeds after that pre-body refusal, the adapter answers retryable
`unavailable` / `provider_session_unavailable`: it resolved no session and cannot
judge the cookie. Without a configured public origin, the server accepts no
sessions at all; that branch retains its acceptance refusals, including
`unauthenticated` / `invalid_credential` in account mode. Saturation answers
`busy` / `listener_capacity` with `Retry-After: 1`. Operations also retain the
API's 32-request owner. It checks JSON content type, reads at most 65536 bytes,
and parses strict JSON with depth 8 and 128 fields. The body must be an object;
`session.describe` itself rejects unknown actor or session fields. This read's
body limit deliberately differs from the browser password and Knowledge limits.

The adapter calls `resolveSession` outside admission with the request abort
signal, then passes the resolved session and the original raw presented
credentials to `mint`. Stage, verification and mint share one admitted phase.
`runner.readRelease` performs the fresh admitted read and Node write. It checks
current authority, grants, directory, clock, deadline, connection and controller
eligibility. If the provider becomes ineligible between mint and the final read,
revalidation keeps its existing `unauthenticated` / `credential_no_longer_valid`
refusal. No successful DTO or usage timestamp is written outside that phase.

All refusals use the operations five-field error envelope. Browser authority
failures map to `invalid_request` / `invalid_authority` (400); origin and fetch
failures to `forbidden` / `origin_forbidden` (403). Cookie syntax and singleton
failures use `invalid_request` (400), body excess `payload_too_large` (413).
A cookie examined and refused by an eligible provider or verifier (unknown,
expired, revoked, signed out or a disabled account) is `unauthenticated` /
`invalid_credential`. An ineligible provider at mint (not loaded, failed to load,
changed pinned configuration or disposed) is retryable `unavailable` /
`provider_session_unavailable` (503, `Retry-After: 1`). This also applies when
resolution returns null after eligibility is lost in flight. Controller
maintenance and stopping retain their earlier refusal. A mixed request is
`unauthenticated` / `mixed_credentials`.
Contention remains `busy` / `admission_refused`; cancellation remains
`unavailable` / `request_cancelled`, both retryable. A session resolution that
the provider itself rejects (a failed plugin, an unavailable or disposed
provider) is retryable `unavailable` / `provider_session_unavailable`, never
`internal`. Storage faults retain `unavailable` / `database_unavailable`. The total ten-second deadline
aborts provider resolution and admission and answers retryable
`unavailable` / `request_timed_out` when that timer causes a caught refusal.
A runner clock deadline refusal is `release_timed_out`.

The slot receives `responseFinished` on finish or close, including a response
already closed before acquisition, and exactly one `settle` joining all started
provider settlement. Cancellation never stands in for real settlement. Listener
close fences and aborts synchronously, then drains accepted work. Administration
stops the shared budget before listener drain and disposes the provider before
SQLite and its owner lock can be released. Provider readiness is checked on each
request; no boundary rebuild is needed after a late successful provider load.
Pinned configuration changes, disposal, maintenance and stopping refuse.

The shared listener conformance suite is
`src/server/modules/operations/http-boundary-conformance.test.ts`, with exact
negative-control assertion identities in `http-boundary-driver.ts`.
`packages/auth-provider-better-auth-proof/test/cli-provider-lifecycle-operations-cookie.test.ts` runs
real Better Auth through production bootstrap under `node:test:auth-provider-cli`.
Installed API bearer and unix operator checks run under `node:test:package`;
`node:test:rbac-artifact` extends these to open, token and account modes and
account cookies. `node:test:package:provider` builds the separate optional
provider artifact; it does not run listener checks itself.

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

A resource without a project (parentless, see
[Parentless resources](#parentless-resources)) is visible to full authority
only. No account sees it, whatever it holds: an installation-scope grant such
as `admin`, which makes every project visible, does not reach it.

Grants do not expire; revocation is removal. The `GrantsSnapshot` port
contains active grants only. Returning nothing else is the snapshot adapter's
obligation; the SQLite adapter below meets it and its tests check it. Stored
grants have no expiry field, and the module never filters grants by time.
Grants on an archived project keep counting: nothing filters a grant by the
status of its project (owner decision of 2026-11-17).

### SQLite adapters

Slice 3 (C4) adds two read adapters under
`src/server/modules/operations/adapters/`. Neither imports SQLite: each takes a
structural read port. The store exposes the SQLite query modules
(`AccountGrantsQueries`, `ProjectDirectoryQueries`) on its owned core
connection. The controller composition now wires these adapters for the
API and unix session description.

- `sqliteGrants` builds the runtime's `grants()`. Each call is one snapshot
  that reads each account at most once, together with its grants, in one
  statement. `owner` and `human` accounts are `human`, `agent` accounts are
  `agent`. Workers, the installation principal, revoked and unknown accounts
  are `null` and hold no grant, even when their rows remain. Every stored row
  is returned, because revocation deletes the row; `effectivePermissions`
  still re-validates the recipient. A stored value outside the schema's
  domain, a reader fault, more than 5001 grants for one account or more than
  64 accounts in one snapshot is `internal`.
- `SqliteResourceResolver` resolves `registration` and `project` only. Every
  other kind is `internal`/`resource_kind_unsupported`, never `not_found`. A
  registration resolves to its parent project, or to `null` when it has none.
  Its version is its `mapping_version`, which the mapping clock advances on
  every parent change and on re-creation. An unstamped row is `internal`. A
  project resolves to itself with the constant version 1. This relies on no
  production path deleting or recreating a `knowledge_projects` row, and a
  test pins that. Archived projects resolve and are listed, because archiving
  changes no mapping. `listProjects` refuses more than 1000 projects. It
  leaves out a project whose stored Knowledge ID the contract grammar cannot
  carry (Knowledge accepts any trimmed ID of up to 160 characters), because no
  operation can name it; a lookup of such a project is `internal` for that
  project alone.

A version is never reused for the same reference within one linear history of
the database. Versions are not unique across references: every project has
version 1, and a registration may share a value with another. A restore
rewinds the mapping clock, and the quarantine is the recovery boundary for
anything that retains versions.

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
- `same_project(slots)`: every named slot is present and all resolve to one
  value, the same project or all no project (parentless); a missing slot,
  different projects and parentless and project slots mixed do not satisfy
  it;
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
   (`intent_origin`) and slots bound by `same_project` that do not all resolve
   to one value are `not_found` too, decided before every other part of the
   requirement.
2. The human-only flag: `forbidden`/`human_only` for an agent.
3. The requirement: `forbidden`/`permission_denied`, or a predicate's own
   denial. Predicates are evaluated only on visible resources.
4. Fresh login: `login_stale`/`fresh_login_required`, or
   `forbidden`/`fresh_login_unavailable` for an agent. A stored principal
   decided through `decideForPrincipal` never passes it (see
   [Remote requests and stored principals](#remote-requests-and-stored-principals)).

Visibility follows decision M above. Every decision is a new frozen value.
A live full-authority caller passes permissions, `any_project`, the human-only
flag and fresh login, and manages every schedule. It is still subject to resource
resolution and to the predicates that protect foreign claims (including
`claim_holder_if_claimed`), runs, assignments, submitted requests and
intents.

Fresh login holds when `0 <= now - authenticatedAt < 600000`. The value comes
only from current provider evidence; missing or malformed evidence is stale.

The `ResourceResolver` port maps registrations, claims, test runs, profiles,
Vault entries, Knowledge records, worker attempts, project claim slots
(`project_claim`), schedules, remote requests (`remote_request`) and saved
test-run intents (`test_intent`) each to exactly one project, to no project
(`projectId: null`, see [Parentless resources](#parentless-resources)) or to
not-found. It never searches another namespace. `resolveAll`
returns a frozen record with a `null` prototype that holds deep, frozen copies.
It treats a malformed or mismatched answer as not-found. A `projectId` that is
neither a non-empty string nor `null` (absent, empty, another type) is
malformed.

### Parentless resources

A resolved resource may state explicitly that it has no project:
`projectId: null`, for example a registration without a parent project. It is
a resolved fact, not a missing resource. A resolver never invents a project ID
for it and never puts another ID in its place.

- Full authority (a live `installation` or `operator`, and a stored principal
  holding full authority) sees it. Project-permission and collection
  requirements on it hold as they do for full authority on any project.
- Every account, a human holding `admin` and an agent included, gets
  `not_found`/`resource_not_found`, the answer for a missing resource. Masking
  checks every own slot, so a parentless slot masks the whole call whatever
  the other slots are and whichever slot the requirement names. Ownership and
  relation predicates never run for an account on it.
- `same_project` holds for slots that are all parentless, as for slots that
  are all in one project; only full authority reaches it, because an account
  is masked by the parentless slots first. A mix of parentless and project
  slots never satisfies it.
- A saved test-run intent on a parentless resource has the origin project
  `null`. `intent_origin` compares the origin's project with the resolved
  project strictly: `null` matches only `null`, a project only the same
  project. The intent's own full-authority origin (an installation caller
  under the credential it was saved with) can look it up; an account is
  masked by visibility, and an operator or a stored principal, which has no
  credential, never adopts it.
- `copyResolution`, retained idempotency records, transition results
  (`changed` with `projectId: null`) and `sameResolution` keep the state
  exactly. A change from no project to a project, or back, is a mapping
  change: it carries a new version and is caught by every recheck, replay and
  transition comparison as `conflict`/`resource_changed`.
- `ReleaseContext.visible(null)` and `can(permission, null)` hold for full
  authority only; `filter` and `page` keep an item whose `projectOf` is `null`
  for full authority only. `any_project` counts only real projects from
  `listProjects`, and `session.describe` lists only those, skipping any
  entry that is not a project ID even for full authority, so a parentless
  resource is never listed among projects.

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
frozen and mounted only on the API and private unix transports. Every other operation in the tests is a
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

### Release inside admission

Transports must use `OperationRunner.readRelease` for every successful read
response. `run()` still returns a value without committing a response.
`ReadOperation` is unchanged. The new entry point accepts reads only; another
kind is `internal`/`invalid_operation`.

The runner takes core admission. One synchronous callback revalidates the
context and listener, reads the clock, checks eligibility, deadline and
connection, reads fresh grants, resolves references, decides, reruns `read`,
projects and applies `releaseValue`. After any canonical comparison, it reads
the clock and checks the deadline again immediately before calling `commit`,
before leaving admission. No await separates those steps. Bootstrap must supply
the same current eligibility policy used by the other runtime stages.

The runner captures `eligible`, `connected` and `commit` once, before waiting
for admission, and calls them with the options object as receiver. Reassigning
these methods while waiting does not replace the captured callbacks.

`eligible` and `connected` are required predicates with no defaults. Only a
synchronous `true` allows release. A throw, thenable or any other answer
refuses; thenable rejections are absorbed (decision W). `deadline` is required,
finite and absolute in the runtime clock's milliseconds; equality is expired.
The deadline is checked on entering the phase and again immediately before
commit. A thenable or non-finite clock answer at the second check refuses as
`release_timed_out` without calling `commit`.
An aborted `signal` also refuses. The public refusals are
`unavailable`/`release_not_eligible`, `unavailable`/`release_timed_out`, and
`unavailable`/`request_cancelled` for a caller that is gone. The last two have
retry disposition `retry`; the first has `none`. Read errors have effect
`null`. Existing read refusals use the same path as `run()`.

There are two commit shapes:

- Direct: `commit(value)` receives the fresh released value. HTTP serializes
  and writes it synchronously there.
- Validated payload: `expectedCanonical` supplies `canonicalJson` of an earlier
  `run()` public value for the same operation and input. The transport has
  already built and bounded its buffered response from that value. Inside
  admission the runner compares it with `canonicalJson` of the fresh released
  value. This helper applies strict serialization and sorts object keys by
  code unit. Key order alone does not change equality; changed or added fields
  do. The supplied string must itself be canonical. A mismatch is
  `conflict`/`release_payload_changed`, retry `none`, with no commit call.
  MCP can then write its validated buffer synchronously in `commit`.

The result is `committed`, `refused` with a public error before commit, or
`commit_failed` with `internal`/`release_commit_failed`, retry `none`. A commit
that throws or returns a thenable is failed and is never retried. A synchronous
void callback may return an ordinary value; it is ignored. Commit runs at most
once per call. Failed commit confirms no successful release, though it may
have written some bytes. Admission never spans asynchronous SDK work or
network drain. Committing bytes to Node promises neither client receipt nor
revocation of bytes already committed. API and unix session descriptions use the direct commit shape.

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
permission of the requirement. An item without a project is kept for full
authority only. Filtering happens before pagination. The cursor
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
same reply (`intent_origin`; coordination sessions are not part of this). Queries, mutations and streams remain unmounted.

### Queries

Kind `query` (delta 1, review F1). Discovery, hashing and filesystem reads
cannot run inside a synchronous `read`. A query runs in three steps:

1. In one admitted phase: decide, then `plan(input, scope)`, which captures
   synchronously what the work needs.
2. Outside admission: `work(plan, signal)`. A caller that already holds
   admission, which the first phase joined, is suspended through `idle` for
   the work, so other admissions and authentication-provider borrows proceed
   while it waits. The signal aborts on caller
   cancellation (`unavailable`/`request_cancelled`, `retry`) and at the
   deadline (`unavailable`/`query_timed_out`, `retry`). The deadline is
   `OperationRuntime.queryDeadlineMs` (default 30 s); an operation's own
   `timeoutMs` can only shorten it. A result or failure that settles after the
   abort is ignored and never becomes an unhandled rejection.
3. In a new admitted phase (after re-admission, for a suspended caller):
   decide again, require the resolution unchanged
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
  `removed`, or `changed` with the resulting project (or `null` for no
  project) and relation. A call
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
  current state legitimately differs from the commit point. Before anything
  about the record is reported (`idempotency_conflict`,
  `previous_attempt_outcome_unknown`, `request_in_progress` or a replay), the
  requirement is decided on the record's own resolution: the admission's,
  or the commit point's once the attempt started. A caller who lost access to
  it gets `not_found`, never a conflict or an unknown outcome.
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
- For an operation with expected transitions, `recheck()` past the commit
  point applies the release rules of
  [Expected transitions](#expected-transitions) to the steps so far. It
  decides on the commit-point resolution with the full requirement, then on
  the resulting resolution so far without predicates on declared slots and
  without requirements on slots confirmed removed. A declared slot must be
  unchanged or match the result its handler already reported with
  `transition()`; every undeclared slot must be unchanged. Otherwise it is
  `conflict`/`resource_changed`. A handler therefore reports a step's
  transition before it calls `recheck()` for the next step.

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
disabled account holds nothing and is never allowed. A resource it would need
is masked as `not_found`, and a requirement that needs no grant
(`authenticated`, also with `agents: false`) is
`forbidden`/`principal_unavailable`.

A stored `installation` or `operator` holds full authority only in a mode
whose acceptance table admits that actor kind (`modeAdmitsActor`, read from
`acceptanceTable`): the installation in open and token mode, the operator in
every mode. The mode is checked before any full-authority actor is built. A
stored `installation` in better-auth mode, left over from an earlier mode,
holds nothing and is decided exactly as an unknown account: `not_found` for a
resource it would need, `forbidden`/`principal_unavailable` where no grant is
needed.

A stored principal has no credential, coordination session or provider
evidence, so it never passes a session predicate, `intent_origin` or fresh
login. A requirement with `freshLogin` is never allowed for any stored
principal kind in any mode: masking and every other denial answer first,
then `principal_unavailable` for a principal that holds nothing, and otherwise
`forbidden`/`fresh_login_unavailable`. A live full-authority caller stays
exempt from fresh login, and `session.describe` reports it as `exempt`. A
malformed principal is `forbidden`/`invalid_principal`.
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
  resource's project: the same project ID, or `null` for both (an intent on a
  parentless resource). Otherwise the answer is `not_found`, masked like a
  missing intent. A new coordination session under the same credential
  passes; a rotated credential or another principal does not, and an operator,
  which has no credential, never adopts an intent;
- the digest version is supported (`INTENT_DIGEST_VERSIONS`, today only 1),
  otherwise `forbidden`/`intent_digest_unsupported`;
- the digest equals `intentOriginDigest(version, origin)`, otherwise
  `forbidden`/`intent_digest_mismatch`. Version 1 is SHA-256 of a JSON array
  binding the other fields. A parentless origin's project is the JSON `null`,
  which no project ID produces (the string `"null"` is encoded as a string),
  so the digest of an origin with a project is unchanged.

An origin states its project explicitly. A missing project, like any value
that is neither `null` nor a non-empty string, makes the relation malformed,
and `intentOriginDigest` refuses it with a `TypeError` rather than encode it
as `null`.

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
file under `src`, `packages`, `scripts` and `tests`, plus these root files:
`eslint.config.mjs`, `next-env.d.ts`, `next.config.ts`, `playwright.config.ts`,
`playwright.e2e.config.ts`, `postcss.config.mjs`,
`vitest.auth-provider-proof.config.ts`, `vitest.config.ts`,
`vitest.https.config.ts`, `vitest.integration.config.ts`,
`vitest.provider-administration.config.ts` and
`vitest.remote-recovery.config.ts`. Build and dependency trees (`node_modules`, `.git`, `.next`, `dist`,
`out`, `build`, `coverage`, `.turbo`, `test-results`, `playwright-report`) are
never scanned. The test also fails when a root-level source file is missing
from that list. Files of the module itself and the contract file are exempt.
`site/`, `skills/` and `design-reference/` are not part of the inventory.
A source file cannot hide an import behind a helper under `tests/`: that
helper is itself scanned. Negative controls cover direct module and contract
imports under `tests/`, and a `src/` importer of such a helper.

The approved importers of the module and shared contract are
`src/server/bootstrap/operations-runtime.ts` (store-owner composition) and
`src/server/transports/operations-http.ts` (the public wire classifier, error
serializer and runtime types). The exact provider proof importer
`packages/auth-provider-better-auth-proof/test/cli-provider-lifecycle-operations-cookie.test.ts`
reuses the listener driver and conformance assertions under real production
bootstrap. It is test-only and mounts no additional operation. The adapter receives the built runtime as a
value and creates no boundary. Approved entries must exist and really import
the module or contract. Missing and stale entries fail, with negative controls.
A second exact-importer guard permits only `src/cli/index.ts` to import the
composition. It still rejects imports from inside the operations module and
computed composition imports in allowlisted production files.

Within the inventory, the guard does three things:

- It resolves every literal specifier: static imports, re-exports, type
  imports, `import()`, `require()`, `require.resolve()`, `module.require()`,
  `import.meta.resolve()` and `import x = require()`. It resolves relative
  paths, the `@/` alias, absolute paths and `file:` URLs. A specifier fails when
  its path names the module or its contract file, or when a resolved file's
  real path lies inside them, unless its importer is explicitly approved.
  A symlink on the way cannot hide the target.
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

These obligations remain for later families and mounts. The API and unix
`session.describe` mounts already use strict bounded JSON, cancellation, the
shared composition and admitted read-release. The API cookie path also shares
the browser boundary and budget. Worker, MCP and CLI mounts remain for later steps.

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
- **Provider session transport.** The browser transport resolves the cookie
  through the provider runtime, then stages the result and mints the context
  in the same request. Only that resolution result may reach `stage`. It
  creates one `ProviderSessionVerifier` with the provider storage as its
  reader, and gives the reader and the runner the same clock. It binds
  `eligible` to the runtime's disposal state, session-authority support and
  storage availability. The runtime exposes `isSessionAuthorityEligible()`
  and request-scoped `resolveRequest()` with `result` and `settled`; bootstrap
  binds the predicate with its maintenance, stopping and pinned
  configuration guard, and the API transport consumes the resolution. It must
  call `verify` and `current` where `currentSession` may read: the storage
  requires core admission. It must not release a `credentialId`, because for a
  provider session it is the session's row ID.
- **Operation-bound proof.** Slice 2 does not remove the Ed25519 owner proof.
  Fresh login replaces it only once a transport mounts the provider-session
  verifier.

## Not implemented

- Store adapters. Two SQLite adapters exist (see
  [SQLite adapters](#sqlite-adapters)): the grants snapshot, and a resolver for
  the `registration` and `project` kinds only. The store exposes their read
  ports; production wires them for the one mounted read. Every other resource kind has
  no resolver and answers `internal`. The idempotency store exists only as a
  port and an in-memory test double. The installation-token, anonymous,
  agent-token and provider-session verifiers exist, with a composite that
  dispatches without fallback (see [Actors and authentication](#actors-and-authentication)
  and [Provider sessions](#provider-sessions)). The bootstrap
  `buildOperationsRuntime` composes those adapters, one clock, the store's own
  admission, a fresh grants factory, disposal diagnostics and a registry pinned
  to `session.describe`, exposed through a frozen read-only view with bound read
  methods and no registration method. Its explicit active mode fixes both
  installation verification and each served listener boundary. Unknown modes, including
  `legacy`, construct no boundary or verifier and answer `unauthenticated` /
  `unknown_mode` on this new surface alone.

  Bootstrap separates controller eligibility from provider-session eligibility.
  In every mode, controller eligibility refuses maintenance and stopping. It
  gates every listener boundary together with that listener's own `open`, the
  top of mint, and offline mint and revalidation together with the owner lock.
  Provider-session eligibility shares the existing throwing guard's maintenance,
  stopping and pinned-configuration checks, requires the provider runtime to be
  ready, and requires a synchronous `true` from its session-authority predicate.
  Only provider sessions use this additional gate: mint checks it before staging
  a resolved session, and the verifier checks it on every `stage`, `verify` and
  `current`. A provider outage or pending configuration change therefore refuses
  human contexts at their next revalidation while agent tokens, the unix
  operator and the offline CLI retain access if the controller remains eligible.
  Mint, including the offline path through the composition, provider stage and
  provider verification run in one synchronous core admission callback. Offline
  mint and every revalidation require both controller eligibility and a
  synchronously held owner lock. Thrown failures use the runner's public
  classification: contention is `busy` / `admission_refused`, an aborted admission is
  `unavailable` / `request_cancelled` with retry `retry`, and an unexpected
  throw is `internal` / `unexpected_failure`, without exposing thrown details.
  Cookie resolution belongs outside it. Staging is bounded
  to 16 handles and 5000 ms; no timer or new connection is created. Transports
  must supply the resolution for the current request and retain raw credential
  multiplicity. The returned `eligible` is the controller-level predicate for
  every request's read-release; human contexts enforce the additional provider
  condition through their own revalidation. Cookie transports check the returned
  `providerSessionEligibility` before starting provider work. It answers
  `eligible`, `ineligible` or `busy`; the boolean `providerSessionEligible`
  convenience returns false for both ineligibility and contention. Provider
  administration owns a stable accessor with the fixed `better-auth` ID and the store's session reader,
  which exists before loading. Its synchronous eligibility check uses existing
  core admission for configuration validation. Entry contention rejects resolution
  with `busy` / `admission_refused`, without starting provider work. The same
  composition and verifier work when that provider later becomes ready. Failed loads remain failed; configuration changes
  require a new controller boot, not replacement within this lifetime. Stage and
  verify share one synchronous admission callback, so no staged handle crosses
  a provider replacement. `resolveSession` uses the current provider outside
  admission and retains its real settlement independently of the public result.
  Its delivery check queues for core admission with the request's abort signal.
  Contention delays delivery; refused admission rejects with retryable
  `busy` / `admission_refused`, and an aborted wait with
  `unavailable` / `request_cancelled`. An evaluated refusal still returns null.
  The accessor rejects with `ControllerOperationSessionResolutionError` only
  when the entry check could not run or the request was already cancelled.
  Connection errors from provider work and from the delivery check reach the
  operations composition unchanged, which classifies them: contention is
  retryable `busy`; a closed, draining or poisoned store and a provider fault
  such as an expired borrow are `unavailable` / `database_unavailable` without
  a retry instruction. The provider's own cancellation, raised when the request
  is aborted after its borrow was admitted, is `unavailable` /
  `request_cancelled` like every other aborted wait.
  Administration also owns the browser's shared 16-slot request budget, with
  four slots reserved for completions. Its initiating acquisition and release
  after both response completion and work settlement are shared by the API
  operations cookie path. It counts as initiating work, leaving the four
  completion slots available to the browser handler.
  Settlement must be called exactly once, with all started work joined.
  Shutdown and listener-start failure stop the budget synchronously before
  listener drain.
  Controller start builds this once from its immutable active mode. API and
  unix mounts use it for `session.describe` only. HTTP success serializes and
  ends the response inside `readRelease` admission. The API owns at most 32
  new requests; unix shares its existing 32 accepted-work slots with `/auth`.
  Capacity is retained through response completion and work settlement. Close
  fences and aborts requests synchronously and drains before storage release.
  Body ceilings are 65536 bytes on API and 16384 on unix; the response ceiling
  is 262144 bytes. The total deadline is 10000 ms, including body and admission.
  The error envelope is `{ error: { category, status, reason, retry, effect } }`,
  with HTTP status taken from the public error and `Retry-After: 1` when its
  retry disposition is `retry`. Method refusals use 400 /
  `invalid_request` / `method_not_allowed`; malformed and unknown operation
  targets use 404 / `not_found` / `operation_not_found`. All replies are no-store.
  Worker, MCP and offline CLI mounts, credential usage recording and
  principal-incarnation detection remain unimplemented.
- Enforcement of the project ID grammar. A project ID in the contract matches
  `^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$` (`src/shared/contracts/operations.ts`),
  and the owner decided on 2026-11-17 that Knowledge project IDs must follow it
  as part of the breaking release. Nothing enforces it on Knowledge yet: the
  Knowledge create path and the Hub import still accept any trimmed ID of up
  to 160 characters. The two read adapters treat such an ID differently.
  The resolver leaves the project out of its listing. The grants snapshot
  fails harder: `account_grants.project_id` checks length only, so a grant on
  such a project is a valid stored row, and the adapter validates every row
  of an account before it answers. One grant on a non-conforming project
  therefore makes `accountKind` and `grantsFor` answer `internal`
  (`invalid_stored_grant`) for the whole account, which then reaches no
  project at all. `upgrade inspect` now names such IDs, active and archived
  alike, in "upgrade needed" and in "current" (see
  [the explicit upgrade](authentication.md#the-explicit-upgrade-unreleased-integration-build));
  `upgrade apply` neither refuses on them nor changes them. Still missing are
  prevention in the Knowledge create path and the Hub import, and an approved
  repair procedure: there is no supported way to rename a project ID. The
  owner decided on 2026-11-19 that hand migration is due before the release,
  not before the grants snapshot is mounted, and the release stays blocked on
  conforming IDs, prevention and an approved repair procedure. The upgrade does
  not remap them, and the grammar is not widened.
- Coordination-session issuance and storage (`coordination.*`), any
  transport, and every product operation of the catalogue except
  `session.describe`. The extensions of slice 4 are exercised by test
  fixtures only.
- Moving the 204 current operations onto the registry, as decided in the
  accepted [authorization operation dispositions](authorization-operation-dispositions.md).
- Admin without `secrets` and reader with `logs:read` do not guarantee
  non-disclosure of secrets that an application prints into its logs.
