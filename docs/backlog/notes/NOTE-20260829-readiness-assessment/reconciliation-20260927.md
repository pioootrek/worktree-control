# Delivery and remaining work, 2026-09-27

Inspected application revision: `17d0c9d7e5be6d3f451298cdb7b364dbf25f5200`
on `main`. This assessment supersedes earlier readiness summaries for current
status. It reconciles documentation and backlog; it does not change application
behavior, running services or the authoritative location of project data.

## Evidence and limits

[Main CI run 36312411574](https://github.com/pioootrek/worktree-switcher/actions/runs/36312411574)
completed successfully for that exact revision. Checked job and step results:

- `check-build`: `pnpm check`, build, HTTPS, integration, UI and E2E suites,
  followed by artifact packing.
- `package-smoke`: checkout-free artifact installation on Node 22.23.2 and
  24.21.0.
- `package-service-lifecycle`: packaged Linux systemd lifecycle on an isolated
  runner, including session-manager restart and removal.

These are retrieved CI results, not new local application tests. They do not
prove every backlog criterion, a real owner trial, macOS behavior, a populated
old-to-new package upgrade or a successful Hub cutover. Historical resource
measurements retain their original revision and date.

## Backlog disposition

| Item | Delivered evidence | Remaining work / disposition |
| --- | --- | --- |
| K0 contracts | Contract, Hub inventory, synthetic fixture and baseline files in the knowledge implementation note; commits `3e060ef`, `57a6996` | Closed as `DONE-20260927-knowledge-k0-contracts`. Downstream implementation and migration acceptance stay in the parent. |
| Installation authentication | PR #54; authentication module, CLI admin socket, transport/browser tests, main CI | Keep `FEAT-20260829-independent-auth-modes` for the credential-free CLI gap below. |
| Environment profiles | Existing runtime/test profiles, validation and MCP operations | Select a concrete need for relative working directories, referenced environment files/secrets or CLI additions; no new slice selected here. |
| Package trial | Producer artifact, consumer smoke on two Node versions and real Linux service lifecycle | Populated package upgrade and fault recovery, recorded real-client trial, durable download handoff. Registry publication remains a separate decision. |
| Multi-project switching | Runtime/capacity/ownership code, integration/E2E suites and dated resource evidence | Map remaining criteria to existing evidence and record the focused owner workflow. Do not recreate the suites. |
| Remote verification | Request/attempt services and SQLite queries; exact-SHA Git workspace adapter and tests | Enrollment, credentials, outbound protocol, queue execution, reconciliation/cancellation, caller transports and owner trial. |
| Shared knowledge | K1 outcome; K2–K6 code from PRs #42–#48, K7a tooling and import/UX follow-ups #49–#52 | Reconcile stage acceptance, update pilot authentication, record current import/restore/live evidence, then explicitly cut over one project. K8/K9 remain implementation work. |
| Service/UI boundaries | Extracted application modules, feature compositions, SQLite helpers and architecture tests | Incremental extraction of the next touched transport, bootstrap or facade responsibility. No rewrite or repeat of the first extraction. |
| Better Auth | Unavailable-provider boundary only | Implement the optional one-owner account provider; commercial terms remain undecided. |
| Production runtime | Finite build presets only | Optional managed build-then-serve workflow; a build result is not a running production server. |
| Cache reset | Dashboard reset and completed lifecycle race fix | Optional CLI or one-shot before-start convenience, when justified. |
| Scoped runtime tokens | Durable identity and scoped knowledge credentials | Runtime project filtering, capabilities, lease/audit binding and management UI/CLI. |
| User service | Packaged Linux systemd lifecycle in main CI | Shared upgrade/recovery work, unexpected-failure/child-cleanup acceptance and real macOS evidence. |
| Agent coordination | Identity and knowledge foundations | Assignments, addressed messages/inboxes, acknowledgements and revision-bound handoffs. Autonomous execution remains later. |

Thirteen items remain open after the K0 closure. Their canonical JSON records
contain the current residual scope; their earlier notes remain historical.
K1 was already closed in `DONE-20260926-knowledge-k1-identity`.

## Authentication acceptance gap found during reconciliation

The backend supports anonymous installation authority in `open` mode, but these
CLI entry points require a nonempty token before using that policy:

- `src/cli/knowledge-management.ts`: `runKnowledgeCommand` rejects before
  reading the service record; `runHubImportExecuteCommand` rejects before
  opening the offline database.
- `src/cli/identity-management.ts`: `administratorToken` is called for online
  administration and offline operations other than owner bootstrap/recovery.
- `src/cli/backup-management.ts`: logical `export-project` and `import-project`
  reject before resolving the offline actor. Full controller `create`/`restore`
  do not have this token precondition.

This is source-level evidence. No live mutation or new reproduction was run.
The early rejection is independent of the selected mode. The existing task
now requires tests with every token environment variable absent in `open`,
plus protected-mode and scoped-access regressions. Do not close it solely
because stage 1 merged or the existing suite is green.

## Knowledge delivery and migration boundary

Current code includes threads/replies/tasks, optimistic revisions and retry
keys, memory approval/search/context, attachments, controller backup, logical
project export/import and resumable Hub import with fidelity corrections.
Evidence lives in `src/server/modules/knowledge/`, SQLite knowledge/import
tests, `src/server/knowledge-transports.test.ts`,
`tests/integration/knowledge-flow.test.ts` and `tests/ui/knowledge.spec.ts`.

`scripts/knowledge-pilot.ts` and `scripts/knowledge-pilot-live.mjs` provide an
isolated K7a trial. The setup creates a fresh database and an owner session;
the live driver uses the old pairing/knowledge-session path. They predate
default token-mode startup and are not run by the cited CI. Reconcile their
setup with `assertStartupPolicy` and current browser authentication before
using them as current pilot evidence. No private pilot report was inspected.

The repository's `AGENTS.md` still makes the Git-backed backlog authoritative.
Neither merged import code nor this reconciliation approves changing that
write location. K7 needs a selected project, accepted import/restore evidence,
one explicit cutover and a recorded daily-work trial. K8 playbooks/inspection
and K9 approved-rule composition follow it.

## Suggested next work

First fix the bounded open-mode CLI inconsistency. Then refresh and run the
isolated knowledge pilot before proposing any real-project cutover. For the
next larger implementation, the recorded owner direction still puts remote
commit verification ahead of autonomous fleet execution. Package
upgrade/recovery is the remaining distribution gate; a new UI theme or broad
refactor is not required to address either workflow.

## Documentation verification

Canonical Hub `fmt` regenerated the index; `validate` passed with 13 open
items, 19 done entries, 18 notes and 16 top-level documentation pages.
The synthetic Hub fixture was copied into an isolated temporary Git repository
and passed validation with Hub revision
`22afb656c74b2fde84cb92f1aefcf8b427697cc6` (one item, done entry, note and doc).
`git diff --check` and a relative-link check of changed Markdown passed;
existing backlog item note histories were preserved in order. No local
application build, browser run, migration or runtime mutation was performed.
