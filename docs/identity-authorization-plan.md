---
audience: "owner, implementers and reviewers of human, agent and ENV access"
last_reviewed: "2026-10-28"
source_of_truth: "planned identity, role and environment authorization contracts and acceptance gates"
status: "active"
---

# Identity, roles and environment authorization plan

## Status and decision boundary

This document describes the target design. A1 Knowledge policy and an A2
scoped-runtime subset are implemented. See [Knowledge roles](authentication.md#knowledge-roles-a1)
and [scoped runtime agents](authentication.md#scoped-runtime-agents-a2-subset)
for their compatibility limits.
The owner accepted role-based access, shared application authorization,
Better Auth human accounts and agent-specific identities/scopes on 2026-10-28,
and explicitly requested ENV roles fitting existing workflows and OWASP guidance.
The initial slice delivered this document and Knowledge planning. The subsequent
A1 slice adds shared Knowledge policy and optional role restrictions. The A2
subset adds owner-sponsored runtime credentials, filtered MCP discovery and
credential/session-bound leases. Accounts and ENV delivery remain deferred.

Knowledge project `k7a-worktree-switcher` holds design task
`e3e2e52e-7b95-4088-8234-0e6d35c39f86` and direction memory
`fb8aab07-3d97-4e38-ac84-617a0d1a0aa4`. The memory records the owner's words;
its installation-token authorship is not independent human approval.
Exact ENV role bundles, authentication factors, time limits and migration
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
A2 backend contract checked at `ae866b2d2d9ade47edab9bf7dce3102d13e5d8e8`;
the CLI, transport verification and operational docs extend that contract.

| Area | Implemented baseline | Remaining work |
| --- | --- | --- |
| Installation authentication | `token`, `open`, `legacy`; rotation and policy invalidation | `better-auth` still rejects activation |
| Identity | Owner, agent, worker and installation principals; revocable credentials | Account-backed humans and general role administration |
| Knowledge | Shared policy, explicit grants and optional Knowledge role ceilings; installation compatibility bypass | Explicit human approval in account mode |
| MCP | Agent sessions add filtered runtime discovery, explicit-start claims and claimed control; Knowledge/vault/remote grants stay independent | Scoped profiles/configuration/tests, runtime resources, compact status and wait API |
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
  Migrate existing `owner` principals to humans without changing their IDs.
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

The initial action vocabulary below is proposed, not a published API. Existing
permission names are preserved where their meaning matches. Domain-specific
guards still apply even when an action is allowed.

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
principals. Prove adapter transaction/disposal behavior against the sole SQLite
connection before integrating it. Controller-owned migrations and backups must
include provider data. Keep the static dashboard and use library-supported
password, factor and session handling rather than new cryptographic protocols.

Provision the first owner through protected local recovery/bootstrap; subsequent
humans use administrator-created enrollment or bounded single-use invitations.
Public signup stays disabled. Resolve username/email provisioning against the
pinned provider. Proposed account-mode security profile requires MFA for humans;
choose and test passkeys with user verification or password plus another factor
before enabling it. Method/strength must come from verified provider evidence.
Password-only prototypes cannot be described as meeting ASVS Level 2.

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
in the implemented A2 subset. No two-hour default or 24-hour issue ceiling is
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

Keep existing explicit `open`, `token` and `legacy` compatibility until a
deliberate mode change. They do not provide the new account-mode isolation:
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
4. Atomically switch policy, invalidate incompatible sessions/subscriptions and
   confirm old installation/legacy credentials fail across all transports.
   Managed process lifecycle remains a separate operator action.
5. Exercise loss-of-provider recovery and restore. Recovery may explicitly choose
   token mode through the protected operator path, with fresh credentials and
   recorded loss of account-mode isolation; it must not resurrect old tokens.
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
boundaries. A0 supplied the design; A1 implements Knowledge policy. A2 remains
in progress after its runtime/CLI subset: `projects:read`, `claims:manage` and
`runtime:control` are implemented; profile/configuration/test rights and account
GUI remain deferred. Migration 36 is additive with no runtime backfill. This
status does not authorize a live upgrade, installation changes or publication.

| Slice and Knowledge task | Deliverable | Acceptance gate |
| --- | --- | --- |
| A0 — `e3e2e52e-7b95-4088-8234-0e6d35c39f86` | This design, ENV matrix, OWASP mapping and reconciled backlog | Documentation validation and code-checked baseline; proposals distinguished from owner direction |
| A1 — `77819572-5ba1-44e5-9315-e870a513d534` | Principal/role/action contract, additive storage and shared policy with Knowledge read/write/discovery as first real workflow | Stable IDs, existing grant compatibility, cross-project/field/revocation tests across HTTP/MCP/CLI; existing modes preserved |
| A2 — `eea2897a7bc8412b681ba00d4c8eb672` | Scoped agent runtime access and human CLI credential administration, then account-authenticated GUI after A3 | Project filtering, separate claim/config rights, sponsor/TTL limits, no self-mint; reservation ownership preserved |
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
