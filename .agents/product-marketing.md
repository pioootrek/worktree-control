# Product marketing context

Document version: v1
Last updated: 2026-09-11

## Product and audience

Worktree Control coordinates development servers and finite verification across
Git worktrees for developers and their MCP-capable coding agents. The current
product is an MIT-licensed, source-installed local controller with a browser
panel, CLI, MCP tools and SQLite. Node.js and Django are supported. Primary users
already use worktrees and need humans and agents to share server ownership and
limited machine resources.

The immediate job is to keep each project's port stable, reserve its active
worktree and retrieve test evidence through the existing coding client. Position
MCP ownership and managed verification near the top; server switching alone does
not explain the product's full purpose. The ordinary alternative is manual
terminal/process management and conventions between humans and agents. No
competitor superiority or measured time savings have been established.

## Direction and release boundary

Owner direction is complete self-hosting plus an optional maintainer-operated
SaaS, initially with customer-owned workers. Source fetching to an exact pushed
commit belongs to the remote-verification roadmap. On baseline main `9d2aa60`,
HTTPS, local test queue, source attribution, compact MCP status and CLI project
management are implemented. PRs 28–31 landed on a separate remote implementation
branch, not main; their foundations are not an end-to-end available feature.
Recheck this distinction before future copy changes.

No hosted signup, pricing, npm release, broad customer adoption or named-client
compatibility certification is established. There are no customer testimonials or
measured productivity claims to publish. Linux has the principal runtime evidence;
macOS service lifecycle and Windows support must not be overstated.

## Voice and conversion goal

Write English README copy for developers. Use concrete tasks, short setup steps
and accurate examples. Say Git worktrees, dev servers, MCP claims, test queue,
self-hosted and exact commit when appropriate. Avoid generic AI productivity
claims and describing planned SaaS capabilities as available today.

Primary action: install from source, add one repository and try a switch or test
run. Secondary action: connect an MCP client and report the actual workflow via
a GitHub issue. An example-data screenshot demonstrates the UI, not customer use.

The owner reports low discovery. GitHub traffic read on 2026-09-11 showed 112
views from 3 unique visitors and 734 clones from 205 unique cloners in the available
14-day window. Automated clones/reviews may contribute; these are not customer
or conversion counts. Acquisition channels and installation retention are unknown.
A README change alone is not evidence of increased discovery or adoption.

## Changelog

- v1 (2026-09-11): Established audience, current main versus remote-branch claims,
  self-hosted/SaaS direction and a source-install conversion goal for README work.
