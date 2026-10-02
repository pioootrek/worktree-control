# S4u delivery report — 2026-10-02

Implementation: `31e9ccd9e22d4dcf0e1e85656b4d841b8fee13f3`.
PR: https://github.com/pioootrek/worktree-switcher/pull/73.
Baseline: fetched main `c7f3cca49ff3b31e7a4b3553f7f581eb30a7e8d0`, including S4a merge `0c2f187a2865549ce73b3ad79e8be84b4ebf55f4`. The pre-implementation contract was published on main in `4ad7b0e8ca2694d0ee16ff11b697a8461ef0033f`.
Separate worktree `worktree-switcher-s4u`, branch `feat/sqlite-user-backup-schedules`. Only S4u is implemented. The parent remains open. No merge or production deployment.

## Delivered behavior

User schedules are application records owned by the authenticated scoped principal. The existing product supports owner sessions and agent tokens; it has no SaaS human account provider. Installation, open, legacy and worker identities cannot own schedules. The dashboard can connect a separate scoped credential without replacing its installation session. The API never accepts an owner, path, command, target credential or service-policy mutation.

The only export scope is `knowledge-discussions`: current active project ID/name, thread and reply IDs, text, revisions and dates. Existing `exportKnowledgeProject` includes raw history, provenance and authorship, so it is not reused. Explicit SQL field selection and project predicates omit installation secrets, identities, grants, runtime configuration, tasks, memories, attachments, history and provenance. Invalid cross-project reply references and oversize sets are refused. User-authored discussion text is exported as written.

Startup/service CLI independently admits user schedules. The default is off. Actual new flags are documented in README; the plan's examples were not treated as an existing CLI contract:

- `--user-backup-enabled`, `--user-backup-projects`, `--user-backup-scopes knowledge-discussions`, repeatable `--user-backup-target ID=directory`;
- minimum interval, schedules per principal, bytes per principal, cooperative execution time, pending capacity per principal, retained count and days;
- strict numeric bounds, unique target/project IDs, private destination validation, startup/service-only arguments and service-definition round-trip.

The operator can allow 1–32 schedules per principal, a minimum interval from 60 seconds to 30 days, 1 MiB–1 GiB retained bytes, 1–300 seconds per execution, 1–32 pending jobs, 1–100 retained copies and 1–365 retention days. Defaults are 4 schedules, 3600 seconds, 64 MiB, 30 seconds, 2 pending jobs, 10 copies and 30 days. User configuration stays within these bounds. The ledger also caps 256 schedules globally, 2048 execution receipts, 1024 immutable mutation keys and 4 MiB serialized records. Exports cap at 1000 threads and 1000 replies, plus the serialized artifact bound below 4 MiB. Admission requires a 16 MiB destination free-space reserve.

Current credential, grant and CLI policy are checked at read/mutation, admission and immediately before export/publication. Both `knowledge:read` and `knowledge:export` are required. Revocation after queuing prevents execution. Artifact reads require current owner, project, scope and target authority. A schedule grants no restore permission.

The single S4a executor now accepts bounded user exports. There is still one executing backup/export, with service backups selected first among queued jobs and no preemption. The finite test queue is unchanged. S4a maintenance also blocks user admission/execution. Service and user enablement, timing and retention remain independent.

## Deadlines, durability and retention

Creation or any edit increments the configuration version and sets the next UTC instant to now + interval; disable clears it. Old queued versions are denied. Already running work uses its captured version. The overdue deadline is durably advanced before admission: at most one overdue attempt per active schedule after restart, with no replay of every missed interval. Run identity includes schedule ID, version and original deadline; each term gets its own execution/artifact ID.

Mutation idempotency uses authenticated owner + key + exact input hash. Identical retry returns the original response, conflicting input fails, and exhausted key history refuses admission. Expected versions prevent lost updates. After uncertain persistence the process fails closed rather than confirming an in-memory retry.

Private checksummed application records live beside the S4a ledger in `<database>.backup-operations/user-schedules.json`, under the same controller/database owner. No new active SQLite connection, schema change or migration. SQL snapshots do not include these records, so SQLite rollback cannot rewind configuration, keys, execution receipts or deadline watermarks.

The artifact identifies source, owner, scope, project, target, schedule/version, execution and original due instant. Publication uses private staging, file fsync, exclusive hard-link publication and directory fsync. Only complete verified exports become successful/downloadable. Failures, interruptions, denials and missed attempts remain distinct from success. Restart reconciles pending receipts conservatively; only an exact complete artifact under current authority and the persisted deadline can recover as success.

Retention runs following success only while the same version remains enabled. It verifies the matching owner/schedule/project/target envelope and checksum before deleting. It never deletes another user's artifacts, service/manual snapshots, pre-migration copies, recovery material or unknown files. Disabling does not delete copies. Failed/uncertain publication material is preserved; this slice adds no GC.

Online restore invalidates old scoped credentials through S4a. S4u additionally fences credential creation time against the external restore receipt boundary, including offline restore that resurrects a database credential. The external generation must match before execution. Fresh credentials and an explicit edit revalidate the schedule against current policy/grants and create a new future version. Restore does not reinstate CLI policy or old trust.

## Verification

All local finite verification used discovered MCP worktree/presets, sequentially, with clean source observations. No managed development server was started or switched; browser suites use the static export and controlled API fixtures. Tests create disposable databases, identities and paths. Process-kill tests target only their own isolated export child.

| Verification | SHA | Run ID | Result |
| --- | --- | --- | --- |
| Full check: lint/types, 827 Vitest + 7 script tests | `16f1222017b975ea9108d509a09932980728fd02` | `445ad4e4-d6b1-4e30-9cdb-644224c23be2` | PASS, observed_match |
| Focused S4u: 46 tests, including three real SIGKILL boundaries | `47a4d240f77562ee4cf78b478a547245b8f330e0` | `b1d87d3f-8dd6-4509-8fcd-f0614ed6d5c2` | PASS, observed_match |
| Build | `31e9ccd9e22d4dcf0e1e85656b4d841b8fee13f3` | `2b692874-f17d-4b4d-98ec-874dbd857b48` | PASS, observed_match |
| Built-controller integration: 32 tests | `31e9ccd9e22d4dcf0e1e85656b4d841b8fee13f3` | `c2b603e9-f62e-418b-9231-cbab7f2c1215` | PASS, observed_match |
| Full Chromium UI: 164 tests | `31e9ccd9e22d4dcf0e1e85656b4d841b8fee13f3` | `d394382f-1584-46e9-aa34-2df2e1f0fa80` | PASS, observed_match |

The earlier local check and focused test SHA are not relabeled as final-SHA results. Their subsequent changes were the fail-closed persistence guard with one test, followed by the integration fixture identity fix. Final full check, HTTPS, integration/UI/E2E and installed-package verification are assigned separately to CI below.

Tests cover default-off/independence, CLI limits and service arguments, foreign schedules/projects/targets/results/artifacts, narrow export isolation, grant revocation after queueing, concurrent terms/shared priority/capacity, version/key/restart/overdue semantics, retention isolation, online/offline restore revalidation, publication/collision/size/time/write-denial failures and restart reconciliation. GUI tests cover PL/EN, native validation, keyboard create/edit/toggle/close with focus return, loss of response, missing receipt, same-key reload retry, limits, 403 clearing, separate scoped sessions and widths 1440/1366/390/320 at height 650 in light/dark themes.

### Corrected failures and attribution

Every listed failure remains evidence, not acceptance:

- Typecheck `1473f74f-c071-4f2f-ae5f-fd239f8dfa99`: an import preceded the CLI shebang. Moved below it.
- Typecheck `991b6881-b9a7-4b91-98a2-d08dd24d1734`: process exited zero, but source SHA changed during the run. Attribution is changed; counted as failed. Later submissions waited for commit completion.
- Check `2d738daa-49ef-482c-b29e-02cf2d696de3`: new integration fixture omitted the required waitFor diagnostic argument. Corrected the call.
- UI `28715309-e3ba-4b9d-a9c0-cf8d6e7515f2`: 14 passed, one failed at Polish 320 px. The long credential-change button forced the dialog grid beyond the viewport. Wrapped the button and bounded the grid track; overflow assertions remain. Also corrected the test's theme-storage key and asserted the actual theme class. Original screenshot/trace were preserved before the next browser run.
- Focused tests `12af4d85-f091-4e25-91cd-27fc16840dd1`: 44 passed, one failed because the manually checksummed receipt fixture omitted the new persisted deadline. Added the explicit field; no schema default that changes a checksummed payload.
- Check `f36aaead-8453-43a5-8af0-1bd22b93eabe`: lint rejected synchronous state hydration in an effect. Deferred session hydration via cancellable requestAnimationFrame; no lint suppression.
- Integration `d8bc5889-0b87-468b-9762-8b48bb9408fe`: 31 passed, one failed because default-off coverage used legacy owner bootstrap in the token-mode fixture. Used the supported admin API to create/issue a scoped principal instead. Real export/restart/online/offline restore had passed in this failed suite.
- CI `37050081829` on `47a4d24` is superseded by the integration fixture correction. It was cancelled by normal workflow concurrency after the corrected commit; it is not a final green run.

No assertions were loosened and no retry was added to hide a failure. SIGKILL proves process interruption behavior, not power-loss durability.

## CI and package evidence

Final CI: https://github.com/pioootrek/worktree-switcher/actions/runs/37050621798, attempt 1, PR head `31e9ccd9e22d4dcf0e1e85656b4d841b8fee13f3`. All four jobs passed: check-build, package-smoke (22.23.2), package-smoke (24.21.0) and package-service-lifecycle. Full check passed lint/types, 828 Vitest and 7 script tests; build, HTTPS (1), integration (32), Chromium UI (164) and E2E (3) passed.

GitHub tested/packed clean synthetic merge `f937bd9ef82d9b2531a13cf9feacb29808b7d7a4`, whose parents are main contract commit `4ad7b0e8ca2694d0ee16ff11b697a8461ef0033f` and final feature head `31e9ccd9e22d4dcf0e1e85656b4d841b8fee13f3`. Artifact `worktree-switcher-0.1.0-trial.1.tgz`: 835307 bytes, SHA256 `c8cc7e154df46acbd39b62b627c7b947b83898c058a1ceea761f4d2987d1f615`. Downloaded artifact, SHA256SUMS and provenance agree; smoke/lifecycle helper checksums also agree. The CLI bundle contains the user startup flag, schedule ledger, discussion scope, HTTP route and export publication identifiers.

Installed-artifact smoke passed all 14 steps on each Node version with graceful cleanup, including native SQLite, private installation audit, assets, CLI, HTTP/MCP and backup verifier. Disposable-runner systemd lifecycle passed installation/idempotency, open/restart, new user session, repeated install, singleton/occupied-port rejection and uninstall; cleanup reports service absent and data preserved. These are fresh-install checks, not an old-artifact upgrade or production service change. The provenance file's static `pending-package-smoke` label records pack time; the separate downloaded reports and green jobs establish the later smoke result.

## Limits and follow-up boundary

Only the bounded discussion projection is available; project-transfer, attachments and other data scopes remain unavailable. No SaaS human identity adapter was introduced. Targets remain operator-managed local private directories.

Time limits are cooperative checks around bounded synchronous work, not a hard interrupt of filesystem/SQLite calls. Retained unknown/failed material and exhausted immutable key histories can stop admission and require a future operator recovery procedure; they are never silently deleted/reset. The external schedule ledger must be preserved with the controller's operational records; moving it to another host is outside this slice.

Unverified: power loss, physical disk exhaustion, macOS, old installed-artifact upgrade, production data/deployment, a new-host restore of the external ledger, and actual browser 200% zoom. SIGKILL, injected errors, permission denial and 320 px screenshots do not substitute for those proofs. This PR adds no transfer, customer restore, attachment GC, production rollout or host service/guard/limit changes. S4b/S5 remain untouched.

Inspected final screenshots: [PL 320](storage-safety-s4u-pl-320.png), [EN 390](storage-safety-s4u-en-390.png), [PL 1440](storage-safety-s4u-pl-1440.png). Mobile content scrolls inside the bounded dialog; no horizontal overflow was observed. The [original failed PL 320 screenshot](storage-safety-s4u-failed-pl-320.png) is retained separately.

Evidence: [sanitized run records](storage-safety-s4u-evidence-20261002.json). The parent `RWK-20260928-sqlite-data-safety` stays open.
