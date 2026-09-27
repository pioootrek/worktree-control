# Remote commit verification: implementation slices and acceptance gates

## Current delivery status, 2026-09-27

At main `17d0c9d`, request/grant persistence, exact-SHA workspace preparation
and attempt transitions are implemented. They cover parts of slices 1–3;
they do not constitute a connected worker. Do not restart those components
from scratch. Remaining work is enrollment and credential lifecycle, queue
execution, outbound dispatch/recovery, caller transports and owner acceptance.
The original baseline and next-step recommendation below are historical.
See [the reconciliation](../NOTE-20260829-readiness-assessment/reconciliation-20260927.md).

Date: 2026-09-11. Inspected baseline: `d429eb9` (`main`).
Owner: `FEAT-20260905-remote-commit-verification`.
Status: implementation plan; remote execution is not implemented by this document.

## Outcome and confirmed direction

The owner pushes a commit, requests a preset on a registered worker, and receives
an attributable result without SSH, manual checkout, or copying logs. The worker
fetches the requested project code itself when needed. This updates the run's
source workspace, not the worker executable or an active development checkout.
Worker software upgrades remain a separate operation with version compatibility.

Self-hosting runs the complete flow without the owner's SaaS. The optional SaaS
hosts coordination and results; execution initially remains on customer-owned
machines. Start with one owner, one worker and trusted disposable repositories.
Support finite build, unit-test, lint and typecheck presets. Browser suites,
shared memory, billing, autonomous agents, and operator-hosted untrusted execution
are separate work. A per-run directory is not a sandbox against malicious code.

## Proposed contracts and boundaries

Use shared application operations behind HTTP, MCP and CLI. Extend existing
verification and lifecycle modules rather than creating a second local scheduler.
The control plane owns durable requests and dispatch; the worker's existing
queue owns local admission, process capacity, cancellation and output capture.
Each process has its own SQLite owner. Never share a SQLite file across hosts.

Submission contains registered project ID, full commit object ID, preset ID,
worker ID, authorized environment profile and caller-scoped idempotency key.
A branch/ref hint is optional for locating the commit; it is never the execution
identity. Repository URLs, arbitrary commands and caller-selected disk paths are
not submission fields. Validate object IDs for the repository's declared format.

Keep project identity independent of host-specific repository registration. Store
request ID, attempt ID, principal/access scope, worker, requested/resolved SHA,
preset/profile definition hashes, toolchain versions, phase timestamps, setup
outcome, process outcome, source observations, last contact and retention state.
Reject reusing an idempotency key with a different payload. Repeated identical
submissions return the same request; an explicit retry creates a new attempt.

Propose versioned HTTPS endpoints with worker-initiated bounded long polling,
heartbeats and acknowledged report batches. Reuse ordinary HTTP transport before
adding a broker or another protocol. Workers authenticate with separately scoped,
revocable credentials, not dashboard pairing tokens or loopback MCP credentials.
Persist acknowledgements and report sequence numbers; negotiate protocol versions
and fail closed on incompatibility. Tune polling/heartbeat budgets in the protocol
fixture before treating numeric defaults as supported contracts.

## Automatic preparation of the requested source

1. Authorize principal, project, worker, preset and profile at submission and
   again before preparation/execution. Resolve source URL and permitted refs from
   worker-controlled registration. Never accept a replacement remote from a job.
2. Maintain a worker-owned repository cache scoped to registration and security
   domain. Serialize cache fetch/update/cleanup. Never fetch into a human checkout.
3. Fetch allowed refs when the requested object or required authorization evidence
   is absent. Use bounded Git processes and worker-local read credentials. Disable
   interactive prompts and arbitrary Git protocol/helper use. Verify source identity
   and reachability according to the registered allowed-ref policy. A cached object
   alone is not authorization. Record the authorization observation used for a run.
4. Verify the full object ID resolves to a commit. Prepare a detached, clean,
   attempt-specific checkout under the worker's private run root. A branch moving
   after submission must not change the requested SHA. An unavailable, forbidden,
   shallow-history-missing or force-pushed-away commit fails source preparation;
   never substitute branch HEAD. Fetch deeper history only within configured bounds.
5. Reuse already fetched objects only after policy checks. V1 rejects repositories
   requiring submodules or Git LFS hydration with an explicit unsupported-setup
   result; it must not silently test incomplete source. Add support separately.
6. Select an installed, approved toolchain and install dependencies using the
   configured adapter and frozen lockfile mode. Define required lockfiles and
   supported adapters in the preset; missing tools, incompatible versions, install
   failures and disk exhaustion are setup failures. Capture bounded setup output.
   Installation scripts are code execution and use the same trust/resource policy
   as tests. Do not inherit the controller's environment or repository credentials.
7. Verify HEAD and tracked source after setup, then immediately before execution.
   Record generated/untracked output separately from tracked-source drift. Preserve
   existing source-attribution evidence; an exact initial SHA is not proof that
   scripts did not alter source. Distinguish passing process exit from uncertain or
   changed-source attribution rather than claiming immutable/reproducible execution.
8. Execute through local queue capacity and process ownership. Keep dependency
   caches separate from mutable run workspaces; key by registration/security scope,
   lockfile, platform and toolchain. Never share writable node_modules or environments
   across attempts. Clean only verified worker-owned paths after terminal evidence,
   with quotas, reference tracking, retention and symlink/path-escape checks.

## Delivery order

Each slice is independently reviewable. A failed gate blocks the next dependent
slice. Use small failing regression tests before adding the behavior, then focused
checks. Existing local verification must keep working throughout.

| Slice / PR | Implementation | Early validation and exit gate |
| --- | --- | --- |
| 1. Identity, grants and state contracts | Durable principal, project/worker registration, one-time enrollment, credential hashes, revocation, protocol schemas and request/attempt transitions. No remote execution listener yet. | Reject foreign project/worker, revoked/expired credential, enrollment replay, unsupported version, stale attempt and changed-payload retry. Transaction/migration tests cover upgrade and restart. Gate: authorization and transition tables are executable tests. |
| 2. Exact-SHA preparation | Worker-owned Git cache and clean attempt checkout, approved toolchains, frozen dependency setup, setup evidence and bounded cleanup. Exercise via a local fixture adapter first. | Real temporary Git remote: missing/cached commit, branch movement, denied source/ref, fetch interruption, shallow history, unsupported submodules/LFS, dependency failure, disk quota and unsafe path. Gate: executed source is requested SHA or explicit setup failure; active dev checkout stays untouched. |
| 3. Local queue integration | Admit preparation and execution into the existing worker queue, retain one lifecycle/capacity authority, persist phase transitions and output. | Duplicate acceptance cannot launch twice. Concurrent cache users, capacity exhaustion, reservations, setup timeout and descendant cancellation preserve limits. Gate: setup consumes bounded capacity; existing local queue tests pass. |
| 4. Outbound authenticated dispatch | Worker polling, claim/ack protocol, durable reports, heartbeat and reconciliation. Control plane returns typed work only. | Two real processes: drop acknowledgement after acceptance, duplicate/reorder reports, disconnect during setup/run, restart either side, revoke credentials and reject incompatible protocol. Gate: no silent retry or false completion; accepted work reconciles by attempt ID. |
| 5. Caller workflow | Shared submit/status/cancel operations exposed to MCP, CLI and dashboard; source, setup, connectivity and process results displayed distinctly. | One supported MCP client submits a failing pushed commit, reads evidence, then submits the corrected commit. CLI/UI show the same identities and outcomes; PL/EN and keyboard flows pass. Gate: no SSH/manual checkout/log copying required. |
| 6. Installation and acceptance | Repeatable self-hosted controller + worker setup, retained/expired output behavior, credential rotation and restore instructions. Exercise the same protocol against an alternate control-plane address. | Fresh install, upgrade, database restore, offline worker and credential rotation tests; source/log access isolation across two independent registrations. Gate: observed owner workflow plus evidence for recovery, bounded resources and safe cleanup. |

Slices 2 and 3 may share implementation scaffolding, but no unbounded preparation
path may ship while queue admission remains pending. Remote dispatch in slice 4
requires the authorization, source and resource gates from slices 1–3.

## Failure and recovery semantics

Proposed execution phases: queued, preparing, running, passed, failed, cancelled,
timed_out and interrupted. Setup outcome, cancellation request and connectivity
are separate fields. Reuse existing local semantics where equivalent; define the
remote mapping explicitly rather than replacing the local state machine wholesale.

An accepted attempt is persisted on the worker before acknowledgement. Losing an
acknowledgement may redeliver the same attempt, never a new execution identity.
Worker-local acceptance must be idempotent across restart. Sequence-numbered
reports are persisted and retried until acknowledged; terminal reports are immutable
except through an explicitly modeled correction/audit operation.

Loss of contact makes execution uncertain; it does not prove process termination
or release the attempt for another worker. Previously accepted work may finish
under worker-local time/resource limits while offline; retain results in a bounded
spool. Do not start additional work without valid local authorization. After a
worker restart, reconcile owned process identity and persisted state before marking
interrupted or releasing capacity. Never kill a process based on PID/port alone.

Cancellation persists intent on the control plane; only worker evidence of owned
process-tree termination establishes cancellation. Offline cancellation stays
pending. Revocation blocks new dispatch and remote access immediately; termination
of already offline execution cannot be guaranteed remotely and must remain visible
as unconfirmed. Hard local timeouts remain enforced without connectivity.

Setup failures, test failures and lost evidence are distinct. Missing/spool-expired
logs are reported honestly, not as empty successful output. Disk/spool limits apply
before accepting more work. Retries require an explicit policy/user request and a
new attempt after the previous attempt is terminal or administratively reconciled.
Do not promise exactly-once execution across arbitrary failures.

## Access and SaaS readiness

Put the access scope on project/worker/run records and enforce it for submission,
status, cancellation, logs and artifacts. In self-hosted V1 it can be one local
owner scope; test a second scope for leakage before sharing hosted persistence.
Full accounts and organization management remain stage 3 of the parent plan.

Git credentials remain on the worker and are available only to the fetch adapter.
V1 uses trusted source without test secrets. Credentialed presets depend on the
separate environment-runtime grant policy. Bound and sanitize diagnostic output;
log access still requires authorization. Artifact upload is opt-in with explicit
allowlisted paths, size/retention limits and path/symlink validation. A run outcome
must remain readable even when its artifacts expire.

No customer-specific host paths or SaaS-vendor SDKs belong in shared contracts.
Self-hosted deployment uses its own HTTPS origin and local database. Hosted
multi-tenant deployment is not declared ready by a successful one-worker demo.

## Verification evidence and handoff

Use current supported finite commands and the managed test queue when registered
presets exist. Run heavy suites serially within host policy. Fixtures use isolated
Git repositories, databases, ports and owned processes, never the installed service.
Run relevant unit/integration tests, `pnpm check`, `pnpm build`, and affected browser
flows for each behavioral slice; run the two-process fault matrix before UI work.

Record actual requested/executed SHA, attempt ID, toolchain/profile hashes, setup
and process outcomes, cleanup evidence and measured submission-to-result time.
Capture the failing/corrected commit owner workflow and manual provisioning steps.
Review before merge; deploy only after checks and when the installed controller is
idle. Keep remote dispatch opt-in and independently disableable. Rollback stops new
submissions, retains uncertain attempts/results and preserves local verification.

At the original planning baseline, the next task was slice 1; use the current
delivery status above when selecting remaining work. Before coding, finalize the allowed-ref
policy, credential expiry/revocation behavior and protocol state table in its tests.
Provider-specific enrollment UX, polling intervals and supported initial toolchains
are implementation decisions to validate in their slices, not completed contracts.
