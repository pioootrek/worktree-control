# Angular cross-host acceptance

This is a prepared trial, with no execution result yet. It targets the existing
Angular fixture on two Linux hosts. It does not close controller-crash, reboot
or general customer acceptance. Angular replaces the earlier WinPath target.
The parent owns publication,
infrastructure, foreground processes, serial verification and Knowledge writes.

## Fixed inputs and boundaries

- WTC implementation baseline: `681c0c1a763cb7e2659c35755fdbf696e90cb77a`.
  Use the same reviewed WTC revision and matching built CLI/assets on both hosts.
- Angular baseline: `a5cea6ea5a19ab07ad24bb780738a8f81513d8be`.
- Failing Angular SHA: `f3055ed4bc5e401b8e5bd8c6004ae6171471802b`.
- Fixed Angular SHA: `f6fbceed97875ab5d13755b37020599d5c185ff8`.
- Failed/fixed preset: `node:test:remote`. It imports installed RxJS and checks
  `[2, 4, 6]`; the failing commit deliberately expects `[2, 4, 7]`.
- Disconnect/cancel preset: `node:test:remote:slow` at the fixed SHA. Its two
  owned processes finish within 120 seconds without cancellation. It accepts
  no release paths, external PIDs or secrets.

The source Angular checkout, its untracked instruction files, the Django fixture,
and both hosts' production WTC installations stay outside the trial. Publish only
the reviewed Angular tracked baseline and test branch to the owner's private
repository. The fixture branch has no remote until the parent configures one.
No dependency versions or lock/workspace policies were changed. Node engines
metadata is not required by the worker policy. Existing `allowBuilds` and
`onlyBuiltDependencies` settings remain; actual frozen installation is unverified.

The scripts invoke the real CLI's offline owner bootstrap, project registration,
remote grants and runtime bootstrap. The CLI owns each database, queue, worker,
transport and process tree. The audit takes that installation's singleton lock
only after shutdown and uses public store/recovery APIs. It does not implement a
second queue or worker protocol and never signals a PID from a file.

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

Provision the **broker first**:

```bash
"$trial_node" scripts/remote-worker-acceptance.mjs provision --root "$trial_root"
```

It saves owner, installation and worker credentials privately without printing
them, registers one verification-only project, grants its owner submit/read, and
creates the runtime configuration. Offline `auth token generate` and token mode
allow the later non-TTY foreground start without a first-run token prompt. Owner
sessions last one hour; provision shortly before the trial. A failed CLI step
leaves bounded diagnostics in `provision-failure-private.json`, outside shareable
evidence. Transfer broker `provision-result.json` privately to
worker `broker-provision.json`, and broker `worker.token` to worker `worker.token`,
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
SIGINT/SIGTERM only to its live child. If shutdown exceeds 45 seconds it marks
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
and fixture markers from a different host/boot than the broker. A setup failure
cannot satisfy `failed`. `replay` resubmits through MCP, waits four seconds and
requires unchanged request/attempt/run/result. The final worker audit checks the
entire execution count, not just the broker's visible replay result.

For the disconnect case:

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
after reconnect, without a new execution. This demonstrates a real network cut,
not simulated transport exceptions or a claimed lost-ACK scenario.

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
not raw setup output or arbitrary TAP text. Markers identify actual hostname,
boot, PID/start ticks, SHA, Node version, execution ID and time. The broker has
no worker PID signaling capability.

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
acknowledged; confirmed local cleanup; a different broker machine identity;
matching signed recovery provenance; and no executing fixture PID with its
original start ticks. It also requires an empty trial workspace root. It does
not reconcile, reboot, clear uncertainty, delete files or signal a saved PID.
Any failure preserves the roots, including blocked state. A stopped controller
with uncertain work is not safe teardown.

After both audits succeed, the parent saves only shareable `evidence/*.json`
outside the trial roots, confirms its owned tunnel has exited, and deletes only
the two exact roots it created and the trial's separately owned credentials/TLS
files. Keep source checkouts, tool distributions and production installations.
No recursive deletion command is generated from evidence or user-supplied logs.

Record timestamps for infrastructure preparation, each tunnel cut/restoration,
MCP capability check, cancellation intent, shutdown and audits. The JSON records
submission-to-observation and phase elapsed times plus actual execution times.
Record manual step count, failed recoveries and actual resource observations
separately; the harness makes no resource-budget or performance claim. The
parent then attaches validation evidence to the owning Knowledge task. A
passing Angular trial closes only the gates actually observed here.

## Validation handoff

The implementation child ran syntax checks and documentation validation only.
It ran no dependency install, test suite, lint, build, browser, controller or SSH
session. Parent checks, serially and through managed presets where available:

```bash
node --check scripts/remote-worker-acceptance.mjs
node --check scripts/remote-worker-acceptance.client.mjs
node --check scripts/remote-worker-acceptance.audit.mjs
pnpm check
```

Build the reviewed CLI/assets with the supported `pnpm build` if an exact
artifact is not already available. This adds no production module or bundle
change. Run the acceptance phases above only after review, toolchain and private
source prerequisites are satisfied. Report every failed/unverified phase as such.
