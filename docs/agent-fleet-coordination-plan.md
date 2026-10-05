---
audience: "owner, contributors, and coding agents"
last_reviewed: "2026-10-05"
source_of_truth: "planned agent coordination scope from the owner discussion on 2026-09-05"
status: "active"
---

# Agent fleet coordination

## Direction and dependencies

Extend the [shared project memory plan](shared-project-memory-plan.md) with
coordination for multiple cooperating agents. The owner asked to preserve
these ideas after discussing shared memory, forum, backlog, playbooks, and
repository instructions, and noted that the product is becoming an operations
hub. This describes a planned direction, not implemented fleet capabilities
or a decision to rename the project.

The subsequent owner discussion prioritizes
[remote checks of pushed commits](remote-verification-plan.md) as an earlier
experiment using existing LLM clients and customer-owned workers. It does not
wait for autonomous launching or the complete fleet module. Reuse its run
evidence in future coordination flows.

Track this stage in
[FEAT-20260905-agent-fleet-coordination](backlog/feature/FEAT-20260905-agent-fleet-coordination.json).
It follows the basic memory, discussion, task, and identity services; it does
not require completing optional instruction generation or commercial hosting.
Existing urgent runtime fixes retain priority. The first goal is cooperation
between a few owner-directed agents, not an autonomous manager spawning a fleet.

## Reference workflow

The owner sets a goal. Agent A implements a bounded task on an identified
worktree. Agent B independently reviews the resulting revision. Agent C
investigates a related issue. Each agent can see the others' declared scope,
ask an addressed question, receive changed assumptions, and leave a result
that survives interruption. The owner can see blockers and pending decisions.

The system records coordination and evidence. It does not assume that a task
status proves process activity, that message storage proves receipt, or that
a passing check proves the whole goal was achieved.

## 1. Durable identities and session presence

Represent a durable agent identity separately from an individual execution
session. Model/provider names are metadata, not identities or authority.
Associate writes with an authenticated principal and permitted project scope;
keep safe display labels distinct from credentials and private session tokens.
Represent humans explicitly and preserve the approval boundary established by
the memory module. Existing local pairing and MCP session ownership alone do
not provide this model.

Track session start, last contact, reported task, and supported capabilities.
Use observable presence states, including unknown or disconnected. A silent
client may still be running; the UI must not describe it as stopped. New
sessions can recover durable context without silently inheriting old session
leases or privileges. Revocation prevents subsequent authorized operations.

## 2. Task assignments separate from runtime claims

A task assignment records the task revision, responsible agent/session,
declared scope, worktree and base revision when applicable, and expected next
deliverable. Implement atomic acquisition and revision-checked transitions so
two cooperating agents cannot both acquire exclusive responsibility through
a race. Allow an explicitly described collaboration/review role where useful.
Exact states and lease policy remain to be specified.

Task assignments do not start servers or acquire existing runtime claims.
Several agents may work on a project while one separately claims its server.
Compare declared task/path scope and warn about possible overlapping edits;
these declarations are advisory and cannot prevent independent shell writes.

Use bounded presence/assignment leases to expose abandoned work. Expiry means
the previous executor's state is unknown, not that its files can be overwritten.
Reassignment requires inspection of preserved work and a new assignment version.
Reject stale assignment mutations at the service boundary; do not imply this
fences filesystem access by an independently running agent.

## 3. Addressed messages and acknowledgements

Build messages on durable discussions, with an intended recipient, task or
thread reference, and optional relationship to a previous question. Support
requests for input, changed assumptions, review requests, and stop requests.

Distinguish stored, delivered, acknowledged, and resolved states. A connector
can establish delivery, but only an explicit recipient response establishes
acknowledgement. Neither acknowledgement nor resolution automatically grants
approval or changes runtime state. Persist pending messages across reconnects;
retry identifiers prevent duplicate writes and repeated side effects.

MCP provides access to these records; it is not itself a session launcher or
a guarantee that an idle model will read a message. Waking a session or pushing
input into an active client requires a separately supported runner/client
adapter. Show unavailable delivery capabilities instead of claiming success.

## 4. Handoffs and revision-bound evidence

### Task, forum thread, and recipient inbox

The owner selected a concrete handover mechanism: address a task to an agent
and attach the conversation through its forum thread. The task expresses work
and responsibility, the thread preserves discussion, and the inbox identifies
who needs to respond. Inbox entries reference the same handoff/message instead
of copying its content into a separate source of truth.

Illustrative MCP operations, not implemented or finalized API names:

```text
handoff_task(
  task_id: "TASK-123",
  recipient: "frontend-agent",
  message: "API ready. Implement the test-history screen.",
  source_commit: "abc123",
  references: ["api-contract-v2", "test-run-456"],
  expected_task_revision: 7,
  idempotency_key: "handoff-request-001"
)

get_inbox()
read_task("TASK-123")
accept_handoff("HANDOFF-789")
```

The service authorizes sender, target, and linked project resources, then in
one database transaction records the handoff and source versions, adds the
thread message, creates its inbox reference, and marks the offer pending.
External notification is dispatched only after commit using a recoverable
event/outbox mechanism; transport retries cannot create duplicate handoffs.
Acceptance checks current authorization, task revision, and assignment state
atomically. Reading a message or acknowledging delivery is not acceptance of
responsibility. Never leave a half-created thread/inbox/assignment update.

A pending handoff is an offer, not proof that the recipient is executing.
Define sender ownership while pending explicitly in the implementation
contract; do not silently transfer it when the message is stored. The recipient
can accept, decline, or ask for missing information in the same thread. A
question does not accept the assignment. Superseded, cancelled, or stale offers
cannot be accepted without revalidation.

Support two distinct destinations: a named durable agent, or a role queue such
as frontend specialist. A role queue exposes eligible offers to authorized
agents, with atomic acceptance by one recipient for exclusive work. Membership
in a role never grants additional project access. Named-agent delivery stays
available across session restarts without transferring another session's lease.

The first version uses pull delivery. An agent can check its inbox when a
session starts and before selecting its next task; the project's eventual
operating instructions will describe that workflow. A human can start a client
and ask it to retrieve pending work. Pending entries survive while the client
is offline. MCP storage does not wake a model. Automatic session launch or
message injection remains a separate client/runner integration.

The web action "Hand off task" selects a recipient and message and invokes
the same service as MCP/CLI. It does not have separate assignment semantics.

### Specialist context and integration

For the Python/backend to frontend example, attach the agreed API contract,
sample responses, error/empty/loading behavior, relevant design decisions,
source revision, run evidence, known gaps, and acceptance criteria. Return a
short context with source links; full discussion is available on demand rather
than injected into every session. Frontend needs can inform the contract before
backend implementation; no fixed backend-first sequence is required.

Start with owner-selected specialist profiles: model configuration,
instructions, tools, and environment capabilities. Keep profiles separate from
durable executor identity. Automatic model ranking/routing is deferred and must
not use self-reported completion as evidence of skill.

Track contract changes and the combined integration revision. Two independently
passing components do not prove their integration works; name the integration
owner and verify the combined result, ideally through the remote runner. Limit
repeated unsuccessful handoffs and surface an owner decision instead of an
endless exchange. Detect dependency cycles as blocked work rather than letting
every agent appear to be progressing.

### Evidence payload

A completion or interruption handoff records:

- What changed, its branch/worktree, and commit or immutable artifact identity.
- What was verified, the exact source state, result, and evidence links.
- What was not verified and which uncertainties remain.
- Preserved partial work, remaining steps, and the next useful action.

Link existing Worktree Control test records instead of copying their output as agent
assertions. Preserve dirty-state limitations. Link reviews to the exact patch
or revision examined; later edits expose that the review covers an older
version. Different models agreeing is not independent execution evidence.
Bound output and retain enough durable metadata if operational logs expire.

## 5. Incremental context and subscriptions

Provide bounded changes-since reads and project/task/thread subscriptions so
an agent can ask what changed since its last observed revision. Return compact
events with source links and fetch details explicitly. Scope subscriptions by
authorization; avoid broadcasting every discussion to every agent.

Define cursor ordering, pagination, retention, reconnect, and expired-cursor
behavior. If a cursor is too old, require a visible resync rather than silently
omitting changes. Consumers tolerate duplicate delivery. Notifications of
changed rules link to the approved source rather than generating new authority.

Prefer faithful change summaries first. Any later LLM summary is labeled and
linked to source records. Measure response bytes, retrieval calls, and useful
context rather than claiming token savings from message counts.

## 6. Owner visibility and execution boundaries

Show active assignments, declared scope, last contact, blockers, requests for
decisions, and results awaiting review. Distinguish progress reported by an
agent from state observed by a runner. Keep a record of requested cancellation,
acknowledgement, and verified process exit as separate events.

Only a runner that owns an agent process can promise to terminate it. For an
external session the system can request a stop and report acknowledgement;
it cannot guarantee termination. Existing control over development servers
does not imply control over agent sessions. Do not kill a dev server to imply
that its agent stopped.

Concurrency and spend limits are a later execution-adapter concern. Show
configured limits and measured usage where an adapter supplies them; without
provider/client usage data, cost is unknown. Do not offer a hard spend cap
without a mechanism that can enforce it. Hosted coordination does not gain
implicit command execution or shell access to customer machines.

## Delivery slices and verification

1. Add durable identity/session presence and task assignment services on top
   of the memory module. Prove simultaneous acquisition, expiry, reconnect,
   revocation, and stale updates using deterministic fixtures.
2. Add addressed messages and bounded changes-since reads. Test disconnects,
   duplicate delivery, explicit acknowledgements, expired cursors, and access
   boundaries. Do not require an automated launcher for this slice.
3. Add handoffs, revision-bound reviews, and the owner coordination view.
   Prove task/thread/inbox atomicity, idempotent retries, explicit acceptance,
   decline/questions, stale offers, and two eligible role recipients racing
   to accept. Exercise offline inbox recovery without a launcher and the same
   semantics through UI and MCP. Include a specialist handover with a changed
   API contract and separately verified combined integration revision.
   Complete the A/B/C workflow with actual independent agent sessions and record
   what integrations were available. Test interruption with partial work and
   make stale reviews and unknown presence visible.
4. Only after that workflow is useful, specify optional runner adapters for
   starting/waking sessions, cancellation, concurrency limits, and measured
   cost reporting. Automated delegation and scheduling require a separate
   bounded design and explicit owner adoption.

Mocks can verify protocol behavior, but do not count as proof that real agent
clients receive messages or resume correctly. Verification must state whether
it used fixtures or actual client integrations. Coordination operations alone
must not change runtime reservations, execute repository scripts, or start
managed servers.

## Open decisions

- Identity provisioning and its relationship to local accounts/scoped tokens.
- Assignment states, collaboration roles, expiry policy, and safe reassignment.
- Which existing agent clients can poll, receive input, or be launched by an
  adapter, and which delivery guarantees each actually provides.
- Event retention, cursor contracts, and evidence retention after log pruning.
- Which fleet functions belong in a later hosted offering and what access they
  require; no commercial pricing or fleet scale promise is agreed.

This work broadens Worktree Control toward an operations hub with runtime, knowledge,
and coordination modules. Keep those responsibilities separate in code while
sharing stable project identity and service contracts. A possible future name
change does not block the owner's first useful coordination workflow.
