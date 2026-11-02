---
audience: "people running Worktree Control and choosing how callers authenticate"
last_reviewed: "2026-11-02"
source_of_truth: "authentication modes, owner CLI and scoped runtime agent workflow"
status: "active"
---

# Authentication modes

For planned human accounts, project roles, scoped agents and ENV permissions,
see the [identity and authorization plan](identity-authorization-plan.md).
A1 Knowledge roles and A2 scoped projects, claims, runtime control, profile
selection and timeout configuration are implemented below. Account login and
ENV roles remain planned.

One authentication policy applies to the dashboard, the HTTP API, live updates,
MCP and the online CLI. The controller stores the next-start selection in its
database and captures the
active mode once per boot, after migration and restore recovery. Only the CLI
selects a mode; the new selection takes effect at the next service restart.
Token rotation, credential revocation and current grants still apply immediately.
The permanent product modes are open access, a shared installation token, and
individual RBAC. Full RBAC remains gated on account authentication, readiness
of selected optional methods and A5 work. The current controller refuses `better-auth` selection and startup. `legacy` is
upgrade compatibility and cannot be selected anew.

| Mode | Who uses it | Access |
| --- | --- | --- |
| `token` | New installations | Installation-wide compatibility authority, including Knowledge; cannot sponsor scoped runtime agents |
| `open` | Explicit choice | Anonymous installation-wide compatibility authority; cannot sponsor scoped runtime agents |
| `legacy` | Installations created before modes existed | Browser pairing token, MCP `mcp-token`, owner sessions for knowledge |
| `better-auth` | Reserved | Not available yet; selecting it fails with `auth_provider_unavailable` |

Scoped agent tokens and owner sessions from `identity` commands keep working in
`legacy` and `token` modes. A controller whose stored mode is unavailable
refuses to start; it never falls back to another mode.

## Optional provider proof (first A3 slice)

The private workspace package `packages/auth-provider-better-auth-proof` is an
executable, isolated proof using Better Auth 1.7.14, `@better-auth/core`
1.7.14 and Kysely 0.28.17 on the existing `better-sqlite3` 13.0.3 connection.
It exercises real handler requests, cookies, password changes, session
revocation and local recovery. Startup does not load it. Explicit protected CLI
maintenance can load a configured module without activating accounts.
Selecting `better-auth` still fails; this slice adds no login UI,
production browser authorization or account endpoints. A bounded browser adapter
is composed only by isolated proof fixtures; see [browser adapter](#bounded-browser-adapter).

The versioned local loader checks readiness and storage compatibility. Local
modules execute as trusted controller code, with no sandbox. Each operation
borrows the sole controller-owned connection. Shared core admission and exclusive
provider admission now use one bounded FIFO gate. Admitted controller phases wait
for a provider transaction to commit or roll back; they cannot join that
transaction. Strict test fixtures reject every unadmitted core statement, even
when the connection is idle. Production without a provider keeps compatible
synchronous store access. This is partial live admission infrastructure, not
acceptance of safe account-mode coexistence.

HTTP and MCP requests, finite-job persistence, event/status callbacks, remote
coordination, scans, schedules and restore callbacks have admission boundaries.
The proof suite exercises selected real boundaries under held Better Auth
transactions. Coverage and remaining cases are listed in the
[proof README](../packages/auth-provider-better-auth-proof/README.md#live-admission-coverage).
Regressions cover Knowledge and vault body-read re-admission: an expired
database wait preserves `database_busy` (503 with `Retry-After`), while malformed
JSON remains a 400 response. The application operation does not execute when
re-admission fails. Remaining coverage and design gates still apply.

SQL-free waits release admission and re-enter it afterwards. Callers must recheck
current authority after those waits. `idle` suspends the whole shared participant;
joined branches cannot use SQL concurrently while a sibling idles. Project-lock
waiters release admission before waiting, and lock holders re-enter admission
for database phases. See the [architecture contract](architecture.md#database-admission).
Provider resolution inside a core scope fails as reentrant. The implemented
[provider authorization handoff](#provider-authorization-handoff) resolves outside
admission and validates current stored authority inside each Knowledge operation.
The isolated browser composition below mounts it in a temporary fixture only.
Production account mode remains unavailable.

Disposal rejects new provider work and tracks actual execution, including a
continuation whose public promise timed out. Late SQL and host notifications
are refused. Unsettled execution or a rejected provider disposal reports
`disposal_unconfirmed`; repeated disposal calls share the same failure. Database close
waits for accepted work and driver backup settlement; an unconfirmed drain or
failed driver close retains ownership. Current implementation limits are a
5-second admission wait, a 60-second persistence retry budget and a 10-second
database drain. These are implementation bounds, not approved account-security
defaults. Operations already invoked are never retried as a whole by the
admission helper.

Controller migration 38 adds empty, recognized `authentication_ba_*` tables and
`authentication_provider_subjects`. It performs no account, credential, role or
grant backfill. An explicit opaque provider subject maps to an existing active
owner ID. Resolution checks the current session, mapping and owner; email and
display name grant no authority. Cookies never manufacture an `owner_session`.
A2 machine credentials and scoped runtime policy remain unchanged.

Controller schema 39 adds `provider_session` only to the Knowledge history
method constraint. It preserves historical rows, IDs, timestamps, indexes and
the AUTOINCREMENT watermark, including empty history. Migrations 1..38 and their
checksums remain unchanged; provider storage revision stays 1. No identity,
credential, role or grant backfill occurs, and owner-only import batches retain
their existing method constraint. History metadata and authorized logical
export/import recognize the honest provider audit method.

Full controller backups now record schema 39 and include provider rows. Genuine
schema-38 snapshots can be restored and upgraded on open. Older binaries reject
schema 39; restoring a backup is not a downgrade procedure. Restoring a snapshot can revive old sessions and
passwords; the external revocation/recovery fence remains A5 work. Better Auth
stores bearer session tokens, and the proof's native sign-in and password-change
JSON responses include session tokens. Those responses are not an approved
browser API design. Password-only evidence is neither MFA nor an ASVS Level 2
claim. Numeric session, reset, password and rate limits are proof settings,
not approved product defaults. A4 vault proof remains separate.

Optional-factor implementation, invitations, roles, GUI and the A5 activation gates
remain open in Knowledge task `ec4c7258770328ca33fb1801be6831f6`. The optional
package retains its dependency notices and stays outside Community runtime
dependencies and published assets. See its
[README](../packages/auth-provider-better-auth-proof/README.md) for verification.

### Owner-selected optional methods

The owner chose "Kody i passkey", then "Opcjonalne" on 2026-11-02, recorded
in Knowledge discussion `d1062d3b2a802346592d701d29028b51`, reply
`a6b59c9b-45aa-4c4d-9a0c-387fdf723d93`. Authenticator-app TOTP and passkeys
are both selected as available optional methods. This replaces the engineering
proposal requiring MFA for every human. Supporting both means alternative
methods can satisfy the chosen protection, without requiring both in sequence.
A full-RBAC password account must not be denied globally just because it has
not enrolled an optional method. Enrollment and authentication strength confer
no implicit role, grant or privilege.

Optional enrollment must preserve an account's chosen protection. Once an
account selects or enrolls protection, an ordinary password, unverified passkey,
client UV flag or trusted-device cookie must not bypass it. Account policy,
method evidence and authorization remain separate. Existing current-identity
hard guards still apply until a separately implemented policy replaces them;
this decision does not unlock owner administration or vault access.

A3-I14 adds an isolated backend passkey proof using the actual optional
`@better-auth/passkey` 1.7.14 plugin and locked SimpleWebAuthn server 13.3.3.
It uses a fixed fixture RP/origin, real signed registration/assertion data,
and supported server callbacks that require verified UV before credential or
session persistence. Its signed-registration experiment accepts packed
attestation only; default unsigned `none` enrollment is not a completed workflow.
Browser UV requests are also required. Temporary owner-made
schema and nonauthorizing `passkey_uv` observations do not change core schema
39, provider storage 1, contract 2 or production provider loading. The plugin
has no durable session-method or enrollment-UV history; integration must supply
reviewed current evidence and credential trust bindings. See the
[proof details](../packages/auth-provider-better-auth-proof/README.md#a3-i14-passkey-proof).

These are selected product capabilities and local feasibility work, with no live
activation. TOTP replay remains unresolved. Four replay failures and the old
bounded counter-loss failure remain visible. Accepted replay handling, safe factor management and
recovery, production evidence/migrations, transport/disconnect handling and A5
remain gates before public account activation. Password-only access proves no
MFA, and no ASVS Level 2 conformance is claimed.

### Protected provider maintenance

The protected local commands are:

```text
auth provider status [--principal-id ID]
auth provider configure --input-stdin
auth provider owner create
auth provider enroll --principal-id ID --input-stdin
auth provider recover --principal-id ID --input-stdin
```

Sensitive commands also accept `--input-file ABSOLUTE_PATH` instead of stdin.
Input is exactly one strict UTF-8 JSON object, at most 8 KiB; stdin has a
ten-second deadline. Files must be regular, current-user-owned, single-linked,
private (no group/other access), outside Git working trees and supervised
repositories, with no symlink components. Unknown/repeated flags, including
global data/state directory flags, and extra JSON fields are refused. Passwords
and signing material have no argument or environment option. Use a private pipe
or file; keep secrets out of shell history.

Configure input has exactly `module`, `origin`, and `signingSecret`. The module
is an absolute local JavaScript path or file URL, without a symlink entry, query
or fragment. It is trusted in-process code owned by the operator or system and
not writable by others. Origin must be HTTPS without credentials, non-root path,
query or fragment. The core fixes `/api/auth` and its internal client-IP header.
This nonsecret example shows the structure:

```json
{"module":"/protected/provider/index.js","origin":"https://controller.example","signingSecret":{"kind":"generate"}}
```

Only explicit initial `generate` creates 32 random bytes. Alternatively supply
`{"kind":"supplied","value":"<canonical base64url material>"}` with 32–128
bytes from a cryptographically secure generator. Format and length cannot prove
entropy; the operator must supply randomness. Later configuration requires
`{"kind":"preserve"}` or exactly the existing supplied value. There is no
rotation/delete command. Existing provider data with missing configuration
requires restoring the original material, never generation. Invalid existing
configuration refuses maintenance.

Private `authentication-provider.json` in the data directory is the durable
authority. File fsync, rename and directory fsync publish it. Uncertainty before
or after rename returns `configuration_write_unconfirmed`; inspect private status
before another intentional command. Configuration emits a fixed nonsecret
operational event (stderr for stopped CLI, controller log online), without
claiming atomic SQLite/filesystem audit. Back up the
file separately under protected custody. SQLite snapshots and Knowledge/user
exports do not include it. Database restoration can still revive historical
passwords/sessions until A5 provides an external recovery fence.

`owner create` writes one stable active owner and ID-only transactional audit,
with no credential, token, role or grant. Any existing owner, including revoked,
prevents creation. Status reports none/single/ambiguous; existing installations
choose an active ID explicitly. Enrollment input is exactly `{email,name,password}`;
recovery input is `{newPassword}`. The pinned proof requires 12–256-character
passwords, which remains experimental policy. Email never selects an identity.
Principal creation and enrollment are separate transactions. Failed enrollment
leaves a harmless uncredentialed principal for inspection and explicit retry.
Any mapping history, including revoked, prevents re-enrollment.

Recovery checks the exact active owner/mapping inside the actual queued borrow,
then atomically replaces the password, deletes every subject session and audits.
It preserves principal/provider IDs, grants, bindings and tombstones. Revoked
principals/mappings are not reactivated. Session revocation is immediate despite
a pending next-start mode selection.

Online commands use the existing owner-only Unix socket and store. Configure,
status and principal creation do not import code. The first explicit enroll or
recover loads one retained runtime; concurrent commands share initialization.
Changed loaded configuration blocks account mutations until a new owner boot.
Status omits secrets, paths, email and provider subjects/sessions. `ready` means
maintenance initialized only. There is no hot reload, browser activation, mode
fallback, compatibility bearer or default grant. Public login stays unavailable.

Stopped commands acquire both owners and start no listeners. Success is printed
only after provider disposal/drain, SQLite close and lock release. Unconfirmed
cleanup reports `cleanupConfirmed:false` and retains the actual process, resources
and locks for operator recovery. There is no forced exit or recovery daemon.
Real process death permits stale-PID lock recovery, but does not prove cleanup
of arbitrary external effects from trusted module code.

Errors are fixed structured DTOs; no effect is automatically replayed.
`committed:true` preserves a known committed effect despite notification/cleanup
failure. Its absence does not imply rollback. After a lost enrollment response,
inspect principal enrollment status. Recovery has no durable receipt; after a
lost response its outcome is unknown. Another intentional recovery is a new
password/revoke-all effect, including sessions created since the first.
Same-OS-user agents share operator authority. Host isolation, MFA, role
administration, full A3 acceptance and production RBAC remain separate gates.

### Bounded browser adapter

`AuthenticationHttp` is an exported core-owned Node HTTP adapter. The isolated
`composeIsolatedBrowserAuthentication` helper wires the existing immutable
`AuthenticationService`, loaded runtime, seventh-argument identity authority and
`ProviderKnowledgeApplication`. `createControllerServer` calls it before blanket
core admission. The production CLI has no caller, configuration switch or flag
for that composition. It neither loads the optional package nor makes
`better-auth` selectable. No login GUI is implemented.

The public production `GET /api/auth/status` returns only active `mode` and
`loginAvailable: false`. It exposes no pending selection, token metadata, account
existence, provider path, diagnostics or grants. The isolated adapter supports:

| Exact request | Strict input | Sanitized success |
| --- | --- | --- |
| `POST /api/auth/sign-in/email` | `{email,password}` | `{authenticated:true}` and validated cookie |
| `GET /api/auth/get-session` | No query or body | `{authenticated:false}` or `{authenticated:true,principal:{id,kind},expiresAt,authentication:{method:"password",factors:1}}` |
| `POST /api/auth/sign-out` | `{}` | `{authenticated:false}` after durable deletion |
| `POST /api/auth/change-password` | `{currentPassword,newPassword}` | `{changed:true}` and replacement cookie |

All other native routes, methods, extra fields and path aliases are denied
before provider invocation. There is no native catch-all, signup, reset,
redirect, social/linking, factor, user-update or administration endpoint.
Original Host must exactly match the canonical HTTPS origin's authority. Raw
paths cannot contain queries, percent escapes, dot segments, repeated slashes,
trailing aliases, userinfo or absolute-form targets. Browser mutations require
that exact Origin, including initial login. Missing/null/foreign origins and
foreign Fetch Metadata are refused. Native CSRF/origin checks remain enabled;
no CORS or Referer fallback is added.

The adapter rebuilds provider headers from an allowlist. Installation bearer,
product token, Forwarded, X-Forwarded and incoming internal-IP headers are
stripped. It derives the internal peer header from a validated socket address;
missing or invalid peers fail closed. Only temporary Unix fixtures supply an
explicit trusted peer. Behind a reverse proxy all clients share the proxy peer
until a separate trusted-proxy design exists. The native in-memory per-peer/path
limiter remains enabled, including its IPv6 subnet normalization. This is not
account-based throttling or durable restart protection. Rate limiting returns
429 with fixed `Retry-After: 60`; contention returns 503 with `Retry-After: 1`.

Current experimental adapter bounds are eight in-flight requests (including
body reads and response completion), 4 KiB auth bodies, 64 KiB Knowledge bodies,
a ten-second body deadline, 8 KiB incoming cookies and 16 KiB native response
bodies. Native password/session/rate numbers remain proof settings, not approved
production defaults. The adapter never replays a login or password effect after
failure. Only fresh JSON, no-store/nosniff and approved cookies cross the boundary.
Cookies are host-only Secure/HttpOnly/SameSite=Strict, Path=/, with no Domain.
`Headers.getSetCookie()` preserves separate cookies and Expires commas; disabled
cache cookies may only be deleted. Native tokens, user/session/subject records,
arbitrary headers, Location and error text are discarded. Provider library logs
and router exceptions produce fixed events without raw messages or arguments.

Bodies are read outside core admission. Provider calls borrow exclusively;
current session/mapping/principal checks run synchronously under admission
before releasing the response or cookie. Password changes additionally recheck
the exact runtime-issued actor through `runControllerOperation` inside the actual
queued borrow immediately before native work. They force
`revokeOtherSessions:true`, invalidate all old cookies and return the native
replacement only after validation. Native sign-out can swallow deletion errors;
contract version 2 requires a specialized `signOut` operation that verifies
caller-session deletion using the sanctioned delete API. Old version-1 modules
fail compatibility checks. This contract change is independent of controller
schema 39/provider storage revision 1; neither changes here.

Login sessions without a current mapping/principal receive no cookie and are
revoked. Failed cleanup still denies. Committed notification failures return a
fixed error with `committed:true`; they do not promise rollback or trigger retry.
Current database state, exact actor ownership and original expiry remain the
authority. Protected recovery invalidates sessions immediately despite pending
mode selection, including the protected CLI recovery workflow above.

The same real HTTP fixture logs in and calls `/api/knowledge` with explicit
grants. `executeAdmitted` releases each Knowledge result in the same synchronous
admitted callback as its authorization/effect. Unconverted provider-cookie
requests are denied before installation authority, including open mode. This
covers runtime/reservations/configuration, identity/token administration, vault,
backups, downloads, SSE and the separate MCP HTTP listener. Ordinary open/token
clients retain their existing paths. Provider actors do not gain owner-session
or independent vault authority.

The owning shutdown helper disposes the optional provider after accepted
responses, listeners and external producers settle, before the service closes
SQLite. Unconfirmed disposal retains both ownership locks and the shared failure.
The real temporary Unix fixture exercises that order and rejection. Production
loading, OS restart, full restore/reboot, factors/MFA, roles and A5 transport and
external restore fences remain separate gates. This is bounded backend evidence,
not completed A3 or safe production RBAC.

### Provider authorization handoff

This server-only API is implemented for the optional pinned proof. Production
startup still does not load the provider; protected maintenance is explicit.
Production browser transports remain
credential-only, and `better-auth` mode remains unavailable.

`runtime.authenticate(headers)` resolves the actual cookie outside core
admission and returns a frozen `ProviderSessionActor`, or null. The exact object
is an opaque reference owned by that runtime's WeakMap. It binds the original
session ID, subject, principal, creation time and expiry. Copies, structured
clones, raw `runtime.resolve` evidence and another runtime's actors do not
authenticate. Its public fields are `principalId`, `principalKind: "owner"`,
`credentialId: null` and `authenticationMethod: "provider_session"`. No A2
credential, bearer or `owner_session` is manufactured.

Use the same runtime as `IdentityService`'s seventh constructor argument. The
application wrapper owns or joins admission for each call:

```ts
import { ProviderKnowledgeApplication } from "@/server/modules/authentication";
import { IdentityService } from "@/server/modules/identity";
import { KnowledgeService } from "@/server/modules/knowledge";

// `runtime` is explicitly loaded by the isolated proof, never production bootstrap.
const identity = new IdentityService(store, undefined, undefined, undefined,
  undefined, store, runtime);
const application = new ProviderKnowledgeApplication(store.admission, identity,
  new KnowledgeService(store, identity));
const actor = await runtime.authenticate(headers); // Outside core admission.
if (!actor) throw new Error("Authentication required.");
const result = await application.execute(knowledgeRequest, actor);
const metadata = await application.describeIdentity(actor);
```

Every authenticated application check synchronously reads the stored session,
exact active mapping and active owner principal through the guarded SQLite
owner. The projection selects no token, password, email or name and neither
calls Kysely nor borrows the provider. Missing authority, foreign/disposed
runtime, closed/timed-out provider lifetime or connection drain denies access.
The fixed adapter requires canonical UTC ISO timestamps with milliseconds.
Malformed/numeric dates and session subject, principal or creation-time
substitution fail closed. An actor cannot outlive its original expiry even if
stored expiry extends; fresh authentication obtains a new reference.

Committed session deletion denies the next operation even if after-commit
notification fails. Rollback retains access. The query is authoritative;
notifications are not an authorization cache. This validity adapter supports
Better Auth 1.7.14, implementation `0.0.0-proof.2`, storage revision 1. Other
provider/version combinations need their own verified adapter.

Each `ProviderKnowledgeApplication.execute` call is a synchronous Knowledge
phase with ordinary project/action grants, optional role ceilings, revisions
and idempotency checks. Mapping alone grants nothing. Call the application
again after an idle or lifecycle-lock wait to revalidate before the next effect
or retained result. `describeIdentity` returns safe principal/grant metadata
with `credential: null`; it returns no provider session/subject identifiers.

Provider actors do not satisfy owner administration, token issuance/renewal,
runtime sponsorship/control, privileged Knowledge approval, schedule credential
persistence, remote recovery attribution or the independent A4 vault proof.
Password-only provider evidence is not fresh privileged human proof or MFA.

The real-provider tests in `provider-authorization.test.ts` cover current
session/mapping/principal/grant/role state after queue/idle/project-lock waits,
receipt replay, failed notifications, rollback, exact object ownership,
substitution, expiry, disposal, drain and the privilege ceilings. The seven
`provider-session-history-migration.test.ts` cases cover genuine 38-to-39
preservation/rollback, malformed schema refusal, watermarks and full/logical
backup transfer. These checks establish this bounded handoff, not full A3.

### Lifecycle and authority boundaries

`cli-shutdown-admission.test.ts` exercises the owning CLI sequence in
`src/server/bootstrap/controller-shutdown.ts` with temporary Unix listeners
for HTTP, MCP, admin and remote closure. Shutdown fences new work, drains
accepted responses and completion writes, and closes SQLite only after producers
and listeners confirm closure. Failed listener, process cleanup or provider drain
retains ownership. Concurrent calls with the same handoff mode join one promise,
including its failure; changing mode is refused. A failed shutdown requires
explicit recovery rather than a second call reporting success. Controller
ownership and database ownership remain separate locks.

`restore-http-handoff.test.ts` exercises the installed HTTP handler's
`finish`/`close` callbacks, already-disconnected responses and actual deferred
restore admission/launch under provider contention. Duplicate callbacks launch
once, current token revocation denies launch, and refused shutdown prevents
execution. The production restore-failure callback joins the same handoff;
unconfirmed cleanup retains ownership without forcing process exit. Confirmed
cleanup permits lock release and failure exit, including an execution failure
after a successful drain. Successful handoff retains the controller lock and
releases the database owner before the execution callback. Physical replacement and starting
the next controller are mocked. HTTP 202 means durable admission, not successful
restore.

Installed HTTP operation/reservation/force-release requests share project
serialization. Direct-store reservation injection is not evidence of transport
takeover. These HTTP operations now carry a current-authority callback: they
recheck after body/lock/stop/readiness waits, immediately before spawn and before
returning success. Admin token rotation during a wait denies queued reservation
mutations and returns 401 to the old runtime caller. A process already started
under valid authority is not rolled back on revocation. This bounded HTTP policy
adds no provider runtime-control route; scoped lease/credential checks remain
separate. Other installation workflows still require their own activation review.

## Knowledge roles (A1)

Knowledge operations use a shared application policy in HTTP, MCP and CLI.
The persisted `owner` identity is interpreted as a human subject by that policy;
its ID, credentials, signed vault operations and historical records stay intact.
Schema migration 35 adds project-scoped role bindings without changing grants.

For existing owner/agent credentials, effective permissions are the intersection
of the explicit Knowledge grant and an optional role:

| Role | Allowed ceiling (still requires the corresponding grant) |
| --- | --- |
| `reader` | Read Knowledge, export, read attachments |
| `operator` | Reader actions plus write Knowledge, import, write attachments |
| `manager` | Operator actions plus approve; only an owner/human session |

Exports/imports and attachment permissions remain explicit grants. Roles neither
create access to other projects nor grant runtime or ENV permissions. A revoked
binding denies all Knowledge access for that principal/project, including
project discovery; it never falls back to the old grant. An absent binding
preserves existing grants. Changing/revoking the grant remains an independent
restriction. Current credential, grant and role are checked for every operation,
including an idempotent retry and requests within an existing MCP session.
Discovery filters effective permissions before pagination and reports the same
write ceiling to the dashboard.

An owner session or the existing installation authority administers roles:

```bash
worktree-control identity set-knowledge-role --principal-id <id> --project-id <knowledge-id> --role reader --expected-revision 0
worktree-control identity list-knowledge-roles --principal-id <id>
worktree-control identity revoke-knowledge-role --principal-id <id> --project-id <knowledge-id> --expected-revision 1
```

First assignment requires an active Knowledge grant and revision `0`; subsequent
changes require the current binding revision. Revocation keeps a tombstone and
increments the revision. Restoring access requires an explicit new assignment
with that revision. Repeating a stale mutation returns a revision conflict
(HTTP 409); read current state before deciding whether to retry. Audit and binding
updates are atomic. Role administration is not exposed as an agent MCP tool.
The online CLI calls `/api/identity/admin`; the offline CLI uses the same service
under the controller lock. Unknown fields and role options are rejected.

The compatibility installation authority in `open`/`token` mode still bypasses
Knowledge roles. This is not account-mode RBAC. Human account login and ENV roles remain later slices. Runtime credential
scopes and optional expiry are available through A2 below. The
shared policy denies reserved ENV actions; the existing DEV vault continues to
require its separate signed proof and exact grants, with `use` unavailable.

Full backups retain bindings, revisions, tombstones and audit. As with existing
credentials, restoring an older snapshot can restore older authorization state;
external revocation fences are an A5 gate before account-mode activation.

## Scoped runtime agents (A2)

A scoped agent can discover registered runtime projects, reserve one discovered
worktree, control its claimed managed server, select an existing literal profile
and configure preset timeouts. The accepted runtime actions are:

| Action | Operations |
| --- | --- |
| `projects:read` | Filtered `list_projects`, safe `get_project_status`, `list_worktrees` |
| `claims:manage` | Acquire, renew and release the session's own lease |
| `runtime:control` | Start, restart and stop under an active own lease; also required for `claim_project` with `start: true` |
| `profiles:select` | List literal profile names/selection/revision and select an existing profile while stopped |
| `config:write` | Read discovered preset IDs/default/override timeouts and change project-wide timeout overrides for future enqueues |

The owner delegates actions to a stable agent for each registered runtime
project. Each credential has an exact project/action ceiling. Effective access
is their intersection, requiring an active agent, credential, delegation and
stored owner sponsor. Both credential and delegation expiry apply. A sponsor
is derived from the authenticated owner session; callers cannot supply one.
The owner's session may expire without ending durable sponsorship. Revoking the
owner principal blocks sponsored authority. Knowledge grants, DEV vault grants
and remote-verification grants remain independent.
Adding actions to a delegation never widens an existing credential. Issue a new
credential with the intended ceiling; rotation can only preserve or narrow it.
These actions assign no manager role and grant no ENV or secret access.

### Owner workflow

Run these commands as the installation's OS owner, against the intended data
and state directories. They are examples, not automatic installation changes.
If no owner session exists, `identity bootstrap-owner` creates the first one;
`identity recover-owner` is the protected local OS recovery operation for an
existing owner. Recovery requires the stopped controller's singleton lock.
Save the returned owner session privately. Load it through your secret manager
into `WORKTREE_CONTROL_OWNER_TOKEN`, never as a command-line token argument.
`WORKTREE_CONTROL_TOKEN` is the fallback for older identity commands, but an
installation token cannot authorize these new commands. Open mode ignores
bearer credentials and cannot administer scoped runtime access.

```bash
worktree-control identity bootstrap-owner --label 'Local owner'
```

After bootstrap, load the private owner-token environment variable, then run:

```bash
worktree-control identity create-agent
```

Record the returned principal ID as `AGENT_ID` and the intended
registered runtime project ID as `PROJECT_ID`. Runtime project IDs come from
existing project registration, not Knowledge project IDs. This example assumes
those nonsecret variables are set and creates a delegation with no expiry:

```bash
worktree-control identity set-runtime-delegation \
  --principal-id "$AGENT_ID" --project-id "$PROJECT_ID" \
  --actions projects:read,claims:manage,runtime:control --expected-revision 0
worktree-control identity issue-runtime-credential \
  --principal-id "$AGENT_ID" --label 'Private MCP client' \
  --projects-json "[{\"projectId\":\"$PROJECT_ID\",\"actions\":[\"projects:read\",\"claims:manage\",\"runtime:control\"]}]"
worktree-control identity list-runtime-access --principal-id "$AGENT_ID"
```

`--projects-json` is a JSON array of 1–64 unique project IDs with explicit action
arrays. It supports several projects without combining their scopes. Unknown
fields/actions, repeated flags, missing values and trailing arguments are
rejected. No command accepts a raw token flag or reads scope files. Listing
returns credential metadata, stored ceilings, delegations and current effective
access, never raw tokens. Issuance and rotation print the new raw token once;
only verifiers and nonsecret metadata persist.

There is no default credential or delegation lifetime. Add `--expires-at` with
a future ISO timestamp when a bound is needed. `set-runtime-delegation` replaces
the delegation. At revision `0`, omitting `--expires-at` means no expiry.
For updates/restoration with a later revision, the CLI requires `--expires-at`:
pass the current future timestamp to preserve its bound or `none` to explicitly
remove it. Read `list-runtime-access` before changing actions. The HTTP/service
contract preserves the existing expiry when the field is omitted on an update,
including an already expired bound. Explicit null removes it; omission on creation
means no expiry. Updates and revocations require the current revision.
Revocation retains a tombstone; restoration is a new set with its revision.
Stale mutations fail with a revision conflict (HTTP 409).

### Private MCP configuration and runtime use

Use the MCP URL configured for this installation. `worktree-control config mcp`
shows its endpoint, but generates compatibility configuration rather than a
scoped credential configuration. In the client's private secret store/config,
replace its authorization header with the once-issued agent token. A template
is shown here; replace both placeholders locally:

```json
{
  "mcpServers": {
    "worktree-control-scoped": {
      "type": "http",
      "url": "<configured MCP endpoint>",
      "headers": { "Authorization": "Bearer <once-issued runtime credential>" }
    }
  }
}
```

Keep the actual configuration and tokens out of repository files, `AGENTS.md`,
`CLAUDE.md`, prompts, chat, logs and issues. The agent receives its own token,
never the owner's session or the installation token.

In that client, call `get_identity` to inspect `runtimeAccess`, then
`list_projects`, `list_worktrees` and `get_project_status`. Use the exact
returned worktree path with `claim_project`, a reason, a stable idempotency key
and an optional TTL of 30–1800 seconds. A scoped claim defaults to `start: false`.
It reserves the worktree without starting or moving the server. Set `start: true`
explicitly when execution is authorized; both `claims:manage` and
`runtime:control` are required. Alternatively acquire without starting and call
`start_project` with the returned project/reservation IDs and a new idempotency
key. `restart_project` and `stop_project` use the same own-lease requirement.
If the previous holder left a server running on another worktree, explicit
`start_project` or `restart_project` stops it and starts the claimed worktree.
`stop_project` stops the project's managed server without changing the selected
worktree or releasing the claim. Every operation still requires current
`runtime:control`; a reservation alone does not authorize runtime changes.
For example, these are MCP tool argument objects, with placeholders replaced
by discovery/claim results:

```json
{
  "projectId": "<registered project UUID>",
  "worktreePath": "<exact discovered path>",
  "reason": "Verify the requested change",
  "idempotencyKey": "verify-claim-1",
  "ttlSeconds": 900,
  "start": true
}
```

Call `claim_project` with that object. To start a previously acquired claim,
call `start_project` with:

```json
{
  "projectId": "<registered project UUID>",
  "reservationId": "<claim result reservation UUID>",
  "idempotencyKey": "verify-start-1"
}
```

Reuse a claim's idempotency key only with the same worktree, reason, TTL and
`start` choice. Conflicting retries are rejected; identical retries keep the
existing renewal deadline. After startup, the controller checks the lease and
all required actions again before reporting success. An expired or released
lease produces a stale-claim error; revoked authority produces a denial.

Check `leaseHeld`, `error` and current safe status after an operation. Release
with `release_project_claim` when finished; release does not stop the server.

These scoped tools omit ENV and profile content editing, local test admission,
logs, storage, capacity and foreign lease details. Runtime resources,
`get_project_status_compact` and `wait_for_status_change` are unavailable to
scoped agents. The HTTP runtime/dashboard API continues to reject their
credentials, including existing configuration routes; runtime access is through
these MCP tools. Test/log/ENV permissions such as `tests:run` cannot be granted.

### Independent profile and timeout access

An owner can grant either action without discovery, claim or runtime control.
For a new agent whose returned ID is `PROFILE_AGENT_ID`, grant selection only:

```bash
worktree-control identity set-runtime-delegation \
  --principal-id "$PROFILE_AGENT_ID" --project-id "$PROJECT_ID" \
  --actions profiles:select --expected-revision 0
worktree-control identity issue-runtime-credential \
  --principal-id "$PROFILE_AGENT_ID" --label 'Profile selection only' \
  --projects-json "[{\"projectId\":\"$PROJECT_ID\",\"actions\":[\"profiles:select\"]}]"
```

For another new agent, `CONFIG_AGENT_ID`, grant timeout configuration only:

```bash
worktree-control identity set-runtime-delegation \
  --principal-id "$CONFIG_AGENT_ID" --project-id "$PROJECT_ID" \
  --actions config:write --expected-revision 0
worktree-control identity issue-runtime-credential \
  --principal-id "$CONFIG_AGENT_ID" --label 'Preset timeout configuration only' \
  --projects-json "[{\"projectId\":\"$PROJECT_ID\",\"actions\":[\"config:write\"]}]"
```

Use the owner session and private client setup described above. Supply the
registered project ID and, for timeout operations, an exact discovered worktree
path through the task context when the agent lacks `projects:read`. Neither
action implies the other, `claims:manage`, `runtime:control` or a human role.

The [MCP configuration workflow](reservations-and-mcp.md#scoped-configuration-workflow)
defines the four tools, revision handling and claim rules. Profile selection
accepts an exact existing name and never creates, edits, deletes or restarts a
profile. A changed selection requires no owned process or pending cleanup.
When runtime control is separately authorized, use explicit stop, select, start
operations under the own claim. Re-selecting the current profile can be a no-op
while running, but still checks the expected revision.

`config:write` currently means preset timeout overrides only. It cannot change
commands, launch/TLS settings, ENV, literal/test profile content, preset-profile
assignments, identities, global settings or vaults. Both mutations are useful
without a claim, including on verification-only projects. Any active human or
agent reservation blocks them unless the request proves that session's exact
own agent claim. Supplying a stale reservation never falls back to unclaimed
access. A timeout request must target the claim's worktree, even when a claim
acquired with `start: false` left the selected runtime worktree elsewhere.

### Rotate and revoke

```bash
worktree-control identity rotate-runtime-credential --credential-id "$CREDENTIAL_ID"
worktree-control identity revoke-token --credential-id "$REPLACEMENT_CREDENTIAL_ID"
worktree-control identity revoke-runtime-delegation \
  --principal-id "$AGENT_ID" --project-id "$PROJECT_ID" --expected-revision 1
```

Rotation revokes the old credential atomically and prints the replacement once.
Omit `--projects-json` and `--expires-at` to preserve the old ceiling and expiry.
Supply a project/action subset or an earlier future expiry to narrow it.
Rotation cannot add projects/actions or extend a finite expiry. Update the
client's private secret and reconnect; the new session cannot adopt the old
session's claim. Credential-bound vault grants are not copied by rotation.

Revoking a credential, agent or delegation denies the next applicable call,
including retained claim/runtime/configuration receipts and failures. Automatic renewal rechecks
current authority and stops when denied. Existing leases retain their remaining
TTL; revocation does not release the lease or stop its server. Manual renew and
release also require current authority. A replacement session must wait for
expiry or ask a human to review the reservation. Already returned data cannot
be recalled.

### Upgrade and backup boundary

Schema migration 36 adds delegations, per-credential ceilings and optional
principal/credential lease bindings on the existing SQLite connection. Existing
principal IDs, credentials, Knowledge/vault/remote grants and unbound leases
remain intact. Existing agents receive no runtime backfill. Installation-token,
open and legacy compatibility callers retain their previous broad runtime
authority; scoped credentials do not isolate those callers. Migration 37 adds
the project configuration revision. Existing compatibility configuration
writes increment it alongside scoped changes; no old credential gains actions.

Opening an older database with this version applies the pending migrations. Plan an
installation upgrade with a stopped-controller backup and a compatible restore
version; do not use a live database as a test fixture or open it with an older
binary after upgrade. Full backups preserve runtime grants, ceilings and lease
bindings. Restoring an older snapshot can restore older credential/delegation
state; A5 still owns external revocation fences and cutover acceptance.

The controller removes its token and keyfile environment variables from managed
process inheritance. Scoped authorization is not an OS sandbox: repository code
still executes with the controller's host identity and its permitted filesystem
access. The original A2 projects/claims/profiles/configuration criteria are
implemented; completion requires recorded verification. Scoped finite-job
admission/own-run access (`415205f2-4583-4b13-a508-49a9b618a19e`) and scoped
resources/compact status/wait (`e0bfe2b5-d1cf-4f1e-ae67-13ab3a542f21`) remain
separate followups and are denied. A3 owns account GUI/human administration, A4
ENV policy and A5 compatibility cutover. This describes source behavior, not a
live installation upgrade.

## The `auth` command

```bash
worktree-control auth status
worktree-control auth token generate
worktree-control auth token rotate
worktree-control auth mode set <open|token|better-auth>
```

When the controller is stopped, the command opens the database under the
controller's singleton lock. When it runs, the command talks to it through an
owner-only Unix socket, `admin.sock` in the state directory. The socket is
`0600` inside a `0700` directory. Access to this private IPC channel is OS-user
authority, not proof of which executable made the request. Public HTTP, GUI and
MCP have no mode selector.

`auth mode set` saves the next-start selection and its audit atomically. It does
not restart the service, rebind listeners, disconnect clients or change live
access links. Selecting the same configured mode is a no-op. Selecting the
active mode cancels a pending selection. Changing modes never generates or
rotates a token; select `token` only after explicitly generating one.

Private CLI/admin status reports `mode`, `activeMode`, `configuredMode` and
`restartRequired`, alongside the existing safe token metadata and generation.
For example, running token mode after selecting open reports
`mode: token, activeMode: token, configuredMode: open, restartRequired: true`.
When stopped, `activeMode` is null, `mode` is the configured selection, and
`restartRequired` is false. These fields are private administration data, not
public browser metadata. Live client configuration continues to use active mode.

Only mode is captured at boot. Each authorization still reads current token
ID/verifier, principal status and grants. Rotation invalidates the previous
bearer and retained installation actors immediately, even with a pending mode.
It also closes MCP sessions and live dashboard connections. Token generation
and future-mode selection do not disconnect them. New selectors are refused
after maintenance begins, including selectors queued behind database work.

`token generate` and `token rotate` print the token once. The first `start` or
`service install` of a new installation does the same; see
[Use token mode](#use-token-mode). The controller stores only a hash; a lost
token cannot be recovered, only rotated. Rotation
invalidates the previous token immediately. Save the token in a password
manager and keep it out of issues, logs and shared shell history.

There is no command to return to `legacy`.

## Use token mode

A new installation starts in `token` mode without a token. The first
`worktree-control start` or `worktree-control service install` run from an
interactive terminal creates it, exactly as `auth token generate` would, and
prints it once with a reminder to save it. `start` then keeps running;
`service install` prints the token before the service starts, so it never
reaches the service log. Save the token in a password manager straight away.
If you lose it, run `worktree-control auth token rotate`.

The controller prints a new token only to an interactive terminal. When output
goes to a pipe, a file or a service log (CI, scripts, `--service-mode`), `start`
and `service install` refuse and ask you to run `auth token generate` first.
Run it in a terminal, save the token, then repeat the command.

- **Browser:** the dashboard asks for the token and keeps it for the browser
  tab's session. **Sign out** forgets it. `service open` and `service url` open
  the dashboard without a secret.
- **CLI against a running controller:** export `WORKTREE_CONTROL_TOKEN`.
  Offline `project` and `auth` commands need no token.
- **Knowledge and identity administration:** `identity`, `knowledge` and
  `backup` project commands accept `WORKTREE_CONTROL_TOKEN` when no owner or
  knowledge token is set. The installation token retains compatibility administration authority.
  New runtime delegation/credential commands require a real owner session.
- **MCP:** send `Authorization: Bearer <token>`. `config mcp` prints a
  placeholder, or the real token when `WORKTREE_CONTROL_TOKEN` is set.

Before the 2026-10-05 rename these variables were named `WORKTREE_SWITCHER_*`
and the dashboard header `X-Worktree-Switcher-Token`. The CLI still reads a
legacy variable when its `WORKTREE_CONTROL_*` name is unset and prints a
deprecation warning; the controller still accepts the legacy header. Move
scripts to the new names.

## Use open mode

`open` removes authentication. Use it only on a trusted, single-user machine
with the controller bound to loopback. The dashboard shows a red **open mode**
badge and the controller prints its listening address on start.

```bash
worktree-control auth mode set open
worktree-control service restart
```

The explicit restart activates the selection. Until then, the running controller
continues to enforce its previous mode.

### CLI in open mode

CLI commands need no token environment variable in `open` mode. The online
knowledge CLI and identity administration omit the `Authorization` header and
the controller applies the active mode. Offline identity administration, Hub
`knowledge execute-import` and logical `backup export-project` /
`import-project` read the persisted mode after acquiring the singleton lock.
Every such caller acts as the anonymous installation authority. New runtime
delegation/credential administration rejects that authority, even if an owner
token variable is set; use `token` or `legacy` mode with an owner session. Knowledge
history records it as `authenticationMethod: none`; Hub import batches record
only the `installation` principal. A token variable set in
`open` mode is ignored. In `token` and `legacy` modes the same commands still
reject a missing, invalid or revoked credential, and scoped agent tokens keep
their grants.

## Move a legacy installation to token mode

1. Stop the controller and take a backup:
   `worktree-control service stop`, then
   `worktree-control backup create <directory>`, then
   `worktree-control service start`.
2. Generate the token and save it privately:
   `worktree-control auth token generate`. Token mode cannot be selected
   without it.
3. Select the next-start mode: `worktree-control auth mode set token`.
   Pairing and `mcp-token` keep working in the running legacy boot.
4. Restart explicitly with `worktree-control service restart`. The new boot
   applies token mode and stops accepting pairing and `mcp-token`. Sign in to
   the dashboard with the token in each browser.
5. Replace the bearer token in every MCP client with the installation token.
   Agents that use scoped `wts_` tokens need no change.
6. Export `WORKTREE_CONTROL_TOKEN` where you run online CLI commands.

If a client still fails, run `auth status` to confirm the mode and the token
prefix. Rotate the token if it may have leaked.

## Upgrade notes and breaking changes

Upgrading an existing installation keeps it in `legacy` mode. The pairing link,
`mcp-token` and owner sessions keep working until you migrate. These changes
apply after the upgrade:

- **No downgrade.** The upgrade applies database migration 25. Controller
  backups record schema version 25, and older versions refuse to restore them.
- **No return to `legacy`.** After a restart activates `token` or `open`,
  the pairing link and `mcp-token` stop working. A pending selection can still
  be cancelled by selecting another supported mode; `legacy` is never selectable.
- **Knowledge exports.** History entries can record the `installation_token`
  and `none` authentication methods. Older versions reject such exports.
- **Owner bootstrap over HTTP** (`/api/identity/bootstrap`) works only in
  `legacy` mode. The offline `identity bootstrap-owner` command is unchanged.

New installations differ from earlier releases:

- The first interactive `start` or `service install` creates the installation
  token and prints it once. Without an interactive terminal, both refuse until
  `auth token generate` creates it.
- The controller prints no pairing link. `service open` and `service url` show
  the sign-in page.
- `config mcp` prints a token placeholder unless `WORKTREE_CONTROL_TOKEN` is
  set.
- Online CLI commands need `WORKTREE_CONTROL_TOKEN`.

## Restore and pending mode selection

A token-authorized restore keeps the immutable active execution mode separate
from the configured policy restored into the next boot. Format-2 durable
handoffs require `executionMode`; format-1 records retain their historical
`authentication.mode` interpretation. Missing, unknown or inconsistent new
records fail closed. The captured token ID remains current, and existing
credential/revocation fences and ownership locks still apply. A pending open
selection therefore cannot authorize a restore or invalidate an admitted token
restore. Recovery writes the captured configured policy before constructing the
new boot's authentication service. No SQLite migration is needed; controller
schema stays 39 and provider storage revision stays 1.

This does not solve A5 provider-session resurrection after restoring older
password/session data. External restore revocation fencing, account authentication,
readiness of optional methods and complete transport coverage still gate
production RBAC activation.
