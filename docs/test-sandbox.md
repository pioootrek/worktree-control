---
audience: "authors of external test suites that exercise Knowledge or MCP against a real controller"
last_reviewed: "2026-11-13"
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
   `state` inside it. Like any data directory, its ancestors must not be
   writable by other users unless they are sticky, as `/tmp` is. A `TMPDIR`
   inside a group-writable directory is refused.
2. Offline, under that directory's controller lock: the token-mode installation
   token, one Knowledge project, one agent with the requested grant, and that
   agent's token.
3. The unchanged `start` command as a child process: `127.0.0.1` only, free
   ports, service mode, no browser, no backups, directory browsing limited to
   the sandbox directory. `WORKTREE_CONTROL_*` and `WORKTREE_SWITCHER_*`
   variables are removed from its environment, so the host installation's
   directories and tokens cannot reach it.

Like every controller, the sandbox controller also creates a root for per-run
temporary directories, `wtc-XXXXXX`, in the system temporary directory, next to
the sandbox directory and not inside it. It removes that root when it stops
normally. [Reservations and MCP](reservations-and-mcp.md) describes these
directories.

When the controller accepts requests, the command prints one JSON line on
standard output. It always uses standard output, also when standard output is
a pipe and standard error is a terminal. The controller's own output goes to
standard error. A stop requested before the controller is confirmed ready
prints no descriptor, so a descriptor always describes an instance that was
still meant to run.

The sandbox never pauses the controller's output pipes, because a controller
blocked on a full pipe would hang the instance under test. When standard error
is not being read and its queue is full, the sandbox discards the controller's
output instead of holding it and counts the discarded bytes. Once the reader
catches up it forwards output again and writes one line, for example
`Sandbox: dropped 33554432 bytes of controller output while standard error was
not being read.` Memory used for forwarding stays bounded however much the
controller logs. The last 8 KiB of controller output that startup failure
messages quote is kept separately and is not affected by dropping. A suite
that needs the controller's full log must read standard error continuously.

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
- a write to its standard output or standard error fails, for example with
  `EPIPE` because the test closed its reader. Nothing more is written to that
  stream;
- its standard input is a pipe or socket and fails with a read error, for
  example `ECONNRESET`;
- the controller exits on its own.

It stops the controller with one `SIGTERM`, then `SIGKILL` after 15 seconds.
Further `SIGTERM`, `SIGINT` or `SIGHUP` signals while it stops are ignored, so a
repeated Ctrl-C does not leave the controller or the directory behind. Before it
exits, the command waits up to 5 seconds for its remaining output to reach the
reader.

| Exit status | Meaning |
| --- | --- |
| 0 | Stopped on request: a signal or the end of standard input. This includes a request that arrives before the descriptor was printed. |
| 1 | Invalid options, the controller failed to start or exited on its own, a read from standard input or a write to standard output or standard error failed, or the controller could not be stopped (see below). The sandbox directory is removed. |

If the controller still has not exited 5 seconds after `SIGKILL`, the command
removes the directory anyway, writes `Sandbox controller <pid> did not exit
after SIGKILL.` to standard error and exits with status 1. Check that process
by hand: it may still be running.

A terminal or `/dev/null` on standard input never ends the sandbox. A sandbox
killed with `SIGKILL` cannot clean up: its controller keeps running and its
directory stays. Stop it with `SIGTERM` or close its input instead.

A controller that is killed cannot remove its `wtc-XXXXXX` root. This happens
when the sandbox has to send `SIGKILL`, and when a sandbox was itself killed
and its controller is killed later. The root stays in the system temporary
directory, and no later start removes it, because the record that names it was
in the sandbox directory. It holds one marker file, plus the directories of any
queued test runs that were active in the sandbox.

Other controllers of the same user keep roots with the same `wtc-` prefix in
the same place, including the installed one, so do not remove such directories
by name. To make leftovers unambiguous, start the sandbox with `TMPDIR` set to
a private directory that the suite created with `mkdtemp`. Both the sandbox
directory and the controller's root are then created inside it.

Remove that directory only when the controller is gone. An exit with status 0
confirms that. After status 1, read standard error first: `Sandbox controller
<pid> did not exit after SIGKILL.` names a controller that may still be
running. Removing the directory under a live controller deletes its root and
the temporary files of runs that are still active.

Each sandbox costs one controller process: about half a second to start and
roughly 150 MB of resident memory on Linux. Start one per test file or suite,
not one per test case.

## Using it from a suite

```js
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

// The controller's log goes to the inherited standard error; the descriptor is always on stdout.
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
await once(child, "exit");
```

An installed release without this command prints its list of available
commands on standard error and exits with status 1, without a descriptor and
without touching any installation. A suite can treat "exited before a
descriptor, and `worktree-control --help` does not list `sandbox`" as "sandbox
unavailable" and skip with a warning. Once a descriptor has been printed, a
failed request is a real incompatibility and should fail the suite.
