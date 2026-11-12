---
audience: "authors of external test suites that exercise Knowledge or MCP against a real controller"
last_reviewed: "2026-11-12"
source_of_truth: "the worktree-control sandbox command and its descriptor format"
status: "active"
---

# Test sandbox

`worktree-control sandbox` runs a throwaway controller for one test suite. The
suite talks to it through the same `POST /api/knowledge` and `/mcp` endpoints
that production clients use, on its own empty database. It never reads internal
modules from the installed package, so a release that changes only internal
code or the CLI cannot break the suite.

```bash
worktree-control sandbox [--project-name NAME] [--permissions LIST] \
  [--ready-timeout-seconds N]
```

- `--project-name` names the one Knowledge project (default `Sandbox`).
- `--permissions` is the agent's comma-separated Knowledge grant (default
  `knowledge:read,knowledge:write`). It accepts the values listed by
  `identity grant-knowledge`.
- `--ready-timeout-seconds` bounds startup (default 30).

## What it starts

1. A private directory under the system temporary directory, with `data` and
   `state` inside it.
2. Offline, under that directory's controller lock: the token-mode installation
   token, one Knowledge project, one agent with the requested grant, and that
   agent's token.
3. The unchanged `start` command as a child process: `127.0.0.1` only, free
   ports, service mode, no browser, no backups, directory browsing limited to
   the sandbox directory. `WORKTREE_CONTROL_*` and `WORKTREE_SWITCHER_*`
   variables are removed from its environment, so the host installation's
   directories and tokens cannot reach it.

When the controller accepts requests, the command prints one JSON line on
standard output. The controller's own output goes to standard error.

```json
{
  "format": "worktree-control-sandbox/1",
  "version": "0.1.1",
  "pid": 12345,
  "url": "http://127.0.0.1:41234",
  "mcpUrl": "http://127.0.0.1:41235/mcp",
  "dataDirectory": "/tmp/worktree-control-sandbox-AbC123/data",
  "stateDirectory": "/tmp/worktree-control-sandbox-AbC123/state",
  "installationToken": "wsi_…",
  "project": { "id": "…", "name": "Sandbox" },
  "agent": { "principalId": "…", "token": "wts_…", "permissions": ["knowledge:read", "knowledge:write"] }
}
```

Check `format` before reading other fields. It changes only when the
descriptor changes incompatibly. The installation token acts as the owner of
every project: use it for owner-only operations such as approvals, and to
create more agents or projects through `/api/identity/admin`. Use the agent
token for everything a production agent would do.

These tokens exist only inside the sandbox database and stop working when the
sandbox ends. They are still secrets while it runs, so do not log the
descriptor.

## Stopping

The sandbox stops the controller, waits for it to exit and removes the whole
directory when any of these happens:

- it receives `SIGTERM`, `SIGINT` or `SIGHUP`;
- its standard input is a pipe or socket and reaches end of file, for example
  because the test process that holds the other end exits;
- the controller exits on its own. The command then exits with status 1.

A terminal or `/dev/null` on standard input never ends the sandbox. A sandbox
killed with `SIGKILL` cannot clean up: its controller keeps running and its
directory stays. Stop it with `SIGTERM` or close its input instead.

Each sandbox costs one controller process: about half a second to start and
roughly 150 MB of resident memory on Linux. Start one per test file or suite,
not one per test case.

## Using it from a suite

```js
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn("worktree-control", ["sandbox"], { stdio: ["pipe", "pipe", "inherit"] });
const [line] = await createInterface({ input: child.stdout })[Symbol.asyncIterator]().next().then(r => [r.value]);
const sandbox = JSON.parse(line);
if (sandbox.format !== "worktree-control-sandbox/1") throw new Error(`unsupported sandbox ${sandbox.format}`);

const response = await fetch(`${sandbox.url}/api/knowledge`, {
  method: "POST",
  headers: { Authorization: `Bearer ${sandbox.agent.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ operation: "projects", input: {} }),
});

child.stdin.end(); // stops the controller and removes its files
```

An installed release without this command prints its list of available
commands on standard error and exits with status 1, without a descriptor and
without touching any installation. A suite can treat "exited before a
descriptor, and `worktree-control --help` does not list `sandbox`" as "sandbox
unavailable" and skip with a warning. Once a descriptor has been printed, a
failed request is a real incompatibility and should fail the suite.
