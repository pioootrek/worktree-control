---
audience: "owner, implementers and reviewers of human, agent and ENV access"
last_reviewed: "2026-11-08"
source_of_truth: "planned identity, role and environment authorization contracts and acceptance gates"
status: "active"
---

# Identity, roles and environment authorization plan

## Current A5 account integration

Production bootstrap now validates the actual pinned optional provider, canonical
HTTPS configuration, external fence and existing owner enrollment before account
mode can be selected or listeners opened. The shared bounded adapter is publicly
mounted only for the immutable active RBAC boot. Individual agents keep explicit
credential ceilings; diagnostic logs/storage/capacity have independent grants.
Unconverted cookie and broad privileged operations deny. The optional provider
artifact remains separate from Community. See the current
[production contract and migration runbook](authentication.md#production-account-mode-a5)
for the transport inventory, protected CLI, installed acceptance and exact GUI gap.
Older slice descriptions below record their original boundaries; A5 supersedes
the unconditional mode-refusal and missing-public-mount statements. General ENV
roles, GUI integration, independent review and live migration remain separate.

## Status and decision boundary

This document describes the target design. A1 Knowledge policy and A2 scoped
projects, claims, runtime control, profile selection and timeout configuration
are implemented. See [Knowledge roles](authentication.md#knowledge-roles-a1)
and [scoped runtime agents](authentication.md#scoped-runtime-agents-a2)
for their compatibility limits.
The owner accepted role-based access, shared application authorization,
Better Auth human accounts and agent-specific identities/scopes on 2026-10-28,
and explicitly requested ENV roles fitting existing workflows and OWASP guidance.
The initial slice delivered this document and Knowledge planning. The subsequent
A1 slice adds shared Knowledge policy and optional role restrictions. The A2
implementation adds owner-sponsored runtime credentials, filtered MCP discovery,
credential/session-bound leases and separately authorized configuration tools.
Protected ordinary-human accounts and reader/operator Knowledge memberships
are implemented in A3-I24. Production account integration is documented above; general ENV delivery remains deferred.

The first A3 slice now provides an optional executable provider/SQLite proof.
It verifies real Better Auth operations through the sole guarded connection,
controller migration 38 and explicit subject mapping. The bounded A3 handoff
now issues opaque runtime-owned provider actors and validates current stored
session/mapping/principal state inside grant-limited Knowledge operations.
Controller migration 39 adds honest provider history attribution, preserving
old history and migrations 1..38. Migration 40 and A3-I18 add
[integrated factor authority](authentication.md#integrated-factor-authority):
recognized optional TOTP and passkey storage, one application-owned protection
policy and persisted session evidence behind the same handoff. Account mode now requires A5 validated readiness. Closed factor HTTP routes and ordinary-human memberships now work
inside the isolated composition. P1 implements the production shared lifetime
and IdentityService. P2a adds explicit runtime-project reader memberships and
current-session cookie reads through shared policy and existing projections.
P2b1 adds explicit operator subsets and session/evidence/revision-bound finite
human runtime leases with durable retry intent and closed HTTP control. No
operator receives implied tests/profiles/config/ENV/admin rights. P2b2 adds explicit
independent tests:run through the shared queue, original-session own-run access
and bounded waits, with schema 47 immutable attribution and current native
provider authority at dispatch. See [human finite verification](authentication.md#human-finite-verification-p2b2).
P2c adds explicit literal profile selection and timeout-only configuration.
Public browser mounting, remaining transport parity, P3 protected
recovery/restore fencing, factor management/recovery,
invitations, general delegated roles and GUI remain open.
Shared core admission, exclusive provider admission and background persistence
boundaries are implemented as partial infrastructure. Strict integration tests
cover HTTP body-read admission errors and the installed restore completion
handoff. CLI shutdown retains ownership on failed cleanup and joins concurrent
calls to the same completion. Supported HTTP reservation changes serialize behind
readiness and revalidate installation authority after waiting; token rotation
prevents queued effects and successful replies to the old caller.
P3b supplies the external restore fence and protected quarantine. Supported restore
and raw database rollback refuse before provider loading until protected recovery. Native proof responses expose
session tokens; the existing bounded browser adapter strips them and releases
cookies only after current authority checks. A5 supplies the closed production mount; independent release review remains required.
See [the implemented proof boundary](authentication.md#optional-provider-proof-first-a3-slice).

Knowledge project `k7a-worktree-switcher` holds design task
`e3e2e52e-7b95-4088-8234-0e6d35c39f86` and direction memory
`fb8aab07-3d97-4e38-ac84-617a0d1a0aa4`. The memory records the owner's words;
its installation-token authorship is not independent human approval.
Exact ENV role bundles, factor implementation policy, time limits and migration
mechanics below are engineering proposals, subject to their implementation gates.
There is no authorization here to provision keys, import secrets, migrate the
live installation, change host isolation or publish/deploy a release.

The earlier single-owner-first Better Auth plan remains historical context in
Knowledge memory `570757852db162a0d3c6d2c252b26e7e`, attachment
`7b468c2a1302e39f69b09e8c10426ff3`. This direction brings role design forward.
Optional provider packaging, MIT core and undecided commercial terms remain
unchanged. One Node controller, static dashboard, SQLite owner and lifecycle
coordinator remain architecture constraints.

## Baseline verified against source

Historical main baseline: `f71bad97f921bc6ff42cacb585afd0c4258a06bc`.
A2 backend contract checked at `1d18574013c87ee0c4ee49385c54959b1bbbcd15`;
the CLI, transport verification and operational docs extend that contract.

| Area | Implemented baseline | Remaining work |
| --- | --- | --- |
| Installation authentication | `token`, `open`, `legacy`; rotation and policy invalidation; optional server-free Better Auth/SQLite proof | A5 validates the optional provider and mounts the closed account API; GUI remains separate |
| Identity | Owner, ordinary human, agent, worker and installation principals; revocable legacy credentials and isolated human sessions | General delegated role administration |
| Knowledge | Shared policy, explicit grants and optional Knowledge role ceilings; installation compatibility bypass | Explicit human approval in account mode |
| MCP | Agent sessions add filtered discovery/resources, compact project status/wait, explicit-start claims, claimed control, literal profile selection and preset timeout overrides; Knowledge/vault/remote grants stay independent | Scoped finite-job execution and own-run access now require independent tests:run; logs/storage/capacity require independent explicit grants |
| Remote verification | Separate submitter/project and worker/project/preset grants | Integrate without replacing both checks with a broad project role |
| DEV vault | Encrypted profiles, signed owner operations, exact agent grants; backend and GUI on main | General role integration; execution delivery remains unavailable |

Evidence: `src/server/modules/authentication/`, `src/server/modules/identity/`,
`src/server/transports/mcp/mcp-runtime.ts`,
`src/server/modules/remote-verification/`, `src/server/modules/dev-vault/`,
`src/shared/contracts/dev-vault.ts` and `src/features/dev-vault/`.
See [current authentication](authentication.md) and
[current vault contract](dev-environment-vault.md) for operational instructions.

## Identity and policy model

The following concepts belong to Worktree Control, independent of Better Auth:

- **Principal:** stable ID, kind `human`, `agent` or `worker`, active/revoked state.
  Preserve historical installation principals as compatibility/audit identities.
  Keep existing `owner` rows unchanged as compatibility identities. New ordinary
  humans have the distinct stored `human` kind.
- **Provider identity:** unique provider/subject mapping to a human principal.
  Never infer ownership by matching a display name or unverified email.
- **Credential/session:** principal, verifier/provider reference, method,
  authentication strength/time, expiry, revocation and bounded usage metadata.
  A role change does not mint a new identity.
- **Role binding:** principal, fixed role, typed scope and revision. Scope types
  include installation, Knowledge project, runtime project and ENV profile.
  A runtime link is navigation, not an implicit membership or grant.
- **Agent sponsorship:** recorded human sponsor, permitted projects/actions and
  expiry. Effective delegation cannot exceed the sponsor's current delegable
  authority; sponsor disablement blocks it until explicit reassignment.
- **Sensitive grant:** exact resource/version, permission, recipient credential,
  approver, validity and execution binding where applicable. This is separate
  from membership and from a transport session or runtime lease.

The shared application operation evaluates `subject + action + typed resource
+ context`. It obtains trusted attributes from persistence and authentication,
not a caller-supplied role, sponsor or project label. Unknown actions, missing
resources and unavailable policy dependencies deny access. Multiple role bindings
may combine permissions only within matching scopes; credential and sponsor
constraints narrow that set, and sensitive grants add required conditions.
Revocation and hard human-only restrictions take precedence over every role.

Introduce normalization before replacing persisted principal-kind values.
Existing owner-session authentication, vault signatures and backup readers still
depend on `owner`; preserve an explicit compatibility adapter until those
consumers migrate together. Never reinterpret an agent or installation principal
as a human. Existing scoped grants remain effective ceilings during migration,
not a reason to assign a broader default role.

Use a small action registry and explicit resource resolvers, delivered with a
real workflow. Avoid a general policy language, external policy service or
empty modules. Keep policy evaluation and domain effects inside the existing
application boundary. Recheck after lifecycle-lock/queue admission and make the
final authorization check, relevant revision check and mutation atomic where
they share SQLite state. External effects need an explicit execution boundary.

A3-I24 implements only protected local human lifecycle and atomic Knowledge
reader/operator memberships. Both current grant and binding are mandatory for
new humans; explicit permissions are limited to read/write. General role bundles
below remain proposals. See [the current human workflow](authentication.md#ordinary-humans-and-knowledge-memberships-a3-i24).

## General roles and permissions

Fixed bundles are the initial UX; custom roles can follow demonstrated need.
Installation authority does not imply ordinary project-content access in the
new account mode. The initial owner receives explicit bindings for existing
projects during migration. Every later project requires an explicit assignment.

| Proposed role | Scope and permitted work | Deliberate limits |
| --- | --- | --- |
| Owner | Installation security policy, administrator assignment, protected recovery | No implicit vault plaintext or external signing key |
| Administrator | Account/agent lifecycle, project registration and operational settings | Cannot grant owner, ENV custody, or self-upgrade; no implied content membership |
| Project manager | Assigned project membership, configuration, operator actions; Knowledge approvals when separately bound there | Human only; cannot appoint another manager or elevate self; no ENV grant authority |
| Operator | Assigned runtime lifecycle/claims, allowed verification presets and profile selection; Knowledge writes when separately bound there | No membership/configuration changes, approval or secret access |
| Reader | Assigned project metadata and permitted content | No mutation, bulk export, raw ENV values or automatic logs/attachment access |

Owner appoints administrators and project managers. Administrators can assign
reader/operator bindings within their delegated project scope, but cannot
grant to themselves or to their own agents to bypass a missing permission.
Managers may assign only reader/operator within their own project. All grant
operations verify both grantor authority and recipient type/constraints.

The role assignments below are proposed. A2 implements its five runtime actions
through explicit owner-sponsored delegation and credential ceilings, without
assigning these roles. In particular, an agent can hold timeout-only
`config:write` without a manager role. Other action groups remain subject to
their slice's implementation. `tests:run` now uses the same explicit delegation
and immutable ceilings for finite jobs. Scoped logs remain denied.
Domain-specific guards apply even when an action is allowed.

| Action group | Default assignment | Additional restriction |
| --- | --- | --- |
| `projects:read`, `knowledge:read` | Matching reader, operator, manager | Filter lists, counts, search and detail by actual resource scope |
| `knowledge:write` | Matching operator, manager | Existing revisions, archive rules and idempotency |
| `knowledge:approve` | Human Knowledge manager | Fresh human proof; agent labels or installation-token history do not count |
| `attachments:read/write`, `knowledge:export/import`, `logs:read` | Explicit supplementary grant | Never inferred from generic project read; logs may contain application secrets |
| `claims:manage`, `runtime:control`, `tests:run` | Runtime operator, manager | Own lease, safe preset, source and capacity checks; foreign cancellation needs separate authority |
| `profiles:select` | Runtime operator, manager | Literal-profile selection only; no vault-use authority |
| `config:write` | Runtime manager | Allowlisted fields; no identity, signing-key or vault-grant mutation |
| `members:manage` | Human manager within delegation ceiling | No self-elevation or assignment of privileged/ENV roles |

Agents can receive reader/operator bundles, narrowed by credential actions,
project allowlists and TTL. They cannot receive owner, administrator, manager,
human approval or credential-issuance actions. A worker is an executor with
assigned attempt permissions, not an operator with arbitrary submit/read access.
The UI may hide unavailable actions; the service must reject direct calls too.

## ENV roles for the existing workflow

Keep two resource classes separate: existing plaintext **literal profiles** and
encrypted **DEV vault profiles**. A literal configuration editor is not a vault
editor. Do not silently migrate values or claim literal profiles are encrypted.
All vault role bindings include runtime project, profile and `DEV`; no staging
or production access is introduced by this plan.

| Proposed ENV role | Capabilities within the assigned profile | What it does not confer |
| --- | --- | --- |
| Executor / wykonawca | Request `env:use`; execute an approved use binding once delivery exists | No plaintext read, write or approval; use remains unavailable today |
| Reader / czytelnik | Request `env:read`; reveal values only with a matching grant | No execution use, editing or onward delegation |
| Change author / autor zmian | `env:propose-write`; apply the exact approved patch through `env:write` | No read of old values, free-form edit window, deletion or approval |
| Custodian / opiekun | Human-only request inspection, approval/rejection/revocation and bounded audit | No implicit existing-value read, execution use or profile mutation |

Each bundle permits only safe metadata for its assigned profile and the
caller's own requests; it does not enable project-wide profile discovery.
Write inspection intentionally reveals the proposed patch to its approving
custodian, not the existing profile. Custodianship is therefore a sensitive
assignment. Profile import/update is a separate `env:provision` capability;
an owner needing it receives an explicit binding and uses the existing proof.
One person may hold multiple roles, but role assignment alone never replaces
the required sensitive-operation proof/grant.

In the first ENV integration, custody remains with the externally verified
vault owner. A broader multi-custodian workflow requires key-to-human mapping,
protected enrollment/revocation and recovery design; assigning a role cannot
make a database-writable key trusted. An administrator cannot manufacture a
human approval by creating an account or issuing another owner credential.

Preserve these existing constraints:

- Owner operations require the external Ed25519 proof bound to exact command,
  principal, credential and timestamp. A Better Auth cookie or MFA result alone
  does not satisfy it. Changing this proof is a separate reviewed design.
- Agent grants bind both principal and exact credential, profile revision and
  independent `read`, `write` or `use`. Rotation requires new approvals.
- A write approves an immutable patch at one revision. Applying it advances
  the revision; a 15-minute lifetime is not an unrestricted editing session.
- Current lifetimes remain `once`, `15-minutes`, `until-revoked`; pending
  requests expire after 15 minutes and unused once grants after 24 hours.
  An earlier credential/role/grant expiry still denies access. Revocation
  blocks new access and replayed plaintext responses.
- Once consumption and receipts remain atomic. Retries recheck authority;
  idempotency is not authorization. Preserve current restore fences.

No recipient approves its own request. A human can approve a sponsored agent's
request with independent human proof; this is not two-person control and must
not be presented as such. Existing signed owner import/update is a direct
owner action, not a self-approved agent request.

Example: an operator agent may diagnose a missing-input category and request
use of profile P revision 7 for a specific execution. Only an executor binding
plus an approved use grant could authorize delivery. Reading values to debug
requires a separate reader binding and read approval; proposing a replacement
requires the change-author binding and an approved immutable patch.

**Execution delivery is a separate gate.** Bind future delivery to trusted
immutable source, commit, command digest, worker, preset, profile revision and
execution phase. Mutable local worktrees do not meet that guarantee merely
because their observed HEAD matches. Code receiving values can copy them;
use-without-read means the control-plane API does not reveal plaintext, not
that an agent controlling that code cannot exfiltrate it. Dependency setup
does not inherit test secrets. Grant revocation cannot erase process memory
or revoke a credential at its external provider.

## Authentication, revocation and audit

Better Auth remains an optional identity/session provider mapped to stable
principals. The first proof exercises adapter transactions/disposal against the
sole SQLite connection; migration 38 and controller backups include its data.
The [implemented handoff](authentication.md#provider-authorization-handoff)
uses an instance-bound frozen actor and synchronous current-state checks, with
original expiry, ordinary grants/role ceilings and safe `credential: null`
metadata. It denies owner administration, runtime sponsorship/control,
privileged approval and vault proof substitution. Schema 39 widens only
Knowledge history audit attribution, and schema 40 adds factor and evidence storage
with historical provider storage revision 2. Issuance schema 41 uses revision 3;
schema 42 adds ordinary humans without changing provider contract 5,
storage 3 or proof implementation 5. Core schema 43 adds Godot Web project configuration; schema 44 adds
immutable scoped-test requester attribution; schema 45 adds an empty human
runtime membership aggregate. Current schema 46 extends explicit membership to
operator subsets, with provider-bound reservation sidecars and durable bounded
runtime intents on the same connection. No grants are backfilled and provider
contract/storage remain unchanged. Earlier migration SQL/checksums remain unchanged.
Full/logical backup compatibility
has focused migration tests. Protected CLI failure/concurrency handling and
isolated closed HTTP/factor routes are implemented. Safe production integration
and the remaining account gates still need acceptance.
The current 5-second admission wait, 60-second persistence retry budget and
10-second database drain are implementation limits, not approved account
security defaults. Keep the static dashboard and use library-supported
password, factor and session handling rather than new cryptographic protocols.

Provision the first owner through protected local recovery/bootstrap; subsequent
humans use administrator-created enrollment or bounded single-use invitations.
Public signup stays disabled. Resolve username/email provisioning against the
pinned provider. On 2026-11-02 the owner selected both authenticator-app TOTP
and passkeys as optional methods ("Kody i passkey", then "Opcjonalne"). This
supersedes the engineering proposal requiring MFA for all humans. Do not deny
full-RBAC password accounts globally solely for lacking enrollment or choose
new roles that require MFA without an owner decision. Supporting both methods
means alternatives, not two mandatory sequential checks. Optional enrollment
cannot bypass a protection the account has chosen or enrolled. Method and
strength need verified session evidence; enabled flags grant no role or privilege.
Existing current-identity hard guards remain until separately implemented policy.
See [the owner decision and current proof](authentication.md#owner-selected-optional-methods).

A3-I14 proves passkey feasibility only in the private temporary fixture, using
supported callbacks in `@better-auth/passkey` 1.7.14. A3-I15 adds untrusted
privacy-preserving `fmt:none` staging followed by a separate native signed UP/UV
confirmation bound to the exact credential, subject, issued handle, original
password session, generation and deadline with fixed RP/origin. Confirmation
promotes trust atomically and deletes its native-created session, with no cookie
or upgrade of the original password evidence. Normal login refuses staged keys;
packed signed enrollment remains supported. Its later `passkey_uv` login
observation is nonauthorizing; the library supplies no
durable session-method/generation or enrollment-UV trust history. Production
contracts, schema and activation stay unchanged. A3-I17 replaces the admitted TOTP
fixture's presentation ledger with one monotone step per opaque subject across
enrollment, login and explicit nonauthorizing current-session reauthentication.
Native success stays necessary. A reusable optional-package helper uses the public
`hotp` primitive over at most four counters and may only refuse further; it claims
no hidden native matched step. Consumption and receipt are atomic, admission
charges remain durable, state stays one integer per subject, and later decimal
collisions at newer counters are accepted. No reset exists. Later A3-I18/I20 supply recognized step storage, current-generation evidence
and closed HTTP response handling in the isolated composition. Production
activation, management/recovery and A5 remain unresolved integration gates. The five native/bounded negative baselines remain unskipped.
Readiness of these selected optional features is distinct from mandatory
multi-factor enrollment for every user. Password-only prototypes prove no MFA,
and neither this proof nor the account plan claims ASVS Level 2 conformance.

Use backend-validated browser sessions, rotated at login/re-authentication;
HttpOnly, Secure and appropriate SameSite cookies; explicit Origin/Host and CSRF
defenses for cookie-authenticated mutations. Specify and test idle/absolute
lifetimes, concurrent-session caps, login/invite/recovery throttling and fresh
authentication for grants and factor changes before shipping accounts. These
numeric defaults are an A3 design output, not existing host settings. Keep
secrets out of URLs and browser persistent storage. Remote account access needs
HTTPS; failure or missing provider never falls back to anonymous access.

Machine credentials are separate: server-generated opaque secrets with only
verifiers retained, shown once, narrowed actions/resources and optional expiry
in the implemented A2 contract. No two-hour default or 24-hour issue ceiling is
implemented or approved. Such finite defaults remain a proposal; unattended
worker renewal requires its own explicit operator configuration.
MCP clients may inspect their effective access and request more, but cannot
mint tokens or approve their own elevation. OAuth later reuses the same policy.

Revalidate current principal, credential, sponsor, bindings and grant on each
operation, before queued execution and before secret release. Close or refilter
live streams on loss of access; do not retain stale privileges in session caches.
Stop automatic claim renewal when credential authority is revoked and retain
documented lease expiry; do not transfer reservations silently. Running jobs
record cancellation intent separately from verified owned-process termination.
Already returned data cannot be recalled. Concurrent mutation/revocation tests
must establish the decision's transaction ordering explicitly.

Audit records identify principal, sponsor where relevant, credential ID (never
the secret), authentication method/strength, action, typed resource, policy
revision, approval reference, outcome and correlation ID. Keep request bodies,
ENV names/values, passwords, cookies, tokens and signing material out. Preserve
encrypted vault audit boundaries and bounded retention. Historical installation
events remain unattributed; a new role assignment does not rewrite history.

## Transport and migration coverage

| Boundary | Enforcement and acceptance obligation |
| --- | --- |
| HTTP API and dashboard | Same application policy for every action; filter nested objects/fields, counts and search; clear stale UI on identity change |
| MCP tools/resources | Validate current actor per call, regardless of tool discovery; preserve credential/session binding and bounded session governor |
| Online CLI | Same operations as HTTP; no privilege inferred from TTY, command name or local network address |
| Downloads, attachments, exports, logs | Authorize resource plus specific data class; no unguarded static/private-file path or stale download credential |
| SSE and other long-lived subscriptions | Check subscribe and delivery authority, release resources after revocation and bound fan-out |
| Verification queue and workers | Recheck requester and worker independently at dispatch/delivery; authorize result and artifact reads separately |
| Identity, backup/restore and administration | Inventory every privileged route; explicit human authority/fresh proof or deny before account-mode activation |
| Unix admin socket and offline CLI | Trusted operator boundary with OS protection and protected recovery; singleton lock alone is not authentication |

The permanent product modes are `open`, one shared installation `token`, and
full individual RBAC. `legacy` remains upgrade compatibility and cannot be
selected anew. Mode selection is protected CLI-only and effective only after
service restart. The stored selection and immutable active boot mode are now
separate; selecting a future mode leaves live access and sessions unchanged.
Token/session revocation and current principal/grant checks remain immediate.
Production `better-auth` selection/startup still fail closed until account
authentication, readiness of selected optional methods and A5 enforcement gates
are complete. This slice proves token/open restart
behavior and explicit third-mode refusal, not positive production RBAC support.

A3-I9 adds an isolated core browser adapter and actual HTTP-cookie-to-Knowledge
fixture with explicit grants. Its exact allowlist, secure cookies, canonical
HTTPS/Host/Origin checks, socket-peer native limiting and current-authority
checks are described in [authentication](authentication.md#bounded-browser-adapter).
Contract 2 specializes durable logout; password changes recheck authority inside
the actual provider borrow. No provider cookie gains installation authority on
unconverted HTTP/MCP operations, even during an open-mode proof boot. The isolated
browser composition remains fixture-only. Production startup now owns
one shared provider composition for protected administration and current-session
identity, with an internal bounded-browser preparation method and no public mount.
See [P1 composition](authentication.md#shared-controller-provider-composition-p1).
Protected CLI maintenance can explicitly load a configured provider without mounting it.
Experimental numbers and strength labels do not establish full RBAC, MFA or ASVS
Level 2.
Protected CLI configuration, principal-only creation, enrollment and recovery
are implemented as bounded A3-I10 maintenance. They preserve the existing boot
authentication object and mode, issue no bearer/grant/role, and recheck active
principal/mapping history inside provider admission. Configuration/status do not
load code; changed loaded material requires a new owner boot. Private signing
configuration needs its own protected backup. Production account activation
still waits for optional-method readiness, roles and complete A5. See the
[operator workflow](authentication.md#protected-provider-maintenance).

Keep existing active compatibility authority until the explicit restart.
These modes do not provide individual account isolation:
`open` remains anonymous full access and `token` retains its documented shared
authority. Do not relabel either as individual RBAC. Account mode rejects shared
installation/legacy bearers, even if their stored verifier remains for recovery;
it also closes any bootstrap path that can recreate human authority from them.

Migration procedure to implement and test on an isolated copy:

1. Inventory active clients and exposed operations; preview mappings and denied
   workflows. Preserve IDs and existing Knowledge/remote/vault grants without
   broadening them into project roles.
2. Provision and verify the human owner and recovery path; enroll separate
   agents/workers and update private client configuration. No shared secret is
   copied into Knowledge, repository files or audit.
3. Verify complete policy coverage, recovery and current backup/restore policy.
   Unconverted privileged operations remain denied in account mode.
4. Select the next-start policy atomically through protected CLI, then restart
   explicitly. Confirm the new boot applies RBAC and old installation/legacy
   credentials fail across all transports. Selection alone does not invalidate
   current sessions or control managed process lifecycle.
5. Exercise loss-of-provider recovery and restore. Recovery may explicitly choose
   token mode through the protected operator path, with fresh credentials and
   recorded loss of account-mode isolation, then restart explicitly. It must not
   resurrect old tokens.
   Backup restore must preserve external revocation/recovery fences.

An agent with the controller's OS account can access its administrative socket,
database and possibly key files. Application RBAC does not sandbox that agent.
An adversarial local-agent deployment therefore needs a separately protected
controller account, private storage/recovery channel and execution isolation.
Design and validate that deployment separately; this plan changes no host users,
services, ports, guards or credentials. Multi-tenant SaaS isolation is also a
separate scope, not implied by project roles.

## OWASP requirements and verification map

The owner explicitly requested OWASP guidance. Pin requirement references to
[ASVS 5.0.0](https://asvs.owasp.org/); use applicable Level 2 requirements as the
proposed verification baseline, with selected stronger revocation/delegation
controls. This table is scoped to this feature and is not a full ASVS assessment
or certification claim. Each implementation slice records requirement ID,
applicability, test/evidence and unresolved exceptions; missing evidence stays
open. Exact MFA configuration and recovery strength gate any future L2 claim.

| Reference | Worktree Control design requirement | Negative/acceptance evidence |
| --- | --- | --- |
| [ASVS V8](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x17-V8-Authorization.md): 8.1.1–8.1.2, 8.2.1–8.2.3 | Document and enforce action, object and field boundaries | Swap project/profile/attachment IDs; inject role/grant fields; compare lists/counts/downloads across two principals |
| ASVS 8.3.1–8.3.3 (8.3.2–8.3.3 are L3 additions) | Enforce in shared services; current authority follows original caller | Direct service/HTTP/MCP/CLI bypass attempts; revoked session, retry and queue-dispatch races; intermediary cannot supply its own wider rights |
| [ASVS V6](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x15-V6-Authentication.md): 6.1.1, 6.1.3, 6.3.1; V6.2/V6.3 | Enumerate authentication paths, defend login/recovery and verify factors/password policy | Brute-force limits without permanent victim lockout; invitation/reset replay; weaker recovery cannot silently yield stronger proof |
| [ASVS V7](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x16-V7-Session-Management.md): 7.1.1–7.1.2, 7.2.1–7.2.4, 7.3.1–7.3.2, 7.4.1–7.4.3 | Backend session lifecycle, rotation, documented bounds and revocation | Fixation, idle/absolute expiry, logout, account disablement, factor-change session invalidation including streams |
| [Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) | Default refusal; roles plus resource/context constraints; least privilege | Unknown action denied; sponsor/credential ceilings; periodic binding review; no self-elevation |
| [Session](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) and [CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) cheat sheets | Protect browser credentials and cookie-authenticated requests | Cookie flags, cross-origin forms/fetch, token-in-URL and stale browser state tests |
| [API Security 2023](https://api-security.owasp.org/editions/2023/en/0x11-t10/): API1, API2, API3, API4, API5 | Object/function/property checks and bounded auth/session/approval work | Cross-resource reads/writes, mass assignment, missing credentials, request floods with bounded queues/state |
| [Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html) | Independent grants, protected key custody and explicit lifecycle | No plaintext metadata/logs/exports; expired/revoked grants and key loss fail closed; restore does not revive access |
| [LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) | Narrow tools/credentials; human approval outside model-controlled input | Malicious repository/Knowledge text cannot mint scopes, claim human consent or change an approved ENV patch |
| [Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) | Attributable bounded security events without credentials/content | Verify denied and sensitive accepted operations; log injection/redaction tests; audit readers cannot obtain vault values |

References were checked on 2026-10-28. The test cases are project-specific design
choices derived from these sources. Agent prompts and AGENTS.md instructions
are not security enforcement. An agent following malicious content must still
hit the same application denials. Authorization does not solve malicious code
execution or secret exfiltration from an already approved process.

## Delivery slices and gates

Knowledge owns status, discussion and validation; this table defines intended
boundaries. A0 supplied the design; A1 implements Knowledge policy. The original
A2 projects/claims/profiles/configuration criteria are implemented through five
actions: `projects:read`, `claims:manage`, `runtime:control`, `profiles:select`
and `config:write`. Closure requires recorded verification of the final source.
Migration 36 adds scoped authority without backfill; migration 37 adds the
configuration revision. Existing credentials never gain actions automatically.
This status does not authorize a live upgrade, installation changes or publication.

A2 configuration is deliberately narrow: existing literal profile names and
stopped selection; discovered preset metadata and future-enqueue timeout
overrides. `config:write` grants no manager role, ENV, profile editing,
preset-profile assignment, launch/TLS/global or identity rights. Current agent,
credential, delegation and owner sponsor constrain every call and cached retry.
Active reservations require exact own-session/credential/secret/ID proof;
unclaimed mutations remain useful without claim/runtime rights. See the
[operational contract](reservations-and-mcp.md#scoped-configuration-workflow).

Scoped finite-job admission and own-run access are implemented under
`415205f2-4583-4b13-a508-49a9b618a19e`. Scoped resources, compact project status
and bounded project wait are implemented under `e0bfe2b5-d1cf-4f1e-ae67-13ab3a542f21`,
with current authority checked after waiting and no global capacity or queue data.
These are separate followups, not delivered A2 behavior or part of A3–A5.

| Slice and Knowledge task | Deliverable | Acceptance gate |
| --- | --- | --- |
| A0 — `e3e2e52e-7b95-4088-8234-0e6d35c39f86` | This design, ENV matrix, OWASP mapping and reconciled backlog | Documentation validation and code-checked baseline; proposals distinguished from owner direction |
| A1 — `77819572-5ba1-44e5-9315-e870a513d534` | Principal/role/action contract, additive storage and shared policy with Knowledge read/write/discovery as first real workflow | Stable IDs, existing grant compatibility, cross-project/field/revocation tests across HTTP/MCP/CLI; existing modes preserved |
| A2 — `eea2897a7bc8412b681ba00d4c8eb672` | Scoped projects/claims/runtime, literal profile selection, timeout-only configuration and human CLI credential administration | Project/action/credential isolation, sponsor/expiry limits, exact own claims, strict fields, CAS/replay/audit verification; no self-mint or secrets |
| A3 — `ec4c7258770328ca33fb1801be6831f6` | Provider adapter proof first; then human accounts/factors/sessions and role administration | Single SQLite owner, provider lifecycle, enrollment/recovery, session/CSRF tests and private package boundary |
| A4 — `6645ffce-dc9e-4a88-ab94-6b2cf9ca34b6` | ENV roles through shared policy; independent read/write/use eligibility and signed human custody | Existing proof/grant/revision/retry tests preserved; no automatic admin secret access; use still unavailable |
| A5 — `1436bb74-d52a-48ec-ad3a-c35c838eeecc` | Complete transport inventory, account-mode cutover and recovery acceptance | All unconverted operations denied, old shared-token paths closed, isolated upgrade/restore and OS trust-boundary runbook |
| A6 — `b83623bb-5425-46a3-bbca-b68fabbd13bc` | OAuth consent and MCP client onboarding on the same authority model | PKCE/discovery/audience/refresh/revocation and actual supported-client tests |

A1 is the first coding task. A2 depends on A1; A3 can prove the provider adapter
after A1 while A2 completes scoped credentials. A4 requires A1 plus the A2/A3
credential and human-proof contracts. Account-mode production activation waits
for A5, even if a login screen works earlier. A6 follows A5. A2 and A3 should
split internally into focused PRs at those boundaries; each PR ships a usable
tested workflow rather than silently activating half a security boundary.

ENV execution delivery remains under parent
`92e7dab563aa6d7ee110ec007a65bfd6` and the
[environment runtime plan](environment-runtime-plan.md), dependent on immutable
execution trust. It is not smuggled into A4. Preserve remote-verification and
MCP-session reliability work rather than replacing their state machines.

Implementation checks use the managed queue: relevant behavioral tests,
`pnpm check`, build for modules/packaging, affected browser flows and package
upgrade/recovery where applicable. A5 requires an explicit security review of
the cross-transport matrix, including denied cases and deployment assumptions.
Documentation-only A0 uses `test:docs` (format, validate and diff check).

Remaining pre-implementation decisions are tracked in the owning slices:
provider version/SQLite adapter and factor UX in A3; exact credential/session
bounds in A2/A3; mapping
human accounts to existing external vault proofs in A4; recovery and host
isolation contract in A5. None permits weakening current protections by default.

### P2c explicit human configuration scope

The implemented human operator aggregate now accepts explicit `profiles:select`
and `config:write` alongside its four earlier actions. Each is independently
usable; reader still permits only `projects:read`, and existing owners receive
no automatic project grant. Protected CLI/IPC assignment remains strict and uses
membership CAS before provider loading.

For this slice `config:write` means discovered-preset timeout overrides only.
It does not implement the broader proposed manager configuration role, grant
ENV/vault access, allow profile editing or preset-profile assignment, or authorize
launch/TLS/global administration. Literal profile selection requires stopped
owned runtime and never restarts it. Actual original provider authority,
membership revision and original no-claim/exact-claim context govern durable
receipts, including after reopening the store. See
[the operational contract](authentication.md#human-literal-profiles-and-preset-timeouts-p2c).

P3a supplies protected account recovery below. P3b supplies the external restore/revocation fence and protected installation resume. Minimum agent diagnostics, complete transport enforcement, public mount,
activation, release and client migration remain separate acceptance gates.

### Protected recovery boundary (P3a)

The shared production provider now supports password recovery for existing active
humans and the single active owner. Private CLI input defaults to preserving
factors; explicit `factors: "reset"` requires a new password and the provider's
`localFactorReset: "v1"` readiness plus separate reset method. Password, sessions,
factor bindings, challenge authority and account generation change in one sole
connection transaction. IDs, roles, grants, audit, TOTP steps and account budgets
remain. See [authentication](authentication.md#protected-factor-loss-recovery-p3a) for the operator contract.
P3b now requires an external checkpoint and protected quarantine receipt before restored provider loading. Public account activation and A5 transport enforcement remain separate gates.

### External restore checkpoint and protected resume (P3b)

Migration49 adds a fixed SQLite checkpoint and authority-table triggers, preserving
migrations1..48. The sole core/provider connection publishes a private external
pending witness from the BEFORE-trigger observer before authority rows change,
and a confirmed witness after FULL SQLite COMMIT.
Normal confirmed restarts preserve current rights. Supported restore and raw
DB-only rollback fail closed before provider/listeners, including older schemas.
The bounded witness binds the canonical database path and installation outside
the application backup payload; custom state-directory nesting does not change
that boundary. Whole-host rollback including the witness is outside this local
OS-owner trust model.

Protected offline `auth fence inspect/establish/resume` uses both singleton locks
and an exact preflight. Resume quarantines restored credentials, sessions, factors,
passwords, grants, leases and pending work, preserves the same owner and history,
then acknowledges the existing handoff and publishes a durable receipt. No public
session or token can perform it. Captured mode/token policy remains historical
evidence; resumed mode is explicit, and old verifiers stay invalid. Schedules and
vault use an additional receipt floor while retaining their separate signed proof.
See [operator flow and crash protocol](authentication.md#external-security-fence-and-protected-resume-p3b).
Production account-mode selection/public mounting, minimum agent diagnostics,
complete transport enforcement, independent review and verified release/client
migration remain A5 gates. The five historical factor negatives remain visible.
