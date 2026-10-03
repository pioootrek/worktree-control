# S4u: user schedule contract

Written before implementation, 2026-10-02, against main c7f3cca and merged S4a 0c2f187. Updated 2026-10-03 for the owner-authorized PR #73 closeout. Only S4u is authorized. No transfer, restore of customer data, attachment GC, deployment or host service changes.

## Authority and scope

Default off. Startup/service CLI independently enables user schedules, lists allowed project IDs and local target ID/path mappings, and bounds interval, schedules per principal, retained count/days, bytes per principal, execution time and pending capacity per principal. Service backup policy stays separate and read-only. HTTP accepts IDs, intervals, retention, enabled state, expected version and an idempotency key. No paths, commands, secrets or owner field.

The current product has owner and agent scoped credentials, not a SaaS human account adapter. S4u accepts active owner_session and agent_token principals; installation/open/legacy/worker identities are unavailable. Owner comes from authentication. Activation records the credential ID, never its secret. Expiry/revocation blocks execution until the owner edits the schedule with a current credential. Check authentication, project grants and CLI policy on reads/mutations, admission and immediately before export. Require knowledge:read plus knowledge:export. A schedule grants no restore authority.

Existing project-transfer format is unsuitable: it includes raw history snapshots, import sources and authorship. The only S4u scope is knowledge-discussions, an explicit projection of current project name, thread/reply IDs, text, revisions and dates. No credentials, grants, runtime configuration, provenance, history, authorship, tasks, memories or attachments. All queries are project-bound and bounded; oversize/inconsistent content is refused, never silently truncated. Content itself remains user-authored project data. Other scopes stay unavailable.

## Persistence, deadlines and changes

Application schedule records and execution receipts use checksummed private atomic records beside the S4a ledger, under the same database owner. No additional live SQLite connection or schema change. This store is outside whole-database snapshots and is not rolled back by restore. It has a fixed global schedule/history bound. Format 2 stores a random mutation generation and four receipts per schedule (at most 1024 globally). Fresh keys bind generation, schedule ID, expected version and nonce; forgotten keys cannot execute against a consumed version. Retained identical requests replay; conflicting payloads return 409 and expired keys return 410. Configuration version and receipt compaction commit together. An exhausted receipt history cannot block an authorized disable or consume another schedule's reserved history. Format 1 is checksum-validated before migration; unknown opaque legacy keys expire, retained ones still replay. Older controllers refuse format 2. Never reset generation or schedule versions independently.

UTC deadlines are persisted instants. Creation/enabling or an edit increments configuration version and sets nextAt = current time + interval. Disable clears nextAt without deleting artifacts. Edits invalidate queued work of the previous version. Already running work completes with its captured version; disabling prevents retention. A due tick advances to now + interval before admission, attempting at most one overdue slot per enabled schedule, including after restart. No catch-up storm. Identity is schedule ID + version + original deadline; each admitted execution receives a separate artifact/run ID. The deadline watermark persists outside SQLite. Configuration retry with the same owner/key and identical input returns the original response; a different payload under that key conflicts. Versions prevent lost updates.

## Execution and retention

Extend S4a's single executor. Shared bounded capacity, one active service backup or user export. Select queued service jobs before users without interrupting running work. Per-principal pending and disk limits also apply. Maintenance closes admission and prevents queued work; finite test state machines remain unchanged.

States: queued, running, succeeded, failed, interrupted, denied. Refusal, delay and interrupted work are never successful copies. Persist receipt before admission returns and reconcile queued/running receipts as interrupted after restart unless the exact complete, checksummed artifact was durably published. Publication uses private staging, file fsync, exclusive final naming and parent fsync. On publication/durability error report failure and preserve evidence, never manufacture success. Limits and cooperative deadlines are checked around bounded synchronous phases.

Artifact envelope identifies user-schedule source, owner, scope, project, target ID, schedule ID/version, execution ID and original deadline. Read/download rechecks current owner, credential, grants and CLI target/project policy. Artifact paths are computed by the server. Only complete recorded artifacts are visible.

Retention runs only following success, while the same schedule version remains enabled. It examines only matching owner/schedule/source artifacts whose checksum and envelope match the durable receipt. Keep the newest, apply count and age; never traverse or remove unknown/service/manual/pre-migration/recovery material. Disabling does not delete copies. Refusal to validate retained material is visible as a retention failure.

## Restart, restore and GUI

Restart does not reconstruct queued exports. It reconciles receipts then admits at most one overdue attempt per schedule. Whole-database restore cannot resurrect old schedule configuration, CLI arguments, deadline watermarks or execution keys because those remain outside SQLite. S4a invalidates restored scoped credentials before listeners reopen; a surviving S4u schedule therefore requires a current credential and current grants/policy before it runs. Explicit edit with a newly issued credential revalidates and starts a new version/future deadline. Offline restoration also requires current identity checks; historical principals alone never authorize execution.

GUI separates own schedules from the installation operator's read-only service settings. PL/EN, native keyboard controls, mobile wrapping, explicit refresh without new subscriptions. Persist the pending mutation/key across lost responses and reopen; a missing individual receipt leaves the authorized panel available for explicit same-key retry. Authentication loss clears protected content. Validation/conflict/quota/maintenance/denial are visible.

## Verification boundary

Use exact discovered worktree and sequential MCP presets. Results count only on committed clean revisions with source observations; package checks use isolated data. Cover CLI/default-off independence, authority and scope, export isolation, queued grant revocation, shared priority/capacity, configuration/retry/deadlines/restart, retention isolation, restore credential fence, interrupted publication and PL/EN keyboard/mobile/reconnection. Record limitations honestly. The parent remains open.

## Operator recovery and staging accounting (2026-10-03)

Both local agent branches are integrated into PR #73. The operator uses the running controller's private admin socket with `backup user-cleanup list`, `preview <execution-id>`, then `cleanup <execution-id> <confirmation>`. Application operations enforce local-admin authority and share the existing backup executor. No offline SQLite owner or user HTTP cleanup endpoint is added.

Known failed, interrupted and succeeded executions qualify; active or denied executions do not. Preview explicitly reports the original state. Deleting a succeeded copy, including the last one, requires the same explicit operator confirmation. This provides a supported way to clear full owner-byte or global-history capacity without automatic removal of the last successful copy. Automatic retention remains success-driven. Listing reads bounded metadata; preview validates one complete final or staging export. It binds the captured execution, current configured target, complete envelope/checksum, file identity, directory identity and exact permitted aliases. No caller supplies a deletion path. Unknown, corrupt, foreign, symlinked or extra-hardlinked material is preserved. A complete staging-only export is eligible under the same checks; it does not become a successful publication.

A separate checksummed recovery journal durably records intent before unlink. Revalidate surviving names before each unlink, synchronize the directory and durably settle before releasing the charge. Pending intents keep their execution and saved charge across restart, even if names appear absent. Retry uses the same execution and confirmation IDs. Completed replay never deletes replacement material; expired execution IDs refuse. Persistence uncertainty fences admission until normal restart.

All recorded final/staging files count toward owner quota, deduplicating the known final/staging inode pair. Staging preserves its execution record even if timeout/crash preceded the publication stamp or CLI target configuration changed. Repeated failures cannot evade quota by leaving uncharged partials or pruning their history. Unsafe material remains charged and requires inspection. Unknown filesystem files are outside this bounded ID-based operation; no general garbage collector is introduced.

Recovery journal limits remain 2048 entries and 4 MiB. Pending entries cannot be pruned. Mutation and recovery journals remain separate and outside SQLite restore. SIGKILL/injected errors do not establish physical power-loss durability.
