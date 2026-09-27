---
audience: "contributors and coding agents extracting or adding modules"
last_reviewed: "2026-09-27"
source_of_truth: "incremental module organization and dependency rules"
status: "active"
---

# Codebase organization

Develop a modular application inside the existing single Node.js controller.
Keep the statically exported Next.js dashboard and local SQLite adapter.
Use `docs/architecture.md` for runtime decisions and
`docs/architecture-effort-assessment.md` for the planned expansion. Check the
actual interfaces before implementing examples from design documents.

### Current map and extraction destinations

The following destinations guide new work and incremental extraction; they
are not a claim that the directory migration is complete.

| Responsibility | Current location | Destination when extracted |
| --- | --- | --- |
| Pages, layouts, dashboard composition | `src/app/`, `src/features/dashboard/`, feature compositions in `src/features/<area>/` | Keep new feature UI, hooks, and API clients with their area |
| Reusable UI controls | `src/components/ui/` | Keep here; feature-specific composition stays with its feature |
| Application operations | `src/server/modules/` (including lifecycle, runtime, verification, identity, authentication and knowledge), remaining operations in `src/server/control-service.ts` | Extract the next touched workflow behind the existing facade |
| HTTP and MCP adapters | `src/server/http-server.ts`, `src/server/mcp-*.ts`, extracted knowledge handlers under `src/server/transports/` | Move the next touched route/tool family under `src/server/transports/` |
| Persistence, Git, OS processes, file logs | SQLite under `src/server/infrastructure/sqlite/`; other adapters under `src/server/` | `src/server/infrastructure/<adapter>/` |
| Controller construction and lifecycle wiring | `src/cli/index.ts` | `src/server/bootstrap/`; command parsing and CLI output stay in `src/cli/` |
| Browser-safe API types and schemas | `src/shared/contracts.ts` | `src/shared/contracts/<area>.ts` |
| Translations and locale handling | `src/i18n/` | Keep the existing typed translation system |

Existing areas include projects, reservations, runtime, verification,
environments, status, dashboard queries, identity, authentication and knowledge.
Remote verification has request/attempt and workspace foundations, without a
connected-worker execution flow. Add further worker or coordination modules
with their first implemented workflow. Do not create empty modules or generic
extension frameworks for backlog ideas.

See [module development](module-development.md) for implemented APIs, ownership,
focused test commands, and responsibilities still retained by the facade.

### Dependency and contract rules

- HTTP, MCP, and CLI adapters validate and translate requests, invoke shared
  application operations, and format responses. Keep business authorization,
  reservation policy, and state transitions in those shared operations.
- Application modules depend on explicit interfaces for persistence, Git,
  execution, and other external effects. Concrete adapters implement those
  interfaces; bootstrap constructs and connects their instances. During
  extraction, narrow existing dependencies without replacing working adapters
  solely to match a pattern.
- A module exposes a small, explicit public API. Other modules must not reach
  into its query helpers, mutable state, or implementation files. Keep the
  dependency graph acyclic; extract a shared contract or coordinate the use
  case at the application layer when two modules would depend on each other.
- Browser code may import browser-safe contracts and UI dependencies, never
  controller modules, SQLite, Node APIs, or privileged configuration. Shared
  contracts must not import server implementations. Keep internal persistence
  records separate from public response shapes where their contents differ.
- Keep reusable UI presentation-focused. Feature hooks and API clients own
  browser data loading and mutations; the controller owns permission checks.
  Preserve translations, accessible states, and keyboard interactions.
- Use shared validation schemas at input boundaries when adding or extracting
  contracts. Keep transport parsing separate from application invariants and
  return safe, consistent errors across HTTP, MCP, and CLI. Preserve existing
  payloads and error semantics during behavior-preserving refactors.
- Give each file a cohesive responsibility and descriptive kebab-case name.
  Keep tests near the implementation using the existing `*.test.ts` convention.
  Prefer domain-specific helpers over expanding a generic `utils` directory.
- Enforce established import boundaries with lint rules or focused architecture
  checks as modules are extracted. Written rules alone are not evidence that
  automated enforcement exists.

### Ownership invariants

- Preserve one controller/database owner under the existing singleton lock,
  including offline CLI access. Splitting SQLite code must preserve migration
  order and transaction boundaries; modules do not open independent connections.
- Runtime changes, test admission, and cache maintenance must coordinate through
  the same lifecycle authority for shared resources. Never create independent
  lock maps or capacity counters in extracted services. Finite jobs retain
  their separate queue and state machine.
- Keep process termination limited to verified owned process trees. Preserve
  shell-free commands and resolve execution targets through Git discovery or
  an explicitly authorized worker contract, never arbitrary client paths.
- Keep logs, event delivery, scans, and retained history bounded. UI extraction
  must not multiply subscriptions or turn log events into repeated full Git
  scans. Resource ownership includes disposal and shutdown behavior.
- When implementing remote execution, separate durable project identity from
  machine registration and submitted verification from execution attempts.
  Introduce compatible contracts and explicit migrations in that feature's
  scope. Knowledge and coordination must remain independent of runtime claims
  and worktree lifetime. These are expansion constraints, not current features.

### Extraction workflow

Follow `RWK-20260905-service-ui-boundaries` in the backlog. Urgent runtime
reliability fixes retain priority. Extract the area needed by the next
implemented workflow in small, reviewable changes.

Keep `ControlService` as the public facade while delegating extracted
responsibilities. Put new feature families in cohesive modules rather than
expanding the facade, dashboard, or SQLite store.

Separate behavior-preserving moves from API, schema, or policy changes where
practical. This map does not require a repository-wide move, framework
migration, package split, or microservice conversion. Split by responsibility,
not file length. Follow the root `AGENTS.md` for verification and local guides.
