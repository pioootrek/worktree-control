# Memory history progress

[PR #66](https://github.com/pioootrek/worktree-switcher/pull/66) remains open. Sol high implements on isolated `rework/knowledge-history`; root owns serialized managed tests, isolated-pilot QA and delivery. This report is in progress, not a merge claim.

Candidate `c04eac239e370638dac96079d7920da787550ea9` passed managed check (515 application tests + 7 resource tests, lint/types; run `28acc935-1fa8-4617-b8b6-56852d39a4a1`) and build (`489cf411-6761-48fe-95e8-a503694f8e97`) with clean matching source observations. UI run `55179627-72a9-44d5-9c00-a3deae90df6b` is in progress. Earlier check attempts failed on effect-state lint and a test fixture variable, corrected before the passing run. One early direct typecheck was run by the agent before root reiterated managed-only verification; it is not final evidence.

The managed pilot is running c04eac2 on the history worktree. Supported API comparison preserved 21 pre-existing Memory records and four raw audit entries; all before/after field snapshots of the separate 28-revision native QA fixture matched the original mutation results, including page 25/3. This checks actual approval, invalidation, archive/restore and supersession, without production data changes. Browser visual acceptance remains pending while the UI suite runs.

n8n all dispatched once. Claude completed analysis but its permission mode denied GitHub publication. Its two concerns were read from the log: (1) possible stale Memory A under B, contradicted by existing keyed MemoryPanelContent remount and protected by a new delayed-read/actual-B-mutation regression pending UI results; (2) unconditional before/after body inflation of agent history, fixed by strict-validated optional includeComparison, default false. UI explicitly opts in; ordinary HTTP/MCP shape and work remain unchanged. Kimi/Codex review completion remains pending.

No history/schema mutation. Incomplete, malformed or discontinuous snapshots explicitly lack a comparison. Scope stays existing Memory history; broader GUI work remains open.
