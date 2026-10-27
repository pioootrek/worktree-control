---
audience: "owner, contributors and coding agents designing Knowledge task reading"
last_reviewed: "2026-10-27"
source_of_truth: "proposed stage 1 design for a task's current state shown before its history; Knowledge task 6cc7e676-d699-482b-b907-5832249eda70"
status: "active"
---

# Task current state before history — stage 1 design

**Status: the owner answered its four open decisions on 2026-10-27, and the
[smallest implementation slice](#smallest-implementation-slice) is implemented
on branch `feat/knowledge-task-current-state`.** The
[verified facts](#verified-facts-about-the-current-system) describe commit
`b5da139`, before that slice. [Implementation notes](#implementation-notes)
record where the code differs from this design.

The Knowledge task is `6cc7e676-d699-482b-b907-5832249eda70`. Stages 2 (one
view of a case across task, memory and discussion) and 3 (simplified evidence
upload result) are out of scope here, apart from the boundaries stage 1 must
leave for them.

The prototype is in
[design-reference/experiments/2026-10-27-knowledge-current-state](../design-reference/experiments/2026-10-27-knowledge-current-state/README.md).

## Goal

Within a few seconds of opening a task, a reader can name:

1. the **result** that is true now;
2. any **open blocker**, and who or what unblocks it;
3. the **next step**, and who takes it;
4. whether an **owner decision** is needed, and whether one was actually given;
5. which **evidence** exists, and how far it was checked.

They should not need to read the chronology. The full history and every
source must stay one action away. Merge, CI, review, evidence storage and
verification, and deployment stay separate facts. A summary that may be stale,
contradictory or incomplete must say so.

The summary is written by people and agents through an explicit operation and
assessed by deterministic rules. No LLM generates or judges it. An agent's
statement never becomes owner consent.

## Verified facts about the current system

These facts were checked against code at `b5da139` and Knowledge records on
2026-10-27.

| Area | Fact | Where |
| --- | --- | --- |
| Task shape | A task has `title`, free-text `description` (≤ 65536 characters), `status` (`open`, `in_progress`, `blocked`, `done`, `archived`), `priority` and `revision`. There are no structured result, blocker, next-step or delivery fields. | `src/shared/contracts/knowledge.ts` |
| Task updates | `update_task` replaces title, description, status and priority together under `expectedRevision`. The SQL `UPDATE` sets only those columns plus revision and time. | `knowledge-queries.ts` `updateTask` |
| Task history | Every task update stores the previous task as `previousJson`. It is the mapped `KnowledgeTask` field list from `getTask`, not the raw row, so a new column is not captured unless the snapshot adds it. Entries carry with `principalId` and `authenticationMethod`. Readable before/after comparison exists only for Memory. | `knowledge-queries.ts` `history`; `KnowledgeHistoryEntry` |
| Task reader | The reader shows status, title, attribution, the full description, edit action, an on-demand **Task context**, attachments, relations and metadata. Nothing summarises current state above the description. | `src/features/knowledge/knowledge-dashboard.tsx` |
| Task context | `task_context` groups memories that cite the task: approved decisions (approval revision equals current revision), proposals and open questions. Source states report `stale` (revision changed) and `inactive` (archived or superseded). Derived threads are listed as evidence. | `knowledge-memory-service.ts` `taskContext` |
| Memory sources | Memory sources may cite Knowledge records at an exact revision, external `http(s)` URLs or repository commits. Writes reject a Knowledge source whose current revision differs. | `knowledge-memory-schemas.ts`; `validateSources` |
| Approval | `approve_memory` needs `knowledge:approve`. A grant holder needs an owner session, and agents cannot receive the permission. The **installation principal bypasses grants**, so an installation token can approve. | `identity-service.ts` `authorizeKnowledge`, `grantKnowledge` |
| Identity on this host | In `token` mode, "the installation token acts as the owner" for Knowledge. This session's MCP identity is `installation` with `installationAuthority: true`, and recent task revisions are recorded as `createdBy: "installation"`. History can therefore separate `owner_session` from `installation_token`, but it cannot tell the owner from an agent when both use the installation token. | `docs/authentication.md`; `get_identity` |
| Attachments | Attachments are immutable. Their server-computed `sha256`, size, creator and time are stored per record. Preflight is not persisted and does not prove upload or command execution. | `knowledge-attachments.ts`; `docs/knowledge-evidence.md` |
| Relations | Types are `derived_from`, `blocks`, `relates_to` and `supersedes`. SQLite permits task, thread and reply endpoints. | `knowledge.ts` |
| Transports | Adding an operation to `knowledgeSchemas` exposes it through HTTP, the generic `knowledge` CLI and the MCP tool `knowledge_<operation>`. | `knowledge-tools.ts`; `knowledge-management.ts` |
| Visual direction | The owner-approved reference is charcoal with restrained lime: lime marks selection and the primary action, and amber, red and green stay semantic. WinPath's appearance must not be copied. | Memory `77da185b803443f60cb1f8d3af6a8677`; `design-reference/` |

### The problem in a real record

This task's own description shows the problem. As of revision 6 it contains
the original request, a 2026-10-05 ordering, a 2026-10-15 scope split, a
2026-10-27 assignment, a launcher confirmation and an executor confirmation.
Each was appended to the description. A reader must scan all of them to learn
that the design is in progress and implementation has not started. The T02e
case in `win-path-6` is the owner's original example. This design does not
re-verify T02e facts.

## Proposed model

### One current-state record per task

Store the summary as a structured, versioned **current state** attached to the
task. It is not derived from free text and is not a new kind of record. It
lives beside the description and changes only through a dedicated operation.
That operation advances the task revision. Its history entry adds the previous
state to the `previousJson` snapshot, because the mapped task fields alone would
not contain it. Ordinary `update_task` does not change the state, so every
previous state stays in the entry of the state write that replaced it.

```ts
// Proposed: src/shared/contracts/knowledge-task-state.ts
type Unknown = { known: false; reason?: string }; // ≤ 200 characters

interface TaskCurrentState {
  formatVersion: 1;
  taskRevision: number;          // task revision this write produced
  statusAtWrite: KnowledgeTaskStatus;
  writtenAt: string;             // server time
  declaredBy: string | null;     // free label, e.g. "codex · T3 thread …"; not authentication
  changeNote: string;            // ≤ 280 characters: what changed in this write

  outcome: { known: true; text: string; sources: StateSource[] } | Unknown;   // ≤ 280 characters
  blockers: Blocker[];                                                       // ≤ 10, open and resolved
  nextStep: { known: true; none: true } | { known: true; none?: false; action: string; actor: StateActor; sources: StateSource[] } | Unknown;
  ownerDecision: OwnerDecision;
  delivery: {
    merge: DeliveryFact<"not_started" | "pr_open" | "merged" | "closed_unmerged">;
    ci: DeliveryFact<"not_run" | "running" | "passed" | "failed">;
    review: DeliveryFact<"not_requested" | "in_progress" | "findings_open" | "findings_closed">;
    evidence: DeliveryFact<"none" | "stored" | "verified">;
    deploy: DeliveryFact<"not_planned" | "pending" | "done" | "failed">;
  };
}

type StateActor = "owner" | "agent" | "operator" | "external";

interface Blocker {
  key: string;                   // stable within the task, e.g. "ci-runner"
  text: string;                  // ≤ 200 characters
  unblockedBy: StateActor;
  condition: string;             // ≤ 200 characters: what ends the blocker
  since: string;                 // date or ISO time
  state: "open" | "resolved";
  resolvedAt?: string;
  resolution?: string;           // ≤ 200 characters
  sources: StateSource[];
}

type OwnerDecision =
  | { state: "not_needed" }
  | { state: "needed"; question: string; options?: string[]; proposalRef?: MemoryRef }
  | { state: "recorded"; decisionRef: MemoryRef }   // consent itself is derived, never written
  | { state: "unknown"; reason?: string };

type DeliveryFact<S extends string> =
  | { state: S; applies: true; commit?: string; ref?: string; detail?: string; observedAt: string; sources: StateSource[]; openFindings?: number; attachments?: string[] }
  | { applies: false }            // not applicable to this task
  | { known: false; reason?: string };

type StateSource =
  | { kind: "thread" | "reply" | "task" | "memory"; id: string; revision: number }
  | { kind: "attachment"; id: string }
  | { kind: "external"; label: string; url: string }      // http(s) only, e.g. a PR or CI run
  | { kind: "repository"; sourceId: string; repository: string; commit: string; path: string };

type MemoryRef = { id: string; revision: number };
```

Rules:

- **Three explicit states for every field:** known, explicitly none (`none`,
  `not_needed`, `applies: false`) and unknown. A missing field is unknown and is
  never rendered as "none" or green.
- **Merge, CI, review, evidence and deployment** are independent facts. Each
  has its own commit, reference and observation time. CI records the commit it
  tested; merge records the merged head in `commit` and may name the resulting
  main commit in `detail`; deployment records the deployed commit and target.
- **Evidence has two levels.** `stored` means the listed attachment IDs exist on
  this task. The server can check that at write and read time. `verified` means
  the writer asserts that the contents were checked against the claim. It is
  shown with the writer's attribution, never as a system fact. Upload integrity,
  partial uploads and retries belong to stage 3.
- **Owner consent cannot be written.** `recorded` only points to a decision
  memory. Whether that amounts to owner consent is derived from the memory's
  approval and the authentication method in its approval history (see
  [owner consent](#owner-consent-tiers)).
- **Resolved blockers stay** in the state with `resolvedAt` and `resolution`
  until a writer removes them. Removal is visible in history because the
  previous state is kept.
- **Bounds:** the serialized state is limited to 16 KiB, with at most 10
  blockers and 20 sources per fact. Text is plain and rendered as text.

### Assessment computed on read

A pure, tested function shared by the server read operation produces the
signals the view shows. It has no clock-based guesses and no language model.

```ts
interface TaskStateAssessment {
  freshness: "missing" | "current" | "changed_since";
  changesSince: {
    taskRevisions: number;            // task.revision - state.taskRevision
    statusChanged: boolean;           // task.status !== state.statusAtWrite
    descriptionChanged: boolean;      // from the newer history entries
    memoriesChanged: number;          // memories citing the task, updated after writtenAt (bounded count)
    attachmentsAdded: number;         // task attachments created after writtenAt (bounded count)
    repliesAdded: number;             // replies in derived threads after writtenAt (bounded count)
    staleSources: number;             // cited Knowledge sources whose revision changed
    inactiveSources: number;          // cited sources now archived or superseded
  };
  findings: Array<{ code: FindingCode; severity: "conflict" | "attention"; fields: string[]; sources: StateSource[] }>;
  ownerConsent: "not_needed" | "needed" | "unknown" | "proposal_only" | "approved" | "approved_method_not_accepted" | "approval_invalidated";
  approvalMethod: AuthenticationMethod | null; // from the approval history entry; always shown with "approved"
  evidence: { listed: number; present: number; missing: string[] };
}
```

`freshness` is `current` only when every `changesSince` count is zero and no
cited source is stale or inactive. The number shown to the reader is the sum of
`taskRevisions`, `memoriesChanged`, `attachmentsAdded`, `repliesAdded`,
`staleSources` and `inactiveSources`; `statusChanged` and `descriptionChanged`
explain the task revisions rather than adding to them. A summary does not go stale through elapsed
time alone. Its age is shown, and the Knowledge hygiene task
(`18bb4fee-d887-481c-859d-702070a4b97f`) decides when a review is due.

Deterministic findings:

| Code | Severity | Rule |
| --- | --- | --- |
| `done_with_open_blocker` | conflict | Task status is `done` and a blocker is `open`. |
| `blocked_without_blocker` | conflict | Task status is `blocked` and no blocker is `open`. |
| `open_blocker_not_blocked` | attention | A blocker is `open` and task status is neither `blocked` nor `done` (`done` is already a conflict). A blocker may cover only one step, so this is not a conflict. |
| `deploy_without_merge` | conflict | Deployment is `done` while merge applies and is not `merged`. |
| `ci_not_merged_head` | attention | CI and merge commits are both known and differ. |
| `deploy_not_merged_head` | attention | Deployment and merge commits are both known and deployment matches neither the merged head nor the main commit in `detail`. |
| `evidence_missing` | conflict | A listed attachment no longer exists or belongs to another record. |
| `claim_without_source` | attention | A positive fact (`merged`, `passed`, `findings_closed`, `stored`, `verified`, `done`) or the outcome has no source. For evidence, listed attachments count as sources. |
| `source_stale` / `source_inactive` | attention | A cited Knowledge source changed revision, or was archived or superseded. |
| `consent_missing` | attention | `ownerDecision.recorded` points to a memory that is unapproved or whose approval no longer applies to its current revision. |
| `consent_method_not_accepted` | attention | The decision memory is approved, but the approval's authentication method is not in the accepted set (see [owner consent](#owner-consent-tiers)). Under the current policy this cannot occur. |
| `next_step_on_done` | attention | Task status is `done` and a next step is set. |

Write-time validation rejects only structural errors: bounds, malformed
commits or URLs, missing or revision-mismatched Knowledge sources (the same
rule as Memory), attachments not on this task, `openFindings > 0` with
`findings_closed`, and a decision reference that is not a `decision` memory.
Contradictions between facts are accepted and shown. Rejecting them would hide
real disagreement between sources.

### Owner consent tiers

Owner consent is a derived value. It requires an approved decision memory, and
the approval's authentication method must be in one accepted set. That set is
a single constant in the shared assessment module, not a stored setting:

```ts
// Owner decision 2026-10-27: owner and agents currently share the installation
// token, so it counts as the owner. Remove "installation_token" once agents
// receive their own credentials.
export const OWNER_CONSENT_METHODS: ReadonlySet<AuthenticationMethod> =
  new Set(["owner_session", "installation_token"]);
```

| Tier | Condition | Shown as |
| --- | --- | --- |
| Needed | `ownerDecision.state = needed` | **Decision needed** with the question and options |
| Proposal only | Decision memory exists but is not approved at its current revision | **Agent proposal — owner has not approved** |
| Approved | Approved at the current revision with a method in `OWNER_CONSENT_METHODS` | **Owner decision · approved with {method}**, with date and a link to the memory |
| Method not accepted | Approved at the current revision with a method outside the set | **Approved with {method}, which does not confirm the owner** |
| Invalidated | The memory changed after approval (`approve_memory` approvals are cleared on update) | **Approval no longer applies** |

The approval method is always displayed next to an approved decision. Readers
can therefore see today that an approval came from the shared installation
token, and nothing changes in stored data when the set changes.

Separating permissions later takes three steps, none of which migrate data:
issue agents their own credentials without `knowledge:approve`, remove
`installation_token` from the set, and decide whether approvals recorded
before that date keep the **Approved** tier. History records each approval's
method and time, so either choice is possible. If needed, a dated policy
(`acceptedUntil`) can replace the constant at that point.

An agent's report that "the owner agreed in chat" belongs in `changeNote` or a
proposal memory. It is shown as the agent's report and never upgrades a tier.
While the token is shared, the system cannot stop an agent from approving.
The implementation slice therefore adds a process rule to agent guidance: an
agent calls `approve_memory` only on the owner's explicit instruction in the
current conversation, and quotes that instruction in the change note.

### Who updates the state

- **Agents** update the state in the same session as any change to outcome,
  blockers, next step, decision need or delivery: before handoff and after merge,
  CI, review or deployment results. They use `expectedRevision`; a conflict
  means re-reading the task first. Long narrative goes into a discussion reply
  or an evidence attachment, not the description.
- **The owner** can update any field and is the only party who can create an
  owner-session decision.
- **Knowledge hygiene reviews** (task `18bb4fee`) list tasks whose assessment
  is `changed_since` or has conflicts, and ask the responsible party to update
  them. Reviews do not rewrite state automatically.
- **Nobody backfills automatically.** Existing tasks show "No current state
  recorded" until someone writes one.

#### Short update format for agents

The structured operation is the update format; it replaces appended paragraphs.
For a human-readable trail, `changeNote` follows one line:

```text
<what changed>; blocker: <none|key opened|key resolved>; next: <actor> — <action>; decision: <none|needed|recorded>
```

Example: `CI passed on a31f92c; blocker: none; next: owner — merge PR #112; decision: needed`.

## View design

The approved charcoal and lime vocabulary is reused: a bordered summary panel
with a small uppercase label (like "URUCHOMIONY SERWER"), state words with
icons, monospaced commits and lime only for selection and the primary action.
Amber marks attention and blockers, red marks conflicts and failures, and green
marks a sourced positive fact. Nothing is copied from WinPath.

### Desktop reader (1440 and 1366, list beside reader)

The reader order becomes:

1. Status and priority badges, then the title.
2. **Current state** panel:
   - Header row: label **Current state**, freshness chip
     (**Current** / **Changes since this summary: N** / **No current state recorded**)
     and `r7 · 27 Oct 10:20 · installation token · declared: codex`.
   - **Result** in one readable sentence (18 px), with a source link.
   - A four-cell grid with **Blocker**, **Next step**, **Owner decision** and
     **Evidence**. An open blocker uses an amber border and icon; a needed
     decision uses a question icon. Unknown cells keep their place and read
     **Unknown**.
   - **Delivery**: a five-row definition list (merge, CI, review, evidence,
     deployment). Each row has an icon and word, version (commit or PR), checked
     time and source link. **Not applicable** and **Unknown** stay visible.
   - **Needs attention (N)**: conflicts first, then attention findings. Each
     names both sides and links its sources.
   - Actions: **Sources (N)** disclosure, **Go to history** link and, for
     writers, **Update state**.
3. **Description and history**: the existing description, then
   **Resolved blockers** and **Superseded findings** (memories that cite the
   task with status `superseded`, linking to their replacement), then the
   existing Task context, attachments and relations.

When `freshness` is `changed_since`, a banner above the result reads "Later
changes not reflected in this summary: N" and links each change. The summary stays fully
readable, with no blur or strike-through.

### Mobile (390 and 320)

The reader replaces the list, as today. The panel stacks Result, Blocker,
Next step, Owner decision and Evidence, each a full-width row with its label
above the value. Delivery becomes a five-row list with the state word next to
the stage name. Commits and references wrap below. Source links keep 44 px
targets. **Sources** and **Needs attention** are disclosures. Nothing scrolls
horizontally, and the freshness chip wraps under the label.

### Keyboard, focus and screen readers

- The panel is a `section` labelled by its heading. Each fact is a `dt`/`dd`
  pair, so screen readers announce "Blocker: …".
- Tab order follows reading order: freshness details, result source, each
  cell's source, delivery sources, **Needs attention**, **Sources**,
  **Go to history**, **Update state**. No single-key shortcuts are added.
- Each source link is a native link to the existing record route
  (`knowledgeSourceHref`). Opening one records a return target. **Back to task
  state** on the destination returns to the task and focuses the originating
  link. This reuses the existing return-to-results pattern. External sources
  open as ordinary links with an external icon and `rel="noreferrer"`; they
  are never fetched.
- **Go to history** moves focus to the **Description and history** heading.
- State is never conveyed by colour alone: every state has a word and an icon.

### Copy (PL / EN)

| Key | PL | EN |
| --- | --- | --- |
| panel | Aktualny stan | Current state |
| result | Rezultat | Result |
| blocker | Blokada | Blocker |
| noBlocker | Brak otwartych blokad | No open blockers |
| nextStep | Następny krok | Next step |
| ownerDecision | Decyzja właściciela | Owner decision |
| decisionNeeded | Potrzebna decyzja | Decision needed |
| proposalOnly | Propozycja agenta — brak zgody właściciela | Agent proposal — owner has not approved |
| ownerApproved | Decyzja właściciela · zatwierdzono: {method} | Owner decision · approved with: {method} |
| methodNotAccepted | Zatwierdzono metodą, która nie potwierdza właściciela: {method} | Approved with a method that does not confirm the owner: {method} |
| method.installation_token / owner_session | token instalacji / sesja właściciela | installation token / owner session |
| evidence | Dowody | Evidence |
| evidenceStored | Zapisane, niezweryfikowane | Stored, not verified |
| evidenceVerified | Zweryfikowane (deklaruje: …) | Verified (declared by …) |
| delivery | Dostarczenie | Delivery |
| merge / ci / review / deploy | Scalenie / CI / Przegląd / Wdrożenie | Merge / CI / Review / Deployment |
| unknown | Nieznane | Unknown |
| notApplicable | Nie dotyczy | Not applicable |
| current | Aktualne | Current |
| changedSince | Zmiany od podsumowania: {n} | Changes since this summary: {n} |
| missing | Brak zapisanego stanu | No current state recorded |
| attention | Do sprawdzenia: {n} | Needs attention: {n} |
| conflict | Sprzeczność | Conflict |
| noSource | Deklaracja bez źródła | Claim without a source |
| sources | Źródła: {n} | Sources: {n} |
| history | Przejdź do historii | Go to history |
| back | Wróć do stanu zadania | Back to task state |
| resolvedBlockers | Rozwiązane blokady | Resolved blockers |
| superseded | Zastąpione ustalenia | Superseded findings |

Counts follow the existing "Label: {count}" pattern, such as
`knowledge.replyCount`, because the i18n module has no plural rules.

## Acceptance scenarios

Each scenario is a fixture in the prototype and must become a static-export UI
test in the implementation.

| # | Scenario | Expected first reading |
| --- | --- | --- |
| A | **Resolved blocker** — the CI runner blocker resolved on 26 Oct, CI then passed | Blocker cell: "No open blockers · 1 resolved" (link to history), not amber. The only amber is the review row with 2 open findings; no attention list. Freshness: current. |
| B | **New blocker after success** — merged, CI passed, then deployment failed a health check | Blocker cell amber: "Deployment health check fails · unblocked by operator". Delivery: merge ✓, CI ✓, deployment ✕ failed. Result still states what was merged. If task status is not `blocked`: attention `open_blocker_not_blocked`. |
| C | **Missing and contradictory data** — status `done`, one open blocker, CI on another commit, review unknown | No green summary. Needs attention lists: conflict `done_with_open_blocker`, attention `ci_not_merged_head` with both commits, and review "Unknown". |
| D | **Merge without deployment** — merged, CI passed, findings closed, evidence verified, deployment pending | Delivery reads "Merged · CI passed · findings closed · evidence verified · deployment pending (separate stage)". The task is not presented as finished. |
| E | **No owner consent** — the agent reports that the owner agreed in chat; the decision memory is not approved | Owner decision: "Agent proposal — owner has not approved" and attention `consent_missing`. The agent's report appears as an attributed note. After approval with the installation token: "Owner decision · approved with: installation token". With the future set (owner session only), the same record shows `consent_method_not_accepted`. |
| F | **Stale summary** — state at r7; task now r9 with a description edit and status change to `done`; two new replies; one cited memory superseded | Freshness chip amber "Changes since this summary: 5" and a banner listing them with links. Attention `next_step_on_done` and `source_inactive`. The result stays readable. |
| G | **No state yet** — every existing task until written | "No current state recorded". Shows only the system-derived facts (status, priority, last update, counts of decisions, proposals, open questions and attachments) and writer guidance. |

The few-second reading target is validated by giving the owner scenarios B, D
and E with only the panel visible. The owner names the result, blocker, next
step, decision and evidence, and the answers are recorded. Screenshots alone
are not acceptance.

## Smallest implementation slice

One PR after PR110 (supersession export) and the `legacyId` change merge,
because both touch the same Knowledge files.

1. **Migration**: an additive nullable column
   `knowledge_tasks.current_state_json TEXT`, with a `schema-inspection` count
   update. Existing rows stay `NULL`. The `update_task` SQL already leaves
   unlisted columns unchanged, but `insertTask` inserts positionally
   (`INSERT INTO knowledge_tasks VALUES (?, …)`, used by `create_task` and
   `task_from_thread`). It must name its columns in the same change, or every
   task creation fails once the column exists. The transfer importer's column
   list gains the column with `NULL` for older exports. Test task creation after
   the migration.
2. **Contract** `src/shared/contracts/knowledge-task-state.ts`: Zod schema and
   types above, browser-safe. `KnowledgeTask` gains an optional
   `currentState: TaskCurrentState | null` on the single-task read only. List
   summaries are unchanged.
3. **Operations** in `knowledgeSchemas`, which automatically reach HTTP, MCP and
   CLI:
   - `update_task_state { projectId, idempotencyKey, taskId, expectedRevision, state, status? }`
     with `knowledge:write`. It sets the state and, optionally, task status
     atomically, advances the revision and writes history `updated` with
     `previousJson` = previous task fields plus `currentState`. The server fills `taskRevision`, `statusAtWrite` and
     `writtenAt`.
   - `task_state { projectId, taskId }` with `knowledge:read`. It returns
     `{ task summary, state, assessment }` using bounded, indexed counts. It
     does not change `task_context` or exports.
4. **Assessment** `src/server/modules/knowledge/task-state-assessment.ts`: a
   pure function, with a store method that collects bounded fact counts. It
   opens no new connection.
5. **Transfer**: the project snapshot task schema accepts an optional
   `current_state_json`, defaulting to null, so existing exports still import.
6. **UI** `src/features/knowledge/task-current-state.tsx`: read-only panel
   above the description, refreshed by the existing Knowledge change signal
   with no new polling. Add PL/EN messages, source links with return focus and
   **Go to history**. Owner editing is a follow-up; writes in this slice come
   through MCP, HTTP or CLI.
7. **Agent guidance**: add the update rule, the `changeNote` format and the
   shared-token approval rule to `docs/knowledge/AGENTS.md` and the shared
   skill, only after the owner accepts this design.

Tests: unit tests for every finding code and consent tier, run with both the
current and the future `OWNER_CONSENT_METHODS`; SQLite tests for
migration, task creation after it, revision conflict, a history snapshot that
contains the previous state, idempotent replay and
transfer round trip; transport parity for the two operations; static-export UI
tests for scenarios A–G at 1440, 1366, 390 and 320 in PL/EN and dark/light,
including keyboard order and focus return. Verification: managed `check`,
`build`, `test:ui`, then pilot acceptance on isolated data as in earlier GUI
slices.

Deferred to later slices: a readable timeline of state changes from task history
(the Memory comparison pattern applied to tasks), list badges for open
blockers and stale states, an owner edit form, and the stage 2 case view.

## Implementation notes

The first slice follows this design with these differences:

- `KnowledgeTask` and the `task` operation are unchanged. The state is read
  only through `task_state`, which returns the task summary, the state, the
  assessment, `stateUnreadable` and system facts. List and search responses
  do not grow.
- Delivery facts have no separate `ref` field. Links to a PR, CI run or
  deployment are ordinary `external` sources. Merge records the merged head as
  `commit` and the main-branch commit as `resultCommit`.
- The stored state includes `writtenBy` (principal and authentication method)
  so the panel can show how it was written without reading history.
- Missing records cited as sources count as inactive sources.
- Source links use the existing record routes. Returning focus to the
  originating link after following a source is not implemented; browser Back
  reopens the task.
- Agent guidance lives in the `knowledge_update_task_state` MCP tool
  description. The `docs/knowledge/AGENTS.md` update waits for PR #110 and
  #111, which edit the same file.

## Alternatives considered

- **A structured section inside the description.** This needs no migration,
  but free-text parsing is fragile, `update_task` overwrites the whole text,
  and the summary would appear twice. Rejected.
- **A tagged Memory holding the state.** Revision pinning, history comparison
  and approval are already available. However, the state would clutter the
  Memory tab and task context, read as a finding rather than a status, and
  invite approving a summary as if it were a decision. Rejected.
- **A separate `knowledge_task_states` table.** Its own revision would stop
  state writes from making memory sources that cite the task stale. It costs a
  new history record kind, a new transfer array and a second concurrency token
  that can drift from the task. Kept as a fallback if task revision churn
  becomes a problem.
- **LLM-generated summaries.** Rejected by the task. They would also need
  separate provenance and could invent consent.

## Owner decisions (2026-10-27)

The owner answered the four open questions in the design thread. The design as
a whole remains a proposal until the owner reviews the document and prototype.

1. **Consent on a token-mode installation.** The owner expects separate
   permissions in the future. For now an installation-token approval counts as
   the owner's, and the design must make the later separation simple. Applied as
   `OWNER_CONSENT_METHODS` in [owner consent](#owner-consent-tiers).
2. **Storage.** One additive nullable column, `knowledge_tasks.current_state_json`.
3. **Status coupling.** `update_task_state` may change task status atomically.
4. **Rollout order.** Implement after the higher-priority work the owner set on
   2026-10-05 (the task remains `later`), and after PR110 and the `legacyId`
   change merge.

## Unverified and out of scope

- The prototype's rendering in a browser preview and its keyboard checks are
  recorded in the experiment README. They do not verify the production
  component.
- No T02e facts were re-checked. Scenario content is fictional.
- Counting replies in derived threads assumes the existing `derived_from`
  relation. Threads related in other ways are left to the stage 2 case view.
- Stage 3 (upload result, partial success, retry) and attachment retention are
  separate tasks. This design only reserves `evidence.stored` and `verified`.
- Hub importer changes are out of scope by owner decision. Hub completion
  writes leave `current_state_json` unchanged and therefore appear as
  `changed_since`.
