# MCP post-deploy observation — 2026-10-08

PR [#86](https://github.com/pioootrek/worktree-control/pull/86), deployed as
`5f791aef158d8db3c4288747f07ba0a170205770`, shows production idle and
abandoned-transport cleanup. Claim expiry, real client reconnect behavior and
memory impact remain unverified. The parent Knowledge task stays `in_progress`.

The [JSON report](mcp-post-deploy-20261008.json) contains the exact aggregates,
RSS readings, source snapshot hash and remaining acceptance criteria. Deployment
is independently recorded in Knowledge memory
`a7ef56d9-83dc-48d8-aef6-ce73b9888588` in project `k7a-worktree-switcher`.

The existing owner-only diagnostics sampler supplied 101 complete samples,
approximately two minutes apart. This read-only investigation did not induce a
claim, reconnect, client termination or service lifecycle change. The user-service
journal records the deployment start at 06:10:20 UTC, a stop at 06:43:38–39 UTC,
and a new start at 06:44:04 UTC. Counter totals must be read separately across
that restart; its cleanup is not attributed to session policy.

| UTC sample window | Samples | Logical session range | Closure counter increases |
| --- | ---: | ---: | --- |
| 06:12:05–06:42:02 | 16 | 1–9 | 9 abandoned-transport, 5 client-delete |
| 06:46:03–09:34:00 | 85 | 0–12 | 7 abandoned-transport, 3 idle-expired |

All sampled claims, renewal timers, automatic renewals, operations, initializing
sessions and draining sessions were zero. Fourteen samples in the second window
also had zero logical sessions and lifetime timers. Twelve of those formed an
uninterrupted sampled window at 08:36–08:58 UTC, away from the restart. These
gauges do not cover subscriptions or status waiters omitted by the sampler.
Short activity between samples can be missed.

Controller RSS was first retained by the existing sampler at 09:24 UTC. Six
readings through 09:34 UTC range from 137,388,032 to 194,547,712 bytes
(131.0–185.5 MiB), with session counts changing from 4 to 12. Knowledge calls
during this investigation contribute real client activity. This ten-minute
series does not establish savings, a plateau or a leak. Controller RSS is
separate from systemd cgroup memory and client/proxy RSS. The earlier 43-hour
peak of 208 sessions is a different workload and duration with intervening
restarts; it does not establish a causal reduction to the observed peak of 12.

Policy-enriched samples record a 15-minute claim-renewal idle deadline,
15-minute ended-session idle deadline, 60-minute open-session idle deadline,
60-second reconnect grace, 120-second drain, eight-hour absolute lifetime,
and admission limits of 64 global/32 per credential. Skipped renewals and
admission refusals were zero. Configuration confirms the deployed contract;
there was no observed claimed session to test its expiry behavior.

Completion requires evidence from normal owner use:

- A real claim with client/proxy name and version, qualifying activity and
  renewal/lease timestamps. A natural gap beyond 15 minutes must show renewal
  stopping; subsequent qualifying calls or explicit renewal reset that window.
- A naturally abandoned claim becoming available within the documented maximum
  of 45 minutes after last qualifying activity, with a later normal acquisition
  using its own session. Observe that the managed server continues and any
  accepted test job retains its independent lifecycle.
- A real transport interruption followed by a successful authorized reconnect
  within grace, and normal reinitialization after expiry, with ownership and
  actual outcomes recorded. Counters alone cannot establish these behaviors;
  uncertain mutations must not be replayed.
- Comparable warm controller RSS observations across ordinary work and cleanup
  on one uninterrupted process. Client/proxy RSS and liveness need separate
  observations if authorized; a longer uncontrolled series alone cannot prove
  causal savings.

No sampler timer, limits or guards were changed. Previously planned sampler
cleanup after 2026-10-10 remains outstanding. Evidence is appended to task
`48284853d99c88ae756dfb967a93e5de` and discussion
`23d44c27b8f10d6f14ca18d161f0c7b7` in `k7a-worktree-switcher`.
