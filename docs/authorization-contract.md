---
audience: "owner, implementers and reviewers of the authentication and authorization unification"
last_reviewed: "2026-11-13"
source_of_truth: "implemented, unmounted authorization contract for the unreleased breaking auth unification; Knowledge task 040062b4"
status: "active"
---

# Authorization contract

**Status: contract for an unreleased breaking change. The code exists but is
unmounted.** No HTTP route, MCP tool, CLI command, policy function, schema or
migration uses it. Current behaviour is described in
[authentication](authentication.md) and
[identity and authorization plan](identity-authorization-plan.md) until the
release that mounts this contract.

Evidence: Knowledge task `040062b4`, discussion `8a2683b8`. The owner-accepted
target is in replies `5583b882` and `1367c632`. Proposal v0 is `efa8c8e5`, the
independent review with eleven required changes is `575a4fe8`, and contract v1
(binding) is `032aa386`.

Code: `src/shared/contracts/operations.ts` (browser-safe vocabulary) and
`src/server/modules/operations/` (public API in `index.ts`).

## Actors and authentication

There are four actor kinds: `installation`, `operator`, `human` and `agent`.
`installation` and `operator` hold full authority. A remote worker is the
installation in open and token mode, or an agent holding `executor` in
better-auth mode.

Only a listener boundary (`createListenerBoundary`) or an offline invocation
holding the exclusive lock (`mintOfflineContext`) can mint an
`AuthenticationContext`. The context is opaque, frozen and never serialized.
Its `revalidate()` re-reads the original credential and returns the current
actor, provider evidence and coordination session, or fails with
`unauthenticated`. It never falls back to another credential and never
substitutes another actor or coordination session.

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
MFA ceremonies, public status and static assets stay outside the operation
registry and never produce an actor.

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

## Requirements and decisions

An operation declares an `OperationRequirement`. Its `require` field takes one
of these forms:

- `authenticated`, with no permission;
- a project permission on a named resource;
- an installation permission;
- `allOf`, a conjunction over one or several resources;
- `collection`, filtered per item at release;
- a named predicate: `claim_holder`, `run_originating_session` or
  `worker_assignment`.

The `agents: false` and `freshLogin` flags complete the requirement.

`decide` is pure. Full authority passes permissions, the human-only flag and
fresh login. It is still subject to resource resolution and to the predicates
that protect foreign claims, runs and assignments.

Fresh login holds when `0 <= now - authenticatedAt < 600000`. The value comes
only from current provider evidence; missing evidence is stale.

A denied action on a missing or invisible resource returns `not_found`. A
denied action on a visible resource returns `forbidden`. A resource is visible
with `project:read` on its project or with full authority.

The `ResourceResolver` port maps registrations, claims, test runs, profiles,
Vault entries, Knowledge records and worker attempts each to exactly one
project or to not-found. It never searches another namespace. Each resolution
carries a relation version, so a later phase can detect a move.

## Operations and the runner

An operation is `Operation<Input, InternalResult, PublicResult>`. It is either
a `read` or a `mutation`. `StreamOperation` covers streams. The
`OperationRegistry` rejects duplicate and malformed IDs. The only real
operation is `session.describe`, which is registered on no transport.

`OperationRunner` runs a mutation as these admitted phases, built on
`src/server/database-admission.ts`:

1. Revalidate, resolve and decide. A replay of a retained result is decided
   and projected here.
2. Run the optional SQL-free wait, such as a lock, outside admission.
3. Revalidate, re-resolve and decide again. Refuse a changed resource
   mapping, then start exactly one effect.
4. Finalize under reserved admission, without an authority check.
5. Revalidate, re-resolve and decide, then release through the projector.

Finalization, audit and owned cleanup of an effect that began complete even
after revocation. The result is then withheld. Streams authorize and project
every event in its own admitted phase. A denial ends the stream with one error
item and disposes the source.

## Release and errors

Each operation projects to an allowlisted public DTO, and the runner rejects
unlisted top-level fields. The authentication context cannot be serialized. In
collections, `ReleaseContext.page` filters per item before pagination. Its
cursor encodes only the key of the last released item, and it returns no total
count.

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
`null` for reads. `busy` and `retry` are possible only when execution never
began. `outcome_unknown` requires an unknown effect.

## Not yet decided or implemented

- The server-issued coordination session is only a reference: there is no
  issuance, lease, renewal or expiry, and no I1 origin-session digest version.
- Background authorization specifications are not implemented.
- The disposition of the 204 current operations is not done yet.
- Admin without `secrets` and reader with `logs:read` do not guarantee
  non-disclosure of secrets an application prints into its logs.
