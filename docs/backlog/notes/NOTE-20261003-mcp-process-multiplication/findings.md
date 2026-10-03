# MCP process multiplication across coding agents

Research date: 2026-10-03. This is an assessment and proposed direction, not an
approved implementation plan. No service, MCP configuration, resource limit or
credential was changed.

## Owner direction

On 2026-10-03 the owner requested preserving the analysis and said the feature
would probably be dropped, unless existing components make reuse worthwhile.
Treat implementation as deferred, with a conditional reason to revisit it.
This is not an approved roadmap item or authorization to install a gateway,
change process ownership, restart clients or change host limits. Keep this note
as research rather than create an implementation task.

Subsequent owner direction explicitly approved a narrower backlog follow-up:
[FIX-20261003-abandoned-mcp-sessions](../../fix/FIX-20261003-abandoned-mcp-sessions.json).
It covers Switcher's own inbound MCP session lifecycle and stale claim renewal.
The general proxy/supervisor implementation remains deferred; adding this fix
to the backlog does not authorize immediate runtime changes.

The process multiplication is a general consequence of local stdio MCP servers.
Client lifecycle bugs can add retained processes on top. The available evidence
does not establish a T3-specific leak or prove that our extra set was orphaned.

## Local evidence and its limits

The preceding host investigation reported three Codex processes, 33 local MCP
instances/proxies, 79 associated processes and approximately 4.1 GiB aggregate
PSS. T3's service accounting included its descendants. One older Codex process
had two MCP sets and two thread identifiers. Those observations explain the
counts but do not prove that either thread had finished or lost its owner.

The follow-up read-only inspection reported Codex CLI 0.159.0 and Claude Code
2.1.286. Neon, Worktree Switcher, Kinde development and Kinde staging proxy
families accounted for approximately 2042 MiB PSS. Direct HTTP makes that a
candidate saving, subject to installed-client authentication compatibility.
This is not a measured post-migration reduction. These measurements came from
the parent investigation; this research did not repeat the runtime sampling.

## What repeats elsewhere

The MCP stdio transport launches the server as a child process. Streamable HTTP
instead allows an independent process to handle multiple clients. Therefore,
independent clients using the same stdio registration normally create separate
server processes. More sessions, broad default registrations and retained npm
launchers can multiply the footprint without any leak. Separate HTTP sessions
and TCP connections do not imply separate server processes.
[Protocol transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

Codex issue #25015 describes a controlled Ubuntu app-server reproduction using
version 0.128.0. MCP subprocesses remained after subagents finished and were
closed. This is a report from another installation, not reproduction on our
installed version. Codex also merged a separate shutdown fix in PR #19753 on
2026-04-28. Treat these as evidence of a recurring defect class, with fixes that
have specific scopes.
[Reported reproduction](https://github.com/openai/codex/issues/25015),
[merged shutdown fix](https://github.com/openai/codex/pull/19753).

Claude Code's official changelog records fixes for MCP list/get orphan servers
in 2.1.6, stdio timeout child cleanup in 2.1.15, and Windows VS Code orphan MCP
servers in 2.1.153. This confirms lifecycle bugs outside T3 and Codex, without
claiming those historical bugs remain in the installed 2.1.286.
[Claude Code changelog](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md).

Both clients document direct HTTP MCP connections. Claude's tool search defers
tool definitions in model context; that alone does not establish deferred
process startup. T3 describes itself as a control interface around coding
agents. Its aggregate service footprint therefore needs attribution among T3,
agent runtimes and their children before assigning responsibility.
[Codex MCP](https://developers.openai.com/codex/mcp),
[Claude Code MCP](https://code.claude.com/docs/en/mcp),
[T3 repository](https://github.com/pingdotgg/t3code).

## Recommended system design

The user's clarified goal is an automatic, repeatable supervisor across clients,
not a one-off cleanup. The target is an independent MCP runtime service with a
registry of server instances, client sessions, owners, leases and active calls.
Codex, Claude Code and T3 connect through native HTTP or small client adapters.
This is a proposed architecture, not an existing Worktree Switcher feature.

The runtime reconciles desired and observed state. It distinguishes configured,
starting, ready, busy, idle, draining, stopped and failed instances. An expired
owner lease is evidence to inspect, not unconditional permission to kill.
Automatic cleanup also needs a verified ownership contract, settled work and
an explicit policy allowing loss of retained session state. Sending a cancel
notification alone does not prove that an operation has stopped.
Inactivity alone does not prove abandonment; a live parent app-server does not
prove that every child thread still owns its MCP instance. A client integration
must supply reliable ownership and session-close signals. A heartbeat from a
forgotten proxy would otherwise preserve the very leak the supervisor should
remove.

- Start executors on demand. Discover tools separately from execution where
  trustworthy versioned metadata is available.
- Share only servers whose state and authentication support multiple clients.
  Partition by identity, authorization, project roots, working directory and
  environment; use isolated leased processes for session-specific browser state.
- Reconcile duplicate starts under one ownership lock. Reclaim only verified
  owned processes, never a process selected by name or port alone.
- Drain active calls before idle shutdown. Recover transient faults with bounded
  retries and backoff; stop retry storms for authentication or configuration
  failures and expose the required operator action.
- Admit work against explicit per-server and total budgets. Report PSS, process
  counts, sessions, owners and cleanup decisions. Existing host limits remain
  unchanged without separate authorization.

A proposed automatic policy maps observed conditions to bounded actions:

| Condition | Action |
| --- | --- |
| Owner has released its lease, or its agreed lease has expired; work settled; retained state disposable | Drain and stop the verified owned process tree. |
| Executor unhealthy; work settled; restart allowed by its state policy | Restart within a retry budget, then quarantine on repeated failure. |
| Capacity exhausted | Queue or reject new work; preserve active calls. |
| Repeated authentication/configuration failure | Open the circuit, suppress retries and report the required correction. |
| Idle and explicitly restart-safe | Stop after the idle lease expires; recreate on next use. |

Direct HTTP to existing services is one execution mode in this design. Managed
stdio executors are another. Pinned direct executables reduce launcher overhead,
but do not provide supervision or cross-client sharing on their own.

MCP HTTP security guidance requires origin validation and recommends local
binding and authentication. Its security guidance also warns about session
hijacking and forwarding tokens without proper validation. Sharing a process
must preserve client identity and authorization; sharing credentials across
unrelated sessions is not a resource optimization.
[Transport safeguards](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[security guidance](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices).

## Existing gateways do not guarantee deduplication

Docker MCP Gateway already offers lifecycle management, profiles, on-demand
container launch and HTTP transport. Its CLI exposes memory/CPU settings and a
long-lived mode. It is a candidate to evaluate, not evidence that all our
servers can become one instance each.
[Gateway documentation](https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/),
[CLI options](https://docs.docker.com/reference/cli/docker/mcp/gateway/run/).

At Docker Gateway commit `a34df45d4ec0e941a9853ad768c4f6cd818966b3`,
`AcquireClient` keys cached long-lived clients by server name and client
session. Sharing one gateway therefore does not itself share those upstream
clients across sessions. MetaMCP commit
`250240be7da37e3f21d53eaa66afac5eee775aa5` similarly stores active connections
by session and server; consuming an idle connection triggers another prewarm.
That pool reduces startup latency and can still retain multiple processes.
[Docker client pool](https://github.com/docker/mcp-gateway/blob/a34df45d4ec0e941a9853ad768c4f6cd818966b3/pkg/gateway/clientpool.go#L71-L140),
[MetaMCP connection pool](https://github.com/metatool-ai/metamcp/blob/250240be7da37e3f21d53eaa66afac5eee775aa5/apps/backend/src/lib/metamcp/mcp-server-pool.ts#L72-L127).

A useful acceptance experiment would compare one, three and several concurrent
clients, then repeated close/reopen and crash cycles, using the same enabled
servers and tools. Measure host-wide PSS, subprocess counts, startup latency and
return to baseline after leases expire. Include separate identities and roots.
Moving processes out of T3's cgroup alone would change accounting, not reduce
host memory. No such migration or reproduction experiment ran in this research.

## Fit inside Worktree Switcher

An optional MCP proxy and supervisor could fit the product's process-management
direction. Existing foundations include owned process groups, Linux resource
sampling, runtime lifecycle coordination, authentication, SQLite and a static
dashboard. Relevant code is `src/server/owned-process-group.ts`,
`src/server/resource-monitor.ts`, `src/server/modules/lifecycle/` and
`src/server/mcp-runtime.ts`. The current MCP endpoint exposes Switcher's own
operations; it does not proxy arbitrary upstream servers.

The proposed module would expose MCP to clients, connect to upstream servers,
track frontend/backend sessions and active work, and supervise only local
processes it owns. A separate logical state machine is necessary for MCP
instances; reuse existing coordination and process adapters rather than invent
another competing owner. Preserve the single controller/database owner.
An optional external proxy would be a separate deployment decision, not an
automatic change to the single-controller architecture.

In-path proxying provides reliable attribution of requests that pass through it
and lets the controller stop admitting new work before draining an instance.
It does not reveal an agent's future intent, make every server shareable, or
turn a session identifier into authorization. Account, project-root, working
directory and state boundaries still apply. Traffic that bypasses the proxy
remains outside this ownership model.

## Consequences of accidentally stopping a used instance

An interrupted read can usually be retried. An interrupted write may have
succeeded remotely while its response was lost; blindly replaying it can
duplicate side effects. Browser state and other in-memory session state may
be lost. Stopping a shared instance can affect several agents. A restarted
transport therefore does not prove that the original work recovered.

No active requests is not proof that retained state is disposable. Pending
background work and subscriptions also matter. A connection loss is not
cancellation, and cancellation is not a rollback. These distinctions must be
visible in recovery status and tested before automatic stopping is enabled.
[MCP connection and session semantics](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[MCP cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation).

## Indicative implementation effort

The conversation estimated 2-4 focused engineering days for a single-client,
single-backend prototype; 2-4 weeks for a bounded useful version with selected
MCP servers, isolated sessions, owned processes, safe shutdown and basic UI;
and several additional weeks for broader client compatibility, authentication,
recovery and selective sharing. These assume an engineer familiar with the repo
using agent assistance. They are planning estimates, not measured throughput,
a commitment or an estimate for universal transparent compatibility.

The main uncertainty is lifecycle correctness: races between new requests and
shutdown, distinguishing unknown write outcomes, client/subagent ownership,
controller restart, and forwarding protocol features beyond tool calls.
Ready proxy components can reduce protocol implementation work. They do not
justify reducing the whole estimate before testing their lifecycle behavior.

## Reusable components checked on 2026-10-03

| Component | Reusable capability | Fit and remaining work |
| --- | --- | --- |
| FastMCP Proxy Provider, Python | `create_proxy`, transport bridging, aggregation, protocol-feature forwarding and configurable backend clients | Substantial ready proxy layer, but adds Python if used as an external service. Session/lifecycle policy and host supervision still need design. |
| Supergateway, Node.js CLI | stdio/HTTP bridges, session timeout, shutdown handling, parent-liveness option | Close runtime fit for a separate managed proxy. Its inspected package exposes a CLI, not a documented library export. Isolation retains per-session processes. |
| Docker MCP Gateway | Container lifecycle, profiles, credentials and resource controls | A runnable external gateway, not a small module inside the Node controller. Session-keyed pooling is not global deduplication. |
| Official TypeScript MCP SDK | Clients, servers, transports and connection cleanup | The repo already declares SDK 1.30.0. Current v2 documentation describes newer APIs; it is not a drop-in migration or a ready supervisor. |

FastMCP documents fresh backend sessions per request by default and warns that
sharing an already-connected client can mix context. Its configurable client
factory permits different session policies. Lazy proxy construction does not
mean the backend starts only on a tool call: negotiation and discovery can
contact it. No universal orphan detector or resource supervisor was established
by these docs.
[FastMCP Proxy Provider](https://gofastmcp.com/servers/providers/proxy).

Supergateway's inspected `main` package reports 4.1.0. Its changelog records
idle expiry for stateful HTTP sessions in 4.0 and cleanup/reconnect improvements.
In 4.1, SSE and WebSocket connections receive separate server processes, as
stateful HTTP sessions already did. Reconnect can lose in-memory backend state.
Those are useful lifecycle mechanisms but not cross-agent process sharing.
The README documents `--exitWithProcess`; parent liveness still cannot identify
a finished subagent within a live app-server. These are documentation/source
findings, not a runtime compatibility test or confirmation of a published
package's installed version.
[Supergateway README](https://github.com/supercorp-ai/supergateway),
[changelog](https://github.com/supercorp-ai/supergateway/blob/main/CHANGELOG.md),
[package entry points](https://github.com/supercorp-ai/supergateway/blob/main/package.json).

The TypeScript SDK provides protocol building blocks. Its v2 client documentation
describes connection and stdio cleanup; it does not establish an application-level
supervisor with agent ownership and recovery policy.
[TypeScript SDK clients](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect).

TBXark MCP Proxy is another external aggregation candidate. Its documented
timeouts and keepalive do not establish transparent recovery: the configuration
guide notes that a stalled shared stdio backend can become unavailable to all
callers until proxy restart. It was not selected for integration.
[TBXark configuration](https://github.com/TBXark/mcp-proxy/blob/master/docs/CONFIGURATION.md).

## Revisit criteria

Keep custom implementation deferred. Revisit only if a pinned existing component
passes a small compatibility experiment with our actual clients and selected
servers: start/close/crash cycles, reconnects, unknown write outcomes, state
isolation and stable host-wide memory. Evaluate the component's own lifecycle
first; wrapping it in Switcher does not repair those semantics automatically.
Nothing was installed or benchmarked during this assessment, and no ready
component was confirmed to satisfy the complete automatic-supervision goal.

## Follow-up: Switcher's own MCP and inbound agent connections

A read-only sample at approximately 22:38 local time on 2026-10-03 found one
controller process at roughly 142 MiB RSS. Four agent-side `mcp-remote` workers
had eight established TCP connections to the MCP listener. Their worker,
shell and npm launcher groups summed to approximately 454 MiB PSS, excluding
the Codex parents. These are connection/process counts, not an exact count of
logical sessions or in-flight calls. They are a later sample than the figures
above and must not be combined into one simultaneous measurement.

The shared MCP catalog declares Switcher as a stdio proxy; the active Codex
registration invokes `agent-mcp-worktree-switcher`, which starts
`npx mcp-remote@0.8.2`. Each such client registration creates local bridge
processes even though the real Switcher MCP server is already HTTP. Removing
a bridge after compatibility verification could reduce client overhead; this
does not require adding a gateway inside Switcher.

A temporary authenticated diagnostic connection successfully initialized,
listed 29 advertised tools and ended its own session with HTTP DELETE (200).
No operational tool was called and no existing session was terminated.
The server reported `0.1.0-trial.1`; inspected installed release `a727fd8`
contains the same eight-hour lifetime and claim-renewal logic discussed below.
The session's agent tool catalog did not expose Switcher's tools, so live
inspection used a bounded protocol probe without printing credentials.

The controller creates an in-memory `McpServer`/transport per MCP session,
not an OS process or database connection per agent. In `src/server/mcp-runtime.ts`
the session has an absolute eight-hour lifetime. Transport closure removes it
from the registry, clears timers and disposes runtime-operation bookkeeping.
There is no explicit session-count cap or client-activity timeout in the
inspected session-creation path. The operation-entry limits (64 per session,
512 globally) are distinct from a session admission limit.

Claim renewal is driven by a server timer while the MCP session exists.
Stream closure is not necessarily session closure; the inspected SDK's SSE
cancel path removes the stream mapping without closing the transport, whereas
DELETE closes the session. Consequently, a vanished client that does not end
its session can potentially leave claim renewal running until the absolute
session lifetime ends, followed by the remaining claim TTL. This is a code-based
failure-path finding, not a reproduced orphaned claim in the running system.
The statement in `docs/reservations-and-mcp.md` that claims expire if the client
disappears needs qualification against these actual session semantics.

This narrower issue is independent of the deferred general gateway proposal.
Any future correction should specify client liveness, a reconnect grace period,
when automatic renewal stops, session admission bounds and active-call handling
at absolute expiry. It must preserve the existing rule that reservation expiry
or release does not stop a managed development server. Do not equate a missing
TCP connection with permission to kill a runtime or abandon a pending write.
