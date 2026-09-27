# Self-hosted and owner-operated SaaS implementation plan

## Current delivery status, 2026-09-27

The HTTPS path and authentication stage 1 have implementation and main CI
evidence at `17d0c9d`. Stage 1 retains a credential-free knowledge/admin CLI
gap in open mode. Knowledge core and remote-verification foundations are also
merged; full remote execution, Better Auth and SaaS remain incomplete.
Read [the reconciliation](../NOTE-20260829-readiness-assessment/reconciliation-20260927.md)
before treating the dated stages below as a list of unimplemented work.

Date: 2026-09-09. Inspected baseline: `5777634` (`main`; application code
from `13e80fe`). Status: planning, not implemented or deployment evidence.

Authentication update, 2026-09-17: follow the
[global CLI modes and optional Better Auth plugin plan](authentication-modes-and-plugin.md)
for the current owner direction. It supersedes independent Web/MCP modes and
separate owner knowledge login in earlier plans. Open and unified-token modes
are self-hosted choices; the organization-isolation gates below still apply to
public SaaS. Earlier source observations in this document remain dated baselines.

## Direction and scope

Owner direction: the product must support self-hosting and be prepared for a
SaaS operated by the owner. Record staged delivery with validation that detects
errors before subsequent layers depend on them.

Proposed architecture: one product with configurable deployment, a control
plane for authorization and durable requests/results, and workers for local
repositories, process ownership and execution. A local installation can retain
one Node process and SQLite. Remote workers initiate authenticated outbound
connections to either a self-hosted control plane or the owner's service.
Self-hosting must not require an account or license-server connection to the
owner's SaaS. Keep the static dashboard and shared application operations.

Initial hosted scope assumes customer-owned execution hardware and worker-side
secrets. Running customer code on operator infrastructure requires a separate
execution-isolation design. Hosting provider, proxy product, central database,
worker protocol and commercial terms are not selected by this plan. The
2026-09-17 authentication update selects Better Auth for the later account flow.
Verify current official documentation when selecting implementation dependencies.

The HTTPS feature owns stage 1 only. Stages 2-4 coordinate existing remote,
identity and distribution work; they are not prerequisites to closing HTTPS.
Read `docs/remote-verification-plan.md` for remote execution/recovery details,
`docs/environment-runtime-plan.md` for credentialed execution, and
`docs/architecture-effort-assessment.md` for architectural constraints.
This note adds delivery gates; it does not replace those plans.

## Stage 0: contracts and early negative tests

Before production edits, inspect the current revision and capture the baseline
for direct LAN/loopback operation, CLI service access, pairing and SSE. Record
which existing checks pass. Establish a temporary controller with isolated
SQLite/state, a loopback test proxy and a test CA. Do not change the installed
service, its certificates, ports, reservations or host protections.

Specify and test the address contract first:

- Internal listening address is separate from public browser origin and the
  local CLI endpoint. Public configuration is a proposed `--public-url` option.
- The first proxy-supported variant uses a dedicated origin at `/`; reject
  credentials, query, fragment and non-root path in the configured public URL.
  Define canonical port/hostname/IPv6 handling and test equivalent origins.
- Existing direct HTTP mode remains explicit and compatible. Proxy mode uses
  HTTPS publicly and a loopback/private backend that cannot be reached by
  untrusted clients. A private IP alone does not prove access restriction.
- Derive security decisions from configured origins, never untrusted forwarding
  headers. Avoid introducing forwarded-header trust unless a concrete field
  needs it; then scope it to explicit peers and test the full trust chain.
- Browser mutation requests must use an allowed origin. Define separately the
  authenticated non-browser CLI path, including absence of Origin. Reject
  malformed and `null` browser origins and test cross-origin read/SSE behavior.

Write a small failing test for the current HTTPS incompatibility before fixing
it. Add negative cases for forged Host/forwarded headers and invalid public URLs.
Specify failure behavior before expanding options or changing authentication.

Gate G0: reviewers can see proposed contracts, baseline results and failing
regressions tied to actual code. Unresolved address/authentication semantics
block proxy integration, rather than becoming implicit defaults.

## Stage 1: HTTPS for the existing local controller

### 1A. Address configuration and service compatibility

Current source points:

- `src/server/http-server.ts`: `hasValidOrigin` currently accepts only `http:`
  and compares with Host; request URL construction also assumes HTTP.
- `src/cli/pairing-url.ts` and `src/cli/index.ts`: pairing and advertised service
  addresses are constructed as HTTP URLs from the listening/LAN host.
- `src/cli/service-access.ts`: one dashboard endpoint currently also supports
  CLI access. Audit `src/cli/project-management.ts` and service-status callers
  before separating public and internal endpoint fields.
- `src/cli/service-manager.ts`: persist the selected public origin through
  generated service definitions and explicit refresh.

Implement one validated configuration contract and use it across these callers.
Public links must use the configured HTTPS origin. Local CLI operations must
remain usable when public DNS, proxy or its certificate is unavailable, using
the explicitly local authenticated endpoint. Preserve owner-only access-record
permissions and define compatibility for existing records. Do not repurpose an
existing field without migrating all consumers. An update must not silently
change binding, disable MCP or overwrite installed options.

Gate G1A: URL parsing, link generation, old/new access records, service-definition
round trips and local CLI fallback pass focused tests. A bad configuration must
fail before exposing a new listener or stopping a working installation.

### 1B. Origin, pairing and SSE

Apply the configured-origin contract to HTTP mutations without widening access.
Keep token authentication independent of transport checks. Specify allowed Host
handling for direct and proxy modes and reject arbitrary externally supplied
origins. Keep the current MCP listener on loopback; public MCP authorization is
not implemented by proxying that listener.

The current SSE path accepts a token in its query string. Resolve this before
calling the proxy path ready. Preferred first investigation: stream authenticated
SSE with fetch and a header while preserving bounded reconnect, cancellation,
event framing and existing refresh behavior. Decide this mechanism in G0; if a
short-lived stream credential is chosen instead, define expiry, audience, replay
and log redaction tests. Do not introduce account cookies accidentally through
this transport slice. Reusing a permanent token in URLs must not be the default
published proxy recipe.

Gate G1B: positive authenticated flows and negative origin/token/Host tests pass.
Test SSE reconnect, stop/dispose, partial frames, duplicate subscriptions and
refresh/error retention. Scan captured controller/proxy diagnostics for a unique
synthetic secret and require no matches. Exclude intentional private pairing
output/access records from public diagnostics; test their permissions separately.

### 1C. Supported proxy recipe and full HTTPS proof

Choose one reverse proxy with a reproducible test version and official setup
references. Provide certificate issuance/renewal and private-CA guidance,
SSE streaming/timeouts, sanitized access logging and backend access restrictions.
A domain with trusted certificates and a LAN/private-CA installation have different
setup requirements; describe both without disabling TLS verification.
Do not bundle a certificate authority or require a specific hosted provider.

Exercise the built application through real TLS with the fixture CA trusted by
the client. Cover pairing, API reads/mutations, SSE/reconnect and local CLI access.
Test wrong hostname/untrusted or expired certificate, unavailable proxy, invalid
backend configuration and certificate replacement. None may silently downgrade
an HTTPS installation to public plaintext. Test fresh installation and upgrade
from the preceding direct-mode configuration. Keep evidence free of pairing URLs.

Gate G1C: focused tests, relevant integration/browser suites and packaged install
smoke pass on the same build; direct LAN/loopback behavior remains covered.
Certificate replacement/recovery and no-secret logging have explicit evidence.
Only then close `FEAT-20260829-controller-https`. Native Node TLS is deferred
unless this experiment demonstrates that proxy deployment fails a required use.

## Stage 2: one authenticated remote execution path

Use `FEAT-20260905-remote-commit-verification` as the workflow owner. Extract
project identity from machine registration as the first remote use needs it.
Define worker identity, request, execution attempt and reported state; use the
existing local queue/executor behind an interface. Keep one local lifecycle
coordinator and database owner, not duplicated lock maps or schedulers.

Before any remote mutation, implement minimum durable principal identity,
project/worker grants and scoped worker enrollment/revocation. Full accounts and
multi-tenant hosting follow in stage 3, but authorization cannot wait until then.
Prototype on one owner-controlled worker and trusted disposable repositories.

Deliver exact-SHA submission, worker-side source validation and preset execution,
then bounded output and persisted result. Specify protocol version negotiation,
heartbeat/last-contact evidence, attempt identifiers and offline policy. Never
interpret a lost connection as process exit or automatically redispatch uncertain
work. Distinguish cancellation requested from owned termination confirmed.

Early tests, before UI integration:

1. Pure transition/authorization tests reject stale attempts, invalid sources,
   disallowed presets, foreign workers and revoked credentials.
2. Protocol fixtures inject duplicate, delayed and reordered messages; local and
   remote executor contract tests preserve idempotency and capacity ownership.
3. Real two-process fixtures disconnect mid-run, restart each side, move a branch
   while queued and cancel a job with a surviving descendant. Verify exact SHA,
   retained evidence, no false terminal state and successful reconciliation.
4. Run the complete flow through an actual supported MCP client, then dashboard
   and CLI. Record client requirements and manual setup steps.

Gate G2: every fault case has bounded recovery or an explicit uncertain state;
no unqualified success, unauthorized execution or duplicate redispatch. Both
local operation and remote self-hosting pass. Hosted access is still private.

## Stage 3: durable accounts and organization isolation

Use existing independent-auth/scoped-token/account records as inputs. Before
implementation, create the narrowly scoped organization/worker identity backlog
records needed by this stage; do not treat local web accounts as equivalent to
multi-tenant isolation.

Define organization membership and user, agent and worker principals. Enforce
permissions in shared application operations, not only HTTP handlers. Each
project, worker, request, attempt, result and artifact must have an unambiguous
organization boundary. Resolve that boundary through authenticated membership
and grants; a client-supplied organization ID is never sufficient authority.
Separate reading knowledge, executing code and using a credentialed profile.

Use the optional Better Auth provider from the authentication update for account
login, after its integration gates pass. Specify session lifetime/revocation,
worker enrollment/rotation and separate public MCP authorization before exposing
remote MCP. Retain local
pairing only as an explicit local mode. Design local-data migration into an
initial organization without losing ownership, history or access.

Start with two-organization deny tests at the application/storage boundary,
before building account screens. Run the same cases through HTTP and MCP:
foreign IDs, list/search/history, logs/artifacts, SSE subscriptions, cancellation,
worker reassignment, revoked membership and stale credentials. Verify revocation
for existing long-lived connections and accepted-work policy, not just new login.

Gate G3: organization isolation and migration/restore tests pass; missing scope
fails closed. Shared local pairing credentials cannot authorize hosted customers.
A security review of tenant and worker boundaries is required before a public
pilot. Fix reproducible findings and rerun their negative tests.

## Stage 4: repeatable self-hosted and SaaS operation

Produce two deployment profiles from the same application, with explicit enabled
capabilities. Self-hosted installs use owner-controlled configuration and work
without the operator's service. SaaS runs the control plane; customer workers
remain outbound-connected executors.

Select central persistence against durable remote requests, organization
isolation, backup/recovery and required concurrency. PostgreSQL is an option,
not a migration performed by this plan; SQLite remains the worker adapter.
Validate storage contracts and migrations against the chosen adapter. Define
artifact retention, quotas, request admission, monitoring and secret handling.
Billing follows a working private pilot and must not dictate local execution.

Test fresh install, upgrade, backup and actual restore, credential rotation,
worker reconnect and rollback compatibility in a clean environment before pilot
rollout. Measure bounded load and overload responses before accepting multiple
customers. Record RPO/RTO targets before measuring recovery. Distinguish service
availability from availability of customer workers.

Gate G4: restore and staged-upgrade rehearsals pass; a representative owner and
self-hosted user can complete setup without hidden host configuration. Publish
support limits and known failures. Public deployment is a separate explicit
operation; passing tests does not authorize changes to the current installation.

## Delivery discipline and evidence

Each stage starts with its smallest executable failure case. Prefer fast pure
and contract tests, then controlled fault injection, then real process/network
integration, then browser and clean-install validation. Do not postpone negative
authorization, disconnect or migration cases to a final QA phase. A failed gate
blocks dependent implementation; fix the cause rather than widening an allowlist,
disabling certificate verification or retrying away a failure.

Stage 1 can use three reviewable PRs matching 1A/1B/1C. Keep intermediate changes
compatible; do not advertise proxy support until G1C passes. Later stages should
be divided around usable workflows, not empty framework modules. Read relevant
subtree instructions and route changes through existing application boundaries.

Follow repository verification rules: focused tests for changed behavior,
`pnpm check`, `pnpm build` for modules/bundles, relevant integration and browser
suites against the verified build, and package smoke when distribution changes.
Use managed presets when available. Run heavy verification serially and keep
host guards intact. New fixture commands must be public supported project
commands and included in CI where applicable. Do not require the installed
controller for isolated acceptance or restart it as part of a test.

For each gate record source commit, build fingerprint, dependency versions,
scenario/result matrix, relevant sanitized evidence and unresolved limitations.
Demonstrate that representative deliberately invalid inputs or injected failures
make the check fail; a green happy path alone does not prove the guard works.
Record rollback compatibility before rollout, including database changes and
old-client behavior. Never claim a restarted job completed its original run.

Planning validation: canonical Hub fmt/validate, local-reference checks and
`git diff --check`. Saving this plan does not execute the application, deploy
TLS, install the selected authentication provider or restart a service.
