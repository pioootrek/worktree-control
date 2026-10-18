---
audience: "maintainers publishing Worktree Control to MCP directories"
last_reviewed: "2026-10-18"
source_of_truth: "official MCP Registry manifest, directory submission steps and listing copy"
status: "active"
---

# MCP registry and directory listings

Worktree Control is distributed as the npm package `worktree-control`. The
[`server.json`](../server.json) manifest at the repository root describes it
for the official MCP Registry. Every step below is an owner action. Directory
rules were checked on 2026-10-18 and change often, so recheck each page before
submitting.

## What the manifest declares

The registry entry points clients to the npm package. The package runs a local
controller; it has no stdio transport and no public remote endpoint. The
manifest therefore declares a package with a local `streamable-http`
transport:

- command: `worktree-control start --no-open --host 127.0.0.1 --mcp-port 47832`,
  where `--no-open` stops each client launch from opening a browser tab and
  the fixed `--host` keeps the dashboard off the CLI default `0.0.0.0`;
- endpoint: `http://127.0.0.1:{--mcp-port}/mcp`, always on loopback;
- header: `Authorization: Bearer <token>`, using the installation token or a
  scoped agent token. Open mode needs no header.

`worktree-control config mcp` prints the same URL and header. Two limits apply
to clients that launch the package themselves:

- Only one controller can own an installation's data directory. If the user
  service already runs, a second controller started by the client does not
  start. Those users should put the output of `worktree-control config mcp`
  in the client's private MCP configuration instead.
- On a new token-mode installation, a controller started without an
  interactive terminal refuses to start rather than print the installation
  token to a log. MCP clients start the package without a terminal, so the
  first client-launched start fails until the user runs
  `worktree-control auth token generate`.

## Publish to the official MCP Registry

The registry checks the `mcpName` field of the published npm version.
`package.json` has carried it since this guide was added, but
`worktree-control@0.1.1` was published without it. A registry publish of
`0.1.1` fails ownership verification. The registry guide offers no other route
for an npm package, so publish the next npm release first.

1. Release the next version through the usual release PR and
   [publish the CI tarball](package-trial.md#publish-a-release). Confirm that
   npm has the field:

   ```bash
   npm view worktree-control@<version> mcpName
   ```

   The command should print `io.github.pioootrek/worktree-control`.
2. In `server.json`, set both `version` and `packages[0].version` to that
   release and merge the change.
3. Install `mcp-publisher` as described in the registry's
   [quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx).
   On Linux or macOS, either run `brew install mcp-publisher` or download the binary:

   ```bash
   curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
   ```

   Each release publishes `registry_<version>_checksums.txt` for verification.
4. From the repository root on the merged commit:

   ```bash
   mcp-publisher validate
   mcp-publisher login github
   mcp-publisher publish
   ```

   Sign in as `pioootrek`. GitHub authentication only grants the
   `io.github.pioootrek/` namespace to that account.
5. Verify the listing:

   ```bash
   curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.pioootrek/worktree-control"
   ```

The registry is in preview and may reset data before general availability.
Publish again after each release that changes the manifest. The registry also
documents
[publishing from GitHub Actions](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/github-actions.mdx);
that workflow is not configured here.

## Directory listings

### MCP Market

- Submit at <https://mcpmarket.com/submit>.
- Choose **MCP Server** with **GitHub repo**, and enter
  `https://github.com/pioootrek/worktree-control`.
- Choose **Free Queue**. The page states a 4–6 week listing time. The
  **Try Now** link is part of the paid option only.
- MCP Market indexes the Agent Skill in `skills/worktree-control/` without a
  separate submission.

### Glama

- Glama already lists the repository at
  <https://glama.ai/mcp/servers/pioootrek/worktree-control>. The unclaimed
  listing still shows the old name `worktree-switcher` and says that the server
  cannot be deployed.
- Sign in with the `pioootrek` GitHub account and select **Claim**. A personal
  repository needs no `glama.json`; that file is for organization-owned
  repositories.
- The awesome-mcp-servers list requires a Glama score badge. Its PR check says
  Glama needs a Dockerfile added on Glama and a server that starts and answers
  MCP introspection. Whether Glama's check can reach the loopback endpoint and
  send the bearer token has not been tested.

### PulseMCP

- <https://www.pulsemcp.com/submit> states that PulseMCP is not accepting new
  submissions. It recommends publishing to the official MCP Registry and says
  PulseMCP will pick entries up from there when it reopens.
- No action is needed beyond the registry publish. Recheck the page later.

### Smithery

- Smithery publishes either a public HTTPS Streamable HTTP URL or a
  stdio MCPB bundle; see <https://smithery.ai/docs/build/publish>. The
  submission page is <https://smithery.ai/new>.
- Worktree Control has neither: its endpoint is local and loopback-only. Do not
  submit a `127.0.0.1` URL. Revisit Smithery once a public endpoint or an MCPB
  bundle exists.

### awesome-mcp-servers

- Open a pull request against
  <https://github.com/punkpeye/awesome-mcp-servers> after the Glama listing has
  a score; the list's PR check labels entries without the badge as
  `missing-glama`.
- Follow its
  [contributing guide](https://github.com/punkpeye/awesome-mcp-servers/blob/main/CONTRIBUTING.md):
  edit `README.md` only, one server per line and alphabetical order within
  the category. The link text must be `owner/repo`, and only the legend's
  emoji are allowed.
- Category: **💻 Developer Tools**. Entry:

  ```md
  - [pioootrek/worktree-control](https://github.com/pioootrek/worktree-control) [![pioootrek/worktree-control MCP server](https://glama.ai/mcp/servers/pioootrek/worktree-control/badges/score.svg)](https://glama.ai/mcp/servers/pioootrek/worktree-control) 📇 🏠 🐧 - Local control plane for coding agents: claim and switch one dev server per project between Git worktrees on a stable port, queue tests against a chosen worktree and keep tasks and decisions in shared project memory.
  ```

  The emoji mark TypeScript, a local service and Linux. macOS and Windows are
  unverified and left out.

## Listing copy

Reuse this copy wherever a directory asks for a description.

**One line (118 characters):**

> Switch dev servers between Git worktrees on stable ports, with MCP claims, a test queue and project memory for agents.

**Long description:**

> Worktree Control switches a project's development server between Git
> worktrees without changing its port, and switching one project leaves the
> others alone. Coding agents claim a project over MCP before they start or
> switch its server; claims expire, and an agent cannot release someone else's.
> A shared queue runs test, lint, typecheck and build presets against a chosen
> worktree and shows which code each run checked. Knowledge keeps tasks,
> discussions and decisions in one place for humans and agents, through the
> dashboard, MCP and CLI. It runs on your machine with SQLite,
> needs no hosted account and is MIT licensed; Linux is verified, while macOS
> and Windows are not.

**Registry description (`server.json`, 100-character limit):**

> Claim and switch dev servers between Git worktrees on stable ports, queue tests, keep project memory

## GitHub repository description

The current description predates the rename and leaves out tests and project
memory. Proposed replacement (152 characters):

> Local control plane for coding agents: switch dev servers between Git worktrees on stable ports, with MCP claims, a test queue and shared project memory

```bash
gh repo edit pioootrek/worktree-control --description "Local control plane for coding agents: switch dev servers between Git worktrees on stable ports, with MCP claims, a test queue and shared project memory"
```
