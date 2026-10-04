# Knowledge workflow and archived backlog

Status: active
Audience: humans and agents maintaining project memory
Source of truth: Worktree Switcher Knowledge project `k7a-worktree-switcher`

## Current work

Use the configured Worktree Switcher MCP connection or Knowledge GUI. Read
`knowledge_project` and `knowledge_tasks` with
`projectId: "k7a-worktree-switcher"`, then relevant tasks, related discussions
and durable memory. This project identity is independent of the runtime
project ID; do not create a second Knowledge project named `worktree-switcher`.

Use service record IDs and current revisions returned by Knowledge. To locate
an imported record, call `knowledge_search` with the project ID, its
`legacyId` and `includeInactive: true`. Check provenance when the match is
missing or ambiguous; do not recreate it from an old JSON entry. Archived Hub
cards and JSON indexes do not reflect later Knowledge writes.

Create work with `knowledge_create_task`, stating the problem, expected
outcome, scope, validation and risk. Pick open tasks by priority: `now`, then
`next`, then `later`. Use `knowledge_update_task` and the current revision for
`in_progress`, `blocked` with its unblock condition, or `done` after checking
the outcome. Reuse the same idempotency key when retrying a write and re-read
after a revision conflict.

On completion, append outcome, validation and limits to the task description,
preserving its previous content. If `knowledge_relations` returns an existing
linked discussion, append a reply there as well. Read the saved task back
before reporting completion. The current MCP API cannot link an arbitrary new
discussion to an existing task. Do not create a `DONE-*` file or delete the
task to close it.

Append discussion replies instead of rewriting decision history. Save durable
findings in Knowledge before compaction and check existing records first.
Human-authored notes remain direction; imported author labels are historical
attribution, not authenticated identity. Agent proposals do not become human
approvals. Process `backlog-feedback` issues by finding their legacy IDs in
Knowledge and reference the saved outcome when closing them.

If Knowledge is unavailable, report the connection or access failure and
pause backlog writes. Keep credentials in private client configuration and
never put secrets in Knowledge. Knowledge operations do not require a managed
development-server claim.

## Frozen import archive and Git documentation

Existing JSON records, manifests, indexes and note payloads under this
directory are the frozen import archive. Preserve their bytes and historical
links. They are not a second writable backlog, and there is no synchronization
from Knowledge back into them. A future rollback to files must first export
post-cutover Knowledge writes.

Product documentation stays in Git. After changing this guide or top-level
Markdown pages under `docs/`, run from the repository root:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
HUB_DIR="${LLM_OPS_HUB_DIR:-/home/pioootrek/development/llm-ops-hub}"
"$HUB_DIR/.venv/bin/python" "$HUB_DIR/bin/hub.py" fmt --backlog-dir "$REPO_ROOT/docs/backlog"
"$HUB_DIR/.venv/bin/python" "$HUB_DIR/bin/hub.py" validate --backlog-dir "$REPO_ROOT/docs/backlog"
```

Do not hand-edit generated `index.json`, weaken schemas or commit failed
validation. Top-level documentation keeps canonical frontmatter; update
`last_reviewed` after checking changed facts. Preserve `CLAUDE.md` companions
containing only `@AGENTS.md`.
