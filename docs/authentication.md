---
audience: "people running Worktree Control and choosing how callers authenticate"
last_reviewed: "2026-11-07"
source_of_truth: "authentication modes, owner CLI and scoped runtime agent workflow"
status: "active"
---

# Authentication modes

For planned human accounts, project roles, scoped agents and ENV permissions,
see the [identity and authorization plan](identity-authorization-plan.md).
A1 Knowledge roles and A2 scoped projects, claims, runtime control, profile
selection, timeout configuration and finite verification are implemented below.
Protected ordinary human accounts and isolated cookie-based Knowledge access are also implemented.
Production account activation and ENV roles remain gated.

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
public account endpoints. Production startup now owns the shared provider
composition described below; the bounded browser adapter remains unmounted
on production listeners. See [browser adapter](#bounded-browser-adapter).

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
Temporary fixtures mount the browser adapter using either the original isolated
proof or the shared controller composition. Production account mode remains unavailable.

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
owner ID. Schema 42 extends that mapping to a distinct active `human` principal.
Resolution checks the current session, exact mapping and stored kind; email and
display name grant no authority. Cookies never manufacture an `owner_session`.
A2 machine credentials and scoped runtime policy remain unchanged.

Controller schema 39 adds `provider_session` only to the Knowledge history
method constraint. It preserves historical rows, IDs, timestamps, indexes and
the AUTOINCREMENT watermark, including empty history. Migrations 1..38 and their
checksums remain unchanged. No identity,
credential, role or grant backfill occurs, and owner-only import batches retain
their existing method constraint. History metadata and authorized logical
export/import recognize the honest provider audit method.

Controller schema 40 adds the frozen two-factor and passkey plugin storage plus
recognized account protection; see [integrated factor authority](#integrated-factor-authority).
Schema 41 adds durable session issuance; see [closed factor HTTP API](#closed-factor-http-api).
Schema 42 widens only the core principal kind for ordinary humans; provider
contract 5, storage revision 3 and implementation `0.0.0-proof.5` are unchanged.
Full controller backups record the current schema and include provider rows.
Genuine schema-38, schema-39, schema-40 and schema-41 snapshots can be restored and upgraded on open.
Older binaries reject a newer schema; restoring a backup is not a downgrade procedure. Restoring a snapshot can revive old sessions and
passwords; the external revocation/recovery fence remains A5 work. Better Auth
stores bearer session tokens, and the proof's native sign-in and password-change
JSON responses include session tokens. Those responses are not an approved
browser API design. Password-only evidence is neither MFA nor an ASVS Level 2
claim. Numeric session, reset, password and rate limits are proof settings,
not approved product defaults. A4 vault proof remains separate.

Optional-factor production integration, invitations, general delegated roles,
GUI and the A5 activation gates remain open in Knowledge task `ec4c7258770328ca33fb1801be6831f6`. The optional
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
and supported server callbacks. A3-I15 extends the same proof to ordinary
privacy-preserving `fmt:none` registration as untrusted staged state. A separate
fresh native signed UP/UV assertion must confirm the exact credential, issued
handle and original authorized password-session context before promotion.
Confirmation deletes its native-created session atomically, emits no cookie and
leaves the original session and password evidence unchanged. Normal login refuses
staged keys; later passkey login returns the existing nonauthorizing observation.
Packed signed enrollment remains supported. Browser UV requests are also required.
Staging/confirmation use bounded owner-controlled state and immutable deadlines;
COMMIT uncertainty withholds output. These fixture limits are not product defaults.
Temporary owner-made
schema and nonauthorizing `passkey_uv` observations stay inside that fixture. The
plugin has no durable session-method or enrollment-UV history;
[integrated factor authority](#integrated-factor-authority) supplies it. See the
[proof details](../packages/auth-provider-better-auth-proof/README.md#a3-i14-passkey-proof).

A3-I17 replaces the fixture's lifetime presentation ledger with one monotone
`last_step` per opaque subject, shared across enrollment, login and explicit
current-session reauthentication. Native verification stays necessary. A reusable
private-package helper then uses the public `hotp` primitive over a bounded
interval of at most four counters and consumes the highest matching step. The
guarded update joins native success, evidence and receipt in one transaction, after
a separately committed attempt charge. Any observer or update refusal rolls native
success back. Reauthentication returns only a nonauthorizing observation, with no
new session or cookie.

The counter survives factor replacement, verification toggles, re-encryption,
reload and clock changes, and no reset exists. A second ceremony in one step needs
a newer code, which can take longer than one period after a future-window code. A
later identical decimal string at a newer counter is accepted. The helper does not
claim native's hidden matched step, and it is not activated in any provider. See
the
[mechanism and API limits](../packages/auth-provider-better-auth-proof/README.md#a3-i17-totp-step-candidate).

These are selected product capabilities and local feasibility work, with no live
activation. Four original replay failures and the old bounded counter-loss failure
remain visible in the native/bounded baselines. The later integrated authority
and closed HTTP sections describe the current isolated step/evidence storage
and response handling. Production activation, factor management/recovery and A5
remain gates before public account activation. Password-only access proves no
MFA, and no ASVS Level 2 conformance is claimed.

### Protected provider maintenance

The protected local commands are:

```text
auth provider status [--principal-id ID]
auth provider configure --input-stdin
auth provider owner create
auth provider human create
auth provider human list [--limit 1..20] [--after ID]
auth provider human disable --principal-id ID
auth provider knowledge-access list --principal-id ID [--limit 1..20] [--after PROJECT_ID]
auth provider knowledge-access set --input-stdin
auth provider knowledge-access revoke --input-stdin
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
configuration refuses maintenance. If only the old provider module has moved or
disappeared, protected configuration can select a validated replacement while
preserving the exact signing material. Reading/loading still validates the
selected module; replacement never bypasses private-file, document or secret checks.

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
status, principal creation, human lists/disable and membership commands do not
import provider code. The first explicit enroll or
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
Same-OS-user agents share operator authority. Host isolation, delegated account
administration, full A3 acceptance and production RBAC remain separate gates.

### Shared controller provider composition (P1)

`src/cli/index.ts` constructs `createControllerAuthentication` once and passes its
IdentityService to the controller, MCP, Knowledge, vault and other application
services. Protected administration and the internal bounded-browser preparation
method share its single retained load promise, pinned private configuration and
provider runtime. Repeated browser preparation returns the same adapter and its
capacity counter; changing its origin, Knowledge service, runtime read service or trusted fixture peer
requires a new owner. The stopped CLI uses the same composition through
`createAuthenticationAdministration`. Neither path opens another database or
upgrades a core admission into a provider borrow.

Loading remains lazy. Enrollment, recovery or internal browser preparation first
runs the existing store-owned ordinary-restart session recovery, then loads the
configured module. Restored or unconfirmed provenance refuses recovery before
loading and leaves pending markers intact. This preserves the restore refusal;
it does not implement the external P3 recovery/revocation fence.

The shared identity checks the exact runtime-owned actor and current stored
session, subject mapping, principal and protection evidence on every admitted
authorization. It also checks that the pinned configuration is still valid and
unchanged. Expiry, logout, recovery, revocation, account disablement, maintenance
and disposal deny retained actors without depending on notification delivery.
The browser adapter repeats the configuration guard after admission and before
response release. Body reads remain outside admission. Accepted preparation and
administration drain through one disposal before SQLite closes; uncertain cleanup
retains ownership and the same rejected disposal promise. Reserved cleanup may
settle only this runtime's own unpublished sessions after the fence; it cannot
admit new authentication or sweep restored pending rows.

Internal browser preparation requires a canonical HTTPS origin equal to the
protected provider configuration. Its explicit controller engineering bounds are
64 unreleased sessions, 4,096 native session rows across boots, reconciliation in
batches of 32, and 16 concurrent requests with four slots reserved for completion.
Bodies are capped at 8 KiB for passwords, 64 KiB for WebAuthn and 128 KiB for
Knowledge; cookies at 8 KiB; body reads at 10 seconds. JSON bounds are depth 8 /
128 fields for authentication and depth 16 / 2,048 fields for Knowledge. Loader
and transport validators enforce these inputs. These capacity choices are
separate from fixture limits and from account-security policy. They do not
mandate MFA or enable optional factors without their explicit provider policy.

Existing accounts enroll by principal ID. The production composition test creates
a temporary pre-existing owner `69849424-2aba-4fdd-b4fa-a394a77a193c`, then configures
and enrolls it while preserving its kind, credentials, grants and history. It
performs no live enrollment and never uses owner creation to replace that account.

`requireSelectable` still rejects `better-auth`, and private status still reports
`productionAccountModeAvailable:false`. Startup does not mount public login in
open/token/legacy modes. Provider sessions gain neither owner-session nor
installation authority, and never replace signed Ed25519 vault proof. P2a supplies
the reader workflow below, and P2b1 adds explicit human runtime leases and control.
Remaining P2 transport enforcement and P3 protected recovery/restore
fencing remain activation gates.

### Human runtime readers (P2a)

Protected local administration can explicitly assign `reader` plus
`["projects:read"]` to an active existing owner or ordinary human. The target
is `{kind:"runtime-project",id:PROJECT_ID}`. There is no default project access,
including for an owner. Knowledge grants, memberships and runtime links confer
no runtime access, and runtime membership confers no Knowledge rights.

```sh
worktree-control auth provider runtime-access list --principal-id HUMAN_ID --limit 20
worktree-control auth provider runtime-access set --input-file /private/runtime-reader.json
worktree-control auth provider runtime-access revoke --input-stdin
```

Set input contains the full aggregate:

```json
{"principalId":"HUMAN_ID","scope":{"kind":"runtime-project","id":"PROJECT_ID"},"role":"reader","permissions":["projects:read"],"expectedRevision":0}
```

Revoke takes `principalId`, `scope` and `expectedRevision`. Both changes and their
audit commit atomically with one revision. Revocation retains a tombstone; a
restore requires its latest revision and a complete explicit set. Lists use
`limit` from 1 through 20 and an optional `after` project ID, returning
`nextAfter`. CLI private file/stdin handling and the private administration
socket share the same application operation. Membership maintenance does not
load the provider. No HTTP or MCP membership setter exists.

Migration 45 adds only `runtime_human_memberships` on the existing SQLite
connection. Migrations 1..44, principal IDs/kinds, grants, credentials and history
remain intact. Upgrade creates no membership. Recognition, backups and restore
include the new table; provider contract 5, storage 3 and proof implementation 5
are unchanged. A disabled principal cannot read even while its membership persists.

The internal `prepareBrowserAuthentication` seam accepts the existing controller
as its `runtimeReads` port. One closed cookie route, `POST /api/runtime/read`,
accepts exactly these requests:

```json
{"operation":"list-projects"}
{"operation":"project-status","projectId":"PROJECT_ID"}
{"operation":"list-worktrees","projectId":"PROJECT_ID"}
```

Responses carry the operation and respectively `projects`, `status` or
`worktrees`. Lists filter by current effective `projects:read`. Status and
worktrees reuse the scoped allowlist: identity/name/port, phase and placement,
claim relation, and discovered path/branch/head/dirty metadata. They expose no
commands, ENV/TLS/profile values, logs, foreign lease owners/secrets, global
queue or capacity. Humans cannot own an agent lease. P2b1 additionally recognizes
`own` only for the exact current provider session and original human lease
authority; an ordinary reader still sees `none` or `other` with no `ownClaim`.
This slice adds no SSE, waits or cursors.

Authentication uses the real provider cookie outside core admission. Shared
IdentityService and application policy require the exact runtime-owned actor,
current session/principal/evidence and explicit membership. Git discovery
releases admission and checks current authority after readmission. The adapter
rechecks and emits the response in the final admitted phase. Logout, recovery,
expiry, disablement, revoked/removed/invalid membership and missing provider
authority deny retained results. Unknown and forbidden project IDs share a
fixed 403 `project_access_denied`. Copied actors and actors issued by another
runtime fail authentication. Identity metadata contains only effective runtime
actions, never provider subjects or native session identifiers.

The route inherits canonical HTTPS Host/Origin, CSRF/Fetch Metadata, socket-peer,
cookie sanitation, strict JSON, cancellation, no-store and the existing request
capacity/lifetime. Its body is capped at 4 KiB (or the smaller configured password
body limit), with authentication JSON depth/field limits. GETs, query strings,
extra role/scope fields and mutation operations are refused. Raw runtime routes
remain closed to provider cookies. Reader membership grants no claims, runtime
control, profiles/configuration, tests/jobs, administration, delegation or ENV/
vault access; agent delegation and credential ceilings keep their existing behavior.
Selected optional TOTP/passkeys and separate Ed25519 vault proof retain their gates.

This is backend source implementation and isolated real-provider verification.
Production startup still does not mount public login or this cookie workflow;
`requireSelectable` continues to refuse account-mode selection. Remaining P2/P3 stay
required before activation. In particular, the P1 restored-provenance refusal
continues across reboots and is not a completed protected-recovery mechanism.

### Human runtime operators and leases (P2b1)

The same protected `runtime-access set/list/revoke` workflow now accepts
`operator` with a nonempty, unique explicit subset of `projects:read`,
`claims:manage`, `runtime:control`, independent `tests:run` (P2b2),
`profiles:select` and timeout-only `config:write` (P2c). A role grants no implicit actions.
Reader remains exactly `["projects:read"]`. Existing aggregates are copied
unchanged into schema 46; no existing owner, credential or grant gains rights.
For example, an operator who can reserve and control but cannot read uses:

```json
{"principalId":"HUMAN_ID","scope":{"kind":"runtime-project","id":"PROJECT_ID"},"role":"operator","permissions":["claims:manage","runtime:control"],"expectedRevision":0}
```

The internal composition accepts a `runtimeMutations` controller port. Its
closed `POST /api/runtime/mutate` route accepts these strict discriminated DTOs:

```json
{"operation":"claim","projectId":"PROJECT_ID","worktreePath":"DISCOVERED_PATH","reason":"Task","idempotencyKey":"claim-1","ttlSeconds":1800,"start":false}
{"operation":"renew","projectId":"PROJECT_ID","reservationId":"RESERVATION_ID","idempotencyKey":"renew-1","ttlSeconds":1800}
{"operation":"release","projectId":"PROJECT_ID","reservationId":"RESERVATION_ID","idempotencyKey":"release-1"}
{"operation":"start","projectId":"PROJECT_ID","reservationId":"RESERVATION_ID","idempotencyKey":"start-1"}
{"operation":"restart","projectId":"PROJECT_ID","reservationId":"RESERVATION_ID","idempotencyKey":"restart-1"}
{"operation":"stop","projectId":"PROJECT_ID","reservationId":"RESERVATION_ID","idempotencyKey":"stop-1"}
```

Claim, renew and release need `claims:manage`; explicit claim `start:true`
also needs `runtime:control`. Start/restart/stop need `runtime:control` captured
at claim and still held now. No operation implicitly grants `projects:read`.
Claim defaults to `start:false`. TTL defaults to 1800 seconds and accepts
30..1800; each deadline is capped by the original provider session deadline
and an eight-hour absolute lease maximum. Less than 30 seconds remaining
refuses admission/renewal. Stop retains the lease; release retains the running
process. Expiry and revocation do not automatically stop an already authorized
process. Inspect current placement before a new intent after uncertainty.

Shared runtime operations resolve only the exact opaque runtime-issued actor
against current session, principal, mapping and evidence. A server-only digest
binds the actual provider/session identity, evidence identity, protection
generation and original principal linkage. Each lease also captures the exact
membership revision and explicit permissions. Every later decision requires
both captured and current authority. Revoke/regrant, revision changes, logout,
recovery, expiry or a different login cannot attach new authority to an old
lease. The same still-valid cookie resolves the same binding across requests
and ordinary controller reboots. Restored provenance remains fenced by P1;
these semantics do not implement the P3 external restore/recovery fence.

Schema 46 uses the existing `reservations` table, a permanent provider-bound
marker and a typed lease sidecar on the sole SQLite connection. Finite deadlines
are stored in the sidecar and projected by existing reservation reads. Legacy
human records and agent credential/session/hash requirements remain unchanged.
The old unbound owner-string authorization/release path rejects marked leases,
even after sidecar cleanup. Human operations use a dedicated bound-claim
verifier and the existing project lock, process ownership and capacity gates.
Trusted local operator force-release remains separate; this route has no force
parameter. No machine credential, MCP session or second client lease secret is
created. Identity/HTTP/log projections contain no session IDs, cookies, binding
digests or evidence internals.

The application checks current rights at admission, after project-lock/Git/
provider waits, before external runtime effects and spawn, and in the admitted
final delivery/replay phase. Only the exact current binding can see `ownClaim`.
Runtime receipts use an allowlist, omit global capacity/ENV/commands/foreign
lease details, and contain safe operation results even without project-read
permission. The closed route inherits the existing Host/Origin/CSRF/cookie/
socket-peer/lifetime/slot guards and 4 KiB body limit. Only read and mutate are
claimed as runtime routes without a cookie; unknown cookie routes fail closed.
Provider authentication stays outside core admission. Cancellation keeps the
HTTP slot until the actual work settles.

Normalized idempotency intent is durable before effects and scoped to the real
session/principal/project/operation/claim. Reusing a key for different intent
conflicts. Concurrent pending retries and interrupted intent after reboot
return `outcome_unknown`, requiring inspection; they never automatically rerun
an effect. Completed receipts replay only after current/original authority and
reservation checks. A disconnect can leave a completed or unknown outcome;
failed runtime receipts also retain their original intent. Intent retention is
bounded to 4096 globally, 128 per session, and 8192 bytes per receipt; leases
have a 4096-sidecar cap. Exhaustion refuses new work. Intent keys expire only
when their original provider session deadline has passed; sidecars expire only
after their absolute maximum, while the reservation marker persists.

`pnpm test:runtime-mutations` covers core migration/policy/transport guards and
real-provider cookies with finite process doubles, including another session,
principal, agent, revocation races, disconnect/retry and database/provider reopen.
No development server is needed. P2b2 supplies the independent jobs and bounded
run-wait workflow below. P2c supplies explicit profile selection and timeout
configuration. Logs, capacity, delegation, administration and ENV remain denied
pending their own workflows. Optional factors and separate vault
signatures retain their existing policy. P3/A5 and public activation remain
open; this backend workflow does not mount a public login listener.

### Human finite verification (P2b2)

Protected `runtime-access set` accepts `operator` with exactly `["tests:run"]`,
or an explicit subset including that action. It adds no default grants and
implies no project read, claim, runtime control, profile, configuration or ENV
rights. Reader remains exactly `["projects:read"]`. Knowledge memberships and
owner status supply no test authority.

The internal shared composition accepts the existing controller as its
`verification` port. Closed `POST /api/runtime/tests` accepts these strict DTOs:

```json
{"operation":"presets","projectId":"PROJECT_ID"}
{"operation":"enqueue","projectId":"PROJECT_ID","worktreePath":"DISCOVERED_PATH","presetId":"node:test","idempotencyKey":"test-1"}
{"operation":"status","runId":"RUN_ID"}
{"operation":"wait","runId":"RUN_ID","cursor":"CURSOR","timeoutMs":20000}
{"operation":"cancel","runId":"RUN_ID"}
```

Enqueue may additionally name `reservationId`; status, wait and cancel may
add `projectId` to constrain the known run. No request supplies an actor,
principal, session, command, environment or profile. Discovery is limited to
64 discovered non-prunable worktrees, 256 presets and 64 KiB. It returns only
exact paths and clean-profile preset IDs/timeouts. Execution revalidates the
worktree and trusted shell-free command through the existing resolver. Clean
profiles retain their declared literals and fixed system allowlist; inherited
server profiles and vault delivery remain unavailable.

An unclaimed project can enqueue with tests-only rights. If a claim exists,
its exact original human session, membership revision and worktree must match.
The run captures either no claim or that claim ID. A later claim, including a
replacement by the same session, release or expiry blocks dispatch and retry.
New rights never attach to an accepted run retroactively.

All human own-run reads, waits, cancellation and replay require the exact
**original provider session** and current original membership revision and
evidence, including for completed runs. A new login or revoke/regrant cannot
adopt history. A durable key is scoped to its principal and cannot duplicate
an old run when retried by another session. A separate durable key ledger
survives detailed-run retention until the original session deadline. It refuses
retry when details have been removed and never evicts live keys under pressure.
The bounds are 4096 keys globally and 128 per original session.
The original still-valid cookie
retains this relationship after an ordinary controller reboot. Existing
interrupted-run recovery remains in force; reopening never reruns stale jobs.
Read/cancel authority does not depend on continued claim ownership; the claim
fences execution and enqueue replay. Revocation does not kill an already
running process. Existing process cancellation/cleanup semantics remain.

Schema 47 adds a permanent `test_runs.provider_bound` marker and an immutable
human requester sidecar, atomically with run/summary creation on the sole
connection. It preserves SQL/checksums 1..46 and all old rows without backfill.
Human attribution uses no fake credential or MCP session. A server-only native
session row reference permits current provider lookup, contains no cookie or
token, and stays outside DTOs, logs and audit payloads. The provider validates
current session/account/mapping/evidence/generation/expiry rows. Persistence
alone grants no authority. Missing/corrupt marked attribution refuses lookup,
replay, dispatch and pre-spawn instead of falling through to legacy execution.
One typed queue dispatcher preserves the existing agent checker alongside the
human checker; requests cannot replace it.

Shared operations recheck after Git, project-lock and database-admission waits,
at dispatch and pre-spawn, and before delivery. SQL-free waits release the same
connection admission. Run envelopes reuse scoped allowlists and `StatusService`
sampling, cursors and waiter budgets. Cursors bind principal, actual session
and run; waits accept at most 20 seconds and clean up on disconnect, timeout,
authority loss and shutdown. Envelopes reveal no logs, commands, ENV, profiles,
requester/session internals, queue positions or global capacity. Unknown and
forbidden runs return the same denial. The closed route retains POST-only,
strict duplicate-key JSON, 4 KiB body, current cookie, Host/Origin/CSRF,
no-store and slot-until-settlement guards. Authentication remains outside core
admission. Legacy installation tokens cannot bypass this cookie path.

The agent contract is unchanged: the same credential in a new MCP session may
read a known run; cancellation requires its original session. Human sessions
are never represented as agents for ownership, waiter budgets or cursors.
Optional TOTP/passkeys and separate Ed25519 vault proof retain their policies.
`pnpm test:human-jobs` exercises real provider composition, temporary native
sessions, the existing finite queue and migration/transport/policy regressions.
P2 remaining profile/configuration and transport parity, P3 protected recovery
and external restore fencing, and A5 activation remain open. The public mount
and `requireSelectable` gate stay closed.

### Human literal profiles and preset timeouts (P2c)

The shared controller composition accepts the opaque actual provider-session
actor for profile and timeout operations. An operator receives an explicit
`profiles:select` or `config:write` permission on one runtime project. Either
permission works alone. Reader remains exactly `projects:read`; claims, runtime
control and tests grant neither configuration action. Protected CLI/IPC
`runtime-access set/list/revoke` validates strict JSON and membership CAS before
loading the provider. No default grant or owner exception is added.

The closed POST `/api/runtime/configuration` adapter offers `profiles`,
`select_environment_profile`, `configuration` and `set_test_preset_timeout`.
Profiles expose only existing literal names, current selection and configuration
revision. A changed selection requires no owned process, including startup,
shutdown and failed cleanup. An unchanged selection may return a no-op. Selection
never starts, stops or restarts a process. Timeout reads expose only discovered
preset IDs, defaults, overrides and revision for the exact discovered worktree.
Setting or clearing an override affects future enqueues; queued and running jobs
keep their captured timeout. Existing bounds apply. Neither action exposes ENV
names/values or vault references, edits profiles, assigns test profiles, accepts
commands, or changes launch, TLS, identity or global settings. Selecting a literal
profile supplies no vault-use grant and preserves existing execution guards.

An unclaimed mutation needs no claim permission. With an active claim, it needs
the exact original human lease, session, evidence, generation, membership revision,
permission ceiling and pinned worktree. Consuming that lease requires the relevant
configuration permission in its original ceiling, without another
`claims:manage` authorization check. A regrant changes revision and cannot attach
new rights to an older lease. Foreign human, agent and legacy claims refuse access.

Authority is checked before lookup, after the shared project lock, after Git idle
and database readmission, immediately before the synchronous atomic effect, and
before delivery. Durable intents freeze the original absence of a claim or the
exact lease and placement. A later claim, including one created by the same
session, cannot adopt an intent or release its cached receipt. New logins,
revocation, expiry and regrants cannot take over earlier authority.

Additive migration 48 preserves migrations/checksums 1 through 47 and copies
memberships unchanged. Configuration uses the existing human runtime intent ledger
and its shared limits of 4096 total, 128 per original session and 8 KiB per receipt.
Live keys are never evicted; retention ends at the original session deadline.
An immutable typed context and marker distinguish configuration intents. The
shared agent/human mutation implementation uses one SQLite transaction for the
change, common configuration revision, safe human audit and completed receipt.
No-op receipts add no change event or revision. A conflicting CAS or failed receipt
write leaves no partial configuration effect. Retries require original current
authority and the original claim contract; changed effective inputs conflict.
Pending unknown outcomes are refused, never retried automatically after restart.
Audit identifies the real principal and provider-session method without a fake
machine credential, session handles, cookies or ENV content.

This backend slice extends the internal composition only. Public browser mounting,
account-mode selection, protected recovery and external restore fences remain
separate gates. The P1 restored-provenance refusal and optional TOTP/passkey and
signed Ed25519 vault policies remain in force. The historical five full-proof
factor compatibility failures remain visible; these fixtures establish no
production-readiness claim. Evidence and acceptance belong to Knowledge A3.

### Bounded browser adapter

`AuthenticationHttp` is an exported core-owned Node HTTP adapter. The isolated
`composeIsolatedBrowserAuthentication` helper wires the existing immutable
`AuthenticationService`, loaded runtime, seventh-argument identity authority and
`ProviderKnowledgeApplication`. `createControllerServer` calls it before blanket
core admission when an adapter is supplied. The production CLI owns the shared
provider lifetime above, but supplies no browser adapter to the public listener.
Neither composition makes `better-auth` selectable. No login GUI is implemented.

The public production `GET /api/auth/status` returns only active `mode` and
`loginAvailable: false`. It exposes no pending selection, token metadata, account
existence, provider path, diagnostics or grants. The isolated adapter supports:

| Exact request | Strict input | Sanitized success |
| --- | --- | --- |
| `POST /api/auth/sign-in/email` | `{email,password}` | `{authenticated:true}` and validated cookie, or `{authenticated:false,outcome:"challenge",method:"totp"}` with no session |
| `GET /api/auth/get-session` | No query or body | `{authenticated:false}` or `{authenticated:true,principal:{id,kind},expiresAt,authentication:{method,factors}}` |
| `POST /api/auth/sign-out` | `{}` | `{authenticated:false}` after durable deletion |
| `POST /api/auth/change-password` | `{currentPassword,newPassword}` | `{changed:true}` and replacement cookie |

When the composition supplies factor limits, the
[closed factor routes](#closed-factor-http-api) are added. Without them those
paths get the generic denial. All other native routes, methods, extra fields and
path aliases are denied before provider invocation. There is no native catch-all,
signup, reset, redirect, social/linking, user-update or administration endpoint.
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
fail compatibility checks. That contract change was independent of controller
schema. Contract 3 adds the account protection port, with storage revision 2.

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
session ID, subject, principal, exact stored kind, mapping link time, creation time
and expiry. Copies, structured
clones, raw `runtime.resolve` evidence and another runtime's actors do not
authenticate. Its public fields are `principalId`, `principalKind: "owner" | "human"`,
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
exact active mapping and active owner or human principal through the guarded SQLite
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
Better Auth 1.7.14, implementation `0.0.0-proof.5`, storage revision 3. Other
provider/version combinations need their own verified adapter.

Each `ProviderKnowledgeApplication.execute` call is a synchronous Knowledge
phase with ordinary project/action grants, role ceilings, revisions
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

### Integrated factor authority

A3-I18 connects TOTP and passkeys to the real optional provider, recognized
storage and the provider handoff above. Account mode stays unavailable, and no
public route, browser flow, CLI selection or live activation follows from it.
Default HTTP mounting still exposes only the four password and session operations.

Migration 40 freezes the DDL that pinned Better Auth 1.7.14 compiles for its
two-factor and passkey plugins, and a test recompiles it from a genuine schema 39.
It adds account policy and generation, one monotone TOTP step per subject, passkey
trust and staging, attempt contexts, budgets, receipts and immutable session evidence.
It backfills nothing. A password account has no policy row and its old sessions
authorize nothing until a fresh real sign-in. Subject-keyed rows restrict deletion,
so recreating an opaque subject cannot reset a step or generation.

`AccountProtection` is the one application-owned policy for both methods. It reaches
the provider as `host.protection` on contract 5, joined to the provider's open
transaction on the sole connection. The supported combination is contract 5,
storage revision 3, implementation `0.0.0-proof.5` and library 1.7.14.
Contract 4 added the explicit issuance/WebAuthn limits and named admission and
settlement refusals. Contract 5 adds the durable session obligations below: session
evidence requires the native session's open transaction, and a host that lacks
schema 41 cannot honor them. Older contract and storage combinations are rejected
before `create`, and there is no mixed-version compatibility allowlist. A native
passkey failure after verified proof is a fixed provider error, rather than a
wrong-credential response.

- **Evidence.** The success transaction records the verified method (`password`,
  `password_totp` or `passkey_uv`), original authentication time and deadline,
  generation, policy revision, credential binding and attempt. Refresh never rewrites
  it, and a replaced session after a password change inherits it. The actor's
  deadline is the earlier of the original deadline and the native expiry.
- **Selection.** Confirming a method advances generation and policy revision and
  deletes every session of that subject in the same transaction. Enrollment mints
  no session and upgrades none, so the next login must use a selected method.
- **Alternatives.** With nothing selected, a password session is eligible. With a
  method selected, a password alone is not. An account with both methods accepts
  either one, and neither requires the other.
- **Passkeys.** Every registration format is staged, whatever its unsigned UV bit
  says. A dedicated native assertion with signed UV promotes it. Staged credentials
  cannot log in.
- **TOTP.** Native verification stays mandatory. A public `hotp` observer then
  requires a strictly newer per-subject witness, atomic with native success and
  evidence. This is a policy witness inside an observed clock interval, not proof
  of the counter native matched. An unobserved clock excursion can coexist with a
  later colliding witness.
- **Budgets.** A committed wrapper charge precedes native evaluation and survives
  rollback. Native rate limits and failure counters stay separate, and a wrong code
  keeps its native count. Wrapper limits come from `AuthenticationProviderOptions.factors`.
  They have no defaults: without them factor routes return 404 and an account with
  selected protection cannot sign in.

Every decision evaluates committed state: session, mapping, owner/human principal, policy,
generation, evidence and credential binding. This runs synchronously on the guarded
handle and never enters a provider borrow from core admission. Current state stays
authoritative when an after-commit notification is lost, so no consumer here needs
guaranteed delivery. A future consumer that does must add a bounded durable intent;
hooks alone do not provide one. An uncertain COMMIT releases no cookie.

An account's selected flags and native rows must agree. A flag, a verified row or
a trust row that disagrees with the policy refuses that account rather than granting
or removing protection. Re-encrypting a TOTP secret changes its binding, so sessions
proved with it must sign in again; the step does not change. Trust does not depend on
generation, so adding a method does not distrust another.

Authentication strength grants nothing. A provider actor keeps ordinary grants and
role ceilings, `credential: null`, no `owner_session` or bearer, and no owner
administration, runtime control or vault action.

**Not supported yet, each explicitly denied.** The closed route list refuses recovery
codes, TOTP or passkey replacement and removal, additional passkeys, reauthentication,
trusted devices, administrative factor reset and every other native plugin route.
Recovery therefore has no factor-loss path: `recoverLocal` replaces a password and
revokes sessions and outstanding password-backed TOTP challenges but leaves selected
protection in place. Native password change/reset and explicit revoke-all share that
transactional invalidation. The pinned library stores the subject ID as the verification
value for TOTP login and reset tokens; both are deleted on revoke-all. Factor contexts
then fail their required native-row check, including a previously charged attempt before
native entry. WebAuthn challenges use structured values and remain independent. No account
generation changes, so a completed password replacement keeps its inherited evidence.
Rollback preserves the prior password, sessions and challenges. A clock that ran ahead can
hold TOTP refused until real time passes the step, and with no other method that
account waits. These need accepted management decisions, along with final numeric
limits and consecutive-failure accounting.

Backups include this storage, and a restore keeps its rows. Restoring an older snapshot
reopens older sessions, steps, generations and factors, which remains the A5 external
fence. Schema 40 has no downgrade: older binaries refuse it and A3-I18 adds no rollback
path except restoring a backup. A4 vault authority and A5 transport, cutover and restore
fencing stay separate gates. See the
[proof details](../packages/auth-provider-better-auth-proof/README.md#a3-i18-integrated-factor-authority).

### Closed factor HTTP API

A3-I20 mounts login and first enrollment through the isolated composition only. It
uses the same provider, current core schema 48, contract 5, `AccountProtection` and sole
connection as [integrated factor authority](#integrated-factor-authority). Production
main still has no caller or flag, account mode stays refused, and recovery, removal,
replacement, additional passkeys and trusted devices stay refused.

| Exact request | Strict body | Safe 200 response |
| --- | --- | --- |
| `POST /api/auth/two-factor/enable` | `{password}` | `{outcome:"enrollment",totpURI,authorizing:false}` |
| `POST /api/auth/two-factor/verify-totp` | `{code}` | Login: `{authenticated:true}`. Enrollment: `{outcome:"enrolled",authorizing:false}` |
| `GET /api/auth/passkey/generate-register-options` | None | `{outcome:"options",options}` |
| `POST /api/auth/passkey/verify-registration` | `{response}` | `{outcome:"staged",authorizing:false}` |
| `GET /api/auth/passkey/generate-confirm-options` | None | `{outcome:"options",options}`, restricted to the staged credential |
| `POST /api/auth/passkey/verify-confirmation` | `{response}` | `{outcome:"enrolled",authorizing:false}` |
| `GET /api/auth/passkey/generate-authenticate-options` | None | `{outcome:"options",options}` |
| `POST /api/auth/passkey/verify-authentication` | `{response}` | `{authenticated:true}` |

An enrollment result never carries a login. Selection ends every session of that
account, including the one that enrolled, and returns only deletions. Adding the other
method needs a current session, which on a selected account is always a strong one,
and it ends every session too. The setup URI is the one deliberate secret: it goes only to
the enrolling account, under a fixed label with no email, and is never logged.
Generated options contain only named fields, a fixed account label and the random
WebAuthn handle.

**Request boundary.** Factor POSTs need the exact Origin. Option GETs allocate state,
so they need either that exact Origin or, when Origin is absent, the browser's
`Sec-Fetch-Site: same-origin`. Both transport and provider enforce this rule;
foreign/opaque Origins and conflicting Fetch Metadata refuse. This permits ordinary
same-origin browser GETs, which omit Origin. Bodies are counted as streamed bytes, decoded as strict
UTF-8 and read with no admission held. Compressed bodies, repeated JSON keys and repeated
Host, Origin, Fetch Metadata or body headers refuse. WebAuthn fields are canonical
unpadded base64url; every layer is closed; `id` and `rawId` must be the same bytes; a
missing user handle refuses. Only `credProps` may appear among extension results, and
it grants nothing. The caller supplies all bounds through `ProviderFactorLimits.webauthn`
and `AuthenticationTransportLimits`. They have no defaults.

**Cookies.** Only three request cookies matter: session `S`, two-factor `T` and passkey
challenge `P`. Duplicates, unsigned names and case-changed names refuse; a trust-device
cookie is dropped unread. Each operation forwards a fixed subset, and `verify-totp` with
both `S` and `T` refuses as ambiguous.

| Operation | Forwarded | Live response cookie |
| --- | --- | --- |
| Password sign-in | None | `S` or `T`, never both |
| Session, change password | `S` | `S` |
| Sign-out | `S` | None |
| TOTP enable | `S` | None |
| TOTP verify | `S` for enrollment, `T` for login | `S` for login only |
| Passkey register options | `S` | `P` |
| Passkey registration | `S`, `P` | None; the client keeps `P` for confirmation |
| Passkey confirm options | `S`, `P` | Replacement `P` |
| Passkey confirmation | `S`, `P` | None |
| Passkey authenticate options | None | `P` |
| Passkey authentication | `P` | `S` |

The whole response set is validated before any cookie is released. A challenge deletes
an old `S` so the next request is unambiguous, and completion deletes stale `T` and `P`.

**Release.** A provider result stays behind an opaque, runtime-owned object. A
nonauthorizing result carries an immutable capture of the exact context, staged row or
receipt taken inside its borrow, read back from schema 40 rows with no new table or
connection. Header emission and that final check form one synchronous admitted phase.
Accepted completion uses reserved queue room and the existing bounded admission retry
budget, including the request's cancellation signal. Only refusals before callback entry
are retried; the provider effect and publication callback are never replayed. Current
authority is checked after the wait. A retained result is never adopted after state changed.

**Cancellation and lifetime.** One `AbortController` per request follows a closed
connection, never a normal completed close, through the body read, native `Request`,
queued borrow and final admission. Before COMMIT the existing guards roll the success
back, and the separately committed charge stays. After a known COMMIT, cancellation only
suppresses output and removes the unreleased new session on reserved admission. It
cannot undo a password, selection, step or revocation. The in-flight slot is held until
the response closed and every callback really ended, including a cleanup callback, and
including after a borrow's public promise timed out.

**Unreleased sessions.** A session minted for a response that was never delivered has
no client, so the runtime owns its cleanup. The identity comes only from the evidence
write in the transaction that created the session: password evidence, inherited
password-replacement evidence, or a TOTP or passkey login settlement. No request field,
native response or lookup of the account's latest session can select it, and enrollment
or staging results own nothing. The record is that session ID. A discarded or finished
result keeps no cookie or body.

The loader input `unreleasedSessions` bounds these records. It is a required positive
integer for browser login, with no default, and the proof fixture's value is not a
product limit. Every session-producing operation checks it inside its actual borrow,
before native work, so queued issuers cannot pass it together. At the bound they get 503
`database_busy` and mint nothing. Enrollment, staging and options are not refused.
Every caller of `AuthenticationProviderRuntime.browser` must finish or discard its result;
an abandoned one keeps its record until disposal.

A cleanup that fails stays recorded, and the row alone decides completion: a deletion
whose notification failed still counts as finished, and a thrown error does not count as
either result. Each later session-producing request first retries the retained records,
so recovered deletion makes room for that request. Cleanup runs on reserved admission, at
most once per record at a time. A record never expires or gets evicted, so reaching the
bound refuses issuers rather than forgetting a session that may exist. If provider admission
closed, a read on reserved core admission reconciles the row, so a forced rollback or a
deletion that finished before a timeout does not leave disposal falsely unconfirmed.

A failed operation keeps its record across a lost COMMIT acknowledgment or a failed
notification. After a known commit, cleanup removes only that session and its evidence.
The password, selection, step, receipt and revocations stay. A proved rollback leaves
nothing to clean. An unknown outcome keeps its public answer whatever cleanup later learns.
Disposal retries every record and reads the rows again after the drain. It rejects with
`disposal_unconfirmed` while a row may remain, and the owner keeps both locks.
These records are in memory. What survives a process is the durable issuance record
described next.

**Durable issuance.** Schema 41 adds `authentication_session_issuance`, one row per new
session, holding its session ID, a state and a copy of its immutable original deadline.
All four evidence writers meet in one controller operation that writes evidence and a
`pending` row inside the native session's own transaction, so a session never commits
without its marker, and a marker failure rolls back the whole native success. Separately
committed admission charges keep their semantics. The row has no bearer material, and it
grants no authority: current evidence and policy still decide every request.

Immediately before a cookie can leave, the synchronous final phase rechecks current
authority and commits a `pending` to `may_publish` compare-and-set in its own short
transaction. Nothing awaits between that check, the marker's COMMIT and the response write.
SQLite and the network have no shared transaction, so `may_publish` means only that the
client may have received the session. It is never proof of receipt, and no acknowledgment
protocol exists. A marked row stays until its original deadline or an authorized
revocation, including after a successful response, a failed write or a clean shutdown,
and a valid `may_publish` row does not make disposal fail. If the mark throws, no cookie
leaves. The error does not say whether the COMMIT happened, so cleanup reads the stored
state: `pending` is deleted, `may_publish` is kept, and an unreadable row stays uncertain.

Three required inputs bound this, with no defaults: `unreleasedSessions` (U),
`sessionRows` (B) and `sessionReconcileBatch` (Q). B counts every native session row across
all boots, including released, possibly published, revoked but present, expired but
unpruned and unmarked rows. Counting only pending rows could not close the bound, because a
crash after the marker and before the write would escape it on every boot. A saturating
query reads the count in the actual borrow, before native work, and the same transaction
that writes the marker enforces it again. For a fixed B, native rows stay at or below
`max(N0, B)`, where N0 is the row count inherited at the upgrade, and evidence and issuance
rows follow them. That is a logical row bound. It does not bound database bytes, WAL size,
legacy string sizes or other tables.

The cap costs availability, which was accepted for this local proof. At B a new login or a
password replacement is refused before verification or any password write, even when the
replacement would have been net zero. An oversized inherited table is preserved and
refuses new sessions until revocation or expiry brings it below B. No deployment value
for U, B or Q is approved.

Pre-41 rows have no marker. They are unclassified, not orphans: they stay byte-for-byte
unchanged, keep their current evidence-based authority, count toward B, and are never
pruned, even when expired. Nothing is backfilled.

**Ordinary restart.** Before any issuer can load, the new owner runs one recovery for its
lifetime through `SqliteStateStore.recoverIssuedSessions`. Loading a runtime with bounds
is refused until that has finished, and a later load, lazy administration or status call
never sweeps anything. Each batch is a short transaction of at most Q rows on a fresh
admission. Recovery deletes every `pending` session, then prunes `may_publish` rows at or
past their original deadline. A live issuer prunes at most Q expired marked rows and retries
only its own retained flights, never other `pending` rows. Deletion is by exact native row,
so evidence and issuance go through the foreign keys. Password, revocations, selection,
TOTP step, passkey counter, receipts and unrelated sessions do not change. A row recovery
cannot resolve fails readiness rather than being skipped, and a killed pass resumes from
current rows. A maintenance-only load without bounds can administer and cannot mint.

**Restored databases.** A `pending` row in a snapshot may have been published after that
snapshot was taken, so ordinary recovery must not read it as unpublished. The owner reports
provenance from the existing restore journal. A recognized restore, or a journal it cannot
read, refuses the sweep and isolated browser readiness and changes no row. There is no
caller flag, and this path does not clear or reclassify the journal, so a restored
installation stays refused for browser proof issuance. Community open and token modes and
maintenance administration are unaffected. A backup holding more than B rows stays
structurally valid. A manual file rollback leaves no provenance and is outside this
guarantee, and A5's external restore fence remains unsolved.

**Outcomes.** Refusals use fixed bodies:

| Status | Code | Meaning |
| --- | --- | --- |
| 400, 408, 413 | `invalid_request`, `request_timeout`, `request_too_large` | Boundary refusal before the provider |
| 401 | `authentication_failed` | Missing, wrong, replayed, expired, revoked, cross-account or selected-policy failure, all alike |
| 429 | `rate_limited` | Real limiter or budget exhaustion |
| 503 | `database_busy`, `database_unavailable` | Bounded capacity, including the unreleased-session and session-row bounds, or an unavailable owner or provider |
| 502 | `provider_failed` | Invalid provider output |
| 503 | `completion_unconfirmed` with `committed:true` | A durable receipt proves the effect, but its response failed |
| 503 | `completion_unconfirmed` | The outcome is unknown, with no boolean and no cookie |
| 500 | `committed_notification_failed` with `committed:true` | The change committed and its notification failed |

`committed:false` is never sent, and no retained result causes a second verifier call.
This normalization makes no uniform-timing claim.

**Anonymous capacity.** Authenticate options allocate before any account is known. The
runtime applies a per-peer and global window and a bounded peer map before queueing. It
then checks row capacity in the borrow, before a native challenge exists.
`issuance.nativeChallenges` bounds native rows, `issuance.reservedContexts` keeps rows
that anonymous options can never use, and `reservedCompletionSlots` keeps in-flight room
that sign-in and anonymous options can never use. Windows live in process memory, so a
restart forgets them; the durable bound is the row capacity. Pruning deletes a native row
only with the expired context that owns it. Every number in the isolated composition is
a test input, not an approved product value.

**Not proved.** The software authenticator proves real signature verification through the
actual handler. It proves neither hardware provenance nor a browser ceremony.
`pnpm test:auth-provider-session-restart` builds a private worker and kills real owner
processes at real boundaries over one installation, but it is a temporary Unix-socket
fixture, not the installed service. TLS and proxy deployment, a stable operator-owned origin
and RP ID, `secretConfig`/`base32:` end to end, final numeric and failure policy, recovery
and management, A4 and A5 all remain open.

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

## Ordinary humans and Knowledge memberships (A3-I24)

The protected operator can create an ordinary `human`, enroll it separately with
`{email,name,password}`, and assign reader/operator access to a typed Knowledge
project. Creation writes only a stable principal and audit. It creates no provider
account, compatibility credential, grant or role. Historical `owner` rows retain
their IDs, kinds, credentials and first-owner semantics. Human account lists use
keyset pagination with a default and maximum of 20; `nextAfter` selects the next
page. Status/list DTOs contain no email, native subject/session or credential data.

Membership set input is strict JSON through the same private pipe/file handling:

```json
{"principalId":"H1","scope":{"kind":"knowledge-project","id":"K1"},"role":"reader","permissions":["knowledge:read"],"expectedRevision":0}
```

Revoke input has exactly `principalId`, `scope` and `expectedRevision`.
Only `knowledge:read` and `knowledge:write` are accepted. A role is a ceiling:
reader plus an explicit write grant still cannot write; operator plus a read-only
grant cannot write either. Every human operation requires both an active grant
and an active explicit reader/operator binding. A role alone grants nothing.
Attachments, export/import, logs and approval remain denied for ordinary humans,
even if broader stored grants exist. The legacy optional-binding rule remains
for existing owners and agents.

Binding revision is the membership aggregate revision. `0` means never assigned.
Set writes the full explicit grant, binding, incremented revision and audit in one
immediate transaction. Permission-only changes also increment it. Revoke tombstones
both rows atomically. Restore requires a complete new set with the tombstone's
latest revision. A stale set/revoke conflicts without an effect or success audit.
The old identity grant/role setters and revokers refuse human targets, including
direct calls to their storage methods. Read the current private list after an
unknown result before deciding on a new command; no command is replayed automatically.

`knowledge:write` retains A1 project archive/restore semantics. Ordinary humans
cannot mutate runtime links. The shared service refuses before runtime lookup or
retained replay, giving the same safe denial for known and unknown runtime IDs.
Reading an existing linked ID is navigation metadata and grants no runtime access.

Disable performs a conditional active-to-revoked transition plus audit. It is
terminal; a repeat returns `changed:false` with the revoked state and adds no
success event. There is no reenable, deletion or kind-change command. The current
principal state denies the next Knowledge operation or replay independently of
invalidation notifications. The disable transaction also deletes at most one native
session for that human, cascading its evidence and issuance marker. The shared protected
application drains the remaining sessions one row per freshly admitted transaction,
including revoked mapping history, without loading the provider. This recovers existing
global capacity without adding a per-account cap. An interruption leaves revocation
committed and reports `committed:true`; repeat disable to resume cleanup. Retained rows
still count until deleted. Other principals' sessions remain untouched. Enrollment checks active kind and
mapping history in the actual borrow and again at the final link after password
hashing; a prior committed disable prevents native account publication.

Private IPC and offline CLI call the same application and store operations.
Human commands use the trusted local bootstrap context; request actor/kind/sponsor/
strength fields confer no authority. Ordinary human cookies cannot administer
accounts/members, create agents, sponsor credentials, operate runtimes/claims,
approve Knowledge, access ENV/vault, or administer backups/remote workers.
Owner recovery stays owner-only. New human recovery, factor reset/removal and
invitations remain unsupported. Current-session password changes and optional
TOTP/passkey protection retain their existing rules.

`human-account-administration.test.ts` uses actual native accounts, separate cookies
and two Knowledge projects through the isolated HTTP application. It covers
filtering, ceilings, current authority before queued effects/replay, enrollment
races and optional methods. Schema 42 tests use a fresh schema-41 SQL dump produced
by unchanged baseline `7f022fb21069728cf4c9844eec660f367b5680c1`; its populated file upgrade verifies a pre-migration schema-41 backup. Synthetic
rewinds in older tests are still synthetic. Neither fixture is an old executable binary test.
Production `better-auth` selection and unconverted cookie HTTP/MCP remain denied,
including open boot. Full A3, general delegated roles, GUI and A4/A5 stay open.

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
Knowledge roles. This is not account-mode RBAC. Ordinary human membership uses the protected
workflow above; production account login and ENV roles remain gated. Runtime credential
scopes and optional expiry are available through A2 below. The
shared policy denies reserved ENV actions; the existing DEV vault continues to
require its separate signed proof and exact grants, with `use` unavailable.

Full backups retain bindings, revisions, tombstones and audit. As with existing
credentials, restoring an older snapshot can restore older authorization state;
external revocation fences are an A5 gate before account-mode activation.

## Scoped runtime agents (A2)

A scoped agent can discover registered runtime projects, reserve one discovered
worktree, control its claimed managed server, select an existing literal profile
and configure preset timeouts. Independently delegated finite verification is
also available. The accepted runtime actions are:

| Action | Operations |
| --- | --- |
| `projects:read` | Filtered `list_projects`, safe `get_project_status`, `list_worktrees` |
| `claims:manage` | Acquire, renew and release the session's own lease |
| `runtime:control` | Start, restart and stop under an active own lease; also required for `claim_project` with `start: true` |
| `profiles:select` | List literal profile names/selection/revision and select an existing profile while stopped |
| `config:write` | Read discovered preset IDs/default/override timeouts and change project-wide timeout overrides for future enqueues |
| `tests:run` | Discover exact worktrees/presets, enqueue finite jobs and read/wait for own credential-bound runs; originating session may cancel |

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

These scoped tools omit ENV and profile content editing, logs, storage,
capacity and foreign lease details. Finite test admission requires the separate
`tests:run` action. With `projects:read`, agents
can discover/read filtered project and worktree resources, call
`get_project_status_compact` and wait for one project's cursor with
`wait_for_status_change`. The shared waiter budgets apply; sampling, timeout
and delivery after database re-admission recheck current authority. Revocation
rejects pending waits without returning retained data. Cursors cover only the
allowlisted project view and are bound to the credential and MCP session.
Own-run waits require `tests:run`; there is no global queue/capacity projection.
The HTTP runtime/dashboard API continues to reject their
credentials, including existing configuration routes; runtime access is through
these MCP tools. Log and ENV permissions remain unavailable.

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

### Independently delegated finite verification

Grant `tests:run` explicitly through the protected owner delegation and
credential commands above. None of the other five actions implies it, and it
implies none of them. Adding it to a delegation does not change an existing
credential ceiling; issue a new credential with the intended scope. Agents
cannot issue credentials or approve their own elevation.

Call `list_test_presets` with `projectId`. This action supplies its own safe
exact-path discovery even without `projects:read`. Use a returned `worktreePath`
and preset ID with `run_test`, plus a stable `idempotencyKey`. No command,
arguments, ENV, profile or requester override is accepted. Both `full` and
`compact` response modes return the safe compact envelope for scoped callers.
The existing finite queue executes the job without claiming, starting or moving
a development server.

An unclaimed project needs no lease. An active reservation requires this
session's exact own claim and `reservationId`, with its retained secret and
principal/credential binding. A human lock, foreign claim, stale supplied ID or
worktree mismatch denies enqueue. The original reservation is rechecked during
queued dispatch, immediately before spawn and before an identical retry returns.
Authority is also checked before enqueue, after asynchronous discovery/source
preparation, at dispatch and before spawn. A revoked/expired agent, credential,
delegation or disabled sponsor prevents a new process. Revocation does not
retroactively terminate an already running process.

`tests:run` grants no ENV read or vault use. Human-configured clean test profiles
keep their declared literal variables and fixed system allowlist. Presets that
inherit a server profile are denied until separate ENV-use authority exists.
Nothing reads vault plaintext or changes the signed vault-proof contract.

`get_test_run` and `get_test_run_status` return the same safe envelope. They
require current `tests:run` on the target project and the run's original
principal and credential. A missing, foreign or installation/legacy job returns
the same denial. A new session using the **same credential** may read or wait
for a retained run. A replacement or rotated credential cannot adopt it, even
for the same principal. Supply exactly one `runId` or `projectId` to
`wait_for_status_change`; project waits still require `projects:read`. Run
cursors bind the run, credential and current session and share the existing
sampler, waiter budgets, timeout, cancellation and re-admission checks.

Cancellation remains restricted to the originating MCP session as well as the
original principal/credential and current action. A reconnect that resumes the
same logical session retains this right; initialization of a new logical session
does not. `cancel_test_run` requests cancellation and may return `running` while
owned-process cleanup is pending. Only confirmed cleanup permits a terminal
running-process result. Closing a session disposes waits but does not cancel jobs.
Retained enqueue retries remain scoped to the original session and idempotency
key while detailed records exist; a new session must inspect a known run before
making a new enqueue decision.

Safe envelopes expose only run/project/preset/worktree IDs, phase, timestamps,
exit code, a fixed error code and bounded source HEAD/outcome evidence. They
omit logs, commands, ENV and profile contents/names, actor bindings, foreign IDs,
queue positions, global counts and capacity. Current authority is rechecked for
replayed enqueues and every wait result after database re-admission.

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
Migration 44 adds immutable test requester attribution on the same connection,
atomically with initial enqueue. It backfills no jobs or credentials. Retention
cascades requester rows with their detailed jobs; full backups preserve them.

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
implemented. Scoped finite-job admission/own-run access is implemented under
`415205f2-4583-4b13-a508-49a9b618a19e`; completion requires recorded verification.
Scoped resources/compact status/project wait are implemented under
`e0bfe2b5-d1cf-4f1e-ae67-13ab3a542f21`. A3 owns account GUI/human administration, A4
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
new boot's authentication service. No SQLite migration is needed for this
behavior.

This does not solve A5 provider-session resurrection after restoring older
password/session data. External restore revocation fencing, account authentication,
readiness of optional methods and complete transport coverage still gate
production RBAC activation.
