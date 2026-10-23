---
audience: "owner, contributors, and coding agents"
last_reviewed: "2026-10-23"
source_of_truth: "remote verification and worker direction from the owner discussion on 2026-09-05"
status: "active"
---

# Remote verification of pushed commits

## Implementation status, 2026-10-23

Request authorization/persistence, attempt-state operations and exact-SHA
workspace preparation were already implemented on `main` at `17d0c9d`.
The current development branch adds an opt-in worker protocol, durable worker
receipts and reports, existing finite-queue execution, local provisioning and
MCP submit/status/log/cancel operations. This is an experimental first fragment,
not a deployed or accepted WinPath workflow.

The fragment accepts dependency-free Node projects and clean profiles only.
Verification uses the worker's Node executable directory plus fixed system
directories in PATH, supporting a user-local Node installation without copying
the controller's environment.
It does not install dependencies, upload artifacts or stream live logs. A
manifest declaring dependencies is refused as setup failure; therefore this
fragment cannot yet verify WinPath. Real worker selection, deployment approval,
and the failed/fixed WinPath acceptance trial remain outstanding. An isolated
worker subprocess crash/restart test confirms quarantine and no repeated
command; controller process-crash and operator recovery acceptance remain open.

See the [remaining implementation slices](knowledge/AGENTS.md) (Knowledge attachment `64ab7a29d6c4ae015d5cd794c58a8a68`).

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
[FEAT-20260905-remote-commit-verification](knowledge/AGENTS.md) (Knowledge task `0e2204a2e0e0945eee4f754b2f932eed`).

The complete accepted worker workflow remains pending; implementation and
fixture tests alone do not constitute a deployed remote service. Other people's willingness to
pay remains a hypothesis; start with the owner's real workflow.

On 2026-10-23 the owner explicitly started implementation before completion of
the product-interest test, superseding the earlier ordering recorded in
Knowledge task `0e2204a2e0e0945eee4f754b2f932eed`. WinPath is the reference
project. The first scope is one owner-controlled Linux worker, one project,
and one verification preset without application secrets. Protocol development
and fault testing use isolated fixtures; no production worker has been selected.
Implementation authorization includes tests, local commits and PR preparation,
but excludes merging, deployment, service changes, host-limit changes and
account configuration. Backup diagnostics and automatic-backup acceptance are
separate work.

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
identities. The experimental contract below defines transport, provisioning,
revocation and local persistence. Credential rotation and operational enrollment
remain open. Existing pairing and loopback MCP are not
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

The [implementation slices and acceptance gates](knowledge/AGENTS.md) (Knowledge attachment `64ab7a29d6c4ae015d5cd794c58a8a68`)
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

Keep fixture evidence separate from acceptance on the actual worker. For the
owner trial, retain the failed pushed commit's request ID, attempt ID, requested
and executed SHA, preset identity, result and bounded output. Push a correction
and retain a distinct passing result with the same evidence. Also exercise
disconnect, restart, duplicate submission and cancellation without duplicate
execution. A protocol fixture alone does not close this gate. Select the target
machine and agree its operational setup only when this actual trial is ready;
implementation permission does not authorize deployment.

Success means trustworthy remote evidence without manual SSH or copying logs
into a conversation. Measure submission-to-result time, manual steps, failed
recoveries, resource usage, and repeat use. A phone-driven demo does not replace
failure-path verification. Use throwaway repos for development verification.

## Experimental setup contract

This contract describes the development slice, not an instruction to modify
an existing installation. Use dedicated fixture data/state directories first.
Each installation keeps its own SQLite owner and singleton lock. Provisioning
requires a stopped installation and its local owner session credential;
installation-wide and worker tokens cannot administer these grants.

1. Register a local verification-only project on each installation with the
   existing project command and the `none` launch preset.
2. Prepare an independent worker-owned clone as the source cache, outside
   registered project repositories. Keep the configured named remote there;
   requests cannot supply repository URLs or filesystem paths.
3. On the broker, run `remote-verification provision --file FILE`. The JSON
   contains `project: {id, name, sourceRemote}`, `worker: {id, name}`,
   `localProjectId`, `presetIds`, `callerPrincipalIds`, and `workerTokenFile`.
   Caller IDs must refer to existing active owner/agent principals. The command
   creates the token file exclusively with mode `0600` and prints identifiers,
   including the worker principal and credential IDs, without the token.
4. On the worker, provision the same project/worker IDs with its local project
   ID, `worker.principalId` from the broker, and `callerPrincipalIds: []`.
   Omit `workerTokenFile`; transfer the broker token through a private channel.
5. Supply `start --remote-verification-config FILE` explicitly. The broker
   configuration is `{version: 1, listener: {host, port, keyFile, certFile}}`.
   The worker configuration is `{version: 1, worker: {workerId, origin,
   tokenFile, workspaceRoot, mappings}}`. Each mapping contains `projectId`,
   `localProjectId`, `sourceCachePath`, `sourceRemote` and `presetIds`. File
   and directory paths are absolute, local configuration. Production transport
   requires HTTPS; `allowLoopbackHttpFixture: true` permits HTTP only with a
   numeric loopback origin/listener. Worker software supports Linux in this
   trial; no worker service installer is introduced.
6. Connect the existing MCP client with an owner/agent credential granted on
   the broker. Call `submit_remote_verification` with `projectId`, `workerId`,
   full `commitSha`, `presetId` and a stable `idempotencyKey`. Use the returned
   request ID with `get_remote_verification`, `get_remote_verification_logs`
   or `cancel_remote_verification`. A repeated identical submission returns
   the original request. A correction uses a new SHA and idempotency key.
7. Credential revocation uses `remote-verification revoke-token
   --credential-id ID` under the same stopped-installation owner boundary.
   Local active work may finish while disconnected; revocation does not prove
   that a remote process has stopped.

Status distinguishes setup failure, execution failure and uncertainty. The
reported result includes requested/executed SHA, local run/attempt identity,
preset/environment fingerprints, source observations, exit and cleanup evidence.
Logs are the last uploaded tail, at most 200 lines of 2,000 characters, further
trimmed so the serialized report envelope stays within 512 KiB. Live
output and artifacts are not uploaded; an empty tail is not proof of no output.
Cancellation intent can be read while the worker is offline; confirmation waits
for owned-process cleanup. Terminal reports and acknowledgements survive
reopening the databases and are replayed without creating a new execution.

Worker receipt retention currently stops new acceptance at 1,000 records;
existing report delivery continues when that limit is reached. Local run details
remain protected from normal history pruning until a durable receipt outcome
preserves their completion evidence. This can retain up to 1,000 additional run
details while collection is delayed. Routine retention maintenance remains open.

Source preparation currently uses the existing per-command Git timeouts. The
preset timeout starts with test execution; it is not an overall preparation
deadline. Cancellation during preparation prevents the test from starting but
waits for preparation to settle before cleanup and capacity release. Propagating
cancellation through preparation, defining its overall deadline and exercising
stalled-source failures remain required before the real-worker trial.

After a restart, accepted work with unknown process cleanup blocks new finite
jobs in the worker installation, even if the remote configuration is omitted.
This conservative block has no automatic release or operator reconciliation
command in the first fragment. Do not delete receipts or assume a PID/port proves
process ownership to clear it. The subprocess fixture kills the worker after
its running report, lets its finite child exit, and restarts against the same
database: the old attempt remains uncertain and new execution is blocked.
A safe operator recovery workflow and controller process-crash acceptance remain
required before routine worker use.

## SaaS path and open decisions

Optional SaaS hosts knowledge and coordination/control services. Customers
supply execution hardware and model access initially. Self-hosting supports the
same remote checks. Hosted memory works without a worker, and verification
works before adopting memory. Operator-hosted runners are a separate possible
paid offering, not included in a small hosting fee by default.

Later [fleet adapters](agent-fleet-coordination-plan.md) may launch, wake, and
cancel supported agent sessions. Ownership of development/test processes does
not imply control of an external LLM client.

The experimental fragment makes initial choices for transport, access scopes,
trusted sources, fingerprints, provisioning and offline cancellation. Operational
enrollment, credential rotation, retention maintenance, preparation deadlines
and safe recovery from unknown process ownership remain open. No provider,
price, remote-client compatibility, or deployment is agreed by this plan.
