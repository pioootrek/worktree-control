---
audience: "people running Worktree Switcher and choosing how callers authenticate"
last_reviewed: "2026-09-26"
source_of_truth: "authentication modes, the auth CLI, and migration from legacy access"
status: "active"
---

# Authentication modes

One authentication policy applies to the dashboard, the HTTP API, live updates,
MCP and the online CLI. The controller stores the policy in its database and
applies the active mode to every request.

| Mode | Who uses it | Access |
| --- | --- | --- |
| `token` | New installations | One installation token authorizes every function, including knowledge |
| `open` | Explicit choice | No authentication; every caller has full access |
| `legacy` | Installations created before modes existed | Browser pairing token, MCP `mcp-token`, owner sessions for knowledge |
| `better-auth` | Reserved | Not available yet; selecting it fails with `auth_provider_unavailable` |

Scoped agent tokens and owner sessions from `identity` commands keep working in
`legacy` and `token` modes. A controller whose stored mode is unavailable
refuses to start; it never falls back to another mode.

## The `auth` command

```bash
worktree-switcher auth status
worktree-switcher auth token generate
worktree-switcher auth token rotate
worktree-switcher auth mode set <open|token|better-auth>
```

When the controller is stopped, the command opens the database under the
controller's singleton lock. When it runs, the command talks to it through an
owner-only Unix socket, `admin.sock` in the state directory. The socket is
`0600` inside a `0700` directory. A policy change takes effect at once. The
controller closes MCP sessions and live dashboard connections, and those
callers must authenticate again.

`token generate` and `token rotate` print the token once. The controller stores
only a hash; a lost token cannot be recovered, only rotated. Rotation
invalidates the previous token immediately. Save the token in a password
manager and keep it out of issues, logs and shared shell history.

There is no command to return to `legacy`.

## Use token mode

A new installation starts in `token` mode without a token. The controller
refuses to start until you run `auth token generate`.

- **Browser:** the dashboard asks for the token and keeps it for the browser
  tab's session. **Sign out** forgets it. `service open` and `service url` open
  the dashboard without a secret.
- **CLI against a running controller:** export `WORKTREE_SWITCHER_TOKEN`.
  Offline `project` and `auth` commands need no token.
- **Knowledge and identity administration:** `identity`, `knowledge` and
  `backup` project commands accept `WORKTREE_SWITCHER_TOKEN` when no owner or
  knowledge token is set. The installation token acts as the owner.
- **MCP:** send `Authorization: Bearer <token>`. `config mcp` prints a
  placeholder, or the real token when `WORKTREE_SWITCHER_TOKEN` is set.

## Use open mode

`open` removes authentication. Use it only on a trusted, single-user machine
with the controller bound to loopback. The dashboard shows a red **open mode**
badge and the controller prints its listening address on start.

```bash
worktree-switcher auth mode set open
```

## Move a legacy installation to token mode

1. Stop the controller and take a backup:
   `worktree-switcher service stop`, then
   `worktree-switcher backup create <directory>`, then
   `worktree-switcher service start`.
2. Generate the token and save it privately:
   `worktree-switcher auth token generate`. Token mode cannot be selected
   without it.
3. Switch the mode: `worktree-switcher auth mode set token`. The pairing link
   and `mcp-token` stop working immediately.
4. Sign in to the dashboard with the token in each browser.
5. Replace the bearer token in every MCP client with the installation token.
   Agents that use scoped `wts_` tokens need no change.
6. Export `WORKTREE_SWITCHER_TOKEN` where you run online CLI commands.

If a client still fails, run `auth status` to confirm the mode and the token
prefix. Rotate the token if it may have leaked.
