# Knowledge workflow

Worktree Control Knowledge project `k7a-worktree-switcher` owns this repository's tasks,
discussions and durable findings. Product documentation and agent instructions
remain in Git. All local worktrees use the same Knowledge project.

## Before work

Read `knowledge_project` and `knowledge_tasks` with
`projectId: "k7a-worktree-switcher"`, then the relevant task, discussion and memory.
Follow `nextOffset` when a result is paginated. Choose open work by priority:
`now`, then `next`, then `later`. Knowledge operations require no server claim.

Use the configured MCP connection, which may still be named
`worktree-switcher`. Keep credentials in private client configuration. If
Knowledge is unavailable, report the failure and pause backlog writes.

## Context handoffs

For a handoff that needs replaced alternatives, pass `includeSuperseded: true`
to `knowledge_task_context` or `knowledge_export_context` (JSON or Markdown).
The default stays unchanged. `supersessionHistory.chains` attaches predecessors
to approved decisions on the current page; keep this history separate from
current decisions and proposals. Each predecessor retains its superseded
revision, `updatedAt` date, and recorded `supersededBy` replacement ID/revision.
Replacement revisions may have advanced since that pointer was recorded.

Follow `nextOffset` with the same option for subsequent current entries.
History is bounded to depth 8, 50 predecessors and 32 KiB across the page,
nearest predecessors first. Check each chain's `truncated` flag and read full
memories separately when more history is needed. History truncation does not
advance `nextOffset`; the flag also covers detected repeated records.
Exports retain the 256 KiB limit; reduce the page size if an export exceeds it.
Use the same `includeSuperseded`, `limit` and `offset` when calling
`knowledge_check_context_export` to validate the saved fingerprint.

## Writing and completion

Create tasks with `knowledge_create_task`, stating the problem, scope, expected
outcome, validation and risk. Use returned service IDs and current revisions.
Set `in_progress` when starting, `blocked` with an unblock condition when
necessary, and `done` only after verification. Append results and limitations
to the existing task description. Read the saved task back before reporting
completion.

Append discussion replies rather than rewriting history. If
`knowledge_relations` returns a linked discussion, append completion evidence
there too. The current MCP API cannot link an arbitrary new discussion to an
existing task. Reuse an idempotency key for identical retries; re-read the
record after a revision conflict. Search before creating durable memory. Save
useful findings before context compaction. Human decisions remain distinct
from agent proposals and historical imported author labels.

## Imported records and attachments

Find a legacy ID with `knowledge_search`, using `query` and
`includeInactive: true`. For a matching thread, use `knowledge_relations` to
find its task. If needed, search `knowledge_tasks` by title with
`activeOnly: false`, then read candidate records. The `legacyId` filter
currently applies only to memories; an empty filtered result does not prove
a task is absent. Report ambiguous matches instead of creating duplicates.

Use `knowledge_attachments` and `knowledge_attachment` for imported note
payloads. Before uploading a batch, check `knowledge_attachment_policy` and
`knowledge_check_attachment_batch` for the entire set.

The local file backlog was retired on 2026-10-10. Source hashes, additional
historical versions and verification evidence are retained in Knowledge
memory `6a6a5d6b-867e-48d5-9491-a589614ebcd9`. Git history also retains the old files.
Current task status comes from Knowledge. A return to files requires an
explicit migration preserving changes made since the original import.

Treat existing `backlog-feedback` issues as human input: locate the imported
record, save accepted changes and evidence in Knowledge, and follow the
authorized issue workflow. Old Hub cards are historical snapshots.

## Repository documentation

Maintain product decisions in topic documents in Git and identify their
Knowledge evidence. Keep secrets and private credentials out of both stores.
Preserve sibling `CLAUDE.md` files containing only `@AGENTS.md`.

For governed top-level pages in `docs/`, preserve sorted, double-quoted
frontmatter. Active and reference pages require `last_reviewed`; change it
only after checking facts. Superseded pages identify `superseded_by`.

After documentation changes, run `python3 scripts/docs.py fmt`,
`python3 scripts/docs.py check`, and `git diff --check`. Use an available
Worktree Control verification preset for the corresponding command.
