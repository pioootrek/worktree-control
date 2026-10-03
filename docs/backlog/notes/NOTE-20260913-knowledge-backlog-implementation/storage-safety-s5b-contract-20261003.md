# S5b implementation contract — 2026-10-03

Status: accepted implementation direction; code starts after PR #75 merges.
Root orchestrates and reviews; one gpt-6.1-sol high worker implements.
Scope: code and isolated tests; operational target, keys and rollout are separate.

1. Offline `backup remote rebind --from <destination-id> --target-config <private-restic-json> --generation <next>` obtains existing controller lock AND canonical database-owner lock, without opening SQLite. Refuse active owners/unfinished restore. `target-config` is operator-only private input using existing restic validation; read-only authenticated `cat config` proves the new cryptographic repository ID. Never upload or change service definitions during rebind. Operator starts controller with the new target policy separately; same repository ID at another locator needs no rebind.

2. Migrate remote record to format 2: active ledger + previous-repository archives + monotonic rebind generation/last request digest in ONE existing checksummed durable JSON publication. Up to four archived repositories and the existing 4 MiB total envelope limit; preserve old confirmation and every pending/failed/running receipt and pin, refuse limits before mutation. Keep installationId, replace active destination, clear active lastConfirmed and active receipts. One publication makes archive/pins/rebind atomic; before rename old generation wins; after visible rename readRecord repairs directory sync and matching retry returns existing result. Same generation with changed from/target is conflict; lower generations cannot rebind backward. Existing format-1 migrates without dropping evidence; older controllers fail closed on format 2.

3. `hasReceipt` considers historical intent for automatic local-publication reconciliation so old backups are NOT implicitly reuploaded. `protectedIds` unions active pending and archived pending; disabled transfer preserves all pins. Current remote confirmation/pending are distinguished from archived evidence. New target starts unprotected regardless of old confirmations. `backup remote reupload <backup-id>` is running-controller, OS-owner CLI only, restricted to an archived server-recorded backup still in configured catalog; saved original manifest identities/dataAt must match. One selected ID per invocation; stable current-target backupId identity makes duplicate admission idempotent, existing pendingLimit (max32), receipt/byte caps and shared executor bound work. Reupload cannot reset attempts; failed admitted transfers still need existing monotonic `retry --generation`. New-target success does NOT erase uncertain old-target receipts/pins or claim recovery proof.

4. Partial-history reconciliation uses durable progress, not merely a larger array cap. Restic 0.19.1 snapshots has no cursor/after pagination; `--latest` truncation cannot prove that an older complete candidate is absent. Every pass inventories ALL matching snapshots under 512 KiB/256-unique-candidate budget; validate full ID/tree/host/path/tags and reject duplicate IDs/unknown/truncated inventory. Each pass authenticates at most32 not-yet-classified candidates, with aggregate32 MiB read output and existing upload-policy wall deadline. Store proven-partial ID/tree classifications bound to destination+installation+backupId+manifestSHA outside SQLite in the remote receipt; strict per-receipt256/global1024 proof and 4 MiB record limits. Re-inventory next pass, reuse proofs only for unchanged immutable ID/tree and exact source identity. Successful full inventory mismatch proves partial; network/dump/permission/parse failure is unknown, never proof of partial.

5. Add a transport progress outcome so read-only continuation persists proofs and requeues through the SAME executor without consuming a new upload attempt. Maximum8 automatic continuation passes per receipt, at least retrySeconds spacing, no new timers/capacity maps; exhaustion fails safely and explicit retry generation can resume retained proofs. Zero complete candidates authorizes upload ONLY after exhaustive classification and with a spare candidate slot; one complete authenticates existing confirmation; multiple complete points, changing/oversized inventories or exhausted budgets forbid upload. Recheck after write before confirmation. No `forget`, `prune`, deletion permission or automatic cleanup. New target never reuses previous-target proofs.

6. Evidence: format1 compatibility; active-owner/canonical-alias refusals; crash before/after single publication and retry fencing; archive/count/byte caps; pins across disabled/restart/restore/rebind; explicit singular reupload/idempotency/wrong source/newtarget-age isolation; >32 partial candidates with one older complete point, all partial then one upload, progress restart, unknown candidate, duplicatecomplete, candidate/byte/time/pass budgets and no remote deletion. Reuse disposable real HTTPS restic fixture and installed CLI; no production target/key/host operations.

Open implementation detail to check before coding: acquireDatabaseOwnership currently invokes owned-restore recovery; offline rebind must refuse pending restore first and preserve that helper's singleton semantics rather than introduce another lock path.

Implementation constraints confirmed in review:

- Private operator status distinguishes archived pins/counts from active-target
  protection. Archive exhaustion is an explicit refusal, never implicit deletion.
- Continuation counters and budgets survive restart. Changing inventories cannot
  reset them indefinitely. A snapshot created by the current upload is handled
  explicitly during post-upload reconciliation.
- Partial proof requires a complete authenticated mismatch; truncated or failed
  reads never classify a candidate as partial.
- Aggregate read budgets must support the existing manifest/tree contract and
  stay separate from the 64 MiB streaming backup-progress budget. The proposed
  32 MiB read allowance must be checked against those existing limits before
  implementation; document the final bound and its refusal behavior.
- Refuse unfinished restore before any ownership helper that could run recovery;
  rebind cannot implicitly perform restore.
