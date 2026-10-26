# Angular cross-host acceptance

The finite Angular trial completed on two Linux machines on 2026-10-26. It
exercised failed/fixed commits, real disconnection, offline cancellation and
terminal replay through an actual MCP SDK client. Controller-crash, reboot
and general customer acceptance remain open. Angular replaced the earlier
WinPath target. This document records the result and the reusable procedure.
The parent owns publication, infrastructure, foreground processes, serial
verification and Knowledge writes.

## Fixed inputs and boundaries

- Merged WTC product baseline: `681c0c1a763cb7e2659c35755fdbf696e90cb77a`.
- Validated WTC source and acceptance tooling:
  `bb56f485ac75481297a3dcf3aa5688f459576a1f`, based on that product baseline.
  Use the same reviewed WTC revision and matching built CLI/assets on both hosts.
- Angular baseline: `a5cea6ea5a19ab07ad24bb780738a8f81513d8be`.
- Failing Angular SHA: `f3055ed4bc5e401b8e5bd8c6004ae6171471802b`.
- Fixed Angular SHA: `f6fbceed97875ab5d13755b37020599d5c185ff8`.
- Failed/fixed preset: `node:test:remote`. It imports installed RxJS and checks
  `[2, 4, 6]`; the failing commit deliberately expects `[2, 4, 7]`.
- Disconnect/cancel preset: `node:test:remote:slow` at the fixed SHA. Its two
  owned processes run for about 120 seconds without cancellation. It accepts
  no release paths, external PIDs or secrets.

The source Angular checkout, its untracked instruction files, the Django fixture,
and both hosts' production WTC installations stayed outside the trial. The
parent published the reviewed Angular tracked baseline and test branch to a
private repository; both fixture commits were reachable. No dependency versions
or lock/workspace policies were changed. Node engines metadata is not required
by the worker policy. Existing `allowBuilds` and `onlyBuiltDependencies` settings
remained; actual frozen dependency installation passed with `scripts: "ignore"`
and the test imported installed RxJS.

The scripts invoke the real CLI's offline owner bootstrap, project registration,
remote grants and runtime bootstrap. The CLI owns each database, queue, worker,
transport and process tree. The audit takes that installation's singleton lock
only after shutdown and uses public store/recovery APIs. It does not implement a
second queue or worker protocol and never signals a PID from a file.

## Completed trial evidence

The trial used Node **24.19.0**, genuine pnpm **11.22.0**, and matching built
artifact SHA-256 `98bcbe2fb1d39d6b2bc5754fcf961bf834312ed58466aef398587dff1e817365`
on both machines. Results belong to WTC revision `bb56f48` above; later
revisions do not inherit that execution provenance. The private
manifest and per-case evidence were checked against Knowledge project
`k7a-worktree-switcher`, thread `4aa80e3623977202ad6fa9a39dfbb170`, completion
reply `f7c90101-30e3-4b1e-b7d5-a7b17f797474`.

- The failing Angular SHA returned a real assertion failure, exit **1**;
  the fixed SHA returned exit **0**. Both reported `observed_match` for their
  exact requested SHA, with identical preset and environment fingerprints.
- During the real tunnel cut, the broker reported `executionUncertain` while
  the test was running. The interruption lasted over four minutes, longer than
  the intended roughly 40 seconds. The finite test completed offline, and its
  same result arrived after reconnect. This covers eventual result delivery;
  it does not demonstrate reconnect before completion or lost-ACK injection.
- A separate cancellation intent was durably accepted while disconnected.
  The tunnel was restored while the test was still active. Cancellation
  delivered SIGTERM before natural completion and stopped both owned fixture
  processes, including the descendant.
- All four terminal replays retained the original request, attempt, local run
  and result. The stopped worker audit found exactly **4 receipts and 4 runs**,
  one execution per case, final sequence **3** acknowledged for every case,
  exact SHAs/fingerprints and matching signed provenance. Cleanup was confirmed,
  no fixture process was executing, and the workspace root was empty. Both
  controller exits were **0**, with no shutdown timeout; the broker audit passed.

The initial `r1` setup was refused before Git/test execution because the cloned
cache directory was group-writable (`0775`). Its result was `preparation_failed`,
with no executed SHA and confirmed cleanup. It is separate from the deliberate
assertion failure. Only disposable clone directory modes were corrected to
`0700`, and the trial process umask was set to `022` for fresh `r2` installations.
No host permission policy was changed and no uncertain-state recovery was used.

After the audits, both `r1` and `r2` trial installations and their secrets were
removed. The owned tunnel stopped; the trial repository deploy key was revoked
and its absence verified. Source checkouts and tool distributions were retained.
Evidence includes per-case wait/replay records, network events, the setup
refusal, both audits, source-checkout observations and teardown confirmation.
Keep these files private: even allowlisted JSON includes infrastructure identity.
Publish only a sanitized summary such as this one, never raw evidence or logs.

The SDK client exercised the disposable broker's four remote tools. The
interactive T3 MCP connection was not repointed or validated. No controller
crash/reboot, resource benchmark or whole-feature completion is claimed.
Manual provisioning and tunnel management remain part of this procedure.

## Parent prerequisites

Prepare these before starting either foreground process:

1. Preinstalled Node **24.19.0**, genuine pnpm **11.22.0** distribution, Git and
   Linux `/proc`. The worker's `pnpmEntryPoint` is the real executable
   `pnpm/bin/pnpm.mjs`, not Corepack or a shell wrapper. The acceptance scripts
   and WTC source dependencies must be available on each host: the MCP driver
   imports the existing SDK; the stopped audit needs the existing `tsx` loader
   and SQLite native module for the pinned Node ABI. Do not bootstrap these
   through the trial. Parent validation/build uses supported serial commands.
2. A reviewed WTC CLI with its static `out` assets, from that same revision.
   The scripts do not build or install WTC. Record its revision/artifact digest
   in the parent's trial notes; the constant above alone is not build provenance.
3. An owner-only input JSON on each host. Choose previously absent absolute
   trial roots with basenames `wtc-remote-acceptance-<unique-id>`. All parent
   directories must already exist and resolve without symlinks. Keep the JSON,
   raw logs, tokens, Git credential files, certificates and keys outside Git.
4. Distinct unused loopback ports for trial HTTP, MCP and the broker's worker
   listener. Never take an occupied port or change a managed production server.
   Registration uses launch preset `none`; no development server is started.
5. A trial TLS certificate with an IP SAN for `127.0.0.1`, its private key and
   CA. Bind the broker worker listener only to loopback. The parent creates a
   private reverse SSH tunnel so worker loopback HTTPS reaches that listener,
   retaining the certificate's valid IP SAN. Transfer the CA and set its path
   in the worker input. No public listener, insecure TLS option, HTTP fixture
   exception, SSH agent forwarding or host service change is needed.
6. Private repository read authentication usable by **Git under the worker's
   clean environment**. Runtime setup resets HOME per attempt, sets
   `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`,
   `GIT_TERMINAL_PROMPT=0` and does not inherit SSH sockets or controller tokens.
   A token-free HTTPS origin plus a repository-local credential helper pointing
   to a trial-owned `0600` file can satisfy this. Configure
   `credential.useHttpPath=true` and a helper restricted to this repository.
   Git's built-in `store --file=<private-file>` needs no custom code; the parent
   privately provisions a repository-scoped read credential in that file.
   Avoid broad credentials, URL-embedded credentials, global Git configuration
   and assumptions about the operator's normal HOME. This runs trusted code
   under the operator's UID, not in a credential-isolating sandbox.
7. Public registry access for the committed Angular dependency graph. Setup
   uses a fresh store/HOME, frozen lockfile, `scripts: "ignore"`, no runtime or
   package-manager download, and a ten-minute preparation deadline. Registry
   failures are setup failures and cannot count as the deliberate failed test.
8. Owner-only (`0700`) disposable `repository` and worker `cache` directories,
   owned by the trial user, with canonical paths and no symlink components.
   Inspect the clones after creation; Git may create a clone directory as
   group-writable under the invoking umask. Recovery provenance refuses unsafe
   group/other-writable path components before execution. Use a process-local
   `umask 022` for trial commands and correct only the exact disposable clone
   directories to `0700` when needed. Do not use recursive chmod or change host
   policy. If an ancestor is unsafe, choose a compliant trial parent rather
   than changing an unrelated directory.

Transport supports a real external MCP caller. The four remote tools appear only
when the broker is started with its explicit remote configuration. The existing
production MCP connection is not repointed. The driver below is a real SDK client
of the disposable broker, not a direct application-service call. To demonstrate
the user's existing interactive client too, add a separate temporary MCP
connection to the broker's loopback endpoint with its private owner credential;
confirm the same tool list and retain that client's calls separately. No T3
integration or currently connected tool catalog is claimed by this script.

## Initialize and provision

Run commands from the reviewed WTC checkout. In the examples, `trial_node` is
the absolute pinned Node executable, `trial_root` is the root on the current
host, and `trial_config` is that host's private input JSON. Set variables on
each host explicitly. Paths below are placeholders to replace, not defaults.

Broker input:

```json
{
  "role": "broker",
  "root": "/absolute/parent/wtc-remote-acceptance-broker-UNIQUE",
  "nodeExecutable": "/absolute/tools/node/bin/node",
  "cliEntry": "/absolute/reviewed-wtc/dist/cli/index.js",
  "webRoot": "/absolute/reviewed-wtc/out",
  "repositoryPath": "/absolute/parent/wtc-remote-acceptance-broker-UNIQUE/repository",
  "port": 49131,
  "mcpPort": 49132,
  "remotePort": 49133,
  "keyFile": "/absolute/private-tls/server.key",
  "certFile": "/absolute/private-tls/server.crt"
}
```

Worker input:

```json
{
  "role": "worker",
  "root": "/absolute/parent/wtc-remote-acceptance-worker-UNIQUE",
  "nodeExecutable": "/absolute/tools/node/bin/node",
  "cliEntry": "/absolute/reviewed-wtc/dist/cli/index.js",
  "webRoot": "/absolute/reviewed-wtc/out",
  "repositoryPath": "/absolute/parent/wtc-remote-acceptance-worker-UNIQUE/repository",
  "port": 49231,
  "mcpPort": 49232,
  "origin": "https://127.0.0.1:49233",
  "caFile": "/absolute/private-tls/ca.crt",
  "pnpmEntryPoint": "/absolute/tools/pnpm/bin/pnpm.mjs",
  "sourceCachePath": "/absolute/parent/wtc-remote-acceptance-worker-UNIQUE/cache",
  "workspaceRoot": "/absolute/parent/wtc-remote-acceptance-worker-UNIQUE/workspaces"
}
```

The example tunnel forwards worker `127.0.0.1:49233` to broker
`127.0.0.1:49133`; the parent chooses the SSH target and owns the tunnel.
Input JSON must be `0600`. On each host:

```bash
"$trial_node" scripts/remote-worker-acceptance.mjs init --config "$trial_config"
```

The parent now creates independent, ordinary Git clones in each root's
`repository` directory. The worker additionally needs an independent clone in
`cache`, a sibling of `repository` and `workspaces`. Use the pushed private
remote as named `origin`, not a local working tree or linked worktree. Keep
the failed/fixed commits reachable on the pushed test branch. The parent
provisions fetch authentication for `cache` and verifies it with the clean
environment described above. No trial script creates or publishes a Git remote.
Check both clones' ownership, modes and canonical paths against prerequisite 8
before provisioning or starting the controllers.

Provision the **broker first**:

```bash
"$trial_node" scripts/remote-worker-acceptance.mjs provision --root "$trial_root"
```

It saves owner, installation and worker credentials privately without printing
them, registers one verification-only project, grants its owner submit/read, and
creates the runtime configuration. Offline `auth token generate` and token mode
allow the later non-TTY foreground start without a first-run token prompt. Owner
sessions last one hour; provision shortly before the trial. A failed CLI step
leaves bounded diagnostics in `provision-failure-private.json`, separate from
the structured evidence. Both remain private. Transfer broker
`provision-result.json` privately to worker `broker-provision.json`, and broker
`worker.token` to worker `worker.token`,
both `0600`. Run the same provision command on the worker. It imports the stable
broker worker principal ID, creates its own project mapping and local owner,
and issues no replacement broker credential. Never retry partial provisioning
by clearing a database. Preserve the root and diagnose the failed operation.

## Run separate foreground processes

Start the parent-owned tunnel, then in separate terminals on the respective hosts:

```bash
"$trial_node" scripts/remote-worker-acceptance.mjs run --root "$trial_root"
```

This invokes the actual CLI `start` with explicit fresh data/state roots, private
runtime configuration, loopback bindings and no browser. The worker disables its
unused MCP listener. It does not claim/start/switch any development server. Raw
controller output stays in `controller-private.log`, which can contain bootstrap
credentials and is never shareable evidence. A `spawned` event is not readiness.
The foreground supervisor requests shutdown after 30 minutes and forwards
its first SIGINT, SIGTERM or SIGHUP as one SIGTERM to its live child. The child
has a separate process group so terminal Ctrl-C or a terminal/SSH hangup reaches
the supervisor, which waits for the child's asynchronous cleanup and exit. This
prevents a second signal from terminating the CLI after it removes its signal
handlers for asynchronous cleanup. The supervisor retains and awaits the
live ChildProcess; `detached` does not mean abandoned or unreferenced here.
Repeated stop signals and the deadline share the same idempotent stop; all
three signal handlers are removed after exit. Closing a terminal may make the
supervisor's output unavailable. Check the private `controller-exit.json` and
`controller-private.log` rather than treating missing terminal output as a clean
exit. SIGKILL and abrupt machine failure cannot run this graceful shutdown.
If shutdown exceeds 45 seconds it marks
the run failed and remains attached until the child exits. It never escalates
to force kill, abandons a running child or restarts the CLI. Such a shutdown
timeout also fails the later audit, even if the child eventually exits.

On the broker, confirm readiness/capabilities:

```bash
"$trial_node" scripts/remote-worker-acceptance.client.mjs --root "$trial_root" --action capabilities
```

## Failed/fixed, replay, disconnect and cancel

All client commands run on the broker. Each case gets a distinct stable
idempotency key. `submit` can be retried identically after a lost response; it
retains the same request ID. Other phase evidence files are exclusive. Existing
evidence is preserved rather than silently overwritten.

```bash
"$trial_node" scripts/remote-worker-acceptance.client.mjs --root "$trial_root" --case failed --action submit
"$trial_node" scripts/remote-worker-acceptance.client.mjs --root "$trial_root" --case failed --action wait
"$trial_node" scripts/remote-worker-acceptance.client.mjs --root "$trial_root" --case failed --action replay
"$trial_node" scripts/remote-worker-acceptance.client.mjs --root "$trial_root" --case fixed --action submit
"$trial_node" scripts/remote-worker-acceptance.client.mjs --root "$trial_root" --case fixed --action wait
"$trial_node" scripts/remote-worker-acceptance.client.mjs --root "$trial_root" --case fixed --action replay
```

`wait` defaults to 900 seconds including dependency preparation. It requires the
expected executed SHA, phase, fingerprints, source attribution, owned cleanup,
and fixture markers with the requested SHA and a different boot from the broker.
A setup failure cannot satisfy `failed`. `replay` resubmits through MCP, waits four seconds and
requires unchanged request/attempt/run/result. The final worker audit checks the
entire execution count, not just the broker's visible replay result.

For the disconnect case, the intended short-interruption procedure is below.
The completed trial's longer interruption and narrower observation are recorded
in [Completed trial evidence](#completed-trial-evidence).

```bash
"$trial_node" scripts/remote-worker-acceptance.client.mjs --root "$trial_root" --case disconnect --action submit
"$trial_node" scripts/remote-worker-acceptance.client.mjs --root "$trial_root" --case disconnect --action wait-running
```

After `running`, allow a few seconds for both fixture processes to start, then
the parent stops only its owned SSH tunnel. Leave the worker running. Keep the
interruption bounded to about 40 seconds, below the 120-second fixture lifetime.
While it is cut, observe the broker's actual stale-contact uncertainty:

```bash
"$trial_node" scripts/remote-worker-acceptance.client.mjs --root "$trial_root" --case disconnect --action wait-disconnected --timeout-seconds 60
```

Restore the same tunnel promptly; run `--case disconnect --action wait`, then
`--case disconnect --action replay`. The worker reports its actual finite result
after reconnect, without a new execution. Record whether it completed before or
after restoration. If the cut outlasts the fixture, report eventual delivery
only; do not claim reconnect before completion. This procedure does not inject
a lost acknowledgement.

For cancellation, repeat submit/wait-running/tunnel cut/wait-disconnected with
`--case cancel`, then **while disconnected** run:

```bash
"$trial_node" scripts/remote-worker-acceptance.client.mjs --root "$trial_root" --case cancel --action cancel
```

This requires observed uncertainty and durable cancellation intent. Restore the
tunnel within the same bounded interruption, then run `--case cancel --action
wait` and `--case cancel --action replay`. Terminal cancellation requires actual
queue-owned cleanup. A request that naturally completes before cancellation is a
failed cancellation trial, not a pass. Never send arbitrary PID signals.

The protocol uploads bounded logs at terminal collection; the `running` report
does not stream live output. Before completion the MCP log operation may return
an empty tail. The driver still calls the real log tool. Final evidence keeps
only validated fixture markers, line/byte counts and structured result fields,
not raw setup output or arbitrary TAP text. These files are still private.
Markers identify actual hostname, boot, PID/start ticks, SHA, Node version,
execution ID and time. The broker has no worker PID signaling capability.
Hostnames are display and consistency data, not unique machine identities.
Two independent machines may both be named `ubuntu`. Terminal wait and replay
require markers for the requested SHA and a different boot from the broker.
Markers contain no machine identity; host separation is proved by the stopped
worker audit, not by the client's marker check.

## Audit and teardown

Stop the worker supervisor with its terminal SIGINT and await a clean CLI exit;
then stop the broker the same way. Keep the tunnel until all four cases and
replays have completed. Copy the broker's `evidence` directory into worker
`broker-evidence` without moving private logs/tokens/configuration. On each host:

```bash
"$trial_node" --import tsx scripts/remote-worker-acceptance.audit.mjs --root "$trial_root"
```

The broker audit checks stopped database outcomes and its child exit. The worker
audit requires exactly four receipts and four runs; matching immutable
request/attempt/run/SHA/preset identities and fingerprints; all outbox sequences
acknowledged; confirmed local cleanup; different broker machine and boot
identities; matching signed recovery provenance; and no executing fixture PID with its
original start ticks. It also requires an empty trial workspace root. It does
not reconcile, reboot, clear uncertainty, delete files or signal a saved PID.
Any failure preserves the roots, including blocked state. Local gate failures
append one diagnostic code of at most 80 characters to the entrypoint's generic
error context, for example `co_located_trial_rejected`, `cleanup_unconfirmed`,
`unacknowledged_outbox` or `retained_workspace_preserve_root`. Only errors
created by local assertions carry a trusted code; filesystem, SDK and other
external errors retain the generic context without raw messages, paths or
tokens. A code identifies the failed gate, not permission to clear state.
A stopped controller with uncertain work is not safe teardown.

The worker audit still requires each start marker's hostname, boot and SHA to
match the worker's actual observations. Spoofing different hostnames cannot
make a co-located trial pass the machine-identity check.

After both audits succeed, the parent preserves `evidence/*.json` privately
outside the trial roots and prepares a sanitized summary for publication.
Confirm the owned tunnel has exited, revoke the trial repository credential
and verify revocation, then delete only the exact trial roots and separately
owned credentials/TLS files. Keep source checkouts, tool distributions and
production installations.
No recursive deletion command is generated from evidence or user-supplied logs.

Record timestamps for infrastructure preparation, each tunnel cut/restoration,
MCP capability check, cancellation intent, shutdown and audits. The JSON records
submission-to-observation and phase elapsed times plus actual execution times.
Record manual step count, failed recoveries and actual resource observations
separately; the harness makes no resource-budget or performance claim. The
parent then attaches validation evidence to the owning Knowledge task. A
passing Angular trial closes only the gates actually observed here.

## Validation handoff

The process-group isolation and shared-hostname correction were made after the
`bb56f48` trial. SIGHUP handling and safe gate diagnostics were corrected
after `d994079`; their regressions still require parent execution.
That trial's four case results and observed clean exits remain historical
evidence for that revision. They do not rule out the shutdown scheduling race
or validate these later corrections on two hosts.

`remote-worker-acceptance.test.mjs` exercises the actual harness entrypoint with
a finite, inert temporary CLI on Linux. It sends SIGINT or SIGHUP to a newly
owned supervisor group, holds cleanup after both child handlers are removed, and
checks repeated stops, the lifetime deadline, shutdown timeout and actual exit
evidence. Only supervisor timers are virtual; process creation, signals and
child exits are real. Each fake child has an independent eight-second lifetime.
No database, real controller, network listener or private trial fixture is used.
The existing `test:resources` script discovers these tests without package changes.

The parent owns regression execution. For a red/green comparison without
changing either checkout or the historical commit, copy the new test beside
the old harness in a disposable directory, run it there expecting failure, then
run the corrected checkout's test expecting success:

```bash
signal_regression_dir=$(mktemp -d /tmp/wtc-signal-regression-XXXXXX)
git show 49a4f5f365737f07100e3300b27be9670ef5510f:scripts/remote-worker-acceptance.mjs > "$signal_regression_dir/remote-worker-acceptance.mjs"
cp scripts/remote-worker-acceptance.test.mjs "$signal_regression_dir/remote-worker-acceptance.test.mjs"
node --test "$signal_regression_dir/remote-worker-acceptance.test.mjs"
# Expected red: forwarded SIGTERM interrupts shared-group SIGINT cleanup.
node --test scripts/remote-worker-acceptance.test.mjs
```

`remote-worker-acceptance.client.test.mjs` copies the actual client entrypoint
unchanged into temporary fixtures with inert SDK responses and synthetic host
observations. Wait and replay cover shared and distinct hostnames with different
boots. Negative cases retain SHA, boot and cleanup rejection. The actual stopped
worker audit also runs against inert store/recovery adapters and rejects a shared
machine identity despite a spoofed hostname and different boot, or a shared boot
despite a different machine identity. These fixtures open no network connection,
database or real controller and do not claim a cross-host trial. Gate tests
assert the actual entrypoint stderr using the production assertion function.
They cover co-location, cleanup, outbox acknowledgement and retained-workspace
failures, plus successful stopped-audit evidence. Unknown dependency errors
include a synthetic credential, a gate-code impersonation and a long private
path; stderr must remain bounded and contain only generic context.

For the hostname regression, use the pre-fix client with the same new test.
The old client rejects otherwise valid shared-hostname fixtures; its generic
stderr does not expose the failing gate:

```bash
identity_regression_dir=$(mktemp -d /tmp/wtc-identity-regression-XXXXXX)
git show b589ad3d1f300a9c5b83bafbcf1845f7f92d9b0b:scripts/remote-worker-acceptance.client.mjs > "$identity_regression_dir/remote-worker-acceptance.client.mjs"
cp scripts/remote-worker-acceptance.mjs scripts/remote-worker-acceptance.client.test.mjs "$identity_regression_dir/"
node --test --test-name-pattern='client (wait|replay) accepts shared hostnames' "$identity_regression_dir/remote-worker-acceptance.client.test.mjs"
# Expected red: both shared-hostname cases are rejected by the old client.
node --test scripts/remote-worker-acceptance.client.test.mjs
```

For the two round-2 findings, use the exact pre-fix `d994079` production
scripts with the new tests in one disposable directory. No real controller,
network or database is used. These commands belong to the parent; the child
has not executed them:

```bash
round2_regression_dir=$(mktemp -d /tmp/wtc-round2-regression-XXXXXX)
for acceptance_file in remote-worker-acceptance.mjs remote-worker-acceptance.client.mjs remote-worker-acceptance.audit.mjs; do
  git show "d994079efee98c2b7e4f2c7e82e99226751778ae:scripts/$acceptance_file" > "$round2_regression_dir/$acceptance_file"
done
cp scripts/remote-worker-acceptance.test.mjs scripts/remote-worker-acceptance.client.test.mjs "$round2_regression_dir/"
node --test --test-name-pattern='terminal process-group SIGHUP' "$round2_regression_dir/remote-worker-acceptance.test.mjs"
# Expected red: the old supervisor exits on SIGHUP before owned cleanup/exit evidence.
node --test --test-name-pattern='client rejects|stopped worker audit rejects' "$round2_regression_dir/remote-worker-acceptance.client.test.mjs"
# Expected red: the old client/audit stderr omits the asserted local gate code.
node --test --test-concurrency=1 scripts/remote-worker-acceptance.test.mjs scripts/remote-worker-acceptance.client.test.mjs
# Expected green on the corrected checkout, including external-error non-disclosure.
```

Run the commands serially and preserve their output as new validation evidence.
The red/green procedure is not an executed result. Then use managed
`node:test:resources` for script-test discovery and `node:lint` for the changed
scripts on the exact reviewed worktree/head. No build or GUI verification is
needed for this script-only correction.

Parent-managed verification passed on exact WTC source
`bb56f485ac75481297a3dcf3aa5688f459576a1f`, with `observed_match`:

- `node:check`, run `b2b5b994-0b66-467e-ae87-ce30b516dbb6`: lint, typecheck,
  **1,606 Vitest tests and 62 script tests** passed.
- `node:build`, run `62eeb9b7-b733-4ba2-a827-a070da8f59ce`: build passed.
- The two-host trial and stopped audits above used that source and the matching
  artifact digest. These results do not assert a trial on a later docs commit.

For documentation-only follow-ups, inspect managed presets and use a matching
standalone preset if available. Otherwise run the lightweight checks directly:

```bash
node --check scripts/remote-worker-acceptance.mjs
node --check scripts/remote-worker-acceptance.client.mjs
node --check scripts/remote-worker-acceptance.audit.mjs
python3 scripts/docs.py fmt
python3 scripts/docs.py check
git diff --check
```

The implementation child ran only syntax/documentation/whitespace checks.
Parent verification and trial execution are recorded separately above. This
tooling adds no production module or bundle change. A future code change needs
its own scoped managed verification; a future two-host trial needs reviewed
matching artifacts and all private prerequisites again. Preserve the historical
results and report every failed or unverified phase as such.
