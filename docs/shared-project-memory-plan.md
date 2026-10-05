---
audience: "owner, contributors, and coding agents"
last_reviewed: "2026-10-05"
source_of_truth: "shared project memory direction and phased delivery plan from the owner discussion on 2026-09-05"
status: "active"
---

# Shared project memory, discussions, and backlog

## Direction and current status

Latest owner decision on 2026-09-13: deliver the working flow on SQLite first.
Migration to PostgreSQL is deferred and does not gate K1 or the first SQLite
workflow. This supersedes the earlier PostgreSQL-first direction; see
[the database decision](backlog/notes/NOTE-20260913-knowledge-backlog-implementation/database-portability.md).


The owner wants Worktree Control to provide shared memory for humans and
agents, a forum for exchanging information, and a backlog for findings that
will not be addressed immediately. Build this as a cohesive module within
Worktree Control, reusing its project registry, controller, SQLite infrastructure,
dashboard, and MCP integration. The core module is implemented on `main`,
including threads/replies/tasks, revisioned memory and approval, search/context,
attachments, backup/restore, logical project transfer and resumable Hub import.
Find current acceptance and migration work in Knowledge project
`k7a-worktree-switcher`, using the legacy ID from the archived record
[FEAT-20260905-shared-project-memory](backlog/feature/FEAT-20260905-shared-project-memory.json).

The [implementation plan from 2026-09-13](backlog/notes/NOTE-20260913-knowledge-backlog-implementation/implementation-plan.md)
breaks this direction into K0-K9 delivery stages with code entry points,
recommended contracts, Hub data mapping, test cases, and cutover/rollback
gates. Its current-status section distinguishes delivered K0–K6 work from
K7 pilot/cutover acceptance and future K8/K9 instruction workflows. The local
cutover uses token-mode access to runtime and Knowledge through one installation
token. This repository now writes its backlog to Knowledge project
`k7a-worktree-switcher`; existing Git records are its import archive. Follow
[the current workflow](backlog/AGENTS.md) rather than the historical file-write
instructions in imported plans.

The priority is usefulness to the owner, then cooperation between the owner's
agents and models, then usefulness to other people. Open source with optional
paid hosting is a possible distribution model, not a prerequisite for the
owner's first working version. Existing urgent runtime reliability work keeps
its priority.

## The workflow that prompted this plan

The owner already uses LLM Ops Hub by discussing an idea with an agent and
then asking it to save the conclusions into the project backlog. This plan
was requested in exactly that way. Preserve that useful behavior while
removing the GitHub feedback detour and repository synchronization dependency.

The first complete workflow is:

1. A human discusses an idea with an agent in an existing client.
2. The human asks the agent to save the plan or finding for the project.
3. The agent records a concise account of the discussion, distinguishing
   agreed direction, proposals, evidence, and open questions.
4. The human reads and replies in Worktree Control's web interface. Another agent
   finds the same thread and adds evidence or a different conclusion.
5. An actionable finding becomes a linked backlog task without duplicating
   the discussion. A settled conclusion can become a memory entry.
6. A later session retrieves the relevant context and continues the work.

Saving an out-of-scope finding must be cheap: a title, useful description,
project, and source are enough to capture it; authorship is recorded by the
service. Detailed implementation scope, risk, and verification can be added
when preparing the task. Do not require a full planning form for every note.

## Three connected views

| View | Purpose | Typical content |
| --- | --- | --- |
| Discussions | Exchange and challenge information | Questions, findings, proposals, replies, evidence |
| Memory | Retrieve durable project knowledge | Decisions, verified facts, pitfalls, superseded conclusions |
| Backlog | Preserve work for later | Tasks, priorities, status, links to originating discussions |

These views share stable links rather than copying the same prose. A thread
is not automatically an accepted decision. Multiple agents agreeing is not
verification by itself. Preserve who stated something, what was checked, and
which source revision or commit the result concerns. A later correction keeps
the original history and identifies the conclusion it supersedes.

Implemented record schemas live in `src/shared/contracts/knowledge.ts`,
application operations in `src/server/modules/knowledge/`, and persistence in
`src/server/infrastructure/sqlite/`. Use those contracts for current behavior;
later playbook and instruction workflows still need their own bounded design.

## Source of truth and file access

The module's service-owned database becomes the source of truth for its shared
memory, discussions, and backlog. UI, MCP, and CLI use the same application
services and authorization rules. Transport handlers do not implement separate
business rules, and agent clients never access SQLite directly.

Generate Markdown or JSON when an agent or human needs a file. Exports carry
source identifiers, revisions, and generation time. They are snapshots, not a
second writable database. Editing an export does not silently update the
service; changes must be submitted explicitly through the supported write
interface. Start with faithful assembly of recorded content. Any later
LLM-generated summary must be labeled and linked to its sources.

Code and documentation maintained in a repository remain authoritative there.
The module can link to a path and commit without taking ownership of that
document. GitHub and Git are not required for everyday knowledge operations;
repository links are optional context.

## Module boundary inside Worktree Control

The [environment runtime plan](environment-runtime-plan.md) covers configuration
and secret delivery to workers. Knowledge records may link to safe profile/run
metadata; they do not store secret values or grant credential access. This is
a distinct authorization boundary within the broader operations-hub direction.

The planned scope also preserves the Hub's useful instruction inspection and
playbook monitoring capabilities. These follow the basic memory/discussion
workflow rather than expanding its first implementation slice.

Use SQLite behind a dedicated knowledge service/store boundary, with explicit
migrations. Reuse the existing controller and dashboard for local operation.
The module shares the controller-owned SQLite connection with runtime state.
Knowledge query helpers and migrations do not open a competing database owner.

Knowledge belongs to a stable project identity. Worktree paths, branches,
commits, and test runs are optional references, not the lifetime of a record.
Removing a worktree or unregistering its runtime must not cascade-delete
project memory. Knowledge operations do not acquire a server claim or start
a development server. Log pruning and runtime retention do not prune memory.

Keep application services independent of Git discovery and process management
so the knowledge module can eventually run on its own. A hosted knowledge
project must not require a local repository path, port, or development command.
This does not require building remote synchronization or a second service in
the initial local slice.

Durable authorship, revision checks against lost updates, retry-safe creation,
bounded search/read responses, export, and recoverable backups are part of the
design. An existing MCP session is not a durable person or agent identity; a
caller-supplied display name is not proof of human approval. Define this trust
boundary when extending writes. K1 supplies durable principals and scoped
knowledge grants; installation authentication supplies shared-token and open
access. Neither delivers the optional Better Auth account provider or scoped
runtime capabilities.

## Product execution priority

See the [architecture and effort assessment](architecture-effort-assessment.md)
for shared foundations, preliminary ranges, and assumptions. These estimates
are reference material and do not turn this roadmap into a fixed schedule.

The owner's subsequent discussion identified
[remote commit verification](remote-verification-plan.md) as an early concrete
experiment: push from an existing LLM workflow, request checks on an owned
worker, and receive revision-bound results without manual SSH or copying logs.
It follows urgent runtime/queue repairs and precedes autonomous fleet execution.
It does not wait for complete memory/forum functionality or commercial hosting.
The sequence below describes the knowledge module, not prerequisites for that
remote experiment.

## Delivery sequence

### 1. Define and prove the local write/read loop

Specify minimal thread, reply, task, link, author, and revision contracts.
Implement service-owned persistence, basic web reads/writes, and thin MCP
operations. Provide a CLI path through the same services for clients without
MCP. Include a compact search/list interface and explicit detail reads.

Acceptance: a human and two independent agent sessions can create, retrieve,
and reply to one project thread, then create a linked task. Retries do not
duplicate records, conflicting edits are detected, and server claims/runtime
state are unchanged. Records survive a controller restart.

### 2. Make the information useful across sessions

Add durable memory entries with source links and supersession, task context
retrieval, and Markdown/JSON export. Define an explicit human decision path
rather than promoting agent prose into instructions automatically.

Acceptance: another session can reconstruct the agreed scope, unresolved
questions, and evidence from the saved material. It can identify superseded
information and stale exports. Measure repeated explanations, repeated
investigations, retrieval effort, and owner corrections; do not infer token
savings from record counts.

### 3. Import existing Hub data and switch deliberately

Import existing canonical backlog items, done entries, notes, and attachments
with identifiers, dates, authorship labels, relationships, and source
provenance preserved. Mark legacy author labels as imported assertions rather
than authenticated identities. Report unsupported fields and unresolved links
instead of silently losing them. Keep imported attachments separate from
prunable runtime logs.

Use fixture repositories to verify repeatable import and data export/restore.
Agree one cutover per project; keep the existing Hub workflow until that
project is migrated. Avoid two active write locations and automatic two-way
file synchronization. Rollback retains an export and the original repository
data. Update repository operating instructions as part of the actual cutover,
not merely because this plan exists.

### 4. Add playbooks and monitor their health

Represent a playbook as durable procedural knowledge with a purpose,
preconditions, steps, expected outcomes, source links, and a last verification
record. Preserve failed-use reports and supersession. A playbook may remain
repository-owned or be service-owned and exported; show one explicit source
of truth for each document, without two-way synchronization.

Start with report-only checks for broken links, missing referenced files or
scripts, overdue review, and explicit reports that a procedure no longer
works. Changes to linked source code request a review rather than proving a
procedure invalid. Connect verification to an exact playbook revision, commit,
and relevant test run where available; a passing test proves only its stated
scope, not the entire playbook. Monitoring does not automatically execute
commands from documents. Repository inspection remains local; hosted knowledge
can receive explicit bounded reports without gaining filesystem access.

Acceptance: fixtures cover stale review dates without any content changes,
missing targets, corrected findings, failed-use reports, and superseded
procedures. Show when a check ran and when its source snapshot was captured,
including unavailable or stale inspection evidence. Retain links to relevant
discussion and backlog tasks instead of duplicating findings.

### 5. Inspect repository instruction sources

Adapt the existing Hub instruction explorer for a selected worktree and
directory: applicable sources, discovery order, provenance, and differences
between source snapshots. Identify commit and dirty-file state so the report
does not confuse committed content with local edits. Keep deterministic
discovery findings separate from any optional LLM assessment of ambiguity or
conflicting prose. Do not claim to reconstruct the agent's complete prompt.

Define versioned discovery profiles using current official documentation at
implementation time. Preserve bounded reads, path containment, symlink safety,
escaped previews, and visible omissions. Repository-owned AGENTS.md files stay
authoritative in the repository; inspection may produce a proposed patch.

Acceptance: fixtures cover nested scope, sibling isolation, source precedence,
dirty worktrees, stale snapshots, limits, unsafe paths, and escaped content.
Read-only inspection neither changes instructions nor claims/starts a server.
Remote hosting receives only explicitly selected source content or reports;
it does not gain implicit access to local repository instructions.

### 6. Assemble instructions from approved knowledge

Support an explicit path from discussion to an approved rule, project/directory
scope, generated AGENTS.md preview, diff, and deliberate application. Only
selected approved rules enter generation; forum messages and agent findings
do not become instructions automatically. Define verifiable approval identity
and revision semantics before implementing this path.

Each target declares its ownership mode. For repository-owned files, the
service proposes changes and the repository stays authoritative. For generated
files, approved service records are authoritative and exports identify source
versions. Detect manual drift and stale bases before application; never
silently overwrite them or merge both ownership models. Assembly starts with
faithful rule composition, not unreviewed LLM rewriting. Operating rules added
to this repository continue to follow its AGENTS.md/CLAUDE.md convention.

Acceptance: unapproved and out-of-scope records are excluded, superseded rules
are handled explicitly, output is reproducible for fixed inputs, source
provenance survives export, and conflicting/manual edits block blind writes.
Actual application is a separate authorized local action, not a hosted process
operation. Exporting or applying instructions does not itself trigger execution.

### 7. Trial reusable installation and optional hosting

First demonstrate useful daily operation for the owner. Then let a small
external group install the open-source module or connect to a hosted trial.
Track setup friction, continued use, willingness to pay, and support burden.
External adoption is an experiment, not a gate for owner-focused improvements.

## Agent coordination extension

The owner also requested a later coordination stage for multiple agents:
durable identities, task assignments, addressed messages, handoffs, incremental
context, and owner visibility. The scope and acceptance workflow are in the
[Agent fleet coordination plan](agent-fleet-coordination-plan.md), tracked by
[FEAT-20260905-agent-fleet-coordination](backlog/feature/FEAT-20260905-agent-fleet-coordination.json).
It follows the core memory/discussion services and is independent of optional
hosting and instruction generation. Autonomous launching and scheduling remain
deferred until cooperative execution is proven. This broadens the product
toward an operations hub; no renaming is decided.

## Optional paid hosting

The discussed business model is free self-hosted open source plus a modest fee
for managed hosting. The owner's phrase "for a dollar" meant a small fee, not
a literal price. No price, plan limits, revenue forecast, or launch date was
agreed. The ambition ranges from covering coffee to a useful side income;
profitability remains unproven.

Host knowledge, discussions, and backlog. Development processes, worktrees,
and verification remain on customer-owned Worktree Control workers: laptops, servers,
or customer cloud VMs. The [remote verification plan](remote-verification-plan.md)
defines outbound worker connections and the execution boundary. Local and remote agents
can access the same chosen knowledge service; the host does not need shell
access to customer computers. Users pay for availability, setup convenience,
updates, and backups, while retaining export and self-hosting options.

Before public hosting, design authenticated remote access, tenant isolation,
membership/permissions, revocable agent credentials, quotas, deletion/export,
and tested backup restoration. The current local pairing and loopback MCP
model is not a multi-tenant security boundary. SQLite is the local starting
point; hosted persistence topology must be selected and verified against the
actual deployment and workload rather than assumed to scale unchanged.

## Deferred work and open questions

- Exact user/agent identity and approval model for the first local version.
- Shared versus separate database file, attachment storage, and backup policy.
- Minimal relation model and API/MCP vocabulary; precise task promotion UX.
- Knowledge-project identity independent of runtime registration, including
  future projects without a local checkout and cross-project retrieval scope.
- Hosted deployment topology, pricing, and packaging; whether the broader
  product eventually needs a name beyond Worktree Control.

Do not expand the first slice into autonomous agent scheduling, a new chat
client, vector search, paid model inference, bidirectional file sync, or
automatic GitHub issue processing. Existing conversations with agents remain
valid entry points; saving their useful outcomes is the core workflow.
