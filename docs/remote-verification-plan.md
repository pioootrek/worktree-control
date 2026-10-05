---
audience: "owner, contributors, and coding agents"
last_reviewed: "2026-10-05"
source_of_truth: "remote verification and worker direction from the owner discussion on 2026-09-05"
status: "active"
---

# Remote verification of pushed commits

## Implementation status, 2026-09-27

On `main` at `17d0c9d`, request authorization/persistence, attempt-state
operations and exact-SHA workspace preparation are implemented with tests.
Enrollment and worker credentials, outbound dispatch, finite-queue execution,
reconnect/cancellation and caller transports remain incomplete. The workflow
below is the acceptance target, not a currently available remote command.
See the [remaining implementation slices](backlog/notes/NOTE-20260909-self-hosted-saas-plan/remote-verification-implementation.md).

## Owner need and priority

The owner wants to work with an LLM remotely, including from a lightweight
device, and request build/test verification on a prepared remote machine.
The motivating flow resembles the owner's remote work with T3 Code; no
particular T3 integration or vendor capability has been verified or selected.
The agent stays in its existing client while verification runs elsewhere.

Promote this to an early experiment, ahead of autonomous fleet execution. It
does not depend on a complete forum, Hub migration, instruction generation,
paid SaaS, or remote agent launching. Memory can later link tasks and
discussions to run results. Existing urgent runtime reliability fixes keep
priority; queue reliability and truthful source attribution are foundations.
Track delivery in
[FEAT-20260905-remote-commit-verification](backlog/feature/FEAT-20260905-remote-commit-verification.json).

The complete connected-worker workflow remains planned; its foundations alone
do not constitute a deployed remote service. Other people's willingness to
pay remains a hypothesis; start with the owner's real workflow.

## First complete workflow

1. A human or agent commits and pushes changes to an authorized Git remote.
2. Through MCP, CLI, or web, the caller requests a registered project, exact
   commit SHA, configured verification preset, and selected worker.
3. The worker fetches from its configured source and prepares a clean workspace
   dedicated to the run. It checks that the executed SHA equals the requested
   SHA. Missing or unauthorized source fails without substituting branch HEAD.
4. The worker executes the preset through its local queue and resource policy.
5. The caller retrieves a durable run ID, status, terminal result, bounded
   output, and authorized links to retained logs or artifacts.
6. The agent reads the failure, pushes a fix, and submits another run. Evidence
   for the failed and corrected revisions remains separately attributable.

Local uncommitted edits are excluded. Branch names can help locate source but
are not execution identities. Record requested/executed SHA, repository,
preset version or resolved definition hash, worker, toolchain/environment
metadata without secrets, timestamps, and exit/termination details. A fixed
commit alone does not guarantee reproducibility. Distinguish setup failure
from test failure.

## Deployment and trust boundary

| Component | Responsibility |
| --- | --- |
| Self-hosted or optional SaaS control plane | Authorize requests, persist dispatch/run state, expose status and results |
| Customer-owned Worktree Control worker | Fetch approved code, prepare workspaces, enforce local policy, execute presets, report evidence |
| Existing LLM client | Request checks, read results, edit code, decide the next action |
| Optional knowledge module | Link runs to tasks, discussions, playbooks, and reviews |

Use the existing controller as the basis for an installable worker mode. A
worker can be a laptop, home server, or customer-owned cloud VM. Register its
stable identity, projects, supported presets, and capacity. It initiates an
authenticated outbound connection to the control plane; do not require inbound
SSH, port forwarding, or broad access to the customer's computer.

Requests select typed operations, not arbitrary shell commands, repository
URLs, or filesystem paths. Workers revalidate authorization, registered source,
preset, and local capacity at execution time. Remote dispatch never overrides
local limits or reservations. GitHub Actions and GitHub-specific APIs are not
required; an authorized Git source only needs to supply the requested commit.

Each controller owns its local SQLite/runtime state. Do not share a database
file across machines. A remote protocol reconciles durable request and attempt
identities. Exact transport, enrollment, credential revocation/rotation, and
storage layout remain design work. Existing pairing and loopback MCP are not
sufficient remote authorization.

## Initial execution scope

The [environment runtime plan](environment-runtime-plan.md) extends existing
profiles with worker-side secret references and scoped injection. Secret-free
checks can ship independently; integration jobs requiring credentials must
verify that authorization and source-trust boundary before enabling injection.

Start with one owner-controlled worker and trusted repositories. Support build,
unit tests, lint, and typecheck first. Resolve configured commands through
adapters as executable/argument arrays. Repository scripts execute code: an
allowlisted preset and separate directory are not a security sandbox. Define
who may push executable source and which runs may access test secrets.

Use separate per-run workspaces without moving active development worktrees.
Specify dependency installation, lockfile handling, toolchain selection,
cleanup, and cache keys. Bound concurrency, execution time, logs, artifacts,
and disk retention. Cleanup must preserve other runs and managed checkouts.
Keep repository credentials and test secrets on workers where possible.
Define output publication and access scope; bounded logs may still contain
sensitive data and must not be uploaded indiscriminately.

Browser/E2E jobs come later: they also need app lifecycle, service dependencies,
readiness, and artifact collection. Do not silently reuse a human's claimed
development server. Operator-hosted execution of unrelated customers' code
requires a separate isolation design and is outside the initial experiment.

## Disconnects, retries, and cancellation

Use idempotent submission, a stable run ID, and explicit attempt identities.
Persist enough state on both sides to reconcile after network loss, sleep, or
restart. Show queued, preparing, running, terminal, and uncertain execution
states with last-contact evidence; exact protocol enums remain to be specified.

Loss of contact does not prove failure or termination. Do not automatically
redispatch an uncertain attempt to another worker. Define recovery and a local
policy for accepted work when offline. Reject stale attempt updates without
losing their evidence. Idempotent submission is not an exactly-once execution
guarantee.

Cancellation requested and process exit confirmed are different events. The
worker confirms termination of its owned process tree before reporting
cancellation or releasing capacity. A restarted attempt cannot be reported as
completion of the original check.

## Delivery and verification

The [implementation slices and acceptance gates](backlog/notes/NOTE-20260909-self-hosted-saas-plan/remote-verification-implementation.md)
expand this direction against baseline `d429eb9`: automatic worker-owned source
preparation, six delivery slices, early failure tests and explicit recovery rules.
Worker source updates do not update its own executable or move a dev checkout.

The [architecture and effort assessment](architecture-effort-assessment.md)
estimates a narrow remote-worker slice and identifies enabling refactors.
Re-estimate after actual execution and recovery evidence; its calendar range
is not a delivery commitment.

1. Specify request/run contracts and prove exact-commit execution with fixture
   repositories using the existing queue/process abstractions.
2. Connect one worker to a self-hosted control plane with scoped outbound
   communication. Expose submission and bounded status/detail reads through
   MCP, CLI, and web.
3. Perform the owner workflow from an actual existing LLM client: push a failing
   commit, obtain remote evidence, push a fix, and obtain a distinct passing
   result. Report actual client capabilities and manual steps.
4. Add optional knowledge links and a small reusable installation trial before
   commercial packaging or operator-owned execution infrastructure.

Fixtures cover branch movement while queued, missing commits, unauthorized
source/presets, worker unavailability, duplicate submission, disconnect during
execution, restart recovery, stale attempt reports, cancellation with surviving
descendants, setup failure, cache separation, bounded output, and safe cleanup.
Test recovery of durable run metadata and expose artifact expiration.

Success means trustworthy remote evidence without manual SSH or copying logs
into a conversation. Measure submission-to-result time, manual steps, failed
recoveries, resource usage, and repeat use. A phone-driven demo does not replace
failure-path verification. Use throwaway repos for development verification.

## SaaS path and open decisions

Optional SaaS hosts knowledge and coordination/control services. Customers
supply execution hardware and model access initially. Self-hosting supports the
same remote checks. Hosted memory works without a worker, and verification
works before adopting memory. Operator-hosted runners are a separate possible
paid offering, not included in a small hosting fee by default.

Later [fleet adapters](agent-fleet-coordination-plan.md) may launch, wake, and
cancel supported agent sessions. Ownership of development/test processes does
not imply control of an external LLM client.

Open choices include transport/reconnect protocol, worker access scopes,
trusted-source policy, environment fingerprints, provisioning, retention, and
offline cancellation. No provider, price, remote-client compatibility, or
deployment is agreed by this plan.
